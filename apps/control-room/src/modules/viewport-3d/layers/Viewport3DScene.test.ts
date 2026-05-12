import { describe, expect, it } from "vitest";

import {
  resolveViewport3DGridSpec,
  resolveViewport3DOrthographicZoom,
} from "./Viewport3DScene";

describe("Viewport3DScene scale helpers", () => {
  it("sizes grid and axes from nanoscale domain bounds", () => {
    const grid = resolveViewport3DGridSpec({
      center: [2e-7, 0, 0],
      radius: 1e-7,
      size: [2e-7, 1e-7, 5e-9],
    });

    expect(grid.center).toEqual([2e-7, 0, 0]);
    expect(grid.size).toBeGreaterThanOrEqual(2e-7);
    expect(grid.size).toBeLessThan(1e-6);
    expect(grid.axesLength).toBeLessThan(1e-6);
    expect(grid.divisions).toBeGreaterThanOrEqual(4);
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
