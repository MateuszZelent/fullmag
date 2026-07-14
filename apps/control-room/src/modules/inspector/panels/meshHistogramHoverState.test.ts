import { describe, expect, it } from "vitest";

import {
  buildMeshSizeDistributionHoverBin,
  meshSizeDistributionHoverKey,
  resolveActiveHistogramBinIndex,
} from "./meshHistogramHoverState";

describe("resolveActiveHistogramBinIndex", () => {
  it("uses the same semantic key for equivalent Recharts payload allocations", () => {
    expect(
      meshSizeDistributionHoverKey({
        binLabel: "4 nm to 8 nm",
        count: 20,
        distributionId: "tetra_size",
        distributionLabel: "Tetra size",
        fraction: 0.4,
        hi: 8e-9,
        lo: 4e-9,
        binIndex: 4,
      }),
    ).toBe(
      meshSizeDistributionHoverKey({
        binLabel: "4 nm to 8 nm",
        count: 20,
        distributionId: "tetra_size",
        distributionLabel: "Tetra size",
        fraction: 0.4,
        hi: 8e-9,
        lo: 4e-9,
        binIndex: 4,
      }),
    );
    expect(meshSizeDistributionHoverKey(null)).toBe("none");
  });

  it("returns the active tooltip index for hovered histogram columns", () => {
    expect(
      resolveActiveHistogramBinIndex(
        {
          activeTooltipIndex: 1,
          isTooltipActive: true,
        },
        3,
      ),
    ).toBe(1);
  });

  it("accepts string tooltip indices from recharts state", () => {
    expect(
      resolveActiveHistogramBinIndex(
        {
          activeTooltipIndex: "2",
          isTooltipActive: true,
        },
        4,
      ),
    ).toBe(2);
  });

  it("ignores inactive or out-of-range tooltip states", () => {
    expect(
      resolveActiveHistogramBinIndex(
        {
          activeTooltipIndex: 0,
          isTooltipActive: false,
        },
        4,
      ),
    ).toBeNull();

    expect(
      resolveActiveHistogramBinIndex(
        {
          activeTooltipIndex: 5,
          isTooltipActive: true,
        },
        4,
      ),
    ).toBeNull();
  });

  it("builds a mesh hover payload from the active histogram bin", () => {
    expect(
      buildMeshSizeDistributionHoverBin(
        {
          id: "tetra_size",
          histogram: [
            {
              count: 9,
              fraction: 0.375,
              hi: 3e-9,
              label: "1 nm to 3 nm",
              lo: 1e-9,
            },
          ],
          label: "Tetra size",
          max: 3e-9,
          mean: 2e-9,
          min: 1e-9,
          ratio: 3,
          std: 0.5e-9,
        },
        0,
      ),
    ).toEqual({
      binIndex: 0,
      binLabel: "1 nm to 3 nm",
      count: 9,
      distributionId: "tetra_size",
      distributionLabel: "Tetra size",
      fraction: 0.375,
      hi: 3e-9,
      lo: 1e-9,
    });
  });
});
