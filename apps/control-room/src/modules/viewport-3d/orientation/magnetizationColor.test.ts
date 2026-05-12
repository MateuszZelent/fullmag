import { describe, expect, it } from "vitest";

import {
  HSL_REFERENCE_AXES,
  magnetizationHslRgb,
  magnetizationHslRgbForSceneVector,
} from "./magnetizationColor";

function expectRgb(actual: [number, number, number], expected: [number, number, number]) {
  expect(actual[0]).toBeCloseTo(expected[0], 5);
  expect(actual[1]).toBeCloseTo(expected[1], 5);
  expect(actual[2]).toBeCloseTo(expected[2], 5);
}

describe("magnetization HSL color mapping", () => {
  it("maps +X to red", () => {
    expectRgb(magnetizationHslRgb(1, 0, 0), [0.5, 0, 0]);
  });

  it("maps +Z to white and -Z to black", () => {
    expectRgb(magnetizationHslRgb(0, 0, 1), [1, 1, 1]);
    expectRgb(magnetizationHslRgb(0, 0, -1), [0, 0, 0]);
  });

  it("keeps the v1 HSL-sphere value ramp away from the poles", () => {
    expectRgb(magnetizationHslRgb(1, 0, 1), [
      0.8535533905932737,
      0.25,
      0.25,
    ]);
  });

  it("maps the zero vector to a neutral reference color", () => {
    expectRgb(magnetizationHslRgb(0, 0, 0), [0.6, 0.6, 0.6]);
  });

  it("defines HSL reference axes with the v1 swapYZ scene convention", () => {
    expect(HSL_REFERENCE_AXES).toEqual([
      {
        color: [1, 0, 0],
        direction: [1, 0, 0],
        id: "x",
        label: "+X",
      },
      {
        color: [0.3137254901960784, 0.5647058823529412, 0.9019607843137255],
        direction: [0, 1, 0],
        id: "y",
        label: "+Z",
      },
      {
        color: [0.3137254901960784, 0.7843137254901961, 0.3137254901960784],
        direction: [0, 0, 1],
        id: "z",
        label: "+Y",
      },
    ]);
  });

  it("samples HSL reference-sphere colors through the v1 swapYZ scene convention", () => {
    expectRgb(magnetizationHslRgbForSceneVector(0, 1, 0), [1, 1, 1]);
    expectRgb(
      magnetizationHslRgbForSceneVector(0, 0, 1),
      magnetizationHslRgb(0, 1, 0),
    );
  });
});
