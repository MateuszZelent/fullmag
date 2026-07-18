import { describe, expect, it } from "vitest";

import { buildVectorGlyphs } from "./vectorGlyphs";

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
});
