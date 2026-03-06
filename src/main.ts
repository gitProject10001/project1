import * as THREE from 'three';
import { Planet, terrainConfig } from './Planet';
import { CameraControls } from './CameraControls';
import { FreeCameraControls } from './FreeCameraControls';
import { Spaceship } from './Spaceship';
import { GUI } from './GUI';
import { Starfield } from './Starfield';

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

// Ship (hidden by default — shown in game mode)
const ship = new Spaceship();
ship.position.set(0, 0, 3000);
ship.visible = false;
scene.add(ship);

// ---------------------------------------------------------------------------
// Dual-mode controls: Free camera (default) ↔ Game mode (G key)
// ---------------------------------------------------------------------------

let gameMode = false;
const freeControls = new FreeCameraControls(camera, renderer.domElement);
const gameControls = new CameraControls(camera, ship, renderer.domElement);
gameControls.enabled = false;

document.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyG' || !document.pointerLockElement) return;
  gameMode = !gameMode;
  if (gameMode) {
    // Free → Game: place ship at camera, switch to third-person
    ship.position.copy(camera.position);
    ship.quaternion.copy(camera.quaternion);
    ship.velocity.copy(freeControls.velocity);
    ship.visible = true;
    freeControls.enabled = false;
    freeControls.velocity.set(0, 0, 0);
    gameControls.enabled = true;
    gameControls.resetMouse();
    gameControls.snap();
  } else {
    // Game → Free: keep camera where it is, switch to 6DOF
    freeControls.velocity.copy(ship.velocity);
    ship.velocity.set(0, 0, 0);
    ship.visible = false;
    gameControls.enabled = false;
    freeControls.enabled = true;
    freeControls.resetMouse();
  }
});

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
// Stars (shader skybox)
// ---------------------------------------------------------------------------

const starfield = new Starfield();
scene.add(starfield.mesh);

// ---------------------------------------------------------------------------
// Planet
// ---------------------------------------------------------------------------

const planet = new Planet();
scene.add(planet.group);

// Pass sun direction to shaders
planet.atmosphere.setSunDirection(sunDir);
planet.atmosphere.setDepthTexture(depthTarget.depthTexture!);
planet.ocean.setSunDirection(sunDir);
planet.ocean.setDepthTexture(depthTarget.depthTexture!);
planet.clouds.setSunDirection(sunDir);
planet.clouds.setDepthTexture(depthTarget.depthTexture!);
planet.setTerrainSunDirection(sunDir);

// ---------------------------------------------------------------------------
// GUI – Real-time parameter controls
// ---------------------------------------------------------------------------

const gui = new GUI();

// Debounce helper for terrain regeneration (expensive)
let regenTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleTerrainRegen(): void {
  if (regenTimer) clearTimeout(regenTimer);
  regenTimer = setTimeout(() => planet.regenerateTerrain(), 300);
}

// ---- Terrain Generation Card ----
gui.addCard({
  title: 'Terrain Generation',
  icon: '\u26F0',
  sliders: [
    { label: 'Terrain Height', key: 'terrainHeight', min: 10, max: 200, step: 1, value: terrainConfig.terrainHeight,
      onChange: v => { terrainConfig.terrainHeight = v; scheduleTerrainRegen(); } },
    { label: 'Ocean Level', key: 'oceanLevel', min: 0.0, max: 0.8, step: 0.01, value: terrainConfig.oceanLevel,
      onChange: v => { terrainConfig.oceanLevel = v; scheduleTerrainRegen(); } },
    { label: 'Continent Scale', key: 'continentScale', min: 0.1, max: 3.0, step: 0.05, value: terrainConfig.continentScale,
      onChange: v => { terrainConfig.continentScale = v; scheduleTerrainRegen(); } },
    { label: 'Continent Octaves', key: 'continentOctaves', min: 1, max: 8, step: 1, value: terrainConfig.continentOctaves,
      onChange: v => { terrainConfig.continentOctaves = v; scheduleTerrainRegen(); } },
    { label: 'Continent Lacunarity', key: 'continentLac', min: 1.0, max: 4.0, step: 0.1, value: terrainConfig.continentLacunarity,
      onChange: v => { terrainConfig.continentLacunarity = v; scheduleTerrainRegen(); } },
    { label: 'Continent Persistence', key: 'continentPers', min: 0.1, max: 0.9, step: 0.01, value: terrainConfig.continentPersistence,
      onChange: v => { terrainConfig.continentPersistence = v; scheduleTerrainRegen(); } },
    { label: 'Mountain Scale', key: 'mountainScale', min: 0.5, max: 8.0, step: 0.1, value: terrainConfig.mountainScale,
      onChange: v => { terrainConfig.mountainScale = v; scheduleTerrainRegen(); } },
    { label: 'Mountain Strength', key: 'mountainStrength', min: 0.0, max: 1.0, step: 0.01, value: terrainConfig.mountainStrength,
      onChange: v => { terrainConfig.mountainStrength = v; scheduleTerrainRegen(); } },
    { label: 'Mountain Sharpness', key: 'mountainSharpness', min: 0.5, max: 5.0, step: 0.1, value: terrainConfig.mountainSharpness,
      onChange: v => { terrainConfig.mountainSharpness = v; scheduleTerrainRegen(); } },
    { label: 'Mountain Gain', key: 'mountainGain', min: 0.1, max: 0.9, step: 0.01, value: terrainConfig.mountainGain,
      onChange: v => { terrainConfig.mountainGain = v; scheduleTerrainRegen(); } },
    { label: 'Detail Scale', key: 'detailScale', min: 1.0, max: 50.0, step: 0.5, value: terrainConfig.detailScale,
      onChange: v => { terrainConfig.detailScale = v; scheduleTerrainRegen(); } },
    { label: 'Detail Strength', key: 'detailStrength', min: 0.0, max: 0.3, step: 0.005, value: terrainConfig.detailStrength,
      onChange: v => { terrainConfig.detailStrength = v; scheduleTerrainRegen(); } },
    { label: 'Erosion Power', key: 'erosionPower', min: 0.5, max: 4.0, step: 0.05, value: terrainConfig.erosionPower,
      onChange: v => { terrainConfig.erosionPower = v; scheduleTerrainRegen(); } },
  ],
});

// ---- Atmosphere Card ----
gui.addCard({
  title: 'Atmosphere',
  icon: '\uD83C\uDF0D',
  sliders: [
    { label: 'Intensity', key: 'atmoIntensity', min: 0, max: 60, step: 0.5, value: 22.0,
      onChange: v => planet.atmosphere.setUniform('uIntensity', v) },
    { label: 'Rayleigh Scale H', key: 'atmoRayleighScale', min: 1, max: 30, step: 0.5, value: 10.0,
      onChange: v => planet.atmosphere.setUniform('uRayleighScale', v) },
    { label: 'Mie Scale H', key: 'atmoMieScale', min: 0.5, max: 15, step: 0.1, value: 3.5,
      onChange: v => planet.atmosphere.setUniform('uMieScale', v) },
    { label: 'Mie Coeff', key: 'atmoMieCoeff', min: 0.0, max: 0.1, step: 0.001, value: 0.015,
      onChange: v => planet.atmosphere.setUniform('uMieCoeff', v) },
    { label: 'Mie G (Asymmetry)', key: 'atmoMieG', min: -0.99, max: 0.99, step: 0.01, value: 0.76,
      onChange: v => planet.atmosphere.setUniform('uMieG', v) },
    { label: 'Rayleigh R', key: 'atmoRayR', min: 0.0, max: 0.1, step: 0.001, value: 0.01,
      onChange: v => {
        const c = planet.atmosphere.getUniform('uRayleighCoeff') as THREE.Vector3;
        planet.atmosphere.setUniform('uRayleighCoeff', new THREE.Vector3(v, c.y, c.z));
      } },
    { label: 'Rayleigh G', key: 'atmoRayG', min: 0.0, max: 0.1, step: 0.001, value: 0.025,
      onChange: v => {
        const c = planet.atmosphere.getUniform('uRayleighCoeff') as THREE.Vector3;
        planet.atmosphere.setUniform('uRayleighCoeff', new THREE.Vector3(c.x, v, c.z));
      } },
    { label: 'Rayleigh B', key: 'atmoRayB', min: 0.0, max: 0.2, step: 0.001, value: 0.06,
      onChange: v => {
        const c = planet.atmosphere.getUniform('uRayleighCoeff') as THREE.Vector3;
        planet.atmosphere.setUniform('uRayleighCoeff', new THREE.Vector3(c.x, c.y, v));
      } },
  ],
});

// ---- Clouds Card ----
gui.addCard({
  title: 'Clouds',
  icon: '\u2601',
  sliders: [
    { label: 'Coverage', key: 'cloudCoverage', min: 0.0, max: 1.0, step: 0.01, value: 0.74,
      onChange: v => { planet.clouds.setUniform('uCoverage', v); planet.syncTerrainCloudParams(); } },
    { label: 'Density', key: 'cloudDensity', min: 0.1, max: 3.0, step: 0.05, value: 0.8,
      onChange: v => { planet.clouds.setUniform('uDensityMult', v); planet.syncTerrainCloudParams(); } },
    { label: 'Speed', key: 'cloudSpeed', min: 0.0, max: 2.0, step: 0.05, value: 0.3,
      onChange: v => { planet.clouds.setUniform('uCloudSpeed', v); planet.syncTerrainCloudParams(); } },
    { label: 'Cloud Type', key: 'cloudType', min: 0.0, max: 2.0, step: 0.1, value: 1.0,
      onChange: v => { planet.clouds.setUniform('uCloudType', v); planet.syncTerrainCloudParams(); } },
    { label: 'Advection', key: 'cloudAdvection', min: 0.0, max: 5.0, step: 0.1, value: 1.5,
      onChange: v => { planet.clouds.setUniform('uAdvectionStrength', v); planet.syncTerrainCloudParams(); } },
    { label: 'Turbulence', key: 'cloudTurbulence', min: 0.0, max: 3.0, step: 0.1, value: 0.8,
      onChange: v => { planet.clouds.setUniform('uTurbulence', v); planet.syncTerrainCloudParams(); } },
    { label: 'Weather Scale', key: 'cloudWeather', min: 0.0, max: 3.0, step: 0.1, value: 1.0,
      onChange: v => { planet.clouds.setUniform('uWeatherScale', v); planet.syncTerrainCloudParams(); } },
    { label: 'Wind X', key: 'cloudWindX', min: -1.0, max: 1.0, step: 0.05, value: 0.7,
      onChange: v => { planet.clouds.setUniform('uWindX', v); planet.syncTerrainCloudParams(); } },
    { label: 'Wind Z', key: 'cloudWindZ', min: -1.0, max: 1.0, step: 0.05, value: 1.0,
      onChange: v => { planet.clouds.setUniform('uWindZ', v); planet.syncTerrainCloudParams(); } },
    { label: 'Sun Intensity', key: 'cloudSunInt', min: 0, max: 60, step: 0.5, value: 22.0,
      onChange: v => planet.clouds.setUniform('uSunIntensity', v) },
    { label: 'Tornado Strength', key: 'tornadoStrength', min: 0.0, max: 5.0, step: 0.1, value: 2.0,
      onChange: v => { planet.clouds.setUniform('uTornadoStrength', v); planet.syncTerrainCloudParams(); } },
    { label: 'Tornadoes Active', key: 'tornadoActive', min: 0, max: 3, step: 1, value: 0,
      onChange: v => { planet.clouds.setTornadoActive(v); planet.syncTerrainCloudParams(); } },
  ],
  colors: [
    { label: 'Cloud Color', key: 'cloudColor', r: 1.0, g: 0.98, b: 0.95,
      onChange: (r, g, b) => planet.clouds.setUniform('uCloudColor', new THREE.Vector3(r, g, b)) },
    { label: 'Shadow Color', key: 'cloudShadow', r: 0.2, g: 0.22, b: 0.25,
      onChange: (r, g, b) => planet.clouds.setUniform('uCloudShadowColor', new THREE.Vector3(r, g, b)) },
  ],
});

// ---- Ocean Card ----
gui.addCard({
  title: 'Ocean',
  icon: '\uD83C\uDF0A',
  sliders: [
    { label: 'Wave Height', key: 'waveHeight', min: 0.0, max: 15.0, step: 0.5, value: 3.0,
      onChange: v => planet.ocean.setUniform('uWaveHeight', v) },
    { label: 'Wave Choppy', key: 'waveChoppy', min: 1.0, max: 8.0, step: 0.1, value: 4.0,
      onChange: v => planet.ocean.setUniform('uWaveChoppy', v) },
    { label: 'Wave Speed', key: 'waveSpeed', min: 0.0, max: 3.0, step: 0.05, value: 0.8,
      onChange: v => planet.ocean.setUniform('uWaveSpeed', v) },
    { label: 'Wave Frequency', key: 'waveFreq', min: 0.01, max: 1.0, step: 0.01, value: 0.15,
      onChange: v => planet.ocean.setUniform('uWaveFreq', v) },
    { label: 'Sun Intensity', key: 'oceanSunInt', min: 0, max: 60, step: 0.5, value: 22.0,
      onChange: v => planet.ocean.setUniform('uSunIntensity', v) },
    { label: 'Max Depth Fade', key: 'oceanDepthFade', min: 5, max: 200, step: 1, value: 40.0,
      onChange: v => planet.ocean.setUniform('uMaxDepthFade', v) },
    { label: 'Absorption R', key: 'oceanAbsR', min: 0.0, max: 2.0, step: 0.01, value: 0.4,
      onChange: v => {
        const c = planet.ocean.getUniform('uAbsorption') as THREE.Vector3;
        planet.ocean.setUniform('uAbsorption', new THREE.Vector3(v, c.y, c.z));
      } },
    { label: 'Absorption G', key: 'oceanAbsG', min: 0.0, max: 2.0, step: 0.01, value: 0.08,
      onChange: v => {
        const c = planet.ocean.getUniform('uAbsorption') as THREE.Vector3;
        planet.ocean.setUniform('uAbsorption', new THREE.Vector3(c.x, v, c.z));
      } },
    { label: 'Absorption B', key: 'oceanAbsB', min: 0.0, max: 2.0, step: 0.01, value: 0.02,
      onChange: v => {
        const c = planet.ocean.getUniform('uAbsorption') as THREE.Vector3;
        planet.ocean.setUniform('uAbsorption', new THREE.Vector3(c.x, c.y, v));
      } },
  ],
  colors: [
    { label: 'Shallow Color', key: 'oceanShallow', r: 0.04, g: 0.16, b: 0.28,
      onChange: (r, g, b) => planet.ocean.setUniform('uShallowColor', new THREE.Vector3(r, g, b)) },
    { label: 'Deep Color', key: 'oceanDeep', r: 0.005, g: 0.02, b: 0.08,
      onChange: (r, g, b) => planet.ocean.setUniform('uDeepColor', new THREE.Vector3(r, g, b)) },
    { label: 'Scatter Color', key: 'oceanScatter', r: 0.0, g: 0.4, b: 0.3,
      onChange: (r, g, b) => planet.ocean.setUniform('uScatterColor', new THREE.Vector3(r, g, b)) },
  ],
});

// ---- Starfield Card ----
gui.addCard({
  title: 'Starfield',
  icon: '\u2B50',
  sliders: [
    { label: 'Star Brightness', key: 'starBright', min: 0.0, max: 5.0, step: 0.1, value: 1.5,
      onChange: v => starfield.setUniform('uStarBrightness', v) },
    { label: 'Nebula Brightness', key: 'nebulaBright', min: 0.0, max: 2.0, step: 0.05, value: 0.6,
      onChange: v => starfield.setUniform('uNebulaBrightness', v) },
    { label: 'Twinkle Speed', key: 'twinkleSpeed', min: 0.0, max: 5.0, step: 0.1, value: 1.0,
      onChange: v => starfield.setUniform('uTwinkleSpeed', v) },
  ],
});

// ---- Lighting Card ----
gui.addCard({
  title: 'Lighting',
  icon: '\u2600',
  sliders: [
    { label: 'Sun Dir X', key: 'sunX', min: -1, max: 1, step: 0.01, value: sunDir.x,
      onChange: v => {
        sunDir.x = v; sunDir.normalize();
        sunLight.position.copy(sunDir.clone().multiplyScalar(10000));
        planet.atmosphere.setSunDirection(sunDir);
        planet.ocean.setSunDirection(sunDir);
        planet.clouds.setSunDirection(sunDir);
        planet.setTerrainSunDirection(sunDir);
      } },
    { label: 'Sun Dir Y', key: 'sunY', min: -1, max: 1, step: 0.01, value: sunDir.y,
      onChange: v => {
        sunDir.y = v; sunDir.normalize();
        sunLight.position.copy(sunDir.clone().multiplyScalar(10000));
        planet.atmosphere.setSunDirection(sunDir);
        planet.ocean.setSunDirection(sunDir);
        planet.clouds.setSunDirection(sunDir);
        planet.setTerrainSunDirection(sunDir);
      } },
    { label: 'Sun Dir Z', key: 'sunZ', min: -1, max: 1, step: 0.01, value: sunDir.z,
      onChange: v => {
        sunDir.z = v; sunDir.normalize();
        sunLight.position.copy(sunDir.clone().multiplyScalar(10000));
        planet.atmosphere.setSunDirection(sunDir);
        planet.ocean.setSunDirection(sunDir);
        planet.clouds.setSunDirection(sunDir);
        planet.setTerrainSunDirection(sunDir);
      } },
    { label: 'Sun Intensity', key: 'sunLightInt', min: 0, max: 5, step: 0.1, value: 2.0,
      onChange: v => { sunLight.intensity = v; } },
    { label: 'Ambient Intensity', key: 'ambientInt', min: 0, max: 2, step: 0.05, value: 0.4,
      onChange: v => { ambientLight.intensity = v; } },
    { label: 'Hemisphere Intensity', key: 'hemiInt', min: 0, max: 2, step: 0.05, value: 0.3,
      onChange: v => { hemiLight.intensity = v; } },
    { label: 'Exposure', key: 'exposure', min: 0.1, max: 3.0, step: 0.05, value: 1.0,
      onChange: v => { renderer.toneMappingExposure = v; } },
    { label: 'Fog Density', key: 'fogDensity', min: 0, max: 0.00005, step: 0.000001, value: 0.000002,
      onChange: v => { (scene.fog as THREE.FogExp2).density = v; } },
  ],
});

// ---- Camera / Flight Card ----
gui.addCard({
  title: 'Flight Controls',
  icon: '\uD83D\uDE80',
  sliders: [
    { label: 'Thrust', key: 'thrust', min: 10, max: 1000, step: 10, value: ship.config.thrust,
      onChange: v => { ship.config.thrust = v; freeControls.config.thrust = v; } },
    { label: 'Boost Multiplier', key: 'boost', min: 1, max: 20, step: 0.5, value: ship.config.boostMultiplier,
      onChange: v => { ship.config.boostMultiplier = v; freeControls.config.boostMultiplier = v; } },
    { label: 'Max Speed', key: 'maxSpeed', min: 100, max: 10000, step: 50, value: ship.config.maxSpeed,
      onChange: v => { ship.config.maxSpeed = v; freeControls.config.maxSpeed = v; } },
    { label: 'Drag', key: 'drag', min: 0.9, max: 1.0, step: 0.002, value: ship.config.linearDrag,
      onChange: v => { ship.config.linearDrag = v; freeControls.config.linearDrag = v; } },
    { label: 'Mouse Sensitivity', key: 'mouseSens', min: 0.0005, max: 0.01, step: 0.0005, value: freeControls.config.mouseSensitivity,
      onChange: v => { gameControls.config.mouseSensitivity = v; freeControls.config.mouseSensitivity = v; } },
    { label: 'Pitch Speed', key: 'pitchSpeed', min: 0.1, max: 5.0, step: 0.1, value: ship.config.pitchSpeed,
      onChange: v => { ship.config.pitchSpeed = v; } },
    { label: 'Yaw Speed', key: 'yawSpeed', min: 0.1, max: 5.0, step: 0.1, value: ship.config.yawSpeed,
      onChange: v => { ship.config.yawSpeed = v; } },
    { label: 'Roll Speed', key: 'rollSpeed', min: 0.1, max: 5.0, step: 0.1, value: ship.config.rollSpeed,
      onChange: v => { ship.config.rollSpeed = v; freeControls.config.rollSpeed = v; } },
    { label: 'Gravity', key: 'gravity', min: 0, max: 200_000_000, step: 1_000_000, value: ship.config.gravityGM,
      onChange: v => { ship.config.gravityGM = v; } },
    { label: 'FOV', key: 'fov', min: 30, max: 120, step: 1, value: 75,
      onChange: v => { camera.fov = v; camera.updateProjectionMatrix(); } },
  ],
});

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

const hudEl = document.getElementById('hud')!;

// FPS tracking with smoothing
let fpsFrames = 0;
let fpsLastTime = performance.now();
let fpsDisplay = 0;

function updateHUD(): void {
  // FPS calculation — update display every 500ms for stability
  fpsFrames++;
  const now = performance.now();
  const elapsed = now - fpsLastTime;
  if (elapsed >= 500) {
    fpsDisplay = Math.round((fpsFrames * 1000) / elapsed);
    fpsFrames = 0;
    fpsLastTime = now;
  }

  const speed = (gameMode ? ship.speed : freeControls.speed).toFixed(1);
  const alt = ((gameMode ? ship.position.length() : camera.position.length()) - planet.radius).toFixed(1);
  const pos = gameMode ? ship.position : camera.position;
  hudEl.innerHTML = [
    `MODE: ${gameMode ? 'GAME [G]' : 'FREE [G]'}`,
    `FPS: ${fpsDisplay}`,
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
  const altitude = (gameMode ? ship.position.length() : camera.position.length()) - planet.radius;
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

  // Update active flight controls
  if (gameMode) {
    gameControls.update(dt);

    // --- Terrain collision ---
    const surfaceH = planet.getHeightAt(ship.position);
    const shipDist = ship.position.length();
    const collisionBuffer = 2; // ship half-height
    if (shipDist < surfaceH + collisionBuffer) {
      const normal = ship.position.clone().normalize();
      // Cancel inward velocity and add slight bounce
      const vn = ship.velocity.dot(normal);
      if (vn < 0) {
        ship.velocity.addScaledVector(normal, -vn * 1.5);
        ship.velocity.multiplyScalar(0.8); // friction
      }
      ship.position.copy(normal.multiplyScalar(surfaceH + collisionBuffer));
    }

    // --- Re-entry flame ---
    const atmoRadius = (planet.radius + terrainConfig.terrainHeight) * 1.26;
    const atmoDepth = Math.max(0, (atmoRadius - shipDist) / (atmoRadius - planet.radius));
    const reentryIntensity = Math.min(1.0, atmoDepth * ship.speed / 300);
    const velDir = ship.speed > 0.1
      ? ship.velocity.clone().divideScalar(ship.speed)
      : new THREE.Vector3(0, 0, -1);
    ship.setReentryIntensity(reentryIntensity, clock.elapsedTime, velDir);
  } else {
    freeControls.update(dt);
  }

  // Adjust clip planes based on altitude
  updateClipPlanes();

  // Force camera matrix update BEFORE planet LOD/culling reads it
  camera.updateMatrixWorld(true);

  // Update starfield skybox
  starfield.update(camera);
  starfield.updateTime(clock.elapsedTime);

  // Update planet LOD
  planet.update(camera);

  // Update camera-dependent uniforms for volumetric shaders
  planet.atmosphere.updateCameraUniforms(camera);
  planet.ocean.updateCameraUniforms(camera);
  planet.ocean.updateTime(clock.elapsedTime);
  planet.clouds.updateCameraUniforms(camera);
  planet.clouds.updateTime(clock.elapsedTime);

  // Update terrain cloud shadow params
  planet.updateTerrainTime(clock.elapsedTime);
  planet.syncTerrainCloudParams();

  // ---------------------------------------------------------------------------
  // Two-pass hybrid pipeline
  // ---------------------------------------------------------------------------

  // Pass 1: Render opaque terrain into the depth target
  planet.atmosphere.mesh.visible = false;
  planet.ocean.mesh.visible = false;
  planet.clouds.mesh.visible = false;
  starfield.mesh.visible = false;
  renderer.setRenderTarget(depthTarget);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);

  // Pass 2: Render everything (volumetric shaders now read the depth texture)
  planet.atmosphere.mesh.visible = true;
  planet.ocean.mesh.visible = true;
  planet.clouds.mesh.visible = true;
  starfield.mesh.visible = true;
  renderer.render(scene, camera);

  // HUD
  updateHUD();
}

animate();
