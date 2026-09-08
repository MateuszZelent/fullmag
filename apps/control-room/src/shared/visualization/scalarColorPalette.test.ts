import { describe, expect, it } from "vitest";
import { scalarColorRgb, scalarColorSrgb } from "./scalarColorPalette";

describe("scalarColorRgb · S-02 linear-sRGB conversion", () => {
  it("converts the viridis t=0 stop (#440154, sRGB) to its linear-sRGB equivalent", () => {
    const [r, g, b] = scalarColorRgb(0, "viridis");
    // #440154 sRGB = (0x44/255, 0x01/255, 0x54/255) = (0.2667, 0.0039, 0.3294).
    // Linear-sRGB per the standard EOTF (c <= 0.04045 ? c/12.92 : ((c+0.055)/1.055)^2.4),
    // independently computed and verified in Python — do NOT reuse the audit
    // document's own worked example for #440154, it contains a numeric error
    // (it states ~0.0267 for the red channel; the correct value is ~0.0578).
    expect(r).toBeCloseTo(0.0578, 3);
    expect(g).toBeCloseTo(0.0003, 3);
    expect(b).toBeCloseTo(0.0887, 3);
  });

  it("converts the viridis t=1 stop (#fde725, sRGB) to its linear-sRGB equivalent", () => {
    const [r, g, b] = scalarColorRgb(1, "viridis");
    // #fde725 sRGB = (0xfd/255, 0xe7/255, 0x25/255) = (0.9922, 0.9059, 0.1451).
    // In linear-sRGB:
    // r: ((253/255 + 0.055) / 1.055)^2.4 ≈ 0.9823
    // g: ((231/255 + 0.055) / 1.055)^2.4 ≈ 0.7991
    // b: ((37/255 + 0.055) / 1.055)^2.4 ≈ 0.0185
    expect(r).toBeCloseTo(0.9823, 3);
    expect(g).toBeCloseTo(0.7991, 3);
    expect(b).toBeCloseTo(0.0185, 3);
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
      // Re-encoding the linear value back to sRGB must reproduce the exact sRGB
      // value within float precision — this confirms the CPU path's linear
      // output reconstructs the reference sRGB display values.
      const expectedSrgb = scalarColorSrgb(t, "viridis");
      expect(reencoded[0]).toBeCloseTo(expectedSrgb[0], 3);
      expect(reencoded[1]).toBeCloseTo(expectedSrgb[1], 3);
      expect(reencoded[2]).toBeCloseTo(expectedSrgb[2], 3);

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

  it("safely handles non-finite inputs without throwing unhandled exceptions", () => {
    const midColor = scalarColorRgb(0.5, "viridis");

    const nanColor = scalarColorRgb(Number.NaN, "viridis");
    expect(nanColor[0]).toBeCloseTo(midColor[0], 5);
    expect(nanColor[1]).toBeCloseTo(midColor[1], 5);
    expect(nanColor[2]).toBeCloseTo(midColor[2], 5);

    const posInfColor = scalarColorRgb(Number.POSITIVE_INFINITY, "viridis");
    expect(posInfColor).toEqual(midColor);

    const negInfColor = scalarColorRgb(Number.NEGATIVE_INFINITY, "viridis");
    expect(negInfColor).toEqual(midColor);
  });
});

describe("scalarColorSrgb · sRGB reference palette for 2D canvas", () => {
  it("returns literal sRGB stop values for viridis endpoints", () => {
    const [r0, g0, b0] = scalarColorSrgb(0, "viridis");
    expect(r0).toBeCloseTo(0x44 / 255, 4);
    expect(g0).toBeCloseTo(0x01 / 255, 4);
    expect(b0).toBeCloseTo(0x54 / 255, 4);

    const [r1, g1, b1] = scalarColorSrgb(1, "viridis");
    expect(r1).toBeCloseTo(0xfd / 255, 4);
    expect(g1).toBeCloseTo(0xe7 / 255, 4);
    expect(b1).toBeCloseTo(0x25 / 255, 4);
  });

  it("safely handles non-finite inputs without throwing unhandled exceptions", () => {
    const nanColor = scalarColorSrgb(Number.NaN, "viridis");
    const midColor = scalarColorSrgb(0.5, "viridis");
    expect(nanColor[0]).toBeCloseTo(midColor[0], 5);
    expect(nanColor[1]).toBeCloseTo(midColor[1], 5);
    expect(nanColor[2]).toBeCloseTo(midColor[2], 5);
  });

  it("maintains mathematical parity with scalarColorRgb for all palettes", () => {
    const srgbChannelToLinear = (c: number): number =>
      c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

    const palettes = ["coolwarm", "inferno", "jet", "magma", "viridis"] as const;
    for (const palette of palettes) {
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const [sR, sG, sB] = scalarColorSrgb(t, palette);
        const [lR, lG, lB] = scalarColorRgb(t, palette);

        expect(lR).toBeCloseTo(srgbChannelToLinear(sR), 6);
        expect(lG).toBeCloseTo(srgbChannelToLinear(sG), 6);
        expect(lB).toBeCloseTo(srgbChannelToLinear(sB), 6);
      }
    }
  });
});
