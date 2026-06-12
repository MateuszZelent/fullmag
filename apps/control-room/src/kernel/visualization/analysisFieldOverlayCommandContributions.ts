import type { FieldVectorQuery } from "../api/apiTypes";
import type { CommandContext, CommandContribution } from "../commands/commandTypes";
import type { SelectionRef } from "../selection/selectionTypes";

import type {
  AnalysisFieldOverlaySource,
  AnalysisFieldOverlayState,
} from "./AnalysisFieldOverlayController";

interface AnalysisFieldOverlayCommandInput {
  animatePhase?: boolean | null;
  animationRateHz?: number | null;
  fieldId?: string | null;
  label?: string | null;
  phaseRad?: number | null;
  source?: AnalysisFieldOverlaySource | null;
  view?: string | null;
}

const DEFAULT_ANALYSIS_FIELD_VIEW = "phase_rotated_real";
const ANALYSIS_FIELD_VIEWS = new Set([
  "real",
  "imag",
  "amplitude",
  "phase",
  DEFAULT_ANALYSIS_FIELD_VIEW,
]);

function overlayCommandInput(
  context: CommandContext,
): AnalysisFieldOverlayCommandInput {
  return isRecord(context.input) ? context.input : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function clampAnimationRateHz(value: number | null): number {
  const fallback = value ?? 1;
  return Math.min(10, Math.max(0.05, fallback));
}

function normalizeAnalysisFieldView(value: string | null): string {
  if (value === "abs" || value === "complex") {
    return "amplitude";
  }
  return value && ANALYSIS_FIELD_VIEWS.has(value)
    ? value
    : DEFAULT_ANALYSIS_FIELD_VIEW;
}

function selectedFrequencyDomainRef(context: CommandContext): Extract<
  SelectionRef,
  { type: "frequency-domain" }
> | null {
  const ref = context.selection?.get().ref;
  return ref?.type === "frequency-domain" ? ref : null;
}

function fieldIdFromContext(context: CommandContext): string | null {
  const input = overlayCommandInput(context);
  return stringValue(input.fieldId) ?? selectedFrequencyDomainRef(context)?.fieldId ?? null;
}

function sourceFromSelectionRef(
  ref: Extract<SelectionRef, { type: "frequency-domain" }> | null,
): AnalysisFieldOverlaySource | null {
  if (!ref) return null;
  if (
    ref.kind.startsWith("results.eigen") ||
    ref.kind.startsWith("resources.analysis.eigen") ||
    ref.fieldId?.startsWith("analysis:eigen:")
  ) {
    return "eigen-mode";
  }
  if (
    ref.kind.startsWith("results.frequency_response") ||
    ref.kind.startsWith("resources.analysis.frequency_response") ||
    ref.fieldId?.startsWith("analysis:frequency-response:")
  ) {
    return "frequency-response";
  }
  return null;
}

function selectedFieldMatchesSource(
  context: CommandContext,
  source: AnalysisFieldOverlaySource,
): boolean {
  const input = overlayCommandInput(context);
  const inputSource = overlaySourceFromContext(context, source);
  if (input.fieldId !== undefined) return inputSource === source;

  const selectedSource = sourceFromSelectionRef(selectedFrequencyDomainRef(context));
  return selectedSource === null || selectedSource === source;
}

function overlaySourceFromContext(
  context: CommandContext,
  fallback: AnalysisFieldOverlaySource,
): AnalysisFieldOverlaySource {
  const source = overlayCommandInput(context).source;
  return source === "eigen-mode" || source === "frequency-response"
    ? source
    : fallback;
}

function overlayLabelFromContext(
  context: CommandContext,
  source: AnalysisFieldOverlaySource,
): string {
  const input = overlayCommandInput(context);
  const explicit = stringValue(input.label);
  if (explicit) return explicit;

  const selection = context.selection?.get();
  if (selection?.label) return selection.label;

  return source === "eigen-mode" ? "Eigen mode field" : "Response field";
}

function overlayQueryFromContext(context: CommandContext): FieldVectorQuery {
  const input = overlayCommandInput(context);
  return {
    component: "full",
    phase_rad: numberValue(input.phaseRad) ?? 0,
    scope_kind: "full",
    view: normalizeAnalysisFieldView(stringValue(input.view)),
  };
}

function overlayStateFromContext(
  context: CommandContext,
  source: AnalysisFieldOverlaySource,
): AnalysisFieldOverlayState | null {
  const fieldId = fieldIdFromContext(context);
  if (!fieldId) return null;
  const resolvedSource = overlaySourceFromContext(context, source);
  return {
    fieldId,
    label: overlayLabelFromContext(context, resolvedSource),
    query: overlayQueryFromContext(context),
    source: resolvedSource,
  };
}

function activeEigenModeOverlay(context: CommandContext): AnalysisFieldOverlayState | null {
  const snapshot = context.analysisFieldOverlay?.getSnapshot() ?? null;
  return snapshot?.source === "eigen-mode" ? snapshot : null;
}

function setModePhaseCommand(): CommandContribution {
  return {
    id: "analysis.eigen.set-mode-3d-phase",
    title: "Set eigen mode 3D phase",
    category: "analysis",
    disabledReason: (context) => {
      if (!context.analysisFieldOverlay) {
        return "Analysis field overlay controller is unavailable.";
      }
      return activeEigenModeOverlay(context)
        ? null
        : "No eigen mode overlay is active.";
    },
    group: "analysis.frequency-domain",
    isEnabled: (context) =>
      Boolean(context.analysisFieldOverlay && activeEigenModeOverlay(context)),
    run: (context) => {
      const overlay = activeEigenModeOverlay(context);
      const controller = context.analysisFieldOverlay;
      if (!overlay || !controller) {
        return {
          status: "failed",
          message: "No eigen mode overlay is active.",
        };
      }
      const phaseRad = numberValue(overlayCommandInput(context).phaseRad) ?? 0;
      controller.update({
        query: {
          ...overlay.query,
          phase_rad: phaseRad,
          view: DEFAULT_ANALYSIS_FIELD_VIEW,
        },
      });
      return {
        status: "completed",
        message: `Eigen mode phase set to ${phaseRad} rad.`,
      };
    },
    scope: "viewport",
  };
}

function setModeAnimationCommand(): CommandContribution {
  return {
    id: "analysis.eigen.set-mode-3d-animation",
    title: "Animate eigen mode phase",
    category: "analysis",
    disabledReason: (context) => {
      if (!context.analysisFieldOverlay) {
        return "Analysis field overlay controller is unavailable.";
      }
      return activeEigenModeOverlay(context)
        ? null
        : "No eigen mode overlay is active.";
    },
    group: "analysis.frequency-domain",
    isEnabled: (context) =>
      Boolean(context.analysisFieldOverlay && activeEigenModeOverlay(context)),
    run: (context) => {
      const overlay = activeEigenModeOverlay(context);
      const controller = context.analysisFieldOverlay;
      if (!overlay || !controller) {
        return {
          status: "failed",
          message: "No eigen mode overlay is active.",
        };
      }
      const input = overlayCommandInput(context);
      const animatePhase = booleanValue(input.animatePhase) ?? true;
      const animationRateHz = clampAnimationRateHz(numberValue(input.animationRateHz));
      controller.update({
        animation: {
          animatePhase,
          animationRateHz,
        },
        query: {
          ...overlay.query,
          view: DEFAULT_ANALYSIS_FIELD_VIEW,
        },
      });
      return {
        status: "completed",
        message: animatePhase
          ? `Animating eigen mode phase at ${animationRateHz} Hz.`
          : "Eigen mode phase animation paused.",
      };
    },
    scope: "viewport",
  };
}

function plotCommand(
  id: string,
  title: string,
  source: AnalysisFieldOverlaySource,
): CommandContribution {
  return {
    id,
    title,
    category: "analysis",
    disabledReason: (context) => {
      if (!context.analysisFieldOverlay) {
        return "Analysis field overlay controller is unavailable.";
      }
      if (!selectedFieldMatchesSource(context, source)) {
        return source === "eigen-mode"
          ? "Selected analysis field is not a modal eigen field."
          : "Selected analysis field is not a driven response field.";
      }
      return fieldIdFromContext(context) ? null : "No analysis field is selected.";
    },
    group: "analysis.frequency-domain",
    isEnabled: (context) =>
      Boolean(
        context.analysisFieldOverlay &&
          fieldIdFromContext(context) &&
          selectedFieldMatchesSource(context, source),
      ),
    run: (context) => {
      const state = overlayStateFromContext(context, source);
      if (!state || !context.analysisFieldOverlay) {
        return {
          status: "failed",
          message: "No analysis field is selected.",
        };
      }
      context.analysisFieldOverlay.set(state);
      return {
        status: "completed",
        message: `Plotting ${state.label} in 3D.`,
      };
    },
    scope: "selection",
  };
}

export const ANALYSIS_FIELD_OVERLAY_COMMANDS: CommandContribution[] = [
  plotCommand("analysis.eigen.plot-mode-3d", "Plot eigen mode in 3D", "eigen-mode"),
  setModePhaseCommand(),
  setModeAnimationCommand(),
  plotCommand(
    "analysis.frequency-response.plot-response-field-3d",
    "Plot response field in 3D",
    "frequency-response",
  ),
  {
    id: "analysis.frequency-domain.clear-3d-overlay",
    title: "Clear frequency-domain 3D overlay",
    category: "analysis",
    disabledReason: (context) => {
      if (!context.analysisFieldOverlay) {
        return "Analysis field overlay controller is unavailable.";
      }
      return context.analysisFieldOverlay.getSnapshot()
        ? null
        : "No frequency-domain field overlay is active.";
    },
    group: "analysis.frequency-domain",
    isEnabled: (context) =>
      Boolean(context.analysisFieldOverlay?.getSnapshot()),
    run: (context) => {
      context.analysisFieldOverlay?.clear();
      return {
        status: "completed",
        message: "Frequency-domain 3D overlay cleared.",
      };
    },
    scope: "viewport",
  },
];
