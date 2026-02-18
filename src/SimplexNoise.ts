/**
 * Simplex Noise implementation for terrain generation.
 * Based on Stefan Gustavson's simplex noise algorithm.
 */

const F3 = 1.0 / 3.0;
const G3 = 1.0 / 6.0;

// Gradient vectors for 3D
const grad3: [number, number, number][] = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

function buildPermTable(seed: number): { perm: Uint8Array; permMod12: Uint8Array } {
  const perm = new Uint8Array(512);
  const permMod12 = new Uint8Array(512);
  const p = new Uint8Array(256);

  // Seed-based shuffle
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    seed = (seed * 16807 + 0) % 2147483647;
    const j = seed % (i + 1);
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }

  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
    permMod12[i] = perm[i] % 12;
  }
  return { perm, permMod12 };
}

export class SimplexNoise3D {
  private perm: Uint8Array;
  private permMod12: Uint8Array;

  constructor(seed = 42) {
    const tables = buildPermTable(seed);
    this.perm = tables.perm;
    this.permMod12 = tables.permMod12;
  }

  noise(x: number, y: number, z: number): number {
    const { perm, permMod12 } = this;

    const s = (x + y + z) * F3;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const k = Math.floor(z + s);
    const t = (i + j + k) * G3;

    const X0 = i - t;
    const Y0 = j - t;
    const Z0 = k - t;
    const x0 = x - X0;
    const y0 = y - Y0;
    const z0 = z - Z0;

    let i1: number, j1: number, k1: number;
    let i2: number, j2: number, k2: number;

    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }

    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2.0 * G3;
    const y2 = y0 - j2 + 2.0 * G3;
    const z2 = z0 - k2 + 2.0 * G3;
    const x3 = x0 - 1.0 + 3.0 * G3;
    const y3 = y0 - 1.0 + 3.0 * G3;
    const z3 = z0 - 1.0 + 3.0 * G3;

    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;

    let n0 = 0, n1 = 0, n2 = 0, n3 = 0;

    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      t0 *= t0;
      const gi0 = permMod12[ii + perm[jj + perm[kk]]];
      n0 = t0 * t0 * (grad3[gi0][0] * x0 + grad3[gi0][1] * y0 + grad3[gi0][2] * z0);
    }

    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      t1 *= t1;
      const gi1 = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]];
      n1 = t1 * t1 * (grad3[gi1][0] * x1 + grad3[gi1][1] * y1 + grad3[gi1][2] * z1);
    }

    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      t2 *= t2;
      const gi2 = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]];
      n2 = t2 * t2 * (grad3[gi2][0] * x2 + grad3[gi2][1] * y2 + grad3[gi2][2] * z2);
    }

    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      t3 *= t3;
      const gi3 = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]];
      n3 = t3 * t3 * (grad3[gi3][0] * x3 + grad3[gi3][1] * y3 + grad3[gi3][2] * z3);
    }

    // Return value in range [-1, 1]
    return 32.0 * (n0 + n1 + n2 + n3);
  }

  /**
   * Fractal Brownian Motion — layered noise for terrain.
   *
   * @param lacunarity  Frequency multiplier per octave. Higher = more fine detail.
   *                    2.0 is standard. 2.5+ gives "busier" terrain.
   * @param gain        Amplitude multiplier per octave (also called "persistence").
   *                    0.5 is standard (each octave is half the amplitude).
   *                    Lower = smoother, higher = rougher.
   */
  fbm(x: number, y: number, z: number, octaves: number, lacunarity = 2.0, gain = 0.5): number {
    let value = 0;
    let amplitude = 1.0;
    let frequency = 1.0;
    let maxAmp = 0;

    for (let i = 0; i < octaves; i++) {
      value += amplitude * this.noise(x * frequency, y * frequency, z * frequency);
      maxAmp += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }

    return value / maxAmp;
  }

  /**
   * Ridged Multifractal Noise — produces sharp ridges and peaks.
   *
   * Each octave takes abs(noise), inverts it (1 - abs), then squares for
   * sharper creases. The "weight" feedback loop makes valleys between
   * ridges receive less high-frequency detail, concentrating detail on peaks.
   *
   * @param lacunarity  Frequency multiplier per octave (2.0 standard).
   * @param gain        Controls how fast amplitude drops. 0.5 = standard.
   *                    Higher (0.6-0.7) = more aggressive ridges at all scales.
   * @param sharpness   Exponent applied to each ridge signal. 2.0 = square
   *                    (standard), higher = sharper/thinner ridges.
   * @param offset      Shifts the ridge signal. 1.0 is standard. Lower values
   *                    make ridges thinner and more separated.
   */
  ridgedMF(
    x: number, y: number, z: number,
    octaves: number,
    lacunarity = 2.0,
    gain = 0.5,
    sharpness = 2.0,
    offset = 1.0,
  ): number {
    let value = 0;
    let amplitude = 1.0;
    let frequency = 1.0;
    let weight = 1.0;

    for (let i = 0; i < octaves; i++) {
      let signal = this.noise(x * frequency, y * frequency, z * frequency);
      // Fold into ridges: invert the absolute value
      signal = offset - Math.abs(signal);
      // Sharpen
      signal = Math.pow(signal, sharpness);
      // Weight feedback: previous octave's signal attenuates this one
      signal *= weight;
      weight = Math.min(Math.max(signal * gain, 0), 1);

      value += signal * amplitude;
      frequency *= lacunarity;
      amplitude *= gain;
    }

    return value;
  }
}
