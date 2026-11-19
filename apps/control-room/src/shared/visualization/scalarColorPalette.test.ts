import { describe, expect, it } from "vitest";
import {
  getScalarColorPaletteStops,
  isDivergingScalarPalette,
  normalizeScalarColorPalette,
  scalarColorPaletteGradientCss,
  scalarColorRgb,
  scalarColorSrgb,
  SCALAR_COLOR_PALETTE_ITEMS,
} from "./scalarColorPalette";

describe("scalarColorRgb · S-02 linear-sRGB conversion", () => {
  it("converts the viridis t=0 stop (#440154, sRGB) to its linear-sRGB equivalent", () => {
    const [r, g, b] = scalarColorRgb(0, "viridis");
    expect(r).toBeCloseTo(0.0578, 3);
    expect(g).toBeCloseTo(0.0003, 3);
    expect(b).toBeCloseTo(0.0887, 3);
  });

  it("round-trips linear GPU colors to the display samples used by Canvas", () => {
    const srgbEncode = (c: number): number =>
      c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

    for (const t of [0, 0.5, 1]) {
      const [r, g, b] = scalarColorRgb(t, "viridis");
      const display = scalarColorSrgb(t, "viridis");
      const reencoded: [number, number, number] = [
        srgbEncode(r),
        srgbEncode(g),
        srgbEncode(b),
      ];
      for (const [index, channel] of reencoded.entries()) {
        expect(Number.isFinite(channel)).toBe(true);
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
        expect(channel).toBeCloseTo(display[index]!, 12);
      }
    }
  });

  it("stays within [0, 1] for every palette across the full t range", () => {
    for (const { value: palette } of SCALAR_COLOR_PALETTE_ITEMS) {
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

describe("scalarColorSrgb display sampling", () => {
  it("preserves independently specified viridis endpoint and midpoint bytes", () => {
    expect([0, 0.5, 1].map((t) => scalarColorSrgb(t).map((c) => Math.round(c * 255))))
      .toEqual([[68, 1, 84], [51, 144, 132], [253, 231, 37]]);
  });

  it("samples the added scalar palettes at their declared endpoints", () => {
    const endpoints = {
      plasma: [[13, 8, 135], [240, 249, 33]],
      cividis: [[0, 32, 76], [254, 232, 56]],
      turbo: [[48, 18, 59], [122, 4, 3]],
      grayscale: [[0, 0, 0], [255, 255, 255]],
      rdbu: [[103, 0, 31], [5, 48, 97]],
    } as const;

    for (const [palette, [start, end]] of Object.entries(endpoints)) {
      expect(
        [0, 1].map((t) =>
          scalarColorSrgb(t, palette).map((c) => Math.round(c * 255)),
        ),
      ).toEqual([start, end]);
    }
  });

  it("uses the shared catalog for normalization and sRGB colorbar stops", () => {
    expect(SCALAR_COLOR_PALETTE_ITEMS.map(({ value }) => value)).toContain("plasma");
    expect(SCALAR_COLOR_PALETTE_ITEMS.map(({ value }) => value)).toContain("cividis");
    expect(SCALAR_COLOR_PALETTE_ITEMS.map(({ value }) => value)).toContain("turbo");
    expect(SCALAR_COLOR_PALETTE_ITEMS.map(({ value }) => value)).toContain("grayscale");
    expect(SCALAR_COLOR_PALETTE_ITEMS.map(({ value }) => value)).toContain("rdbu");
    expect(normalizeScalarColorPalette("RdBu")).toBe("rdbu");
    expect(normalizeScalarColorPalette("not-a-palette")).toBe("viridis");
    expect(scalarColorPaletteGradientCss("grayscale", "to right")).toBe(
      "linear-gradient(to right in srgb, rgb(0, 0, 0), rgb(255, 255, 255))",
    );
    expect(getScalarColorPaletteStops("rdbu")[5]).toEqual([
      0xf7 / 255,
      0xf7 / 255,
      0xf7 / 255,
    ]);
    expect(getScalarColorPaletteStops("twilight")[0]).toEqual(
      getScalarColorPaletteStops("twilight")[4],
    );
  });
});

describe("isDivergingScalarPalette · S-11", () => {
  it("identifies coolwarm as diverging and sequential palettes as non-diverging", () => {
    expect(isDivergingScalarPalette("coolwarm")).toBe(true);
    expect(isDivergingScalarPalette("viridis")).toBe(false);
    expect(isDivergingScalarPalette("inferno")).toBe(false);
    expect(isDivergingScalarPalette("jet")).toBe(false);
    expect(isDivergingScalarPalette("magma")).toBe(false);
    expect(isDivergingScalarPalette("RdBu")).toBe(true);
  });
});
