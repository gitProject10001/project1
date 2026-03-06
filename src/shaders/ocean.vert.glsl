uniform float uTime;
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

// ---- Wave functions (must match fragment shader) ----

float waveHash(vec2 p) {
  float h = dot(p, vec2(127.1, 311.7));
  return fract(sin(h) * 43758.5453123);
}

float waveNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return -1.0 + 2.0 * mix(
    mix(waveHash(i + vec2(0.0, 0.0)), waveHash(i + vec2(1.0, 0.0)), u.x),
    mix(waveHash(i + vec2(0.0, 1.0)), waveHash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

mat2 octave_m = mat2(1.6, 1.2, -1.2, 1.6);

float seaOctave(vec2 uv, float choppy) {
  uv += waveNoise(uv);
  vec2 wv = 1.0 - abs(sin(uv));
  vec2 swv = abs(cos(uv));
  wv = mix(wv, swv, wv);
  return pow(1.0 - pow(wv.x * wv.y, 0.65), choppy);
}

// Vertex displacement uses LOWER frequency (fewer octaves, scaled down freq)
// so the mesh can actually resolve the waves. High-freq detail is fragment-only.
float waveHeightVertex(vec2 uv) {
  float SEA_TIME = uTime * uWaveSpeed;
  // Use 1/4 the fragment frequency — big swells only
  float freq = uWaveFreq * 0.25;
  float amp = uWaveHeight;
  float choppy = min(uWaveChoppy, 2.0); // less choppy for vertex (smoother large swells)
  uv *= 0.75;

  float h = 0.0;
  // Only 2 octaves for vertex — large swells
  for (int i = 0; i < 2; i++) {
    float d = seaOctave((uv + SEA_TIME) * freq, choppy);
    d += seaOctave((uv - SEA_TIME) * freq, choppy);
    h += (d - 1.0) * amp;
    uv *= octave_m;
    freq *= 1.9;
    amp *= 0.22;
    choppy = mix(choppy, 1.0, 0.2);
  }
  return h;
}

// Triplanar wave sampling — avoids pole singularity
float waveHeightTriplanar(vec3 worldPos, vec3 sphereN) {
  vec3 blend = abs(sphereN);
  blend = pow(blend, vec3(4.0));
  blend /= (blend.x + blend.y + blend.z);

  float h = 0.0;
  if (blend.x > 0.01) h += waveHeightVertex(worldPos.yz) * blend.x;
  if (blend.y > 0.01) h += waveHeightVertex(worldPos.xz) * blend.y;
  if (blend.z > 0.01) h += waveHeightVertex(worldPos.xy) * blend.z;
  return h;
}

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 sphereNormal = normalize(wp.xyz);
  vSphereNormal = sphereNormal;

  // Compute wave displacement using triplanar projection
  float h = waveHeightTriplanar(wp.xyz, sphereNormal);

  // Displace along sphere normal
  wp.xyz += sphereNormal * h;

  vWorldPos = wp.xyz;
  vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);

  vec4 clipPos = projectionMatrix * viewMatrix * wp;
  gl_Position = clipPos;

  // Pass view-space depth and camera forward to fragment shader
  vOceanViewDepth = clipPos.w;
  vCamForward = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);

  // Screen UV for depth texture sampling
  vScreenUV = clipPos.xy / clipPos.w * 0.5 + 0.5;

  // Write logarithmic depth (must match terrain's MeshPhongMaterial log depth)
  vLogZ = log2(max(1e-6, gl_Position.w + 1.0));
}
