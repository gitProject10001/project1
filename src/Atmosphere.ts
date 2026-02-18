import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Volumetric Raymarched Atmosphere
//
// Physics-based Rayleigh + Mie scattering on a full-screen back-face sphere.
// The fragment shader casts a ray from the camera through the atmosphere shell,
// integrates optical depth along the ray, and applies:
//   - Rayleigh scattering  → blue sky, orange/red sunsets
//   - Mie scattering       → bright halo around the sun
//   - Henyey-Greenstein phase function for directional Mie
//   - Terrain-following ground level via heightmap cubemap
// ---------------------------------------------------------------------------

const ATMOSPHERE_VERTEX = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vWorldDir;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vWorldDir = wp.xyz - cameraPosition;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const ATMOSPHERE_FRAGMENT = /* glsl */ `
// ---- Uniforms ----
uniform vec3  uSunDir;        // Normalised direction TO the sun
uniform float uPlanetRadius;  // Base planet radius (no terrain)
uniform float uAtmoRadius;    // Top-of-atmosphere radius
uniform float uRayleighScale; // Rayleigh scale height
uniform float uMieScale;      // Mie scale height
uniform vec3  uRayleighCoeff; // Rayleigh scattering coefficients
uniform float uMieCoeff;      // Mie scattering coefficient
uniform float uMieG;          // Mie asymmetry (Henyey-Greenstein g)
uniform float uIntensity;     // Sun intensity multiplier
uniform samplerCube uHeightMap;  // Terrain height cubemap [0,1]
uniform float uTerrainHeight;   // Max terrain displacement in world units

varying vec3 vWorldPos;
varying vec3 vWorldDir;

// ---- Constants ----
#define PI 3.14159265359
#define NUM_VIEW_STEPS 16
#define NUM_LIGHT_STEPS 8

// ---- Ray-sphere intersection ----
vec2 raySphere(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float disc = b * b - c;
  if (disc < 0.0) return vec2(1e20, -1e20);
  float sq = sqrt(disc);
  return vec2(-b - sq, -b + sq);
}

// ---- Phase functions ----
float phaseRayleigh(float cosTheta) {
  return (3.0 / (16.0 * PI)) * (1.0 + cosTheta * cosTheta);
}

float phaseMie(float cosTheta, float g) {
  float g2 = g * g;
  float num = (1.0 - g2);
  float denom = pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5);
  return (3.0 / (8.0 * PI)) * num / denom;
}

// Get the terrain surface radius at a given direction
float getTerrainRadius(vec3 dir) {
  float hNorm = textureCube(uHeightMap, dir).r;
  return uPlanetRadius + hNorm * uTerrainHeight;
}

// ---- Main ----
void main() {
  vec3 rayOrigin = cameraPosition;
  vec3 rayDir = normalize(vWorldDir);

  // Intersect atmosphere shell
  vec2 tAtmo = raySphere(rayOrigin, rayDir, uAtmoRadius);
  if (tAtmo.x > tAtmo.y) { discard; }

  // Conservative ground sphere: use max possible terrain radius to stop ray
  float maxGroundRadius = uPlanetRadius + uTerrainHeight;
  vec2 tPlanet = raySphere(rayOrigin, rayDir, maxGroundRadius);
  bool hitPlanet = (tPlanet.x < tPlanet.y) && (tPlanet.x > 0.0);

  // Clamp ray segment to atmosphere
  float tStart = max(tAtmo.x, 0.0);
  float tEnd   = hitPlanet ? min(tPlanet.x, tAtmo.y) : tAtmo.y;
  if (tStart >= tEnd) { discard; }

  float segLen = tEnd - tStart;
  float stepSize = segLen / float(NUM_VIEW_STEPS);

  // Accumulators
  float opticalDepthR = 0.0;
  float opticalDepthM = 0.0;
  vec3 totalR = vec3(0.0);
  vec3 totalM = vec3(0.0);

  // ---- Primary ray march ----
  for (int i = 0; i < NUM_VIEW_STEPS; i++) {
    float t = tStart + (float(i) + 0.5) * stepSize;
    vec3 samplePos = rayOrigin + rayDir * t;
    float sampleR = length(samplePos);
    vec3 sampleDir = samplePos / sampleR;

    // Look up the terrain surface height at this direction
    float surfaceRadius = getTerrainRadius(sampleDir);

    // Altitude above the local terrain surface
    float altitude = sampleR - surfaceRadius;

    // Skip samples that are underground
    if (altitude < 0.0) continue;

    // Density at this altitude (exponential falloff from local surface)
    float densR = exp(-altitude / uRayleighScale) * stepSize;
    float densM = exp(-altitude / uMieScale)      * stepSize;

    opticalDepthR += densR;
    opticalDepthM += densM;

    // ---- Light (sun) ray march from sample point toward sun ----
    vec2 tSunAtmo = raySphere(samplePos, uSunDir, uAtmoRadius);
    float sunPathLen = max(tSunAtmo.y, 0.0);
    float sunStepSize = sunPathLen / float(NUM_LIGHT_STEPS);

    float optDepthLR = 0.0;
    float optDepthLM = 0.0;
    bool shadow = false;

    for (int j = 0; j < NUM_LIGHT_STEPS; j++) {
      float ts = (float(j) + 0.5) * sunStepSize;
      vec3 lightSample = samplePos + uSunDir * ts;
      float lightR = length(lightSample);
      vec3 lightDir = lightSample / lightR;

      // Terrain-aware altitude for light samples
      float lightSurfaceR = getTerrainRadius(lightDir);
      float lightAlt = lightR - lightSurfaceR;

      if (lightAlt < 0.0) { shadow = true; break; }
      optDepthLR += exp(-lightAlt / uRayleighScale) * sunStepSize;
      optDepthLM += exp(-lightAlt / uMieScale)      * sunStepSize;
    }

    if (!shadow) {
      vec3 tau = uRayleighCoeff * (opticalDepthR + optDepthLR)
               + uMieCoeff      * (opticalDepthM + optDepthLM);
      vec3 attenuation = exp(-tau);

      totalR += densR * attenuation;
      totalM += densM * attenuation;
    }
  }

  // Phase functions
  float cosTheta = dot(rayDir, uSunDir);
  float pR = phaseRayleigh(cosTheta);
  float pM = phaseMie(cosTheta, uMieG);

  // In-scattered light
  vec3 scatter = uIntensity * (pR * uRayleighCoeff * totalR + pM * uMieCoeff * totalM);

  // Alpha: based on how much atmosphere the ray passed through
  float totalOD = length(uRayleighCoeff) * opticalDepthR + uMieCoeff * opticalDepthM;
  float alpha = 1.0 - exp(-totalOD * 1.5);
  alpha = max(alpha, 0.0);

  // Tone-map scatter to prevent blow-out around sun
  scatter = 1.0 - exp(-scatter);

  gl_FragColor = vec4(scatter, alpha);
}
`;

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
  atmosphereScale: 1.06,                            // 6% above surface → 60 unit shell
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

    // The atmosphere shell must extend above the highest possible terrain
    const maxSurface = cfg.planetRadius + cfg.terrainHeight;
    const atmoRadius = maxSurface * cfg.atmosphereScale;

    // If no cubemap provided, create a black dummy (all height = 0)
    const heightMap = cfg.heightCubemap ?? createDummyCubemap();

    this.material = new THREE.ShaderMaterial({
      vertexShader: ATMOSPHERE_VERTEX,
      fragmentShader: ATMOSPHERE_FRAGMENT,
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
      },
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
    });

    const geo = new THREE.SphereGeometry(atmoRadius, cfg.segments, cfg.segments);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.renderOrder = 2;
  }

  /** Call each frame to update sun direction */
  setSunDirection(dir: THREE.Vector3): void {
    (this.material.uniforms['uSunDir'].value as THREE.Vector3).copy(dir);
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
