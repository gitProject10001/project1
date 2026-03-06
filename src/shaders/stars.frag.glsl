// Procedural starfield with nebula - viewed from space
// Inspired by Star Nest (Pablo Roman Andrioli, MIT)

uniform float uTime;
uniform float uStarBrightness;
uniform float uNebulaBrightness;
uniform float uTwinkleSpeed;

varying vec3 vDirection;

// ---- Hashing ----

float hash21(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}

float hash31(vec3 p) {
  p = fract(p * vec3(443.897, 441.423, 437.195));
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}

vec3 hash33(vec3 p) {
  p = fract(p * vec3(443.897, 441.423, 437.195));
  p += dot(p, p.yzx + 19.19);
  return fract(vec3(p.x * p.z, p.y * p.x, p.z * p.y));
}

// ---- Star colour from temperature (approximate blackbody) ----

vec3 starColor(float temp) {
  // temp: 0 = cool red/orange, 1 = white, >1 = blue-white
  vec3 cool  = vec3(1.0, 0.6, 0.3);   // K/M star
  vec3 mid   = vec3(1.0, 0.95, 0.9);  // G star (sun-like)
  vec3 hot   = vec3(0.7, 0.8, 1.0);   // O/B star
  if (temp < 0.5) return mix(cool, mid, temp * 2.0);
  return mix(mid, hot, (temp - 0.5) * 2.0);
}

// ---- Single star layer ----
// Projects direction onto cube faces, tiles each face into cells,
// places one star per cell with random offset, brightness, and colour.

vec3 starLayer(vec3 dir, float scale, float brightnessBase) {
  // Determine dominant axis for cube-map style tiling
  vec3 ad = abs(dir);
  vec2 uv;
  float faceId;

  if (ad.x >= ad.y && ad.x >= ad.z) {
    uv = dir.yz / dir.x;
    faceId = dir.x > 0.0 ? 0.0 : 1.0;
  } else if (ad.y >= ad.x && ad.y >= ad.z) {
    uv = dir.xz / dir.y;
    faceId = dir.y > 0.0 ? 2.0 : 3.0;
  } else {
    uv = dir.xy / dir.z;
    faceId = dir.z > 0.0 ? 4.0 : 5.0;
  }

  uv *= scale;
  vec2 cell = floor(uv);
  vec2 local = fract(uv) - 0.5;

  vec3 col = vec3(0.0);

  // Check neighboring cells to avoid edge clipping
  for (int dx = -1; dx <= 1; dx++) {
    for (int dy = -1; dy <= 1; dy++) {
      vec2 neighbor = cell + vec2(float(dx), float(dy));
      vec3 seed = vec3(neighbor + faceId * 100.0, faceId);

      float rBright = hash31(seed + 0.1);
      // Steep power-law: very few bright stars
      float brightness = pow(rBright, 12.0) * brightnessBase;
      if (brightness < 0.0005) continue;

      // Star position within cell
      vec2 offset = hash33(seed).xy - 0.5;
      vec2 delta = local - vec2(float(dx), float(dy)) - offset;
      float dist = length(delta);

      // Tiny pinpoint stars; only brightest get slightly larger
      float starSize = mix(0.0015, 0.006, pow(rBright, 5.0));
      float star = smoothstep(starSize, 0.0, dist);

      // Very subtle glow only on bright stars
      float glow = exp(-dist * dist / (starSize * 4.0)) * brightness * 0.15;

      // Twinkle
      float twinkle = sin(uTime * uTwinkleSpeed * (0.5 + rBright * 2.0)
                         + hash21(neighbor) * 6.283);
      twinkle = 0.8 + 0.2 * twinkle;

      // Colour temperature
      float temp = hash31(seed + 7.77);
      vec3 sCol = starColor(temp);

      col += sCol * (star * brightness + glow) * twinkle;
    }
  }

  return col;
}

// ---- Nebula / dust (simplified volumetric) ----

float nebulaNoise(vec3 p) {
  // Simple 3D value noise via lattice hashing
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f); // smoothstep

  float n000 = hash31(i);
  float n100 = hash31(i + vec3(1, 0, 0));
  float n010 = hash31(i + vec3(0, 1, 0));
  float n110 = hash31(i + vec3(1, 1, 0));
  float n001 = hash31(i + vec3(0, 0, 1));
  float n101 = hash31(i + vec3(1, 0, 1));
  float n011 = hash31(i + vec3(0, 1, 1));
  float n111 = hash31(i + vec3(1, 1, 1));

  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}

float nebulaFBM(vec3 p) {
  float v = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  for (int i = 0; i < 5; i++) {
    v += amp * nebulaNoise(p * freq);
    freq *= 2.2;
    amp *= 0.5;
  }
  return v;
}

vec3 nebulaColor(vec3 dir) {
  // Milky-way band along a tilted plane
  vec3 bandDir = normalize(vec3(0.3, 1.0, 0.2));
  float band = 1.0 - abs(dot(dir, bandDir));
  band = pow(band, 5.0);

  vec3 p = dir * 3.0 + vec3(0.0, 0.0, uTime * 0.002);
  float n = nebulaFBM(p);
  float n2 = nebulaFBM(p * 2.0 + 5.0);

  // Colour regions
  vec3 c1 = vec3(0.15, 0.05, 0.25); // purple
  vec3 c2 = vec3(0.05, 0.1, 0.3);   // deep blue
  vec3 c3 = vec3(0.2, 0.08, 0.05);  // warm dust

  vec3 col = mix(c1, c2, n);
  col = mix(col, c3, n2 * 0.5);

  // Enhance along milky-way band
  col *= (0.15 + band * 0.85);

  // Dense cloud patches
  float density = smoothstep(0.35, 0.65, n * band);
  col += vec3(0.05, 0.04, 0.08) * density;

  return col * uNebulaBrightness;
}

// ---- Volumetric star-nest style deep-field ----

vec3 deepField(vec3 dir) {
  float s = 0.1, fade = 1.0;
  vec3 v = vec3(0.0);
  vec3 from = vec3(0.5, 0.5, 0.0) + vec3(0.0, 0.0, uTime * 0.003);

  for (int r = 0; r < 12; r++) {
    vec3 p = from + s * dir * 0.5;
    p = abs(vec3(0.85) - mod(p, vec3(1.7)));

    float pa = 0.0, a = 0.0;
    for (int i = 0; i < 12; i++) {
      p = abs(p) / dot(p, p) - 0.53;
      a += abs(length(p) - pa);
      pa = length(p);
    }

    float dm = max(0.0, 0.3 - a * a * 0.001);
    a *= a * a;
    if (r > 4) fade *= 1.0 - dm;
    v += fade;
    v += vec3(s, s * s, s * s * s * s) * a * 0.0008 * fade;
    fade *= 0.73;
    s += 0.1;
  }

  return mix(vec3(length(v)), v, 0.85) * 0.006;
}

// ---- Main ----

void main() {
  vec3 dir = normalize(vDirection);

  // Multi-scale star layers (fine + coarse)
  vec3 stars = vec3(0.0);
  stars += starLayer(dir, 120.0, 0.6);  // faint dense background stars
  stars += starLayer(dir, 50.0, 1.0);   // medium stars
  stars += starLayer(dir, 20.0, 2.5);   // bright sparse stars
  stars *= uStarBrightness;

  // Nebula background (subtle)
  vec3 nebula = nebulaColor(dir) * 0.4;

  // Deep-field volumetric structure (very subtle)
  vec3 deep = deepField(dir) * uNebulaBrightness * 0.25;

  // Composite
  vec3 col = stars + nebula + deep;

  // Slight ambient so space isn't pure black
  col += vec3(0.001, 0.001, 0.003);

  gl_FragColor = vec4(col, 1.0);
}
