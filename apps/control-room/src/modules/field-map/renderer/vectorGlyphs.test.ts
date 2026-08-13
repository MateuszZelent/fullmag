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
});
