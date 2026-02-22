import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Spaceship — player-controlled vessel with inertia-based physics
// ---------------------------------------------------------------------------

export interface ShipConfig {
  /** Forward thrust acceleration (units/s²) */
  thrust: number;
  /** Boost multiplier (Space key while thrusting) */
  boostMultiplier: number;
  /** Linear drag per frame (0–1, closer to 1 = less drag) */
  linearDrag: number;
  /** Pitch speed (rad/s) */
  pitchSpeed: number;
  /** Yaw speed (rad/s) */
  yawSpeed: number;
  /** Roll speed (rad/s) */
  rollSpeed: number;
  /** Maximum velocity cap (units/s) */
  maxSpeed: number;
  /** Brake drag per frame (0–1, lower = stronger braking) */
  brakeForce: number;
  /** Gravitational parameter GM (set 0 to disable gravity) */
  gravityGM: number;
}

// Reusable axis vectors (never mutated by setFromAxisAngle)
const _axisX = new THREE.Vector3(1, 0, 0);
const _axisY = new THREE.Vector3(0, 1, 0);
const _axisZ = new THREE.Vector3(0, 0, 1);

// ---------------------------------------------------------------------------
// Re-entry flame shader
// ---------------------------------------------------------------------------

const REENTRY_VERTEX = /* glsl */ `
varying vec3 vWorldNormal;
varying vec2 vUv;

void main() {
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const REENTRY_FRAGMENT = /* glsl */ `
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
`;

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export class Spaceship extends THREE.Group {
  config: ShipConfig;

  /** Current velocity in world space */
  velocity = new THREE.Vector3();

  private engineGlow: THREE.Mesh;
  private reentryShield: THREE.Mesh;
  private reentryMat: THREE.ShaderMaterial;

  // Reusable quaternion temps
  private _qPitch = new THREE.Quaternion();
  private _qYaw = new THREE.Quaternion();
  private _qRoll = new THREE.Quaternion();
  private _localRot = new THREE.Quaternion();
  private _forward = new THREE.Vector3();
  private _gravDir = new THREE.Vector3();

  constructor(config?: Partial<ShipConfig>) {
    super();
    this.config = {
      thrust: 200,
      boostMultiplier: 5,
      linearDrag: 0.98,
      pitchSpeed: 1.5,
      yawSpeed: 1.5,
      rollSpeed: 1.5,
      maxSpeed: 2000,
      brakeForce: 0.92,
      gravityGM: 50_000_000,
      ...config,
    };

    this.engineGlow = this.buildMesh();

    // Re-entry flame shield (sphere around ship)
    this.reentryMat = new THREE.ShaderMaterial({
      vertexShader: REENTRY_VERTEX,
      fragmentShader: REENTRY_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uIntensity:   { value: 0.0 },
        uTime:        { value: 0.0 },
        uVelocityDir: { value: new THREE.Vector3(0, 0, -1) },
      },
    });
    this.reentryShield = new THREE.Mesh(
      new THREE.SphereGeometry(5, 24, 24),
      this.reentryMat,
    );
    this.reentryShield.visible = false;
    this.add(this.reentryShield);
  }

  private buildMesh(): THREE.Mesh {
    // Fuselage — cone pointing forward (-Z in local space)
    const body = new THREE.Mesh(
      new THREE.ConeGeometry(1.5, 6, 8),
      new THREE.MeshStandardMaterial({ color: 0x88aacc, metalness: 0.7, roughness: 0.3 }),
    );
    body.rotation.x = Math.PI / 2;
    this.add(body);

    // Delta wings
    const wings = new THREE.Mesh(
      new THREE.BoxGeometry(6, 0.15, 2.5),
      new THREE.MeshStandardMaterial({ color: 0x667799, metalness: 0.6, roughness: 0.4 }),
    );
    wings.position.set(0, 0, 1);
    this.add(wings);

    // Engine glow (unlit — always visible)
    const engine = new THREE.Mesh(
      new THREE.SphereGeometry(0.7, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0x2244aa }),
    );
    engine.position.set(0, 0, 3);
    this.add(engine);

    return engine;
  }

  get speed(): number {
    return this.velocity.length();
  }

  // -----------------------------------------------------------------------
  // Re-entry flame control (called from main.ts each frame)
  // -----------------------------------------------------------------------

  setReentryIntensity(intensity: number, time: number, velocityDir: THREE.Vector3): void {
    if (intensity < 0.001) {
      this.reentryShield.visible = false;
      return;
    }
    this.reentryShield.visible = true;
    const u = this.reentryMat.uniforms;
    u['uIntensity'].value = intensity;
    u['uTime'].value = time;
    u['uVelocityDir'].value.copy(velocityDir);
  }

  // -----------------------------------------------------------------------
  // Physics update (call once per frame)
  // -----------------------------------------------------------------------

  update(dt: number, keys: Map<string, boolean>): void {
    const cfg = this.config;
    const k = (code: string) => keys.get(code) === true;

    // --- Rotation (W/S pitch, A/D yaw, Q/E roll) ---
    let pitch = 0, yaw = 0, roll = 0;

    if (k('KeyW')) pitch += cfg.pitchSpeed * dt;  // nose up
    if (k('KeyS')) pitch -= cfg.pitchSpeed * dt;  // nose down
    if (k('KeyA')) yaw   += cfg.yawSpeed * dt;    // nose left
    if (k('KeyD')) yaw   -= cfg.yawSpeed * dt;    // nose right
    if (k('KeyQ')) roll  += cfg.rollSpeed * dt;   // roll left
    if (k('KeyE')) roll  -= cfg.rollSpeed * dt;   // roll right

    this._qPitch.setFromAxisAngle(_axisX, pitch);
    this._qYaw.setFromAxisAngle(_axisY, yaw);
    this._qRoll.setFromAxisAngle(_axisZ, roll);

    this._localRot.identity()
      .multiply(this._qYaw)
      .multiply(this._qPitch)
      .multiply(this._qRoll);

    this.quaternion.multiply(this._localRot);
    this.quaternion.normalize();

    // --- Translation ---
    const isThrusting = k('ShiftLeft') || k('ShiftRight');
    const boost = k('Space') ? cfg.boostMultiplier : 1;

    if (isThrusting) {
      this._forward.set(0, 0, -1).applyQuaternion(this.quaternion);
      this.velocity.addScaledVector(this._forward, cfg.thrust * boost * dt);
    }

    // Gravity (Newton: a = GM / r², toward planet center at origin)
    if (cfg.gravityGM > 0) {
      const r = this.position.length();
      if (r > 1) {
        const gravAccel = cfg.gravityGM / (r * r);
        this._gravDir.copy(this.position).negate().divideScalar(r); // unit vector toward origin
        this.velocity.addScaledVector(this._gravDir, gravAccel * dt);
      }
    }

    // Brake / reverse
    if (k('ControlLeft') || k('ControlRight')) {
      this.velocity.multiplyScalar(cfg.brakeForce);
    }

    // Drag
    this.velocity.multiplyScalar(cfg.linearDrag);

    // Speed cap
    const spd = this.velocity.length();
    if (spd > cfg.maxSpeed) {
      this.velocity.multiplyScalar(cfg.maxSpeed / spd);
    }

    // Integrate position
    this.position.addScaledVector(this.velocity, dt);

    // Visual feedback: engine glow
    const mat = this.engineGlow.material as THREE.MeshBasicMaterial;
    mat.color.setHex(isThrusting ? (boost > 1 ? 0xaaeeff : 0x88ccff) : 0x2244aa);
  }
}
