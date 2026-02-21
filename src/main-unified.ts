import * as THREE from 'three';
import { Planet, terrainConfig } from './Planet';
import { CameraControls } from './CameraControls';
import { GUI } from './GUI';
import { UnifiedRenderer } from './UnifiedRenderer';
import { generateMeshSDFFromMesh } from './MeshSDF';

// ---------------------------------------------------------------------------
// Scene bootstrap
// ---------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

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
// Sun
// ---------------------------------------------------------------------------

const sunDir = new THREE.Vector3(1, 0.5, 0.8).normalize();

// ---------------------------------------------------------------------------
// Planet (used only for terrain mesh generation / LOD — not for rendering)
// We still need the Planet to generate terrain geometry so we can produce
// an SDF from it. The planet's atmosphere/clouds/ocean meshes are NOT
// rendered; the UnifiedRenderer handles all of that in a single shader.
// ---------------------------------------------------------------------------

// We create a minimal scene just so Planet's LOD system can function.
// This scene is never rendered to screen.
const offscreenScene = new THREE.Scene();
const planet = new Planet();
offscreenScene.add(planet.group);

// ---------------------------------------------------------------------------
// Unified Renderer
// ---------------------------------------------------------------------------

const unified = new UnifiedRenderer({
  // Match Planet defaults
  planetRadius: 1000,
  cloudInnerRadius: 1045.0,
  cloudOuterRadius: 1095.0,
  atmoRadius: (1000 + 80) * 1.26,
});

// ---------------------------------------------------------------------------
// SDF Generation
//
// The terrain is a LOD quadtree with many patches. To generate a meaningful
// SDF we need to merge visible patches or use a representative mesh.
// For now, we generate the SDF from the coarsest LOD level (6 face patches)
// by forcing the planet to update at a far distance, collecting the meshes,
// merging them, and generating one SDF.
//
// This runs once at startup. For dynamic terrain, call regenerateSDF().
// ---------------------------------------------------------------------------

let sdfGenerated = false;

function generateTerrainSDF(): void {
  // Force planet LOD update at a far distance to get coarse patches
  const farCam = camera.clone();
  farCam.position.set(0, 0, 50000);
  farCam.updateMatrixWorld(true);
  planet.update(farCam);

  // Collect all visible terrain meshes from the planet group
  const geometries: THREE.BufferGeometry[] = [];
  planet.group.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry && child.visible) {
      // Skip ocean, atmosphere, and cloud meshes (they use ShaderMaterial)
      if (child.material instanceof THREE.ShaderMaterial) return;
      const geo = child.geometry.clone();
      child.updateMatrixWorld(true);
      geo.applyMatrix4(child.matrixWorld);
      geometries.push(geo);
    }
  });

  if (geometries.length === 0) {
    console.warn('UnifiedRenderer: No terrain meshes found for SDF generation');
    return;
  }

  // Merge all geometries into one
  const merged = mergeGeometries(geometries);
  for (const geo of geometries) geo.dispose();

  if (!merged) {
    console.warn('UnifiedRenderer: Failed to merge terrain geometries');
    return;
  }

  // Create a temporary mesh for SDF generation
  const tempMesh = new THREE.Mesh(merged);
  tempMesh.updateMatrixWorld(true);

  console.log('Generating terrain SDF (this may take a moment)...');
  const sdfResult = generateMeshSDFFromMesh(tempMesh, { resolution: 64 });
  unified.setTerrainSDF(sdfResult);
  sdfGenerated = true;
  console.log('Terrain SDF generated:', sdfResult.resolution + '^3 voxels');

  merged.dispose();
}

/**
 * Merge multiple BufferGeometries into one.
 * Only transfers position, normal, and index attributes.
 */
function mergeGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  let totalVerts = 0;
  let totalIndices = 0;

  for (const geo of geometries) {
    totalVerts += geo.attributes.position.count;
    totalIndices += geo.index ? geo.index.count : geo.attributes.position.count;
  }

  if (totalVerts === 0) return null;

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const indices = new Uint32Array(totalIndices);

  let vertOffset = 0;
  let indexOffset = 0;

  for (const geo of geometries) {
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const norm = geo.attributes.normal as THREE.BufferAttribute | undefined;
    const count = pos.count;

    for (let i = 0; i < count * 3; i++) {
      positions[vertOffset * 3 + i] = (pos.array as Float32Array)[i];
    }
    if (norm) {
      for (let i = 0; i < count * 3; i++) {
        normals[vertOffset * 3 + i] = (norm.array as Float32Array)[i];
      }
    }

    if (geo.index) {
      const idx = geo.index;
      for (let i = 0; i < idx.count; i++) {
        indices[indexOffset + i] = idx.getX(i) + vertOffset;
      }
      indexOffset += idx.count;
    } else {
      for (let i = 0; i < count; i++) {
        indices[indexOffset + i] = vertOffset + i;
      }
      indexOffset += count;
    }

    vertOffset += count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  return merged;
}

// Generate the SDF on first load (deferred to let the first frame render)
setTimeout(generateTerrainSDF, 100);

// ---------------------------------------------------------------------------
// GUI — Real-time parameter controls
// ---------------------------------------------------------------------------

const gui = new GUI();

// Debounce helper for terrain regeneration (expensive)
let regenTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleTerrainRegen(): void {
  if (regenTimer) clearTimeout(regenTimer);
  regenTimer = setTimeout(() => {
    planet.regenerateTerrain();
    // Re-generate SDF after terrain changes
    setTimeout(generateTerrainSDF, 200);
  }, 300);
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

// ---- Clouds Card ----
gui.addCard({
  title: 'Clouds',
  icon: '\u2601',
  sliders: [
    { label: 'Coverage', key: 'cloudCoverage', min: 0.0, max: 1.0, step: 0.01, value: 0.55,
      onChange: v => unified.setUniform('uCloudCoverage', v) },
    { label: 'Density', key: 'cloudDensity', min: 0.1, max: 3.0, step: 0.05, value: 0.8,
      onChange: v => unified.setUniform('uCloudDensity', v) },
    { label: 'Speed', key: 'cloudSpeed', min: 0.0, max: 2.0, step: 0.05, value: 0.3,
      onChange: v => unified.setUniform('uCloudSpeed', v) },
    { label: 'Sun Intensity', key: 'cloudSunInt', min: 0, max: 60, step: 0.5, value: 22.0,
      onChange: v => unified.setUniform('uSunIntensity', v) },
  ],
  colors: [
    { label: 'Cloud Color', key: 'cloudColor', r: 1.0, g: 0.98, b: 0.95,
      onChange: (r, g, b) => unified.setUniform('uCloudColor', new THREE.Vector3(r, g, b)) },
    { label: 'Shadow Color', key: 'cloudShadow', r: 0.2, g: 0.22, b: 0.25,
      onChange: (r, g, b) => unified.setUniform('uCloudShadowColor', new THREE.Vector3(r, g, b)) },
  ],
});

// ---- Atmosphere Card ----
gui.addCard({
  title: 'Atmosphere',
  icon: '\uD83C\uDF0D',
  sliders: [
    { label: 'Rayleigh Scale H', key: 'atmoRayleighScale', min: 1, max: 30, step: 0.5, value: 10.0,
      onChange: v => unified.setUniform('uRayleighScale', v) },
    { label: 'Mie Scale H', key: 'atmoMieScale', min: 0.5, max: 15, step: 0.1, value: 3.5,
      onChange: v => unified.setUniform('uMieScale', v) },
    { label: 'Mie Coeff', key: 'atmoMieCoeff', min: 0.0, max: 0.1, step: 0.001, value: 0.015,
      onChange: v => unified.setUniform('uMieCoeff', v) },
    { label: 'Mie G (Asymmetry)', key: 'atmoMieG', min: -0.99, max: 0.99, step: 0.01, value: 0.76,
      onChange: v => unified.setUniform('uMieG', v) },
    { label: 'Rayleigh R', key: 'atmoRayR', min: 0.0, max: 0.1, step: 0.001, value: 0.01,
      onChange: v => {
        const c = unified.getUniform('uRayleighCoeff') as THREE.Vector3;
        unified.setUniform('uRayleighCoeff', new THREE.Vector3(v, c.y, c.z));
      } },
    { label: 'Rayleigh G', key: 'atmoRayG', min: 0.0, max: 0.1, step: 0.001, value: 0.025,
      onChange: v => {
        const c = unified.getUniform('uRayleighCoeff') as THREE.Vector3;
        unified.setUniform('uRayleighCoeff', new THREE.Vector3(c.x, v, c.z));
      } },
    { label: 'Rayleigh B', key: 'atmoRayB', min: 0.0, max: 0.2, step: 0.001, value: 0.06,
      onChange: v => {
        const c = unified.getUniform('uRayleighCoeff') as THREE.Vector3;
        unified.setUniform('uRayleighCoeff', new THREE.Vector3(c.x, c.y, v));
      } },
  ],
});

// ---- Lighting Card ----
gui.addCard({
  title: 'Lighting',
  icon: '\u2600',
  sliders: [
    { label: 'Sun Dir X', key: 'sunX', min: -1, max: 1, step: 0.01, value: sunDir.x,
      onChange: v => { sunDir.x = v; sunDir.normalize(); } },
    { label: 'Sun Dir Y', key: 'sunY', min: -1, max: 1, step: 0.01, value: sunDir.y,
      onChange: v => { sunDir.y = v; sunDir.normalize(); } },
    { label: 'Sun Dir Z', key: 'sunZ', min: -1, max: 1, step: 0.01, value: sunDir.z,
      onChange: v => { sunDir.z = v; sunDir.normalize(); } },
    { label: 'Exposure', key: 'exposure', min: 0.1, max: 3.0, step: 0.05, value: 1.0,
      onChange: v => { renderer.toneMappingExposure = v; } },
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
    `MODE: UNIFIED`,
    `SPD: ${speed} m/s`,
    `ALT: ${alt} m`,
    `POS: ${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)}`,
    `SDF: ${sdfGenerated ? 'READY' : 'PENDING'}`,
  ].join('<br>');
}

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  unified.setSize(window.innerWidth, window.innerHeight);
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

  const dt = Math.min(clock.getDelta(), 0.05);

  // Update flight controls
  controls.update(dt);

  // Adjust clip planes based on altitude
  updateClipPlanes();

  // Force camera matrix update
  camera.updateMatrixWorld(true);

  // Update the unified renderer with current camera, sun, and time
  unified.update(camera, sunDir, clock.elapsedTime);

  // Render — completely replaces renderer.render(scene, camera)
  unified.render(renderer);

  // HUD
  updateHUD();
}

animate();
