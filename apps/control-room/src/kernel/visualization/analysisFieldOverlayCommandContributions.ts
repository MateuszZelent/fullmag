import type {
  FloquetSpatialConvention,
  PhasorConvention,
} from "@/shared/domain/analysis/phasorConventionAdapter";

import type { FieldVectorQuery } from "../api/apiTypes";
import type { CommandContext, CommandContribution } from "../commands/commandTypes";
import type { SelectionRef } from "../selection/selectionTypes";
import {
  analysisResultFieldOverlayAdapter,
  createAnalysisResultFieldOverlayIntent,
} from "./AnalysisResultFieldOverlayIntent";
import { createModeFieldOverlayIntent } from "./ModeFieldOverlayIntent";

import type {
  AnalysisFieldOverlayAppearanceState,
  AnalysisFieldOverlayKContextKind,
  AnalysisFieldOverlayRepresentation,
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
  cellOrigin?: unknown;
  colorSource?: string | null;
  colorRangeMax?: number | null;
  colorRangeMin?: number | null;
  colorRangeMode?: string | null;
  colormap?: string | null;
  componentBasis?: string | null;
  componentCount?: number | null;
  artifactRevision?: number | string | null;
  equilibriumId?: string | null;
  fieldId?: string | null;
  floquetSpatialConvention?: string | null;
  frequencyIndex?: number | null;
  frequencyHz?: number | null;
  displayGain?: number | null;
  geometryScope?: string | null;
  label?: string | null;
  kContextKind?: string | null;
  kPathCoordinateRadPerM?: number | null;
  modeIndex?: number | null;
  normalization?: string | null;
  observableId?: string | null;
  phaseRad?: number | null;
  phasorConvention?: string | null;
  shaderVisible?: boolean | null;
  resourceRef?: string | null;
  representation?: string | null;
  runId?: string | null;
  sampleIndex?: number | null;
  source?: AnalysisFieldOverlaySource | null;
  stageId?: string | null;
  solidColor?: string | null;
  valueKind?: string | null;
  vectorBudget?: number | null;
  vectorScale?: number | null;
  vectorsVisible?: boolean | null;
  view?: string | null;
  wavevectorKf?: unknown;
  studyProduct?: string | null;
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

function vector3Value(value: unknown): [number, number, number] | null {
  return Array.isArray(value) &&
    value.length === 3 &&
    value.every((component) => numberValue(component) !== null)
    ? [value[0] as number, value[1] as number, value[2] as number]
    : null;
}

function floquetSpatialConventionValue(
  value: unknown,
): FloquetSpatialConvention | null {
  return value === "dst_equals_src_exp_minus_i_k_dot_delta_r" ||
    value === "dst_equals_src_exp_plus_i_k_dot_delta_r"
    ? value
    : null;
}

function phasorConventionValue(value: unknown): PhasorConvention | null {
  return value === "exp_i_omega_t" || value === "exp_minus_i_omega_t"
    ? value
    : null;
}

function kContextKindValue(
  value: unknown,
): AnalysisFieldOverlayKContextKind | null {
  return value === "finite_open" ||
    value === "fixed_k" ||
    value === "gamma" ||
    value === "k_grid" ||
    value === "k_path"
    ? value
    : null;
}

function representationValue(value: unknown): AnalysisFieldOverlayRepresentation | null {
  return value === "complex-vector-xyz" ? value : null;
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
  const colorRangeMode = stringValue(input.colorRangeMode);
  const colorRangeMin = numberValue(input.colorRangeMin);
  const colorRangeMax = numberValue(input.colorRangeMax);
  const displayGain = numberValue(input.displayGain);
  const vectorScale = numberValue(input.vectorScale);
  if (
    !surfaceColorSource &&
    !geometryScope &&
    !scalarColorPalette &&
    !shaderMonoColor &&
    shaderVisible === null &&
    vectorBudget === null &&
    vectorsVisible === null &&
    colorRangeMode !== "auto" &&
    colorRangeMode !== "manual" &&
    colorRangeMode !== "symmetric" &&
    colorRangeMin === null &&
    colorRangeMax === null &&
    displayGain === null &&
    vectorScale === null
  ) {
    return undefined;
  }
  return {
    ...(colorRangeMode === "auto" ||
    colorRangeMode === "manual" ||
    colorRangeMode === "symmetric"
      ? { colorRangeMode }
      : {}),
    ...(colorRangeMin === null ? {} : { colorRangeMin }),
    ...(colorRangeMax === null ? {} : { colorRangeMax }),
    ...(displayGain === null ? {} : { displayGain: Math.max(0, displayGain) }),
    ...(geometryScope ? { geometryScope } : {}),
    ...(scalarColorPalette ? { scalarColorPalette } : {}),
    ...(shaderMonoColor ? { shaderMonoColor } : {}),
    ...(shaderVisible === null ? {} : { shaderVisible }),
    ...(surfaceColorSource ? { surfaceColorSource } : {}),
    ...(vectorBudget === null ? {} : { vectorBudget: Math.max(0, Math.floor(vectorBudget)) }),
    ...(vectorScale === null ? {} : { vectorScale: Math.max(0, vectorScale) }),
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

function selectedAnalysisResultRef(context: CommandContext): Extract<
  SelectionRef,
  { type: "analysis-result" }
> | null {
  const ref = context.selection?.get().ref;
  return ref?.type === "analysis-result" ? ref : null;
}

function selectedOverlayIdentityRef(context: CommandContext): Extract<
  SelectionRef,
  { type: "frequency-domain" | "mode-visualization" }
> | null {
  const ref = context.selection?.get().ref;
  return ref?.type === "frequency-domain" || ref?.type === "mode-visualization"
    ? ref
    : null;
}

function fieldIdFromContext(context: CommandContext): string | null {
  const input = overlayCommandInput(context);
  return (
    stringValue(input.fieldId) ??
    selectedFrequencyDomainRef(context)?.fieldId ??
    selectedAnalysisResultRef(context)?.fieldId ??
    null
  );
}

function sourceFromSelectionRef(
  ref: Extract<SelectionRef, { type: "frequency-domain" }> | null,
): AnalysisFieldOverlaySource | null {
  if (!ref) return null;
  if (
    ref.source === "eigen-mode" ||
    ref.source === "frequency-response" ||
    ref.source === "time-domain-response"
  ) {
    return ref.source;
  }
  if (
    ref.kind.startsWith("results.eigen") ||
    ref.fieldId?.startsWith("analysis:eigen:")
  ) {
    return "eigen-mode";
  }
  if (
    ref.kind.startsWith("results.frequency_response") ||
    ref.fieldId?.startsWith("analysis:frequency-response:")
  ) {
    return "frequency-response";
  }
  if (ref.kind.startsWith("results.time_domain")) {
    return "time-domain-response";
  }
  return null;
}

function sourceFromAnalysisResultRef(
  ref: Extract<SelectionRef, { type: "analysis-result" }> | null,
): AnalysisFieldOverlaySource | null {
  return ref?.itemKind
    ? analysisResultFieldOverlayAdapter(ref.itemKind).source
    : null;
}

function selectedFieldMatchesSource(
  context: CommandContext,
  source: AnalysisFieldOverlaySource,
): boolean {
  const input = overlayCommandInput(context);
  const inputSource = overlaySourceFromContext(context, source);
  if (input.fieldId !== undefined) return inputSource === source;

  const selectedResultSource = sourceFromAnalysisResultRef(
    selectedAnalysisResultRef(context),
  );
  if (selectedResultSource !== null) return selectedResultSource === source;

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

  const resultRef = selectedAnalysisResultRef(context);
  if (resultRef) {
    if (!resultRef.fieldId || !resultRef.fieldRevision || !resultRef.fieldRef) {
      return "Selected result item has no published spatial field reference.";
    }
    if (!createAnalysisResultFieldOverlayIntent(resultRef)) {
      return "Selected result field is unsupported until its complex XYZ field and immutable mesh reference are verified.";
    }
  }
  return null;
}

function overlaySourceFromContext(
  context: CommandContext,
  fallback: AnalysisFieldOverlaySource,
): AnalysisFieldOverlaySource {
  const source = overlayCommandInput(context).source;
  return source === "eigen-mode" ||
    source === "frequency-response" ||
    source === "time-domain-response"
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

  const resultRef = selectedAnalysisResultRef(context);
  if (resultRef?.itemKind) {
    const adapter = analysisResultFieldOverlayAdapter(resultRef.itemKind);
    if (adapter.source === source) return adapter.label;
  }

  if (source === "eigen-mode") return "Eigen mode field";
  if (source === "time-domain-response") return "Time-domain response field";
  return "Response field";
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
  const selectedRef = selectedFrequencyDomainRef(context);
  const selectedResultRef = selectedAnalysisResultRef(context);
  const modeIntent =
    resolvedSource === "eigen-mode"
      ? createModeFieldOverlayIntent(selectedRef)
      : null;
  const analysisResultFieldIntent = createAnalysisResultFieldOverlayIntent(
    selectedResultRef,
  );
  const resultSource = analysisResultFieldIntent?.source ?? resolvedSource;
  const identityRef = selectedOverlayIdentityRef(context);
  const activeIdentityOverlay =
    identityRef?.type === "mode-visualization" &&
    activeOverlay?.fieldId === fieldId
      ? activeOverlay
      : null;
  const cellOrigin =
    vector3Value(input.cellOrigin) ?? activeIdentityOverlay?.cellOrigin;
  const floquetSpatialConvention =
    floquetSpatialConventionValue(input.floquetSpatialConvention) ??
    activeIdentityOverlay?.floquetSpatialConvention;
  const phasorConvention =
    phasorConventionValue(input.phasorConvention) ??
    activeIdentityOverlay?.phasorConvention;
  const wavevectorKf =
    vector3Value(input.wavevectorKf) ??
    (identityRef?.wavevectorKf ? [...identityRef.wavevectorKf] as [number, number, number] : null) ??
    activeIdentityOverlay?.wavevectorKf;
  const artifactRevision =
    analysisResultFieldIntent?.datasetRevision ??
    identityRef?.artifactRevision ??
    input.artifactRevision ??
    undefined;
  const equilibriumId =
    identityRef?.equilibriumId ?? stringValue(input.equilibriumId) ?? undefined;
  const kContextKind =
    identityRef?.kContextKind ?? kContextKindValue(input.kContextKind) ?? undefined;
  const resourceRef =
    analysisResultFieldIntent?.fieldRef.resource_key ??
    identityRef?.resourceRef ??
    stringValue(input.resourceRef) ??
    undefined;
  const representation =
    representationValue(identityRef?.representation) ??
    representationValue(input.representation) ??
    (analysisResultFieldIntent ? "complex-vector-xyz" : undefined);
  const runId =
    analysisResultFieldIntent?.analysisRunId ??
    identityRef?.analysisRunId ??
    stringValue(input.runId) ??
    undefined;
  const stageId =
    analysisResultFieldIntent?.analysisStageId ??
    identityRef?.analysisStageId ??
    stringValue(input.stageId) ??
    undefined;
  const studyProduct =
    identityRef?.studyProduct ?? stringValue(input.studyProduct) ?? undefined;
  const normalization =
    identityRef?.normalization ?? stringValue(input.normalization) ?? activeIdentityOverlay?.provenance?.normalization;
  return {
    ...(appearance ? { appearance } : {}),
    ...(cellOrigin ? { cellOrigin } : {}),
    fieldId,
    ...(floquetSpatialConvention ? { floquetSpatialConvention } : {}),
    ...((numberValue(input.frequencyIndex) ?? identityRef?.frequencyIndex) !== undefined
      ? {
          frequencyIndex:
            numberValue(input.frequencyIndex) ?? identityRef?.frequencyIndex,
        }
      : {}),
    ...((numberValue(input.frequencyHz) ?? identityRef?.frequencyHz) !== undefined
      ? { frequencyHz: numberValue(input.frequencyHz) ?? identityRef?.frequencyHz }
      : {}),
    ...((numberValue(input.kPathCoordinateRadPerM) ?? identityRef?.kPathCoordinateRadPerM) !== undefined
      ? {
          kPathCoordinateRadPerM:
            numberValue(input.kPathCoordinateRadPerM) ?? identityRef?.kPathCoordinateRadPerM,
        }
      : {}),
    label: overlayLabelFromContext(context, resolvedSource),
    ...((numberValue(input.modeIndex) ?? identityRef?.modeIndex) !== undefined
      ? { modeIndex: numberValue(input.modeIndex) ?? identityRef?.modeIndex }
      : {}),
    ...(modeIntent?.fieldId === fieldId ? { modeIntent } : {}),
    ...(analysisResultFieldIntent?.fieldId === fieldId
      ? { analysisResultFieldIntent }
      : {}),
    ...(phasorConvention ? { phasorConvention } : {}),
    query: defaultView == null
      ? overlayQueryFromContext(context, phaseRad)
      : overlayQueryWithDefaultViewFromContext(context, defaultView, phaseRad),
    source: resultSource,
    ...((numberValue(input.sampleIndex) ?? identityRef?.sampleIndex) !== undefined
      ? { sampleIndex: numberValue(input.sampleIndex) ?? identityRef?.sampleIndex }
      : {}),
    visualizationPhaseRad: phaseRad,
    ...(identityRef || artifactRevision !== undefined || runId
      ? {
          provenance: {
            artifactRevision,
            datasetId: analysisResultFieldIntent?.datasetId,
            datasetRevision: analysisResultFieldIntent?.datasetRevision,
            equilibriumId,
            fieldRevision: analysisResultFieldIntent?.fieldRevision,
            kContextKind,
            normalization,
            observableId:
              selectedRef?.observableId ??
              stringValue(input.observableId) ??
              activeIdentityOverlay?.provenance?.observableId,
            representation,
            resourceRef,
            runId,
            stageId,
            studyProduct:
              analysisResultFieldIntent?.itemKind === "eigen_mode"
                ? "modal_eigen"
                : analysisResultFieldIntent?.itemKind ===
                    "driven_frequency_point"
                  ? "driven_response"
                  : analysisResultFieldIntent
                    ? "time_domain_spectrum"
                    : studyProduct,
          },
        }
      : {}),
    ...(wavevectorKf ? { wavevectorKf } : {}),
  };
}

function rebindTargetFromContext(
  context: CommandContext,
): AnalysisFieldOverlayState | null {
  const ref = selectedFrequencyDomainRef(context);
  const resultRef = selectedAnalysisResultRef(context);
  const source =
    sourceFromSelectionRef(ref) ?? sourceFromAnalysisResultRef(resultRef);
  return source ? overlayStateFromContext(context, source) : null;
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
          direction: overlay.animation?.direction ?? 1,
          loop: overlay.animation?.loop ?? true,
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
          direction: overlay.animation?.direction ?? 1,
          loop: overlay.animation?.loop ?? true,
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
        if (source === "eigen-mode") {
          return "Selected analysis field is not a modal eigen field.";
        }
        if (source === "frequency-response") {
          return "Selected analysis field is not a driven response field.";
        }
        return "Selected analysis field is not a time-domain response field.";
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
            resourceKey:
              state.analysisResultFieldIntent?.fieldRef.resource_key ??
              `data/fields/${encodeURIComponent(state.fieldId)}`,
          },
          selection: {
            resourceKey:
              selection?.ref?.type === "frequency-domain"
                ? selection.ref.resourceRef ?? state.fieldId
                : selection?.ref?.type === "analysis-result"
                  ? selection.ref.fieldRef?.resource_key ?? state.fieldId
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
  plotCommand(
    "analysis.time-domain.plot-response-field-3d",
    "Plot time-domain response field in 3D",
    "time-domain-response",
  ),
  plotCommand(
    "analysis.time-domain.plot-response-field-3d-real",
    "Plot time-domain response field real in 3D",
    "time-domain-response",
    "real",
  ),
  plotCommand(
    "analysis.time-domain.plot-response-field-3d-imag",
    "Plot time-domain response field imag in 3D",
    "time-domain-response",
    "imag",
  ),
  plotCommand(
    "analysis.time-domain.plot-response-field-3d-abs",
    "Plot time-domain response field complex magnitude in 3D",
    "time-domain-response",
    "abs",
  ),
  plotCommand(
    "analysis.time-domain.plot-response-field-3d-phase",
    "Plot time-domain response field phase in 3D",
    "time-domain-response",
    "phase",
  ),
  {
    id: "analysis.frequency-domain.rebind-3d-overlay",
    title: "Rebind analysis overlay to selected result",
    category: "analysis",
    disabledReason: (context) => {
      if (!context.analysisFieldOverlay) {
        return "Analysis field controller is unavailable.";
      }
      return context.analysisFieldOverlay.rebindDisabledReason(
        rebindTargetFromContext(context),
      );
    },
    group: "analysis.frequency-domain",
    isEnabled: (context) =>
      Boolean(
        context.analysisFieldOverlay &&
          context.analysisFieldOverlay.rebindDisabledReason(
            rebindTargetFromContext(context),
          ) === null,
      ),
    run: (context) => {
      const controller = context.analysisFieldOverlay;
      const target = rebindTargetFromContext(context);
      const disabledReason = controller
        ? controller.rebindDisabledReason(target)
        : "Analysis field controller is unavailable.";
      if (!controller || !target || disabledReason) {
        return {
          status: "failed",
          message: disabledReason ?? "Analysis overlay rebind is unavailable.",
        };
      }
      if (!controller.rebind(target)) {
        return { status: "failed", message: "Analysis overlay rebind was rejected." };
      }
      activateViewport3D(context);
      return {
        status: "completed",
        message: `Analysis overlay rebound to ${target.label}.`,
      };
    },
    scope: "selection",
  },
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
