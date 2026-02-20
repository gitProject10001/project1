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
//
// The terrain heightmap only affects where density *starts* (the ground).
// The outer atmosphere boundary is always a clean sphere so it looks
// smooth from orbit. Near the surface, density is measured from the
// local terrain height. Higher up, the terrain offset fades out so that
// the atmosphere top is spherically symmetric.
// ---------------------------------------------------------------------------

const ATMOSPHERE_VERTEX = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vWorldDir;
varying vec2 vUv;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vWorldDir = wp.xyz - cameraPosition;
  vec4 clipPos = projectionMatrix * viewMatrix * wp;
  gl_Position = clipPos;

  // Screen-space UV for sampling the depth texture
  vUv = clipPos.xy / clipPos.w * 0.5 + 0.5;
}
`;

const ATMOSPHERE_FRAGMENT = /* glsl */ `
// ---- Uniforms ----
uniform vec3  uSunDir;        // Normalised direction TO the sun
uniform float uPlanetRadius;  // Base planet radius (no terrain)
uniform float uAtmoRadius;    // Top-of-atmosphere radius (smooth sphere)
uniform float uRayleighScale; // Rayleigh scale height
uniform float uMieScale;      // Mie scale height
uniform vec3  uRayleighCoeff; // Rayleigh scattering coefficients
uniform float uMieCoeff;      // Mie scattering coefficient
uniform float uMieG;          // Mie asymmetry (Henyey-Greenstein g)
uniform float uIntensity;     // Sun intensity multiplier
uniform samplerCube uHeightMap;  // Terrain height cubemap [0,1]
uniform float uTerrainHeight;   // Max terrain displacement in world units

// Depth buffer integration
uniform sampler2D tDepth;     // Scene depth texture (logarithmic depth)
uniform float uCameraNear;
uniform float uCameraFar;

varying vec3 vWorldPos;
varying vec3 vWorldDir;
varying vec2 vUv;

// ---- Constants ----
#define PI 3.14159265359
#define NUM_VIEW_STEPS 16
#define NUM_LIGHT_STEPS 8

// ---- Reconstruct linear depth from logarithmic depth buffer ----
// Three.js logarithmic depth: gl_FragDepthEXT = log2(vFragDepth) * logDepthBufFC * 0.5
// where logDepthBufFC = 2.0 / (log(far + 1.0) / log(2.0))
// Stored as: depth = log2(clipW + 1.0) / log2(far + 1.0)
float linearizeLogDepth(float d) {
  if (d >= 1.0) return uCameraFar;
  // Reverse: clipW = pow(2.0, d * log2(far + 1.0)) - 1.0
  // clipW corresponds to the view-space Z (distance from camera along view axis)
  float logFarP1 = log2(uCameraFar + 1.0);
  return pow(2.0, d * logFarP1) - 1.0;
}

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

// Compute altitude above local terrain, with smooth fade-out at height.
float getAltitude(vec3 pos, float r, vec3 dir) {
  float terrainR = getTerrainRadius(dir);
  float terrainOffset = terrainR - uPlanetRadius;

  float altAboveBase = r - uPlanetRadius;
  float shellThickness = uAtmoRadius - uPlanetRadius;
  float terrainBlend = 1.0 - smoothstep(shellThickness * 0.1, shellThickness * 0.4, altAboveBase);

  float effectiveGround = uPlanetRadius + terrainOffset * terrainBlend;
  return r - effectiveGround;
}

// ---- Main ----
void main() {
  vec3 rayOrigin = cameraPosition;
  vec3 rayDir = normalize(vWorldDir);

  // ---- Read scene depth to find where opaque terrain is ----
  float rawDepth = texture2D(tDepth, vUv).r;
  float sceneLinearDepth = linearizeLogDepth(rawDepth);

  // Convert linear depth (view-space Z) to world-space ray distance
  // sceneLinearDepth is the view-space Z (distance along the camera's forward axis)
  // We need the actual ray distance: t = viewZ / dot(rayDir, cameraForward)
  // For perspective cameras, dot(normalize(vWorldDir), cameraForward) = viewZ / rayLength
  // Simpler: the depth buffer stores the clip-space W, which for perspective
  // projection IS the view-space Z. The ray distance is viewZ / cos(angle).
  float cosAngle = dot(rayDir, vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));
  float tSceneDepth = sceneLinearDepth / abs(cosAngle);

  // Intersect the smooth outer atmosphere sphere
  vec2 tAtmo = raySphere(rayOrigin, rayDir, uAtmoRadius);
  if (tAtmo.x > tAtmo.y) { discard; }

  // Intersect base planet sphere (conservative inner bound for when no depth available)
  vec2 tPlanet = raySphere(rayOrigin, rayDir, uPlanetRadius);
  bool hitPlanet = (tPlanet.x < tPlanet.y) && (tPlanet.x > 0.0);

  // Clamp ray segment to atmosphere shell
  float tStart = max(tAtmo.x, 0.0);
  float tEnd   = hitPlanet ? min(tPlanet.x, tAtmo.y) : tAtmo.y;

  // If the depth buffer has a valid hit closer than the atmosphere sphere intersection,
  // use it to stop the ray early (terrain mesh is blocking the view)
  bool terrainHit = rawDepth < 1.0 && tSceneDepth < tEnd;
  if (terrainHit) {
    tEnd = tSceneDepth;
  }

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

    // Terrain-aware altitude with smooth fade at height
    float altitude = getAltitude(samplePos, sampleR, sampleDir);

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

      float lightAlt = getAltitude(lightSample, lightR, lightDir);

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

  // Transmittance: how much background light survives through the atmosphere
  vec3 totalTau = uRayleighCoeff * opticalDepthR + uMieCoeff * opticalDepthM;
  vec3 transmittanceRGB = exp(-totalTau * 1.5);

  // Use luminance of transmittance for scalar alpha
  float transmittance = dot(transmittanceRGB, vec3(0.2126, 0.7152, 0.0722));
  float alpha = 1.0 - transmittance;

  // Tone-map scatter to prevent blow-out around sun
  scatter = 1.0 - exp(-scatter);

  // Premultiplied alpha: scatter is already the "add" component,
  // alpha controls how much the background is dimmed
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
