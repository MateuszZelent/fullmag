import type { FieldVectorQuery } from "../api/apiTypes";
import type { CommandContext, CommandContribution } from "../commands/commandTypes";
import type { SelectionRef } from "../selection/selectionTypes";

import type {
  AnalysisFieldOverlayAppearanceState,
  AnalysisFieldOverlaySource,
  AnalysisFieldOverlayState,
} from "./AnalysisFieldOverlayController";
import type {
  SurfaceColorSource,
  VisualizationGeometryScope,
} from "./ObjectVisualizationController";

interface AnalysisFieldOverlayCommandInput {
  animatePhase?: boolean | null;
  animationRateHz?: number | null;
  colorSource?: string | null;
  colormap?: string | null;
  componentBasis?: string | null;
  componentCount?: number | null;
  fieldId?: string | null;
  geometryScope?: string | null;
  label?: string | null;
  phaseRad?: number | null;
  shaderVisible?: boolean | null;
  source?: AnalysisFieldOverlaySource | null;
  solidColor?: string | null;
  valueKind?: string | null;
  vectorBudget?: number | null;
  vectorsVisible?: boolean | null;
  view?: string | null;
}

const DEFAULT_ANALYSIS_FIELD_VIEW = "phase_rotated_real";
const DEFAULT_ANALYSIS_FIELD_OVERLAY_APPEARANCE: AnalysisFieldOverlayAppearanceState = {
  shaderVisible: true,
  surfaceColorSource: "magnitude",
};
const ANALYSIS_FIELD_VIEWS = new Set([
  "real",
  "imag",
  "abs",
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
  if (value === "amplitude" || value === "complex") {
    return "abs";
  }
  return value && ANALYSIS_FIELD_VIEWS.has(value)
    ? value
    : DEFAULT_ANALYSIS_FIELD_VIEW;
}

function normalizeSurfaceColorSource(value: string | null): SurfaceColorSource | null {
  if (
    value === "solid" ||
    value === "orientation" ||
    value === "component_x" ||
    value === "component_y" ||
    value === "component_z" ||
    value === "magnitude" ||
    value === "colormap"
  ) {
    return value;
  }
  return null;
}

function normalizeGeometryScope(value: string | null): VisualizationGeometryScope | null {
  return value === "surface" || value === "full" ? value : null;
}

function overlayAppearanceFromInput(
  input: AnalysisFieldOverlayCommandInput,
): AnalysisFieldOverlayAppearanceState | undefined {
  const surfaceColorSource = normalizeSurfaceColorSource(
    stringValue(input.colorSource),
  );
  const geometryScope = normalizeGeometryScope(stringValue(input.geometryScope));
  const scalarColorPalette = stringValue(input.colormap);
  const shaderMonoColor = stringValue(input.solidColor);
  const shaderVisible = booleanValue(input.shaderVisible);
  const vectorBudget = numberValue(input.vectorBudget);
  const vectorsVisible = booleanValue(input.vectorsVisible);
  if (
    !surfaceColorSource &&
    !geometryScope &&
    !scalarColorPalette &&
    !shaderMonoColor &&
    shaderVisible === null &&
    vectorBudget === null &&
    vectorsVisible === null
  ) {
    return undefined;
  }
  return {
    ...(geometryScope ? { geometryScope } : {}),
    ...(scalarColorPalette ? { scalarColorPalette } : {}),
    ...(shaderMonoColor ? { shaderMonoColor } : {}),
    ...(shaderVisible === null ? {} : { shaderVisible }),
    ...(surfaceColorSource ? { surfaceColorSource } : {}),
    ...(vectorBudget === null ? {} : { vectorBudget: Math.max(0, Math.floor(vectorBudget)) }),
    ...(vectorsVisible === null ? {} : { vectorsVisible }),
  };
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

function unsupported3DPlotReason(context: CommandContext): string | null {
  const input = overlayCommandInput(context);
  const componentBasis = stringValue(input.componentBasis);
  const componentCount = numberValue(input.componentCount);
  const valueKind = stringValue(input.valueKind);

  if (
    componentBasis === "local_tangent_frame" ||
    valueKind === "complex_tangent_vector" ||
    (componentCount != null && componentCount !== 3)
  ) {
    return "Frequency-domain 3D field requires a spatial XYZ field; this payload is local tangent-space and needs tangent-to-XYZ reconstruction first.";
  }
  return null;
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

function overlayQueryFromContext(
  context: CommandContext,
  phaseRad: number,
): FieldVectorQuery {
  const input = overlayCommandInput(context);
  return {
    component: "full",
    phase_rad: phaseRad,
    scope_kind: "full",
    view: normalizeAnalysisFieldView(stringValue(input.view)),
  };
}

function overlayQueryWithDefaultViewFromContext(
  context: CommandContext,
  defaultView: string | null,
  phaseRad: number,
): FieldVectorQuery {
  const input = overlayCommandInput(context);
  return {
    component: "full",
    phase_rad: phaseRad,
    scope_kind: "full",
    view: normalizeAnalysisFieldView(stringValue(input.view) ?? defaultView),
  };
}

function overlayStateFromContext(
  context: CommandContext,
  source: AnalysisFieldOverlaySource,
  defaultView: string | null = null,
): AnalysisFieldOverlayState | null {
  const fieldId = fieldIdFromContext(context);
  if (!fieldId) return null;
  const activeOverlay = context.analysisFieldOverlay?.getSnapshot() ?? null;
  const resolvedSource = overlaySourceFromContext(context, source);
  const input = overlayCommandInput(context);
  const appearancePatch = overlayAppearanceFromInput(input);
  const appearance =
    appearancePatch ??
    activeOverlay?.appearance ??
    DEFAULT_ANALYSIS_FIELD_OVERLAY_APPEARANCE;
  const phaseRad =
    numberValue(input.phaseRad) ??
    activeOverlay?.visualizationPhaseRad ??
    activeOverlay?.query.phase_rad ??
    0;
  return {
    ...(appearance ? { appearance } : {}),
    fieldId,
    label: overlayLabelFromContext(context, resolvedSource),
    query: defaultView == null
      ? overlayQueryFromContext(context, phaseRad)
      : overlayQueryWithDefaultViewFromContext(context, defaultView, phaseRad),
    source: resolvedSource,
    visualizationPhaseRad: phaseRad,
  };
}

function activateViewport3D(context: CommandContext): void {
  context.layout?.setActiveViewportMainModule("viewport-3d");
  context.layout?.setFocusedSlot("viewport-main");
}

function setOverlayAppearanceCommand(options: {
  activeOverlay: (context: CommandContext) => AnalysisFieldOverlayState | null;
  id: string;
  missingMessage: string;
  title: string;
}): CommandContribution {
  return {
    id: options.id,
    title: options.title,
    category: "analysis",
    disabledReason: (context) => {
      if (!context.analysisFieldOverlay) {
        return "Analysis field controller is unavailable.";
      }
      return options.activeOverlay(context)
        ? null
        : options.missingMessage;
    },
    group: "analysis.frequency-domain",
    isEnabled: (context) =>
      Boolean(context.analysisFieldOverlay && options.activeOverlay(context)),
    run: (context) => {
      const overlay = options.activeOverlay(context);
      const controller = context.analysisFieldOverlay;
      if (!overlay || !controller) {
        return {
          status: "failed",
          message: options.missingMessage,
        };
      }
      const appearancePatch = overlayAppearanceFromInput(
        overlayCommandInput(context),
      );
      if (!appearancePatch) {
        return {
          status: "completed",
          message: "Frequency-domain 3D field appearance unchanged.",
        };
      }
      controller.update({
        appearance: {
          ...(overlay.appearance ?? {}),
          ...appearancePatch,
        },
      });
      return {
        status: "completed",
        message: "Frequency-domain 3D field appearance updated.",
      };
    },
    scope: "viewport",
  };
}

function activeEigenModeOverlay(context: CommandContext): AnalysisFieldOverlayState | null {
  const snapshot = context.analysisFieldOverlay?.getSnapshot() ?? null;
  return snapshot?.source === "eigen-mode" ? snapshot : null;
}

function activeAnalysisOverlay(context: CommandContext): AnalysisFieldOverlayState | null {
  return context.analysisFieldOverlay?.getSnapshot() ?? null;
}

function setOverlayPhaseCommand(options: {
  activeOverlay: (context: CommandContext) => AnalysisFieldOverlayState | null;
  id: string;
  missingMessage: string;
  title: string;
}): CommandContribution {
  return {
    id: options.id,
    title: options.title,
    category: "analysis",
    disabledReason: (context) => {
      if (!context.analysisFieldOverlay) {
        return "Analysis field controller is unavailable.";
      }
      return options.activeOverlay(context)
        ? null
        : options.missingMessage;
    },
    group: "analysis.frequency-domain",
    isEnabled: (context) =>
      Boolean(context.analysisFieldOverlay && options.activeOverlay(context)),
    run: (context) => {
      const overlay = options.activeOverlay(context);
      const controller = context.analysisFieldOverlay;
      if (!overlay || !controller) {
        return {
          status: "failed",
          message: options.missingMessage,
        };
      }
      const phaseRad = numberValue(overlayCommandInput(context).phaseRad) ?? 0;
      controller.update({
        visualizationPhaseRad: phaseRad,
      });
      return {
        status: "completed",
        message: `Frequency-domain phase set to ${phaseRad} rad.`,
      };
    },
    scope: "viewport",
  };
}

function setOverlayAnimationCommand(options: {
  activeOverlay: (context: CommandContext) => AnalysisFieldOverlayState | null;
  defaultSource: AnalysisFieldOverlaySource;
  id: string;
  missingMessage: string;
  title: string;
}): CommandContribution {
  return {
    id: options.id,
    title: options.title,
    category: "analysis",
    disabledReason: (context) => {
      if (!context.analysisFieldOverlay) {
        return "Analysis field controller is unavailable.";
      }
      return options.activeOverlay(context)
        ? null
        : options.missingMessage;
    },
    group: "analysis.frequency-domain",
    isEnabled: (context) =>
      Boolean(
        context.analysisFieldOverlay &&
          (options.activeOverlay(context) ||
            overlayStateFromContext(context, options.defaultSource)),
      ),
    run: (context) => {
      const existingOverlay = options.activeOverlay(context);
      const controller = context.analysisFieldOverlay;
      if (!controller) {
        return {
          status: "failed",
          message: options.missingMessage,
        };
      }
      const overlay =
        existingOverlay ??
        overlayStateFromContext(context, options.defaultSource);
      if (!overlay) {
        return {
          status: "failed",
          message: options.missingMessage,
        };
      }
      const input = overlayCommandInput(context);
      const animatePhase = booleanValue(input.animatePhase) ?? true;
      const animationRateHz = clampAnimationRateHz(numberValue(input.animationRateHz));
      const visualizationPhaseRad =
        numberValue(input.phaseRad) ??
        overlay.visualizationPhaseRad ??
        overlay.query.phase_rad ??
        0;
      const nextOverlay = {
        ...overlay,
        animation: {
          animatePhase,
          animationRateHz,
        },
        visualizationPhaseRad,
        query: animatePhase
          ? {
              ...overlay.query,
              view: DEFAULT_ANALYSIS_FIELD_VIEW,
            }
          : overlay.query,
      };
      if (existingOverlay) {
        controller.update(nextOverlay);
      } else {
        controller.set(nextOverlay);
      }
      activateViewport3D(context);
      return {
        status: "completed",
        message: animatePhase
          ? `Animating frequency-domain phase at ${animationRateHz} Hz.`
          : "Frequency-domain phase animation paused.",
      };
    },
    scope: "viewport",
  };
}

function stopOverlayAnimationCommand(options: {
  activeOverlay: (context: CommandContext) => AnalysisFieldOverlayState | null;
  id: string;
  missingMessage: string;
  title: string;
}): CommandContribution {
  return {
    id: options.id,
    title: options.title,
    category: "analysis",
    disabledReason: (context) => {
      if (!context.analysisFieldOverlay) {
        return "Analysis field controller is unavailable.";
      }
      return options.activeOverlay(context)
        ? null
        : options.missingMessage;
    },
    group: "analysis.frequency-domain",
    isEnabled: (context) =>
      Boolean(context.analysisFieldOverlay && options.activeOverlay(context)),
    run: (context) => {
      const overlay = options.activeOverlay(context);
      const controller = context.analysisFieldOverlay;
      if (!overlay || !controller) {
        return {
          status: "failed",
          message: options.missingMessage,
        };
      }
      controller.update({
        animation: {
          animatePhase: false,
          animationRateHz: 0,
        },
      });
      return {
        status: "completed",
        message: "Frequency-domain phase animation stopped.",
      };
    },
    scope: "viewport",
  };
}

function plotCommand(
  id: string,
  title: string,
  source: AnalysisFieldOverlaySource,
  defaultView: string | null = null,
): CommandContribution {
  return {
    id,
    title,
    category: "analysis",
    disabledReason: (context) => {
      if (!context.analysisFieldOverlay) {
        return "Analysis field controller is unavailable.";
      }
      const unsupportedReason = unsupported3DPlotReason(context);
      if (unsupportedReason) {
        return unsupportedReason;
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
          selectedFieldMatchesSource(context, source) &&
          !unsupported3DPlotReason(context),
      ),
    run: async (context) => {
      const unsupportedReason = unsupported3DPlotReason(context);
      if (unsupportedReason) {
        return { status: "failed", message: unsupportedReason };
      }
      const state = overlayStateFromContext(context, source, defaultView);
      if (!state || !context.analysisFieldOverlay) {
        return { status: "failed", message: "No analysis field is selected." };
      }
      const adopt = () => {
        context.analysisFieldOverlay!.set(state);
        activateViewport3D(context);
      };
      if (!context.chartViewportHandoff) {
        adopt();
        return { status: "completed", message: `Plotting ${state.label} in 3D.` };
      }
      const selection = context.selection?.get();
      const status = await context.chartViewportHandoff.run(
        {
          commandId: id,
          fieldRef: {
            fieldId: state.fieldId,
            resourceKey: `data/fields/${encodeURIComponent(state.fieldId)}`,
          },
          selection: {
            resourceKey:
              selection?.ref?.type === "frequency-domain"
                ? selection.ref.resourceRef ?? state.fieldId
                : state.fieldId,
            rowIds: selection?.nodeId ? [selection.nodeId] : [],
            semanticTarget: selection?.kind ?? source,
          },
        },
        async (signal) => {
          await Promise.resolve();
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          return state;
        },
        adopt,
      );
      return status === "completed"
        ? { status, message: `Plotting  in 3D.` }
        : {
            status: status === "failed" ? "failed" : "cancelled",
            message: context.chartViewportHandoff.getSnapshot().message ?? undefined,
          };
    },
    scope: "selection",
  };
}

export const ANALYSIS_FIELD_OVERLAY_COMMANDS: CommandContribution[] = [
  plotCommand("analysis.eigen.plot-mode-3d", "Plot eigen mode in 3D", "eigen-mode"),
  plotCommand(
    "analysis.eigen.plot-mode-3d-real",
    "Plot eigen mode real in 3D",
    "eigen-mode",
    "real",
  ),
  plotCommand(
    "analysis.eigen.plot-mode-3d-imag",
    "Plot eigen mode imag in 3D",
    "eigen-mode",
    "imag",
  ),
  plotCommand(
    "analysis.eigen.plot-mode-3d-amplitude",
    "Plot eigen mode complex magnitude in 3D",
    "eigen-mode",
    "abs",
  ),
  plotCommand(
    "analysis.eigen.plot-mode-3d-abs",
    "Plot eigen mode complex magnitude in 3D",
    "eigen-mode",
    "abs",
  ),
  plotCommand(
    "analysis.eigen.plot-mode-3d-phase",
    "Plot eigen mode phase in 3D",
    "eigen-mode",
    "phase",
  ),
  plotCommand(
    "analysis.eigen.plot-mode-3d-phase-rotated-real",
    "Plot eigen mode phase-rotated real in 3D",
    "eigen-mode",
    DEFAULT_ANALYSIS_FIELD_VIEW,
  ),
  setOverlayPhaseCommand({
    activeOverlay: activeEigenModeOverlay,
    id: "analysis.eigen.set-mode-3d-phase",
    missingMessage: "No eigen mode field is active.",
    title: "Set eigen mode 3D phase",
  }),
  setOverlayAnimationCommand({
    activeOverlay: activeEigenModeOverlay,
    defaultSource: "eigen-mode",
    id: "analysis.eigen.set-mode-3d-animation",
    missingMessage: "No eigen mode field is active.",
    title: "Animate eigen mode phase",
  }),
  setOverlayPhaseCommand({
    activeOverlay: activeAnalysisOverlay,
    id: "analysis.frequency-domain.set-3d-phase",
    missingMessage: "No frequency-domain field is active.",
    title: "Set frequency-domain 3D phase",
  }),
  setOverlayAnimationCommand({
    activeOverlay: activeAnalysisOverlay,
    defaultSource: "frequency-response",
    id: "analysis.frequency-domain.set-3d-animation",
    missingMessage: "No frequency-domain field is active.",
    title: "Animate frequency-domain phase",
  }),
  stopOverlayAnimationCommand({
    activeOverlay: activeAnalysisOverlay,
    id: "analysis.frequency-domain.stop-3d-animation",
    missingMessage: "No frequency-domain field is active.",
    title: "Stop frequency-domain phase animation",
  }),
  setOverlayAppearanceCommand({
    activeOverlay: activeAnalysisOverlay,
    id: "analysis.frequency-domain.set-3d-appearance",
    missingMessage: "No frequency-domain field is active.",
    title: "Set frequency-domain 3D appearance",
  }),
  plotCommand(
    "analysis.frequency-response.plot-response-field-3d",
    "Plot response field in 3D",
    "frequency-response",
  ),
  plotCommand(
    "analysis.frequency-response.plot-response-field-3d-real",
    "Plot response field real in 3D",
    "frequency-response",
    "real",
  ),
  plotCommand(
    "analysis.frequency-response.plot-response-field-3d-imag",
    "Plot response field imag in 3D",
    "frequency-response",
    "imag",
  ),
  plotCommand(
    "analysis.frequency-response.plot-response-field-3d-amplitude",
    "Plot response field complex magnitude in 3D",
    "frequency-response",
    "abs",
  ),
  plotCommand(
    "analysis.frequency-response.plot-response-field-3d-abs",
    "Plot response field complex magnitude in 3D",
    "frequency-response",
    "abs",
  ),
  plotCommand(
    "analysis.frequency-response.plot-response-field-3d-phase",
    "Plot response field phase in 3D",
    "frequency-response",
    "phase",
  ),
  plotCommand(
    "analysis.frequency-response.plot-response-field-3d-phase-rotated-real",
    "Plot response field phase-rotated real in 3D",
    "frequency-response",
    DEFAULT_ANALYSIS_FIELD_VIEW,
  ),
  {
    id: "analysis.frequency-domain.clear-3d-overlay",
    title: "Clear frequency-domain 3D field",
    category: "analysis",
    disabledReason: (context) => {
      if (!context.analysisFieldOverlay) {
        return "Analysis field controller is unavailable.";
      }
      return context.analysisFieldOverlay.getSnapshot()
        ? null
        : "No frequency-domain field is active.";
    },
    group: "analysis.frequency-domain",
    isEnabled: (context) =>
      Boolean(context.analysisFieldOverlay?.getSnapshot()),
    run: (context) => {
      context.analysisFieldOverlay?.clear();
      return {
        status: "completed",
        message: "Frequency-domain 3D field cleared.",
      };
    },
    scope: "viewport",
  },
];
