/* ── ControlRoom pure helper functions ──
 * Stateless functions extracted from ControlRoomContext.tsx to reduce file size. */

import type {
  CurrentDisplaySelection,
  DisplaySelection,
  EngineLogEntry,
  PreviewConfig,
  PreviewState,
  ScriptBuilderStageState,
  ScriptBuilderState,
  SessionManifest,
} from "@/lib/session/types";
import type {
  ScriptBuilderCurrentModuleEntry,
  ScriptBuilderExcitationAnalysisEntry,
  ScriptBuilderGeometryEntry,
  ModelBuilderGraphV2,
  ScriptBuilderUniverseState,
} from "../../../lib/session/types";
import { serializeModelBuilderGraphV2 } from "../../../lib/session/modelBuilderGraph";
import { buildSceneDocumentFromScriptBuilder } from "../../../lib/session/sceneDocument";
import { asVec3 } from "./shared";
import {
  displaySelectionFromPreviewComponent,
  previewComponentFromDisplaySelection as previewComponentFromApiDisplaySelection,
} from "@/src/api/displaySelection";
import { DEFAULT_SOLVER_SETTINGS } from "../../panels/SolverSettingsPanel";
import type { SolverSettingsState } from "../../panels/SolverSettingsPanel";
import { DEFAULT_MESH_OPTIONS } from "@/lib/mesh/options";
import type { MeshOptionsState } from "@/lib/mesh/options";
import type { BackendErrorInfo, SolverPlanSummary } from "./types";
import type { VectorComponent } from "./shared";

/* ── Record / typing helpers ── */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/* ── Display selection comparison ── */

export function sameDisplaySelection(
  left: DisplaySelection | null | undefined,
  right: DisplaySelection | null | undefined,
): boolean {
  if (!left || !right) return false;
  return (
    left.quantity === right.quantity &&
    left.kind === right.kind &&
    left.view_mode === right.view_mode &&
    left.field_component === right.field_component &&
    left.layer === right.layer &&
    left.all_layers === right.all_layers &&
    left.x_chosen_size === right.x_chosen_size &&
    left.y_chosen_size === right.y_chosen_size &&
    left.every_n === right.every_n &&
    left.max_points === right.max_points &&
    left.auto_scale_enabled === right.auto_scale_enabled
  );
}

export function previewComponentFromDisplaySelection(
  selection: Pick<DisplaySelection, "view_mode" | "field_component">,
): "3D" | VectorComponent {
  return previewComponentFromApiDisplaySelection(selection) as "3D" | VectorComponent;
}

export function buildRequestedDisplaySelection({
  optimisticDisplaySelection,
  displaySelection,
  previewConfig,
  preview,
  spatialPreview,
  kindForQuantity,
}: {
  optimisticDisplaySelection: DisplaySelection | null;
  displaySelection: CurrentDisplaySelection | null;
  previewConfig: Partial<
    Pick<
      PreviewConfig,
      | "quantity"
      | "component"
      | "layer"
      | "all_layers"
      | "every_n"
      | "max_points"
      | "x_chosen_size"
      | "y_chosen_size"
      | "auto_scale_enabled"
    >
  > | null;
  preview: PreviewState | null;
  spatialPreview: Partial<
    Pick<
      Extract<PreviewState, { kind: "spatial" }>,
      | "component"
      | "layer"
      | "all_layers"
      | "max_points"
      | "x_chosen_size"
      | "y_chosen_size"
      | "auto_scale_enabled"
    >
  > | null;
  kindForQuantity: (quantity: string) => DisplaySelection["kind"];
}): DisplaySelection {
  if (optimisticDisplaySelection) {
    return optimisticDisplaySelection;
  }

  const quantity =
    displaySelection?.selection.quantity ??
    previewConfig?.quantity ??
    preview?.quantity ??
    "m";
  const fallbackComponent =
    previewConfig?.component ?? spatialPreview?.component ?? "3D";
  const nextSelection: DisplaySelection = {
    quantity,
    kind: displaySelection?.selection.kind ?? kindForQuantity(quantity),
    ...(() => {
      const fallbackDisplaySelection = displaySelectionFromPreviewComponent(
        fallbackComponent === "3D" ||
          fallbackComponent === "x" ||
          fallbackComponent === "y" ||
          fallbackComponent === "z" ||
          fallbackComponent === "magnitude"
          ? fallbackComponent
          : "magnitude",
      );
      return {
        view_mode:
          displaySelection?.selection.view_mode ??
          fallbackDisplaySelection.view_mode,
        field_component:
          displaySelection?.selection.field_component ??
          fallbackDisplaySelection.field_component,
      };
    })(),
    layer:
      displaySelection?.selection.layer ??
      previewConfig?.layer ??
      spatialPreview?.layer ??
      0,
    all_layers:
      displaySelection?.selection.all_layers ??
      previewConfig?.all_layers ??
      spatialPreview?.all_layers ??
      false,
    x_chosen_size:
      displaySelection?.selection.x_chosen_size ??
      previewConfig?.x_chosen_size ??
      spatialPreview?.x_chosen_size ??
      0,
    y_chosen_size:
      displaySelection?.selection.y_chosen_size ??
      previewConfig?.y_chosen_size ??
      spatialPreview?.y_chosen_size ??
      0,
    every_n:
      displaySelection?.selection.every_n ??
      previewConfig?.every_n ??
      50,
    max_points:
      displaySelection?.selection.max_points ??
      previewConfig?.max_points ??
      spatialPreview?.max_points ??
      16_384,
    auto_scale_enabled:
      displaySelection?.selection.auto_scale_enabled ??
      previewConfig?.auto_scale_enabled ??
      spatialPreview?.auto_scale_enabled ??
      true,
  };

  if (nextSelection.kind !== "vector_field") {
    nextSelection.view_mode = "2d";
    nextSelection.field_component = "magnitude";
  }

  return nextSelection;
}

/* ── Command kind label ── */

export function commandKindLabel(kind: string | null | undefined): string {
  switch (kind) {
    case "run": return "Run";
    case "relax": return "Relax";
    case "pause": return "Pause";
    case "resume": return "Resume";
    case "stop":
    case "break": return "Stop";
    case "solve": return "Compute";
    case "remesh": return "Remesh";
    case "save_vtk": return "Export VTK";
    default: return kind && kind.trim().length > 0 ? kind : "Command";
  }
}

function compactSingleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function parseEmbeddedJsonErrorPayload(
  message: string,
): { start: number; error: string | null; traceback: string | null } | null {
  for (let index = message.indexOf("{"); index >= 0; index = message.indexOf("{", index + 1)) {
    const candidate = message.slice(index).trim();
    if (!candidate.includes('"error"') && !candidate.includes('"traceback"')) {
      continue;
    }
    try {
      const parsed = JSON.parse(candidate) as { error?: unknown; traceback?: unknown };
      if (parsed && typeof parsed === "object") {
        return {
          start: index,
          error: asString(parsed.error),
          traceback: asString(parsed.traceback),
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function parseBackendErrorMessage(
  message: string,
): Omit<BackendErrorInfo, "timestampUnixMs" | "level"> {
  const trimmed = message.trim();
  if (!trimmed) {
    return {
      title: "Operation interrupted by backend error",
      summary: "Backend error",
      details: "Backend error",
      traceback: null,
    };
  }

  const embeddedPayload = parseEmbeddedJsonErrorPayload(trimmed);
  if (embeddedPayload) {
    const prefix = trimmed.slice(0, embeddedPayload.start).trim();
    const prefixLine = compactSingleLine(prefix.split("\n").filter(Boolean).pop() ?? "");
    const payloadError = compactSingleLine(embeddedPayload.error ?? "");
    const summaryParts = [
      prefixLine,
      payloadError && !prefix.includes(payloadError) ? payloadError : "",
    ].filter(Boolean);
    return {
      title: "Operation interrupted by backend error",
      summary: summaryParts.length > 0 ? summaryParts.join(" — ") : (payloadError || "Backend error"),
      details: [
        prefix,
        embeddedPayload.error && !prefix.includes(embeddedPayload.error) ? embeddedPayload.error : "",
        embeddedPayload.traceback ?? "",
      ].filter(Boolean).join("\n\n"),
      traceback: embeddedPayload.traceback,
    };
  }

  const tracebackMarker = "Traceback (most recent call last):";
  const tracebackIndex = trimmed.indexOf(tracebackMarker);
  if (tracebackIndex >= 0) {
    const prefix = trimmed.slice(0, tracebackIndex).trim();
    const traceback = trimmed.slice(tracebackIndex).trim();
    return {
      title: "Operation interrupted by backend error",
      summary: compactSingleLine(prefix.split("\n").filter(Boolean).pop() ?? "Backend error"),
      details: trimmed,
      traceback,
    };
  }

  return {
    title: "Operation interrupted by backend error",
    summary: compactSingleLine(trimmed.split("\n").find((line) => line.trim().length > 0) ?? "Backend error"),
    details: trimmed,
    traceback: null,
  };
}

export function latestBackendErrorFromLog(
  engineLog: EngineLogEntry[],
): BackendErrorInfo | null {
  for (let index = engineLog.length - 1; index >= 0; index -= 1) {
    const entry = engineLog[index];
    if (String(entry?.level ?? "").toLowerCase() !== "error") {
      continue;
    }
    return {
      timestampUnixMs: Number(entry.timestamp_unix_ms ?? 0),
      level: String(entry.level ?? "error"),
      ...parseBackendErrorMessage(String(entry.message ?? "")),
    };
  }
  return null;
}

/* ── Script-builder ↔ settings conversion ── */

export function solverSettingsFromBuilder(
  builder: ScriptBuilderState["solver"],
): SolverSettingsState {
  return {
    ...DEFAULT_SOLVER_SETTINGS,
    integrator: builder.integrator || DEFAULT_SOLVER_SETTINGS.integrator,
    fixedTimestep: builder.fixed_timestep,
    relaxAlgorithm: builder.relax_algorithm || DEFAULT_SOLVER_SETTINGS.relaxAlgorithm,
    torqueTolerance: builder.torque_tolerance,
    energyTolerance: builder.energy_tolerance,
    maxRelaxSteps: builder.max_relax_steps,
  };
}

export function solverSettingsToBuilder(
  settings: SolverSettingsState,
): ScriptBuilderState["solver"] {
  return {
    integrator: settings.integrator || "",
    fixed_timestep: settings.fixedTimestep,
    relax_algorithm: settings.relaxAlgorithm || "",
    torque_tolerance: settings.torqueTolerance,
    energy_tolerance: settings.energyTolerance,
    max_relax_steps: settings.maxRelaxSteps,
  };
}

export function meshOptionsFromBuilder(
  builder: ScriptBuilderState["mesh"],
): MeshOptionsState {
  return {
    ...DEFAULT_MESH_OPTIONS,
    algorithm2d: builder.algorithm_2d,
    algorithm3d: builder.algorithm_3d,
    sizeControlMode: builder.size_mode === "custom" ? "custom" : "predefined",
    calibrateFor: builder.calibrate_for ?? "general_physics",
    sizePreset: builder.size_preset ?? "normal",
    hmax: builder.maximum_element_size ?? builder.hmax,
    hmin: builder.minimum_element_size ?? builder.hmin,
    maximumElementSize: builder.maximum_element_size ?? builder.hmax,
    minimumElementSize: builder.minimum_element_size ?? builder.hmin,
    sizeFactor: builder.size_factor,
    sizeFromCurvature: builder.size_from_curvature,
    curvatureFactor: builder.curvature_factor ?? "",
    growthRate: builder.growth_rate,
    maximumElementGrowthRate: builder.maximum_element_growth_rate ?? builder.growth_rate,
    narrowRegions: builder.narrow_regions,
    narrowRegionResolution: builder.narrow_region_resolution ?? "",
    resolvedSizeFromCurvature: builder.resolved_size_from_curvature ?? null,
    resolvedNarrowRegions: builder.resolved_narrow_regions ?? null,
    resolvedGrowthRate: builder.resolved_growth_rate ?? "",
    smoothingSteps: builder.smoothing_steps,
    optimize: builder.optimize,
    optimizeIters: builder.optimize_iterations,
    computeQuality: builder.compute_quality,
    perElementQuality: builder.per_element_quality,
    interfaceHMax: builder.interface_hmax ?? "",
    interfaceThickness: builder.interface_thickness ?? "",
    transitionDistance: builder.transition_distance ?? "",
    transitionGrowth: builder.transition_growth ?? "",
    adaptiveEnabled: builder.adaptive_enabled ?? false,
    adaptivePolicy: builder.adaptive_policy || "auto",
    adaptiveIndicator: builder.adaptive_indicator || "geometric_only",
    adaptiveTargetQuantity: builder.adaptive_target_quantity || "auto",
    adaptiveConvergenceMetric: builder.adaptive_convergence_metric || "energy_delta",
    adaptiveTheta: builder.adaptive_theta ?? 0.3,
    adaptiveHMin: builder.adaptive_h_min || "",
    adaptiveHMax: builder.adaptive_h_max || "",
    adaptiveMaxPasses: builder.adaptive_max_passes ?? 2,
    adaptiveErrorTolerance: builder.adaptive_error_tolerance || "1e-3",
  };
}

export function meshOptionsToBuilder(
  options: MeshOptionsState,
  current?: ScriptBuilderState["mesh"] | null,
): ScriptBuilderState["mesh"] {
  return {
    ...current,
    algorithm_2d: options.algorithm2d,
    algorithm_3d: options.algorithm3d,
    size_mode: options.sizeControlMode === "custom" ? "custom" : "predefined",
    hmax: options.hmax,
    hmin: options.hmin,
    maximum_element_size: options.maximumElementSize,
    minimum_element_size: options.minimumElementSize,
    calibrate_for: options.calibrateFor,
    size_preset: options.sizePreset,
    size_factor: options.sizeFactor,
    size_from_curvature: options.sizeFromCurvature,
    curvature_factor: options.curvatureFactor,
    growth_rate: options.growthRate,
    maximum_element_growth_rate: options.maximumElementGrowthRate,
    narrow_regions: options.narrowRegions,
    narrow_region_resolution: options.narrowRegionResolution,
    resolved_size_from_curvature: options.resolvedSizeFromCurvature ?? null,
    resolved_narrow_regions: options.resolvedNarrowRegions ?? null,
    resolved_growth_rate: options.resolvedGrowthRate ?? "",
    smoothing_steps: options.smoothingSteps,
    optimize: options.optimize,
    optimize_iterations: options.optimizeIters,
    compute_quality: options.computeQuality,
    per_element_quality: options.perElementQuality,
    interface_hmax: options.interfaceHMax,
    interface_thickness: options.interfaceThickness,
    transition_distance: options.transitionDistance,
    transition_growth: options.transitionGrowth,
    adaptive_enabled: options.adaptiveEnabled,
    adaptive_policy: options.adaptivePolicy,
    adaptive_indicator: options.adaptiveIndicator,
    adaptive_target_quantity: options.adaptiveTargetQuantity,
    adaptive_convergence_metric: options.adaptiveConvergenceMetric,
    adaptive_theta: options.adaptiveTheta,
    adaptive_h_min: options.adaptiveHMin,
    adaptive_h_max: options.adaptiveHMax,
    adaptive_max_passes: options.adaptiveMaxPasses,
    adaptive_error_tolerance: options.adaptiveErrorTolerance,
  };
}

export function buildSceneDocumentFromBuilderFallback(
  solverSettings: SolverSettingsState,
  meshOptions: MeshOptionsState,
  demagRealization: string | null,
  universe: ScriptBuilderUniverseState | null,
  stages: ScriptBuilderStageState[],
  geometries: ScriptBuilderGeometryEntry[],
  currentModules: ScriptBuilderCurrentModuleEntry[],
  excitationAnalysis: ScriptBuilderExcitationAnalysisEntry | null,
) {
  return buildSceneDocumentFromScriptBuilder({
    revision: 0,
    backend: null,
    cpu_threads: null,
    fem_demag_solver_policy: null,
    demag_realization: demagRealization,
    external_field: null,
    solver: solverSettingsToBuilder(solverSettings),
    mesh: meshOptionsToBuilder(meshOptions),
    universe,
    domain_frame: null,
    stages,
    study_pipeline: null,
    initial_state: null,
    geometries,
    current_modules: currentModules,
    excitation_analysis: excitationAnalysis,
  });
}

export function buildScriptBuilderUpdatePayload(
  modelBuilderGraph: ModelBuilderGraphV2 | null,
  fallback: {
    solverSettings: SolverSettingsState;
    meshOptions: MeshOptionsState;
    demagRealization: string | null;
    universe: ScriptBuilderUniverseState | null;
    stages: ScriptBuilderStageState[];
    geometries: ScriptBuilderGeometryEntry[];
    currentModules: ScriptBuilderCurrentModuleEntry[];
    excitationAnalysis: ScriptBuilderExcitationAnalysisEntry | null;
  },
) {
  if (modelBuilderGraph) {
    const scene = buildSceneDocumentFromScriptBuilder({
      revision: modelBuilderGraph.revision,
      initial_state: modelBuilderGraph.study.initial_state,
      ...serializeModelBuilderGraphV2(modelBuilderGraph),
    });
    scene.study.requested_backend = modelBuilderGraph.study.requested_backend;
    scene.study.requested_device = modelBuilderGraph.study.requested_device;
    scene.study.requested_precision = modelBuilderGraph.study.requested_precision;
    scene.study.requested_mode = modelBuilderGraph.study.requested_mode;
    return scene;
  }
  return buildSceneDocumentFromBuilderFallback(
    fallback.solverSettings,
    fallback.meshOptions,
    fallback.demagRealization,
    fallback.universe,
    fallback.stages,
    fallback.geometries,
    fallback.currentModules,
    fallback.excitationAnalysis,
  );
}

export function buildScriptBuilderSignature(
  modelBuilderGraph: ModelBuilderGraphV2 | null,
  fallback: {
    solverSettings: SolverSettingsState;
    meshOptions: MeshOptionsState;
    demagRealization: string | null;
    universe: ScriptBuilderUniverseState | null;
    stages: ScriptBuilderStageState[];
    geometries: ScriptBuilderGeometryEntry[];
    currentModules: ScriptBuilderCurrentModuleEntry[];
    excitationAnalysis: ScriptBuilderExcitationAnalysisEntry | null;
  },
): string {
  return JSON.stringify(
    buildScriptBuilderUpdatePayload(modelBuilderGraph, fallback),
  );
}

/* ── File I/O helpers ── */

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Failed to read uploaded file"));
        return;
      }
      const base64 = result.includes(",") ? result.split(",", 2)[1] ?? "" : result;
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read uploaded file"));
    reader.readAsDataURL(file);
  });
}

export function downloadBase64File(fileName: string, contentBase64: string) {
  const binary = atob(contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

/* ── Solver plan extraction ── */

export function extractSolverPlan(
  metadata: Record<string, unknown> | null,
  session: SessionManifest | null,
): SolverPlanSummary | null {
  const executionPlan = asRecord(metadata?.execution_plan);
  const backendPlan = asRecord(executionPlan?.backend_plan);
  if (!backendPlan) return null;

  const common = asRecord(executionPlan?.common);
  const material = asRecord(backendPlan.material);
  const adaptive = asRecord(backendPlan.adaptive_timestep);
  const relaxation = asRecord(backendPlan.relaxation);
  const demagSolverPolicy = asRecord(backendPlan.demag_solver_policy);
  const planSummary = asRecord(session?.plan_summary);

  return {
    backendKind: asString(backendPlan.kind),
    requestedBackend:
      asString(common?.requested_backend) ?? asString(planSummary?.requested_backend) ?? session?.requested_backend ?? null,
    resolvedBackend:
      asString(common?.resolved_backend) ?? asString(planSummary?.resolved_backend) ?? null,
    executionMode:
      asString(common?.execution_mode) ?? asString(planSummary?.execution_mode) ?? session?.execution_mode ?? null,
    precision: asString(backendPlan.precision) ?? session?.precision ?? null,
    integrator: asString(backendPlan.integrator),
    fixedTimestep: asNumber(backendPlan.fixed_timestep),
    adaptive: adaptive
      ? {
          atol: asNumber(adaptive.atol),
          dtInitial: asNumber(adaptive.dt_initial),
          dtMin: asNumber(adaptive.dt_min),
          dtMax: asNumber(adaptive.dt_max),
          safety: asNumber(adaptive.safety),
        }
      : null,
    relaxation: relaxation
      ? {
          algorithm: asString(relaxation.algorithm),
          torqueTolerance: asNumber(relaxation.torque_tolerance),
          energyTolerance: asNumber(relaxation.energy_tolerance),
          maxSteps: asNumber(relaxation.max_steps),
        }
      : null,
    gyromagneticRatio: asNumber(backendPlan.gyromagnetic_ratio),
    exchangeBoundary: asString(backendPlan.exchange_bc),
    externalField: asVec3(backendPlan.external_field),
    exchangeEnabled: backendPlan.enable_exchange === true,
    demagEnabled: backendPlan.enable_demag === true,
    cellSize: asVec3(backendPlan.cell_size),
    gridCells: asVec3(asRecord(backendPlan.grid)?.cells),
    meshName: asString(backendPlan.mesh_name),
    meshSource: asString(backendPlan.mesh_source),
    feOrder: asNumber(backendPlan.fe_order),
    hmax: asNumber(backendPlan.hmax),
    demagSolver: demagSolverPolicy
      ? {
          family: "hypre",
          method: asString(demagSolverPolicy.solver),
          preconditioner: asString(demagSolverPolicy.preconditioner),
          relativeTolerance: asNumber(demagSolverPolicy.rtol),
          absoluteTolerance: asNumber(demagSolverPolicy.atol),
          maxIterations: asNumber(demagSolverPolicy.max_iterations),
          printLevel: asNumber(demagSolverPolicy.print_level),
        }
      : null,
    materialName: asString(material?.name),
    materialMsat: asNumber(material?.saturation_magnetisation),
    materialAex: asNumber(material?.exchange_stiffness),
    materialAlpha: asNumber(material?.damping),
    notes: asStringArray(planSummary?.notes),
  };
}

export function extractFemCpuThreadSummary(
  engineLog: EngineLogEntry[],
): {
  requestedOmpThreads: number | null;
  effectiveOmpThreads: number | null;
} | null {
  for (let index = engineLog.length - 1; index >= 0; index -= 1) {
    const message = engineLog[index]?.message ?? "";
    if (!message.includes("requested_omp_threads=") || !message.includes("effective_omp_threads=")) {
      continue;
    }
    const requestedMatch = message.match(/requested_omp_threads=(\d+)/);
    const effectiveMatch = message.match(/effective_omp_threads=(\d+)/);
    return {
      requestedOmpThreads: requestedMatch ? Number(requestedMatch[1]) : null,
      effectiveOmpThreads: effectiveMatch ? Number(effectiveMatch[1]) : null,
    };
  }
  return null;
}
