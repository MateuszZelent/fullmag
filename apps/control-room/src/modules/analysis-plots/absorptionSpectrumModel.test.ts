import { describe, expect, it } from "vitest";

import { parseAbsorptionSpectrum } from "./absorptionSpectrumModel";

describe("imported RF absorption spectrum", () => {
  it("preserves physical watts and finds the largest sampled value of each drive profile", () => {
    const spectrum = parseAbsorptionSpectrum(
      "frequency_Hz,uniform_y_W,gradient_y_z_W\n0,-1e-16,0\n5.85e9,2e-16,6.5e-16\n6.162e9,4e-16,3e-16",
      "absorption-vs-frequency.csv",
    );

    expect(spectrum.sampleCount).toBe(3);
    expect(spectrum.powerDisplayUnit).toBe("fW");
    expect(spectrum.profiles.map(({ peak, series }) => [series.label, series.unit, peak])).toEqual([
      ["Uniform y", "W", { rowIndex: 2, x: 6.162e9, y: 4e-16 }],
      ["Gradient y z", "W", { rowIndex: 1, x: 5.85e9, y: 6.5e-16 }],
    ]);
    expect(spectrum.profiles[0]?.series.points[0]).toEqual({ rowIndex: 0, x: 0, y: -1e-16 });
  });

  it.each([
    ["frequency_Hz,drive_projected_proxy\n0,0\n1,1", /ending in _W/],
    ["frequency_Hz,uniform_y_W\n0,0\n0,1", /strictly increasing/],
    ["frequency_Hz,uniform_y_W\n-1,0\n1,1", /non-negative/],
    ["frequency_Hz,uniform_y_W\n0,0\n1,NaN\n2,1", /finite/],
    ["frequency_Hz,uniform_y_W,uniform_y_W\n0,0,1\n1,1,2", /unique/],
    ["frequency_Hz,uniform_y_W\n0,0", /at least two/],
  ])("rejects invalid input %s", (csv, message) => {
    expect(() => parseAbsorptionSpectrum(csv, "spectrum.csv")).toThrow(message);
  });
});
