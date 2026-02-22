import * as THREE from 'three';

// ---------------------------------------------------------------------------
// 6DOF Spaceship Camera Controller (Free-fly mode)
// ---------------------------------------------------------------------------

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

export class FreeCameraControls {
  camera: THREE.PerspectiveCamera;
  config: FlightConfig;

  /** Set false to ignore input while another controller is active */
  enabled = true;

  /** Current velocity in world space */
  velocity = new THREE.Vector3();

  private mouseDX = 0;
  private mouseDY = 0;
  private keys = new Map<string, boolean>();
  private _locked = false;
  private domElement: HTMLElement;

  // Reusable quaternion temporaries
  private _qPitch = new THREE.Quaternion();
  private _qYaw = new THREE.Quaternion();
  private _qRoll = new THREE.Quaternion();

  constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement, config?: Partial<FlightConfig>) {
    this.camera = camera;
    this.domElement = domElement;
    this.config = {
      thrust: 200,
      boostMultiplier: 5,
      linearDrag: 0.98,
      mouseSensitivity: 0.002,
      rollSpeed: 1.5,
      maxSpeed: 2000,
      ...config,
    };
    this.initListeners();
  }

  // -----------------------------------------------------------------------
  // Input listeners
  // -----------------------------------------------------------------------

  private initListeners(): void {
    this.domElement.addEventListener('click', () => {
      if (!this._locked) this.domElement.requestPointerLock();
    });

    document.addEventListener('pointerlockchange', () => {
      this._locked = document.pointerLockElement === this.domElement;
    });

    document.addEventListener('mousemove', (e) => {
      if (!this._locked || !this.enabled) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });

    document.addEventListener('keydown', (e) => this.keys.set(e.code, true));
    document.addEventListener('keyup', (e) => this.keys.set(e.code, false));
  }

  private key(code: string): boolean {
    return this.keys.get(code) === true;
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  get speed(): number {
    return this.velocity.length();
  }

  get locked(): boolean {
    return this._locked;
  }

  /** Discard accumulated mouse deltas (call on mode switch). */
  resetMouse(): void {
    this.mouseDX = 0;
    this.mouseDY = 0;
  }

  // -----------------------------------------------------------------------
  // Update (call once per frame)
  // -----------------------------------------------------------------------

  update(dt: number): void {
    if (!this.enabled) return;

    const cam = this.camera;
    const cfg = this.config;

    // --- Rotation ---
    const pitchAngle = -this.mouseDY * cfg.mouseSensitivity;
    const yawAngle   = -this.mouseDX * cfg.mouseSensitivity;
    this.mouseDX = 0;
    this.mouseDY = 0;

    let rollAngle = 0;
    if (this.key('KeyQ')) rollAngle += cfg.rollSpeed * dt;
    if (this.key('KeyE')) rollAngle -= cfg.rollSpeed * dt;

    this._qYaw.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawAngle);
    this._qPitch.setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitchAngle);
    this._qRoll.setFromAxisAngle(new THREE.Vector3(0, 0, -1), rollAngle);

    const localRot = new THREE.Quaternion()
      .multiply(this._qYaw)
      .multiply(this._qPitch)
      .multiply(this._qRoll);

    cam.quaternion.multiply(localRot);
    cam.quaternion.normalize();

    // --- Translation ---
    const boost = this.key('ShiftLeft') || this.key('ShiftRight') ? cfg.boostMultiplier : 1;
    const accel = cfg.thrust * boost;

    const thrustDir = new THREE.Vector3();
    if (this.key('KeyW')) thrustDir.z -= 1;
    if (this.key('KeyS')) thrustDir.z += 1;
    if (this.key('KeyA')) thrustDir.x -= 1;
    if (this.key('KeyD')) thrustDir.x += 1;
    if (this.key('Space')) thrustDir.y += 1;
    if (this.key('ControlLeft') || this.key('ControlRight')) thrustDir.y -= 1;

    if (thrustDir.lengthSq() > 0) {
      thrustDir.normalize();
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
