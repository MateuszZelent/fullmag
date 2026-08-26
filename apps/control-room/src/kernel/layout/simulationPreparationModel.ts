import type {
  LiveStatusResource,
  SimulationPreparationResource,
} from "../api/apiTypes";
import type { ResourceResult } from "../resources/resourceTypes";

const MAX_PREPARATION_LOG_ENTRIES = 200;
const MAX_FAILURE_PREDICATES = 32;
const MAX_FAILURE_PREDICATE_TEXT_LENGTH = 4096;
const MAX_FAILURE_PREDICATE_LENGTH = 160;
const FAILURE_PREDICATE_MARKER = "failed_predicates=[";
const BOOTSTRAPPING_STATUSES = new Set(["bootstrapping"]);
const MATERIALIZING_STATUSES = new Set(["materializing_script"]);

const FEM_ORDER_NOT_P1 = {
  action: "Use first-order (P1) elements for the mixed-prism lane.",
  label: "The requested finite-element order is unsupported",
};
const EXPLICIT_DEVICE_REQUIRED = {
  action: "Choose an explicit CPU or GPU device for this FEM mixed-P1 run.",
  label: "The FEM device is not explicit",
};
const DOUBLE_PRECISION_REQUIRED = {
  action: "Select double precision for this mixed-P1 FEM lane.",
  label: "The requested precision is unsupported",
};
const CERTIFIED_LAYER_COUNT_REQUIRED = {
  action: "Choose exactly 1, 2, or 3 magnetic prism layers.",
  label: "The requested layer count is outside the certified range",
};
const FEM_BACKEND_REQUIRED = {
  action: "Choose FEM as the explicit backend for this mixed-P1 run.",
  label: "The requested backend is not FEM",
};
const STRICT_EXECUTION_REQUIRED = {
  action: "Select strict execution mode for this mixed-P1 FEM run.",
  label: "The execution mode is not strict",
};
const EXCHANGE_REQUIRED = {
  action:
    "Remove disable_exchange() and duplicate explicit Exchange terms; exchange is enabled by default when Aex is present.",
  label: "Exchange must be enabled exactly once",
};
const DEMAG_REQUIRED = {
  action:
    "Remove disable_demag() and duplicate explicit Demag terms; demagnetization defaults to Auto and must resolve to Poisson Robin or Poisson Dirichlet.",
  label:
    "Demagnetization must be enabled exactly once with a supported open-boundary realization",
};
const DEMAG_REALIZATION_REQUIRED = {
  action:
    "Resolve Demag to Poisson Robin or Poisson Dirichlet before starting the mixed-P1 run.",
  label: "The demagnetization realization is unsupported",
};
const RELAXATION_STUDY_REQUIRED = {
  action:
    "Use a relaxation study with Projected Gradient BB, Nonlinear CG, or overdamped LLG.",
  label: "The requested relaxation study is unsupported",
};
const FEM_RELAXATION_PLAN_REQUIRED = {
  action: "Create a FEM relaxation plan before running this mixed-P1 case.",
  label: "The FEM relaxation plan is missing",
};
const BOX_GEOMETRY_REQUIRED = {
  action: "Use exactly one axis-aligned Box geometry for this mixed-P1 case.",
  label: "The geometry is outside the mixed-P1 scope",
};
const REGION_REQUIRED = {
  action: "Use exactly one magnetic region in this mixed-P1 case.",
  label: "The region count is outside the mixed-P1 scope",
};
const MAGNET_REQUIRED = {
  action: "Use exactly one magnet in this mixed-P1 case.",
  label: "The magnet count is outside the mixed-P1 scope",
};
const OBJECT_REGIONS_FORBIDDEN = {
  action: "Remove object-region overrides from this mixed-P1 case.",
  label: "Object-region overrides are outside the mixed-P1 scope",
};
const MS_FIELD_FORBIDDEN = {
  action: "Use a spatially uniform saturation magnetization (Ms).",
  label: "The saturation magnetization field is unsupported",
};
const A_FIELD_FORBIDDEN = {
  action: "Use a spatially uniform exchange stiffness (Aex).",
  label: "The exchange-stiffness field is unsupported",
};
const ALPHA_FIELD_FORBIDDEN = {
  action: "Use a spatially uniform damping constant (alpha).",
  label: "The damping field is unsupported",
};
const MATERIAL_PARAMETER_FIELDS_FORBIDDEN = {
  action:
    "Remove material parameter fields and keep Ms, Aex, and alpha uniform.",
  label: "Material parameter fields are outside the mixed-P1 scope",
};
const COUPLINGS_FORBIDDEN = {
  action: "Remove model couplings from this mixed-P1 case.",
  label: "Model couplings are outside the mixed-P1 scope",
};
const CURRENT_MODULES_FORBIDDEN = {
  action: "Remove current modules from this mixed-P1 case.",
  label: "Current modules are outside the mixed-P1 scope",
};
const FIELD_DRIVES_FORBIDDEN = {
  action: "Remove field drives from this mixed-P1 case.",
  label: "Field drives are outside the mixed-P1 scope",
};
const SPIN_TRANSFER_TORQUE_FORBIDDEN = {
  action:
    "Remove spin-transfer-torque modules and parameters from this mixed-P1 case.",
  label: "Spin-transfer torque is outside the mixed-P1 scope",
};
const THERMAL_MODEL_FORBIDDEN = {
  action: "Remove the temperature model from this mixed-P1 case.",
  label: "Thermal physics is outside the mixed-P1 scope",
};
const MAGNETOELASTIC_OR_MECHANICS_FORBIDDEN = {
  action:
    "Remove magnetoelastic and mechanics models from this mixed-P1 case.",
  label: "Magnetoelastic or mechanics physics is outside the mixed-P1 scope",
};
const PERIODIC_BOUNDARIES_FORBIDDEN = {
  action: "Remove periodic boundary conditions from this mixed-P1 case.",
  label: "Periodic boundary conditions are outside the mixed-P1 scope",
};
const EXTENDED_MODULE_FORBIDDEN = {
  action: "Remove unsupported extended modules from this mixed-P1 case.",
  label: "An extended module is outside the mixed-P1 scope",
};
const DMI_CPU_REQUIRED = {
  action: "Run DMI on FEM CPU and select CPU explicitly for this mixed-P1 case.",
  label: "DMI requires an explicit FEM CPU device",
};
const LAYER_COUNT_MISMATCH = {
  action:
    "Regenerate the mesh so the realized layer count matches the requested layer count.",
  label: "The realized layer count does not match the request",
};
const MAGNETIC_PLANE_CERTIFICATE_MISMATCH = {
  action:
    "Regenerate the mesh so its magnetic-plane coordinates match the requested layer count.",
  label: "The magnetic-plane certificate is inconsistent",
};
const MESH_FALLBACK_FORBIDDEN = {
  action:
    "Regenerate the mesh without topology fallbacks for this mixed-P1 case.",
  label: "The mesh certificate records a fallback",
};
const NATIVE_MIXED_CELLS_REQUIRED = {
  action:
    "Regenerate the mixed-P1 mesh with Prism6 magnetic cells, Pyramid5/Tet4 air cells, and no other cell families.",
  label: "The native mesh cell families are unsupported",
};
const NATIVE_MIXED_FACETS_REQUIRED = {
  action: "Regenerate the mixed-P1 mesh with Tri3 and Quad4 facets only.",
  label: "The native mesh facet families are unsupported",
};
const NATIVE_MAGNETIC_MARKERS_REQUIRED = {
  action: "Regenerate the mesh so magnetic cells are marked Prism6 cells.",
  label: "The native magnetic-cell markers are inconsistent",
};
const NATIVE_PLAN_TOPOLOGY_REQUIRED = {
  action:
    "Regenerate or re-import the mesh so its topology matches the FEM plan.",
  label: "The imported mesh topology does not match the FEM plan",
};
const NATIVE_EXTENDED_PHYSICS_FORBIDDEN = {
  action:
    "Remove extended native physics outside uniform Ms, Aex, alpha, local anisotropy, and CPU-only DMI.",
  label: "Native extended physics is outside the mixed-P1 scope",
};

const KNOWN_FAILURE_PREDICATES: Record<
  string,
  Pick<SimulationPreparationFailureCauseView, "action" | "label">
> = {
  backend_not_explicit_fem: FEM_BACKEND_REQUIRED,
  backend_not_fem: FEM_BACKEND_REQUIRED,
  device_not_explicit_cpu_or_gpu: EXPLICIT_DEVICE_REQUIRED,
  explicit_cpu_or_cuda_device: EXPLICIT_DEVICE_REQUIRED,
  explicit_device_cpu_or_gpu_required: EXPLICIT_DEVICE_REQUIRED,
  execution_mode_not_strict: STRICT_EXECUTION_REQUIRED,
  double_precision: DOUBLE_PRECISION_REQUIRED,
  precision_not_double: DOUBLE_PRECISION_REQUIRED,
  execution_precision_not_double: DOUBLE_PRECISION_REQUIRED,
  fem_precision_not_double: DOUBLE_PRECISION_REQUIRED,
  fem_fe_order_not_p1: FEM_ORDER_NOT_P1,
  fem_order_not_p1: FEM_ORDER_NOT_P1,
  p1: FEM_ORDER_NOT_P1,
  missing_exchange: EXCHANGE_REQUIRED,
  exchange_term_count_not_one: EXCHANGE_REQUIRED,
  exchange_count_not_one: EXCHANGE_REQUIRED,
  fem_exchange_disabled: EXCHANGE_REQUIRED,
  exchange: EXCHANGE_REQUIRED,
  missing_qualified_demag: DEMAG_REQUIRED,
  demag_term_count_not_one: DEMAG_REQUIRED,
  demag_count_not_one: DEMAG_REQUIRED,
  fem_demag_disabled: DEMAG_REQUIRED,
  demag_realization_not_poisson_robin_or_dirichlet: DEMAG_REALIZATION_REQUIRED,
  fem_demag_realization_not_poisson_robin_or_dirichlet:
    DEMAG_REALIZATION_REQUIRED,
  poisson_robin_or_dirichlet: DEMAG_REALIZATION_REQUIRED,
  unsupported_study: RELAXATION_STUDY_REQUIRED,
  study_not_relaxation: RELAXATION_STUDY_REQUIRED,
  study_relaxation_algorithm_unsupported: RELAXATION_STUDY_REQUIRED,
  fem_relaxation_algorithm_unsupported: RELAXATION_STUDY_REQUIRED,
  fem_relaxation_plan_missing: FEM_RELAXATION_PLAN_REQUIRED,
  geometry_not_exactly_one_axis_aligned_box: BOX_GEOMETRY_REQUIRED,
  geometry_count_not_one: BOX_GEOMETRY_REQUIRED,
  geometry_not_box: BOX_GEOMETRY_REQUIRED,
  region_count_not_one: REGION_REQUIRED,
  magnet_count_not_one: MAGNET_REQUIRED,
  gpu_dmi_kernel_not_mixed_p1: {
    action:
      "Run this mixed-P1 case on FEM CPU or remove DMI; the current CUDA DMI kernel is tetrahedral-only.",
    label: "DMI is unavailable on the FEM mixed-P1 GPU lane",
  },
  material_count_not_one: {
    action: "Use exactly one magnetic material in the bounded mixed-P1 lane.",
    label: "The material count is outside the mixed-P1 scope",
  },
  object_region_count_not_zero: OBJECT_REGIONS_FORBIDDEN,
  ms_field_not_uniform: MS_FIELD_FORBIDDEN,
  a_field_not_uniform: A_FIELD_FORBIDDEN,
  alpha_field_not_uniform: ALPHA_FIELD_FORBIDDEN,
  material_parameter_fields_present: MATERIAL_PARAMETER_FIELDS_FORBIDDEN,
  couplings_present: COUPLINGS_FORBIDDEN,
  current_modules_present: CURRENT_MODULES_FORBIDDEN,
  fem_current_modules_present: CURRENT_MODULES_FORBIDDEN,
  field_drives_present: FIELD_DRIVES_FORBIDDEN,
  fem_field_drives_present: FIELD_DRIVES_FORBIDDEN,
  spin_torque_modules_present: SPIN_TRANSFER_TORQUE_FORBIDDEN,
  current_density_present: SPIN_TRANSFER_TORQUE_FORBIDDEN,
  stt_degree_present: SPIN_TRANSFER_TORQUE_FORBIDDEN,
  stt_beta_present: SPIN_TRANSFER_TORQUE_FORBIDDEN,
  stt_spin_polarization_present: SPIN_TRANSFER_TORQUE_FORBIDDEN,
  stt_lambda_present: SPIN_TRANSFER_TORQUE_FORBIDDEN,
  stt_epsilon_prime_present: SPIN_TRANSFER_TORQUE_FORBIDDEN,
  stt_thickness_present: SPIN_TRANSFER_TORQUE_FORBIDDEN,
  stt_fixed_layer_position_present: SPIN_TRANSFER_TORQUE_FORBIDDEN,
  temperature_present: THERMAL_MODEL_FORBIDDEN,
  fem_temperature_present: THERMAL_MODEL_FORBIDDEN,
  fem_magnetoelastic_present: MAGNETOELASTIC_OR_MECHANICS_FORBIDDEN,
  fem_mechanics_present: MAGNETOELASTIC_OR_MECHANICS_FORBIDDEN,
  elastic_materials_present: MAGNETOELASTIC_OR_MECHANICS_FORBIDDEN,
  elastic_bodies_present: MAGNETOELASTIC_OR_MECHANICS_FORBIDDEN,
  magnetostriction_laws_present: MAGNETOELASTIC_OR_MECHANICS_FORBIDDEN,
  mechanical_bcs_present: MAGNETOELASTIC_OR_MECHANICS_FORBIDDEN,
  mechanical_loads_present: MAGNETOELASTIC_OR_MECHANICS_FORBIDDEN,
  periodic_boundary_conditions_present: PERIODIC_BOUNDARIES_FORBIDDEN,
  unsupported_extended_module: EXTENDED_MODULE_FORBIDDEN,
  certificate_requested_layer_count_not_supported: CERTIFIED_LAYER_COUNT_REQUIRED,
  requested_layer_count_outside_1_to_3: CERTIFIED_LAYER_COUNT_REQUIRED,
  realized_layer_count_mismatch: LAYER_COUNT_MISMATCH,
  certificate_realized_layer_count_mismatch: LAYER_COUNT_MISMATCH,
  magnetic_plane_count_mismatch: MAGNETIC_PLANE_CERTIFICATE_MISMATCH,
  certificate_magnetic_plane_count_mismatch: MAGNETIC_PLANE_CERTIFICATE_MISMATCH,
  mesh_fallback_triggered: MESH_FALLBACK_FORBIDDEN,
  certificate_fallbacks_triggered: MESH_FALLBACK_FORBIDDEN,
  mixed_cell_families: NATIVE_MIXED_CELLS_REQUIRED,
  mixed_facet_families: NATIVE_MIXED_FACETS_REQUIRED,
  magnetic_prism6_markers: NATIVE_MAGNETIC_MARKERS_REQUIRED,
  plan_topology_matches_import: NATIVE_PLAN_TOPOLOGY_REQUIRED,
  dmi_requires_explicit_cpu: DMI_CPU_REQUIRED,
  unrelated_extended_physics_scope: NATIVE_EXTENDED_PHYSICS_FORBIDDEN,
  unsupported_energy_term: {
    action:
      "Remove the unsupported interaction or choose a lane whose capability report includes it.",
    label: "An active energy term is outside the mixed-P1 scope",
  },
  unsupported_material_field_or_dmi: {
    action:
      "Use uniform Ms/Aex/alpha; nodal Ku/Kc and CPU DMI fields are supported in the corresponding lanes.",
    label: "A material field or DMI route is outside this mixed-P1 scope",
  },
};

type PreparationStage = SimulationPreparationResource["stages"][number];
type PreparationLogEntry = SimulationPreparationResource["log_tail"][number];

export interface SimulationPreparationStageView {
  readonly detail: string;
  readonly elapsedLabel: string;
  readonly id: PreparationStage["id"];
  readonly isActive: boolean;
  readonly label: string;
  readonly progressLabel: string | null;
  readonly stateLabel: string;
  readonly status: PreparationStage["status"];
}

export interface SimulationPreparationLogEntryView {
  readonly level: PreparationLogEntry["level"];
  readonly message: string;
  readonly stageLabel: string;
  readonly timestampLabel: string;
}

export interface SimulationPreparationFailureCauseView {
  readonly action: string;
  readonly known: boolean;
  readonly label: string;
  readonly predicate: string;
}

export interface ParsedPreparationFailurePredicates {
  readonly analysisTruncated: boolean;
  readonly omittedCount: number;
  readonly predicates: readonly string[];
}

export interface SimulationPreparationFailureView {
  readonly causes: readonly SimulationPreparationFailureCauseView[];
  readonly correlationId: string | null;
  readonly detail: string | null;
  readonly errorCode: string;
  readonly omittedPredicateCount: number;
  readonly predicateAnalysisTruncated: boolean;
  readonly stageElapsedLabel: string;
  readonly stageLabel: string;
  readonly summary: string;
}

export type SimulationPreparationProgressView =
  | { readonly kind: "determinate"; readonly value: number }
  | { readonly kind: "indeterminate" }
  | { readonly kind: "terminal" };

export interface SimulationPreparationViewModel {
  readonly activeStage: SimulationPreparationStageView | null;
  readonly detail: string;
  readonly eyebrow: "Simulation preparation";
  readonly failure: SimulationPreparationFailureView | null;
  readonly isTerminal: boolean;
  readonly isVisible: boolean;
  readonly kind:
    | "connecting"
    | "failed"
    | "hidden"
    | "ready"
    | "resource-error"
    | "running"
    | "stale";
  readonly liveSummary: string;
  readonly logEntries: readonly SimulationPreparationLogEntryView[];
  readonly preparation: SimulationPreparationResource | null;
  readonly progress: SimulationPreparationProgressView;
  readonly progressLabel: string | null;
  readonly reconnectingMessage: string | null;
  readonly reconnectingTitle: string | null;
  readonly requestedExecutionLabel: string | null;
  readonly resolvedExecutionLabel: string | null;
  readonly stages: readonly SimulationPreparationStageView[];
  readonly title: string;
  readonly totalElapsedLabel: string | null;
}

export function resolveSimulationPreparationViewModel(
  preparation: ResourceResult<SimulationPreparationResource>,
  sessionStatus: ResourceResult<LiveStatusResource>,
  nowUnixMs: number | null,
): SimulationPreparationViewModel {
  const snapshot = preparation.data;
  if (!snapshot) {
    return resolveMissingPreparationModel(preparation, sessionStatus);
  }

  const stages = snapshot.stages.map((stage) =>
    resolveStageView(stage, nowUnixMs),
  );
  const activeStage =
    stages.find((stage) => stage.id === snapshot.active_stage_id) ??
    stages.find((stage) => stage.status === "active") ??
    null;
  const stageLabels = new Map(stages.map((stage) => [stage.id, stage.label]));
  const failureStage = snapshot.failure
    ? stages.find((stage) => stage.id === snapshot.failure?.stage_id) ?? null
    : null;
  const progress = resolveProgress(activeStage, snapshot);
  const isStale = preparation.status === "stale";
  const isFailed = snapshot.status === "failed";
  const isReady = snapshot.status === "ready";
  const failurePredicates = snapshot.failure
    ? parsePreparationFailurePredicates(snapshot.failure.detail ?? null)
    : null;
  const failure = snapshot.failure
    ? {
        causes: resolvePreparationFailureCauses(snapshot.failure.detail ?? null),
        correlationId: snapshot.failure.diagnostics_correlation_id ?? null,
        detail: snapshot.failure.detail ?? null,
        errorCode: snapshot.failure.error_code,
        omittedPredicateCount: failurePredicates?.omittedCount ?? 0,
        predicateAnalysisTruncated: failurePredicates?.analysisTruncated ?? false,
        stageElapsedLabel: failureStage?.elapsedLabel ?? "—",
        stageLabel:
          stageLabels.get(snapshot.failure.stage_id) ?? snapshot.failure.stage_id,
        summary: snapshot.failure.summary,
      }
    : null;
  const kind = isStale
    ? "stale"
    : isFailed
      ? "failed"
      : isReady
        ? "ready"
        : snapshot.status === "connecting"
          ? "connecting"
          : "running";
  const title = isFailed
    ? "Simulation preparation failed"
    : isReady
      ? "Simulation ready"
      : activeStage?.label ?? "Preparing simulation";
  const detail = isFailed
    ? failure?.summary ?? "Simulation preparation failed."
    : isReady
      ? "Solver initialization completed."
      : activeStage?.detail || "Preparing the runtime workspace.";
  const logEntries = snapshot.log_tail
    .slice(-MAX_PREPARATION_LOG_ENTRIES)
    .map((entry) => ({
      level: entry.level,
      message: entry.message,
      stageLabel: stageLabels.get(entry.stage_id) ?? entry.stage_id,
      timestampLabel: formatLogTimestamp(entry.timestamp_unix_ms),
    }));
  const totalElapsedLabel = resolveTotalElapsedLabel(snapshot, nowUnixMs);

  return {
    activeStage,
    detail,
    eyebrow: "Simulation preparation",
    failure,
    isTerminal: isFailed || isReady,
    isVisible: !isReady || isStale,
    kind,
    liveSummary: resolveLiveSummary({
      activeStage,
      failure,
      isStale,
      title,
    }),
    logEntries,
    preparation: snapshot,
    progress,
    progressLabel:
      progress.kind === "terminal" ? null : activeStage?.progressLabel ?? null,
    reconnectingMessage: isStale
      ? "Displayed progress may be out of date."
      : null,
    reconnectingTitle: isStale ? "Reconnecting…" : null,
    requestedExecutionLabel: formatExecutionSummary(snapshot.requested_execution),
    resolvedExecutionLabel: formatExecutionSummary(snapshot.resolved_execution),
    stages,
    title,
    totalElapsedLabel,
  };
}

export function parsePreparationFailurePredicates(
  detail: string | null,
): ParsedPreparationFailurePredicates {
  if (!detail) {
    return { analysisTruncated: false, omittedCount: 0, predicates: [] };
  }

  const boundedDetail = detail.slice(0, MAX_FAILURE_PREDICATE_TEXT_LENGTH);
  const markerIndex = boundedDetail.indexOf(FAILURE_PREDICATE_MARKER);
  if (markerIndex < 0) {
    const possibleMarkerIndex = boundedDetail.lastIndexOf("failed_");
    const hasTruncatedMarker =
      detail.length > MAX_FAILURE_PREDICATE_TEXT_LENGTH &&
      possibleMarkerIndex >=
        boundedDetail.length - FAILURE_PREDICATE_MARKER.length + 1 &&
      possibleMarkerIndex >= 0 &&
      FAILURE_PREDICATE_MARKER.startsWith(
        boundedDetail.slice(possibleMarkerIndex),
      );
    return {
      analysisTruncated: hasTruncatedMarker,
      omittedCount: 0,
      predicates: [],
    };
  }

  const predicateStart = markerIndex + FAILURE_PREDICATE_MARKER.length;
  const predicateEnd = boundedDetail.indexOf("]", predicateStart);
  if (predicateEnd < 0) {
    return {
      analysisTruncated: detail.length > MAX_FAILURE_PREDICATE_TEXT_LENGTH,
      omittedCount: 0,
      predicates: [],
    };
  }

  const allPredicates = boundedDetail
    .slice(predicateStart, predicateEnd)
    .split(",")
    .map((predicate) => predicate.trim())
    .filter(Boolean);
  const predicatesWereShortened = allPredicates.some(
    (predicate) => predicate.length > MAX_FAILURE_PREDICATE_LENGTH,
  );
  const omittedCount = Math.max(
    0,
    allPredicates.length - MAX_FAILURE_PREDICATES,
  );
  const predicates = allPredicates
    .slice(0, MAX_FAILURE_PREDICATES)
    .map((predicate) =>
      predicate.length > MAX_FAILURE_PREDICATE_LENGTH
        ? `${predicate.slice(0, MAX_FAILURE_PREDICATE_LENGTH - 1)}…`
        : predicate,
    );

  return {
    analysisTruncated: predicatesWereShortened || omittedCount > 0,
    omittedCount,
    predicates,
  };
}

export function resolvePreparationFailureCauses(
  detail: string | null,
): readonly SimulationPreparationFailureCauseView[] {
  return parsePreparationFailurePredicates(detail).predicates.map((predicate) => {
    const known = KNOWN_FAILURE_PREDICATES[predicate];
    return known
      ? { ...known, known: true, predicate }
      : {
          action:
            "Review the raw diagnostic detail and the runtime capability report for the required change.",
          known: false,
          label: "Unknown preparation constraint",
          predicate,
        };
  });
}

function resolveMissingPreparationModel(
  preparation: ResourceResult<SimulationPreparationResource>,
  sessionStatus: ResourceResult<LiveStatusResource>,
): SimulationPreparationViewModel {
  const solverState = sessionStatus.data?.solver.state?.toLowerCase() ?? "";
  const isMaterializing = MATERIALIZING_STATUSES.has(solverState);
  const isBootstrapping = BOOTSTRAPPING_STATUSES.has(solverState);
  const preparationRevision =
    sessionStatus.data?.resources.simulation_preparation_revision;
  const hasPublishedPreparationRevision =
    typeof preparationRevision === "number" && preparationRevision > 0;
  const preparationError = resolvePreparationResourceError(
    preparation,
    hasPublishedPreparationRevision,
  );
  if (preparationError) {
    return preparationError;
  }
  const hasNonTransientSessionError =
    sessionStatus.status === "error" &&
    !isTransientStartupError(sessionStatus.error);
  const isConnecting =
    !hasNonTransientSessionError &&
    (sessionStatus.status === "idle" ||
      sessionStatus.status === "loading" ||
      isBootstrapping ||
      isMaterializing ||
      hasPublishedPreparationRevision ||
      ((preparation.status === "idle" || preparation.status === "loading") &&
        sessionStatus.data === null) ||
      (sessionStatus.status === "error" &&
        isTransientStartupError(sessionStatus.error)));
  const title = isMaterializing ? "Compiling simulation" : "Preparing simulation";
  const detail = isMaterializing
    ? "Compiling the model and preparing runtime data."
    : isBootstrapping
      ? "Starting the runtime workspace."
      : sessionStatus.status === "error"
        ? "Waiting for the runtime workspace to become available."
        : "Connecting to the local simulation backend.";

  return {
    activeStage: null,
    detail,
    eyebrow: "Simulation preparation",
    failure: null,
    isTerminal: false,
    isVisible: isConnecting,
    kind: isConnecting ? "connecting" : "hidden",
    liveSummary: `${title}. ${detail}`,
    logEntries: [],
    preparation: null,
    progress: { kind: "indeterminate" },
    progressLabel: null,
    reconnectingMessage: null,
    reconnectingTitle: null,
    requestedExecutionLabel: null,
    resolvedExecutionLabel: null,
    stages: [],
    title,
    totalElapsedLabel: null,
  };
}

function resolvePreparationResourceError(
  preparation: ResourceResult<SimulationPreparationResource>,
  hasPublishedPreparationRevision: boolean,
): SimulationPreparationViewModel | null {
  if (preparation.status !== "error" || !preparation.error) {
    return null;
  }

  const status = errorStatus(preparation.error);
  if (
    isTransientStartupError(preparation.error) ||
    (status === 404 && !hasPublishedPreparationRevision)
  ) {
    return null;
  }

  const message = preparation.error.message.toLowerCase();
  const detail =
    status === 401 || status === 403
      ? "Authorization is required to read simulation preparation status."
      : message.includes("contract version mismatch")
        ? "The Control Room API contract is incompatible. Restart or update the local runtime."
        : "The local runtime could not provide simulation preparation status. Open diagnostics or retry.";

  return {
    activeStage: null,
    detail,
    eyebrow: "Simulation preparation",
    failure: null,
    isTerminal: true,
    isVisible: true,
    kind: "resource-error",
    liveSummary: `Preparation status unavailable. ${detail}`,
    logEntries: [],
    preparation: null,
    progress: { kind: "terminal" },
    progressLabel: null,
    reconnectingMessage: null,
    reconnectingTitle: null,
    requestedExecutionLabel: null,
    resolvedExecutionLabel: null,
    stages: [],
    title: "Preparation status unavailable",
    totalElapsedLabel: null,
  };
}

function errorStatus(error: Error): number | null {
  if (!("status" in error)) return null;
  const status = (error as Error & { status: unknown }).status;
  return typeof status === "number" ? status : null;
}

function resolveStageView(
  stage: PreparationStage,
  nowUnixMs: number | null,
): SimulationPreparationStageView {
  const durationMs = resolveStageDurationMs(stage, nowUnixMs);
  return {
    detail: stage.detail,
    elapsedLabel:
      stage.status === "skipped"
        ? "Skipped"
        : durationMs === null
          ? "—"
          : formatDuration(durationMs),
    id: stage.id,
    isActive: stage.status === "active",
    label: stage.label,
    progressLabel: stage.progress_label ?? null,
    stateLabel: formatStageState(stage.status),
    status: stage.status,
  };
}

function resolveStageDurationMs(
  stage: PreparationStage,
  nowUnixMs: number | null,
): number | null {
  const backendDuration = normalizeDuration(stage.duration_ms);
  if (
    stage.status === "active" &&
    nowUnixMs !== null &&
    typeof stage.started_at_unix_ms === "number"
  ) {
    return Math.max(backendDuration ?? 0, nowUnixMs - stage.started_at_unix_ms);
  }
  if (
    backendDuration === null &&
    typeof stage.started_at_unix_ms === "number" &&
    typeof stage.completed_at_unix_ms === "number"
  ) {
    return Math.max(0, stage.completed_at_unix_ms - stage.started_at_unix_ms);
  }
  return backendDuration;
}

function resolveProgress(
  activeStage: SimulationPreparationStageView | null,
  snapshot: SimulationPreparationResource,
): SimulationPreparationProgressView {
  if (snapshot.status === "failed") {
    return { kind: "terminal" };
  }
  const source = snapshot.stages.find((stage) => stage.id === activeStage?.id);
  const value = source?.progress_percent;
  return typeof value === "number" && value >= 0 && value <= 100
    ? { kind: "determinate", value }
    : { kind: "indeterminate" };
}

function resolveTotalElapsedLabel(
  snapshot: SimulationPreparationResource,
  nowUnixMs: number | null,
): string | null {
  const endpoint = snapshot.completed_at_unix_ms ?? nowUnixMs;
  if (endpoint === null) return null;
  return formatDuration(Math.max(0, endpoint - snapshot.started_at_unix_ms));
}

function resolveLiveSummary({
  activeStage,
  failure,
  isStale,
  title,
}: {
  activeStage: SimulationPreparationStageView | null;
  failure: SimulationPreparationFailureView | null;
  isStale: boolean;
  title: string;
}): string {
  if (isStale) {
    return "Reconnecting. Displayed progress may be out of date.";
  }
  if (failure) {
    return `${title}. ${failure.summary}`;
  }
  return activeStage
    ? `${activeStage.label} ${activeStage.stateLabel.toLowerCase()}.`
    : `${title}.`;
}

function formatExecutionSummary(
  summary: SimulationPreparationResource["resolved_execution"],
): string | null {
  if (!summary) return null;
  const values = [
    summary.backend,
    summary.device,
    summary.precision,
    summary.mode,
    summary.engine_id,
  ].filter((value): value is string => Boolean(value));
  return values.length > 0 ? values.join(" · ") : null;
}

function formatStageState(status: PreparationStage["status"]): string {
  return `${status[0]?.toUpperCase() ?? ""}${status.slice(1)}`;
}

function normalizeDuration(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : null;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.floor((durationMs % 60_000) / 1_000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function formatLogTimestamp(timestampUnixMs: number): string {
  return new Date(timestampUnixMs).toISOString().slice(11, 23);
}

function isTransientStartupError(error: Error | null): boolean {
  const message = error?.message.toLowerCase() ?? "";
  return (
    message.includes("no active local live workspace") ||
    message.includes("no active workspace") ||
    message.includes("failed to fetch") ||
    message.includes("fetch failed") ||
    message.includes("connection refused")
  );
}

export { serializeSimulationPreparationDiagnostics } from "./simulationPreparationDiagnostics";
