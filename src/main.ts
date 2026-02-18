import * as THREE from 'three';
import { Planet } from './Planet';
import { CameraControls } from './CameraControls';

// ---------------------------------------------------------------------------
// Scene bootstrap
// ---------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

// ---------------------------------------------------------------------------
// Depth-texture render target for hybrid pipeline
// ---------------------------------------------------------------------------

function createDepthTarget(w: number, h: number): THREE.WebGLRenderTarget {
  const dpr = renderer.getPixelRatio();
  const target = new THREE.WebGLRenderTarget(w * dpr, h * dpr, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    type: THREE.FloatType,
  });
  target.depthTexture = new THREE.DepthTexture(w * dpr, h * dpr);
  target.depthTexture.type = THREE.FloatType;
  return target;
}

let depthTarget = createDepthTarget(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000005);
scene.fog = new THREE.FogExp2(0x000005, 0.000002);

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  0.5,
  100000,
);
// Start in deep space, looking toward planet
camera.position.set(0, 0, 3000);
camera.lookAt(0, 0, 0);

const controls = new CameraControls(camera, renderer.domElement);

// ---------------------------------------------------------------------------
// Lighting
// ---------------------------------------------------------------------------

const sunDir = new THREE.Vector3(1, 0.5, 0.8).normalize();

const sunLight = new THREE.DirectionalLight(0xfff5e0, 2.0);
sunLight.position.copy(sunDir.clone().multiplyScalar(10000));
scene.add(sunLight);

const ambientLight = new THREE.AmbientLight(0x0a0a20, 0.4);
scene.add(ambientLight);

// Subtle hemisphere light for sky/ground colour separation
const hemiLight = new THREE.HemisphereLight(0x4488cc, 0x222211, 0.3);
scene.add(hemiLight);

// ---------------------------------------------------------------------------
// Stars (background particles)
// ---------------------------------------------------------------------------

function createStarfield(): THREE.Points {
  const count = 8000;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    // Distribute on a large sphere
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = 40000 + Math.random() * 20000;
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);

    // Slight colour variation
    const temp = 0.7 + Math.random() * 0.3;
    colors[i * 3] = temp;
    colors[i * 3 + 1] = temp * (0.8 + Math.random() * 0.2);
    colors[i * 3 + 2] = temp;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.PointsMaterial({
    size: 2,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
  });

  return new THREE.Points(geo, mat);
}

scene.add(createStarfield());

// ---------------------------------------------------------------------------
// Planet
// ---------------------------------------------------------------------------

const planet = new Planet();
scene.add(planet.group);

// Pass sun direction to the atmosphere shader
planet.atmosphere.setSunDirection(sunDir);
planet.atmosphere.setDepthTexture(depthTarget.depthTexture!);
planet.ocean.setSunDirection(sunDir);
planet.ocean.setDepthTexture(depthTarget.depthTexture!);
planet.clouds.setSunDirection(sunDir);
planet.clouds.setDepthTexture(depthTarget.depthTexture!);

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

const hudEl = document.getElementById('hud')!;

function updateHUD(): void {
  const speed = controls.speed.toFixed(1);
  const alt = (camera.position.length() - planet.radius).toFixed(1);
  const pos = camera.position;
  hudEl.innerHTML = [
    `SPD: ${speed} m/s`,
    `ALT: ${alt} m`,
    `POS: ${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)}`,
    `TRI: ${renderer.info.render.triangles.toLocaleString()}`,
    `CALLS: ${renderer.info.render.calls}`,
  ].join('<br>');
}

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);

  // Rebuild depth target at new resolution
  depthTarget.dispose();
  depthTarget = createDepthTarget(window.innerWidth, window.innerHeight);
  planet.atmosphere.setDepthTexture(depthTarget.depthTexture!);
  planet.ocean.setDepthTexture(depthTarget.depthTexture!);
  planet.clouds.setDepthTexture(depthTarget.depthTexture!);
});

// ---------------------------------------------------------------------------
// Dynamic near/far plane to handle space-to-surface scale
// ---------------------------------------------------------------------------

function updateClipPlanes(): void {
  const altitude = camera.position.length() - planet.radius;
  if (altitude < 50) {
    camera.near = 0.1;
    camera.far = 10000;
  } else if (altitude < 500) {
    camera.near = 0.5;
    camera.far = 20000;
  } else {
    camera.near = 1;
    camera.far = 100000;
  }
  camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------------------
// Animation loop
// ---------------------------------------------------------------------------

const clock = new THREE.Clock();

function animate(): void {
  requestAnimationFrame(animate);

  const dt = Math.min(clock.getDelta(), 0.05); // Cap to avoid spiral of death

  // Update flight controls
  controls.update(dt);

  // Adjust clip planes based on altitude
  updateClipPlanes();

  // Force camera matrix update BEFORE planet LOD/culling reads it
  camera.updateMatrixWorld(true);

  // Update planet LOD
  planet.update(camera);

  // Update camera-dependent uniforms for volumetric shaders
  planet.atmosphere.updateCameraUniforms(camera);
  planet.ocean.updateCameraUniforms(camera);
  planet.clouds.updateCameraUniforms(camera);
  planet.clouds.updateTime(clock.elapsedTime);

  // ---------------------------------------------------------------------------
  // Two-pass hybrid pipeline
  // ---------------------------------------------------------------------------

  // Pass 1: Render opaque terrain into the depth target
  planet.atmosphere.mesh.visible = false;
  planet.ocean.mesh.visible = false;
  planet.clouds.mesh.visible = false;
  renderer.setRenderTarget(depthTarget);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);

  // Pass 2: Render everything (volumetric shaders now read the depth texture)
  planet.atmosphere.mesh.visible = true;
  planet.ocean.mesh.visible = true;
  planet.clouds.mesh.visible = true;
  renderer.render(scene, camera);

  // HUD
  updateHUD();
}

animate();
