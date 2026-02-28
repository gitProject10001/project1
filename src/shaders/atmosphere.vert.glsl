varying vec3 vWorldPos;
varying vec3 vWorldDir;
varying vec2 vUv;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vWorldDir = wp.xyz - cameraPosition;
  vec4 clipPos = projectionMatrix * viewMatrix * wp;
  gl_Position = clipPos;

  // Screen-space UV for sampling the depth texture
  vUv = clipPos.xy / clipPos.w * 0.5 + 0.5;
}
