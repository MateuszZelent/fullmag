import { describe, expect, it } from "vitest";

import {
  dimensionlessScaleToScene,
  physicalPositionToScene,
  scenePositionToPhysical,
  sceneDeltaToPhysical,
  physicalScaleToScene,
  sceneScaleToPhysical,
  sceneScaleToDimensionless,
  physicalQuatToScene,
  sceneQuatToPhysical,
} from "../../features/viewport-core/coordinates/physicalToScene";

function expectVec3Close(a: [number, number, number], b: [number, number, number], eps = 1e-12) {
  expect(Math.abs(a[0] - b[0])).toBeLessThan(eps);
  expect(Math.abs(a[1] - b[1])).toBeLessThan(eps);
  expect(Math.abs(a[2] - b[2])).toBeLessThan(eps);
}

function expectQuatClose(
  a: [number, number, number, number],
  b: [number, number, number, number],
  eps = 1e-12,
) {
  expect(Math.abs(a[0] - b[0])).toBeLessThan(eps);
  expect(Math.abs(a[1] - b[1])).toBeLessThan(eps);
  expect(Math.abs(a[2] - b[2])).toBeLessThan(eps);
  expect(Math.abs(a[3] - b[3])).toBeLessThan(eps);
}

describe("physical <-> scene coordinates", () => {
  it("position round-trip is stable", () => {
    const physical: [number, number, number] = [1.25e-9, -3.5e-9, 8.75e-9];
    const scene = physicalPositionToScene(physical);
    const back = scenePositionToPhysical(scene);
    expect(scene).toEqual([1.25, 8.75, -3.5]);
    expectVec3Close(back, physical);
  });

  it("delta round-trip keeps axis mapping", () => {
    const sceneDelta: [number, number, number] = [0.1, 0.2, 0.3];
    const physicalDelta = sceneDeltaToPhysical(sceneDelta);
    expectVec3Close(physicalDelta, [0.1e-9, 0.3e-9, 0.2e-9]);
  });

  it("scale round-trip is stable", () => {
    const scalePhysical: [number, number, number] = [2.0e-9, 0.5e-9, 1.5e-9];
    const scaleScene = physicalScaleToScene(scalePhysical);
    const back = sceneScaleToPhysical(scaleScene);
    expect(scaleScene).toEqual([2.0, 1.5, 0.5]);
    expectVec3Close(back, scalePhysical);
  });

  it("dimensionless transform scale keeps only axis mapping", () => {
    const scalePhysical: [number, number, number] = [2.0, 0.5, 1.5];
    const scaleScene = dimensionlessScaleToScene(scalePhysical);
    const back = sceneScaleToDimensionless(scaleScene);
    expect(scaleScene).toEqual([2.0, 1.5, 0.5]);
    expectVec3Close(back, scalePhysical);
  });

  it("quaternion round-trip is stable", () => {
    // 90 deg around physical Z axis
    const s = Math.sqrt(0.5);
    const qPhysical: [number, number, number, number] = [0, 0, s, s];
    const qScene = physicalQuatToScene(qPhysical);
    const qBack = sceneQuatToPhysical(qScene);

    // physical Z maps to scene Y with current convention
    expectQuatClose(qScene, [0, s, 0, s]);
    expectQuatClose(qBack, qPhysical);
  });
});
