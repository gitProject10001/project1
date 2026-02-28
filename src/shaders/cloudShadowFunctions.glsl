float csHash3(vec3 p) {
  p = fract(p * vec3(443.8975, 397.2973, 491.1871));
  p += dot(p, p.yxz + 19.19);
  return fract((p.x + p.y) * p.z);
}
float csValueNoise3D(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(mix(csHash3(i+vec3(0,0,0)), csHash3(i+vec3(1,0,0)), u.x),
                 mix(csHash3(i+vec3(0,1,0)), csHash3(i+vec3(1,1,0)), u.x), u.y),
             mix(mix(csHash3(i+vec3(0,0,1)), csHash3(i+vec3(1,0,1)), u.x),
                 mix(csHash3(i+vec3(0,1,1)), csHash3(i+vec3(1,1,1)), u.x), u.y), u.z);
}
float csFBM3(vec3 p) {
  float v = 0.0, a = 0.5, f = 1.0, t = 0.0;
  for (int i = 0; i < 3; i++) { v += a * csValueNoise3D(p * f); t += a; a *= 0.5; f *= 2.3; }
  return v / t;
}
vec2 csRaySphere(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float d = b * b - c;
  if (d < 0.0) return vec2(1e20, -1e20);
  float s = sqrt(d);
  return vec2(-b - s, -b + s);
}
// Cloud type height profile (must match main shader)
float csHeightProfile(float h) {
  float bottomFade = smoothstep(0.0, 0.08, h) * smoothstep(0.08, 0.18, h * 1.5 + 0.1);
  float stratus = bottomFade * smoothstep(0.0, 0.12, h) * smoothstep(0.5, 0.25, h);
  float cumulusCore = exp(-pow((h - 0.35) / 0.22, 2.0));
  float cumulus = bottomFade * cumulusCore * smoothstep(1.0, 0.75, h);
  float cbColumn = bottomFade * smoothstep(0.0, 0.1, h);
  float cbAnvil = smoothstep(0.7, 0.85, h) * 0.6;
  float cbTopFade = smoothstep(1.0, 0.88, h);
  float cumulonimbus = (cbColumn + cbAnvil) * cbTopFade;
  float ct = uCloudType;
  if (ct <= 1.0) return mix(stratus, cumulus, ct);
  return mix(cumulus, cumulonimbus, ct - 1.0);
}
// Procedural tornado position (must match main shader)
vec3 csTornadoPos(float seed) {
  float t = uCloudTime * 0.02 + seed * 100.0;
  float theta = csValueNoise3D(vec3(t * 0.3, seed, 0.0)) * 3.14159265 * 2.0;
  float phi = csValueNoise3D(vec3(0.0, t * 0.25, seed)) * 3.14159265 * 0.4 + 3.14159265 * 0.3;
  float r = (uCloudInnerRadius + uCloudOuterRadius) * 0.5;
  return vec3(r * sin(phi) * cos(theta), r * cos(phi), r * sin(phi) * sin(theta));
}
// Simplified shadow density: wind-only advection, 3-octave FBM, no curl noise
float csSampleDensity(vec3 pos) {
  float r = length(pos);
  float hf = clamp((r - uCloudInnerRadius) / (uCloudOuterRadius - uCloudInnerRadius), 0.0, 1.0);
  float hg = csHeightProfile(hf);
  if (hg < 0.001) return 0.0;

  // Simple wind advection only (no curl noise for shadow perf)
  float t = uCloudTime * uCloudSpeed;
  vec3 np = pos * 0.008 + vec3(uCloudWindX, 0.0, uCloudWindZ) * t * 0.008;

  // Single cheap warp
  float warpVal = csValueNoise3D(np * 0.4 + vec3(t * 0.025));
  np += vec3(warpVal - 0.5) * uCloudWeatherScale * 2.0;

  float sh = csFBM3(np);
  float dn = smoothstep(1.0 - uCloudCoverage, 1.0, sh);

  // Tornado density boost
  if (uCloudTornadoActive >= 1.0) {
    vec3 tp1 = (length(uCloudTornadoPos1) > 0.1) ? uCloudTornadoPos1 : csTornadoPos(1.0);
    float d1 = length(pos - tp1);
    float fw = 6.0 + hf * 20.0;
    dn += exp(-d1 * d1 / (fw * fw)) * uCloudTornadoStrength * 0.5;
  }
  if (uCloudTornadoActive >= 2.0) {
    vec3 tp2 = (length(uCloudTornadoPos2) > 0.1) ? uCloudTornadoPos2 : csTornadoPos(2.0);
    float d2 = length(pos - tp2);
    float fw = 6.0 + hf * 20.0;
    dn += exp(-d2 * d2 / (fw * fw)) * uCloudTornadoStrength * 0.5;
  }

  return max(dn * hg * uCloudDensityMult, 0.0);
}
float cloudShadow(vec3 worldPos) {
  vec2 ti = csRaySphere(worldPos, uCloudSunDir, uCloudInnerRadius);
  vec2 to = csRaySphere(worldPos, uCloudSunDir, uCloudOuterRadius);
  float tS = max(ti.y, 0.0), tE = to.y;
  if (tS >= tE || tE < 0.0) return 1.0;
  float ss = (tE - tS) / 6.0, tau = 0.0;
  for (int i = 0; i < 6; i++) {
    float t = tS + (float(i) + 0.5) * ss;
    tau += csSampleDensity(worldPos + uCloudSunDir * t) * ss;
  }
  return exp(-tau * 1.5);
}
