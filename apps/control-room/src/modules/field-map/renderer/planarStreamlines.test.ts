import { describe, expect, it } from "vitest";

import { tracePlanarStreamlines, type PlanarStreamlines } from "./planarStreamlines";

const BOUNDS = [0, 64e-9, 0, 64e-9] as const;
const SIZE = 32;

function field(fn: (u: number, v: number) => [number, number, number]): Float64Array {
  const values = new Float64Array(SIZE * SIZE * 3);
  const pitch = (BOUNDS[1] - BOUNDS[0]) / SIZE;
  for (let row = 0; row < SIZE; row += 1) {
    for (let column = 0; column < SIZE; column += 1) {
      const [x, y, z] = fn(BOUNDS[0] + (column + 0.5) * pitch, BOUNDS[2] + (row + 0.5) * pitch);
      values.set([x, y, z], (row * SIZE + column) * 3);
    }
  }
  return values;
}

function eachLine(result: PlanarStreamlines, visit: (points: Float64Array) => void) {
  for (let line = 0; line < result.lineCount; line += 1) {
    visit(result.points.subarray(result.offsets[line]! * 2, result.offsets[line + 1]! * 2));
  }
}

describe("tracePlanarStreamlines", () => {
  it("draws straight parallel lines along a uniform in-plane field", () => {
    const angle = 0.3;
    const result = tracePlanarStreamlines({
      bounds: BOUNDS,
      gridHeight: SIZE,
      gridWidth: SIZE,
      separation: 8e-9,
      vectors: field(() => [Math.cos(angle), Math.sin(angle), 0.2]),
    });
    expect(result.lineCount).toBeGreaterThan(3);
    expect(result.truncated).toBe(false);
    const pitch = (BOUNDS[1] - BOUNDS[0]) / SIZE;
    eachLine(result, (points) => {
      const u0 = points[0]!;
      const v0 = points[1]!;
      for (let index = 2; index < points.length; index += 2) {
        // Distance of every point from the line through the first point.
        const deviation = Math.abs(
          (points[index]! - u0) * Math.sin(angle) - (points[index + 1]! - v0) * Math.cos(angle),
        );
        expect(deviation).toBeLessThan(1e-9 * pitch);
      }
    });
  });

  it("keeps vortex lines inside the disk and never enters an empty cell", () => {
    const centre = 32e-9;
    const radius = 28e-9;
    const vectors = field((u, v) => {
      const r = Math.hypot(u - centre, v - centre);
      return [-(v - centre) / (r || 1), (u - centre) / (r || 1), 0];
    });
    const pitch = (BOUNDS[1] - BOUNDS[0]) / SIZE;
    const mask = new Uint8Array(SIZE * SIZE);
    for (let row = 0; row < SIZE; row += 1) {
      for (let column = 0; column < SIZE; column += 1) {
        const r = Math.hypot((column + 0.5) * pitch - centre, (row + 0.5) * pitch - centre);
        mask[row * SIZE + column] = r <= radius ? 0 : 1;
      }
    }
    const result = tracePlanarStreamlines({
      bounds: BOUNDS,
      gridHeight: SIZE,
      gridWidth: SIZE,
      mask,
      separation: 6e-9,
      vectors,
    });
    expect(result.lineCount).toBeGreaterThan(2);
    eachLine(result, (points) => {
      for (let index = 0; index < points.length; index += 2) {
        const column = Math.floor((points[index]! - BOUNDS[0]) / pitch);
        const row = Math.floor((points[index + 1]! - BOUNDS[2]) / pitch);
        expect(mask[row * SIZE + column]).toBe(0);
        expect(Math.hypot(points[index]! - centre, points[index + 1]! - centre)).toBeLessThanOrEqual(radius);
      }
    });
  });

  it("is deterministic and reports budget truncation", () => {
    const input = {
      bounds: BOUNDS,
      budget: 400,
      gridHeight: SIZE,
      gridWidth: SIZE,
      vectors: field((u, v) => [Math.sin(v * 1e8), Math.cos(u * 1e8), 0]),
    };
    const first = tracePlanarStreamlines(input);
    const second = tracePlanarStreamlines(input);
    expect(Array.from(second.points)).toEqual(Array.from(first.points));
    expect(Array.from(second.offsets)).toEqual(Array.from(first.offsets));
    const limited = tracePlanarStreamlines({ ...input, maxLines: 1 });
    expect(limited.lineCount).toBe(1);
    expect(limited.truncated).toBe(true);
  });

  it("returns no lines for a purely out-of-plane field", () => {
    const result = tracePlanarStreamlines({
      bounds: BOUNDS,
      gridHeight: SIZE,
      gridWidth: SIZE,
      vectors: field(() => [0, 0, 1]),
    });
    expect(result.lineCount).toBe(0);
  });
});
