import { describe, expect, it } from "vitest";

import {
  resolveViewport3DGridSpec,
  resolveViewport3DOrthographicZoom,
} from "./Viewport3DScene";

describe("Viewport3DScene scale helpers", () => {
  it("uses one-micrometer cells when the universe-sized grid can fit them", () => {
    const grid = resolveViewport3DGridSpec({
      center: [0, 0, 0],
      radius: 2e-6,
      size: [4e-6, 2e-6, 5e-7],
    });

    expect(grid.center).toEqual([0, 0, 0]);
    expect(grid.size).toBeLessThanOrEqual(6e-6);
    expect(grid.size / grid.divisions).toBe(1e-6);
  });

  it("downscales physical cells when one micrometer would exceed the universe cap", () => {
    const grid = resolveViewport3DGridSpec({
      center: [2e-7, 0, 0],
      radius: 1e-7,
      size: [2e-7, 1e-7, 5e-9],
    });

    expect(grid.center).toEqual([2e-7, 0, 0]);
    expect(grid.size).toBeGreaterThanOrEqual(2e-7);
    expect(grid.size).toBeLessThanOrEqual(3e-7);
    expect(grid.size / grid.divisions).toBeLessThan(1e-6);
    expect(grid.axesLength).toBeLessThanOrEqual(1.5e-7);
    expect(grid.divisions).toBeGreaterThanOrEqual(4);
  });

  it("does not force four one-micrometer cells for a one-micrometer universe", () => {
    const grid = resolveViewport3DGridSpec({
      center: [0, 0, 0],
      radius: 5e-7,
      size: [1e-6, 6e-7, 1e-7],
    });

    expect(grid.size).toBeGreaterThanOrEqual(1e-6);
    expect(grid.size).toBeLessThanOrEqual(1.5e-6);
  });

  it("caps the grid sheet against the universe side length, not its diagonal", () => {
    const grid = resolveViewport3DGridSpec({
      center: [0, 0, 0],
      radius: Math.sqrt(3) * 5e-7,
      size: [1e-6, 1e-6, 1e-6],
    });

    expect(grid.size).toBeLessThanOrEqual(1.5e-6);
  });

  it("uses micrometer-scale fallback grid before a session publishes bounds", () => {
    expect(resolveViewport3DGridSpec(null)).toMatchObject({
      axesLength: 5e-7,
      center: [0, 0, 0],
      divisions: 10,
      size: 1e-6,
    });
  });

  it("adapts orthographic zoom to micromagnetic dimensions", () => {
    expect(
      resolveViewport3DOrthographicZoom({
        center: [0, 0, 0],
        radius: 5e-8,
        size: [1e-7, 1e-7, 1e-8],
      }),
    ).toBeGreaterThan(1e6);
  });
});
