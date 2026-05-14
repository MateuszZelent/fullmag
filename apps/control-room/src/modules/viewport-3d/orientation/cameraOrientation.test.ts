import { describe, expect, it } from "vitest";

import {
  normalizeDirection,
  orbitCameraAroundTarget,
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
      },
      [0, 1, 0],
    );

    expect(next).toEqual({
      position: [2, 6, 1],
      target: [2, 2, 1],
    });
  });

  it("rotates the camera around an explicit center on the physical Z axis", () => {
    const next = rotateCameraAroundCenter(
      {
        position: [4, 0, 2],
        target: [1, 1, 0],
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
});
