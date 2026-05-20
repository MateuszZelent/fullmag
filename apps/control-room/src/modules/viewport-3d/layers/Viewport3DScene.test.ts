import { describe, expect, it } from "vitest";
import { OrthographicCamera, PerspectiveCamera, Vector3 } from "three";

import {
  applyViewport3DPerspectiveCameraPose,
  applyViewport3DOrthographicCameraPose,
  resolveViewport3DGridSpec,
  resolveViewport3DProjectionCameraClip,
  resolveViewport3DOrthographicCameraFrame,
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

  it("uses a viewport-sized orthographic frustum with micromagnetic zoom", () => {
    const frame = resolveViewport3DOrthographicCameraFrame(
      {
        center: [0, 0, 0],
        radius: 5e-8,
        size: [1e-7, 1e-7, 1e-8],
      },
      { height: 600, width: 800 },
    );

    expect(frame.top - frame.bottom).toBe(600);
    expect(frame.right - frame.left).toBe(800);
    expect(frame.zoom).toBeCloseTo(600 / (1e-7 * 1.6));
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

  it("aims the restored perspective camera at the active viewport target", () => {
    const camera = new PerspectiveCamera(42, 4 / 3, 1e-12, 1e-3);
    const cameraState = {
      position: [2e-6, 1.4e-6, 2e-6] as [number, number, number],
      target: [1e-7, -2e-7, 0] as [number, number, number],
      up: [0, 0, 1] as [number, number, number],
    };

    applyViewport3DPerspectiveCameraPose(camera, cameraState, 1e-12, 1e-3, 42);

    const direction = new Vector3();
    camera.getWorldDirection(direction);
    const expected = new Vector3(...cameraState.target)
      .sub(new Vector3(...cameraState.position))
      .normalize();
    expect(direction.angleTo(expected)).toBeLessThan(1e-6);
    expect(camera.near).toBe(1e-12);
    expect(camera.far).toBe(1e-3);
    expect(camera.fov).toBe(42);
  });

  it("keeps projection clipping beyond the current orbit distance", () => {
    const clip = resolveViewport3DProjectionCameraClip(
      {
        center: [0, 0, 0],
        radius: 5e-8,
        size: [1e-7, 1e-7, 1e-8],
      },
      {
        position: [1.2e-3, 0, 0] as [number, number, number],
        target: [0, 0, 0] as [number, number, number],
        up: [0, 0, 1] as [number, number, number],
      },
    );

    expect(clip.far).toBeGreaterThan(1.2e-3);
  });

  it("keeps bounds visible when the orthographic target is off center", () => {
    const bounds = {
      center: [0, 0, 0] as [number, number, number],
      radius: Math.sqrt(3) * 5e-8,
      size: [1e-7, 1e-7, 1e-7] as [number, number, number],
    };
    const cameraState = {
      position: [6e-7, 1.4e-6, 2e-6] as [number, number, number],
      target: [5e-7, 0, 0] as [number, number, number],
      up: [0, 0, 1] as [number, number, number],
    };
    const frame = resolveViewport3DOrthographicCameraFrame(
      bounds,
      { height: 600, width: 800 },
      cameraState,
    );
    const camera = new OrthographicCamera(
      frame.left,
      frame.right,
      frame.top,
      frame.bottom,
      1e-12,
      1e-3,
    );
    camera.zoom = frame.zoom;
    applyViewport3DOrthographicCameraPose(camera, cameraState, 1e-12, 1e-3);

    for (const x of [-5e-8, 5e-8]) {
      for (const y of [-5e-8, 5e-8]) {
        for (const z of [-5e-8, 5e-8]) {
          const projected = new Vector3(x, y, z).project(camera);
          expect(Math.abs(projected.x)).toBeLessThanOrEqual(1);
          expect(Math.abs(projected.y)).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
