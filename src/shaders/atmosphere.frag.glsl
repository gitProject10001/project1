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
