import { describe, expect, it } from "vitest";

import { resolveViewport3DAdaptiveVectorGlyphLength } from "./viewport3DVectorGlyphScale";

describe("adaptive viewport vector glyph length", () => {
  it("uses sampled 3D spacing instead of a fixed fraction of scene size", () => {
    const length = resolveViewport3DAdaptiveVectorGlyphLength({
      boundsSize: [500e-9, 125e-9, 54e-9],
      glyphCount: 1200,
      lengthScale: 1,
      scope: "full",
    });

    expect(length / 1e-9).toBeGreaterThan(5);
    expect(length / 1e-9).toBeLessThan(7);
  });

  it("uses surface area spacing for surface glyphs", () => {
    const length = resolveViewport3DAdaptiveVectorGlyphLength({
      boundsSize: [500e-9, 125e-9, 54e-9],
      glyphCount: 1200,
      lengthScale: 1,
      scope: "surface",
    });

    expect(length / 1e-9).toBeGreaterThan(3);
    expect(length / 1e-9).toBeLessThan(4);
  });

  it("applies the user scale after deriving local spacing", () => {
    const base = resolveViewport3DAdaptiveVectorGlyphLength({
      boundsSize: [100, 100, 100], glyphCount: 1000, lengthScale: 1, scope: "full",
    });
    const doubled = resolveViewport3DAdaptiveVectorGlyphLength({
      boundsSize: [100, 100, 100], glyphCount: 1000, lengthScale: 2, scope: "full",
    });
    expect(doubled / base).toBeCloseTo(2);
  });

  it("reduces glyph length as the rendered sample density increases", () => {
    const sparse = resolveViewport3DAdaptiveVectorGlyphLength({
      boundsSize: [500e-9, 125e-9, 54e-9],
      glyphCount: 150,
      lengthScale: 1,
      scope: "full",
    });
    const dense = resolveViewport3DAdaptiveVectorGlyphLength({
      boundsSize: [500e-9, 125e-9, 54e-9],
      glyphCount: 1200,
      lengthScale: 1,
      scope: "full",
    });

    expect(sparse / dense).toBeCloseTo(2);
  });

  it("stays finite for degenerate carriers", () => {
    expect(resolveViewport3DAdaptiveVectorGlyphLength({
      boundsSize: [0, 0, 0], glyphCount: 0, lengthScale: 1, scope: "full",
    })).toBe(1e-12);
  });
});
