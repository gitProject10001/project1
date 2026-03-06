uniform vec3  uSunDir;
uniform float uSunIntensity;
uniform float uPlanetRadius;
uniform float uOceanRadius;
uniform float uTime;

// Depth buffer
uniform sampler2D tDepth;
uniform float uCameraNear;
uniform float uCameraFar;

// Ocean optical properties
uniform vec3  uAbsorption;
uniform vec3  uScatterColor;
uniform float uMaxDepthFade;
uniform vec3  uShallowColor;
uniform vec3  uDeepColor;

// Wave parameters
uniform float uWaveHeight;
uniform float uWaveChoppy;
uniform float uWaveSpeed;
uniform float uWaveFreq;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vScreenUV;
varying vec3 vSphereNormal;
varying float vOceanViewDepth;
varying vec3 vCamForward;

// Log depth buffer — must match terrain's MeshPhongMaterial depth encoding
varying highp float vLogZ;

#define PI 3.14159265359

// ---- Gerstner-style wave normals (analytical, no noise lookups) ----
// The gradient of each wave sin(k·x - wt) is k*cos(k·x - wt).
// We accumulate gradients from 5 directional waves and use choppiness
// to control overall steepness.  The key is that the gradient magnitudes
// must be ~0.5-1.0 so the normal visibly tilts (~30°+).

vec3 waveNormal(vec2 uv, float t) {
  // strength controls how steep / visible the wave normals are.
  // At choppiness=4 → strength=0.8 → normals tilt up to ~35°.
  float strength = uWaveChoppy * 0.2;

  float dx = 0.0;
  float dz = 0.0;

  // Wave 1: primary swell  (weight 1.0)
  vec2 d1 = vec2(0.8, 0.6);
  float p1 = dot(d1, uv) * uWaveFreq - t * uWaveSpeed;
  float c1 = cos(p1);
  dx += d1.x * c1;
  dz += d1.y * c1;

  // Wave 2: secondary  (weight 0.5)
  vec2 d2 = vec2(-0.5, 0.86);
  float p2 = dot(d2, uv) * uWaveFreq * 2.3 - t * uWaveSpeed * 1.3;
  float c2 = cos(p2);
  dx += d2.x * c2 * 0.5;
  dz += d2.y * c2 * 0.5;

  // Wave 3: cross wave  (weight 0.25)
  vec2 d3 = vec2(0.3, -0.95);
  float p3 = dot(d3, uv) * uWaveFreq * 4.1 - t * uWaveSpeed * 0.8;
  float c3 = cos(p3);
  dx += d3.x * c3 * 0.25;
  dz += d3.y * c3 * 0.25;

  // Wave 4: fine detail  (weight 0.12)
  vec2 d4 = vec2(-0.7, -0.7);
  float p4 = dot(d4, uv) * uWaveFreq * 7.0 + t * uWaveSpeed * 1.1;
  float c4 = cos(p4);
  dx += d4.x * c4 * 0.12;
  dz += d4.y * c4 * 0.12;

  // Wave 5: choppy detail  (weight 0.06)
  vec2 d5 = vec2(0.95, -0.3);
  float p5 = dot(d5, uv) * uWaveFreq * 11.0 - t * uWaveSpeed * 1.5;
  float c5 = cos(p5);
  dx += d5.x * c5 * 0.06;
  dz += d5.y * c5 * 0.06;

  dx *= strength;
  dz *= strength;

  return normalize(vec3(-dx, 1.0, -dz));
}

// Pick the best 2D projection for the current sphere normal
vec2 getWaveUV(vec3 worldPos, vec3 sphereN) {
  vec3 a = abs(sphereN);
  if (a.x > a.y && a.x > a.z) return worldPos.yz;
  if (a.y > a.z) return worldPos.xz;
  return worldPos.xy;
}

// ---- Sky color for reflections ----
vec3 getSkyColor(vec3 e) {
  e.y = max(e.y, 0.0);
  return vec3(
    pow(1.0 - e.y, 2.0),
    1.0 - e.y,
    0.6 + (1.0 - e.y) * 0.4
  );
}

// Reconstruct linear depth from logarithmic depth buffer
float linearizeLogDepth(float d) {
  if (d >= 1.0) return uCameraFar;
  float logFarP1 = log2(uCameraFar + 1.0);
  return pow(2.0, d * logFarP1) - 1.0;
}

void main() {
  vec3 sphereN = normalize(vSphereNormal);
  vec3 viewDir = normalize(cameraPosition - vWorldPos);

  // ---- Compute wave normal (with distance LOD) ----
  float distToCam = length(cameraPosition - vWorldPos);
  float waveLOD = 1.0 - smoothstep(500.0, 2000.0, distToCam);

  vec3 N = sphereN;

  if (waveLOD > 0.01) {
    // Build local tangent frame
    vec3 refV = abs(sphereN.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 T = normalize(cross(sphereN, refV));
    vec3 B = cross(sphereN, T);

    // Get wave UV and compute analytical normal in tangent space
    vec2 uv = getWaveUV(vWorldPos, sphereN);
    vec3 wN = waveNormal(uv, uTime);

    // Transform from tangent space to world space
    vec3 worldWaveN = normalize(T * wN.x + sphereN * wN.y + B * wN.z);
    N = normalize(mix(sphereN, worldWaveN, waveLOD));
  }

  // ---- Read scene depth (terrain) ----
  float rawDepth = texture2D(tDepth, vScreenUV).r;
  float terrainLinearDepth = linearizeLogDepth(rawDepth);

  float oceanViewDepth = vOceanViewDepth;

  vec3 rayDir = normalize(vWorldPos - cameraPosition);
  float cosAngle = dot(rayDir, vCamForward);
  float terrainRayDist = terrainLinearDepth / abs(cosAngle);
  float oceanRayDist = oceanViewDepth / abs(cosAngle);

  float waterDepth = max(terrainRayDist - oceanRayDist, 0.0);

  bool terrainInFront = rawDepth < 1.0 && terrainRayDist < oceanRayDist - 0.1;
  if (terrainInFront) discard;

  float depthFactor = clamp(waterDepth / uMaxDepthFade, 0.0, 1.0);

  // ---- Absorption (Beer's Law) ----
  vec3 absorption = exp(-uAbsorption * waterDepth);

  // ---- Water base color ----
  vec3 waterColor = mix(uShallowColor, uDeepColor, depthFactor);
  waterColor *= absorption;

  // ---- Subsurface scattering ----
  float sss = pow(max(dot(viewDir, -uSunDir), 0.0), 4.0) * 0.4;
  vec3 subsurface = uScatterColor * sss * (1.0 - depthFactor * 0.5);

  // ---- Fresnel (Schlick) ----
  float NdotV = max(dot(N, viewDir), 0.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);
  fresnel = clamp(fresnel, 0.0, 1.0);

  // ---- Diffuse lighting (wrap) ----
  float NdotL = max(dot(N, uSunDir), 0.0);
  float diffuse = pow(NdotL * 0.4 + 0.6, 0.8);

  // ---- Sky reflection ----
  vec3 reflectDir = reflect(-viewDir, N);
  vec3 skyReflection = getSkyColor(reflectDir);

  // ---- Refracted color (water body) ----
  vec3 refracted = waterColor * diffuse + subsurface;

  // ---- Combine via Fresnel ----
  vec3 color = mix(refracted, skyReflection, fresnel * 0.7);

  // ---- Specular (sun highlight) ----
  vec3 halfVec = normalize(viewDir + uSunDir);
  float NdotH = max(dot(N, halfVec), 0.0);
  float specNorm = (128.0 + 8.0) / (PI * 8.0);
  float specular = pow(NdotH, 128.0) * specNorm * uSunIntensity * 0.25;
  color += vec3(1.0, 0.95, 0.8) * specular;

  // Tone-map
  color = 1.0 - exp(-color);

  gl_FragColor = vec4(color, 1.0);

  // Write logarithmic depth (must match terrain's MeshPhongMaterial log depth)
  // Formula: gl_FragDepth = log2(clipW + 1) / log2(far + 1)
  // = vLogZ / log2(far + 1)  = vLogZ * (2.0 / log2(far + 1)) * 0.5
  gl_FragDepth = vLogZ * (2.0 / log2(uCameraFar + 1.0)) * 0.5;
}
