import { describe, expect, it } from "vitest";

import type {
  FmrPeakPoint,
  FrequencyResponsePoint,
} from "@/shared/domain/analysis/frequencyDomainChartModels";

import { buildFmrResponseSweepViewModel } from "./FmrResponseSweepModel";

const responsePoint: FrequencyResponsePoint = {
  absorbedPowerDensity: 42,
  amplitude: 1.5,
  fieldId: "response-field-0",
  frequencyIndex: 0,
  frequencyHz: 9.5e9,
  observableId: "mx",
  overlap: null,
  phaseRad: 0.1,
  residualNorm: 1e-8,
  susceptibility: null,
};

const responsePeak: FmrPeakPoint = {
  absorbedPowerDensity: 42,
  amplitude: 1.5,
  fieldId: "response-field-0",
  fieldResourceKey: "field://response-field-0",
  frequencyHz: 9.5e9,
  frequencyPointIndex: 0,
  linewidthHz: null,
  modeRef: null,
  overlap: null,
  phaseRad: 0.1,
  source: "driven_response",
  validationStatus: "unavailable",
};

describe("FMR response sweep view model", () => {
  it("keeps response axes, progress and linked field handoff semantics", () => {
    const model = buildFmrResponseSweepViewModel({
      peaks: [responsePeak],
      points: [responsePoint],
      progress: {
        complete: false,
        completedFrequencyPoints: 1,
        currentFrequencyHz: 9.5e9,
        partialArtifactsAvailable: true,
        state: "running",
        status: "running",
        totalFrequencyPoints: 4,
      },
      resourceStatus: "ready",
      selectedFrequencyHz: 9.5e9,
    });

    expect(model).toMatchObject({
      canPlotSelectedFrequency: true,
      frequencyAxis: { label: "frequency", unit: "Hz" },
      responseAxes: [{ label: "observable", unit: "series-defined" }],
      responseState: "running",
      selectedFrequencyHz: 9.5e9,
    });
    expect(model.peaks).toEqual([
      expect.objectContaining({
        fieldAvailable: true,
        peak: responsePeak,
      }),
    ]);
    expect(model.progress).toEqual({
      complete: false,
      completedFrequencyPoints: 1,
      currentFrequencyHz: 9.5e9,
      partialArtifactsAvailable: true,
      state: "running",
      status: "running",
      totalFrequencyPoints: 4,
    });
  });

  it("fails closed for an unavailable selected response field", () => {
    const model = buildFmrResponseSweepViewModel({
      peaks: [],
      points: [{ ...responsePoint, fieldId: null }],
      progress: null,
      resourceStatus: "ready",
      selectedFrequencyHz: 9.5e9,
    });

    expect(model.canPlotSelectedFrequency).toBe(false);
    expect(model.responseState).toBe("ready");
  });

  it("keeps cancellation, refresh and error states distinct", () => {
    const cancelProgress = {
      complete: false,
      completedFrequencyPoints: 1,
      currentFrequencyHz: 9.5e9,
      partialArtifactsAvailable: true,
      state: "cancel_requested",
      status: "cancel_requested",
      totalFrequencyPoints: 4,
    } as const;

    expect(
      buildFmrResponseSweepViewModel({
        peaks: [],
        points: [],
        progress: cancelProgress,
        resourceStatus: "ready",
      }).responseState,
    ).toBe("cancel_requested");
    expect(
      buildFmrResponseSweepViewModel({
        peaks: [],
        points: [],
        progress: null,
        resourceStatus: "refreshing",
      }).responseState,
    ).toBe("refreshing");
    expect(
      buildFmrResponseSweepViewModel({
        peaks: [],
        points: [],
        progress: null,
        resourceStatus: "error",
      }).responseState,
    ).toBe("error");
  });
});
