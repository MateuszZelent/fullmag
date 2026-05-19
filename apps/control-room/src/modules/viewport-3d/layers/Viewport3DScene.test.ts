import { describe, expect, it } from "vitest";
import { OrthographicCamera, Vector3 } from "three";

import {
  applyViewport3DOrthographicCameraPose,
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
      resolveViewport3DOrthographicZoom(
        {
          center: [0, 0, 0],
          radius: 5e-8,
          size: [1e-7, 1e-7, 1e-8],
        },
        { height: 600, width: 800 },
      ),
    ).toBeCloseTo(600 / (1e-7 * 1.6));
  });

  it("aims the orthographic camera at the active viewport target", () => {
    const camera = new OrthographicCamera(-1, 1, 1, -1, 1e-12, 1e-3);
    const cameraState = {
      position: [2e-6, 1.4e-6, 2e-6] as [number, number, number],
      target: [0, 0, 0] as [number, number, number],
      up: [0, 0, 1] as [number, number, number],
    };

    applyViewport3DOrthographicCameraPose(camera, cameraState, 1e-12, 1e-3);

    const direction = new Vector3();
    camera.getWorldDirection(direction);
    const expected = new Vector3(...cameraState.target)
      .sub(new Vector3(...cameraState.position))
      .normalize();
    expect(direction.angleTo(expected)).toBeLessThan(1e-6);
  });
});
