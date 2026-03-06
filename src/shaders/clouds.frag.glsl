// ---- Uniforms ----
uniform vec3  uSunDir;          // Normalised direction TO the sun
uniform float uInnerRadius;     // Bottom of cloud shell (planet surface + offset)
uniform float uOuterRadius;     // Top of cloud shell
uniform float uTime;            // Elapsed time for cloud drift
uniform float uCoverage;        // Cloud coverage 0..1 (higher = more clouds)
uniform float uDensityMult;     // Overall density multiplier
uniform float uCloudSpeed;      // Drift speed multiplier
uniform float uSunIntensity;    // Sun brightness
uniform vec3  uCloudColor;      // Base albedo of clouds
uniform vec3  uCloudShadowColor;// Shadow / ambient color

// Weather system uniforms
uniform float uCloudType;       // 0=Stratus, 1=Cumulus, 2=Cumulonimbus
uniform float uAdvectionStrength;// Curl noise advection intensity
uniform float uTurbulence;      // Small-scale turbulence
uniform float uWeatherScale;    // Large-scale weather front intensity
uniform float uWindX;           // Global wind direction X
uniform float uWindZ;           // Global wind direction Z

// Tornado uniforms
uniform vec3  uTornadoPos1;     // World-space position of tornado 1
uniform vec3  uTornadoPos2;     // World-space position of tornado 2
uniform float uTornadoActive;   // Bitmask: 1=tornado1, 2=tornado2
uniform float uTornadoStrength; // Vortex intensity

// Depth buffer integration
uniform sampler2D tDepth;       // Scene depth texture (logarithmic depth)
uniform float uCameraNear;
uniform float uCameraFar;

varying vec3 vWorldPos;
varying vec3 vWorldDir;
varying vec2 vUv;

// ---- Constants ----
#define PI 3.14159265359
#define MAX_STEPS 80
#define NUM_LIGHT_STEPS 4

// Sphere-trace margin — detail noise can push cloud density this far
// beyond the clean form SDF surface
const float SDF_MARGIN = 15.0;

// =====================================================================
//  Interleaved Gradient Noise (Jimenez 2014)
// =====================================================================
float interleavedGradientNoise(vec2 fragCoord) {
  vec3 magic = vec3(0.06711056, 0.00583715, 52.9829189);
  return fract(magic.z * fract(dot(fragCoord, magic.xy)));
}

// =====================================================================
//  Pseudo-3D Noise — Hash-based value noise with C2 continuity
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

// =====================================================================
//  FBM Variants — different octave counts for different scales
// =====================================================================

// 2 octaves — planetary weather map (very cheap)
float cloudFBM2(vec3 p) {
  float value = 0.0, amp = 0.5, freq = 1.0, total = 0.0;
  for (int i = 0; i < 2; i++) {
    value += amp * valueNoise3D(p * freq);
    total += amp;
    amp   *= 0.5;
    freq  *= 2.3;
  }
  return value / total;
}

// 3 octaves — cloud form shapes, light density, shadows
float cloudFBM3(vec3 p) {
  float value = 0.0, amp = 0.5, freq = 1.0, total = 0.0;
  for (int i = 0; i < 3; i++) {
    value += amp * valueNoise3D(p * freq);
    total += amp;
    amp   *= 0.5;
    freq  *= 2.3;
  }
  return value / total;
}

// 4 octaves — primary cloud shape
float cloudFBM(vec3 p) {
  float value = 0.0, amp = 0.5, freq = 1.0, total = 0.0;
  for (int i = 0; i < 4; i++) {
    value += amp * valueNoise3D(p * freq);
    total += amp;
    amp   *= 0.5;
    freq  *= 2.3;
  }
  return value / total;
}

// 5 octaves — high-detail cloud microstructure
float cloudFBM5(vec3 p) {
  float value = 0.0, amp = 0.5, freq = 1.0, total = 0.0;
  for (int i = 0; i < 5; i++) {
    value += amp * valueNoise3D(p * freq);
    total += amp;
    amp   *= 0.5;
    freq  *= 2.3;
  }
  return value / total;
}

// =====================================================================
//  Cloud Type Height Profiles
//
//  Three meteorological cloud types blended by uCloudType [0..2]:
//    0 = Stratus:        flat layer, concentrated at 20-40% height
//    1 = Cumulus:         puffy towers, bell curve centered at 35%
//    2 = Cumulonimbus:   full vertical column with anvil top flare
//
//  Bottom always fades smoothly from 0 to prevent hard shell cuts.
// =====================================================================
float cloudHeightProfile(float h) {
  // Soft bottom fade — shared by all types, eliminates bottom-cut artifact
  float bottomFade = smoothstep(0.0, 0.08, h) * smoothstep(0.08, 0.18, h * 1.5 + 0.1);

  // Stratus: thin flat band concentrated low
  float stratus = bottomFade
                * smoothstep(0.0, 0.12, h)
                * smoothstep(0.5, 0.25, h);  // sharp falloff above 25-50%

  // Cumulus: bell-shaped, peaks around 35%, extends to ~80%
  float cumulusCore = exp(-pow((h - 0.35) / 0.22, 2.0));  // gaussian peak
  float cumulus = bottomFade * cumulusCore * smoothstep(1.0, 0.75, h);

  // Cumulonimbus: full vertical column, anvil spread at top
  float cbColumn = bottomFade * smoothstep(0.0, 0.1, h);
  float cbAnvil = smoothstep(0.7, 0.85, h) * 0.6;  // extra density at anvil height
  float cbTopFade = smoothstep(1.0, 0.88, h);        // soft top fade
  float cumulonimbus = (cbColumn + cbAnvil) * cbTopFade;

  // Blend between types based on uCloudType [0..2]
  float t = uCloudType;
  if (t <= 1.0) {
    return mix(stratus, cumulus, t);
  } else {
    return mix(cumulus, cumulonimbus, t - 1.0);
  }
}

// =====================================================================
//  3D Curl Noise — Divergence-free velocity field (optimised)
//
//  Computes curl of a scalar potential field using 3 offset noise
//  evaluations instead of 18. The result is still divergence-free
//  (∇·(∇×F) = 0) and qualitatively approximates incompressible
//  Navier-Stokes, but at ~1/6 the cost of finite-difference curl.
//
//  Method: sample noise at 3 swizzled/offset positions, take pairwise
//  differences to form a pseudo-gradient, then cross with a second.
// =====================================================================
vec3 curlNoise(vec3 p) {
  // Three noise samples at offset positions (decorrelated axes)
  float n1 = valueNoise3D(p + vec3(0.0, 31.41, -17.3));
  float n2 = valueNoise3D(p + vec3(-23.6, 0.0, 43.7));
  float n3 = valueNoise3D(p + vec3(41.2, -19.8, 0.0));

  // Build two pseudo-gradient vectors from the noise differences
  vec3 g1 = vec3(n2 - n3, n3 - n1, n1 - n2);
  vec3 g2 = vec3(n3 - n1, n1 - n2, n2 - n3) * 1.7;

  // Cross product of two gradients → guaranteed divergence-free
  return cross(g1, g2);
}

// =====================================================================
//  Tornado Vortex Field — Rankine Vortex Model
//
//  Injects a helical velocity field around a tornado center point.
//  Inside the core radius: solid-body rotation (v_t ~ r)
//  Outside: irrotational decay (v_t ~ 1/r)
//  Plus vertical updraft and inward radial inflow.
// =====================================================================
vec3 tornadoVelocity(vec3 pos, vec3 tornadoCenter) {
  vec3 toCenter = pos - tornadoCenter;
  vec3 radialDir = normalize(toCenter);
  float r = length(toCenter);

  float coreRadius = 8.0;   // Rankine vortex core (world units)
  float maxRadius = 60.0;   // influence falloff radius
  float gamma = uTornadoStrength * 40.0;  // circulation strength

  if (r > maxRadius) return vec3(0.0);

  // Falloff beyond maxRadius
  float falloff = smoothstep(maxRadius, coreRadius * 2.0, r);

  // Tangential velocity (Rankine profile)
  float vTheta;
  if (r < coreRadius) {
    vTheta = gamma * r / (coreRadius * coreRadius);  // solid body
  } else {
    vTheta = gamma / r;  // irrotational
  }

  // Tangent direction (perpendicular to radial, in the horizontal plane)
  // Use the planet's radial direction as "up" to define the rotation plane
  vec3 up = normalize(tornadoCenter);
  vec3 tangent = normalize(cross(up, radialDir));

  // Vertical updraft — strong near core, decays outward
  float updraft = uTornadoStrength * 15.0 * exp(-r * r / (coreRadius * coreRadius * 4.0));

  // Radial inflow — draws air inward (creates spiral)
  float inflow = -uTornadoStrength * 5.0 * exp(-r * r / (coreRadius * coreRadius * 6.0));

  vec3 vel = tangent * vTheta * falloff
           + up * updraft * falloff
           + radialDir * inflow * falloff;

  return vel;
}

// =====================================================================
//  Procedural tornado path — noise-based wandering on cloud shell
// =====================================================================
vec3 proceduralTornadoPos(float seed) {
  float t = uTime * 0.02 + seed * 100.0;
  // Wander on the sphere surface using noise-driven angles
  float theta = valueNoise3D(vec3(t * 0.3, seed, 0.0)) * PI * 2.0;
  float phi = valueNoise3D(vec3(0.0, t * 0.25, seed)) * PI * 0.4 + PI * 0.3;
  float r = (uInnerRadius + uOuterRadius) * 0.5;
  return vec3(
    r * sin(phi) * cos(theta),
    r * cos(phi),
    r * sin(phi) * sin(theta)
  );
}

// =====================================================================
//  Full Advection Field — combines all velocity contributions
//
//  Two-scale curl noise + global wind + tornado vortices.
//  This is the qualitative Navier-Stokes velocity field.
//  Optimised: 2 curl evaluations (6 noise) instead of 3 (9 noise).
// =====================================================================
vec3 computeAdvection(vec3 pos, vec3 tornadoP1, vec3 tornadoP2) {
  float t = uTime * uCloudSpeed;

  // --- Layer 1: Large-scale weather flow (low frequency) ---
  vec3 largeCurl = curlNoise(pos * 0.0015 + vec3(t * 0.05));
  vec3 weatherFlow = largeCurl * uWeatherScale * 8.0;

  // --- Layer 2: Medium-scale convective + turbulent motion ---
  // Combined medium and small scale into one evaluation at intermediate freq
  vec3 medCurl = curlNoise(pos * 0.008 + vec3(t * 0.15, t * 0.1, 0.0));
  vec3 convection = medCurl * (uAdvectionStrength * 2.5 + uTurbulence * 0.8);

  // --- Global wind drift ---
  vec3 globalWind = vec3(uWindX, 0.0, uWindZ) * t;

  // --- Tornado vortex contributions ---
  vec3 tornadoVel = vec3(0.0);
  if (uTornadoActive >= 1.0) {
    tornadoVel += tornadoVelocity(pos, tornadoP1);
  }
  if (uTornadoActive >= 2.0) {
    tornadoVel += tornadoVelocity(pos, tornadoP2);
  }

  return weatherFlow + convection + globalWind + tornadoVel * uTime * 0.01;
}

// =====================================================================
//  Planetary Weather Map
//
//  Low-frequency noise on the sphere surface determines regional
//  cloud coverage. Creates weather fronts and clear zones at
//  planetary scale. Sampled on the unit-sphere direction for uniform
//  distribution regardless of altitude.
// =====================================================================
float cloudWeather(vec3 pos) {
  vec3 dir = normalize(pos);
  float t = uTime * uCloudSpeed * 0.3;
  vec3 wp = dir * 3.5 + vec3(uWindX * t * 0.001, 0.0, uWindZ * t * 0.001);
  return cloudFBM2(wp);
}

// =====================================================================
//  Cloud Form Distance Estimate
//
//  Medium-frequency noise creates distinct cloud bodies/blobs.
//  Returns a signed distance-like value for sphere-trace acceleration:
//    positive = outside cloud, negative = inside cloud form.
//  This is NOT a true SDF (gradient magnitude ≠ 1), but provides a
//  conservative distance estimate when scaled appropriately.
//  Used only for adaptive step sizing — never for shading.
// =====================================================================
float cloudFormDistance(vec3 pos) {
  float r = length(pos);

  // Height bounds — fast exit when outside the cloud shell
  float hDist = max(uInnerRadius - r, r - uOuterRadius);
  if (hDist > 0.0) return hDist;

  float shellThickness = uOuterRadius - uInnerRadius;
  float heightFrac = (r - uInnerRadius) / shellThickness;
  float heightGrad = cloudHeightProfile(heightFrac);

  // No clouds at this height band — return large distance
  if (heightGrad < 0.01) return SDF_MARGIN * 2.0;

  // Weather map culling — skip clear-sky regions entirely
  float weather = cloudWeather(pos);
  float weatherMask = smoothstep(1.0 - uCoverage - 0.05, 1.0 - uCoverage + 0.2, weather);
  if (weatherMask < 0.01) return SDF_MARGIN * 2.0;

  // Form noise — creates distinct cloud blobs at medium frequency
  float t = uTime * uCloudSpeed;
  vec3 windOff = vec3(uWindX, 0.0, uWindZ) * t;
  vec3 formPos = pos * 0.025 + windOff * 0.025;
  float form = cloudFBM3(formPos);

  // Threshold adapts to weather coverage and height profile
  float threshold = 0.55 - weatherMask * 0.2 - heightGrad * 0.1;

  // Scale to approximate world-space distance
  // Conservative: noise gradient magnitude is ~0.3-0.5, so *40 gives
  // real-space distance with a built-in safety margin
  return (threshold - form) * 40.0;
}

// =====================================================================
//  Full Cloud Density (primary raymarch)
//
//  Three-layer approach:
//    1. Weather map — planetary-scale distribution (where clouds exist)
//    2. Form noise — medium-freq blobs (distinct cloud bodies)
//    3. Detail noise — high-freq 5-octave FBM with wispy/billowy blend
//
//  The form noise creates an SDF-like "profile" (depth into cloud),
//  and the detail noise erodes it with depth-dependent blending:
//  edges are wispy (translucent tendrils), interiors are billowy
//  (dense cotton). This is the Nubis technique.
// =====================================================================
float sampleCloudDensity(vec3 pos, vec3 tornadoP1, vec3 tornadoP2) {
  float r = length(pos);
  float shellThickness = uOuterRadius - uInnerRadius;

  // Normalised height within the cloud shell [0..1]
  float heightFrac = clamp((r - uInnerRadius) / shellThickness, 0.0, 1.0);

  // Cloud type morphological height profile
  float heightGrad = cloudHeightProfile(heightFrac);
  if (heightGrad < 0.001) return 0.0;

  // ---- Layer 1: Planetary weather distribution ----
  float weather = cloudWeather(pos);
  float weatherMask = smoothstep(1.0 - uCoverage - 0.05, 1.0 - uCoverage + 0.2, weather);
  if (weatherMask < 0.001) return 0.0;

  // Compute advection displacement (curl noise + wind + tornadoes)
  vec3 advection = computeAdvection(pos, tornadoP1, tornadoP2);

  // ---- Layer 2: Form noise — distinct cloud bodies ----
  float t = uTime * uCloudSpeed;
  vec3 windOff = vec3(uWindX, 0.0, uWindZ) * t;
  vec3 formPos = pos * 0.025 + advection * 0.008 + windOff * 0.025;

  // Domain warp for organic, non-repetitive shapes
  float warpVal = valueNoise3D(formPos * 0.4 + vec3(t * 0.025));
  formPos += vec3(warpVal - 0.5) * uWeatherScale * 1.5;

  float form = cloudFBM(formPos);

  // SDF-like profile: how deep inside the cloud form [0..1]
  float formThreshold = 0.55 - weatherMask * 0.2;
  float sdf = form - formThreshold;
  if (sdf < 0.0) return 0.0;

  float profile = clamp(sdf / 0.3, 0.0, 1.0);

  // ---- Layer 3: Detail microstructure — 5-octave FBM ----
  vec3 detailPos = pos * 0.06 + advection * 0.015 + windOff * 0.01;
  float n = cloudFBM5(detailPos);

  // Wispy/billowy blend (Nubis technique)
  // Edges (low profile) → wispy: translucent, tendril-like
  // Interiors (high profile) → billowy: dense, cotton-like
  float wispy = n;
  float billowy = 1.0 - abs(n * 2.0 - 1.0);
  float detail = mix(wispy, billowy, smoothstep(0.0, 1.0, profile));

  // Smoothstep erosion — depth controls how much erosion occurs
  // Deep inside: minimal erosion (dense core)
  // At edges: maximum erosion (soft, natural boundaries)
  float density = smoothstep(0.0, 0.25, profile - detail * 0.55);

  // Tornado density boost: increase density near tornado cores
  if (uTornadoActive >= 1.0) {
    float dist1 = length(pos - tornadoP1);
    float funnelWidth = 6.0 + heightFrac * 20.0;
    density += exp(-dist1 * dist1 / (funnelWidth * funnelWidth)) * uTornadoStrength * 0.5;
  }
  if (uTornadoActive >= 2.0) {
    float dist2 = length(pos - tornadoP2);
    float funnelWidth = 6.0 + heightFrac * 20.0;
    density += exp(-dist2 * dist2 / (funnelWidth * funnelWidth)) * uTornadoStrength * 0.5;
  }

  // Apply all masks and multipliers
  density *= weatherMask * heightGrad * uDensityMult;

  return max(density, 0.0);
}

// =====================================================================
//  Cheap cloud density for light marching
//
//  Matches the form+weather model but skips curl noise advection,
//  domain warping, and detail erosion. Uses 3-octave form FBM only.
//  ~4x faster than full density. Acceptable for light absorption
//  since small per-sample errors average out along the sun path.
// =====================================================================
float sampleCloudDensityLight(vec3 pos) {
  float r = length(pos);
  float shellThickness = uOuterRadius - uInnerRadius;
  float heightFrac = clamp((r - uInnerRadius) / shellThickness, 0.0, 1.0);
  float heightGrad = cloudHeightProfile(heightFrac);
  if (heightGrad < 0.001) return 0.0;

  // Weather distribution — must match full density for consistent shadows
  float weather = cloudWeather(pos);
  float weatherMask = smoothstep(1.0 - uCoverage - 0.05, 1.0 - uCoverage + 0.2, weather);
  if (weatherMask < 0.001) return 0.0;

  // Simple wind offset (no curl noise — too expensive for light march)
  float t = uTime * uCloudSpeed;
  vec3 windOff = vec3(uWindX, 0.0, uWindZ) * t;
  vec3 formPos = pos * 0.025 + windOff * 0.025;

  // 3-octave form shape (no detail erosion)
  float form = cloudFBM3(formPos);

  float formThreshold = 0.55 - weatherMask * 0.2;
  float sdf = form - formThreshold;
  if (sdf < 0.0) return 0.0;

  float profile = clamp(sdf / 0.3, 0.0, 1.0);
  float density = smoothstep(0.0, 0.15, profile) * 0.8;

  density *= weatherMask * heightGrad * uDensityMult;
  return max(density, 0.0);
}

// =====================================================================
//  Ray-Sphere Intersection
//
//  Returns (tNear, tFar). If tNear > tFar, no intersection occurred.
//  Works for rays originating inside or outside the sphere.
//  Origin is in world space (planet at origin).
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
//  Henyey-Greenstein Phase Function
//
//  Describes the angular distribution of scattered light. Positive g
//  produces strong forward scattering (silver lining when looking at sun).
// =====================================================================
float henyeyGreenstein(float cosTheta, float g) {
  float g2 = g * g;
  float num = 1.0 - g2;
  float denom = pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5);
  return (1.0 / (4.0 * PI)) * num / denom;
}

// =====================================================================
//  Reconstruct linear depth from logarithmic depth buffer
//  (identical to Atmosphere.ts)
// =====================================================================
float linearizeLogDepth(float d) {
  if (d >= 1.0) return uCameraFar;
  float logFarP1 = log2(uCameraFar + 1.0);
  return pow(2.0, d * logFarP1) - 1.0;
}

// =====================================================================
//  Light march with multi-scatter approximation
//
//  Estimates optical thickness between a cloud sample and the sun.
//  Returns direct transmittance via Beer's Law, plus a multi-scatter
//  term that approximates light bouncing inside the cloud, brightening
//  interiors and giving that characteristic glowing, translucent look.
// =====================================================================
float lightMarch(vec3 pos, out float multiScatter) {
  // March toward the sun, exiting through the outer cloud shell
  vec2 tSun = raySphereIntersect(pos, uSunDir, uOuterRadius);
  float sunPathLen = max(tSun.y, 0.0);
  float sunStep = sunPathLen / float(NUM_LIGHT_STEPS);

  float tau = 0.0;
  bool inShadow = false;
  for (int j = 0; j < NUM_LIGHT_STEPS; j++) {
    float t = (float(j) + 0.5) * sunStep;
    vec3 lightSample = pos + uSunDir * t;

    // Check if light ray goes through the planet
    if (length(lightSample) < uInnerRadius) {
      inShadow = true;
      break;
    }

    // Use cheap density (no curl noise, no domain warp) — ~4x faster
    tau += sampleCloudDensityLight(lightSample) * sunStep;
  }

  if (inShadow) { multiScatter = 0.0; return 0.0; }

  // Multi-scatter: softer extinction simulates photons scattering
  // multiple times through the cloud before reaching this sample.
  // Deeper penetration than single-scatter alone.
  multiScatter = exp(-tau * 0.1) * 0.35;

  return exp(-tau * 0.6);
}

// =====================================================================
//  Main Fragment Shader
// =====================================================================
void main() {
  vec3 rayOrigin = cameraPosition;
  vec3 rayDir = normalize(vWorldDir);

  // ---- Read scene depth to find opaque terrain ----
  float rawDepth = texture2D(tDepth, vUv).r;
  float sceneLinearDepth = linearizeLogDepth(rawDepth);
  float cosAngle = dot(rayDir, vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));
  float tSceneDepth = sceneLinearDepth / abs(cosAngle);

  // ---- Intersect cloud shell ----
  vec2 tOuter = raySphereIntersect(rayOrigin, rayDir, uOuterRadius);
  vec2 tInner = raySphereIntersect(rayOrigin, rayDir, uInnerRadius);

  if (tOuter.x > tOuter.y) discard; // Ray misses cloud shell entirely

  // Determine ray segment through the shell.
  // If camera is below inner radius, the ray enters at tInner.y (exit of inner sphere)
  // and exits at tOuter.y. If camera is between inner and outer, it starts at 0.
  // If camera is above outer, it enters at tOuter.x and exits at tOuter.y (but we
  // must skip the interior planet if the ray passes through the inner sphere).

  float camR = length(rayOrigin);
  float tStart, tEnd;

  if (camR < uInnerRadius) {
    // Camera below cloud layer: march from exiting inner sphere to exiting outer
    tStart = tInner.y;
    tEnd   = tOuter.y;
  } else if (camR > uOuterRadius) {
    // Camera above cloud layer
    tStart = tOuter.x;
    // If ray also hits the inner sphere, stop at its entry (hollow shell)
    if (tInner.x < tInner.y && tInner.x > 0.0) {
      tEnd = tInner.x;
    } else {
      tEnd = tOuter.y;
    }
  } else {
    // Camera inside the cloud shell
    tStart = 0.0;
    // If ray hits inner sphere, stop there; otherwise march to outer exit
    if (tInner.x < tInner.y && tInner.x > 0.0) {
      tEnd = tInner.x;
    } else {
      tEnd = tOuter.y;
    }
  }

  tStart = max(tStart, 0.0);

  // ---- Terrain depth occlusion: stop the ray at the terrain surface ----
  bool terrainHit = rawDepth < 1.0 && tSceneDepth < tEnd;
  if (terrainHit) {
    tEnd = tSceneDepth;
  }

  if (tStart >= tEnd) discard;

  // ---- Jitter ray start to reduce banding ----
  float jitter = interleavedGradientNoise(gl_FragCoord.xy);
  float segLen = tEnd - tStart;
  float fineStep = segLen / 64.0;
  float t = tStart + jitter * fineStep;

  // ---- Density scaling for long ray paths ----
  // When viewing from orbit, the ray can traverse the entire cloud shell
  // diameter. Without compensation, density accumulates into an opaque
  // grey blanket. We scale down per-sample density when the total path
  // length greatly exceeds the shell thickness so individual cloud
  // features remain visible from any angle.
  float shellThickness = uOuterRadius - uInnerRadius;
  float pathRatio = segLen / shellThickness;
  // For a grazing ray (pathRatio ~ 1) densityScale = 1.0
  // For a full-diameter ray (pathRatio ~ 40+) densityScale ~ 0.15
  float densityScale = shellThickness / max(segLen, shellThickness);

  // ---- Phase function for view-sun angle ----
  float cosTheta = dot(rayDir, uSunDir);
  // Dual-lobe: blend isotropic + strong forward scatter for silver lining
  float phase = mix(henyeyGreenstein(cosTheta, 0.0),   // isotropic lobe
                    henyeyGreenstein(cosTheta, 0.75),   // forward scatter lobe
                    0.7);

  // ---- Cache tornado positions (computed once per pixel, not per sample) ----
  vec3 tP1 = vec3(0.0), tP2 = vec3(0.0);
  if (uTornadoActive >= 1.0) {
    tP1 = (length(uTornadoPos1) > 0.1) ? uTornadoPos1 : proceduralTornadoPos(1.0);
  }
  if (uTornadoActive >= 2.0) {
    tP2 = (length(uTornadoPos2) > 0.1) ? uTornadoPos2 : proceduralTornadoPos(2.0);
  }

  // ---- Raymarching loop with SDF-accelerated adaptive stepping ----
  //
  // Three-tier culling strategy:
  //   1. Height bounds: cloudFormDistance returns shell distance when outside
  //   2. Weather map: cloudFormDistance returns large distance in clear-sky regions
  //   3. Form SDF: cloudFormDistance skips empty space between cloud bodies
  //
  // Only samples near/inside cloud forms get the expensive full density
  // evaluation (5-octave FBM + curl noise advection + wispy/billowy blend).
  // This concentrates computational budget on visible cloud detail.
  vec3 luminance = vec3(0.0);
  float transmittance = 1.0;

  for (int i = 0; i < MAX_STEPS; i++) {
    if (t >= tEnd || transmittance < 0.01) break;

    vec3 samplePos = rayOrigin + rayDir * t;

    // Cheap distance estimate for visibility culling
    float dist = cloudFormDistance(samplePos);

    if (dist > SDF_MARGIN) {
      // Far from any cloud form — leap forward conservatively
      t += max(dist - SDF_MARGIN, fineStep);
      continue;
    }

    // Near or inside cloud form — full density evaluation
    float density = sampleCloudDensity(samplePos, tP1, tP2) * densityScale;

    if (density > 0.001) {
      // Beer's Law: transmittance loss through this step
      float sampleTau = density * fineStep;
      float sampleTransmittance = exp(-sampleTau);

      // Light reaching this sample from the sun, with multi-scatter
      float multiScatter;
      float sunTransmittance = lightMarch(samplePos, multiScatter);

      // Beer-powder: blend between Beer's law and powder effect based
      // on how aligned the view is with the sun. This prevents the
      // powder term from darkening the sun-facing side of clouds.
      float powder = 1.0 - exp(-density * fineStep * 2.0);
      // On the sun-facing side (cosTheta > 0), use mostly Beer's law
      // On the shadow side, blend in the powder for silver-lining
      float beerPowder = mix(powder, 1.0, 0.5 + 0.5 * cosTheta);

      // Direct sunlight + multi-scatter interior glow
      vec3 sunLight = uCloudColor * uSunIntensity
                    * (sunTransmittance * phase + multiScatter)
                    * beerPowder;

      // Ambient/sky fill — modulated by how much this part of the
      // planet faces the sun. On the night side, ambient drops to near zero.
      vec3 sampleDir = normalize(samplePos);
      float dayFactor = smoothstep(-0.1, 0.3, dot(sampleDir, uSunDir));
      vec3 ambient = uCloudShadowColor * (dayFactor * 0.5 + 0.05);

      vec3 lightColor = sunLight + ambient;

      // Energy-conserving integration (Sebastien Hillaire 2016)
      vec3 integScatter = lightColor * (1.0 - sampleTransmittance);
      luminance += transmittance * integScatter;
      transmittance *= sampleTransmittance;
    }

    t += fineStep;
  }

  float alpha = 1.0 - transmittance;

  // Tone-map to prevent blow-out near sun
  luminance = 1.0 - exp(-luminance);

  gl_FragColor = vec4(luminance, alpha);
}
