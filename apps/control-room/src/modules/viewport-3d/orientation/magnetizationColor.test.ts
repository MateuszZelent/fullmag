import { describe, expect, it } from "vitest";

import { srgbToLinearChannel } from "../viewport3dColorSpace";
import {
  HSL_REFERENCE_AXES,
  magnetizationHslLinearRgb,
  magnetizationHslRgb,
} from "./magnetizationColor";

function expectRgb(
  actual: [number, number, number],
  expected: [number, number, number],
) {
  expect(actual[0]).toBeCloseTo(expected[0], 5);
  expect(actual[1]).toBeCloseTo(expected[1], 5);
  expect(actual[2]).toBeCloseTo(expected[2], 5);
}

describe("magnetization HSL color mapping", () => {
  it("maps equatorial axes to full-brightness HSL hues", () => {
    expectRgb(magnetizationHslRgb(1, 0, 0), [1, 0, 0]);
    expectRgb(magnetizationHslRgb(0, 1, 0), [0.5, 1, 0]);
  });

  it("matches mumax3 for pure out-of-plane magnetization", () => {
    expectRgb(magnetizationHslRgb(0, 0, 1), [1, 1, 1]);
    expectRgb(magnetizationHslRgb(0, 0, -1), [0, 0, 0]);
  });

  it("derives lightness from the NORMALISED z component", () => {
    // (1, 0, 1) points 45 deg above the plane, so it is a pale red -- not
    // white. Feeding the raw mz into the lightness (the previous behaviour)
    // clamped this to [1, 1, 1] and, on any field that is not unit length,
    // turned a 1 degree tilt into full white.
    const sqrtHalf = Math.SQRT1_2;
    expectRgb(magnetizationHslRgb(1, 0, 1), [1, sqrtHalf, sqrtHalf]);
  });

  it("is invariant under rescaling of the field", () => {
    // Same direction expressed in A/m rather than reduced units must produce
    // exactly the same colour.
    const reduced = magnetizationHslRgb(
      Math.cos(Math.PI / 18),
      0,
      Math.sin(Math.PI / 18),
    );
    const amperesPerMetre = magnetizationHslRgb(
      8e5 * Math.cos(Math.PI / 18),
      0,
      8e5 * Math.sin(Math.PI / 18),
    );
    expectRgb(amperesPerMetre, reduced);
    // A 10 degree tilt keeps most of its chroma; it is nowhere near white.
    expect(reduced[1]).toBeCloseTo(0.173648, 5);
  });

  it("keeps saturation independent of the vector norm", () => {
    // A small-amplitude eigenmode is still a direction, not a grey smear.
    expectRgb(magnetizationHslRgb(1e-6, 0, 0), [1, 0, 0]);
  });

  it("maps the zero vector to a neutral reference color", () => {
    expectRgb(magnetizationHslRgb(0, 0, 0), [0.6, 0.6, 0.6]);
  });

  it("exposes a linear-sRGB variant for three.js color attributes", () => {
    const srgb = magnetizationHslRgb(1, 0, 1);
    const linear = magnetizationHslLinearRgb(1, 0, 1);
    expectRgb(linear, [
      srgbToLinearChannel(srgb[0]),
      srgbToLinearChannel(srgb[1]),
      srgbToLinearChannel(srgb[2]),
    ]);
    expect(linear[1]).toBeCloseTo(0.458176, 5);
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
