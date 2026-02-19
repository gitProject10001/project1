import * as THREE from 'three';
import { Planet, terrainConfig } from './Planet';
import { CameraControls } from './CameraControls';
import { GUI } from './GUI';

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
    { label: 'Detail Scale', key: 'detailScale', min: 1.0, max: 20.0, step: 0.5, value: terrainConfig.detailScale,
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
    { label: 'Coverage', key: 'cloudCoverage', min: 0.0, max: 1.0, step: 0.01, value: 0.55,
      onChange: v => planet.clouds.setUniform('uCoverage', v) },
    { label: 'Density', key: 'cloudDensity', min: 0.1, max: 3.0, step: 0.05, value: 0.8,
      onChange: v => planet.clouds.setUniform('uDensityMult', v) },
    { label: 'Speed', key: 'cloudSpeed', min: 0.0, max: 2.0, step: 0.05, value: 0.3,
      onChange: v => planet.clouds.setUniform('uCloudSpeed', v) },
    { label: 'Sun Intensity', key: 'cloudSunInt', min: 0, max: 60, step: 0.5, value: 22.0,
      onChange: v => planet.clouds.setUniform('uSunIntensity', v) },
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
      } },
    { label: 'Sun Dir Y', key: 'sunY', min: -1, max: 1, step: 0.01, value: sunDir.y,
      onChange: v => {
        sunDir.y = v; sunDir.normalize();
        sunLight.position.copy(sunDir.clone().multiplyScalar(10000));
        planet.atmosphere.setSunDirection(sunDir);
        planet.ocean.setSunDirection(sunDir);
        planet.clouds.setSunDirection(sunDir);
      } },
    { label: 'Sun Dir Z', key: 'sunZ', min: -1, max: 1, step: 0.01, value: sunDir.z,
      onChange: v => {
        sunDir.z = v; sunDir.normalize();
        sunLight.position.copy(sunDir.clone().multiplyScalar(10000));
        planet.atmosphere.setSunDirection(sunDir);
        planet.ocean.setSunDirection(sunDir);
        planet.clouds.setSunDirection(sunDir);
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
    { label: 'Thrust', key: 'thrust', min: 10, max: 1000, step: 10, value: controls.config.thrust,
      onChange: v => { controls.config.thrust = v; } },
    { label: 'Boost Multiplier', key: 'boost', min: 1, max: 20, step: 0.5, value: controls.config.boostMultiplier,
      onChange: v => { controls.config.boostMultiplier = v; } },
    { label: 'Max Speed', key: 'maxSpeed', min: 100, max: 10000, step: 50, value: controls.config.maxSpeed,
      onChange: v => { controls.config.maxSpeed = v; } },
    { label: 'Drag', key: 'drag', min: 0.9, max: 1.0, step: 0.002, value: controls.config.linearDrag,
      onChange: v => { controls.config.linearDrag = v; } },
    { label: 'Mouse Sensitivity', key: 'mouseSens', min: 0.0005, max: 0.01, step: 0.0005, value: controls.config.mouseSensitivity,
      onChange: v => { controls.config.mouseSensitivity = v; } },
    { label: 'Roll Speed', key: 'rollSpeed', min: 0.1, max: 5.0, step: 0.1, value: controls.config.rollSpeed,
      onChange: v => { controls.config.rollSpeed = v; } },
    { label: 'FOV', key: 'fov', min: 30, max: 120, step: 1, value: 75,
      onChange: v => { camera.fov = v; camera.updateProjectionMatrix(); } },
  ],
});

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
