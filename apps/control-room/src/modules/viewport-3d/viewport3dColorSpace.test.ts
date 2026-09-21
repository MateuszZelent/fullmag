import { describe, expect, it } from "vitest";

import {
  linearToSrgbChannel,
  srgbToLinearChannel,
  srgbToLinearRgb,
} from "./viewport3dColorSpace";

describe("viewport3dColorSpace", () => {
  it("keeps 0 and 1 as fixed points", () => {
    expect(srgbToLinearChannel(0)).toBe(0);
    expect(srgbToLinearChannel(1)).toBe(1);
    expect(linearToSrgbChannel(0)).toBe(0);
    expect(linearToSrgbChannel(1)).toBeCloseTo(1, 12);
  });

  it("darkens mid-tones, which is the whole point", () => {
    // 0.5 sRGB is 0.214 linear. Uploading 0.5 unconverted made three.js encode
    // it back out as 0.735 -- the wash towards white this module exists to
    // prevent.
    expect(srgbToLinearChannel(0.5)).toBeCloseTo(0.214041, 6);
    expect(linearToSrgbChannel(0.5)).toBeCloseTo(0.735357, 6);
  });

  it("round-trips through the inverse transfer function", () => {
    for (const value of [0, 0.01, 0.04045, 0.2, 0.5, 0.8, 1]) {
      // The two thresholds in the sRGB standard (0.04045 and 0.0031308) are
      // not exact inverses of one another, so the round trip is good to about
      // 1e-8 rather than to the last bit.
      expect(linearToSrgbChannel(srgbToLinearChannel(value))).toBeCloseTo(
        value,
        6,
      );
    }
  });

  it("converts a triple channel by channel", () => {
    expect(srgbToLinearRgb([1, 0.5, 0])).toEqual([
      srgbToLinearChannel(1),
      srgbToLinearChannel(0.5),
      srgbToLinearChannel(0),
    ]);
  });
});
