import { describe, expect, it } from "vitest";

import type { EigenDispersionPoint } from "@/shared/domain/analysis/frequencyDomainChartModels";

import { buildEigenDispersionPointViewModel } from "./EigenDispersionInspectorModel";

const point: EigenDispersionPoint = {
  analyticFrequencyHz: 12.45e9,
  branchId: "acoustic",
  frequencyHz: 12.5e9,
  linewidthHz: 24e6,
  modeFieldId: "analysis:eigen:sample-0004:mode-0005",
  modeFieldResourceKey: "field://mode-0005",
  overlap: 0.98,
  pathS: 78_539_816.33974482,
  rawModeIndex: 5,
  relativeError: 0.004,
  residualNorm: 1e-6,
  sampleLabel: "X",
  sampleIndex: 4,
  validationGeometry: "backward_volume",
};

describe("EigenDispersionInspectorPanel point model", () => {
  it("keeps path coordinate in rad/m while frequency and linewidth stay in Hz", () => {
    expect(buildEigenDispersionPointViewModel(point)).toEqual({
      branchId: "acoustic",
      fieldAvailable: true,
      frequencyHz: 12.5e9,
      kLabel: "X",
      linewidthHz: 24e6,
      pathCoordinate: 78_539_816.33974482,
      pathUnit: "rad/m",
      pointId: "results:eigen:dispersion:sample:4:mode:5",
    });
  });
});
