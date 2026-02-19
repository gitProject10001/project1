import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Volumetric Ocean Surface Shader
//
// Renders the ocean as a sphere mesh with a custom shader that:
//   - Reads the scene depth buffer to find terrain behind/below the water
//   - Computes water depth (distance between ocean surface and terrain)
//   - Applies absorption (Beer's law) — deeper water absorbs more red/green
//   - Adds subsurface scattering approximation near the sun
//   - Soft shoreline blending where terrain meets ocean
//   - Fresnel-based reflectance (more reflection at grazing angles)
//   - Specular sun highlight (Blinn-Phong)
// ---------------------------------------------------------------------------

const OCEAN_VERTEX = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vScreenUV;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);

  vec4 clipPos = projectionMatrix * viewMatrix * wp;
  gl_Position = clipPos;

  // Screen UV for depth texture sampling
  vScreenUV = clipPos.xy / clipPos.w * 0.5 + 0.5;
}
`;

const OCEAN_FRAGMENT = /* glsl */ `
uniform vec3  uSunDir;
uniform float uSunIntensity;
uniform float uPlanetRadius;
uniform float uOceanRadius;

// Depth buffer
uniform sampler2D tDepth;
uniform float uCameraNear;
uniform float uCameraFar;

// Ocean optical properties
uniform vec3  uAbsorption;      // Absorption coefficients per channel (higher = more absorbed)
uniform vec3  uScatterColor;    // Subsurface scatter tint
uniform float uMaxDepthFade;    // Max depth for absorption calculation
uniform vec3  uShallowColor;    // Color at zero depth (shoreline)
uniform vec3  uDeepColor;       // Color at full depth

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vScreenUV;

#define PI 3.14159265359

// Reconstruct linear depth from logarithmic depth buffer (matches Atmosphere)
float linearizeLogDepth(float d) {
  if (d >= 1.0) return uCameraFar;
  float logFarP1 = log2(uCameraFar + 1.0);
  return pow(2.0, d * logFarP1) - 1.0;
}

void main() {
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  vec3 normal = normalize(vWorldNormal);

  // ---- Read scene depth (terrain) ----
  float rawDepth = texture2D(tDepth, vScreenUV).r;
  float terrainLinearDepth = linearizeLogDepth(rawDepth);

  // Compute this fragment's view-space depth
  vec4 clipPos = projectionMatrix * viewMatrix * vec4(vWorldPos, 1.0);
  float oceanViewDepth = clipPos.w; // perspective W = view-space Z

  // Water column depth: how deep is the terrain below this ocean surface point
  // Convert both to ray distances for comparison
  vec3 rayDir = normalize(vWorldPos - cameraPosition);
  float cosAngle = dot(rayDir, vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));
  float terrainRayDist = terrainLinearDepth / abs(cosAngle);
  float oceanRayDist = oceanViewDepth / abs(cosAngle);

  // Water depth in world units (how far terrain is below the ocean surface)
  float waterDepth = max(terrainRayDist - oceanRayDist, 0.0);

  // If terrain is in front of water (shouldn't render), discard
  bool terrainInFront = rawDepth < 1.0 && terrainRayDist < oceanRayDist - 0.1;
  if (terrainInFront) discard;

  // Normalise depth for effects (0 = shoreline, 1 = deep)
  float depthFactor = clamp(waterDepth / uMaxDepthFade, 0.0, 1.0);

  // ---- Absorption (Beer's Law) ----
  // Deeper water absorbs more light, especially reds and greens
  vec3 absorption = exp(-uAbsorption * waterDepth);

  // ---- Water color: blend shallow to deep ----
  vec3 waterColor = mix(uShallowColor, uDeepColor, depthFactor);

  // Apply absorption to water color
  waterColor *= absorption;

  // ---- Subsurface scattering approximation ----
  // Light penetrating through the water from the sun side
  float sss = pow(max(dot(viewDir, -uSunDir), 0.0), 4.0) * 0.3;
  vec3 subsurface = uScatterColor * sss * (1.0 - depthFactor * 0.5);

  // ---- Fresnel (Schlick) ----
  float NdotV = max(dot(normal, viewDir), 0.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);

  // ---- Specular (Blinn-Phong sun highlight) ----
  vec3 halfVec = normalize(viewDir + uSunDir);
  float NdotH = max(dot(normal, halfVec), 0.0);
  float specular = pow(NdotH, 256.0) * uSunIntensity * 0.5;

  // ---- Diffuse lighting ----
  float NdotL = max(dot(normal, uSunDir), 0.0);
  float diffuse = NdotL * 0.6 + 0.4; // wrap lighting

  // ---- Soft shoreline edge ----
  // Alpha fades to 0 at the terrain intersection (soft blend)
  float shoreAlpha = smoothstep(0.0, 2.0, waterDepth);

  // ---- Combine ----
  vec3 color = waterColor * diffuse + subsurface;

  // Fresnel drives reflection vs refraction balance
  // At grazing angles, the water is more reflective (brighter)
  color = mix(color, vec3(0.4, 0.6, 0.8) * diffuse, fresnel * 0.5);

  // Add specular highlight
  color += vec3(1.0, 0.95, 0.8) * specular;

  // Tone-map
  color = 1.0 - exp(-color);

  // Alpha: combine optical depth-based opacity with shoreline softness
  float baseAlpha = 1.0 - exp(-depthFactor * 4.0);
  float alpha = mix(0.3, 0.92, baseAlpha) * shoreAlpha;

  gl_FragColor = vec4(color, alpha);
}
`;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface OceanConfig {
  planetRadius: number;
  oceanRadius: number;
  segments: number;
  sunIntensity: number;
  /** Absorption coefficients (r, g, b) — higher values absorb more */
  absorption: THREE.Vector3;
  /** Subsurface scatter tint */
  scatterColor: THREE.Vector3;
  /** Maximum depth for full absorption (world units) */
  maxDepthFade: number;
  /** Color at zero depth */
  shallowColor: THREE.Vector3;
  /** Color at maximum depth */
  deepColor: THREE.Vector3;
}

const DEFAULT_OCEAN_CONFIG: OceanConfig = {
  planetRadius: 1000,
  oceanRadius: 1025.6,  // PLANET_RADIUS + OCEAN_LEVEL * TERRAIN_HEIGHT
  segments: 128,
  sunIntensity: 22.0,
  absorption: new THREE.Vector3(0.4, 0.08, 0.02),   // red absorbs most, blue least
  scatterColor: new THREE.Vector3(0.0, 0.4, 0.3),    // teal scatter
  maxDepthFade: 40.0,                                  // full absorption over 40 world units
  shallowColor: new THREE.Vector3(0.04, 0.16, 0.28),  // bright teal
  deepColor: new THREE.Vector3(0.005, 0.02, 0.08),    // dark blue
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class Ocean {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;

  constructor(config?: Partial<OceanConfig>) {
    const cfg = { ...DEFAULT_OCEAN_CONFIG, ...config };

    this.material = new THREE.ShaderMaterial({
      vertexShader: OCEAN_VERTEX,
      fragmentShader: OCEAN_FRAGMENT,
      uniforms: {
        uSunDir:       { value: new THREE.Vector3(1, 0.5, 0.8).normalize() },
        uSunIntensity: { value: cfg.sunIntensity },
        uPlanetRadius: { value: cfg.planetRadius },
        uOceanRadius:  { value: cfg.oceanRadius },
        // Depth buffer
        tDepth:        { value: null },
        uCameraNear:   { value: 0.5 },
        uCameraFar:    { value: 100000 },
        // Optical properties
        uAbsorption:   { value: cfg.absorption },
        uScatterColor: { value: cfg.scatterColor },
        uMaxDepthFade: { value: cfg.maxDepthFade },
        uShallowColor: { value: cfg.shallowColor },
        uDeepColor:    { value: cfg.deepColor },
      },
      transparent: true,
      side: THREE.FrontSide,
      depthWrite: true,
      depthTest: true,
    });

    const geo = new THREE.SphereGeometry(cfg.oceanRadius, cfg.segments, cfg.segments);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.renderOrder = 0;
  }

  /** Set a uniform value by name */
  setUniform(name: string, value: number | THREE.Vector3): void {
    const u = this.material.uniforms[name];
    if (!u) return;
    if (value instanceof THREE.Vector3) {
      (u.value as THREE.Vector3).copy(value);
    } else {
      u.value = value;
    }
  }

  /** Get current uniform value */
  getUniform(name: string): unknown {
    return this.material.uniforms[name]?.value;
  }

  setSunDirection(dir: THREE.Vector3): void {
    (this.material.uniforms['uSunDir'].value as THREE.Vector3).copy(dir);
  }

  setDepthTexture(depthTex: THREE.DepthTexture): void {
    this.material.uniforms['tDepth'].value = depthTex;
  }

  updateCameraUniforms(camera: THREE.Camera): void {
    if (camera instanceof THREE.PerspectiveCamera) {
      this.material.uniforms['uCameraNear'].value = camera.near;
      this.material.uniforms['uCameraFar'].value = camera.far;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
