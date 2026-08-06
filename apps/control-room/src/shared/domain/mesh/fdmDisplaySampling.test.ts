import { describe, expect, it } from "vitest";

import {
  FDM_DISPLAY_CELL_BUDGET,
  formatFdmDisplaySamplingSummary,
  resolveFdmDisplaySampling,
  sampleFdmDisplayCellIndices,
} from "./fdmDisplaySampling";

describe("FDM display sampling", () => {
  it("preserves the default display budget while exposing total, samples, and stride", () => {
    expect(FDM_DISPLAY_CELL_BUDGET).toBe(120_000);
    expect(resolveFdmDisplaySampling(300_000)).toEqual({
      budget: 120_000,
      displaySamples: 120_000,
      stride: 3,
      total: 300_000,
    });
  });

  it("formats explicit HUD provenance without implying reduced simulation data", () => {
    expect(formatFdmDisplaySamplingSummary(resolveFdmDisplaySampling(300_000))).toBe(
      "cells 300,000 · display samples 120,000 · stride 3 · budget 120,000",
    );
  });

  it("uses one global sample for all semantic FDM display passes", () => {
    expect(sampleFdmDisplayCellIndices(4, 2)).toEqual(
      new Uint32Array([0, 2]),
    );
    expect(sampleFdmDisplayCellIndices(5, 8)).toEqual(
      new Uint32Array([0, 1, 2, 3, 4]),
    );
  });
});
