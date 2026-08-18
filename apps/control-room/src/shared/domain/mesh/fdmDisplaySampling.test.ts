import { describe, expect, it } from "vitest";

import {
  FDM_DISPLAY_CELL_BUDGET,
  formatFdmDisplaySamplingSummary,
  resolveFdmDisplaySampling,
  sampleFdmDisplayCellIndices,
  sampleFdmSpatialCellIndices,
} from "./fdmDisplaySampling";

describe("FDM display sampling", () => {
  it("preserves the default display budget while exposing total, samples, and stride", () => {
    expect(FDM_DISPLAY_CELL_BUDGET).toBe(150_000);
    expect(resolveFdmDisplaySampling(300_000)).toEqual({
      budget: 150_000,
      displaySamples: 150_000,
      stride: 2,
      total: 300_000,
    });
  });

  it("formats explicit HUD provenance without implying reduced simulation data", () => {
    expect(formatFdmDisplaySamplingSummary(resolveFdmDisplaySampling(300_000))).toBe(
      "cells 300,000 · display samples 150,000 · stride 2 · budget 150,000",
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

  it("distributes a flattened candidate stream across 3D spatial bins", () => {
    const candidates = new Uint32Array(
      Array.from({ length: 16 * 8 * 4 }, (_, index) => index),
    );

    const sampled = sampleFdmSpatialCellIndices(
      candidates,
      [16, 8, 4],
      64,
    );

    expect(sampled).toHaveLength(64);
    expect(new Set(sampled).size).toBe(64);

    const occupiedBins = new Set(
      Array.from(sampled, (cellIndex) => {
        const x = cellIndex % 16;
        const y = Math.floor(cellIndex / 16) % 8;
        const z = Math.floor(cellIndex / (16 * 8));
        return `${Math.floor(x / 4)}:${Math.floor(y / 2)}:${z}`;
      }),
    );
    expect(occupiedBins.size).toBe(64);
  });

  it("is deterministic and never returns more than the glyph budget", () => {
    const candidates = new Uint32Array(
      Array.from({ length: 32 * 16 * 8 }, (_, index) => index),
    );

    const first = sampleFdmSpatialCellIndices(candidates, [32, 16, 8], 97);
    const second = sampleFdmSpatialCellIndices(candidates, [32, 16, 8], 97);

    expect(first).toEqual(second);
    expect(first.length).toBe(97);
    expect(new Set(first).size).toBe(first.length);
  });
});
