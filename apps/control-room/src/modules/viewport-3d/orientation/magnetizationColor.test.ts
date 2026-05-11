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
  it("maps +X to red", () => {
    expectRgb(magnetizationHslRgb(1, 0, 0), [1, 0, 0]);
  });

  it("maps +Z to white and -Z to black", () => {
    expectRgb(magnetizationHslRgb(0, 0, 1), [1, 1, 1]);
    expectRgb(magnetizationHslRgb(0, 0, -1), [0, 0, 0]);
  });

  it("maps the zero vector to a neutral reference color", () => {
    expectRgb(magnetizationHslRgb(0, 0, 0), [0.5, 0.5, 0.5]);
  });

  it("defines HSL reference axes in world-axis coordinates", () => {
    expect(HSL_REFERENCE_AXES).toEqual([
      {
        color: [1, 0, 0],
        direction: [1, 0, 0],
        id: "x",
        label: "+X",
      },
      {
        color: magnetizationHslRgb(0, 1, 0),
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
});
