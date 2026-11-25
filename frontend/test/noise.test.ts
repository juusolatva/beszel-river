import { describe, expect, it } from "vitest";
import { FlowField, createSimplex3 } from "../src/sim/noise";
import { mulberry32 } from "../src/util/math";

describe("createSimplex3", () => {
  it("is deterministic for a seed, differs between seeds, and stays within -1..1", () => {
    const a = createSimplex3(mulberry32(1));
    const b = createSimplex3(mulberry32(1));
    const c = createSimplex3(mulberry32(2));
    const random = mulberry32(3);
    let differs = false;
    let min = 0;
    let max = 0;
    for (let i = 0; i < 5000; i++) {
      // Negative and large coordinates too, so the permutation wraps and every simplex ordering occurs.
      const [x, y, z] = [random() * 600 - 300, random() * 600 - 300, random() * 600 - 300];
      const value = a(x, y, z);
      expect(value).toBe(b(x, y, z));
      differs ||= value !== c(x, y, z);
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    expect(differs).toBe(true);
    expect(min).toBeGreaterThanOrEqual(-1);
    expect(max).toBeLessThanOrEqual(1);
    // Spread out, not flat.
    expect(max - min).toBeGreaterThan(1);
  });

  it("is zero at lattice points and continuous between them", () => {
    const noise = createSimplex3(mulberry32(7));
    expect(noise(0, 0, 0)).toBe(0);
    expect(noise(3, -2, 5)).toBeCloseTo(0, 10);
    const h = 1e-4;
    expect(Math.abs(noise(0.3, 0.4, 0.5) - noise(0.3 + h, 0.4, 0.5))).toBeLessThan(1e-2);
  });
});

describe("FlowField", () => {
  it("samples about -1..1, the same for the same seed and time", () => {
    const a = new FlowField(mulberry32(1));
    const b = new FlowField(mulberry32(1));
    a.update(10, 1.6);
    b.update(10, 1.6);
    const random = mulberry32(2);
    const speeds: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const [x, y] = [random() * 1.6, random()];
      a.sample(x, y);
      b.sample(x, y);
      expect([a.sx, a.sy]).toEqual([b.sx, b.sy]);
      speeds.push(Math.abs(a.sx), Math.abs(a.sy));
    }
    // "About": typical values well inside 1, rare peaks a little above 2.
    speeds.sort((x, y) => x - y);
    expect(speeds[speeds.length / 2]).toBeGreaterThan(0.2);
    expect(speeds[speeds.length / 2]).toBeLessThan(1);
    expect(speeds.at(-1)).toBeLessThan(3);
  });

  it("is close to divergence-free, as a curl field should be", () => {
    const field = new FlowField(mulberry32(5));
    field.update(3, 1);
    const h = 0.02;
    const random = mulberry32(6);
    let divergence = 0;
    let gradient = 0;
    for (let i = 0; i < 200; i++) {
      const [x, y] = [0.1 + 0.8 * random(), 0.1 + 0.8 * random()];
      field.sample(x + h, y);
      const xPlus = field.sx;
      const yAtXPlus = field.sy;
      field.sample(x - h, y);
      const xMinus = field.sx;
      const yAtXMinus = field.sy;
      field.sample(x, y + h);
      const yPlus = field.sy;
      field.sample(x, y - h);
      const yMinus = field.sy;
      divergence += Math.abs(xPlus - xMinus + yPlus - yMinus);
      gradient += Math.abs(xPlus - xMinus) + Math.abs(yAtXPlus - yAtXMinus);
    }
    // Small next to how fast the field itself changes.
    expect(divergence).toBeLessThan(0.25 * gradient);
  });

  it("clamps samples outside the grid to its edge", () => {
    const field = new FlowField(mulberry32(1));
    field.update(0, 1);
    field.sample(-5, -5);
    const corner = [field.sx, field.sy];
    field.sample(0, 0);
    expect([field.sx, field.sy]).toEqual(corner);
    field.sample(50, 50);
    expect(Number.isFinite(field.sx) && Number.isFinite(field.sy)).toBe(true);
  });

  it("resizes the grid when the aspect ratio changes, and scrolls the eddies upwards", () => {
    const field = new FlowField(mulberry32(1));
    field.update(0, 1);
    field.sample(0.5, 0.5);
    const before = [field.sx, field.sy];
    field.update(0, 3);
    field.sample(2.5, 0.5);
    expect(Number.isFinite(field.sx)).toBe(true);
    field.sample(0.5, 0.5);
    expect([field.sx, field.sy]).toEqual(before);

    field.update(5, 3);
    field.sample(0.5, 0.5);
    expect([field.sx, field.sy]).not.toEqual(before);
  });
});

describe("FlowField vectors", () => {
  it("interleaves vx, vy per grid point, matching samples at grid points", () => {
    const field = new FlowField(mulberry32(3));
    field.update(1.2, 1.5);
    const { gridCols: cols, gridRows: rows, gridCell: cell, vectors } = field;
    expect(vectors).toHaveLength(cols * rows * 2);
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
      field.sample(c * cell, r * cell);
      expect(vectors[(r * cols + c) * 2]).toBeCloseTo(field.sx, 6);
      expect(vectors[(r * cols + c) * 2 + 1]).toBeCloseTo(field.sy, 6);
    }
  });

  it("samples bilinearly: the cell centre is the mean of its corners, edges and outside clamp", () => {
    const field = new FlowField(mulberry32(4));
    field.update(0.7, 1.2);
    const { gridCols: cols, gridRows: rows, gridCell: cell, vectors } = field;
    const at = (c: number, r: number, k: number) => vectors[(r * cols + c) * 2 + k];
    const [c, r] = [3, 5];
    field.sample((c + 0.5) * cell, (r + 0.5) * cell);
    for (const [k, value] of [[0, field.sx], [1, field.sy]]) {
      expect(value).toBeCloseTo((at(c, r, k) + at(c + 1, r, k) + at(c, r + 1, k) + at(c + 1, r + 1, k)) / 4, 6);
    }
    // Below/left of the grid the weights collapse onto the first point exactly.
    field.sample(-1, -1);
    expect([field.sx, field.sy]).toEqual([at(0, 0, 0), at(0, 0, 1)]);
    // Halfway along the left edge, between rows r and r + 1.
    field.sample(-0.5, (r + 0.5) * cell);
    expect(field.sx).toBeCloseTo((at(0, r, 0) + at(0, r + 1, 0)) / 2, 6);
    // Beyond the far corner, the sample stays inside the last cell.
    field.sample(100, 100);
    expect(field.sx).toBeCloseTo(at(cols - 2, rows - 2, 0) * 0.001 * 0.001 + at(cols - 1, rows - 2, 0) * 0.999 * 0.001 + at(cols - 2, rows - 1, 0) * 0.001 * 0.999 + at(cols - 1, rows - 1, 0) * 0.999 * 0.999, 4);
  });

  it("keeps the vector storage while the grid size holds, and reallocates when the aspect changes it", () => {
    const field = new FlowField(mulberry32(1));
    field.update(0, 1.2);
    const first = field.vectors;
    const before = Array.from(first);
    field.update(1, 1.2);
    expect(field.vectors).toBe(first);
    expect(Array.from(field.vectors)).not.toEqual(before);
    field.update(2, 2);
    expect(field.vectors).not.toBe(first);
    expect(field.vectors).toHaveLength(field.gridCols * field.gridRows * 2);
    expect(field.vectors.every(Number.isFinite)).toBe(true);
  });
});
