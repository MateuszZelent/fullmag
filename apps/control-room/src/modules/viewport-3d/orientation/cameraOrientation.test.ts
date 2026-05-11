import { describe, expect, it } from "vitest";

import { normalizeDirection, snapCameraToDirection } from "./cameraOrientation";

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
});
