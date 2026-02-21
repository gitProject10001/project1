import * as THREE from 'three';
import type { MeshSDFResult } from './MeshSDF';

// ---------------------------------------------------------------------------
// UnifiedRenderer — Single-Pass Volumetric Raymarching Renderer
//
// Replaces the hybrid raster/volume pipeline with a single full-screen shader
// pass that raymarches through the entire scene. Every visual element — terrain
// (via SDF), clouds (procedural noise), atmosphere (Rayleigh + Mie) — is
// described mathematically and rendered in one shader pass.
//
// Architecture — Three sequential phases per ray:
//
//   Phase 1: SPHERE TRACE — find the nearest solid surface (terrain SDF).
//            Pure sphere tracing with large SDF-guided steps. No volumetric
//            sampling here — just find the hit distance fast.
//
//   Phase 2: CLOUD MARCH — fixed-step march through the cloud shell segment
//            of the ray (bounded by shell radii and the surface hit).
//            Accumulates in-scattering + transmittance with light marching.
//
//   Phase 3: ATMOSPHERE — fixed-step march through the atmosphere segment
//            (bounded by atmosphere radius and the surface hit).
//            Accumulates Rayleigh + Mie scattering with sun occlusion.
//
//   Compositing: surface color * cloud transmittance * atmo transmittance
//                + cloud luminance + atmosphere luminance
//
// ---------------------------------------------------------------------------
// HOW TO USE
// ---------------------------------------------------------------------------
//
//   import { UnifiedRenderer } from './UnifiedRenderer';
//   import { generateMeshSDFFromMesh } from './MeshSDF';
//
//   // 1. Create the renderer (once)
//   const webglRenderer = new THREE.WebGLRenderer({ antialias: true });
//   webglRenderer.setSize(window.innerWidth, window.innerHeight);
//   document.body.appendChild(webglRenderer.domElement);
//
//   const camera = new THREE.PerspectiveCamera(75, w / h, 0.5, 100000);
//   const unified = new UnifiedRenderer();
//
//   // 2. Generate an SDF from your terrain mesh and provide it
//   const sdfResult = generateMeshSDFFromMesh(terrainMesh, { resolution: 128 });
//   unified.setTerrainSDF(sdfResult);
//
//   // 3. Animation loop — replaces renderer.render(scene, camera)
//   function animate() {
//     requestAnimationFrame(animate);
//     unified.update(camera, sunDirection, clock.elapsedTime);
//     unified.render(webglRenderer);
//   }
//   animate();
//
//   // 4. Handle resize
//   window.addEventListener('resize', () => {
//     camera.aspect = window.innerWidth / window.innerHeight;
//     camera.updateProjectionMatrix();
//     webglRenderer.setSize(window.innerWidth, window.innerHeight);
//     unified.setSize(window.innerWidth, window.innerHeight);
//   });
//
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface UnifiedRendererConfig {
  /** Max distance before a ray is considered a miss */
  maxDist: number;
  /** SDF iso-surface hit threshold */
  hitEpsilon: number;
  /** Cloud shell inner radius (planet radius + offset) */
  cloudInnerRadius: number;
  /** Cloud shell outer radius */
  cloudOuterRadius: number;
  /** Cloud coverage 0..1 */
  cloudCoverage: number;
  /** Cloud density multiplier */
  cloudDensity: number;
  /** Cloud wind speed */
  cloudSpeed: number;
  /** Sun brightness */
  sunIntensity: number;
  /** Cloud base albedo */
  cloudColor: THREE.Vector3;
  /** Cloud shadow/ambient tint */
  cloudShadowColor: THREE.Vector3;
  /** Atmosphere outer radius */
  atmoRadius: number;
  /** Planet base radius */
  planetRadius: number;
  /** Rayleigh scattering coefficients */
  rayleighCoeff: THREE.Vector3;
  /** Rayleigh scale height */
  rayleighScaleHeight: number;
  /** Mie scattering coefficient */
  mieCoeff: number;
  /** Mie scale height */
  mieScaleHeight: number;
  /** Mie asymmetry parameter */
  mieG: number;
}

const DEFAULT_CONFIG: UnifiedRendererConfig = {
  maxDist: 50000.0,
  hitEpsilon: 0.5,
  cloudInnerRadius: 1045.0,
  cloudOuterRadius: 1095.0,
  cloudCoverage: 0.55,
  cloudDensity: 0.8,
  cloudSpeed: 0.3,
  sunIntensity: 22.0,
  cloudColor: new THREE.Vector3(1.0, 0.98, 0.95),
  cloudShadowColor: new THREE.Vector3(0.2, 0.22, 0.25),
  atmoRadius: 1360.8,
  planetRadius: 1000.0,
  rayleighCoeff: new THREE.Vector3(0.01, 0.025, 0.06),
  rayleighScaleHeight: 10.0,
  mieCoeff: 0.015,
  mieScaleHeight: 3.5,
  mieG: 0.76,
};

// ---------------------------------------------------------------------------
// GLSL Vertex Shader — full-screen triangle
// ---------------------------------------------------------------------------

const VERTEX_SHADER = /* glsl */ `
out vec2 vUv;

void main() {
  float x = -1.0 + float((gl_VertexID & 1) << 2);
  float y = -1.0 + float((gl_VertexID & 2) << 1);
  vUv = vec2(x, y) * 0.5 + 0.5;
  gl_Position = vec4(x, y, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------
// GLSL Fragment Shader — multi-phase raymarcher
// ---------------------------------------------------------------------------

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;
precision highp sampler3D;

in vec2 vUv;
out vec4 fragColor;

// ---- Camera & Transform ----
uniform mat4  uInvProjection;
uniform mat4  uInvView;
uniform vec3  uCameraPos;
uniform float uTime;

// ---- Sun ----
uniform vec3  uSunDir;
uniform float uSunIntensity;

// ---- SDF Terrain ----
uniform sampler3D uSDFTexture;
uniform vec3      uSDFBoundsMin;
uniform vec3      uSDFBoundsMax;
uniform bool      uHasSDF;

// ---- Cloud Parameters ----
uniform float uCloudInnerRadius;
uniform float uCloudOuterRadius;
uniform float uCloudCoverage;
uniform float uCloudDensity;
uniform float uCloudSpeed;
uniform vec3  uCloudColor;
uniform vec3  uCloudShadowColor;

// ---- Atmosphere Parameters ----
uniform float uAtmoRadius;
uniform float uPlanetRadius;
uniform vec3  uRayleighCoeff;
uniform float uRayleighScale;
uniform float uMieCoeff;
uniform float uMieScale;
uniform float uMieG;

// ---- Raymarching Limits ----
uniform float uMaxDist;
uniform float uHitEpsilon;

#define PI 3.14159265359

// =====================================================================
//  Terrain SDF
// =====================================================================

float sdTerrain(vec3 p) {
  if (!uHasSDF) return 1e20;
  vec3 uvw = (p - uSDFBoundsMin) / (uSDFBoundsMax - uSDFBoundsMin);
  if (any(lessThan(uvw, vec3(0.0))) || any(greaterThan(uvw, vec3(1.0)))) {
    vec3 d = max(uSDFBoundsMin - p, p - uSDFBoundsMax);
    return length(max(d, 0.0));
  }
  return texture(uSDFTexture, uvw).r;
}

vec3 sdTerrainNormal(vec3 p) {
  vec3 texelSize = (uSDFBoundsMax - uSDFBoundsMin) / vec3(textureSize(uSDFTexture, 0));
  vec2 e = vec2(texelSize.x, 0.0);
  return normalize(vec3(
    sdTerrain(p + e.xyy) - sdTerrain(p - e.xyy),
    sdTerrain(p + e.yxy) - sdTerrain(p - e.yxy),
    sdTerrain(p + e.yyx) - sdTerrain(p - e.yyx)
  ));
}

float sceneSDF(vec3 p) {
  // Also consider the planet body as a sphere SDF
  float planetDist = length(p) - uPlanetRadius;
  float terrainDist = sdTerrain(p);
  return min(planetDist, terrainDist);
}

// =====================================================================
//  Ray-Sphere Intersection
// =====================================================================

vec2 raySphereIntersect(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float disc = b * b - c;
  if (disc < 0.0) return vec2(1e20, -1e20);
  float sq = sqrt(disc);
  return vec2(-b - sq, -b + sq);
}

// =====================================================================
//  Noise & Cloud Density (from Clouds.ts)
// =====================================================================

float hash3(vec3 p) {
  p = fract(p * vec3(443.8975, 397.2973, 491.1871));
  p += dot(p, p.yxz + 19.19);
  return fract((p.x + p.y) * p.z);
}

float valueNoise3D(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(mix(hash3(i + vec3(0,0,0)), hash3(i + vec3(1,0,0)), u.x),
                 mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), u.x), u.y),
             mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), u.x),
                 mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), u.x), u.y), u.z);
}

float cloudFBM(vec3 p) {
  float value = 0.0, amp = 0.5, freq = 1.0, total = 0.0;
  for (int i = 0; i < 4; i++) {
    value += amp * valueNoise3D(p * freq);
    total += amp;
    amp *= 0.5;
    freq *= 2.3;
  }
  return value / total;
}

float sampleCloudDensity(vec3 pos) {
  float r = length(pos);
  float shellThickness = uCloudOuterRadius - uCloudInnerRadius;
  float heightFrac = clamp((r - uCloudInnerRadius) / shellThickness, 0.0, 1.0);

  float heightGrad = smoothstep(0.0, 0.15, heightFrac)
                   * smoothstep(1.0, 0.65, heightFrac);

  vec3 windOffset = vec3(uTime * uCloudSpeed * 0.7, 0.0, uTime * uCloudSpeed);
  vec3 noisePos = pos * 0.008 + windOffset;

  float shape = cloudFBM(noisePos);
  float detail = cloudFBM(noisePos * 3.0 + vec3(37.0));
  float density = shape - detail * 0.35;

  density = smoothstep(1.0 - uCloudCoverage, 1.0, density);
  density *= heightGrad * uCloudDensity;

  return max(density, 0.0);
}

// =====================================================================
//  Phase Functions
// =====================================================================

float henyeyGreenstein(float cosTheta, float g) {
  float g2 = g * g;
  return (1.0 / (4.0 * PI)) * (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5);
}

float phaseRayleigh(float cosTheta) {
  return (3.0 / (16.0 * PI)) * (1.0 + cosTheta * cosTheta);
}

float phaseMie(float cosTheta, float g) {
  float g2 = g * g;
  return (3.0 / (8.0 * PI)) * (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5);
}

// =====================================================================
//  Interleaved Gradient Noise (Jimenez 2014)
// =====================================================================

float interleavedGradientNoise(vec2 fragCoord) {
  vec3 magic = vec3(0.06711056, 0.00583715, 52.9829189);
  return fract(magic.z * fract(dot(fragCoord, magic.xy)));
}

// =====================================================================
//  Cloud Light March — volumetric shadow for clouds only
// =====================================================================

float cloudLightMarch(vec3 pos) {
  vec2 tSun = raySphereIntersect(pos, uSunDir, uCloudOuterRadius);
  float sunPathLen = max(tSun.y, 0.0);
  float sunStep = sunPathLen / 6.0;

  float tau = 0.0;
  for (int j = 0; j < 6; j++) {
    float t = (float(j) + 0.5) * sunStep;
    vec3 lightSample = pos + uSunDir * t;

    if (length(lightSample) < uPlanetRadius) return 0.0;

    float lr = length(lightSample);
    if (lr >= uCloudInnerRadius && lr <= uCloudOuterRadius) {
      tau += sampleCloudDensity(lightSample) * sunStep;
    }
  }

  return exp(-tau * 0.6);
}

// =====================================================================
//  Terrain Surface Lighting
// =====================================================================

vec3 shadeSurface(vec3 pos, vec3 normal, vec3 rayDir) {
  float NdotL = max(dot(normal, uSunDir), 0.0);

  float r = length(pos);
  float alt = r - uPlanetRadius;
  float altNorm = clamp(alt / 80.0, 0.0, 1.0);

  vec3 baseColor;
  if (altNorm < 0.05) {
    baseColor = vec3(0.76, 0.70, 0.50);
  } else if (altNorm < 0.4) {
    baseColor = mix(vec3(0.08, 0.22, 0.04), vec3(0.14, 0.28, 0.06), altNorm / 0.4);
  } else if (altNorm < 0.7) {
    baseColor = vec3(0.32, 0.28, 0.24);
  } else {
    baseColor = mix(vec3(0.36, 0.32, 0.26), vec3(0.92, 0.93, 0.96), (altNorm - 0.7) / 0.3);
  }

  // Simple shadow: trace a short ray toward sun, check SDF
  float shadow = 1.0;
  vec3 shadowOrigin = pos + normal * 1.0;
  for (int i = 0; i < 16; i++) {
    float st = 1.0 + float(i) * 3.0;
    vec3 sp = shadowOrigin + uSunDir * st;
    float sd = sceneSDF(sp);
    if (sd < 0.1) { shadow = 0.3; break; }
  }

  vec3 ambient = baseColor * 0.15;
  vec3 diffuse = baseColor * NdotL * uSunIntensity * 0.08 * shadow;

  float hemi = 0.5 + 0.5 * dot(normal, normalize(pos));
  vec3 hemiColor = baseColor * hemi * 0.05;

  return ambient + diffuse + hemiColor;
}

// =====================================================================
//  PHASE 1: Sphere-trace to find solid surface hit
//  Pure SDF tracing — no volumetric sampling, fast large steps.
//  Returns hit distance, or -1.0 if no hit.
// =====================================================================

float traceScene(vec3 ro, vec3 rd, float tStart, float tEnd) {
  float t = tStart;
  for (int i = 0; i < 128; i++) {
    if (t > tEnd) break;
    vec3 p = ro + rd * t;
    float d = sceneSDF(p);
    if (d < uHitEpsilon) return t;
    t += max(d, 0.5); // min step 0.5 to avoid infinite loops near surface
  }
  return -1.0;
}

// =====================================================================
//  PHASE 2: Cloud raymarching (fixed-step through cloud shell)
//  Outputs accumulated luminance and transmittance.
// =====================================================================

void marchClouds(
  vec3 ro, vec3 rd, float tEnd, float cosTheta, float jitter,
  out vec3 cloudLum, out float cloudTransmittance
) {
  cloudLum = vec3(0.0);
  cloudTransmittance = 1.0;

  // Intersect cloud shell
  vec2 tOuter = raySphereIntersect(ro, rd, uCloudOuterRadius);
  vec2 tInner = raySphereIntersect(ro, rd, uCloudInnerRadius);

  if (tOuter.x > tOuter.y) return; // miss

  float camR = length(ro);
  float cStart, cEnd;

  if (camR < uCloudInnerRadius) {
    cStart = tInner.y;
    cEnd = tOuter.y;
  } else if (camR > uCloudOuterRadius) {
    cStart = tOuter.x;
    if (tInner.x < tInner.y && tInner.x > 0.0) {
      cEnd = tInner.x;
    } else {
      cEnd = tOuter.y;
    }
  } else {
    cStart = 0.0;
    if (tInner.x < tInner.y && tInner.x > 0.0) {
      cEnd = tInner.x;
    } else {
      cEnd = tOuter.y;
    }
  }

  cStart = max(cStart, 0.0);
  cEnd = min(cEnd, tEnd); // stop at solid surface

  if (cStart >= cEnd) return;

  // Phase function
  float phase = mix(
    henyeyGreenstein(cosTheta, 0.0),
    henyeyGreenstein(cosTheta, 0.75),
    0.7
  );

  float segLen = cEnd - cStart;
  float shellThickness = uCloudOuterRadius - uCloudInnerRadius;
  float densityScale = shellThickness / max(segLen, shellThickness);

  const int NUM_CLOUD_STEPS = 48;
  float stepSize = segLen / float(NUM_CLOUD_STEPS);
  float tCloud = cStart + jitter * stepSize;

  for (int i = 0; i < NUM_CLOUD_STEPS; i++) {
    if (cloudTransmittance < 0.01) break;
    float t = tCloud + float(i) * stepSize;
    if (t > cEnd) break;

    vec3 pos = ro + rd * t;
    float density = sampleCloudDensity(pos) * densityScale;

    if (density > 0.001) {
      float sampleTau = density * stepSize;
      float sampleT = exp(-sampleTau);

      float sunT = cloudLightMarch(pos);

      float powder = 1.0 - exp(-density * stepSize * 2.0);
      float beerPowder = mix(powder, 1.0, 0.5 + 0.5 * cosTheta);

      vec3 sunLight = uCloudColor * uSunIntensity * sunT * phase * beerPowder;

      vec3 sampleDir = normalize(pos);
      float dayFactor = smoothstep(-0.1, 0.3, dot(sampleDir, uSunDir));
      vec3 ambient = uCloudShadowColor * (dayFactor * 0.5 + 0.05);

      vec3 integScatter = (sunLight + ambient) * (1.0 - sampleT);
      cloudLum += cloudTransmittance * integScatter;
      cloudTransmittance *= sampleT;
    }
  }
}

// =====================================================================
//  PHASE 3: Atmosphere raymarching (fixed-step, Rayleigh + Mie)
//  Matches the existing Atmosphere.ts approach exactly.
// =====================================================================

void marchAtmosphere(
  vec3 ro, vec3 rd, float tEnd,
  out vec3 atmoScatter, out float atmoAlpha
) {
  atmoScatter = vec3(0.0);
  atmoAlpha = 0.0;

  vec2 tAtmo = raySphereIntersect(ro, rd, uAtmoRadius);
  if (tAtmo.x > tAtmo.y) return;

  // Planet body occlusion
  vec2 tPlanet = raySphereIntersect(ro, rd, uPlanetRadius);
  bool hitPlanet = (tPlanet.x < tPlanet.y) && (tPlanet.x > 0.0);

  float aStart = max(tAtmo.x, 0.0);
  float aEnd = hitPlanet ? min(tPlanet.x, tAtmo.y) : tAtmo.y;

  // Stop at solid surface if closer
  if (tEnd > 0.0 && tEnd < aEnd) {
    aEnd = tEnd;
  }

  if (aStart >= aEnd) return;

  const int NUM_ATMO_STEPS = 16;
  const int NUM_LIGHT_STEPS = 8;
  float stepSize = (aEnd - aStart) / float(NUM_ATMO_STEPS);

  float optDepthR = 0.0;
  float optDepthM = 0.0;
  vec3 totalR = vec3(0.0);
  vec3 totalM = vec3(0.0);

  for (int i = 0; i < NUM_ATMO_STEPS; i++) {
    float t = aStart + (float(i) + 0.5) * stepSize;
    vec3 pos = ro + rd * t;
    float r = length(pos);
    float alt = r - uPlanetRadius;

    if (alt < 0.0) continue;

    float densR = exp(-alt / uRayleighScale) * stepSize;
    float densM = exp(-alt / uMieScale) * stepSize;

    optDepthR += densR;
    optDepthM += densM;

    // Sun light march
    vec2 tSunAtmo = raySphereIntersect(pos, uSunDir, uAtmoRadius);
    float sunPathLen = max(tSunAtmo.y, 0.0);
    float sunStepSize = sunPathLen / float(NUM_LIGHT_STEPS);

    float optDepthLR = 0.0;
    float optDepthLM = 0.0;
    bool shadow = false;

    for (int j = 0; j < NUM_LIGHT_STEPS; j++) {
      float ts = (float(j) + 0.5) * sunStepSize;
      vec3 lightSample = pos + uSunDir * ts;
      float lightAlt = length(lightSample) - uPlanetRadius;

      if (lightAlt < 0.0) { shadow = true; break; }
      optDepthLR += exp(-lightAlt / uRayleighScale) * sunStepSize;
      optDepthLM += exp(-lightAlt / uMieScale) * sunStepSize;
    }

    if (!shadow) {
      vec3 tau = uRayleighCoeff * (optDepthR + optDepthLR)
               + uMieCoeff * (optDepthM + optDepthLM);
      vec3 attenuation = exp(-tau);
      totalR += densR * attenuation;
      totalM += densM * attenuation;
    }
  }

  float cosTheta = dot(rd, uSunDir);
  float pR = phaseRayleigh(cosTheta);
  float pM = phaseMie(cosTheta, uMieG);

  atmoScatter = uSunIntensity * (pR * uRayleighCoeff * totalR + pM * uMieCoeff * totalM);

  // Transmittance for alpha
  vec3 totalTau = uRayleighCoeff * optDepthR + uMieCoeff * optDepthM;
  vec3 transmittanceRGB = exp(-totalTau * 1.5);
  float transmittance = dot(transmittanceRGB, vec3(0.2126, 0.7152, 0.0722));
  atmoAlpha = 1.0 - transmittance;
}

// =====================================================================
//  Main — Sequential multi-phase composition
// =====================================================================

void main() {
  // ---- Reconstruct ray ----
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 clipPos = vec4(ndc, -1.0, 1.0);
  vec4 viewPos = uInvProjection * clipPos;
  viewPos.xyz /= viewPos.w;
  vec3 rayDir = normalize((uInvView * vec4(viewPos.xyz, 0.0)).xyz);
  vec3 rayOrigin = uCameraPos;

  float jitter = interleavedGradientNoise(gl_FragCoord.xy);

  // ---- Clip ray to atmosphere ----
  vec2 tAtmo = raySphereIntersect(rayOrigin, rayDir, uAtmoRadius);
  if (tAtmo.x > tAtmo.y) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  float rayStart = max(tAtmo.x, 0.0);
  float rayEnd = min(tAtmo.y, uMaxDist);

  // ---- PHASE 1: Find solid surface ----
  float tHit = traceScene(rayOrigin, rayDir, rayStart, rayEnd);

  // The effective end of the ray for volumetrics
  float tSolid = (tHit > 0.0) ? tHit : rayEnd;

  // ---- PHASE 2: Cloud march ----
  float cosTheta = dot(rayDir, uSunDir);
  vec3 cloudLum;
  float cloudTransmittance;
  marchClouds(rayOrigin, rayDir, tSolid, cosTheta, jitter, cloudLum, cloudTransmittance);

  // ---- PHASE 3: Atmosphere ----
  vec3 atmoScatter;
  float atmoAlpha;
  marchAtmosphere(rayOrigin, rayDir, tSolid, atmoScatter, atmoAlpha);

  // ---- Compose ----
  vec3 finalColor = vec3(0.0);

  // Surface contribution
  if (tHit > 0.0) {
    vec3 hitPos = rayOrigin + rayDir * tHit;
    vec3 hitNormal = sdTerrainNormal(hitPos);
    vec3 surfaceColor = shadeSurface(hitPos, hitNormal, rayDir);

    // Attenuate by cloud transmittance and atmosphere
    surfaceColor *= cloudTransmittance;
    surfaceColor *= (1.0 - atmoAlpha);

    finalColor += surfaceColor;
  }

  // Cloud luminance (already tone-mapped by Beer integration)
  vec3 cloudToned = 1.0 - exp(-cloudLum);
  finalColor += cloudToned;

  // Atmosphere scatter
  vec3 atmoToned = 1.0 - exp(-atmoScatter);
  finalColor += atmoToned;

  finalColor = clamp(finalColor, 0.0, 1.0);
  fragColor = vec4(finalColor, 1.0);
}
`;

// ---------------------------------------------------------------------------
// TypeScript Class
// ---------------------------------------------------------------------------

export class UnifiedRenderer {
  private material: THREE.ShaderMaterial;
  private scene: THREE.Scene;
  private camera: THREE.Camera;
  private mesh: THREE.Mesh;
  private config: UnifiedRendererConfig;

  constructor(config?: Partial<UnifiedRendererConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        // Camera
        uInvProjection: { value: new THREE.Matrix4() },
        uInvView:       { value: new THREE.Matrix4() },
        uCameraPos:     { value: new THREE.Vector3() },
        uTime:          { value: 0.0 },

        // Sun
        uSunDir:        { value: new THREE.Vector3(1, 0.5, 0.8).normalize() },
        uSunIntensity:  { value: this.config.sunIntensity },

        // SDF Terrain
        uSDFTexture:    { value: null },
        uSDFBoundsMin:  { value: new THREE.Vector3() },
        uSDFBoundsMax:  { value: new THREE.Vector3() },
        uHasSDF:        { value: false },

        // Clouds
        uCloudInnerRadius: { value: this.config.cloudInnerRadius },
        uCloudOuterRadius: { value: this.config.cloudOuterRadius },
        uCloudCoverage:    { value: this.config.cloudCoverage },
        uCloudDensity:     { value: this.config.cloudDensity },
        uCloudSpeed:       { value: this.config.cloudSpeed },
        uCloudColor:       { value: this.config.cloudColor.clone() },
        uCloudShadowColor: { value: this.config.cloudShadowColor.clone() },

        // Atmosphere
        uAtmoRadius:    { value: this.config.atmoRadius },
        uPlanetRadius:  { value: this.config.planetRadius },
        uRayleighCoeff: { value: this.config.rayleighCoeff.clone() },
        uRayleighScale: { value: this.config.rayleighScaleHeight },
        uMieCoeff:      { value: this.config.mieCoeff },
        uMieScale:      { value: this.config.mieScaleHeight },
        uMieG:          { value: this.config.mieG },

        // Raymarching limits
        uMaxDist:       { value: this.config.maxDist },
        uHitEpsilon:    { value: this.config.hitEpsilon },
      },
      depthWrite: false,
      depthTest: false,
    });

    // Full-screen triangle
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(
      [-1, -1, 0,  3, -1, 0,  -1, 3, 0],
      3,
    ));
    geo.setDrawRange(0, 3);

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;

    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  setTerrainSDF(sdfResult: MeshSDFResult): void {
    this.material.uniforms['uSDFTexture'].value = sdfResult.texture;
    (this.material.uniforms['uSDFBoundsMin'].value as THREE.Vector3).copy(sdfResult.boundsMin);
    (this.material.uniforms['uSDFBoundsMax'].value as THREE.Vector3).copy(sdfResult.boundsMax);
    this.material.uniforms['uHasSDF'].value = true;
  }

  update(
    camera: THREE.PerspectiveCamera,
    sunDir: THREE.Vector3,
    elapsedTime: number,
  ): void {
    const invProj = this.material.uniforms['uInvProjection'].value as THREE.Matrix4;
    invProj.copy(camera.projectionMatrix).invert();

    const invView = this.material.uniforms['uInvView'].value as THREE.Matrix4;
    invView.copy(camera.matrixWorld);

    (this.material.uniforms['uCameraPos'].value as THREE.Vector3).copy(camera.position);
    (this.material.uniforms['uSunDir'].value as THREE.Vector3).copy(sunDir).normalize();
    this.material.uniforms['uTime'].value = elapsedTime;
  }

  render(renderer: THREE.WebGLRenderer): void {
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
  }

  setSize(_width: number, _height: number): void {
    // Reserved for resolution-dependent uniforms
  }

  setUniform(name: string, value: number | boolean | THREE.Vector3 | THREE.Matrix4): void {
    const u = this.material.uniforms[name];
    if (!u) return;
    if (value instanceof THREE.Vector3) {
      (u.value as THREE.Vector3).copy(value);
    } else if (value instanceof THREE.Matrix4) {
      (u.value as THREE.Matrix4).copy(value);
    } else {
      u.value = value;
    }
  }

  getUniform(name: string): unknown {
    return this.material.uniforms[name]?.value;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
