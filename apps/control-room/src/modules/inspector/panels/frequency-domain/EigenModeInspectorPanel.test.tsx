import { describe, expect, it } from "vitest";

import type { AnalysisFieldOverlayState } from "@/kernel/visualization/AnalysisFieldOverlayController";

import {
  buildEigenModeIdentityViewModel,
  formatSignedWavevectorKf,
  isCurrentEigenModeOverlay,
  phaseRadForEigenModeViewChange,
  type EigenModeOverlayIdentity,
} from "./EigenModeInspectorModel";

const selectedMode: EigenModeOverlayIdentity = {
  analysisRunId: "run-7",
  analysisStageId: "eigen-stage-7",
  artifactRevision: "sha256:eigen-v7",
  fieldId: "analysis:eigen:sample-0004:mode-0005",
  frequencyHz: 12.5e9,
  kPathCoordinateRadPerM: -2e7,
  modeId: "mode-0005",
  modeIndex: 5,
  nodeId: "results:eigen:sample-0004:mode-0005",
  sampleId: "sample-0004",
  sampleIndex: 4,
  wavevectorKf: [-2e7, 0, 1.25e7],
};

function activeEigenOverlay(
  target: EigenModeOverlayIdentity = selectedMode,
): AnalysisFieldOverlayState {
  return {
    fieldId: target.fieldId ?? "",
    frequencyHz: target.frequencyHz ?? undefined,
    kPathCoordinateRadPerM: target.kPathCoordinateRadPerM ?? undefined,
    label: "sample 4, mode 5",
    modeIndex: target.modeIndex ?? undefined,
    modeIntent: {
      analysisRunId: target.analysisRunId ?? "",
      analysisStageId: target.analysisStageId ?? "",
      artifactRevision: String(target.artifactRevision ?? ""),
      fieldId: target.fieldId ?? "",
      metadataResourceKey: "analysis/frequency-domain/eigen/mode-0005/meta",
      modeId: target.modeId ?? "",
      modeIndex: target.modeIndex ?? -1,
      nodeId: target.nodeId ?? "",
      sampleId: target.sampleId ?? "",
      sampleIndex: target.sampleIndex ?? -1,
    },
    query: { phase_rad: 0.25, view: "real" },
    sampleIndex: target.sampleIndex ?? undefined,
    source: "eigen-mode",
    visualizationPhaseRad: 1.75,
    wavevectorKf: target.wavevectorKf ? [...target.wavevectorKf] : undefined,
  };
}

describe("EigenModeInspectorPanel identity model", () => {
  it("keeps mode index, branch and field provenance together", () => {
    expect(
      buildEigenModeIdentityViewModel({
        branchId: "acoustic",
        fieldId: "analysis:eigen:sample-0004:mode-0005",
        modeId: "mode-0005",
        modeIndex: 5,
        resourceRef: "field://mode-0005",
        sampleId: "sample-0004",
        sampleIndex: 4,
      }),
    ).toEqual({
      branchId: "acoustic",
      fieldId: "analysis:eigen:sample-0004:mode-0005",
      label: "sample 4, mode 5",
      modeId: "mode-0005",
      modeIndex: 5,
      resourceRef: "field://mode-0005",
      sampleId: "sample-0004",
      sampleIndex: 4,
    });
  });

  it("fails closed when a mode selection is incomplete", () => {
    expect(buildEigenModeIdentityViewModel({ modeIndex: 5 })).toMatchObject({
      label: "not selected",
      modeIndex: 5,
      sampleIndex: null,
    });
  });

  it("only treats an overlay with the selected mode identity as current", () => {
    expect(isCurrentEigenModeOverlay(activeEigenOverlay(), selectedMode)).toBe(
      true,
    );
    expect(
      isCurrentEigenModeOverlay(
        activeEigenOverlay({ ...selectedMode, modeId: "mode-0006", modeIndex: 6 }),
        selectedMode,
      ),
    ).toBe(false);
    expect(isCurrentEigenModeOverlay(null, selectedMode)).toBe(false);
  });

  it("preserves the selected mode phase when changing its view", () => {
    const overlay = activeEigenOverlay();
    expect(phaseRadForEigenModeViewChange(overlay, selectedMode)).toBe(1.75);
    expect(
      phaseRadForEigenModeViewChange(
        overlay,
        { ...selectedMode, sampleIndex: 3, sampleId: "sample-0003" },
      ),
    ).toBe(0);
  });

  it("formats a signed k vector only when all three coordinates are present", () => {
    expect(formatSignedWavevectorKf(selectedMode.wavevectorKf)).toBe(
      "[−2.000e+7, 0, +1.250e+7] rad/m",
    );
    expect(formatSignedWavevectorKf([1, 2])).toBe("not available");
  });
});
