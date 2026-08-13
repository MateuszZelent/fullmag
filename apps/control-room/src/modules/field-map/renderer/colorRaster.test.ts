import { describe, expect, it } from "vitest";

import { colorizeScalarRaster, finiteScalarRange } from "./colorRaster";

describe("scalar raster colorization", () => {
  it("ignores masked and non-finite samples when resolving automatic range", () => {
    expect(
      finiteScalarRange([Number.NaN, -2, 4, 100], [0, 0, 0, 1]),
    ).toEqual({ max: 4, min: -2 });
  });

  it("writes transparent masked pixels and opaque finite samples", () => {
    const pixels = colorizeScalarRaster(
      new Float32Array([0, 1]),
      { max: 1, min: 0 },
      new Uint8Array([0, 1]),
    );
    expect([...pixels]).toEqual([0, 0, 255, 255, 0, 0, 0, 0]);
  });

  it("renders partial and overlap-ambiguous support while masking empty and undefined", () => {
    const values = new Float32Array([0, 1, 2, 3, 4]);
    const mask = new Uint8Array([0, 1, 2, 3, 4]);

    expect(finiteScalarRange(values, mask)).toEqual({ max: 4, min: 0 });
    const pixels = colorizeScalarRaster(values, { max: 4, min: 0 }, mask);
    expect([0, 1, 2, 3, 4].map((index) => pixels[index * 4 + 3])).toEqual([
      255,
      0,
      255,
      0,
      255,
    ]);
  });

  it("uses colormap and opacity as presentation-only color inputs", () => {
    expect(
      [...colorizeScalarRaster([0, 1], { max: 1, min: 0 }, undefined, {
        colormap: "grayscale",
        opacity: 0.5,
      })],
    ).toEqual([0, 0, 0, 128, 255, 255, 255, 128]);
  });

  it("uses the deterministic zero range for empty support and rejects invalid opacity", () => {
    expect(finiteScalarRange([Number.NaN], [1])).toEqual({ min: 0, max: 0 });
    expect(() => colorizeScalarRaster([1], { min: 0, max: 1 }, undefined, { opacity: 2 })).toThrow(
      "Planar raster opacity must be finite and within [0, 1]",
    );
  });
});
