import * as THREE from 'three';
import cloudVertexShader from './shaders/clouds.vert.glsl';
import cloudFragmentShader from './shaders/clouds.frag.glsl';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CloudConfig {
  planetRadius: number;
  /** Height above planet surface where cloud shell begins (world units) */
  cloudBaseOffset: number;
  /** Thickness of the cloud shell (world units) */
  cloudThickness: number;
  /** Cloud coverage 0..1 */
  coverage: number;
  /** Overall density multiplier */
  densityMultiplier: number;
  /** Cloud drift speed */
  cloudSpeed: number;
  /** Sun intensity */
  sunIntensity: number;
  /** Base cloud albedo */
  cloudColor: THREE.Vector3;
  /** Shadow / ambient tint */
  cloudShadowColor: THREE.Vector3;
  /** Sphere geometry segments */
  segments: number;
  /** Max terrain height (to place cloud base above highest peaks) */
  terrainHeight: number;
  /** Cloud type: 0=Stratus, 1=Cumulus, 2=Cumulonimbus */
  cloudType: number;
  /** Curl noise advection strength */
  advectionStrength: number;
  /** Small-scale turbulence */
  turbulence: number;
  /** Large-scale weather front intensity */
  weatherScale: number;
  /** Global wind direction X */
  windX: number;
  /** Global wind direction Z */
  windZ: number;
  /** Tornado vortex strength */
  tornadoStrength: number;
}

const DEFAULT_CLOUD_CONFIG: CloudConfig = {
  planetRadius: 1000,
  cloudBaseOffset: 45,
  cloudThickness: 50,
  coverage: 0.55,
  densityMultiplier: 0.8,
  cloudSpeed: 0.3,
  sunIntensity: 22.0,
  cloudColor: new THREE.Vector3(1.0, 0.98, 0.95),
  cloudShadowColor: new THREE.Vector3(0.2, 0.22, 0.25),
  segments: 80,
  terrainHeight: 80,
  cloudType: 1.0,
  advectionStrength: 1.5,
  turbulence: 0.8,
  weatherScale: 1.0,
  windX: 0.7,
  windZ: 1.0,
  tornadoStrength: 2.0,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class Clouds {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  private innerRadius: number;
  private outerRadius: number;

  constructor(config?: Partial<CloudConfig>) {
    const cfg = { ...DEFAULT_CLOUD_CONFIG, ...config };

    this.innerRadius = cfg.planetRadius + cfg.cloudBaseOffset;
    this.outerRadius = this.innerRadius + cfg.cloudThickness;

    this.material = new THREE.ShaderMaterial({
      vertexShader: cloudVertexShader,
      fragmentShader: cloudFragmentShader,
      uniforms: {
        uSunDir:          { value: new THREE.Vector3(1, 0.5, 0.8).normalize() },
        uInnerRadius:     { value: this.innerRadius },
        uOuterRadius:     { value: this.outerRadius },
        uTime:            { value: 0.0 },
        uCoverage:        { value: cfg.coverage },
        uDensityMult:     { value: cfg.densityMultiplier },
        uCloudSpeed:      { value: cfg.cloudSpeed },
        uSunIntensity:    { value: cfg.sunIntensity },
        uCloudColor:      { value: cfg.cloudColor },
        uCloudShadowColor:{ value: cfg.cloudShadowColor },
        // Weather system
        uCloudType:       { value: cfg.cloudType },
        uAdvectionStrength:{ value: cfg.advectionStrength },
        uTurbulence:      { value: cfg.turbulence },
        uWeatherScale:    { value: cfg.weatherScale },
        uWindX:           { value: cfg.windX },
        uWindZ:           { value: cfg.windZ },
        // Tornadoes
        uTornadoPos1:     { value: new THREE.Vector3(0, 0, 0) },
        uTornadoPos2:     { value: new THREE.Vector3(0, 0, 0) },
        uTornadoActive:   { value: 0.0 },
        uTornadoStrength: { value: cfg.tornadoStrength },
        // Depth buffer integration
        tDepth:           { value: null },
        uCameraNear:      { value: 0.5 },
        uCameraFar:       { value: 100000 },
      },
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,  // All occlusion handled analytically via tDepth
      // Premultiplied alpha: luminance is added, background is dimmed by (1 - alpha)
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
    });

    // Use a sphere larger than the atmosphere so the BackSide faces always
    // cover the full planet disc from any camera distance. The shader
    // analytically intersects the actual cloud shell radii — the geometry
    // sphere is just a screen-coverage proxy. Slightly larger than the
    // atmosphere sphere to avoid z-fighting between the two BackSide passes.
    const geoRadius = (cfg.planetRadius + cfg.terrainHeight) * 1.3;
    const geo = new THREE.SphereGeometry(geoRadius, cfg.segments, cfg.segments);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.renderOrder = 3; // After atmosphere (2), after ocean (0), after terrain (1)
  }

  /** Set a uniform value by name */
  setUniform(name: string, value: number | THREE.Vector3): void {
    const u = this.material.uniforms[name];
    if (!u) return;
    if (value instanceof THREE.Vector3) {
      (u.value as THREE.Vector3).copy(value);
    } else {
      u.value = value;
    }
  }

  /** Get current uniform value */
  getUniform(name: string): unknown {
    return this.material.uniforms[name]?.value;
  }

  /** Call each frame to update sun direction */
  setSunDirection(dir: THREE.Vector3): void {
    (this.material.uniforms['uSunDir'].value as THREE.Vector3).copy(dir);
  }

  /** Pass the depth texture from the opaque pass */
  setDepthTexture(depthTex: THREE.DepthTexture): void {
    this.material.uniforms['tDepth'].value = depthTex;
  }

  /** Update camera near/far each frame so logarithmic depth reconstruction is correct */
  updateCameraUniforms(camera: THREE.Camera): void {
    if (camera instanceof THREE.PerspectiveCamera) {
      this.material.uniforms['uCameraNear'].value = camera.near;
      this.material.uniforms['uCameraFar'].value = camera.far;
    }
  }

  /** Advance time for cloud drift animation */
  updateTime(elapsed: number): void {
    this.material.uniforms['uTime'].value = elapsed;
  }

  /** Activate/deactivate tornadoes. mask: 0=none, 1=tornado1, 2=tornado2, 3=both */
  setTornadoActive(mask: number): void {
    this.material.uniforms['uTornadoActive'].value = mask;
  }

  /** Set tornado position (index 0 or 1). Pass null to use procedural position. */
  setTornadoPosition(index: number, pos: THREE.Vector3 | null): void {
    const name = index === 0 ? 'uTornadoPos1' : 'uTornadoPos2';
    const v = this.material.uniforms[name].value as THREE.Vector3;
    if (pos) {
      v.copy(pos);
    } else {
      v.set(0, 0, 0); // zero-length triggers procedural path in shader
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
