import { describe, expect, it } from "vitest";

import { CommandRegistry } from "../commands/CommandRegistry";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
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
  it("plots an eigen mode field through the shared overlay controller", async () => {
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
      fieldId: "analysis:eigen:sample-0000:mode-0002",
      label: "Mode 2",
      query: {
        component: "full",
        phase_rad: 0.5,
        scope_kind: "full",
        view: "phase_rotated_real",
      },
      source: "eigen-mode",
    });
  });

  it.each([
    ["real", "real"],
    ["imag", "imag"],
    ["amplitude", "amplitude"],
    ["abs", "amplitude"],
    ["complex", "amplitude"],
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
    expect(overlay.getSnapshot()?.source).toBe("frequency-response");
  });

  it("gates eigen and response overlay commands by selected analysis field source", async () => {
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

  it("gates response overlay commands away from selected eigen mode fields", () => {
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

  it("clears the active analysis overlay", async () => {
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
        view: "phase_rotated_real",
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
      source: "eigen-mode",
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
    expect(result.message).toBe("No eigen mode overlay is active.");
    expect(overlay.getSnapshot()?.animation).toBeUndefined();
  });
});
