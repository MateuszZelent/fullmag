import { describe, expect, it } from "vitest";

import { magnetizationHslRgb } from "./magnetizationColor";

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
});
