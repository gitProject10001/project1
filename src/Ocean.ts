import * as THREE from 'three';
import oceanVertexShader from './shaders/ocean.vert.glsl';
import oceanFragmentShader from './shaders/ocean.frag.glsl';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface OceanConfig {
  planetRadius: number;
  oceanRadius: number;
  segments: number;
  sunIntensity: number;
  /** Absorption coefficients (r, g, b) — higher values absorb more */
  absorption: THREE.Vector3;
  /** Subsurface scatter tint */
  scatterColor: THREE.Vector3;
  /** Maximum depth for full absorption (world units) */
  maxDepthFade: number;
  /** Color at zero depth */
  shallowColor: THREE.Vector3;
  /** Color at maximum depth */
  deepColor: THREE.Vector3;
}

const DEFAULT_OCEAN_CONFIG: OceanConfig = {
  planetRadius: 1000,
  oceanRadius: 1025.6,  // PLANET_RADIUS + OCEAN_LEVEL * TERRAIN_HEIGHT
  segments: 128,
  sunIntensity: 22.0,
  absorption: new THREE.Vector3(0.4, 0.08, 0.02),   // red absorbs most, blue least
  scatterColor: new THREE.Vector3(0.0, 0.4, 0.3),    // teal scatter
  maxDepthFade: 40.0,                                  // full absorption over 40 world units
  shallowColor: new THREE.Vector3(0.04, 0.16, 0.28),  // bright teal
  deepColor: new THREE.Vector3(0.005, 0.02, 0.08),    // dark blue
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class Ocean {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;

  constructor(config?: Partial<OceanConfig>) {
    const cfg = { ...DEFAULT_OCEAN_CONFIG, ...config };

    this.material = new THREE.ShaderMaterial({
      vertexShader: oceanVertexShader,
      fragmentShader: oceanFragmentShader,
      uniforms: {
        uSunDir:       { value: new THREE.Vector3(1, 0.5, 0.8).normalize() },
        uSunIntensity: { value: cfg.sunIntensity },
        uPlanetRadius: { value: cfg.planetRadius },
        uOceanRadius:  { value: cfg.oceanRadius },
        // Depth buffer
        tDepth:        { value: null },
        uCameraNear:   { value: 0.5 },
        uCameraFar:    { value: 100000 },
        // Optical properties
        uAbsorption:   { value: cfg.absorption },
        uScatterColor: { value: cfg.scatterColor },
        uMaxDepthFade: { value: cfg.maxDepthFade },
        uShallowColor: { value: cfg.shallowColor },
        uDeepColor:    { value: cfg.deepColor },
      },
      transparent: true,
      side: THREE.FrontSide,
      depthWrite: true,
      depthTest: true,
    });

    const geo = new THREE.SphereGeometry(cfg.oceanRadius, cfg.segments, cfg.segments);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.renderOrder = 0;
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

  setSunDirection(dir: THREE.Vector3): void {
    (this.material.uniforms['uSunDir'].value as THREE.Vector3).copy(dir);
  }

  setDepthTexture(depthTex: THREE.DepthTexture): void {
    this.material.uniforms['tDepth'].value = depthTex;
  }

  updateCameraUniforms(camera: THREE.Camera): void {
    if (camera instanceof THREE.PerspectiveCamera) {
      this.material.uniforms['uCameraNear'].value = camera.near;
      this.material.uniforms['uCameraFar'].value = camera.far;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
