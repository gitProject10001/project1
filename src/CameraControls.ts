import * as THREE from 'three';

// ---------------------------------------------------------------------------
// 6DOF Spaceship Camera Controller
// ---------------------------------------------------------------------------

/**
 * Six Degrees of Freedom flight camera.
 * - Mouse controls pitch (Y) and yaw (X)
 * - WASD for translational thrust (forward/back/strafe)
 * - Q/E for roll
 * - Shift for boost
 * - Space/Ctrl for vertical thrust (local up/down)
 *
 * Physics: acceleration-based with drag for smooth space-flight feel.
 */

export interface FlightConfig {
  /** Linear thrust (units/s^2) */
  thrust: number;
  /** Boost multiplier */
  boostMultiplier: number;
  /** Linear drag coefficient (0–1) */
  linearDrag: number;
  /** Pitch/yaw sensitivity (rad/pixel) */
  mouseSensitivity: number;
  /** Roll speed (rad/s) */
  rollSpeed: number;
  /** Maximum speed cap */
  maxSpeed: number;
}

const DEFAULT_CONFIG: FlightConfig = {
  thrust: 200,
  boostMultiplier: 5,
  linearDrag: 0.98,
  mouseSensitivity: 0.002,
  rollSpeed: 1.5,
  maxSpeed: 2000,
};

export class CameraControls {
  camera: THREE.PerspectiveCamera;
  config: FlightConfig;

  /** Current velocity in world space */
  velocity = new THREE.Vector3();

  /** Accumulated mouse delta (consumed each frame) */
  private mouseDX = 0;
  private mouseDY = 0;

  /** Key state */
  private keys = new Map<string, boolean>();

  /** Pointer lock state */
  private _locked = false;

  private domElement: HTMLElement;

  // Reusable quaternion temporaries
  private _qPitch = new THREE.Quaternion();
  private _qYaw = new THREE.Quaternion();
  private _qRoll = new THREE.Quaternion();

  constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement, config?: Partial<FlightConfig>) {
    this.camera = camera;
    this.domElement = domElement;
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.initListeners();
  }

  // -----------------------------------------------------------------------
  // Input listeners
  // -----------------------------------------------------------------------

  private initListeners(): void {
    // Pointer lock
    this.domElement.addEventListener('click', () => {
      if (!this._locked) {
        this.domElement.requestPointerLock();
      }
    });

    document.addEventListener('pointerlockchange', () => {
      this._locked = document.pointerLockElement === this.domElement;
    });

    // Mouse
    document.addEventListener('mousemove', (e) => {
      if (!this._locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });

    // Keyboard
    document.addEventListener('keydown', (e) => {
      this.keys.set(e.code, true);
    });
    document.addEventListener('keyup', (e) => {
      this.keys.set(e.code, false);
    });
  }

  private key(code: string): boolean {
    return this.keys.get(code) === true;
  }

  // -----------------------------------------------------------------------
  // Update (call once per frame)
  // -----------------------------------------------------------------------

  get speed(): number {
    return this.velocity.length();
  }

  get locked(): boolean {
    return this._locked;
  }

  update(dt: number): void {
    const cam = this.camera;
    const cfg = this.config;

    // --- Rotation ---

    // Pitch & Yaw from mouse
    const pitchAngle = -this.mouseDY * cfg.mouseSensitivity;
    const yawAngle = -this.mouseDX * cfg.mouseSensitivity;
    this.mouseDX = 0;
    this.mouseDY = 0;

    // Roll from Q/E
    let rollAngle = 0;
    if (this.key('KeyQ')) rollAngle += cfg.rollSpeed * dt;
    if (this.key('KeyE')) rollAngle -= cfg.rollSpeed * dt;

    // Apply rotations in local space
    // Order: yaw, pitch, roll — applied incrementally
    this._qYaw.setFromAxisAngle(cam.up.clone().applyQuaternion(cam.quaternion.clone().invert()).set(0, 1, 0), yawAngle);
    this._qPitch.setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitchAngle);
    this._qRoll.setFromAxisAngle(new THREE.Vector3(0, 0, -1), rollAngle);

    // Combine: apply pitch and roll in local, yaw in local
    const localRot = new THREE.Quaternion()
      .multiply(this._qYaw)
      .multiply(this._qPitch)
      .multiply(this._qRoll);

    cam.quaternion.multiply(localRot);
    cam.quaternion.normalize();

    // --- Translation ---
    const boost = this.key('ShiftLeft') || this.key('ShiftRight') ? cfg.boostMultiplier : 1;
    const accel = cfg.thrust * boost;

    // Build local-space thrust vector
    const thrustDir = new THREE.Vector3();
    if (this.key('KeyW')) thrustDir.z -= 1;
    if (this.key('KeyS')) thrustDir.z += 1;
    if (this.key('KeyA')) thrustDir.x -= 1;
    if (this.key('KeyD')) thrustDir.x += 1;
    if (this.key('Space')) thrustDir.y += 1;
    if (this.key('ControlLeft') || this.key('ControlRight')) thrustDir.y -= 1;

    if (thrustDir.lengthSq() > 0) {
      thrustDir.normalize();
      // Transform thrust from local to world space
      thrustDir.applyQuaternion(cam.quaternion);
      this.velocity.addScaledVector(thrustDir, accel * dt);
    }

    // Drag
    this.velocity.multiplyScalar(cfg.linearDrag);

    // Speed cap
    const spd = this.velocity.length();
    if (spd > cfg.maxSpeed) {
      this.velocity.multiplyScalar(cfg.maxSpeed / spd);
    }

    // Integrate position
    cam.position.addScaledVector(this.velocity, dt);
  }

  dispose(): void {
    // Listeners would need to be removed properly in production
  }
}
