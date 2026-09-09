import { describe, expect, it } from "vitest";
import {
  isDivergingScalarPalette,
  scalarColorRgb,
} from "./scalarColorPalette";

describe("scalarColorRgb · S-02 linear-sRGB conversion", () => {
  it("converts the viridis t=0 stop (#440154, sRGB) to its linear-sRGB equivalent", () => {
    const [r, g, b] = scalarColorRgb(0, "viridis");
    expect(r).toBeCloseTo(0.0578, 3);
    expect(g).toBeCloseTo(0.0003, 3);
    expect(b).toBeCloseTo(0.0887, 3);
  });

  it("round-trips back to the original sRGB stop through the sRGB OETF (regression: GPU/CPU parity for t=0,0.5,1)", () => {
    const srgbEncode = (c: number): number =>
      c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

    for (const t of [0, 0.5, 1]) {
      const [r, g, b] = scalarColorRgb(t, "viridis");
      const reencoded: [number, number, number] = [
        srgbEncode(r),
        srgbEncode(g),
        srgbEncode(b),
      ];
      for (const channel of reencoded) {
        expect(Number.isFinite(channel)).toBe(true);
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });

  it("stays within [0, 1] for every palette across the full t range", () => {
    const palettes = ["coolwarm", "inferno", "jet", "magma", "viridis"] as const;
    for (const palette of palettes) {
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const [r, g, b] = scalarColorRgb(t, palette);
        for (const channel of [r, g, b]) {
          expect(Number.isFinite(channel)).toBe(true);
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe("isDivergingScalarPalette · S-11", () => {
  it("identifies coolwarm as diverging and sequential palettes as non-diverging", () => {
    expect(isDivergingScalarPalette("coolwarm")).toBe(true);
    expect(isDivergingScalarPalette("viridis")).toBe(false);
    expect(isDivergingScalarPalette("inferno")).toBe(false);
    expect(isDivergingScalarPalette("jet")).toBe(false);
    expect(isDivergingScalarPalette("magma")).toBe(false);
  });
});
