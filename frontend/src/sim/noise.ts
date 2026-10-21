import { LOOK } from "../config";
import type { Random } from "../util/math";

const F3 = 1 / 3;
const G3 = 1 / 6;
// prettier-ignore
const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

/** 3D simplex noise in about -1..1 (after Stefan Gustavson's public-domain reference implementation). */
export function createSimplex3(random: Random): (x: number, y: number, z: number) => number {
  const p = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  const perm = new Uint8Array(512);
  const permMod12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
    permMod12[i] = perm[i] % 12;
  }

  const corner = (gi: number, x: number, y: number, z: number): number => {
    let t = 0.6 - x * x - y * y - z * z;
    if (t <= 0) return 0;
    const g = permMod12[gi] * 3;
    t *= t;
    return t * t * (GRAD3[g] * x + GRAD3[g + 1] * y + GRAD3[g + 2] * z);
  };

  return (xin, yin, zin) => {
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);

    // Offsets of the second and third simplex corners.
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) [i1, j1, k1, i2, j2, k2] = [1, 0, 0, 1, 1, 0];
      else if (x0 >= z0) [i1, j1, k1, i2, j2, k2] = [1, 0, 0, 1, 0, 1];
      else [i1, j1, k1, i2, j2, k2] = [0, 0, 1, 1, 0, 1];
    } else {
      if (y0 < z0) [i1, j1, k1, i2, j2, k2] = [0, 0, 1, 0, 1, 1];
      else if (x0 < z0) [i1, j1, k1, i2, j2, k2] = [0, 1, 0, 0, 1, 1];
      else [i1, j1, k1, i2, j2, k2] = [0, 1, 0, 1, 1, 0];
    }

    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;
    const hash = (a: number, b: number, c: number): number => ii + a + perm[jj + b + perm[kk + c]];

    return (
      32 *
      (corner(hash(0, 0, 0), x0, y0, z0) +
        corner(hash(i1, j1, k1), x0 - i1 + G3, y0 - j1 + G3, z0 - k1 + G3) +
        corner(hash(i2, j2, k2), x0 - i2 + 2 * G3, y0 - j2 + 2 * G3, z0 - k2 + 2 * G3) +
        corner(hash(1, 1, 1), x0 - 1 + 3 * G3, y0 - 1 + 3 * G3, z0 - 1 + 3 * G3))
    );
  };
}

/**
 * Divergence-free velocity field: the curl of a scrolling noise potential, evaluated on a coarse grid
 * once per frame and sampled bilinearly per particle. Values are roughly -1..1.
 */
export class FlowField {
  /** Result of the last `sample` call. */
  sx = 0;
  sy = 0;
  private cols = 0;
  private readonly rows = LOOK.field.rows;
  private readonly cell = 1 / (LOOK.field.rows - 1);
  private psi = new Float32Array(0);
  private vx = new Float32Array(0);
  private vy = new Float32Array(0);
  private readonly noise: (x: number, y: number, z: number) => number;

  constructor(random: Random) {
    this.noise = createSimplex3(random);
  }

  update(t: number, aspect: number): void {
    const cols = Math.ceil(aspect / this.cell) + 2;
    if (cols !== this.cols) {
      this.cols = cols;
      this.psi = new Float32Array(cols * this.rows);
      this.vx = new Float32Array(cols * this.rows);
      this.vy = new Float32Array(cols * this.rows);
    }
    const { frequency, scroll, evolve } = LOOK.field;
    const { rows, cell, psi, vx, vy } = this;

    for (let r = 0; r < rows; r++) {
      // Sampling at y - t * scroll moves the eddies upwards with the river.
      const ny = (r * cell - t * scroll) * frequency;
      for (let c = 0; c < cols; c++) {
        psi[r * cols + c] = this.noise(c * cell * frequency, ny, t * evolve);
      }
    }

    // Curl (dψ/dy, -dψ/dx) by central differences, one-sided at the edges; scaled to about -1..1.
    const scale = 1 / (2.5 * frequency);
    for (let r = 0; r < rows; r++) {
      const r0 = Math.max(r - 1, 0);
      const r1 = Math.min(r + 1, rows - 1);
      for (let c = 0; c < cols; c++) {
        const c0 = Math.max(c - 1, 0);
        const c1 = Math.min(c + 1, cols - 1);
        const i = r * cols + c;
        vx[i] = ((psi[r1 * cols + c] - psi[r0 * cols + c]) / ((r1 - r0) * cell)) * scale;
        vy[i] = -((psi[r * cols + c1] - psi[r * cols + c0]) / ((c1 - c0) * cell)) * scale;
      }
    }
  }

  /** Bilinear sample at world position (x, y); writes `sx`, `sy`. */
  sample(x: number, y: number): void {
    const { cols, rows, cell, vx, vy } = this;
    const fx = Math.min(Math.max(x / cell, 0), cols - 1.001);
    const fy = Math.min(Math.max(y / cell, 0), rows - 1.001);
    const c = Math.floor(fx);
    const r = Math.floor(fy);
    const tx = fx - c;
    const ty = fy - r;
    const i00 = r * cols + c;
    const i01 = i00 + 1;
    const i10 = i00 + cols;
    const i11 = i10 + 1;
    const w00 = (1 - tx) * (1 - ty);
    const w01 = tx * (1 - ty);
    const w10 = (1 - tx) * ty;
    const w11 = tx * ty;
    this.sx = vx[i00] * w00 + vx[i01] * w01 + vx[i10] * w10 + vx[i11] * w11;
    this.sy = vy[i00] * w00 + vy[i01] * w01 + vy[i10] * w10 + vy[i11] * w11;
  }
}
