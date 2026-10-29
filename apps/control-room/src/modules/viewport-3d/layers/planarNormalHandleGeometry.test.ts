import { describe, expect, it } from "vitest";

import {
  closestAxisParameter,
  orthonormalFrame,
  planarFrameCenter,
  ringAngle,
  rotateFrame,
  translateAlongNormal,
} from "./planarNormalHandleGeometry";

describe("planar normal handle geometry", () => {
  it("finds the axis point closest to a skew ray", () => {
    // Axis: z through the origin; ray along x at height z = 3, offset y = 1.
    expect(closestAxisParameter([-5, 1, 3], [1, 0, 0], [0, 0, 0], [0, 0, 1])).toBeCloseTo(3, 12);
    // Non-unit axis direction scales the parameter.
    expect(closestAxisParameter([-5, 1, 3], [1, 0, 0], [0, 0, 0], [0, 0, 2])).toBeCloseTo(1.5, 12);
  });

  it("returns null for a ray parallel to the axis", () => {
    expect(closestAxisParameter([1, 1, 0], [0, 0, 1], [0, 0, 0], [0, 0, 1])).toBeNull();
  });

  it("centres the frame and moves the origin along the unit normal", () => {
    expect(planarFrameCenter([0, 0, 1], [1, 0, 0], [0, 1, 0], [-2, 4, -1, 1])).toEqual([1, 0, 1]);
    expect(translateAlongNormal([0, 0, 1], [0, 0, 2], 0.5)).toEqual([0, 0, 1.5]);
  });

  it("rotates the frame about u and keeps it orthonormal and right-handed", () => {
    const frame = orthonormalFrame([0, 0, 1], [1, 0, 0]);
    const rotated = rotateFrame(frame, frame.uAxis, Math.PI / 2);
    expect(rotated.normal[1]).toBeCloseTo(-1, 12);
    rotated.uAxis.forEach((value, index) => expect(value).toBeCloseTo(frame.uAxis[index]!, 12));
    const dotNu = rotated.normal.reduce((sum, value, index) => sum + value * rotated.uAxis[index]!, 0);
    expect(Math.abs(dotNu)).toBeLessThan(1e-12);
    // v = n × u keeps u × v = n.
    expect(rotated.vAxis[2]).toBeCloseTo(1, 12);
  });

  it("builds a frame on a face normal even when the u hint is parallel", () => {
    const frame = orthonormalFrame([0, 0, 2], [0, 0, 1]);
    expect(frame.normal).toEqual([0, 0, 1]);
    expect(Math.hypot(...frame.uAxis)).toBeCloseTo(1, 12);
    expect(Math.abs(frame.uAxis[2])).toBeLessThan(1e-12);
  });

  it("measures the ring angle of a pointer ray in the ring plane", () => {
    expect(ringAngle([1, 1, 5], [0, 0, -1], [0, 0, 0], [0, 0, 1], [1, 0, 0], [0, 1, 0])).toBeCloseTo(Math.PI / 4, 12);
    expect(ringAngle([0, 0, 5], [1, 0, 0], [0, 0, 0], [0, 0, 1], [1, 0, 0], [0, 1, 0])).toBeNull();
  });
});
