import { describe, expect, it } from "vitest";

import type { EigenSpectrumPoint } from "@/shared/domain/analysis/frequencyDomainChartModels";

import { buildFmrModalSpectrumViewModel } from "./FmrModalSpectrumModel";

const points: EigenSpectrumPoint[] = [
  {
    branchId: "gamma",
    dampingRateHz: null,
    frequencyHz: 9.5e9,
    imaginaryFrequencyHz: null,
    modeFieldId: "mode-field-1",
    modeFieldResourceKey: "field://mode-1",
    rawModeIndex: 1,
    residualNorm: 1e-8,
    sampleIndex: 0,
    tangentLeakageMax: null,
  },
  {
    branchId: "gamma",
    dampingRateHz: null,
    frequencyHz: 12e9,
    imaginaryFrequencyHz: null,
    modeFieldId: null,
    modeFieldResourceKey: null,
    rawModeIndex: 2,
    residualNorm: null,
    sampleIndex: 0,
    tangentLeakageMax: null,
  },
];

describe("FMR modal spectrum view model", () => {
  it("publishes mode identity, field readiness, partial trust and provenance", () => {
    const model = buildFmrModalSpectrumViewModel({
      calculationMode: "fmr_modal",
      points,
      resourceKey: "frequency-domain/eigen-spectrum",
      selectedModeKey: "0:1",
      status: "ready",
    });

    expect(model).toMatchObject({
      canPlotSelectedMode: true,
      selectedModeKey: "0:1",
      trust: "partial",
    });
    expect(model.modes).toEqual([
      expect.objectContaining({
        fieldAvailable: true,
        fieldId: "mode-field-1",
        modeKey: "0:1",
        modeIndex: 1,
      }),
      expect.objectContaining({
        fieldAvailable: false,
        fieldId: null,
        modeKey: "0:2",
        modeIndex: 2,
      }),
    ]);
    expect(model.provenance).toEqual([
      { label: "Calculation mode", value: "fmr_modal" },
      { label: "Spectrum resource", value: "frequency-domain/eigen-spectrum" },
      { label: "Resource status", value: "ready" },
    ]);
  });

  it("fails closed when the selected mode has no linked field", () => {
    const model = buildFmrModalSpectrumViewModel({
      calculationMode: "fmr_modal",
      points,
      resourceKey: "frequency-domain/eigen-spectrum",
      selectedModeKey: "0:2",
      status: "ready",
    });

    expect(model.canPlotSelectedMode).toBe(false);
    expect(model.trust).toBe("partial");
  });
});
