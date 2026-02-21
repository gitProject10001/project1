import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { MeshBVHOptions } from 'three-mesh-bvh';

// ---------------------------------------------------------------------------
// Mesh → Signed Distance Field (3D Texture)
//
// Converts an arbitrary THREE.BufferGeometry into a volumetric SDF stored in
// a Float32Array suitable for THREE.Data3DTexture. Uses three-mesh-bvh for
// O(log n) closest-point queries instead of brute-force per-triangle checks.
//
// The SDF can then be sampled in any raymarching shader (atmosphere, clouds,
// terrain, etc.) to obtain the signed distance to the mesh surface at any
// world-space point — enabling unified volumetric collision, density fields,
// and lighting boundaries in a single ray march.
//
// Sign convention:
//   negative = inside the mesh
//   positive = outside the mesh
//   zero     = on the surface
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface MeshSDFConfig {
  /** Voxel grid resolution per axis (e.g. 64 → 64×64×64). */
  resolution: number;
  /** Extra padding around the mesh bounding box, in world units.
   *  Ensures the SDF extends slightly beyond the surface so that
   *  gradient-based normals and soft blending work at the boundary. */
  margin: number;
  /** Optional BVH construction options passed to three-mesh-bvh. */
  bvhOptions?: Partial<MeshBVHOptions>;
}

const DEFAULT_SDF_CONFIG: MeshSDFConfig = {
  resolution: 64,
  margin: 2.0,
};

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface MeshSDFResult {
  /** Raw SDF data: resolution³ floats in X-row-major order (x varies fastest). */
  data: Float32Array;
  /** Grid resolution per axis. */
  resolution: number;
  /** World-space AABB minimum corner (maps to UVW = 0,0,0). */
  boundsMin: THREE.Vector3;
  /** World-space AABB maximum corner (maps to UVW = 1,1,1). */
  boundsMax: THREE.Vector3;
  /** Pre-built Data3DTexture ready to bind as a uniform. */
  texture: THREE.Data3DTexture;
}

// ---------------------------------------------------------------------------
// Core: CPU SDF generation
// ---------------------------------------------------------------------------

/**
 * Generate a signed distance field from an arbitrary BufferGeometry.
 *
 * Uses three-mesh-bvh to accelerate closest-point-on-surface queries to
 * O(log n) per voxel. The sign is determined by comparing the query point
 * to the closest triangle's face normal (dot product test). This works
 * correctly for watertight manifold meshes. For open meshes, the sign
 * heuristic may produce artefacts at boundary edges — consider closing the
 * mesh or using an alternative inside/outside test for non-manifold input.
 *
 * @param geometry  Source geometry (will not be modified).
 * @param config    Resolution, margin, and optional BVH options.
 * @returns         MeshSDFResult containing data, bounds, and a ready texture.
 */
export function generateMeshSDF(
  geometry: THREE.BufferGeometry,
  config?: Partial<MeshSDFConfig>,
): MeshSDFResult {
  const cfg: MeshSDFConfig = { ...DEFAULT_SDF_CONFIG, ...config };
  const res = cfg.resolution;

  // --- 1. Prepare geometry & build BVH ------------------------------------

  // Work on a clone so we don't mutate the caller's geometry
  const geo = geometry.clone();

  // Ensure we have an index (BVH requires indexed geometry)
  if (!geo.index) {
    geo.setIndex(
      [...Array(geo.attributes.position.count).keys()] as unknown as number[],
    );
  }

  // Compute bounding box for the grid extent
  geo.computeBoundingBox();
  const bbox = geo.boundingBox!;

  const boundsMin = bbox.min.clone().subScalar(cfg.margin);
  const boundsMax = bbox.max.clone().addScalar(cfg.margin);
  const boundsSize = new THREE.Vector3().subVectors(boundsMax, boundsMin);

  // Build the BVH accelerator
  const bvh = new MeshBVH(geo, cfg.bvhOptions);

  // --- 2. Allocate the 3D grid -------------------------------------------

  const totalVoxels = res * res * res;
  const data = new Float32Array(totalVoxels);

  // Reusable temporaries (avoid per-voxel allocation)
  const point = new THREE.Vector3();
  const closestPoint = new THREE.Vector3();
  const closestNormal = new THREE.Vector3();

  // Target object for BVH closestPointToPoint
  const target = {
    point: closestPoint,
    distance: 0,
    faceIndex: 0,
  };

  // Pre-fetch position & normal attributes for triangle face normal fallback
  const posAttr = geo.attributes.position as THREE.BufferAttribute;
  const indexArr = geo.index!.array;
  const triA = new THREE.Vector3();
  const triB = new THREE.Vector3();
  const triC = new THREE.Vector3();
  const edgeAB = new THREE.Vector3();
  const edgeAC = new THREE.Vector3();
  const faceNormal = new THREE.Vector3();

  // --- 3. Fill the grid --------------------------------------------------
  //
  // Layout: x varies fastest (column-major in the x axis).
  //   index = x + y * res + z * res * res
  //
  // This matches the memory order expected by THREE.Data3DTexture
  // (width = x, height = y, depth = z).

  for (let z = 0; z < res; z++) {
    const wz = boundsMin.z + (z + 0.5) / res * boundsSize.z;
    for (let y = 0; y < res; y++) {
      const wy = boundsMin.y + (y + 0.5) / res * boundsSize.y;
      for (let x = 0; x < res; x++) {
        const wx = boundsMin.x + (x + 0.5) / res * boundsSize.x;
        point.set(wx, wy, wz);

        // Closest point on the mesh surface (BVH-accelerated)
        bvh.closestPointToPoint(point, target);

        const dist = point.distanceTo(closestPoint);

        // --- Determine sign via face normal dot product ---
        //
        // Reconstruct the face normal of the closest triangle.
        // If the vector from the surface to the query point is
        // aligned with the outward face normal, the point is outside
        // (positive distance). Otherwise it is inside (negative).

        const fi = target.faceIndex;
        const ia = indexArr[fi * 3];
        const ib = indexArr[fi * 3 + 1];
        const ic = indexArr[fi * 3 + 2];

        triA.fromBufferAttribute(posAttr, ia);
        triB.fromBufferAttribute(posAttr, ib);
        triC.fromBufferAttribute(posAttr, ic);

        edgeAB.subVectors(triB, triA);
        edgeAC.subVectors(triC, triA);
        faceNormal.crossVectors(edgeAB, edgeAC); // un-normalised is fine for dot test

        // Direction: query point minus closest surface point
        closestNormal.subVectors(point, closestPoint);

        const sign = closestNormal.dot(faceNormal) >= 0 ? 1.0 : -1.0;

        data[x + y * res + z * res * res] = sign * dist;
      }
    }
  }

  // --- 4. Build 3D texture -----------------------------------------------

  const texture = createSDFTexture(data, res);

  // Clean up the cloned geometry
  geo.dispose();

  return {
    data,
    resolution: res,
    boundsMin,
    boundsMax,
    texture,
  };
}

// ---------------------------------------------------------------------------
// Texture factory
// ---------------------------------------------------------------------------

/**
 * Create a THREE.Data3DTexture from raw SDF data.
 *
 * Filtering is set to LinearFilter so that hardware trilinear interpolation
 * provides smooth distance values between voxel centres. Wrapping is
 * ClampToEdgeWrapping to avoid wrap-around artefacts at the volume boundary.
 */
export function createSDFTexture(
  data: Float32Array,
  resolution: number,
): THREE.Data3DTexture {
  const tex = new THREE.Data3DTexture(data, resolution, resolution, resolution);
  tex.format = THREE.RedFormat;
  tex.type = THREE.FloatType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// GLSL helpers — paste these into your fragment shaders
// ---------------------------------------------------------------------------

/**
 * Returns a GLSL code block that declares the uniforms and helper function
 * `sdMesh(vec3 p)` for sampling the SDF 3D texture. Designed to be
 * concatenated with your existing fragment shader source.
 *
 * Uniforms to set from TypeScript:
 *   uSDFTexture   — the Data3DTexture from MeshSDFResult
 *   uSDFBoundsMin — result.boundsMin  (vec3)
 *   uSDFBoundsMax — result.boundsMax  (vec3)
 *
 * Usage in GLSL:
 *   float d = sdMesh(worldPos);
 *   // d < 0 → inside mesh
 *   // d > 0 → outside mesh
 *   // d ≈ 0 → on the surface
 */
export const SDF_GLSL = /* glsl */ `
// ---- Mesh SDF sampling ------------------------------------------------
uniform sampler3D uSDFTexture;
uniform vec3      uSDFBoundsMin;
uniform vec3      uSDFBoundsMax;

/**
 * Sample the mesh SDF at a world-space position.
 *
 * Transforms the world-space point into the normalised UVW coordinates of
 * the 3D texture (0..1 maps to boundsMin..boundsMax). Points outside the
 * volume are clamped by the texture's ClampToEdge wrapping, which returns
 * the distance at the nearest boundary voxel — a reasonable approximation
 * for nearby points but not accurate far from the volume.
 *
 * @param p  World-space position.
 * @return   Signed distance to the mesh surface (negative = inside).
 */
float sdMesh(vec3 p) {
  vec3 uvw = (p - uSDFBoundsMin) / (uSDFBoundsMax - uSDFBoundsMin);
  return texture(uSDFTexture, uvw).r;
}

/**
 * Compute the SDF gradient (≈ surface normal) via central differences.
 * Useful for lighting calculations on the SDF iso-surface.
 *
 * @param p  World-space position.
 * @return   Approximate outward-pointing normal (unnormalised).
 */
vec3 sdMeshNormal(vec3 p) {
  vec3 texelSize = (uSDFBoundsMax - uSDFBoundsMin) / vec3(textureSize(uSDFTexture, 0));
  vec2 e = vec2(texelSize.x, 0.0);
  return vec3(
    sdMesh(p + e.xyy) - sdMesh(p - e.xyy),
    sdMesh(p + e.yxy) - sdMesh(p - e.yxy),
    sdMesh(p + e.yyx) - sdMesh(p - e.yyx)
  );
}
`;

// ---------------------------------------------------------------------------
// Convenience: generate SDF from a Mesh (applies world transform)
// ---------------------------------------------------------------------------

/**
 * Generate an SDF from a THREE.Mesh, baking its world-space transform into
 * the geometry so the SDF volume is in world coordinates.
 *
 * Call mesh.updateMatrixWorld() before this if the mesh transform may be stale.
 *
 * @param mesh    Source mesh.
 * @param config  Resolution, margin, BVH options.
 * @returns       MeshSDFResult with bounds in world space.
 */
export function generateMeshSDFFromMesh(
  mesh: THREE.Mesh,
  config?: Partial<MeshSDFConfig>,
): MeshSDFResult {
  // Clone geometry and bake the mesh's world transform
  const geo = (mesh.geometry as THREE.BufferGeometry).clone();
  geo.applyMatrix4(mesh.matrixWorld);
  const result = generateMeshSDF(geo, config);
  geo.dispose();
  return result;
}

// ---------------------------------------------------------------------------
// Uniform helper — attaches SDF uniforms to an existing ShaderMaterial
// ---------------------------------------------------------------------------

/**
 * Inject SDF uniforms into an existing ShaderMaterial's uniform dict.
 *
 * @param material  Target ShaderMaterial.
 * @param result    Output from generateMeshSDF / generateMeshSDFFromMesh.
 */
export function applySDFUniforms(
  material: THREE.ShaderMaterial,
  result: MeshSDFResult,
): void {
  material.uniforms['uSDFTexture'] = { value: result.texture };
  material.uniforms['uSDFBoundsMin'] = { value: result.boundsMin };
  material.uniforms['uSDFBoundsMax'] = { value: result.boundsMax };
}
