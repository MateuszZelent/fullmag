import { describe, expect, it } from "vitest";

import {
  magnitudeColorRgb,
  resolveViewport3DVectorColorRgb,
  resolveViewport3DVectorColorScalar,
  scalarValueColorRgbForTests,
} from "./viewport3dVectorColoring";

describe("viewport3dVectorColoring", () => {
  describe("scalarValueColorRgb (S-05 relative epsilon)", () => {
    it("maps values linearly when span is well-defined", () => {
      const minColor = scalarValueColorRgbForTests(0, { max: 10, min: 0 }, "viridis");
      const midColor = scalarValueColorRgbForTests(5, { max: 10, min: 0 }, "viridis");
      const maxColor = scalarValueColorRgbForTests(10, { max: 10, min: 0 }, "viridis");

      expect(midColor).toEqual(magnitudeColorRgb(0.5, "viridis"));
      expect(minColor).toEqual(magnitudeColorRgb(0, "viridis"));
      expect(maxColor).toEqual(magnitudeColorRgb(1, "viridis"));
    });

    it("returns midpoint palette color for degenerate range at micromagnetic scale (Ms ≈ 8e5)", () => {
      const color = scalarValueColorRgbForTests(
        800000,
        { max: 800000, min: 800000 },
        "viridis",
      );
      expect(color).toEqual(magnitudeColorRgb(0.5, "viridis"));
    });

    it("returns midpoint palette color for ULP float32 noise in uniform high-magnitude field", () => {
      // span is 0.0625, scale is 800000 -> span <= 1e-6 * 800000 (0.8) -> degenerate
      const color = scalarValueColorRgbForTests(
        800000.0625,
        { max: 800000.0625, min: 800000 },
        "viridis",
      );
      expect(color).toEqual(magnitudeColorRgb(0.5, "viridis"));
    });

    it("returns midpoint palette color for degenerate range at zero", () => {
      const color = scalarValueColorRgbForTests(
        0,
        { max: 0, min: 0 },
        "viridis",
      );
      expect(color).toEqual(magnitudeColorRgb(0.5, "viridis"));
    });

    it("returns midpoint palette color for non-finite values and invalid ranges without throwing", () => {
      expect(
        scalarValueColorRgbForTests(Number.NaN, { max: 10, min: 0 }, "viridis"),
      ).toEqual(magnitudeColorRgb(0.5, "viridis"));
      expect(
        scalarValueColorRgbForTests(
          Number.POSITIVE_INFINITY,
          { max: 10, min: 0 },
          "viridis",
        ),
      ).toEqual(magnitudeColorRgb(0.5, "viridis"));
      expect(
        scalarValueColorRgbForTests(
          Number.NEGATIVE_INFINITY,
          { max: 10, min: 0 },
          "viridis",
        ),
      ).toEqual(magnitudeColorRgb(0.5, "viridis"));
      expect(
        scalarValueColorRgbForTests(5, { max: Number.NaN, min: 0 }, "viridis"),
      ).toEqual(magnitudeColorRgb(0.5, "viridis"));
      expect(
        scalarValueColorRgbForTests(5, { max: 10, min: Number.NaN }, "viridis"),
      ).toEqual(magnitudeColorRgb(0.5, "viridis"));
      expect(
        scalarValueColorRgbForTests(
          5,
          null as unknown as Parameters<typeof scalarValueColorRgbForTests>[1],
          "viridis",
        ),
      ).toEqual(magnitudeColorRgb(0.5, "viridis"));
      expect(
        scalarValueColorRgbForTests(
          5,
          undefined as unknown as Parameters<typeof scalarValueColorRgbForTests>[1],
          "viridis",
        ),
      ).toEqual(magnitudeColorRgb(0.5, "viridis"));
    });

    it("returns midpoint palette color for inverted range where min > max", () => {
      expect(
        scalarValueColorRgbForTests(5, { max: 0, min: 10 }, "viridis"),
      ).toEqual(magnitudeColorRgb(0.5, "viridis"));
    });
  });

  describe("magnitudeColorRgb", () => {
    it("sanitizes non-finite t to midpoint color without throwing", () => {
      expect(magnitudeColorRgb(Number.NaN, "viridis")).toEqual(
        magnitudeColorRgb(0.5, "viridis"),
      );
      expect(magnitudeColorRgb(Number.POSITIVE_INFINITY, "viridis")).toEqual(
        magnitudeColorRgb(0.5, "viridis"),
      );
    });
  });

  describe("resolveViewport3DVectorColorRgb", () => {
    it("safely handles NaN component values without throwing", () => {
      const color = resolveViewport3DVectorColorRgb(
        "x",
        Number.NaN,
        0,
        0,
        { max: 10, min: 0 },
        1,
        "viridis",
      );
      expect(color).toEqual(magnitudeColorRgb(0.5, "viridis"));
    });

    it("safely handles NaN relMag in magnitude mode without throwing", () => {
      const color = resolveViewport3DVectorColorRgb(
        "magnitude",
        1,
        0,
        0,
        { max: 10, min: 0 },
        Number.NaN,
        "viridis",
      );
      expect(color).toEqual(magnitudeColorRgb(0.5, "viridis"));
    });

    it("routes component mode with degenerate range to midpoint palette color", () => {
      const color = resolveViewport3DVectorColorRgb(
        "x",
        800000,
        0,
        0,
        { max: 800000, min: 800000 },
        1,
        "viridis",
      );
      expect(color).toEqual(magnitudeColorRgb(0.5, "viridis"));
    });

    it("routes magnitude mode using pre-normalized relMag", () => {
      const color = resolveViewport3DVectorColorRgb(
        "magnitude",
        1,
        0,
        0,
        { max: 10, min: 0 },
        0.75,
        "viridis",
      );
      expect(color).toEqual(magnitudeColorRgb(0.75, "viridis"));
    });

    it("returns null for monochrome mode", () => {
      const color = resolveViewport3DVectorColorRgb(
        "monochrome",
        1,
        0,
        0,
        { max: 1, min: 0 },
      );
      expect(color).toBeNull();
    });

    it("computes correct scalar for components", () => {
      expect(resolveViewport3DVectorColorScalar("x", 2, 3, 4)).toBe(2);
      expect(resolveViewport3DVectorColorScalar("y", 2, 3, 4)).toBe(3);
      expect(resolveViewport3DVectorColorScalar("z", 2, 3, 4)).toBe(4);
      expect(resolveViewport3DVectorColorScalar("magnitude", 3, 4, 0)).toBe(5);
    });
  });
});
