import { describe, expect, it } from "vitest";

import type { EigenBranchPoint } from "@/shared/domain/analysis/frequencyDomainChartModels";

import { buildEigenBranchPointViewModel } from "./EigenBranchInspectorPanel";

const point: EigenBranchPoint = {
  frequencyImagHz: -14e6,
  frequencyRealHz: 13.1e9,
  modeFieldId: null,
  modeFieldResourceKey: null,
  overlapPrev: 0.97,
  rawModeIndex: 1,
  residualNorm: 2e-8,
  sampleIndex: 1,
  trackingConfidence: 0.98,
};

describe("EigenBranchInspectorPanel point model", () => {
  it("preserves branch, sample, mode and missing-field identity", () => {
    expect(buildEigenBranchPointViewModel("acoustic", point)).toEqual({
      branchId: "acoustic",
      fieldAvailable: false,
      frequencyHz: 13.1e9,
      modeIndex: 1,
      pointId: "results:eigen:branch:acoustic:sample:1:mode:1",
      sampleIndex: 1,
    });
  });
});
