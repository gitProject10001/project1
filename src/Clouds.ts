import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Volumetric Raymarched Cloud Layer
//
// Renders volumetric clouds within a thin spherical shell between
// innerRadius and outerRadius. The fragment shader:
//   - Raymarches through the cloud shell sampling pseudo-3D noise
//   - Reads the scene depth buffer (logarithmic) to occlude behind terrain
//   - Applies Beer's Law absorption for optical thickness
//   - Uses Henyey-Greenstein phase function for silver-lining effects
//   - Jitters ray start with interleaved gradient noise to reduce banding
//   - Animates cloud drift over time via uTime
//
// Rendered on a BackSide sphere (same technique as Atmosphere.ts) so the
// shader fires for every pixel covered by the cloud shell.
// ---------------------------------------------------------------------------

const CLOUD_VERTEX = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vWorldDir;
varying vec2 vUv;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vWorldDir = wp.xyz - cameraPosition;
  vec4 clipPos = projectionMatrix * viewMatrix * wp;
  gl_Position = clipPos;

  // Screen-space UV for sampling the depth texture
  vUv = clipPos.xy / clipPos.w * 0.5 + 0.5;
}
`;

const CLOUD_FRAGMENT = /* glsl */ `
// ---- Uniforms ----
uniform vec3  uSunDir;          // Normalised direction TO the sun
uniform float uInnerRadius;     // Bottom of cloud shell (planet surface + offset)
uniform float uOuterRadius;     // Top of cloud shell
uniform float uTime;            // Elapsed time for cloud drift
uniform float uCoverage;        // Cloud coverage 0..1 (higher = more clouds)
uniform float uDensityMult;     // Overall density multiplier
uniform float uCloudSpeed;      // Drift speed multiplier
uniform float uSunIntensity;    // Sun brightness
uniform vec3  uCloudColor;      // Base albedo of clouds
uniform vec3  uCloudShadowColor;// Shadow / ambient color

// Depth buffer integration
uniform sampler2D tDepth;       // Scene depth texture (logarithmic depth)
uniform float uCameraNear;
uniform float uCameraFar;

varying vec3 vWorldPos;
varying vec3 vWorldDir;
varying vec2 vUv;

// ---- Constants ----
#define PI 3.14159265359
#define NUM_STEPS 48
#define NUM_LIGHT_STEPS 6

// =====================================================================
//  Interleaved Gradient Noise (Jimenez 2014)
//  Produces a repeating low-discrepancy pattern that reduces banding
//  far better than white noise, without needing a blue-noise texture.
// =====================================================================
float interleavedGradientNoise(vec2 fragCoord) {
  vec3 magic = vec3(0.06711056, 0.00583715, 52.9829189);
  return fract(magic.z * fract(dot(fragCoord, magic.xy)));
}

// =====================================================================
//  Pseudo-3D Noise
//
//  Hash-based value noise with smooth interpolation. Three octaves of
//  this give convincing fluffy cloud shapes without a 3D texture.
// =====================================================================
float hash3(vec3 p) {
  p = fract(p * vec3(443.8975, 397.2973, 491.1871));
  p += dot(p, p.yxz + 19.19);
  return fract((p.x + p.y) * p.z);
}

float valueNoise3D(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  // Quintic Hermite for C2 continuity (smoother than cubic)
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

  return mix(mix(mix(hash3(i + vec3(0,0,0)), hash3(i + vec3(1,0,0)), u.x),
                 mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), u.x), u.y),
             mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), u.x),
                 mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), u.x), u.y), u.z);
}

// FBM with 4 octaves — the primary cloud shape function
float cloudFBM(vec3 p) {
  float value  = 0.0;
  float amp    = 0.5;
  float freq   = 1.0;
  float total  = 0.0;
  for (int i = 0; i < 4; i++) {
    value += amp * valueNoise3D(p * freq);
    total += amp;
    amp   *= 0.5;
    freq  *= 2.3;   // slightly irregular lacunarity for more natural look
  }
  return value / total;
}

// =====================================================================
//  Cloud density at a world-space position
//
//  Maps the sample point onto the spherical shell, computes a
//  height-within-shell gradient, and combines it with FBM noise
//  to produce the final density. Coverage uniform controls the
//  threshold that separates cloud from clear sky.
// =====================================================================
float sampleCloudDensity(vec3 pos) {
  float r = length(pos);
  float shellThickness = uOuterRadius - uInnerRadius;

  // Normalised height within the cloud shell [0..1]
  float heightFrac = clamp((r - uInnerRadius) / shellThickness, 0.0, 1.0);

  // Vertical density profile: round-bottom / anvil-top shape
  // Dense in the lower-middle, thins out at top and bottom
  float heightGrad = smoothstep(0.0, 0.15, heightFrac)
                   * smoothstep(1.0, 0.65, heightFrac);

  // Sample point in noise space — use direction on sphere + height
  // Drift clouds over time along a consistent wind direction
  vec3 windOffset = vec3(uTime * uCloudSpeed * 0.7, 0.0, uTime * uCloudSpeed);
  vec3 noisePos = pos * 0.008 + windOffset;  // scale to get nice cloud-sized features

  // Primary shape: low-frequency FBM
  float shape = cloudFBM(noisePos);

  // Detail erosion: higher-frequency noise subtracts from edges
  float detail = cloudFBM(noisePos * 3.0 + vec3(37.0));

  // Combine: shape defines base, detail carves edges
  float density = shape - detail * 0.35;

  // Apply coverage: shift the threshold
  density = smoothstep(1.0 - uCoverage, 1.0, density);

  // Apply vertical profile and global multiplier
  density *= heightGrad * uDensityMult;

  return max(density, 0.0);
}

// =====================================================================
//  Ray-Sphere Intersection
//
//  Returns (tNear, tFar). If tNear > tFar, no intersection occurred.
//  Works for rays originating inside or outside the sphere.
//  Origin is in world space (planet at origin).
// =====================================================================
vec2 raySphereIntersect(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float disc = b * b - c;
  if (disc < 0.0) return vec2(1e20, -1e20);
  float sq = sqrt(disc);
  return vec2(-b - sq, -b + sq);
}

// =====================================================================
//  Henyey-Greenstein Phase Function
//
//  Describes the angular distribution of scattered light. Positive g
//  produces strong forward scattering (silver lining when looking at sun).
// =====================================================================
float henyeyGreenstein(float cosTheta, float g) {
  float g2 = g * g;
  float num = 1.0 - g2;
  float denom = pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5);
  return (1.0 / (4.0 * PI)) * num / denom;
}

// =====================================================================
//  Reconstruct linear depth from logarithmic depth buffer
//  (identical to Atmosphere.ts)
// =====================================================================
float linearizeLogDepth(float d) {
  if (d >= 1.0) return uCameraFar;
  float logFarP1 = log2(uCameraFar + 1.0);
  return pow(2.0, d * logFarP1) - 1.0;
}

// =====================================================================
//  Light march: estimate optical thickness between a cloud sample
//  and the sun to compute how much light reaches that sample.
//  Uses Beer's Law: transmittance = exp(-tau).
// =====================================================================
float lightMarch(vec3 pos) {
  // March toward the sun, exiting through the outer cloud shell
  vec2 tSun = raySphereIntersect(pos, uSunDir, uOuterRadius);
  float sunPathLen = max(tSun.y, 0.0);
  float sunStep = sunPathLen / float(NUM_LIGHT_STEPS);

  float tau = 0.0;
  bool inShadow = false;
  for (int j = 0; j < NUM_LIGHT_STEPS; j++) {
    float t = (float(j) + 0.5) * sunStep;
    vec3 lightSample = pos + uSunDir * t;

    // Check if light ray goes through the planet
    if (length(lightSample) < uInnerRadius) {
      inShadow = true;
      break;
    }

    tau += sampleCloudDensity(lightSample) * sunStep;
  }

  if (inShadow) return 0.0; // No direct sunlight

  // Beer's Law: transmittance through the cloud toward the sun
  // Use a gentler absorption coefficient so sun-facing clouds stay bright
  return exp(-tau * 0.6);
}

// =====================================================================
//  Main Fragment Shader
// =====================================================================
void main() {
  vec3 rayOrigin = cameraPosition;
  vec3 rayDir = normalize(vWorldDir);

  // ---- Read scene depth to find opaque terrain ----
  float rawDepth = texture2D(tDepth, vUv).r;
  float sceneLinearDepth = linearizeLogDepth(rawDepth);
  float cosAngle = dot(rayDir, vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));
  float tSceneDepth = sceneLinearDepth / abs(cosAngle);

  // ---- Intersect cloud shell ----
  vec2 tOuter = raySphereIntersect(rayOrigin, rayDir, uOuterRadius);
  vec2 tInner = raySphereIntersect(rayOrigin, rayDir, uInnerRadius);

  if (tOuter.x > tOuter.y) discard; // Ray misses cloud shell entirely

  // Determine ray segment through the shell.
  // If camera is below inner radius, the ray enters at tInner.y (exit of inner sphere)
  // and exits at tOuter.y. If camera is between inner and outer, it starts at 0.
  // If camera is above outer, it enters at tOuter.x and exits at tOuter.y (but we
  // must skip the interior planet if the ray passes through the inner sphere).

  float camR = length(rayOrigin);
  float tStart, tEnd;

  if (camR < uInnerRadius) {
    // Camera below cloud layer: march from exiting inner sphere to exiting outer
    tStart = tInner.y;
    tEnd   = tOuter.y;
  } else if (camR > uOuterRadius) {
    // Camera above cloud layer
    tStart = tOuter.x;
    // If ray also hits the inner sphere, stop at its entry (hollow shell)
    if (tInner.x < tInner.y && tInner.x > 0.0) {
      tEnd = tInner.x;
    } else {
      tEnd = tOuter.y;
    }
  } else {
    // Camera inside the cloud shell
    tStart = 0.0;
    // If ray hits inner sphere, stop there; otherwise march to outer exit
    if (tInner.x < tInner.y && tInner.x > 0.0) {
      tEnd = tInner.x;
    } else {
      tEnd = tOuter.y;
    }
  }

  tStart = max(tStart, 0.0);

  // ---- Terrain depth occlusion: stop the ray at the terrain surface ----
  bool terrainHit = rawDepth < 1.0 && tSceneDepth < tEnd;
  if (terrainHit) {
    tEnd = tSceneDepth;
  }

  if (tStart >= tEnd) discard;

  // ---- Jitter ray start to reduce banding ----
  float jitter = interleavedGradientNoise(gl_FragCoord.xy);
  float segLen = tEnd - tStart;
  float stepSize = segLen / float(NUM_STEPS);
  tStart += jitter * stepSize;

  // ---- Density scaling for long ray paths ----
  // When viewing from orbit, the ray can traverse the entire cloud shell
  // diameter. Without compensation, density accumulates into an opaque
  // grey blanket. We scale down per-sample density when the total path
  // length greatly exceeds the shell thickness so individual cloud
  // features remain visible from any angle.
  float shellThickness = uOuterRadius - uInnerRadius;
  float pathRatio = segLen / shellThickness;
  // For a grazing ray (pathRatio ~ 1) densityScale = 1.0
  // For a full-diameter ray (pathRatio ~ 40+) densityScale ~ 0.15
  float densityScale = shellThickness / max(segLen, shellThickness);

  // ---- Phase function for view-sun angle ----
  float cosTheta = dot(rayDir, uSunDir);
  // Dual-lobe: blend isotropic + strong forward scatter for silver lining
  float phase = mix(henyeyGreenstein(cosTheta, 0.0),   // isotropic lobe
                    henyeyGreenstein(cosTheta, 0.75),   // forward scatter lobe
                    0.7);

  // ---- Raymarching loop ----
  vec3 luminance = vec3(0.0);
  float transmittance = 1.0;

  for (int i = 0; i < NUM_STEPS; i++) {
    if (transmittance < 0.01) break;  // Early exit when opaque

    float t = tStart + float(i) * stepSize;
    if (t > tEnd) break;

    vec3 samplePos = rayOrigin + rayDir * t;
    float density = sampleCloudDensity(samplePos) * densityScale;

    if (density > 0.001) {
      // Beer's Law: transmittance loss through this step
      float sampleTau = density * stepSize;
      float sampleTransmittance = exp(-sampleTau);

      // Light reaching this sample from the sun
      float sunTransmittance = lightMarch(samplePos);

      // Beer-powder: blend between Beer's law and powder effect based
      // on how aligned the view is with the sun. This prevents the
      // powder term from darkening the sun-facing side of clouds.
      float powder = 1.0 - exp(-density * stepSize * 2.0);
      // On the sun-facing side (cosTheta > 0), use mostly Beer's law
      // On the shadow side, blend in the powder for silver-lining
      float beerPowder = mix(powder, 1.0, 0.5 + 0.5 * cosTheta);

      // In-scattered light at this sample
      vec3 sunLight = uCloudColor * uSunIntensity * sunTransmittance * phase * beerPowder;

      // Ambient/sky fill — modulated by how much this part of the
      // planet faces the sun. On the night side, ambient drops to near zero.
      vec3 sampleDir = normalize(samplePos);
      float dayFactor = smoothstep(-0.1, 0.3, dot(sampleDir, uSunDir));
      vec3 ambient = uCloudShadowColor * (dayFactor * 0.5 + 0.05);

      vec3 lightColor = sunLight + ambient;

      // Energy-conserving integration (Sebastien Hillaire 2016)
      vec3 integScatter = lightColor * (1.0 - sampleTransmittance);
      luminance += transmittance * integScatter;
      transmittance *= sampleTransmittance;
    }
  }

  float alpha = 1.0 - transmittance;

  // Tone-map to prevent blow-out near sun
  luminance = 1.0 - exp(-luminance);

  gl_FragColor = vec4(luminance, alpha);
}
`;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CloudConfig {
  planetRadius: number;
  /** Height above planet surface where cloud shell begins (world units) */
  cloudBaseOffset: number;
  /** Thickness of the cloud shell (world units) */
  cloudThickness: number;
  /** Cloud coverage 0..1 */
  coverage: number;
  /** Overall density multiplier */
  densityMultiplier: number;
  /** Cloud drift speed */
  cloudSpeed: number;
  /** Sun intensity */
  sunIntensity: number;
  /** Base cloud albedo */
  cloudColor: THREE.Vector3;
  /** Shadow / ambient tint */
  cloudShadowColor: THREE.Vector3;
  /** Sphere geometry segments */
  segments: number;
  /** Max terrain height (to place cloud base above highest peaks) */
  terrainHeight: number;
}

const DEFAULT_CLOUD_CONFIG: CloudConfig = {
  planetRadius: 1000,
  cloudBaseOffset: 45,        // clouds start 45 units above surface (above most terrain)
  cloudThickness: 25,         // 25 units thick shell
  coverage: 0.55,             // moderate coverage
  densityMultiplier: 0.8,
  cloudSpeed: 0.3,
  sunIntensity: 22.0,
  cloudColor: new THREE.Vector3(1.0, 0.98, 0.95),
  cloudShadowColor: new THREE.Vector3(0.2, 0.22, 0.25), // More neutral grey/blue for ambient light
  segments: 80,
  terrainHeight: 80,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class Clouds {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  private innerRadius: number;
  private outerRadius: number;

  constructor(config?: Partial<CloudConfig>) {
    const cfg = { ...DEFAULT_CLOUD_CONFIG, ...config };

    this.innerRadius = cfg.planetRadius + cfg.cloudBaseOffset;
    this.outerRadius = this.innerRadius + cfg.cloudThickness;

    this.material = new THREE.ShaderMaterial({
      vertexShader: CLOUD_VERTEX,
      fragmentShader: CLOUD_FRAGMENT,
      uniforms: {
        uSunDir:          { value: new THREE.Vector3(1, 0.5, 0.8).normalize() },
        uInnerRadius:     { value: this.innerRadius },
        uOuterRadius:     { value: this.outerRadius },
        uTime:            { value: 0.0 },
        uCoverage:        { value: cfg.coverage },
        uDensityMult:     { value: cfg.densityMultiplier },
        uCloudSpeed:      { value: cfg.cloudSpeed },
        uSunIntensity:    { value: cfg.sunIntensity },
        uCloudColor:      { value: cfg.cloudColor },
        uCloudShadowColor:{ value: cfg.cloudShadowColor },
        // Depth buffer integration
        tDepth:           { value: null },
        uCameraNear:      { value: 0.5 },
        uCameraFar:       { value: 100000 },
      },
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,  // All occlusion handled analytically via tDepth
    });

    // Use a sphere larger than the atmosphere so the BackSide faces always
    // cover the full planet disc from any camera distance. The shader
    // analytically intersects the actual cloud shell radii — the geometry
    // sphere is just a screen-coverage proxy. Slightly larger than the
    // atmosphere sphere to avoid z-fighting between the two BackSide passes.
    const geoRadius = (cfg.planetRadius + cfg.terrainHeight) * 1.3;
    const geo = new THREE.SphereGeometry(geoRadius, cfg.segments, cfg.segments);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.renderOrder = 3; // After atmosphere (2), after ocean (0), after terrain (1)
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

  /** Call each frame to update sun direction */
  setSunDirection(dir: THREE.Vector3): void {
    (this.material.uniforms['uSunDir'].value as THREE.Vector3).copy(dir);
  }

  /** Pass the depth texture from the opaque pass */
  setDepthTexture(depthTex: THREE.DepthTexture): void {
    this.material.uniforms['tDepth'].value = depthTex;
  }

  /** Update camera near/far each frame so logarithmic depth reconstruction is correct */
  updateCameraUniforms(camera: THREE.Camera): void {
    if (camera instanceof THREE.PerspectiveCamera) {
      this.material.uniforms['uCameraNear'].value = camera.near;
      this.material.uniforms['uCameraFar'].value = camera.far;
    }
  }

  /** Advance time for cloud drift animation */
  updateTime(elapsed: number): void {
    this.material.uniforms['uTime'].value = elapsed;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
