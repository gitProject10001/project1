varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vScreenUV;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);

  vec4 clipPos = projectionMatrix * viewMatrix * wp;
  gl_Position = clipPos;

  // Screen UV for depth texture sampling
  vScreenUV = clipPos.xy / clipPos.w * 0.5 + 0.5;
}
