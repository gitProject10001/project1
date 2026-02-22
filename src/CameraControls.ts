import * as THREE from 'three';
import { Spaceship } from './Spaceship';

// ---------------------------------------------------------------------------
// Third-Person Orbit Camera anchored to a Spaceship
// ---------------------------------------------------------------------------
//
// Mouse  → orbit around ship (360° horizontal, clamped vertical)
// Scroll → zoom in/out
// Keys   → forwarded to ship for flight controls
//
// The camera smoothly follows the ship with lerp and gently springs
// back to the default behind-ship view when idle.

export interface CameraConfig {
  /** Orbit mouse sensitivity (rad/pixel) */
  mouseSensitivity: number;
  /** Camera follow lerp speed */
  followSpeed: number;
  /** Default orbit distance from ship */
  defaultDistance: number;
  /** Minimum zoom distance */
  minDistance: number;
  /** Maximum zoom distance */
  maxDistance: number;
  /** Spring strength pulling camera back behind ship */
  springStrength: number;
}

export class CameraControls {
  camera: THREE.PerspectiveCamera;
  ship: Spaceship;
  config: CameraConfig;

  /** Set false to ignore input while another controller is active */
  enabled = true;

  /** Horizontal orbit angle (0 = behind ship) */
  orbitTheta = 0;
  /** Vertical orbit angle (positive = above) */
  orbitPhi = 0.2;
  /** Current orbit distance */
  orbitDistance: number;

  /** Key state — shared with ship */
  keys = new Map<string, boolean>();

  private _locked = false;
  private domElement: HTMLElement;
  private mouseDX = 0;
  private mouseDY = 0;

  // Reusable vectors
  private _offset = new THREE.Vector3();
  private _target = new THREE.Vector3();

  constructor(
    camera: THREE.PerspectiveCamera,
    ship: Spaceship,
    domElement: HTMLElement,
    config?: Partial<CameraConfig>,
  ) {
    this.camera = camera;
    this.ship = ship;
    this.domElement = domElement;
    this.config = {
      mouseSensitivity: 0.003,
      followSpeed: 5,
      defaultDistance: 20,
      minDistance: 5,
      maxDistance: 200,
      springStrength: 0.5,
      ...config,
    };
    this.orbitDistance = this.config.defaultDistance;

    this.initListeners();
    this.snap();
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

    this.domElement.addEventListener('wheel', (e) => {
      this.orbitDistance *= 1 + e.deltaY * 0.001;
      this.orbitDistance = Math.max(
        this.config.minDistance,
        Math.min(this.config.maxDistance, this.orbitDistance),
      );
    });
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  get locked(): boolean {
    return this._locked;
  }

  get speed(): number {
    return this.ship.speed;
  }

  get velocity(): THREE.Vector3 {
    return this.ship.velocity;
  }

  /** Discard accumulated mouse deltas (call on mode switch). */
  resetMouse(): void {
    this.mouseDX = 0;
    this.mouseDY = 0;
  }

  // -----------------------------------------------------------------------
  // Camera positioning
  // -----------------------------------------------------------------------

  /** Immediately snap camera to target (no lerp). */
  snap(): void {
    this.computeOffset();
    this.camera.position.copy(this.ship.position).add(this._offset);
    this.camera.lookAt(this.ship.position);
  }

  private computeOffset(): void {
    // Compute offset in ship-local space, then rotate to world
    this._offset.set(
      this.orbitDistance * Math.cos(this.orbitPhi) * Math.sin(this.orbitTheta),
      this.orbitDistance * Math.sin(this.orbitPhi),
      this.orbitDistance * Math.cos(this.orbitPhi) * Math.cos(this.orbitTheta),
    );
    this._offset.applyQuaternion(this.ship.quaternion);
  }

  // -----------------------------------------------------------------------
  // Update (call once per frame)
  // -----------------------------------------------------------------------

  update(dt: number): void {
    if (!this.enabled) return;

    // Mouse → orbit angles
    this.orbitTheta += this.mouseDX * this.config.mouseSensitivity;
    this.orbitPhi -= this.mouseDY * this.config.mouseSensitivity;
    this.mouseDX = 0;
    this.mouseDY = 0;

    // Clamp phi to avoid gimbal lock
    this.orbitPhi = Math.max(-Math.PI * 0.45, Math.min(Math.PI * 0.45, this.orbitPhi));

    // Update ship physics
    this.ship.update(dt, this.keys);

    // Compute target camera position
    this.computeOffset();
    this._target.copy(this.ship.position).add(this._offset);

    // Smooth follow (exponential lerp for frame-rate independence)
    const t = 1 - Math.exp(-this.config.followSpeed * dt);
    this.camera.position.lerp(this._target, t);

    // Always look at ship
    this.camera.lookAt(this.ship.position);
  }

  dispose(): void {
    // Listeners would need to be removed properly in production
  }
}
