import * as THREE from 'three';
import atmosphereVertexShader from './shaders/atmosphere.vert.glsl';
import atmosphereFragmentShader from './shaders/atmosphere.frag.glsl';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AtmosphereConfig {
  planetRadius: number;
  /** Ratio of atmosphere radius to planet radius (e.g. 1.025 for 2.5% shell) */
  atmosphereScale: number;
  /** Rayleigh scale height in world units */
  rayleighScaleHeight: number;
  /** Mie scale height in world units */
  mieScaleHeight: number;
  /** Rayleigh scattering coefficients (wavelength-dependent, earth-like blue) */
  rayleighCoeff: THREE.Vector3;
  /** Mie scattering coefficient (grey/white) */
  mieCoeff: number;
  /** Mie asymmetry parameter g ∈ (-1, 1). 0.76 typical forward-scattering */
  mieG: number;
  /** Sun intensity multiplier */
  intensity: number;
  /** Sphere geometry resolution */
  segments: number;
  /** Max terrain height in world units (needed for ground-following atmosphere) */
  terrainHeight: number;
  /** Terrain heightmap cubemap — each texel stores normalised height [0,1] */
  heightCubemap: THREE.CubeTexture | null;
}

// Scale heights and coefficients must be proportional to our world.
// Earth: radius 6371 km, atmosphere ~100 km, Rayleigh scale height ~8.5 km.
// Our world: radius 1000, atmosphere shell ~60 units (6% of radius).
// The atmosphere starts at the terrain surface and extends upward.

const DEFAULT_CONFIG: AtmosphereConfig = {
  planetRadius: 1000,
  atmosphereScale: 1.26,                            // 6% above surface → 60 unit shell
  rayleighScaleHeight: 10.0,                         // proportional to 60-unit shell
  mieScaleHeight: 3.5,                               // proportional
  rayleighCoeff: new THREE.Vector3(0.01, 0.025, 0.06),  // tuned for ~60 unit path
  mieCoeff: 0.015,
  mieG: 0.76,
  intensity: 22.0,
  segments: 80,
  terrainHeight: 0,
  heightCubemap: null,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class Atmosphere {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;

  constructor(config?: Partial<AtmosphereConfig>) {
    const cfg = { ...DEFAULT_CONFIG, ...config };

    // Outer atmosphere shell is a clean sphere above the highest terrain
    const atmoRadius = (cfg.planetRadius + cfg.terrainHeight) * cfg.atmosphereScale;

    // If no cubemap provided, create a black dummy (all height = 0)
    const heightMap = cfg.heightCubemap ?? createDummyCubemap();

    this.material = new THREE.ShaderMaterial({
      vertexShader: atmosphereVertexShader,
      fragmentShader: atmosphereFragmentShader,
      uniforms: {
        uSunDir:        { value: new THREE.Vector3(1, 0.5, 0.8).normalize() },
        uPlanetRadius:  { value: cfg.planetRadius },
        uAtmoRadius:    { value: atmoRadius },
        uRayleighScale: { value: cfg.rayleighScaleHeight },
        uMieScale:      { value: cfg.mieScaleHeight },
        uRayleighCoeff: { value: cfg.rayleighCoeff },
        uMieCoeff:      { value: cfg.mieCoeff },
        uMieG:          { value: cfg.mieG },
        uIntensity:     { value: cfg.intensity },
        uHeightMap:     { value: heightMap },
        uTerrainHeight: { value: cfg.terrainHeight },
        // Depth buffer integration
        tDepth:         { value: null },
        uCameraNear:    { value: 0.5 },
        uCameraFar:     { value: 100000 },
      },
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      // Premultiplied alpha: scatter is added, background is dimmed by (1 - alpha)
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
    });

    const geo = new THREE.SphereGeometry(atmoRadius, cfg.segments, cfg.segments);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.renderOrder = 2;
  }

  /** Call each frame to update sun direction */
  setSunDirection(dir: THREE.Vector3): void {
    (this.material.uniforms['uSunDir'].value as THREE.Vector3).copy(dir);
  }

  /** Pass the depth texture from the opaque pass */
  setDepthTexture(depthTex: THREE.DepthTexture): void {
    this.material.uniforms['tDepth'].value = depthTex;
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

  /** Update camera near/far each frame so logarithmic depth reconstruction is correct */
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

function createDummyCubemap(): THREE.CubeTexture {
  const size = 1;
  const canvases: HTMLCanvasElement[] = [];
  for (let i = 0; i < 6; i++) {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 1, 1);
    canvases.push(c);
  }
  const tex = new THREE.CubeTexture(canvases);
  tex.needsUpdate = true;
  return tex;
}
