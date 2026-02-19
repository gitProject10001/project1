import * as THREE from 'three';
import { SimplexNoise3D } from './SimplexNoise';
import { Atmosphere } from './Atmosphere';
import { Ocean } from './Ocean';
import { Clouds } from './Clouds';

// ---------------------------------------------------------------------------
// Configuration (mutable for GUI)
// ---------------------------------------------------------------------------

let PLANET_RADIUS = 1000;
let TERRAIN_HEIGHT = 80;
let OCEAN_LEVEL = 0.32;
let MAX_LOD = 8;
let PATCH_SEGMENTS = 32;
let SPLIT_DISTANCE_FACTOR = 2.0;
let EDGE_OVERLAP = 0.5;

// =========================================================================
//  TERRAIN NOISE PIPELINE
//
//  The height at any point is built from four layered stages:
//
//  1. Continental Base    – Very low-frequency FBM that defines where land
//                          and ocean exist. Think tectonic plates.
//  2. Mountain Ridges     – Ridged Multifractal noise for sharp peaks.
//                          Only applied where the continental mask says
//                          "above sea level", so oceans stay flat.
//  3. Detail / Erosion    – High-frequency small-scale FBM for roughness.
//                          Also masked by the continental signal.
//  4. Power Redistribution – A power curve (Math.pow) flattens lowlands
//                          while keeping peaks tall, mimicking erosion.
//
//  ---- Tuning Guide ----
//
//  Lacunarity (frequency multiplier per octave):
//    2.0  = standard doubling.  Gives self-similar detail at each scale.
//    1.8  = slightly smoother overlap between octaves.
//    2.5+ = "busier", more high-frequency content relative to low.
//
//  Persistence / Gain (amplitude multiplier per octave):
//    0.5  = each octave contributes half the previous. Classic balanced look.
//    0.35 = smoother — fine octaves are faint. Good for rolling hills.
//    0.65 = rougher — fine octaves stay prominent. Craggy terrain.
//
//  The values below were chosen for a Star-Citizen-like planet with
//  clearly defined continents, dramatic mountain ranges, and smooth
//  ocean floors.
// =========================================================================

const noise = new SimplexNoise3D(12345);
// Second noise instance with different seed for uncorrelated mountain layer
const noiseB = new SimplexNoise3D(67890);

// --- Tweakable terrain knobs (mutable for GUI) ---

/** Exported terrain config for GUI access */
export const terrainConfig = {
  continentScale: 0.8,
  continentOctaves: 5,
  continentLacunarity: 2.0,
  continentPersistence: 0.45,
  mountainScale: 2.4,
  mountainOctaves: 6,
  mountainLacunarity: 2.2,
  mountainGain: 0.55,
  mountainSharpness: 2.0,
  mountainStrength: 0.45,
  detailScale: 6.0,
  detailOctaves: 4,
  detailLacunarity: 2.5,
  detailPersistence: 0.4,
  detailStrength: 0.08,
  erosionPower: 1.8,
  get terrainHeight() { return TERRAIN_HEIGHT; },
  set terrainHeight(v: number) { TERRAIN_HEIGHT = v; },
  get oceanLevel() { return OCEAN_LEVEL; },
  set oceanLevel(v: number) { OCEAN_LEVEL = v; },
};

/**
 * Sample final terrain height at a unit-sphere direction.
 * Returns a value in [0, 1] representing normalised elevation.
 */
function sampleHeight(dir: THREE.Vector3): number {
  const tc = terrainConfig;
  const cx = dir.x * tc.continentScale;
  const cy = dir.y * tc.continentScale;
  const cz = dir.z * tc.continentScale;

  // --- Stage 1: Continental base ---
  const continentRaw = noise.fbm(cx, cy, cz, tc.continentOctaves, tc.continentLacunarity, tc.continentPersistence);
  const continent = continentRaw * 0.5 + 0.5;

  // --- Stage 2: Mountain ridges (masked to land only) ---
  const landMask = smoothstep(OCEAN_LEVEL - 0.02, OCEAN_LEVEL + 0.15, continent);

  const mx = dir.x * tc.mountainScale;
  const my = dir.y * tc.mountainScale;
  const mz = dir.z * tc.mountainScale;
  const ridgeRaw = noiseB.ridgedMF(mx, my, mz, tc.mountainOctaves, tc.mountainLacunarity, tc.mountainGain, tc.mountainSharpness);
  const ridge = Math.min(ridgeRaw * 0.5, 1.0);
  const mountains = ridge * landMask * tc.mountainStrength;

  // --- Stage 3: Fine detail (also masked) ---
  const dx = dir.x * tc.detailScale;
  const dy = dir.y * tc.detailScale;
  const dz = dir.z * tc.detailScale;
  const detailRaw = noise.fbm(dx, dy, dz, tc.detailOctaves, tc.detailLacunarity, tc.detailPersistence);
  const detail = detailRaw * landMask * tc.detailStrength;

  // --- Combine ---
  let h = continent + mountains + detail;
  h = Math.max(0, Math.min(h, 1));

  // --- Stage 4: Power redistribution (erosion) ---
  if (h > OCEAN_LEVEL) {
    const aboveSea = (h - OCEAN_LEVEL) / (1.0 - OCEAN_LEVEL);
    const eroded = Math.pow(aboveSea, tc.erosionPower);
    h = OCEAN_LEVEL + eroded * (1.0 - OCEAN_LEVEL);
  }

  return h;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min((x - edge0) / (edge1 - edge0), 1));
  return t * t * (3 - 2 * t);
}

function heightToDisplacement(hNorm: number): number {
  return hNorm * TERRAIN_HEIGHT;
}

function computeAnalyticalNormal(dir: THREE.Vector3): THREE.Vector3 {
  const eps = 0.0005;
  const arbitrary = Math.abs(dir.y) < 0.99
    ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(1, 0, 0);
  const tU = new THREE.Vector3().crossVectors(dir, arbitrary).normalize();
  const tV = new THREE.Vector3().crossVectors(dir, tU).normalize();

  const dirU = new THREE.Vector3().copy(dir).addScaledVector(tU, eps).normalize();
  const dirV = new THREE.Vector3().copy(dir).addScaledVector(tV, eps).normalize();

  const h0 = heightToDisplacement(sampleHeight(dir));
  const hU = heightToDisplacement(sampleHeight(dirU));
  const hV = heightToDisplacement(sampleHeight(dirV));

  const r0 = PLANET_RADIUS + h0;
  const rU = PLANET_RADIUS + hU;
  const rV = PLANET_RADIUS + hV;

  const p0x = dir.x * r0, p0y = dir.y * r0, p0z = dir.z * r0;
  const e1x = dirU.x * rU - p0x, e1y = dirU.y * rU - p0y, e1z = dirU.z * rU - p0z;
  const e2x = dirV.x * rV - p0x, e2y = dirV.y * rV - p0y, e2z = dirV.z * rV - p0z;

  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  return new THREE.Vector3(nx / len, ny / len, nz / len);
}

// =========================================================================
//  BIOME COLOURING
//
//  Uses smooth linear interpolation (lerp) between biome colours based on
//  height and slope. No more hard if/else boundaries.
// =========================================================================

const C_DEEP_OCEAN  = new THREE.Color(0.005, 0.02, 0.08);
const C_OCEAN       = new THREE.Color(0.02, 0.08, 0.20);
const C_SHALLOW     = new THREE.Color(0.04, 0.14, 0.30);
const C_BEACH       = new THREE.Color(0.76, 0.70, 0.50);
const C_GRASS_LOW   = new THREE.Color(0.08, 0.22, 0.04);
const C_GRASS_HIGH  = new THREE.Color(0.14, 0.28, 0.06);
const C_ROCK        = new THREE.Color(0.32, 0.28, 0.24);
const C_ROCK_STEEP  = new THREE.Color(0.25, 0.22, 0.20);
const C_HIGHLAND    = new THREE.Color(0.36, 0.32, 0.26);
const C_SNOW_EDGE   = new THREE.Color(0.70, 0.72, 0.75);
const C_SNOW        = new THREE.Color(0.92, 0.93, 0.96);

function lerpColor(a: THREE.Color, b: THREE.Color, t: number): THREE.Color {
  const s = Math.max(0, Math.min(t, 1));
  return new THREE.Color(
    a.r + (b.r - a.r) * s,
    a.g + (b.g - a.g) * s,
    a.b + (b.b - a.b) * s,
  );
}

function terrainColor(hNorm: number, slope: number): THREE.Color {
  // Slope-based rock blend: steep surfaces get rock colour
  const slopeRock = smoothstep(0.3, 0.7, slope);

  if (hNorm < OCEAN_LEVEL - 0.10) {
    // Deep ocean
    return lerpColor(C_DEEP_OCEAN, C_OCEAN, smoothstep(0.0, OCEAN_LEVEL - 0.10, hNorm));
  }
  if (hNorm < OCEAN_LEVEL - 0.01) {
    // Mid ocean → shallow
    return lerpColor(C_OCEAN, C_SHALLOW, smoothstep(OCEAN_LEVEL - 0.10, OCEAN_LEVEL - 0.01, hNorm));
  }
  if (hNorm < OCEAN_LEVEL + 0.015) {
    // Beach / shoreline
    const beachT = smoothstep(OCEAN_LEVEL - 0.01, OCEAN_LEVEL + 0.015, hNorm);
    return lerpColor(C_SHALLOW, C_BEACH, beachT);
  }
  if (hNorm < OCEAN_LEVEL + 0.06) {
    // Beach → grass transition
    const t = smoothstep(OCEAN_LEVEL + 0.015, OCEAN_LEVEL + 0.06, hNorm);
    const base = lerpColor(C_BEACH, C_GRASS_LOW, t);
    return lerpColor(base, C_ROCK_STEEP, slopeRock);
  }
  if (hNorm < 0.55) {
    // Lowland grasslands
    const t = smoothstep(OCEAN_LEVEL + 0.06, 0.55, hNorm);
    const base = lerpColor(C_GRASS_LOW, C_GRASS_HIGH, t);
    return lerpColor(base, C_ROCK, slopeRock);
  }
  if (hNorm < 0.70) {
    // Highland transition
    const t = smoothstep(0.55, 0.70, hNorm);
    const base = lerpColor(C_GRASS_HIGH, C_HIGHLAND, t);
    return lerpColor(base, C_ROCK, slopeRock);
  }
  if (hNorm < 0.82) {
    // Highland → snow transition
    const t = smoothstep(0.70, 0.82, hNorm);
    const base = lerpColor(C_HIGHLAND, C_SNOW_EDGE, t);
    return lerpColor(base, C_ROCK, slopeRock * 0.6);
  }
  // Snow caps
  const t = smoothstep(0.82, 0.92, hNorm);
  return lerpColor(C_SNOW_EDGE, C_SNOW, t);
}

// ---------------------------------------------------------------------------
// QuadTree
// ---------------------------------------------------------------------------

interface QuadBounds {
  face: number;
  uMin: number;
  vMin: number;
  size: number;
}

const FACE_AXES: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [
  [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0)],
  [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-1, 0, 0)],
  [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)],
  [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, -1, 0)],
  [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)],
  [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1)],
];

function faceUVToSphere(face: number, u: number, v: number): THREE.Vector3 {
  const [right, up, forward] = FACE_AXES[face];
  return new THREE.Vector3()
    .addScaledVector(forward, 1)
    .addScaledVector(right, u * 2 - 1)
    .addScaledVector(up, v * 2 - 1)
    .normalize();
}

class QuadNode {
  bounds: QuadBounds;
  depth: number;
  children: QuadNode[] | null = null;
  mesh: THREE.Mesh | null = null;
  center: THREE.Vector3;

  constructor(bounds: QuadBounds, depth: number) {
    this.bounds = bounds;
    this.depth = depth;
    const cu = bounds.uMin + bounds.size * 0.5;
    const cv = bounds.vMin + bounds.size * 0.5;
    this.center = faceUVToSphere(bounds.face, cu, cv).multiplyScalar(PLANET_RADIUS);
  }

  shouldSplit(camPos: THREE.Vector3): boolean {
    if (this.depth >= MAX_LOD) return false;
    const dist = camPos.distanceTo(this.center);
    const patchArc = this.bounds.size * PLANET_RADIUS * Math.PI;
    return dist < patchArc * SPLIT_DISTANCE_FACTOR;
  }

  split(): void {
    if (this.children) return;
    const { face, uMin, vMin, size } = this.bounds;
    const half = size * 0.5;
    this.children = [
      new QuadNode({ face, uMin, vMin, size: half }, this.depth + 1),
      new QuadNode({ face, uMin: uMin + half, vMin, size: half }, this.depth + 1),
      new QuadNode({ face, uMin, vMin: vMin + half, size: half }, this.depth + 1),
      new QuadNode({ face, uMin: uMin + half, vMin: vMin + half, size: half }, this.depth + 1),
    ];
  }

  dispose(): void {
    if (this.children) {
      for (const child of this.children) child.dispose();
      this.children = null;
    }
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.removeFromParent();
      this.mesh = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Patch geometry — no skirts, uses edge overlap instead
// ---------------------------------------------------------------------------

function buildPatchGeometry(bounds: QuadBounds): THREE.BufferGeometry {
  const seg = PATCH_SEGMENTS;
  const vertCount = (seg + 1) * (seg + 1);

  const positions = new Float32Array(vertCount * 3);
  const normsArr = new Float32Array(vertCount * 3);
  const colors = new Float32Array(vertCount * 3);
  const indices: number[] = [];

  const { face, uMin, vMin, size } = bounds;

  // Extend UV range by EDGE_OVERLAP cells on each side to overlap neighbours
  const cellSize = size / seg;
  const margin = cellSize * EDGE_OVERLAP;
  const extUMin = uMin - margin;
  const extVMin = vMin - margin;
  const extSize = size + margin * 2;

  const hNorms = new Float32Array(vertCount);

  for (let iy = 0; iy <= seg; iy++) {
    for (let ix = 0; ix <= seg; ix++) {
      const idx = iy * (seg + 1) + ix;
      const u = extUMin + (ix / seg) * extSize;
      const v = extVMin + (iy / seg) * extSize;
      const dir = faceUVToSphere(face, u, v);
      const hN = sampleHeight(dir);  // already [0,1]
      hNorms[idx] = hN;

      const r = PLANET_RADIUS + heightToDisplacement(hN);
      positions[idx * 3]     = dir.x * r;
      positions[idx * 3 + 1] = dir.y * r;
      positions[idx * 3 + 2] = dir.z * r;

      const n = computeAnalyticalNormal(dir);
      normsArr[idx * 3]     = n.x;
      normsArr[idx * 3 + 1] = n.y;
      normsArr[idx * 3 + 2] = n.z;

      let slope = 0;
      if (ix > 0 && ix < seg && iy > 0 && iy < seg) {
        const hl = hNorms[iy * (seg + 1) + (ix - 1)];
        const hr = hNorms[iy * (seg + 1) + (ix + 1)];
        const hd = hNorms[(iy - 1) * (seg + 1) + ix];
        const hu = hNorms[(iy + 1) * (seg + 1) + ix];
        slope = Math.abs(hr - hl) + Math.abs(hu - hd);
      }
      const col = terrainColor(hN, slope);
      colors[idx * 3]     = col.r;
      colors[idx * 3 + 1] = col.g;
      colors[idx * 3 + 2] = col.b;
    }
  }

  // Determine correct winding by testing the first triangle.
  // Build triangle (0,0)-(1,0)-(0,1), compute its geometric normal,
  // and check if it points outward (same dir as the vertex position = away from origin).
  const a0 = 0, b0 = 1, c0 = seg + 1;
  const ax = positions[a0 * 3], ay = positions[a0 * 3 + 1], az = positions[a0 * 3 + 2];
  const e1x = positions[c0 * 3] - ax, e1y = positions[c0 * 3 + 1] - ay, e1z = positions[c0 * 3 + 2] - az;
  const e2x = positions[b0 * 3] - ax, e2y = positions[b0 * 3 + 1] - ay, e2z = positions[b0 * 3 + 2] - az;
  const cx = e1y * e2z - e1z * e2y;
  const cy = e1z * e2x - e1x * e2z;
  const cz = e1x * e2y - e1y * e2x;
  // Dot with position (which points outward from planet center)
  const outward = cx * ax + cy * ay + cz * az;
  // If dot > 0, winding a,c,b is outward-facing. If < 0, we need to flip.
  const flip = outward < 0;

  for (let iy = 0; iy < seg; iy++) {
    for (let ix = 0; ix < seg; ix++) {
      const a = iy * (seg + 1) + ix;
      const b = a + 1;
      const c = a + (seg + 1);
      const d = c + 1;
      if (flip) {
        indices.push(a, b, c, b, d, c);
      } else {
        indices.push(a, c, b, b, c, d);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normsArr, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

// ---------------------------------------------------------------------------
// Terrain heightmap cubemap for atmosphere
// ---------------------------------------------------------------------------

/**
 * Build a cubemap where each texel stores the terrain height [0,1] for that direction.
 * Uses the standard OpenGL cubemap face directions so textureCube() in the shader
 * returns the correct value for any world-space direction.
 */
function buildHeightCubemap(resolution: number): THREE.CubeTexture {
  const size = resolution;

  // Standard OpenGL cubemap: for each face, define the major axis direction
  // and how (s,t) in [0,1]^2 map to the other two axes.
  // Face order: +X, -X, +Y, -Y, +Z, -Z
  const faceDirs: { major: number[]; sAxis: number[]; tAxis: number[] }[] = [
    { major: [ 1, 0, 0], sAxis: [ 0, 0,-1], tAxis: [ 0,-1, 0] }, // +X
    { major: [-1, 0, 0], sAxis: [ 0, 0, 1], tAxis: [ 0,-1, 0] }, // -X
    { major: [ 0, 1, 0], sAxis: [ 1, 0, 0], tAxis: [ 0, 0, 1] }, // +Y
    { major: [ 0,-1, 0], sAxis: [ 1, 0, 0], tAxis: [ 0, 0,-1] }, // -Y
    { major: [ 0, 0, 1], sAxis: [ 1, 0, 0], tAxis: [ 0,-1, 0] }, // +Z
    { major: [ 0, 0,-1], sAxis: [-1, 0, 0], tAxis: [ 0,-1, 0] }, // -Z
  ];

  const dir = new THREE.Vector3();
  const faces: ImageData[] = [];

  for (let face = 0; face < 6; face++) {
    const { major, sAxis, tAxis } = faceDirs[face];
    const data = new Uint8ClampedArray(size * size * 4);

    for (let y = 0; y < size; y++) {
      const tv = (2.0 * (y + 0.5) / size - 1.0); // -1 to 1
      for (let x = 0; x < size; x++) {
        const su = (2.0 * (x + 0.5) / size - 1.0); // -1 to 1

        dir.set(
          major[0] + sAxis[0] * su + tAxis[0] * tv,
          major[1] + sAxis[1] * su + tAxis[1] * tv,
          major[2] + sAxis[2] * su + tAxis[2] * tv,
        ).normalize();

        const h = sampleHeight(dir);
        const byte = Math.max(0, Math.min(255, Math.round(h * 255)));
        const idx = (y * size + x) * 4;
        data[idx] = byte;
        data[idx + 1] = byte;
        data[idx + 2] = byte;
        data[idx + 3] = 255;
      }
    }
    faces.push(new ImageData(data, size, size));
  }

  // CubeTexture expects 6 image sources — use canvases drawn from ImageData
  const canvases = faces.map(img => {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    c.getContext('2d')!.putImageData(img, 0, 0);
    return c;
  });

  const cubeTex = new THREE.CubeTexture(canvases);
  cubeTex.needsUpdate = true;
  cubeTex.minFilter = THREE.LinearFilter;
  cubeTex.magFilter = THREE.LinearFilter;
  return cubeTex;
}

// ---------------------------------------------------------------------------
// Ocean — now uses volumetric shader from Ocean.ts
// ---------------------------------------------------------------------------

const OCEAN_RADIUS = PLANET_RADIUS + OCEAN_LEVEL * TERRAIN_HEIGHT;

// ---------------------------------------------------------------------------
// Planet
// ---------------------------------------------------------------------------

const patchMaterial = new THREE.MeshPhongMaterial({
  vertexColors: true,
  flatShading: false,
  shininess: 10,
  side: THREE.FrontSide,
});

export class Planet {
  group: THREE.Group;
  private roots: QuadNode[] = [];
  readonly atmosphere: Atmosphere;
  readonly ocean: Ocean;
  readonly clouds: Clouds;
  private leafMeshes = new Set<THREE.Mesh>();
  private frustum = new THREE.Frustum();
  private projScreenMatrix = new THREE.Matrix4();
  private cullSphere = new THREE.Sphere();

  readonly radius = PLANET_RADIUS;

  constructor() {
    this.group = new THREE.Group();
    for (let face = 0; face < 6; face++) {
      this.roots.push(new QuadNode({ face, uMin: 0, vMin: 0, size: 1 }, 0));
    }
    this.ocean = new Ocean({
      planetRadius: PLANET_RADIUS,
      oceanRadius: OCEAN_RADIUS,
    });
    this.group.add(this.ocean.mesh);

    // Build terrain heightmap cubemap for atmosphere ground-following
    const heightCube = buildHeightCubemap(256);
    this.atmosphere = new Atmosphere({
      planetRadius: PLANET_RADIUS,
      terrainHeight: TERRAIN_HEIGHT,
      heightCubemap: heightCube,
    });
    this.group.add(this.atmosphere.mesh);

    this.clouds = new Clouds({
      planetRadius: PLANET_RADIUS,
      terrainHeight: TERRAIN_HEIGHT,
    });
    this.group.add(this.clouds.mesh);
  }

  /** Force full terrain rebuild (call after changing terrainConfig) */
  regenerateTerrain(): void {
    // Dispose all existing patches
    for (const root of this.roots) root.dispose();
    this.roots.length = 0;
    for (const mesh of this.leafMeshes) {
      mesh.geometry.dispose();
      mesh.removeFromParent();
    }
    this.leafMeshes.clear();

    // Rebuild quad tree roots
    for (let face = 0; face < 6; face++) {
      this.roots.push(new QuadNode({ face, uMin: 0, vMin: 0, size: 1 }, 0));
    }

    // Rebuild heightmap cubemap for atmosphere
    const heightCube = buildHeightCubemap(256);
    this.atmosphere.material.uniforms['uHeightMap'].value = heightCube;
    this.atmosphere.material.uniforms['uTerrainHeight'].value = TERRAIN_HEIGHT;

    // Update ocean radius
    const newOceanRadius = PLANET_RADIUS + OCEAN_LEVEL * TERRAIN_HEIGHT;
    this.ocean.material.uniforms['uOceanRadius'].value = newOceanRadius;
  }

  update(camera: THREE.Camera): void {
    const camPos = camera.position;

    this.projScreenMatrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix);

    const newLeaves = new Set<THREE.Mesh>();
    for (const root of this.roots) {
      this.updateNode(root, camPos, newLeaves);
    }
    for (const mesh of this.leafMeshes) {
      if (!newLeaves.has(mesh)) {
        mesh.geometry.dispose();
        mesh.removeFromParent();
      }
    }
    this.leafMeshes = newLeaves;
  }

  private updateNode(node: QuadNode, camPos: THREE.Vector3, leaves: Set<THREE.Mesh>): void {
    if (node.shouldSplit(camPos)) {
      if (!node.children) node.split();
      if (node.mesh) {
        node.mesh.geometry.dispose();
        node.mesh.removeFromParent();
        node.mesh = null;
      }
      for (const child of node.children!) {
        this.updateNode(child, camPos, leaves);
      }
    } else {
      if (node.children) {
        for (const child of node.children) child.dispose();
        node.children = null;
      }

      // Always ensure the mesh exists so there are never holes
      if (!node.mesh) {
        const geo = buildPatchGeometry(node.bounds);
        node.mesh = new THREE.Mesh(geo, patchMaterial);
        node.mesh.renderOrder = 1;
        this.group.add(node.mesh);
      }

      // Frustum cull — hide but never destroy (prevents holes)
      // Use generous radius: account for terrain height + overlap margin
      const patchRadius = node.bounds.size * (PLANET_RADIUS + TERRAIN_HEIGHT) * 2.0 + TERRAIN_HEIGHT;
      this.cullSphere.set(node.center, patchRadius);
      node.mesh.visible = this.frustum.intersectsSphere(this.cullSphere);

      leaves.add(node.mesh);
    }
  }

  getHeightAt(worldPos: THREE.Vector3): number {
    const dir = worldPos.clone().normalize();
    const hN = sampleHeight(dir);  // already [0,1]
    return PLANET_RADIUS + heightToDisplacement(Math.max(hN, OCEAN_LEVEL));
  }

  dispose(): void {
    for (const root of this.roots) root.dispose();
    this.atmosphere.dispose();
    this.ocean.dispose();
    this.clouds.dispose();
  }
}
