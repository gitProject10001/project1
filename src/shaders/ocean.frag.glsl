uniform vec3  uSunDir;
uniform float uSunIntensity;
uniform float uPlanetRadius;
uniform float uOceanRadius;

// Depth buffer
uniform sampler2D tDepth;
uniform float uCameraNear;
uniform float uCameraFar;

// Ocean optical properties
uniform vec3  uAbsorption;      // Absorption coefficients per channel (higher = more absorbed)
uniform vec3  uScatterColor;    // Subsurface scatter tint
uniform float uMaxDepthFade;    // Max depth for absorption calculation
uniform vec3  uShallowColor;    // Color at zero depth (shoreline)
uniform vec3  uDeepColor;       // Color at full depth

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vScreenUV;

#define PI 3.14159265359

// Reconstruct linear depth from logarithmic depth buffer (matches Atmosphere)
float linearizeLogDepth(float d) {
  if (d >= 1.0) return uCameraFar;
  float logFarP1 = log2(uCameraFar + 1.0);
  return pow(2.0, d * logFarP1) - 1.0;
}

void main() {
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  vec3 normal = normalize(vWorldNormal);

  // ---- Read scene depth (terrain) ----
  float rawDepth = texture2D(tDepth, vScreenUV).r;
  float terrainLinearDepth = linearizeLogDepth(rawDepth);

  // Compute this fragment's view-space depth
  vec4 clipPos = projectionMatrix * viewMatrix * vec4(vWorldPos, 1.0);
  float oceanViewDepth = clipPos.w; // perspective W = view-space Z

  // Water column depth: how deep is the terrain below this ocean surface point
  // Convert both to ray distances for comparison
  vec3 rayDir = normalize(vWorldPos - cameraPosition);
  float cosAngle = dot(rayDir, vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));
  float terrainRayDist = terrainLinearDepth / abs(cosAngle);
  float oceanRayDist = oceanViewDepth / abs(cosAngle);

  // Water depth in world units (how far terrain is below the ocean surface)
  float waterDepth = max(terrainRayDist - oceanRayDist, 0.0);

  // If terrain is in front of water (shouldn't render), discard
  bool terrainInFront = rawDepth < 1.0 && terrainRayDist < oceanRayDist - 0.1;
  if (terrainInFront) discard;

  // Normalise depth for effects (0 = shoreline, 1 = deep)
  float depthFactor = clamp(waterDepth / uMaxDepthFade, 0.0, 1.0);

  // ---- Absorption (Beer's Law) ----
  // Deeper water absorbs more light, especially reds and greens
  vec3 absorption = exp(-uAbsorption * waterDepth);

  // ---- Water color: blend shallow to deep ----
  vec3 waterColor = mix(uShallowColor, uDeepColor, depthFactor);

  // Apply absorption to water color
  waterColor *= absorption;

  // ---- Subsurface scattering approximation ----
  // Light penetrating through the water from the sun side
  float sss = pow(max(dot(viewDir, -uSunDir), 0.0), 4.0) * 0.3;
  vec3 subsurface = uScatterColor * sss * (1.0 - depthFactor * 0.5);

  // ---- Fresnel (Schlick) ----
  float NdotV = max(dot(normal, viewDir), 0.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);

  // ---- Specular (Blinn-Phong sun highlight) ----
  vec3 halfVec = normalize(viewDir + uSunDir);
  float NdotH = max(dot(normal, halfVec), 0.0);
  float specular = pow(NdotH, 256.0) * uSunIntensity * 0.5;

  // ---- Diffuse lighting ----
  float NdotL = max(dot(normal, uSunDir), 0.0);
  float diffuse = NdotL * 0.6 + 0.4; // wrap lighting

  // ---- Soft shoreline edge ----
  // Alpha fades to 0 at the terrain intersection (soft blend)
  float shoreAlpha = smoothstep(0.0, 2.0, waterDepth);

  // ---- Combine ----
  vec3 color = waterColor * diffuse + subsurface;

  // Fresnel drives reflection vs refraction balance
  // At grazing angles, the water is more reflective (brighter)
  color = mix(color, vec3(0.4, 0.6, 0.8) * diffuse, fresnel * 0.5);

  // Add specular highlight
  color += vec3(1.0, 0.95, 0.8) * specular;

  // Tone-map
  color = 1.0 - exp(-color);

  // Alpha: combine optical depth-based opacity with shoreline softness
  float baseAlpha = 1.0 - exp(-depthFactor * 4.0);
  float alpha = mix(0.3, 0.92, baseAlpha) * shoreAlpha;

  gl_FragColor = vec4(color, alpha);
}
