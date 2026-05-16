import { describe, expect, it } from "vitest";

import {
  buildViewport3DCameraPoseFromOrientation,
  resolveViewport3DCameraOrientation,
  toCameraTuple,
} from "./viewport3dCameraModel";

function expectTupleClose(
  actual: readonly number[],
  expected: readonly number[],
): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => {
    expect(actual[index]).toBeCloseTo(value, 10);
  });
}

describe("viewport3dCameraModel", () => {
  it("derives yaw, pitch, roll, and distance from camera vectors", () => {
    const orientation = resolveViewport3DCameraOrientation({
      position: [0, 2, 0],
      target: [0, 0, 0],
      up: [0, 0, 1],
    });

    expect(orientation.distance).toBeCloseTo(2);
    expect(orientation.yawDegrees).toBeCloseTo(90);
    expect(orientation.pitchDegrees).toBeCloseTo(0);
    expect(orientation.rollDegrees).toBeCloseTo(0);
  });

  it("builds a camera pose from orbit-style orientation around target", () => {
    const pose = buildViewport3DCameraPoseFromOrientation({
      distance: 2,
      pitchDegrees: 0,
      rollDegrees: 0,
      target: [0, 0, 0],
      yawDegrees: 90,
    });

    expectTupleClose(pose.position, [0, 2, 0]);
    expectTupleClose(pose.target, [0, 0, 0]);
    expectTupleClose(pose.up, [0, 0, 1]);
  });

  it("round-trips roll through the camera up vector", () => {
    const pose = buildViewport3DCameraPoseFromOrientation({
      distance: 1,
      pitchDegrees: 0,
      rollDegrees: 45,
      target: [0, 0, 0],
      yawDegrees: 0,
    });

    const orientation = resolveViewport3DCameraOrientation(pose);

    expect(orientation.rollDegrees).toBeCloseTo(45);
  });

  it("normalizes generated OpenAPI number arrays into camera tuples", () => {
    expect(toCameraTuple([1, Number.NaN, 3], [4, 5, 6])).toEqual([1, 5, 3]);
  });
});
