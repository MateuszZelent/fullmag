import { describe, expect, it } from "vitest";

import {
  GLYPH_MIN_LENGTH_PX,
  glyphSpacingForBudget,
  layoutScreenGlyphs,
  normalComponentMarker,
} from "./vectorGlyphs";

function uniformField(width: number, height: number, vector: [number, number, number]) {
  const values = new Float64Array(width * height * 3);
  for (let index = 0; index < width * height; index += 1) values.set(vector, index * 3);
  return values;
}

const BASE = {
  bounds: [0, 1, 0, 1] as const,
  canvasHeight: 100,
  canvasWidth: 100,
  gridHeight: 10,
  gridWidth: 10,
  spacingPx: 20,
  viewport: [0, 1, 0, 1] as const,
};

describe("screen-space glyph layout", () => {
  it("places glyphs on a regular 2D grid instead of a row-major stride", () => {
    const glyphs = layoutScreenGlyphs({ ...BASE, vectors: uniformField(10, 10, [1, 0, 0]) });
    expect(glyphs).toHaveLength(25);
    const xs = new Set(glyphs.map((glyph) => Math.round(glyph.x)));
    const ys = new Set(glyphs.map((glyph) => Math.round(glyph.y)));
    expect([...xs].sort((a, b) => a - b)).toEqual([10, 30, 50, 70, 90]);
    expect(ys.size).toBe(5);
  });

  it("uses the mumax3 in-plane projection and a minimum arrow length", () => {
    const tilted = layoutScreenGlyphs({ ...BASE, vectors: uniformField(10, 10, [0.6, 0, 0.8]) });
    expect(tilted[0]!.kind).toBe("arrow");
    expect(tilted[0]!.length).toBeCloseTo(0.82 * 20 * 0.6);
    const tiny = layoutScreenGlyphs({ ...BASE, scale: 0.01, vectors: uniformField(10, 10, [1, 0, 0]) });
    expect(tiny[0]!.length).toBe(GLYPH_MIN_LENGTH_PX);
  });

  it("uses signed normal markers for out-of-plane vectors", () => {
    const up = layoutScreenGlyphs({ ...BASE, vectors: uniformField(10, 10, [0.1, 0, 1]) });
    const down = layoutScreenGlyphs({ ...BASE, vectors: uniformField(10, 10, [0, 0.1, -1]) });
    expect(up[0]!.kind).toBe("out-of-plane");
    expect(down[0]!.kind).toBe("into-plane");
  });

  it("points screen angles with v upwards", () => {
    const [glyph] = layoutScreenGlyphs({ ...BASE, vectors: uniformField(10, 10, [0, 1, 0]) });
    expect(glyph!.angle).toBeCloseTo(-Math.PI / 2);
  });

  it("skips masked, zero and non-finite cells", () => {
    const vectors = uniformField(10, 10, [1, 0, 0]);
    vectors.set([Number.NaN, 0, 0], 0);
    // Occupancy codes: 0 occupied, 1 empty.
    const mask = new Uint8Array(100);
    mask[11] = 1;
    const glyphs = layoutScreenGlyphs({ ...BASE, mask, vectors });
    expect(glyphs.some((glyph) => glyph.index === 0)).toBe(false);
    expect(glyphs.some((glyph) => glyph.index === 11)).toBe(false);
    expect(layoutScreenGlyphs({ ...BASE, vectors: new Float64Array(300) })).toEqual([]);
  });

  it("keeps glyphs anchored to the data while panning", () => {
    const vectors = uniformField(10, 10, [1, 0, 0]);
    const original = layoutScreenGlyphs({ ...BASE, vectors });
    const panned = layoutScreenGlyphs({ ...BASE, vectors, viewport: [0.1, 1.1, 0, 1] });
    const sameAnchor = panned.find((glyph) => glyph.index === original[1]!.index);
    expect(sameAnchor?.x).toBeCloseTo(original[1]!.x - 10);
  });

  it("derives spacing from the vector budget within readable bounds", () => {
    expect(glyphSpacingForBudget(1000, 1000, 1000)).toBeCloseTo(31.62, 2);
    expect(glyphSpacingForBudget(1000, 1000, 1e9)).toBe(24);
    expect(glyphSpacingForBudget(1000, 1000, 0)).toBe(160);
  });

  it("keeps the normal component signed in the 2D glyph marker", () => {
    expect(normalComponentMarker(-2)).toEqual({ direction: "into-plane", magnitude: 2 });
    expect(normalComponentMarker(3)).toEqual({ direction: "out-of-plane", magnitude: 3 });
  });
});
