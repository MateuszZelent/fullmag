import { describe, expect, it } from "vitest";

import { resolveViewport3DFlyStep, resolveViewport3DOrbitReturn, VIEWPORT_3D_FLY_STEP_FRACTION } from "./viewport3DCameraFly";

const base = { orthographic: false, sceneRadius: 100e-9 };

describe("viewport wheel navigation that does not stall at the target", () => {
  it("flies a free camera at a constant step, whatever the target distance", () => {
    const far = resolveViewport3DFlyStep({ ...base, deltaY: -100, mode: "camera", targetDistance: 1e-6 });
    const near = resolveViewport3DFlyStep({ ...base, deltaY: -100, mode: "camera", targetDistance: 1e-12 });
    expect(far?.distance).toBeCloseTo(100e-9 * VIEWPORT_3D_FLY_STEP_FRACTION, 20);
    expect(near?.distance).toBe(far?.distance);
    expect(resolveViewport3DFlyStep({ ...base, deltaY: 100, mode: "camera", targetDistance: 1e-9 })?.distance).toBeLessThan(0);
  });

  it("keeps the orbit dolly far from the target and pushes the target when close", () => {
    expect(resolveViewport3DFlyStep({ ...base, deltaY: -100, mode: "object", targetDistance: 50e-9 })).toBeNull();
    expect(resolveViewport3DFlyStep({ ...base, deltaY: -100, mode: "object", targetDistance: 2e-9 })?.distance).toBeGreaterThan(0);
    // Zooming out near the target stays with the ordinary dolly.
    expect(resolveViewport3DFlyStep({ ...base, deltaY: 100, mode: "object", targetDistance: 2e-9 })).toBeNull();
  });

  it("leaves orthographic zoom and empty wheel events to the controls", () => {
    expect(resolveViewport3DFlyStep({ ...base, orthographic: true, deltaY: -100, mode: "camera", targetDistance: 1 })).toBeNull();
    expect(resolveViewport3DFlyStep({ ...base, deltaY: 0, mode: "camera", targetDistance: 1 })).toBeNull();
  });
});

describe("returning a free camera to object orbit", () => {
  const center = [0, 0, 0] as const;
  it("keeps a camera that is already at a working distance", () => {
    expect(resolveViewport3DOrbitReturn({ camera: [0, 0, 3], center, sceneRadius: 1 })).toEqual([0, 0, 3]);
  });

  it("steps a far-away camera back to the return distance on the same bearing", () => {
    const position = resolveViewport3DOrbitReturn({ camera: [0, 0, 40], center, sceneRadius: 1 });
    expect(position[0]).toBeCloseTo(0);
    expect(position[2]).toBeCloseTo(3);
  });

  it("moves a camera out of the object along a stable diagonal", () => {
    const position = resolveViewport3DOrbitReturn({ camera: [0, 0, 0], center, sceneRadius: 2 });
    expect(Math.hypot(...position)).toBeCloseTo(6);
  });
});
