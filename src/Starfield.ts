import * as THREE from 'three';
import vertexShader from './shaders/stars.vert.glsl';
import fragmentShader from './shaders/stars.frag.glsl';

export class Starfield {
  readonly mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime: { value: 0.0 },
        uStarBrightness: { value: 1.5 },
        uNebulaBrightness: { value: 0.6 },
        uTwinkleSpeed: { value: 1.0 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
    });

    // Large box that always surrounds the camera
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000; // render first, behind everything
  }

  updateTime(t: number): void {
    this.material.uniforms.uTime.value = t;
  }

  /** Keep the skybox centred on the camera */
  update(camera: THREE.Camera): void {
    this.mesh.position.copy(camera.getWorldPosition(new THREE.Vector3()));
  }

  setUniform(name: string, value: number): void {
    if (this.material.uniforms[name] !== undefined) {
      this.material.uniforms[name].value = value;
    }
  }
}
