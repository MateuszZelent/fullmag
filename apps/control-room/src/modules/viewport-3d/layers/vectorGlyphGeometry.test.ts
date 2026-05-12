import { describe, expect, it } from "vitest";

import { buildVectorGlyphInstances } from "./vectorGlyphGeometry";
import { magnitudeColorRgb } from "../viewport3dVectorColoring";

describe("vectorGlyphGeometry", () => {
  it("builds shaft and head instance transforms from vector segments", () => {
    const glyphs = buildVectorGlyphInstances(
      new Float32Array([0, 0, 0, 1, 0, 0]),
      {
        headLengthRatio: 0.25,
        headRadiusRatio: 0.12,
        shaftRadiusRatio: 0.05,
      },
    );

    expect(glyphs.count).toBe(1);
    expectFloatArrayClose(glyphs.directions, [1, 0, 0]);
    expectFloatArrayClose(glyphs.shaftCenters, [0.375, 0, 0]);
    expectFloatArrayClose(glyphs.shaftScales, [0.05, 0.75, 0.05]);
    expectFloatArrayClose(glyphs.headCenters, [0.875, 0, 0]);
    expectFloatArrayClose(glyphs.headScales, [0.12, 0.25, 0.12]);
  });

  it("maps orientation coloring to one color per glyph instance", () => {
    const glyphs = buildVectorGlyphInstances(
      new Float32Array([0, 0, 0, 1, 0, 0]),
      { colorMode: "orientation" },
    );

    expectFloatArrayClose(glyphs.colors ?? new Float32Array(), [0.5, 0, 0]);
  });

  it("uses canonical physical XYZ for orientation coloring", () => {
    const glyphs = buildVectorGlyphInstances(
      new Float32Array([0, 0, 0, 0, 0, 1]),
      { colorMode: "orientation" },
    );

    expectFloatArrayClose(glyphs.colors ?? new Float32Array(), [1, 1, 1]);
  });

  it("colors production glyphs in the HUD orientation frame", () => {
    const glyphs = buildVectorGlyphInstances(
      new Float32Array([
        0, 0, 0, 0, 0, -1, 1,
        0, 0, 0, 1, 0, 0, 1,
      ]),
      { colorMode: "orientation", orientationFrame: "hud" },
    );

    expectFloatArrayClose(glyphs.colors ?? new Float32Array(), [
      1, 1, 1,
      0.5, 0, 0,
    ]);
  });

  it("accepts HSLSPHERE aliases for vector glyph orientation coloring", () => {
    const glyphs = buildVectorGlyphInstances(
      new Float32Array([0, 0, 0, 0, 0, 1]),
      { colorMode: "hsl_sphere" },
    );

    expectFloatArrayClose(glyphs.colors ?? new Float32Array(), [1, 1, 1]);
  });

  it("maps component vector color modes to per-glyph colors", () => {
    const glyphs = buildVectorGlyphInstances(
      new Float32Array([
        0, 0, 0, -1, 0, 0,
        0, 0, 0, 1, 0, 0,
      ]),
      { colorMode: "x" },
    );

    expectFloatArrayClose(glyphs.colors ?? new Float32Array(), [
      0, 0.38, 1,
      1, 0.38, 0,
    ]);
  });

  it("maps magnitude vector coloring to per-glyph colors", () => {
    const glyphs = buildVectorGlyphInstances(
      new Float32Array([0, 0, 0, 1, 0, 0]),
      { colorMode: "magnitude" },
    );

    expectFloatArrayClose(
      glyphs.colors ?? new Float32Array(),
      magnitudeColorRgb(1),
    );
  });

  it("keeps monochrome vector coloring on the fixed material color", () => {
    const glyphs = buildVectorGlyphInstances(
      new Float32Array([0, 0, 0, 1, 0, 0]),
      { colorMode: "monochrome" },
    );

    expect(glyphs.colors).toBeNull();
  });

  it("keeps zero-length vectors finite and neutral", () => {
    const glyphs = buildVectorGlyphInstances(
      new Float32Array([2, 3, 4, 2, 3, 4]),
      { colorMode: "orientation" },
    );

    expectFloatArrayClose(glyphs.directions, [0, 1, 0]);
    expectFloatArrayClose(glyphs.shaftCenters, [2, 3, 4]);
    expectFloatArrayClose(glyphs.headCenters, [2, 3, 4]);
    expectFloatArrayClose(glyphs.shaftScales, [0, 0, 0]);
    expectFloatArrayClose(glyphs.headScales, [0, 0, 0]);
    expectFloatArrayClose(glyphs.colors ?? new Float32Array(), [0.6, 0.6, 0.6]);
  });
});

function expectFloatArrayClose(actual: Float32Array, expected: number[]) {
  expect(actual.length).toBe(expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    expect(actual[index]).toBeCloseTo(expected[index] ?? 0);
  }
}
