import { describe, expect, it } from "vitest";

import { fmrModalSpectrumSelectionOwner } from "./FmrModalSpectrumInspectorModel";

describe("FMR modal spectrum Results owner propagation", () => {
  const manifest = {
    result_manifest: {
      payload: {
        run_id: "run-1",
        stage_id: "stage-1",
      },
    },
  };

  it("propagates run and stage only when the spectrum artifact agrees with its manifest", () => {
    expect(fmrModalSpectrumSelectionOwner(manifest, {
      run_id: "run-1",
      stage_id: "stage-1",
    })).toEqual({
      analysisRunId: "run-1",
      analysisStageId: "stage-1",
    });
  });

  it.each([
    ["run", { run_id: "foreign-run", stage_id: "stage-1" }],
    ["stage", { run_id: "run-1", stage_id: "foreign-stage" }],
    ["missing owner", {}],
  ])("does not attach a mismatched or incomplete %s", (_label, spectrum) => {
    expect(fmrModalSpectrumSelectionOwner(manifest, spectrum)).toBeNull();
  });

  it("rejects a current resource owner when the Inspector selected another run or stage", () => {
    const spectrum = { run_id: "run-1", stage_id: "stage-1" };
    for (const [runId, stageId] of [["other-run", "stage-1"], ["run-1", "other-stage"]]) {
      expect(fmrModalSpectrumSelectionOwner(manifest, spectrum, {
        kind: "results.resonance.modal.spectrum",
        label: "Selected spectrum",
        nodeId: "selected-spectrum",
        objectId: null,
        moduleSource: "analysis.resonance",
        ref: {
          type: "frequency-domain",
          kind: "results.resonance.modal.spectrum",
          analysisRunId: runId,
          analysisStageId: stageId,
          nodeId: "selected-spectrum",
        },
      })).toBeNull();
    }
  });

  it("does not infer owner fields from the spectrum when the manifest has no identity", () => {
    expect(fmrModalSpectrumSelectionOwner(
      { result_manifest: { payload: {} } },
      { run_id: "run-1", stage_id: "stage-1" },
    )).toBeNull();
  });
});
