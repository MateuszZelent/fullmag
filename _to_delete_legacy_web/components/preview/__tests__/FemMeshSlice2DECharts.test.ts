import { describe, expect, it } from "vitest";

import { buildFemExactVectorGlyphs } from "../FemMeshSlice2DECharts";
import type { SliceArrow2D } from "../fem/femSliceGeometry";

function arrow(index: number, magnitude = 1): SliceArrow2D {
  return {
    origin: [index, index],
    vector: [magnitude, 0],
    magnitude,
    partId: "mag",
    worldPoint: [index, index, 0],
    worldVector: [magnitude, 0, 0],
  };
}

describe("buildFemExactVectorGlyphs", () => {
  it("applies density and cap for FEM exact 2D arrows", () => {
    const glyphs = buildFemExactVectorGlyphs({
      arrows: [arrow(0), arrow(1), arrow(2), arrow(3)],
      plane: "xy",
      bounds: { uMin: 0, uMax: 10, vMin: 0, vMax: 10 },
      everyN: 2,
      maxGlyphs: 1,
      colorMode: "monochrome",
      monoColor: "#38d9ff",
    });

    expect(glyphs).toHaveLength(1);
    expect(glyphs[0]).toMatchObject({
      origin: [0, 0],
      vector: [1, 0],
      stroke: "#38d9ff",
    });
    expect(glyphs[0]?.delta[0]).toBeGreaterThan(0);
  });

  it("skips zero vectors without consuming visible glyph budget", () => {
    const glyphs = buildFemExactVectorGlyphs({
      arrows: [arrow(0, 0), arrow(1, 2)],
      plane: "xy",
      bounds: { uMin: 0, uMax: 10, vMin: 0, vMax: 10 },
      everyN: 1,
      maxGlyphs: 1,
      colorMode: "monochrome",
      monoColor: "#ffffff",
    });

    expect(glyphs).toHaveLength(1);
    expect(glyphs[0]?.origin).toEqual([1, 1]);
  });
});
