uniform float uIntensity;
uniform float uTime;
uniform vec3  uVelocityDir;

varying vec3 vWorldNormal;
varying vec2 vUv;

float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float noise2d(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm2(vec2 p) {
  float f  = 0.5000 * noise2d(p); p *= 2.01;
         f += 0.2500 * noise2d(p); p *= 2.02;
         f += 0.1250 * noise2d(p); p *= 2.03;
         f += 0.0625 * noise2d(p);
  return f / 0.9375;
}

void main() {
  // How much this surface faces into the velocity (heat-shield side)
  float facing = dot(vWorldNormal, -uVelocityDir);
  float flameMask = smoothstep(-0.1, 0.7, facing);

  // Animated fire noise
  vec2 nc = vUv * 5.0 + vec2(0.0, -uTime * 4.0);
  float fire = fbm2(nc);
  float flicker = 0.8 + 0.2 * sin(uTime * 15.0 + vUv.x * 10.0);

  // Color gradient: white-hot core → orange → red edges
  float t = flameMask * fire;
  vec3 color = mix(vec3(0.8, 0.15, 0.0), vec3(1.0, 0.5, 0.1), smoothstep(0.0, 0.5, t));
  color = mix(color, vec3(1.0, 0.95, 0.8), smoothstep(0.5, 1.0, t));

  float alpha = flameMask * uIntensity * fire * flicker;
  if (alpha < 0.01) discard;

  gl_FragColor = vec4(color * (1.0 + alpha), clamp(alpha, 0.0, 1.0));
}
