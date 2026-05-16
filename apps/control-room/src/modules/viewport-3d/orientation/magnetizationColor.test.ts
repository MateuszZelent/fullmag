import { describe, expect, it } from "vitest";

import {
  HSL_REFERENCE_AXES,
  magnetizationHslRgb,
} from "./magnetizationColor";

function expectRgb(actual: [number, number, number], expected: [number, number, number]) {
  expect(actual[0]).toBeCloseTo(expected[0], 5);
  expect(actual[1]).toBeCloseTo(expected[1], 5);
  expect(actual[2]).toBeCloseTo(expected[2], 5);
}

describe("magnetization HSL color mapping", () => {
  it("maps equatorial axes to full-brightness HSL hues", () => {
    expectRgb(magnetizationHslRgb(1, 0, 0), [1, 0, 0]);
    expectRgb(magnetizationHslRgb(0, 1, 0), [0.5, 1, 0]);
  });

  it("maps +Z to white and -Z to black", () => {
    expectRgb(magnetizationHslRgb(0, 0, 1), [1, 1, 1]);
    expectRgb(magnetizationHslRgb(0, 0, -1), [0, 0, 0]);
  });

  it("uses HSL lightness for out-of-plane orientation", () => {
    expectRgb(magnetizationHslRgb(1, 0, 1), [
      0.9571067811865476,
      0.75,
      0.75,
    ]);
  });

  it("maps the zero vector to a neutral reference color", () => {
    expectRgb(magnetizationHslRgb(0, 0, 0), [0.6, 0.6, 0.6]);
  });

  it("defines HSL reference axes in canonical physical XYZ", () => {
    expect(HSL_REFERENCE_AXES).toEqual([
      {
        color: [1, 0, 0],
        direction: [1, 0, 0],
        id: "x",
        label: "+X",
      },
      {
        color: [0.5, 1, 0],
        direction: [0, 1, 0],
        id: "y",
        label: "+Y",
      },
      {
        color: [1, 1, 1],
        direction: [0, 0, 1],
        id: "z",
        label: "+Z",
      },
    ]);
  });

  it("samples HSL reference-sphere colors in physical XYZ", () => {
    expectRgb(magnetizationHslRgb(0, 0, 1), [1, 1, 1]);
    expectRgb(magnetizationHslRgb(0, 1, 0), [0.5, 1, 0]);
  });
});
