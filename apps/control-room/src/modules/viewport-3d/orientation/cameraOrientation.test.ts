import { describe, expect, it } from "vitest";

import {
  freeCameraTargetForDirection,
  normalizeDirection,
  orbitCameraAroundTarget,
  resolveCameraUpForDirection,
  resolveViewCubeCurrentCameraState,
  rotateCameraAroundCenter,
  snapCameraToDirection,
} from "./cameraOrientation";

describe("camera orientation math", () => {
  it("normalizes snap directions", () => {
    const normalized = normalizeDirection([1, 1, 1]);
    expect(normalized[0]).toBeCloseTo(1 / Math.sqrt(3));
    expect(normalized[1]).toBeCloseTo(1 / Math.sqrt(3));
    expect(normalized[2]).toBeCloseTo(1 / Math.sqrt(3));
    expect(normalizeDirection([0, 0, 0])).toEqual([0, 0, 1]);
  });

  it("snaps around the existing target while preserving orbit distance", () => {
    const next = snapCameraToDirection(
      {
        position: [6, 2, 1],
        target: [2, 2, 1],
        up: [0, 0, 1],
      },
      [0, 1, 0],
    );

    expect(next).toEqual({
      position: [2, 6, 1],
      target: [2, 2, 1],
      up: [0, 0, 1],
    });
  });

  it("snaps free camera view direction without moving the camera position", () => {
    const next = freeCameraTargetForDirection(
      {
        position: [6, 2, 1],
        target: [2, 2, 1],
        up: [0, 0, 1],
      },
      [0, 1, 0],
    );

    expect(next).toEqual({
      position: [6, 2, 1],
      target: [6, -2, 1],
      up: [0, 0, 1],
    });
  });

  it("uses a non-collinear camera up vector for top and bottom free-camera snaps", () => {
    expect(resolveCameraUpForDirection([0, 0, 1])).toEqual([0, 1, 0]);
    expect(resolveCameraUpForDirection([0, 0, -1])).toEqual([0, 1, 0]);
    expect(resolveCameraUpForDirection([1, 0, 0])).toEqual([0, 0, 1]);
  });

  it("rotates the camera around an explicit center on the physical Z axis", () => {
    const next = rotateCameraAroundCenter(
      {
        position: [4, 0, 2],
        target: [1, 1, 0],
        up: [0, 0, 1],
      },
      [0, 0, 0],
      Math.PI / 2,
    );

    expect(next.position[0]).toBeCloseTo(0);
    expect(next.position[1]).toBeCloseTo(4);
    expect(next.position[2]).toBe(2);
    expect(next.target).toEqual([0, 0, 0]);
  });

  it("maps 3DBox ring drags to an object-center orbit instead of target tumbling", () => {
    const next = orbitCameraAroundTarget(
      {
        position: [4, 0, 2],
        target: [2, 2, 0],
        up: [0, 0, 1],
      },
      Math.PI,
      0.5,
    );

    // Delta is Math.PI * 0.5. Rotation is -PI/2.
    // Center is [2, 2, 0].
    // Original pos relative to center: [2, -2, 2]
    // After -PI/2 rotation around Z:
    // x' = 2 + 2*cos(-PI/2) - (-2)*sin(-PI/2) = 2 - 2 = 0
    // y' = 2 + 2*sin(-PI/2) + (-2)*cos(-PI/2) = 2 - 2 = 0
    // final pos = [0, 0, 2]
    expect(next.position[0]).toBeCloseTo(0);
    expect(next.position[1]).toBeCloseTo(0);
    expect(next.position[2]).toBe(2);
    expect(next.target).toEqual([2, 2, 0]);
  });

  it("uses the live viewport camera target for 3DBox snaps when OrbitControls is absent", () => {
    const current = resolveViewCubeCurrentCameraState({
      cameraPosition: [11, 7, 5],
      cameraState: {
        position: [10, 6, 4],
        target: [3, -2, 1],
        up: [0, 0, 1],
      },
      cameraUp: [0, 0, 1],
      controlsTarget: null,
    });

    expect(current).toEqual({
      position: [11, 7, 5],
      target: [3, -2, 1],
      up: [0, 0, 1],
    });
  });

  it("keeps front-bottom 3DBox snaps anchored to the same non-origin target in object mode", () => {
    const current = resolveViewCubeCurrentCameraState({
      cameraPosition: [11, 7, 5],
      cameraState: {
        position: [10, 6, 4],
        target: [3, -2, 1],
        up: [0, 0, 1],
      },
      cameraUp: [0, 0, 1],
      controlsTarget: null,
    });

    const next = snapCameraToDirection(current, [0, 1, -1]);

    expect(next.target).toEqual([3, -2, 1]);
    expect(next.position[0]).toBeCloseTo(3);
    expect(next.position[1]).toBeGreaterThan(-2);
    expect(next.position[2]).toBeLessThan(1);
  });

  it("keeps front-bottom 3DBox snaps in-place in free camera mode while using the same distance", () => {
    const current = resolveViewCubeCurrentCameraState({
      cameraPosition: [11, 7, 5],
      cameraState: {
        position: [10, 6, 4],
        target: [3, -2, 1],
        up: [0, 0, 1],
      },
      cameraUp: [0, 0, 1],
      controlsTarget: null,
    });
    const beforeDistance = Math.hypot(
      current.position[0] - current.target[0],
      current.position[1] - current.target[1],
      current.position[2] - current.target[2],
    );

    const next = freeCameraTargetForDirection(current, [0, 1, -1]);
    const afterDistance = Math.hypot(
      next.position[0] - next.target[0],
      next.position[1] - next.target[1],
      next.position[2] - next.target[2],
    );

    expect(next.position).toEqual([11, 7, 5]);
    expect(afterDistance).toBeCloseTo(beforeDistance);
    expect(next.target[1]).toBeLessThan(7);
    expect(next.target[2]).toBeGreaterThan(5);
  });
});
