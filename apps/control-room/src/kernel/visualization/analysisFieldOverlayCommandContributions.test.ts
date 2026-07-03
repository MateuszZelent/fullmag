import { describe, expect, it } from "vitest";

import { CommandRegistry } from "../commands/CommandRegistry";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { LayoutController } from "../layout/LayoutController";
import { SelectionController } from "../selection/SelectionController";

import { AnalysisFieldOverlayController } from "./AnalysisFieldOverlayController";
import { ANALYSIS_FIELD_OVERLAY_COMMANDS } from "./analysisFieldOverlayCommandContributions";

function commandRegistry(): CommandRegistry {
  const commands = new CommandRegistry();
  for (const command of ANALYSIS_FIELD_OVERLAY_COMMANDS) {
    commands.register(command);
  }
  return commands;
}

describe("analysis field overlay commands", () => {
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

  it("clears the active analysis field", async () => {
    const commands = commandRegistry();
    const overlay = new AnalysisFieldOverlayController();
    overlay.set({
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
