import { describe, expect, it } from "vitest";

import { buildVectorGlyphs, normalComponentMarker } from "./vectorGlyphs";

describe("vector glyph selection", () => {
  it("uses a deterministic budget as a limit rather than an incidental stride", () => {
    const vectors = new Float64Array(30);
    for (let index = 0; index < 10; index += 1) vectors[index * 3] = index + 1;
    expect(buildVectorGlyphs(vectors, 3).map((glyph) => glyph.index)).toEqual([
      1, 5, 8,
    ]);
    expect(buildVectorGlyphs(vectors, 3)).toEqual(buildVectorGlyphs(vectors, 3));
  });

  it("does not emit NaN geometry for zero vectors", () => {
    expect(buildVectorGlyphs(new Float64Array(9), 3)).toEqual([]);
  });

  it("caps each arrow to its source cell while preserving the signed normal component", () => {
    const [glyph] = buildVectorGlyphs(
      new Float64Array([1e30, -1e30, -7]),
      1,
      1e-15,
      { maxLengthCells: 0.4 },
    );

    expect(Math.hypot(glyph!.u, glyph!.v)).toBeCloseTo(0.4);
    expect(glyph!.normal).toBe(-7);
  });

  it("does not create false arrows from non-finite vector components", () => {
    expect(
      buildVectorGlyphs(new Float64Array([Number.NaN, 1, 0, Infinity, 0, 0]), 2),
    ).toEqual([]);
  });

  it("keeps the normal component signed in the 2D glyph marker", () => {
    expect(normalComponentMarker(-2)).toEqual({ direction: "into-plane", magnitude: 2 });
    expect(normalComponentMarker(3)).toEqual({ direction: "out-of-plane", magnitude: 3 });
  });

  it("applies server length mode while retaining a bounded geometry budget", () => {
    const vectors = new Float64Array([0.1, 0, 0, 10, 0, 0]);
    expect(buildVectorGlyphs(vectors, 2, 1e-15, { lengthMode: "uniform", maxLengthCells: 0.3 }))
      .toMatchObject([{ u: 0.3 }, { u: 0.3 }]);
    expect(buildVectorGlyphs(vectors, 2, 1e-15, { lengthMode: "magnitude", maxLengthCells: 0.3 }))
      .toMatchObject([{ u: 0.1 }, { u: 0.3 }]);
  });

  it("samples vectors deterministically in 2D tiles and provides physical coordinates", () => {
    // 4x4 grid, total 16 cells.
    const vectors = new Float64Array(16 * 3);
    for (let i = 0; i < 16; i++) {
      vectors[i * 3] = 1; // u
      vectors[i * 3 + 1] = 2; // v
      vectors[i * 3 + 2] = 0.5; // normal
    }
    // Mask out top row (y=3, indices 12..15)
    const mask = new Uint8Array(16);
    for (let i = 12; i < 16; i++) mask[i] = 1; // empty

    const glyphs = buildVectorGlyphs(vectors, 4, 1e-15, {
      bounds: [0, 4, 0, 4],
      gridHeight: 4,
      gridWidth: 4,
      lengthMode: "uniform",
      mask,
      maxLengthCells: 0.4,
    });

    expect(glyphs.length).toBeGreaterThan(0);
    expect(glyphs.length).toBeLessThanOrEqual(4);
    for (const g of glyphs) {
      expect(g.worldU).toBeDefined();
      expect(g.worldV).toBeDefined();
      expect(g.origU).toBe(1);
      expect(g.origV).toBe(2);
      expect(g.origNormal).toBe(0.5);
      // Ensure no sample from the masked top row was chosen
      expect(g.index).toBeLessThan(12);
    }
  });
});
