import { describe, expect, it } from "vitest";

import { AnalysisFieldOverlayController } from "./AnalysisFieldOverlayController";

describe("AnalysisFieldOverlay result context", () => {
  it("preserves the complete immutable result identity", () => {
    const controller = ownedOverlayController();

    expect(controller.getSnapshot()).toMatchObject({
      fieldId: "mode-field",
      frequencyHz: 12.5e9,
      frequencyIndex: 4,
      modeIndex: 1,
      provenance: {
        artifactRevision: 7,
        equilibriumId: "eq-1",
        kContextKind: "gamma",
        normalization: "unit_l2",
        representation: "complex-vector-xyz",
        resourceRef: "data/fields/mode-field",
        runId: "run-1",
        stageId: "stage-eigen",
        studyProduct: "modal_eigen",
      },
      query: { phase_rad: 0.25, view: "phase_rotated_real" },
      sampleIndex: 0,
      source: "eigen-mode",
      visualizationPhaseRad: 0.25,
      wavevectorKf: [0, 0, 0],
    });
  });

  it("makes a foreign overlay non-renderable when result context changes", () => {
    const controller = ownedOverlayController();

    controller.setResultContext("run-1");
    expect(controller.getContextSnapshot().status).toBe("compatible");
    expect(controller.getRenderableSnapshot()?.fieldId).toBe("mode-field");

    controller.setResultContext("run-2");
    expect(controller.getContextSnapshot()).toMatchObject({
      resultRunId: "run-2",
      status: "foreign",
    });
    expect(controller.getRenderableSnapshot()).toBeNull();
    expect(controller.getSnapshot()?.fieldId).toBe("mode-field");
  });

  it("treats missing required owner identity as unverified", () => {
    const controller = new AnalysisFieldOverlayController();
    controller.setResultContext("run-1");
    controller.set({
      fieldId: "mode-field",
      label: "Mode 1",
      query: { phase_rad: 0, view: "phase_rotated_real" },
      source: "eigen-mode",
    });

    expect(controller.getContextSnapshot().status).toBe("unverified");
    expect(controller.getRenderableSnapshot()).toBeNull();
    expect(controller.belongsToResultContext("run-1")).toBe(false);
  });

  it.each([
    ["frequency", { frequencyHz: undefined }],
    ["artifact revision", { provenance: { artifactRevision: "unknown" } }],
  ] as const)("fails closed when exact %s identity is unavailable", (_label, change) => {
    const controller = ownedOverlayController();
    controller.setResultContext("run-1");
    const current = controller.getSnapshot()!;
    controller.set({
      ...current,
      ...change,
      provenance: {
        ...current.provenance,
        ...("provenance" in change ? change.provenance : {}),
      },
    });

    expect(controller.getContextSnapshot().status).toBe("unverified");
    expect(controller.getRenderableSnapshot()).toBeNull();
  });

  it.each([
    ["fixed_k without an exact vector", "fixed_k", undefined, undefined, 0],
    ["fixed_k with a zero vector", "fixed_k", [0, 0, 0], undefined, 0],
    ["k_path without an exact vector", "k_path", undefined, 2.5e7, 2],
    ["k_path without a path coordinate", "k_path", [2.5e7, 0, 0], undefined, 2],
    ["k_grid without an exact vector", "k_grid", undefined, undefined, 2],
    ["gamma with a nonzero vector", "gamma", [1, 0, 0], undefined, 0],
  ] as const)("fails closed for %s", (_label, kContextKind, wavevectorKf, kPathCoordinateRadPerM, sampleIndex) => {
    const controller = ownedOverlayController();
    controller.setResultContext("run-1");
    controller.set({
      ...controller.getSnapshot()!,
      ...(kPathCoordinateRadPerM === undefined ? {} : { kPathCoordinateRadPerM }),
      provenance: {
        ...controller.getSnapshot()!.provenance,
        kContextKind,
      },
      sampleIndex,
      ...(wavevectorKf === undefined ? { wavevectorKf: undefined } : { wavevectorKf: [...wavevectorKf] }),
    });

    expect(controller.getContextSnapshot().status).toBe("unverified");
    expect(controller.getRenderableSnapshot()).toBeNull();
  });

  it("clears both the stored and renderable overlay", () => {
    const controller = ownedOverlayController();
    controller.setResultContext("run-1");

    controller.clear();

    expect(controller.getSnapshot()).toBeNull();
    expect(controller.getRenderableSnapshot()).toBeNull();
    expect(controller.getContextSnapshot().status).toBe("inactive");
  });
});

function ownedOverlayController(): AnalysisFieldOverlayController {
  const controller = new AnalysisFieldOverlayController();
  controller.set({
    fieldId: "mode-field",
    frequencyHz: 12.5e9,
    frequencyIndex: 4,
    label: "Mode 1",
    modeIndex: 1,
    provenance: {
      artifactRevision: 7,
      equilibriumId: "eq-1",
      kContextKind: "gamma",
      normalization: "unit_l2",
      representation: "complex-vector-xyz",
      resourceRef: "data/fields/mode-field",
      runId: "run-1",
      stageId: "stage-eigen",
      studyProduct: "modal_eigen",
    },
    query: { phase_rad: 0.25, view: "phase_rotated_real" },
    sampleIndex: 0,
    source: "eigen-mode",
    visualizationPhaseRad: 0.25,
    wavevectorKf: [0, 0, 0],
  });

  return controller;
}
