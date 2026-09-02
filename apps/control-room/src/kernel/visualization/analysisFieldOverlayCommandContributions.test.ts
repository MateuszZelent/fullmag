import { describe, expect, it } from "vitest";

import { CommandRegistry } from "../commands/CommandRegistry";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { LayoutController } from "../layout/LayoutController";
import { SelectionController } from "../selection/SelectionController";
import { analysisResultSelectionRef } from "@/shared/domain/analysis/results";

import { AnalysisFieldOverlayController } from "./AnalysisFieldOverlayController";
import { ANALYSIS_FIELD_OVERLAY_COMMANDS } from "./analysisFieldOverlayCommandContributions";

function commandRegistry(): CommandRegistry {
  const commands = new CommandRegistry();
  for (const command of ANALYSIS_FIELD_OVERLAY_COMMANDS) {
    commands.register(command);
  }
  return commands;
}

const analysisResultFieldRef = {
  field_id: "analysis:eigen:sample-0001:mode-0002",
  field_revision: "sha256:field-v1",
  mesh_ref: {
    mesh_id: "mesh:shared-domain",
    mesh_revision: "41",
    topology_fingerprint: "sha256:topology-v1",
  },
  quantity_id: "m",
  representation: "complex-vector-xyz",
  resource_key: "data/fields/analysis-eigen-sample-0001-mode-0002",
  status: "ready",
} as const;

function analysisResultSelection(
  itemKind: "eigen_mode" | "spectral_feature" = "eigen_mode",
) {
  return analysisResultSelectionRef({
    datasetId: "result:run-result:stage-result:modal-eigen",
    datasetRevision: "sha256:dataset-v1",
    fieldId: analysisResultFieldRef.field_id,
    fieldRef: analysisResultFieldRef,
    fieldRevision: analysisResultFieldRef.field_revision,
    focus: "item",
    itemId: itemKind === "eigen_mode" ? "mode-0002" : "peak-0002",
    itemKind,
    runId: "run-result",
    sampleId: "sample-0001",
    sampleIndex: 1,
    stageId: "stage-result",
  });
}

describe("analysis field overlay commands", () => {
  it("hands a result item field reference to the shared eigen overlay intent", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    const ref = analysisResultSelection();
    selection.set(
      {
        kind: "analysis.result",
        label: "Mode 2",
        nodeId: ref.nodeId,
        objectId: null,
        ref,
      },
      "results-navigator",
    );

    const result = await commands.execute("analysis.eigen.plot-mode-3d", {
      analysisFieldOverlay: overlay,
      selection,
      source: "test",
    });

    expect(result.status).toBe("completed");
    expect(overlay.getSnapshot()).toMatchObject({
      analysisResultFieldIntent: {
        datasetId: ref.datasetId,
        datasetRevision: ref.datasetRevision,
        fieldId: analysisResultFieldRef.field_id,
        fieldRevision: analysisResultFieldRef.field_revision,
        itemId: ref.itemId,
        source: "eigen-mode",
      },
      provenance: {
        datasetId: ref.datasetId,
        datasetRevision: ref.datasetRevision,
        fieldRevision: analysisResultFieldRef.field_revision,
        runId: ref.runId,
        stageId: ref.stageId,
      },
      source: "eigen-mode",
    });
  });

  it("fails closed for a spectrum-only result item", () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    const ref = analysisResultSelectionRef({
      datasetId: "result:run-result:stage-result:modal-eigen",
      datasetRevision: "sha256:dataset-v1",
      focus: "item",
      itemId: "mode-only",
      itemKind: "eigen_mode",
      runId: "run-result",
      sampleId: "sample-0001",
      stageId: "stage-result",
    });
    selection.set(
      {
        kind: "analysis.result",
        label: "Spectrum only",
        nodeId: ref.nodeId,
        objectId: null,
        ref,
      },
      "results-navigator",
    );
    const context = { analysisFieldOverlay: overlay, selection, source: "test" } as const;

    expect(commands.isEnabled("analysis.eigen.plot-mode-3d", context)).toBe(false);
    expect(
      commands.get("analysis.eigen.plot-mode-3d")?.disabledReason?.(context),
    ).toBe("Selected result item has no published spatial field reference.");
  });

  it("maps a typed spectral feature field to the time-domain response source", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    const ref = analysisResultSelection("spectral_feature");
    selection.set(
      {
        kind: "analysis.result",
        label: "Spectral peak",
        nodeId: ref.nodeId,
        objectId: null,
        ref,
      },
      "results-navigator",
    );

    const result = await commands.execute(
      "analysis.time-domain.plot-response-field-3d-abs",
      { analysisFieldOverlay: overlay, selection, source: "test" },
    );

    expect(result.status).toBe("completed");
    expect(overlay.getSnapshot()).toMatchObject({
      analysisResultFieldIntent: { itemKind: "spectral_feature", source: "time-domain-response" },
      source: "time-domain-response",
      provenance: { studyProduct: "time_domain_spectrum" },
      query: { view: "abs" },
    });
  });

  it("plots an eigen mode field through the shared analysis field controller", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();

    const result = await commands.execute(
      "analysis.eigen.plot-mode-3d",
      {
        analysisFieldOverlay: overlay,
        source: "test",
      },
      {
        fieldId: "analysis:eigen:sample-0000:mode-0002",
        label: "Mode 2",
        phaseRad: 0.5,
        source: "eigen-mode",
        view: "phase_rotated_real",
      },
    );

    expect(result.status).toBe("completed");
    expect(overlay.getSnapshot()).toEqual({
      appearance: {
        shaderVisible: true,
        surfaceColorSource: "magnitude",
      },
      fieldId: "analysis:eigen:sample-0000:mode-0002",
      label: "Mode 2",
      query: {
        component: "full",
        phase_rad: 0.5,
        scope_kind: "full",
        view: "phase_rotated_real",
      },
      source: "eigen-mode",
      visualizationPhaseRad: 0.5,
    });
  });

  it.each([
    ["real", "real"],
    ["imag", "imag"],
    ["abs", "abs"],
    ["amplitude", "abs"],
    ["complex", "abs"],
    ["phase", "phase"],
  ])(
    "plots complex analysis field view %s as %s",
    async (requestedView, expectedView) => {
      const commands = commandRegistry();
      const overlay = new AnalysisFieldOverlayController();

      const result = await commands.execute(
        "analysis.eigen.plot-mode-3d",
        {
          analysisFieldOverlay: overlay,
          source: "test",
        },
        {
          fieldId: "analysis:eigen:sample-0000:mode-0002",
          label: "Mode 2",
          source: "eigen-mode",
          view: requestedView,
        },
      );

      expect(result.status).toBe("completed");
      expect(overlay.getSnapshot()?.query.view).toBe(expectedView);
      expect(overlay.getSnapshot()?.appearance).toMatchObject({
        shaderVisible: true,
        surfaceColorSource: "magnitude",
      });
    },
  );

  it("plots selected eigen mode with a fixed context-menu view command", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    selection.set(
      {
        kind: "results.eigen.mode",
        label: "Mode 2",
        nodeId: "results:eigen:sample:0:mode:2",
        objectId: null,
        ref: {
          fieldId: "analysis:eigen:sample-0000:mode-0002",
          kind: "results.eigen.mode",
          modeIndex: 2,
          nodeId: "results:eigen:sample:0:mode:2",
          sampleIndex: 0,
          type: "frequency-domain",
        },
      },
      "test",
    );

    const result = await commands.execute(
      "analysis.eigen.plot-mode-3d-imag",
      {
        analysisFieldOverlay: overlay,
        selection,
        source: "test",
      },
    );

    expect(result.status).toBe("completed");
    expect(overlay.getSnapshot()).toMatchObject({
      fieldId: "analysis:eigen:sample-0000:mode-0002",
      query: {
        view: "imag",
      },
      source: "eigen-mode",
    });
  });

  it("hands a canonical eigenmode SelectionRef to the overlay as a stable mode intent", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    selection.set(
      {
        kind: "results.eigen.mode",
        label: "Mode 2",
        nodeId: "results:eigen:sample-k0:mode-2",
        objectId: null,
        ref: {
          analysisRunId: "run-k0",
          analysisStageId: "stage-eigen",
          artifactRevision: "sha256:artifact-v1",
          fieldId: "analysis:eigen:sample-k0:mode-2:delta_m_xyz",
          kind: "results.eigen.mode",
          modeId: "mode-2",
          modeIndex: 2,
          nodeId: "results:eigen:sample-k0:mode-2",
          sampleId: "sample-k0",
          sampleIndex: 0,
          type: "frequency-domain",
        },
      },
      "test",
    );

    const result = await commands.execute(
      "analysis.eigen.plot-mode-3d",
      {
        analysisFieldOverlay: overlay,
        selection,
        source: "test",
      },
    );

    expect(result.status).toBe("completed");
    expect(overlay.getSnapshot()?.modeIntent).toMatchObject({
      artifactRevision: "sha256:artifact-v1",
      modeId: "mode-2",
      sampleId: "sample-k0",
    });
  });

  it("activates the 3D viewport when plotting a selected analysis field", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();
    const events = new EventBus<KernelEventMap>();
    const layout = new LayoutController(events);
    const selection = new SelectionController(events);
    layout.setActiveViewportMainModule("analysis-plots");
    selection.set(
      {
        kind: "results.eigen.mode",
        label: "Mode 2",
        nodeId: "results:eigen:sample:0:mode:2",
        objectId: null,
        ref: {
          fieldId: "analysis:eigen:sample-0000:mode-0002",
          kind: "results.eigen.mode",
          modeIndex: 2,
          nodeId: "results:eigen:sample:0:mode:2",
          sampleIndex: 0,
          type: "frequency-domain",
        },
      },
      "test",
    );

    const result = await commands.execute(
      "analysis.eigen.plot-mode-3d-imag",
      {
        analysisFieldOverlay: overlay,
        layout,
        selection,
        source: "test",
      },
    );

    expect(result.status).toBe("completed");
    expect(overlay.getSnapshot()?.query.view).toBe("imag");
    expect(layout.get().activeViewportMainModuleId).toBe("viewport-3d");
    expect(layout.get().focusedSlot).toBe("viewport-main");
  });

  it("stores mode appearance on the analysis overlay when plotting", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();

    const result = await commands.execute(
      "analysis.eigen.plot-mode-3d",
      {
        analysisFieldOverlay: overlay,
        source: "test",
      },
      {
        colorSource: "component_z",
        colormap: "inferno",
        fieldId: "analysis:eigen:sample-0000:mode-0002",
        label: "Mode 2",
        solidColor: "#44ccff",
        source: "eigen-mode",
      },
    );

    expect(result.status).toBe("completed");
    expect(overlay.getSnapshot()?.appearance).toEqual({
      scalarColorPalette: "inferno",
      shaderMonoColor: "#44ccff",
      surfaceColorSource: "component_z",
    });
    expect(overlay.getSnapshot()?.query.component).toBe("full");
  });

  it("reuses active mode-field appearance when switching analysis fields", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();
    overlay.set({
      appearance: {
        geometryScope: "full",
        scalarColorPalette: "viridis",
        shaderMonoColor: "var(--fm-surface-magnetic)",
        shaderVisible: true,
        surfaceColorSource: "colormap",
        vectorBudget: 900,
        vectorsVisible: true,
      },
      fieldId: "analysis:eigen:sample-0000:mode-0001",
      label: "Mode 1",
      query: {
        component: "full",
        phase_rad: 0.75,
        scope_kind: "full",
        view: "phase_rotated_real",
      },
      source: "eigen-mode",
      visualizationPhaseRad: 0.75,
    });

    const result = await commands.execute(
      "analysis.eigen.plot-mode-3d",
      {
        analysisFieldOverlay: overlay,
        source: "test",
      },
      {
        fieldId: "analysis:eigen:sample-0000:mode-0002",
        label: "Mode 2",
        source: "eigen-mode",
      },
    );

    expect(result.status).toBe("completed");
    expect(overlay.getSnapshot()).toMatchObject({
      appearance: {
        geometryScope: "full",
        scalarColorPalette: "viridis",
        shaderMonoColor: "var(--fm-surface-magnetic)",
        shaderVisible: true,
        surfaceColorSource: "colormap",
        vectorBudget: 900,
        vectorsVisible: true,
      },
      fieldId: "analysis:eigen:sample-0000:mode-0002",
      query: {
        phase_rad: 0.75,
        view: "phase_rotated_real",
      },
      source: "eigen-mode",
      visualizationPhaseRad: 0.75,
    });
  });

  it("keeps the command-edited display profile when switching from mode 1 to mode 2", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();

    await commands.execute(
      "analysis.eigen.plot-mode-3d",
      {
        analysisFieldOverlay: overlay,
        source: "test",
      },
      {
        fieldId: "analysis:eigen:sample-0000:mode-0001",
        label: "Mode 1",
        source: "eigen-mode",
      },
    );

    const profileResult = await commands.execute(
      "analysis.frequency-domain.set-3d-appearance",
      {
        analysisFieldOverlay: overlay,
        source: "test",
      },
      {
        colorSource: "colormap",
        colormap: "magma",
        geometryScope: "full",
        shaderVisible: false,
        vectorBudget: 384,
        vectorsVisible: true,
      },
    );

    expect(profileResult.status).toBe("completed");

    const modeSwitchResult = await commands.execute(
      "analysis.eigen.plot-mode-3d",
      {
        analysisFieldOverlay: overlay,
        source: "test",
      },
      {
        fieldId: "analysis:eigen:sample-0000:mode-0002",
        label: "Mode 2",
        source: "eigen-mode",
      },
    );

    expect(modeSwitchResult.status).toBe("completed");
    expect(overlay.getSnapshot()).toMatchObject({
      appearance: {
        geometryScope: "full",
        scalarColorPalette: "magma",
        shaderVisible: false,
        surfaceColorSource: "colormap",
        vectorBudget: 384,
        vectorsVisible: true,
      },
      fieldId: "analysis:eigen:sample-0000:mode-0002",
      source: "eigen-mode",
    });
  });

  it("keeps shared appearance when switching from modal to driven field overlays", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();
    overlay.set({
      appearance: {
        scalarColorPalette: "inferno",
        surfaceColorSource: "component_z",
        vectorBudget: 512,
      },
      fieldId: "analysis:eigen:sample-0000:mode-0002",
      label: "Mode 2",
      query: {
        component: "full",
        phase_rad: 0.25,
        scope_kind: "full",
        view: "phase_rotated_real",
      },
      source: "eigen-mode",
      visualizationPhaseRad: 0.25,
    });

    const result = await commands.execute(
      "analysis.frequency-response.plot-response-field-3d",
      {
        analysisFieldOverlay: overlay,
        source: "test",
      },
      {
        fieldId: "analysis:frequency-response:frequency-0001",
        label: "1 GHz",
        source: "frequency-response",
      },
    );

    expect(result.status).toBe("completed");
    expect(overlay.getSnapshot()).toMatchObject({
      appearance: {
        scalarColorPalette: "inferno",
        surfaceColorSource: "component_z",
        vectorBudget: 512,
      },
      fieldId: "analysis:frequency-response:frequency-0001",
      query: {
        phase_rad: 0.25,
      },
      source: "frequency-response",
      visualizationPhaseRad: 0.25,
    });
  });

  it("updates the active frequency-domain field appearance", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();
    overlay.set({
      fieldId: "analysis:eigen:sample-0000:mode-0002",
      label: "Mode 2",
      query: {
        component: "full",
        phase_rad: 0,
        scope_kind: "full",
        view: "phase_rotated_real",
      },
      source: "eigen-mode",
    });

    const result = await commands.execute(
      "analysis.frequency-domain.set-3d-appearance",
      {
        analysisFieldOverlay: overlay,
        source: "test",
      },
      {
        colorSource: "solid",
        solidColor: "#ff3366",
      },
    );

    expect(result.status).toBe("completed");
    expect(overlay.getSnapshot()?.appearance).toEqual({
      shaderMonoColor: "#ff3366",
      surfaceColorSource: "solid",
    });
  });

  it("updates mode field display passes and vector scope appearance", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();
    overlay.set({
      fieldId: "analysis:eigen:sample-0000:mode-0002",
      label: "Mode 2",
      query: {
        component: "full",
        phase_rad: 0,
        scope_kind: "full",
        view: "phase_rotated_real",
      },
      source: "eigen-mode",
    });

    const result = await commands.execute(
      "analysis.frequency-domain.set-3d-appearance",
      {
        analysisFieldOverlay: overlay,
        source: "test",
      },
      {
        geometryScope: "full",
        shaderVisible: false,
        vectorBudget: 512,
        vectorsVisible: true,
      },
    );

    expect(result.status).toBe("completed");
    expect(overlay.getSnapshot()?.appearance).toEqual({
      geometryScope: "full",
      shaderVisible: false,
      vectorBudget: 512,
      vectorsVisible: true,
    });
  });

  it.each([
    ["analysis.eigen.plot-mode-3d-amplitude", "abs"],
    ["analysis.eigen.plot-mode-3d-abs", "abs"],
  ])(
    "plots selected eigen mode complex magnitude with command %s",
    async (commandId, expectedView) => {
      const commands = commandRegistry();
      const overlay = new AnalysisFieldOverlayController();
      const selection = new SelectionController(new EventBus<KernelEventMap>());
      selection.set(
        {
          kind: "results.eigen.mode",
          label: "Mode 2",
          nodeId: "results:eigen:sample:0:mode:2",
          objectId: null,
          ref: {
            fieldId: "analysis:eigen:sample-0000:mode-0002",
            kind: "results.eigen.mode",
            modeIndex: 2,
            nodeId: "results:eigen:sample:0:mode:2",
            sampleIndex: 0,
            type: "frequency-domain",
          },
        },
        "test",
      );

      const result = await commands.execute(commandId, {
        analysisFieldOverlay: overlay,
        selection,
        source: "test",
      });

      expect(result.status).toBe("completed");
      expect(overlay.getSnapshot()).toMatchObject({
        fieldId: "analysis:eigen:sample-0000:mode-0002",
        query: {
          view: expectedView,
        },
        source: "eigen-mode",
      });
    },
  );

  it("uses the selected frequency-domain field id when no payload is supplied", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    selection.set(
      {
        kind: "results.resonance.driven.field",
        label: "1.5 GHz",
        nodeId: "results:frequency-response:stage-1:frequency:3",
        objectId: null,
        ref: {
          fieldId: "analysis:frequency-response:frequency-0003",
          frequencyIndex: 3,
          kind: "results.frequency_response.frequency_point",
          nodeId: "results:frequency-response:stage-1:frequency:3",
          type: "frequency-domain",
        },
      },
      "test",
    );

    const result = await commands.execute(
      "analysis.frequency-response.plot-response-field-3d",
      {
        analysisFieldOverlay: overlay,
        selection,
        source: "test",
      },
    );

    expect(result.status).toBe("completed");
    expect(overlay.getSnapshot()?.fieldId).toBe(
      "analysis:frequency-response:frequency-0003",
    );
    expect(overlay.getSnapshot()?.appearance).toMatchObject({
      shaderVisible: true,
      surfaceColorSource: "magnitude",
    });
    expect(overlay.getSnapshot()?.source).toBe("frequency-response");
  });

  it("plots selected response field with a fixed context-menu view command", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    selection.set(
      {
        kind: "results.frequency_response.frequency_point",
        label: "1.5 GHz",
        nodeId: "results:frequency-response:stage-1:frequency:3",
        objectId: null,
        ref: {
          fieldId: "analysis:frequency-response:frequency-0003",
          frequencyIndex: 3,
          kind: "results.frequency_response.frequency_point",
          nodeId: "results:frequency-response:stage-1:frequency:3",
          type: "frequency-domain",
        },
      },
      "test",
    );

    const result = await commands.execute(
      "analysis.frequency-response.plot-response-field-3d-phase",
      {
        analysisFieldOverlay: overlay,
        selection,
        source: "test",
      },
    );

    expect(result.status).toBe("completed");
    expect(overlay.getSnapshot()).toMatchObject({
      fieldId: "analysis:frequency-response:frequency-0003",
      query: {
        view: "phase",
      },
      source: "frequency-response",
    });
  });

  it.each([
    ["analysis.frequency-response.plot-response-field-3d-real", "real"],
    ["analysis.frequency-response.plot-response-field-3d-imag", "imag"],
    ["analysis.frequency-response.plot-response-field-3d-amplitude", "abs"],
    ["analysis.frequency-response.plot-response-field-3d-abs", "abs"],
    ["analysis.frequency-response.plot-response-field-3d-phase", "phase"],
    [
      "analysis.frequency-response.plot-response-field-3d-phase-rotated-real",
      "phase_rotated_real",
    ],
  ])(
    "plots selected response field with command %s as %s",
    async (commandId, expectedView) => {
      const commands = commandRegistry();
      const overlay = new AnalysisFieldOverlayController();
      const selection = new SelectionController(new EventBus<KernelEventMap>());
      selection.set(
        {
          kind: "results.frequency_response.frequency_point",
          label: "1.5 GHz",
          nodeId: "results:frequency-response:stage-1:frequency:3",
          objectId: null,
          ref: {
            fieldId: "analysis:frequency-response:frequency-0003",
            frequencyIndex: 3,
            kind: "results.frequency_response.frequency_point",
            nodeId: "results:frequency-response:stage-1:frequency:3",
            type: "frequency-domain",
          },
        },
        "test",
      );

      const result = await commands.execute(commandId, {
        analysisFieldOverlay: overlay,
        selection,
        source: "test",
      });

      expect(result.status).toBe("completed");
      expect(overlay.getSnapshot()).toMatchObject({
        fieldId: "analysis:frequency-response:frequency-0003",
        query: {
          view: expectedView,
        },
        source: "frequency-response",
      });
    },
  );

  it("rejects local tangent-space response payloads for 3D spatial fields", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();

    const result = await commands.execute(
      "analysis.frequency-response.plot-response-field-3d",
      {
        analysisFieldOverlay: overlay,
        source: "test",
      },
      {
        componentBasis: "local_tangent_frame",
        componentCount: 2,
        fieldId: "analysis:frequency-response:frequency-0003",
        label: "1.5 GHz",
        source: "frequency-response",
        valueKind: "complex_tangent_vector",
      },
    );

    expect(result.status).toBe("failed");
    expect(result.message).toContain("requires a spatial XYZ field");
    expect(overlay.getSnapshot()).toBeNull();
  });

  it("gates eigen and response field commands by selected analysis field source", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    selection.set(
      {
        kind: "results.frequency_response.frequency_point",
        label: "1.5 GHz",
        nodeId: "results:frequency-response:stage-1:frequency:3",
        objectId: null,
        ref: {
          fieldId: "analysis:frequency-response:frequency-0003",
          frequencyIndex: 3,
          kind: "results.frequency_response.frequency_point",
          nodeId: "results:frequency-response:stage-1:frequency:3",
          type: "frequency-domain",
        },
      },
      "test",
    );

    const context = {
      analysisFieldOverlay: overlay,
      selection,
      source: "test",
    } as const;

    expect(commands.isEnabled("analysis.eigen.plot-mode-3d", context)).toBe(false);
    expect(
      commands.isEnabled(
        "analysis.frequency-response.plot-response-field-3d",
        context,
      ),
    ).toBe(true);

    const result = await commands.execute(
      "analysis.eigen.plot-mode-3d",
      context,
    );

    expect(result.status).toBe("failed");
    expect(result.message).toBe("Selected analysis field is not a modal eigen field.");
  });

  it("gates response field commands away from selected eigen mode fields", () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    selection.set(
      {
        kind: "results.eigen.mode",
        label: "Mode 2",
        nodeId: "results:eigen:mode:2",
        objectId: null,
        ref: {
          fieldId: "analysis:eigen:sample-0000:mode-0002",
          kind: "results.eigen.mode",
          modeIndex: 2,
          nodeId: "results:eigen:mode:2",
          sampleIndex: 0,
          type: "frequency-domain",
        },
      },
      "test",
    );

    const context = {
      analysisFieldOverlay: overlay,
      selection,
      source: "test",
    } as const;

    expect(commands.isEnabled("analysis.eigen.plot-mode-3d", context)).toBe(true);
    expect(
      commands.isEnabled(
        "analysis.frequency-response.plot-response-field-3d",
        context,
      ),
    ).toBe(false);
  });

  it("preserves typed run, stage, equilibrium, resource, k, f, and provenance identity", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    overlay.setResultContext("run-1");
    selection.set(
      {
        kind: "results.frequency_response.frequency_point",
        label: "1.5 GHz",
        nodeId: "results:run-1:response:frequency:3",
        objectId: null,
        ref: {
          analysisRunId: "run-1",
          analysisStageId: "response-stage",
          artifactRevision: 11,
          equilibriumId: "eq-4",
          fieldId: "response-field-3",
          frequencyIndex: 3,
          frequencyHz: 1.5e9,
          kContextKind: "fixed_k",
          kind: "results.resonance.driven.field",
          nodeId: "results:run-1:response:frequency:3",
          normalization: "unit_l2",
          observableId: "mx",
          representation: "complex-vector-xyz",
          resourceRef: "data/fields/response-field-3",
          source: "frequency-response",
          studyProduct: "driven_response",
          type: "frequency-domain",
        },
      },
      "test",
    );

    const result = await commands.execute(
      "analysis.frequency-response.plot-response-field-3d",
      { analysisFieldOverlay: overlay, selection, source: "test" },
      {
        cellOrigin: [1, 2, 3],
        floquetSpatialConvention:
          "dst_equals_src_exp_minus_i_k_dot_delta_r",
        phaseRad: 0.75,
        phasorConvention: "exp_minus_i_omega_t",
        view: "imag",
        wavevectorKf: [0.1, 0.2, 0.3],
      },
    );

    expect(result.status).toBe("completed");
    expect(overlay.getSnapshot()).toMatchObject({
      fieldId: "response-field-3",
      frequencyIndex: 3,
      frequencyHz: 1.5e9,
      cellOrigin: [1, 2, 3],
      floquetSpatialConvention:
        "dst_equals_src_exp_minus_i_k_dot_delta_r",
      phasorConvention: "exp_minus_i_omega_t",
      provenance: {
        artifactRevision: 11,
        equilibriumId: "eq-4",
        kContextKind: "fixed_k",
        normalization: "unit_l2",
        observableId: "mx",
        representation: "complex-vector-xyz",
        resourceRef: "data/fields/response-field-3",
        runId: "run-1",
        stageId: "response-stage",
        studyProduct: "driven_response",
      },
      query: { phase_rad: 0.75, view: "imag" },
      source: "frequency-response",
      visualizationPhaseRad: 0.75,
      wavevectorKf: [0.1, 0.2, 0.3],
    });
    expect(overlay.getContextSnapshot().status).toBe("compatible");
  });

  it("rebinds a foreign overlay only to a compatible typed target", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    overlay.set({
      appearance: { scalarColorPalette: "viridis", vectorBudget: 512 },
      fieldId: "analysis:eigen:old-mode",
      label: "Old mode",
      modeIndex: 1,
      provenance: {
        artifactRevision: 4,
        equilibriumId: "eq-old",
        kContextKind: "gamma",
        representation: "complex-vector-xyz",
        resourceRef: "data/fields/analysis:eigen:old-mode",
        runId: "run-old",
        stageId: "eigen-old",
        studyProduct: "modal_eigen",
      },
      query: { phase_rad: 0.5, view: "phase_rotated_real" },
      sampleIndex: 0,
      source: "eigen-mode",
      visualizationPhaseRad: 0.5,
    });
    overlay.setResultContext("run-new");
    selection.set(
      {
        kind: "results.resonance.modal.mode",
        label: "New mode",
        nodeId: "results:run-new:eigen:mode:2",
        objectId: null,
        ref: {
          analysisRunId: "run-new",
          analysisStageId: "eigen-new",
          artifactRevision: 8,
          equilibriumId: "eq-new",
          fieldId: "mode-field:new",
          frequencyHz: 13e9,
          kContextKind: "gamma",
          kind: "results.resonance.modal.mode",
          modeIndex: 2,
          nodeId: "results:run-new:eigen:mode:2",
          representation: "complex-vector-xyz",
          resourceRef: "data/fields/mode-field:new",
          sampleIndex: 0,
          source: "eigen-mode",
          studyProduct: "modal_eigen",
          type: "frequency-domain",
        },
      },
      "test",
    );
    const context = { analysisFieldOverlay: overlay, selection, source: "test" } as const;

    expect(
      commands.isEnabled("analysis.frequency-domain.rebind-3d-overlay", context),
    ).toBe(true);
    const result = await commands.execute(
      "analysis.frequency-domain.rebind-3d-overlay",
      context,
    );

    expect(result.status).toBe("completed");
    expect(overlay.getSnapshot()).toMatchObject({
      appearance: { scalarColorPalette: "viridis", vectorBudget: 512 },
      fieldId: "mode-field:new",
      modeIndex: 2,
      provenance: { runId: "run-new", stageId: "eigen-new" },
      visualizationPhaseRad: 0.5,
    });
    expect(overlay.getContextSnapshot().status).toBe("compatible");
  });

  it("disables rebind with a reason when the selected target lacks owner identity", () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    overlay.set({
      fieldId: "analysis:eigen:old-mode",
      label: "Old mode",
      query: { phase_rad: 0, view: "phase_rotated_real" },
      source: "eigen-mode",
    });
    overlay.setResultContext("run-new");
    selection.set(
      {
        kind: "results.resonance.modal.mode",
        label: "Unowned mode",
        nodeId: "results:eigen:mode:2",
        objectId: null,
        ref: {
          fieldId: "analysis:eigen:new-mode",
          kind: "results.resonance.modal.mode",
          modeIndex: 2,
          nodeId: "results:eigen:mode:2",
          sampleIndex: 0,
          type: "frequency-domain",
        },
      },
      "test",
    );
    const context = { analysisFieldOverlay: overlay, selection, source: "test" } as const;

    expect(
      commands.isEnabled("analysis.frequency-domain.rebind-3d-overlay", context),
    ).toBe(false);
    expect(
      commands
        .get("analysis.frequency-domain.rebind-3d-overlay")
        ?.disabledReason?.(context),
    ).toBe("Selected analysis target artifact revision is missing.");
  });

  it("clears the active analysis field", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();
    overlay.set({
      animation: {
        animatePhase: true,
        animationRateHz: 0.5,
        direction: -1,
        loop: false,
      },
      fieldId: "analysis:frequency-response:frequency-0001",
      label: "1 GHz",
      query: {
        component: "full",
        scope_kind: "full",
        view: "phase_rotated_real",
      },
      source: "frequency-response",
    });

    const result = await commands.execute(
      "analysis.frequency-domain.clear-3d-overlay",
      {
        analysisFieldOverlay: overlay,
        source: "test",
      },
    );

    expect(result.status).toBe("completed");
    expect(overlay.getSnapshot()).toBeNull();
  });

  it("stops the active frequency-domain phase animation without changing fields", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();
    overlay.set({
      animation: {
        animatePhase: true,
        animationRateHz: 2,
      },
      fieldId: "analysis:eigen:sample-0000:mode-0002",
      label: "Mode 2",
      query: {
        component: "full",
        phase_rad: 0,
        scope_kind: "full",
        view: "phase_rotated_real",
      },
      source: "eigen-mode",
      visualizationPhaseRad: 0.5,
    });

    const result = await commands.execute(
      "analysis.frequency-domain.stop-3d-animation",
      {
        analysisFieldOverlay: overlay,
        source: "test",
      },
    );

    expect(result.status).toBe("completed");
    expect(overlay.getSnapshot()).toMatchObject({
      animation: {
        animatePhase: false,
        animationRateHz: 0,
      },
      fieldId: "analysis:eigen:sample-0000:mode-0002",
      source: "eigen-mode",
      visualizationPhaseRad: 0.5,
    });
  });

  it("updates eigen mode phase animation on the active overlay only", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();
    overlay.set({
      fieldId: "analysis:eigen:sample-0000:mode-0002",
      label: "Mode 2",
      query: {
        component: "full",
        phase_rad: 0,
        scope_kind: "full",
        view: "phase",
      },
      source: "eigen-mode",
    });

    const result = await commands.execute(
      "analysis.eigen.set-mode-3d-animation",
      {
        analysisFieldOverlay: overlay,
        source: "test",
      },
      {
        animatePhase: true,
        animationRateHz: 2,
      },
    );

    expect(result.status).toBe("completed");
    expect(overlay.getSnapshot()).toMatchObject({
      animation: {
        animatePhase: true,
        animationRateHz: 2,
      },
      fieldId: "analysis:eigen:sample-0000:mode-0002",
      query: {
        view: "phase_rotated_real",
      },
      source: "eigen-mode",
    });
  });

  it("starts eigen mode phase animation directly from inspector table input", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();

    const result = await commands.execute(
      "analysis.eigen.set-mode-3d-animation",
      {
        analysisFieldOverlay: overlay,
        source: "test",
      },
      {
        animatePhase: true,
        animationRateHz: 1,
        fieldId: "analysis:eigen:sample-0000:mode-0002",
        label: "Mode 2",
        phaseRad: 0,
        source: "eigen-mode",
        view: "phase_rotated_real",
      },
    );

    expect(result.status).toBe("completed");
    expect(overlay.getSnapshot()).toMatchObject({
      animation: {
        animatePhase: true,
        animationRateHz: 1,
      },
      fieldId: "analysis:eigen:sample-0000:mode-0002",
      label: "Mode 2",
      query: {
        phase_rad: 0,
        view: "phase_rotated_real",
      },
      source: "eigen-mode",
      visualizationPhaseRad: 0,
    });
  });

  it("updates response field phase through the frequency-domain phase command", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();
    overlay.set({
      animation: {
        animatePhase: true,
        animationRateHz: 0.5,
        direction: -1,
        loop: false,
      },
      fieldId: "analysis:frequency-response:frequency-0001",
      label: "1 GHz",
      query: {
        component: "full",
        phase_rad: 0,
        scope_kind: "full",
        view: "abs",
      },
      source: "frequency-response",
    });

    const result = await commands.execute(
      "analysis.frequency-domain.set-3d-phase",
      {
        analysisFieldOverlay: overlay,
        source: "test",
      },
      {
        phaseRad: 1.25,
      },
    );

    expect(result.status).toBe("completed");
    expect(overlay.getSnapshot()).toMatchObject({
      fieldId: "analysis:frequency-response:frequency-0001",
      query: {
        phase_rad: 0,
        view: "abs",
      },
      source: "frequency-response",
      visualizationPhaseRad: 1.25,
    });

    const pauseResult = await commands.execute(
      "analysis.frequency-domain.set-3d-animation",
      {
        analysisFieldOverlay: overlay,
        source: "test",
      },
      {
        animatePhase: false,
        animationRateHz: 2,
      },
    );

    expect(pauseResult.status).toBe("completed");
    expect(overlay.getSnapshot()).toMatchObject({
      animation: {
        animatePhase: false,
        animationRateHz: 2,
        direction: -1,
        loop: false,
      },
      fieldId: "analysis:frequency-response:frequency-0001",
      source: "frequency-response",
    });
  });

  it("updates response field phase animation through the frequency-domain animation command", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();
    overlay.set({
      fieldId: "analysis:frequency-response:frequency-0001",
      label: "1 GHz",
      query: {
        component: "full",
        phase_rad: 0,
        scope_kind: "full",
        view: "phase",
      },
      source: "frequency-response",
    });

    const result = await commands.execute(
      "analysis.frequency-domain.set-3d-animation",
      {
        analysisFieldOverlay: overlay,
        source: "test",
      },
      {
        animatePhase: true,
        animationRateHz: 2,
      },
    );

    expect(result.status).toBe("completed");
    expect(overlay.getSnapshot()).toMatchObject({
      animation: {
        animatePhase: true,
        animationRateHz: 2,
      },
      fieldId: "analysis:frequency-response:frequency-0001",
      query: {
        view: "phase_rotated_real",
      },
      source: "frequency-response",
      visualizationPhaseRad: 0,
    });
  });

  it("starts response field phase animation directly from inspector input", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();

    const result = await commands.execute(
      "analysis.frequency-domain.set-3d-animation",
      {
        analysisFieldOverlay: overlay,
        source: "test",
      },
      {
        animatePhase: true,
        animationRateHz: 2,
        fieldId: "analysis:frequency-response:frequency-0001",
        label: "1 GHz",
        phaseRad: 0.25,
        source: "frequency-response",
        view: "abs",
      },
    );

    expect(result.status).toBe("completed");
    expect(overlay.getSnapshot()).toMatchObject({
      animation: {
        animatePhase: true,
        animationRateHz: 2,
      },
      fieldId: "analysis:frequency-response:frequency-0001",
      label: "1 GHz",
      query: {
        phase_rad: 0.25,
        view: "phase_rotated_real",
      },
      source: "frequency-response",
      visualizationPhaseRad: 0.25,
    });
  });

  it("starts eigen mode phase animation directly from inspector input", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();

    const result = await commands.execute(
      "analysis.frequency-domain.set-3d-animation",
      {
        analysisFieldOverlay: overlay,
        source: "test",
      },
      {
        animatePhase: true,
        animationRateHz: 1.5,
        fieldId: "analysis:eigen:sample-0000:mode-0002",
        label: "Mode 2",
        phaseRad: 0.5,
        source: "eigen-mode",
        view: "phase",
      },
    );

    expect(result.status).toBe("completed");
    expect(overlay.getSnapshot()).toMatchObject({
      animation: {
        animatePhase: true,
        animationRateHz: 1.5,
      },
      fieldId: "analysis:eigen:sample-0000:mode-0002",
      label: "Mode 2",
      query: {
        phase_rad: 0.5,
        view: "phase_rotated_real",
      },
      source: "eigen-mode",
      visualizationPhaseRad: 0.5,
    });
  });

  it("rejects eigen mode phase animation when the active overlay is a response field", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();
    overlay.set({
      fieldId: "analysis:frequency-response:frequency-0001",
      label: "1 GHz",
      query: {
        component: "full",
        phase_rad: 0,
        scope_kind: "full",
        view: "phase_rotated_real",
      },
      source: "frequency-response",
    });

    const result = await commands.execute(
      "analysis.eigen.set-mode-3d-animation",
      {
        analysisFieldOverlay: overlay,
        source: "test",
      },
      {
        animatePhase: true,
      },
    );

    expect(result.status).toBe("failed");
    expect(result.message).toBe("No eigen mode field is active.");
    expect(overlay.getSnapshot()?.animation).toBeUndefined();
  });
});
