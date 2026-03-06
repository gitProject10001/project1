varying vec3 vDirection;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vDirection = normalize(worldPos.xyz - cameraPosition);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w; // push to far plane
}
