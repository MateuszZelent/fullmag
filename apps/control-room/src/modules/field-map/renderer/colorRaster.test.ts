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
});
