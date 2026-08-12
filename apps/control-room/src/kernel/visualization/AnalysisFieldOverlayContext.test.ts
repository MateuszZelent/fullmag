import { describe, expect, it } from "vitest";

import { AnalysisFieldOverlayController } from "./AnalysisFieldOverlayController";

describe("AnalysisFieldOverlay result context", () => {
  it("preserves immutable result provenance and detects a foreign run", () => {
    const controller = new AnalysisFieldOverlayController();
    controller.set({
      fieldId: "mode-field",
      label: "Mode 1",
      provenance: {
        artifactRevision: 7,
        equilibriumId: "eq-1",
        kContextKind: "gamma",
        normalization: "unit_l2",
        runId: "run-1",
        stageId: "stage-eigen",
      },
      query: { view: "phase_rotated_real" },
      source: "eigen-mode",
    });

    expect(controller.getSnapshot()?.provenance).toMatchObject({
      artifactRevision: 7,
      equilibriumId: "eq-1",
      runId: "run-1",
      stageId: "stage-eigen",
    });
    expect(controller.belongsToResultContext("run-1")).toBe(true);
    expect(controller.belongsToResultContext("run-2")).toBe(false);
  });
});
