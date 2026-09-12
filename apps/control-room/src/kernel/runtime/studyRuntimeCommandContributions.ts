import {
  ANALYSIS_HYSTERESIS_BOOKMARKS_PATH,
  DATA_FIELDS_PATH,
  DATA_FIELD_VECTOR_PATH,
  DATA_SCALARS_PATH,
  DIAGNOSTICS_ENGINE_LOG_PATH,
  DIAGNOSTICS_SOLVER_PROFILE_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MESHING_BUILDS_CURRENT_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_READINESS_PATH,
  MODEL_REGION_DIAGNOSTICS_PATH,
  MODEL_SCENE_PATH,
  MODEL_STUDY_PATH,
  PERSISTENCE_CHECKPOINTS_PATH,
  PERSISTENCE_EXPORTS_PATH,
  PERSISTENCE_FIELD_STATE_EXPORTS_PATH,
  PERSISTENCE_FIELD_STATE_IMPORT_INSPECTIONS_PATH,
  PERSISTENCE_FIELD_STATE_IMPORTS_PATH,
  PERSISTENCE_IMPORTS_PATH,
  SIMULATION_COMMANDS_PATH,
  SIMULATION_OBJECT_METRICS_PATH,
  SIMULATION_RUN_CURRENT_PATH,
  SIMULATION_SOLVER_ENERGIES_CURRENT_PATH,
  SIMULATION_SOLVER_ENERGIES_HISTORY_PATH,
  SIMULATION_SOLVER_STATUS_PATH,
  SIMULATION_STAGE_HYSTERESIS_EXECUTION_TREE_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
  VISUALIZATION_STATE_PATH,
} from "../api/apiPaths";
import type { JsonObject, StructuredCommandRequest } from "../api/apiTypes";
import type {
  CheckpointEntry,
  CheckpointListResource,
  CommandQueueStatusResource,
  LiveStatusResource,
  MeshActiveBuildResource,
  MeshSharedDomainManifestResource,
  ModelReadinessResource,
  CurrentRunResource,
  FieldStateTargetRef,
  HysteresisBookmarkPointRequest,
  HysteresisPointSchema,
  RegionDiagnosticsResource,
  RuntimeCommandPrecondition,
  RuntimeCommandTarget,
  SolverProfileResource,
  SolverStatusResource,
  StageExecutionResource,
} from "../api/apiTypes";
import type { CommandContext } from "../commands/commandTypes";
import type { CommandActiveResource } from "../commands/commandTypes";
import type { CommandContribution } from "../commands/commandTypes";
import {
  meshPipelineStatusIsActive,
  normalizeMeshPipelineStatus,
  resolveMeshBuildStatusLabel,
} from "@/shared/domain/mesh/buildPipeline";
import { DEFAULT_RELAX_TORQUE_APM } from "@/shared/domain/physics/torqueUnits";
import { regionRuntimeBlockerPrefix } from "@/shared/domain/region/regionCapabilityCatalog";
import { createDefaultHysteresisStage } from "@/shared/domain/study/hysteresisDefaults";
import {
  applyControlRoomUiState,
  exportControlRoomUiState,
} from "../persistence/controlRoomUiState";
import { SESSION_STATUS_RESOURCE_KEY } from "../resources/useSessionStatus";
import {
  resolveActiveLaneOperation,
  type ActiveLaneOperationId,
} from "../resources/useActiveLaneCapabilities";

import {
  buildStudyRuntimeCommand,
  type SimpleStudyRuntimeCommandKind,
} from "./studyRuntimeCommandAdapters";

type JsonRecord = Record<string, unknown>;
type SolverProfileCommandRequest = Extract<
  StructuredCommandRequest,
  { kind: "set_solver_profile" }
>;
type RuntimeCommandWithPrecondition = StructuredCommandRequest & {
  precondition?: RuntimeCommandPrecondition | null;
};

const SOLVER_PROFILE_DEFAULT_MAX_SAMPLES = 256;
const SOLVER_PROFILE_DEFAULT_SAMPLE_INTERVAL_WALL_MS = 5_000;

interface RuntimePreconditionRefreshApi {
  commands?: {
    list?: () => Promise<CommandQueueStatusResource>;
  };
  sessions?: {
    current?: {
      status?: () => Promise<LiveStatusResource>;
    };
  };
  simulation?: {
    solver?: {
      status?: () => Promise<SolverStatusResource>;
    };
    stages?: {
      execution?: () => Promise<StageExecutionResource>;
    };
  };
}

const DEFAULT_RELAX_STAGE: JsonObject = {
  algorithm: "llg_overdamped",
  entrypoint_kind: "relax",
  kind: "relax",
  max_steps: "50000",
  torque_tolerance_apm: DEFAULT_RELAX_TORQUE_APM,
};

const DEFAULT_RUN_STAGE: JsonObject = {
  entrypoint_kind: "flat_run",
  kind: "run",
  until_seconds: "1e-9",
};

const DEFAULT_TABLE_AUTOSAVE_STAGE: JsonObject = {
  enabled: true,
  entrypoint_kind: "flat_table_autosave",
  kind: "table_autosave",
  table_autosave: {
    kind: "table_autosave",
    quantities: ["t", "step", "mx", "my", "mz", "e_drive"],
    sample_period_s: 5e-13,
    table_id: "default",
  },
};

const DEFAULT_AUTOSAVE_STAGE: JsonObject = {
  enabled: true,
  entrypoint_kind: "flat_autosave",
  kind: "autosave",
  output: { every_seconds: 2e-12, kind: "field", name: "m" },
  quantity: "m",
};

const DEFAULT_FFT_RESPONSE_STAGE: JsonObject = {
  enabled: true,
  entrypoint_kind: "flat_fft_response",
  kind: "fft_response",
  request: {
    analysis: "gamma",
    detrend: "linear",
    response_component: "my",
    schema_version: "spin_wave_response.request.v1",
    susceptibility_floor_fraction: 1e-6,
    weighting: "Ms_times_lumped_volume",
    window: "hann",
  },
};

const DEFAULT_ADD_FIELD_DRIVE_STAGE: JsonObject = {
  drive: {
    activation: { kind: "all_time_evolution" },
    amplitude_B_T: 1e-3,
    direction: [0, 1, 0],
    enabled: true,
    id: "k0-sinc-antenna",
    kind: "regional",
    name: "Uniform transverse k0 sinc antenna",
    spatial_profile: { kind: "uniform" },
    target: { kind: "global" },
    time_origin: "stage_local",
    waveform: {
      amplitude: 1,
      cutoff_hz: 40e9,
      kind: "sinc_pulse",
      t0: 50e-12,
    },
  },
  entrypoint_kind: "flat_add_field_drive",
  kind: "add_field_drive",
};

const DEFAULT_EIGENMODES_STAGE: JsonObject = {
  bc: "free",
  count: 10,
  damping_policy: "ignore",
  eigen_count: 10,
  eigen_damping_policy: "ignore",
  eigen_equilibrium_source: "relax",
  eigen_include_demag: true,
  eigen_magnetostatic_bc: "open",
  eigen_normalization: "unit_l2",
  eigen_spin_wave_bc: "free",
  eigen_target: "lowest",
  eigen_frequency_min: "",
  eigen_frequency_max: "",
  entrypoint_kind: "flat_eigenmodes",
  equilibrium_source: "relax",
  include_demag: true,
  kind: "eigenmodes",
  magnetostatic_bc: "open",
  normalization: "unit_l2",
  target: "lowest",
  frequency_min: "",
  frequency_max: "",
};

const DEFAULT_FREQUENCY_RESPONSE_STAGE: JsonObject = {
  bc: "free",
  damping_policy: "ignore",
  entrypoint_kind: "flat_frequency_response",
  equilibrium_source: "provided",
  excitation_field_au_per_m: [0, 0, 1],
  excitation_phase_rad: 0,
  frequencies_hz: [1e9],
  frequency_damping_policy: "ignore",
  frequency_equilibrium_source: "provided",
  frequency_excitation_field_au_per_m: [0, 0, 1],
  frequency_excitation_phase_rad: 0,
  frequency_include_demag: true,
  frequency_normalization: "unit_l2",
  frequency_observable: "susceptibility_tensor",
  frequency_solver_method: "auto",
  frequency_spin_wave_bc: "free",
  frequency_values_hz: [1e9],
  include_demag: true,
  kind: "frequency_response",
  normalization: "unit_l2",
  observable: "susceptibility_tensor",
};

const DEFAULT_HYSTERESIS_STAGE: JsonObject = createDefaultHysteresisStage();

const DEFAULT_SAVE_STATE_STAGE: JsonObject = {
  artifact_name: "state_snapshot",
  entrypoint_kind: "flat_save_state",
  kind: "save_state",
};

const ACTIVE_RUNTIME_COMMAND_STATUSES = new Set([
  "accepted",
  "dispatched",
  "pending",
  "queued",
  "running",
]);

function disabledWithoutApi(context: CommandContext): string | null {
  return context.api ? null : "Control-room API is unavailable.";
}

function isApiAvailable(context: CommandContext): boolean {
  return Boolean(context.api);
}

function isStageControlCommandKind(kind: SimpleStudyRuntimeCommandKind): boolean {
  return (
    kind === "pause" ||
    kind === "resume" ||
    kind === "save_vtk" ||
    kind === "skip" ||
    kind === "stop"
  );
}

function runtimeCommandDisabledReason(
  context: CommandContext,
  kind: SimpleStudyRuntimeCommandKind,
): string | null {
  const apiReason = disabledWithoutApi(context);
  if (apiReason) return apiReason;

  const queue = resourceData<CommandQueueStatusResource>(
    context,
    SIMULATION_COMMANDS_PATH,
  );
  const backendControl = backendRuntimeControl(queue, kind);

  const state = runtimeState(context);
  if (!state) return "Runtime state is unavailable.";
  const staleQueue = runtimeCommandQueueIsStale(context, queue, state);
  if (
    kind === "solve" &&
    !staleQueue &&
    queue?.commands.some((command) =>
      ACTIVE_RUNTIME_COMMAND_STATUSES.has(command.status),
    )
  ) {
    return "A runtime command is already active.";
  }
  const stateReason = runtimeCommandStateDisabledReason(context, kind, state);
  if (backendControl && !backendControl.enabled) {
    const backendReason = backendControl.reason ?? "Runtime command is unavailable.";
    if (
      stateReason === null &&
      (backendRuntimeControlReasonIsStateDerived(kind, backendReason) ||
        (staleQueue &&
          backendRuntimeControlReasonIsActiveCommandDerived(backendReason)))
    ) {
      return null;
    }
    return backendReason;
  }

  return stateReason;
}

function runtimeCommandStateDisabledReason(
  context: CommandContext,
  kind: SimpleStudyRuntimeCommandKind,
  state: string,
): string | null {
  switch (kind) {
    case "pause":
      return state === "running" ? null : "Runtime is not running.";
    case "resume":
      return state === "paused" ? null : "Runtime is not paused.";
    case "save_vtk":
      return state === "running" || state === "paused"
        ? "Runtime is already active."
        : null;
    case "stop":
      return state === "running" || state === "paused"
        ? null
        : "Runtime is not active.";
    case "skip": {
      const stage = resourceData<StageExecutionResource>(
        context,
        SIMULATION_STAGES_EXECUTION_PATH,
      );
      if (stage?.active_stage_index == null) {
        return "No active stage is available to skip.";
      }
      return state === "running" || state === "paused"
        ? null
        : "Runtime is not in an active stage.";
    }
    case "compute_energies":
    case "compute_fields":
    case "solve":
      if (state === "running" || state === "paused") {
        return "Runtime is already active.";
      }
      return runtimeReadinessDisabledReason(context, kind);
  }
}

function backendRuntimeControlReasonIsStateDerived(
  kind: SimpleStudyRuntimeCommandKind,
  reason: string,
): boolean {
  switch (kind) {
    case "pause":
      return reason === "Runtime is not running.";
    case "resume":
      return reason === "Runtime is not paused.";
    case "stop":
      return reason === "Runtime is not active.";
    case "skip":
      return (
        reason === "No active stage is available to skip." ||
        reason === "Runtime is not in an active stage."
      );
    case "compute_energies":
    case "compute_fields":
    case "solve":
      return false;
    case "save_vtk":
      return reason === "Runtime is already active.";
  }
}

function backendRuntimeControlReasonIsActiveCommandDerived(reason: string): boolean {
  return reason === "A runtime command is already active.";
}

function runtimeCommandQueueIsStale(
  context: CommandContext,
  queue: CommandQueueStatusResource | null | undefined,
  state: string,
): boolean {
  if (state === "running" || state === "paused") return false;
  if (state === "idle" && !queueHasActiveCommandDerivedControl(queue)) {
    return false;
  }
  const queueRevision = numericRevision(queue?.revision);
  const lifecycleRevision = runtimeLifecycleRevision(context);
  return (
    queueRevision !== null &&
    lifecycleRevision !== null &&
    queueRevision < lifecycleRevision
  );
}

function queueHasActiveCommandDerivedControl(
  queue: CommandQueueStatusResource | null | undefined,
): boolean {
  return Boolean(
    queue?.runtime_controls?.some(
      (entry) =>
        entry.enabled === false &&
        typeof entry.reason === "string" &&
        backendRuntimeControlReasonIsActiveCommandDerived(entry.reason),
    ),
  );
}

function numericRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function runtimeLifecycleRevision(context: CommandContext): number | null {
  const solver = resourceData<SolverStatusResource>(
    context,
    SIMULATION_SOLVER_STATUS_PATH,
  );
  const stage = resourceData<StageExecutionResource>(
    context,
    SIMULATION_STAGES_EXECUTION_PATH,
  );
  const solverRevision = numericRevision(solver?.revision);
  const stageRevision = numericRevision(stage?.revision);
  if (solverRevision === null) return stageRevision;
  if (stageRevision === null) return solverRevision;
  return Math.max(solverRevision, stageRevision);
}

function backendRuntimeControl(
  queue: CommandQueueStatusResource | null | undefined,
  kind: SimpleStudyRuntimeCommandKind,
): CommandQueueStatusResource["runtime_controls"][number] | null {
  return queue?.runtime_controls?.find((entry) => entry.kind === kind) ?? null;
}

function runtimeReadinessDisabledReason(
  context: CommandContext,
  kind: Extract<
    SimpleStudyRuntimeCommandKind,
    "compute_energies" | "compute_fields" | "solve"
  >,
): string | null {
  const status = resourceData<LiveStatusResource>(
    context,
    SESSION_STATUS_RESOURCE_KEY,
  );
  if (!status) return "Session status is unavailable.";

  if (kind === "solve") {
    const readiness = resourceData<ModelReadinessResource>(
      context,
      MODEL_READINESS_PATH,
    );
    if (!readiness) return "Model readiness is unavailable.";
    const sceneRevision = status.resources.scene_revision;
    if (sceneRevision == null) return "No scene model is loaded.";
    if (readiness.scene_revision !== sceneRevision) {
      return "Model readiness is stale for the current scene.";
    }
    return readiness.ready_to_run
      ? null
      : readiness.blockers[0] ??
          "Complete the model checklist before running.";
  }

  if (kind === "compute_fields" && !status.capabilities.binary_fields) {
    return "Field data plane is unavailable.";
  }

  const sceneRevision = status.resources.scene_revision;
  if (sceneRevision == null) return "No scene model is loaded.";

  if (hasRuntimeGeometryBlocker(context)) {
    return "Resolve geometry validation blockers before running runtime commands.";
  }

  const regionBlocker = regionOwnedRuntimeBlockerReason(context);
  if (regionBlocker) return regionBlocker;

  if (isMeshBuildRunning(context)) {
    return "A mesh build is still running.";
  }

  if (!requiresExplicitMesh(status)) return null;

  if (status.resources.mesh_revision <= 0) {
    return "Build a current shared-domain mesh before running. Open Mesh Jobs or Build Shared-Domain Mesh.";
  }

  const manifest = resourceData<MeshSharedDomainManifestResource>(
    context,
    MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  );
  if (!manifest) return "Shared-domain mesh manifest is unavailable.";
  if (manifest.source_scene_revision == null) {
    return sharedDomainMeshReadyWithoutSceneProvenance(context)
      ? null
      : "Build a current shared-domain mesh before running. Open Mesh Jobs or Build Shared-Domain Mesh.";
  }
  if (manifest.source_scene_revision !== sceneRevision) {
    return "Build a current shared-domain mesh before running. Open Mesh Jobs or Build Shared-Domain Mesh.";
  }

  return null;
}

function regionOwnedRuntimeBlockerReason(context: CommandContext): string | null {
  const resource = resourceData<RegionDiagnosticsResource>(
    context,
    MODEL_REGION_DIAGNOSTICS_PATH,
  );
  const diagnostic = resource?.diagnostics.find((entry) => {
    const gate = entry.capability_gate ?? "";
    const severity = entry.severity.toLowerCase();
    return (
      gate.startsWith("regions.") &&
      (severity === "warning" || severity === "error" || severity === "fatal")
    );
  });
  if (!diagnostic) return null;
  return `${regionRuntimeBlockerPrefix(diagnostic.capability_gate)}: ${diagnostic.message}`;
}

function isMeshBuildRunning(context: CommandContext): boolean {
  const activeBuild = resourceData<MeshActiveBuildResource>(
    context,
    MESHING_BUILDS_CURRENT_PATH,
  );
  const activeBuildRecord = asRecord(activeBuild);
  const buildStatus =
    asString(activeBuildRecord?.status) ??
    resolveMeshBuildStatusLabel(
      asRecord(activeBuildRecord?.active_build),
      activeMeshBuildPhases(activeBuildRecord?.mesh_pipeline_status),
    );
  return meshPipelineStatusIsActive(buildStatus);
}

function activeMeshBuildPhases(value: unknown) {
  return normalizeMeshPipelineStatus(value).filter(
    (phase) => phase.id.toLowerCase() !== "ready",
  );
}

function sharedDomainMeshReadyWithoutSceneProvenance(
  context: CommandContext,
): boolean {
  const activeBuild = resourceData<MeshActiveBuildResource>(
    context,
    MESHING_BUILDS_CURRENT_PATH,
  );
  const activeBuildRecord = asRecord(activeBuild);
  const status = asString(activeBuildRecord?.status)?.toLowerCase();
  if (status && meshReadyStatus(status)) return true;

  return normalizeMeshPipelineStatus(
    activeBuildRecord?.mesh_pipeline_status,
  ).some(
    (phase) =>
      meshReadinessPhaseId(phase.id) &&
      meshReadyStatus(phase.status.toLowerCase()),
  );
}

function meshReadinessPhaseId(id: string): boolean {
  const normalized = id.toLowerCase();
  return normalized === "ready" || normalized === "readiness";
}

function meshReadyStatus(status: string): boolean {
  return (
    status === "active" ||
    status === "available" ||
    status === "completed" ||
    status === "done" ||
    status === "ready" ||
    status === "success" ||
    status === "succeeded"
  );
}

function requiresExplicitMesh(status: LiveStatusResource): boolean {
  return (
    status.capabilities.explicit_topology ||
    status.domain.discretization.toLowerCase() === "fem"
  );
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function recordHasMessage(record: JsonRecord): boolean {
  return Boolean(
    asString(record.message) ??
      asString(record.error) ??
      asString(record.reason) ??
      asString(record.detail),
  );
}

function recordBlocksRuntime(record: JsonRecord): boolean {
  const blocks = Array.isArray(record.blocks) ? record.blocks : [];
  return blocks.some((block) =>
    [
      "compute",
      "compute_energies",
      "compute_fields",
      "run",
      "runtime",
      "solve",
      "solver",
      "solver_run",
    ].includes(String(block).toLowerCase()),
  );
}

function hasRuntimeGeometryBlocker(context: CommandContext): boolean {
  const validation = resourceData<unknown>(
    context,
    MODEL_GEOMETRY_VALIDATION_PATH,
  );

  const visit = (value: unknown, keyHint = ""): boolean => {
    if (Array.isArray(value)) return value.some((entry) => visit(entry, keyHint));
    const record = asRecord(value);
    if (!record) return false;

    const severity = asString(record.severity)?.toLowerCase();
    const status = asString(record.status)?.toLowerCase();
    const key = keyHint.toLowerCase();
    if (record.dirty === true) return true;
    const blocking =
      record.blocking === true ||
      recordBlocksRuntime(record) ||
      key.includes("runtime") ||
      key.includes("solver") ||
      severity === "error" ||
      severity === "fatal" ||
      status === "blocked" ||
      status === "invalid";
    if (blocking && recordHasMessage(record)) return true;

    return Object.entries(record).some(([childKey, child]) =>
      visit(child, childKey),
    );
  };

  return visit(validation);
}

function saveCheckpointDisabledReason(context: CommandContext): string | null {
  const apiReason = disabledWithoutApi(context);
  if (apiReason) return apiReason;

  const state = runtimeState(context);
  if (state === "running" || state === "paused") return null;

  const stage = resourceData<StageExecutionResource>(
    context,
    SIMULATION_STAGES_EXECUTION_PATH,
  );
  if (stage?.active_stage_index != null) return null;

  const currentRun = resourceData<CurrentRunResource>(
    context,
    SIMULATION_RUN_CURRENT_PATH,
  );
  if (currentRun && currentRun.total_steps > 0) return null;

  return "No runtime magnetization state is available to checkpoint.";
}

function restoreCheckpointDisabledReason(context: CommandContext): string | null {
  const apiReason = disabledWithoutApi(context);
  if (apiReason) return apiReason;

  const checkpoint = resolveCheckpointForRestore(context);
  if (!checkpoint) return "No checkpoint is selected.";
  if (checkpoint.resume_class === "config_only") {
    return "Selected checkpoint does not contain magnetization state.";
  }
  return null;
}

function exportStateDisabledReason(context: CommandContext): string | null {
  return disabledWithoutApi(context);
}

function discardPausedStateDisabledReason(context: CommandContext): string | null {
  const apiReason = disabledWithoutApi(context);
  if (apiReason) return apiReason;

  return runtimeState(context) === "paused"
    ? null
    : "Runtime is not paused.";
}

function resourceData<T>(context: CommandContext, key: string): T | null {
  return (context.resourceData?.[key] as T | null | undefined) ?? null;
}

function solverProfileDisabledReason(context: CommandContext): string | null {
  const apiReason = disabledWithoutApi(context);
  if (apiReason) return apiReason;

  const status = resourceData<LiveStatusResource>(
    context,
    SESSION_STATUS_RESOURCE_KEY,
  );
  return status ? null : "Session status is unavailable.";
}

function solverProfileResource(context: CommandContext): SolverProfileResource | null {
  return resourceData<SolverProfileResource>(
    context,
    DIAGNOSTICS_SOLVER_PROFILE_PATH,
  );
}

function solverProfileEnabled(context: CommandContext): boolean {
  const profile = solverProfileResource(context);
  return (
    profile?.config.enabled === true ||
    profile?.state === "active" ||
    profile?.state === "enabled"
  );
}

function isRuntimeCommandActive(
  context: CommandContext,
  kind: SimpleStudyRuntimeCommandKind,
  reason?: string,
): boolean {
  return Boolean(activeRuntimeCommandResource(context, kind, reason));
}

function activeRuntimeCommandResource(
  context: CommandContext,
  kind: SimpleStudyRuntimeCommandKind,
  reason?: string,
): CommandActiveResource | null {
  const queue = resourceData<CommandQueueStatusResource>(
    context,
    SIMULATION_COMMANDS_PATH,
  );
  const state = runtimeState(context);
  if (state && runtimeCommandQueueIsStale(context, queue, state)) {
    return null;
  }
  const command = queue?.commands.find(
    (entry) =>
      entry.kind === kind &&
      ACTIVE_RUNTIME_COMMAND_STATUSES.has(entry.status) &&
      (reason === undefined || entry.reason === reason),
  );
  return command?.command_id
    ? {
        commandId: command.command_id,
        kind: "command",
        label: `${command.kind} ${command.status}`,
      }
    : null;
}

function resolveCheckpointIdInput(input: unknown): string | null {
  if (typeof input === "string" && input.length > 0) return input;
  if (input && typeof input === "object" && "checkpointId" in input) {
    const checkpointId = (input as { checkpointId?: unknown }).checkpointId;
    return typeof checkpointId === "string" && checkpointId.length > 0
      ? checkpointId
      : null;
  }
  return null;
}

function resolveCheckpointForRestore(context: CommandContext): CheckpointEntry | null {
  const checkpointId = resolveCheckpointIdInput(context.input);
  const catalog = resourceData<CheckpointListResource>(
    context,
    PERSISTENCE_CHECKPOINTS_PATH,
  );
  if (checkpointId) {
    return (
      catalog?.checkpoints.find(
        (checkpoint) => checkpoint.checkpoint_id === checkpointId,
      ) ?? ({ checkpoint_id: checkpointId, resume_class: "logical_resume" } as CheckpointEntry)
    );
  }
  return catalog?.checkpoints[0] ?? null;
}

function runtimeState(context: CommandContext): string | null {
  const solver = resourceData<SolverStatusResource>(
    context,
    SIMULATION_SOLVER_STATUS_PATH,
  );
  if (solver?.runtime_state) return solver.runtime_state;

  const stage = resourceData<StageExecutionResource>(
    context,
    SIMULATION_STAGES_EXECUTION_PATH,
  );
  return stage?.runtime_state ?? null;
}

function commandRevisionPrecondition(
  context: CommandContext,
): number | undefined {
  const queue = resourceData<CommandQueueStatusResource>(
    context,
    SIMULATION_COMMANDS_PATH,
  );
  return queue ? queue.commands.length : undefined;
}

function regionRevisionPrecondition(
  context: CommandContext,
): Pick<
  RuntimeCommandPrecondition,
  | "region_coefficients_revision"
  | "region_initial_state_revision"
  | "region_membership_revision"
  | "region_topology_revision"
> {
  const status = resourceData<LiveStatusResource>(
    context,
    SESSION_STATUS_RESOURCE_KEY,
  );
  if (!status) return {};

  const resources = status.resources;
  const precondition: Pick<
    RuntimeCommandPrecondition,
    | "region_coefficients_revision"
    | "region_initial_state_revision"
    | "region_membership_revision"
    | "region_topology_revision"
  > = {};
  if (typeof resources.region_coefficients_revision === "number") {
    precondition.region_coefficients_revision =
      resources.region_coefficients_revision;
  }
  if (typeof resources.region_initial_state_revision === "number") {
    precondition.region_initial_state_revision =
      resources.region_initial_state_revision;
  }
  if (typeof resources.region_membership_revision === "number") {
    precondition.region_membership_revision = resources.region_membership_revision;
  }
  if (typeof resources.region_topology_revision === "number") {
    precondition.region_topology_revision = resources.region_topology_revision;
  }
  return precondition;
}

function activeStageTarget(
  context: CommandContext,
): RuntimeCommandTarget {
  const stage = resourceData<StageExecutionResource>(
    context,
    SIMULATION_STAGES_EXECUTION_PATH,
  );
  const activeIndex = stage?.active_stage_index;
  const activeStage =
    activeIndex == null ? null : stage?.stages?.[activeIndex] ?? null;
  if (activeStage?.stage_id) {
    return { kind: "stage_id", stage_id: activeStage.stage_id };
  }
  if (activeIndex != null) {
    return { kind: "stage_index", stage_index: activeIndex };
  }
  return { kind: "current_stage" };
}

function runtimeCommandPrecondition(
  context: CommandContext,
  kind: SimpleStudyRuntimeCommandKind,
  overrides: RuntimeCommandPrecondition = {},
): RuntimeCommandPrecondition | undefined {
  const stage = resourceData<StageExecutionResource>(
    context,
    SIMULATION_STAGES_EXECUTION_PATH,
  );
  const state = runtimeState(context);
  const commandRevision = commandRevisionPrecondition(context);
  const precondition: RuntimeCommandPrecondition = {
    ...regionRevisionPrecondition(context),
    ...(state ? { runtime_state: state } : {}),
    ...(stage && isStageControlCommandKind(kind)
      ? { stage_execution_revision: stage.revision }
      : {}),
    ...(commandRevision === undefined
      ? {}
      : { command_revision: commandRevision }),
    ...overrides,
  };

  return Object.keys(precondition).length > 0 ? precondition : undefined;
}

function buildRuntimeCommandFromContext(
  context: CommandContext,
  kind: SimpleStudyRuntimeCommandKind,
  options: {
    precondition?: RuntimeCommandPrecondition;
    reason?: string;
    target?: RuntimeCommandTarget;
  } = {},
): StructuredCommandRequest {
  return buildStudyRuntimeCommand(kind, {
    precondition: runtimeCommandPrecondition(context, kind, options.precondition),
    reason: options.reason,
    target:
      options.target ??
      (kind === "pause" ||
      kind === "resume" ||
      kind === "save_vtk" ||
      kind === "skip" ||
      kind === "stop"
        ? activeStageTarget(context)
        : undefined),
  });
}

function buildSolverProfileCommand(
  context: CommandContext,
): SolverProfileCommandRequest {
  const requestedEnabled =
    typeof context.input === "boolean"
      ? context.input
      : !solverProfileEnabled(context);
  const current = solverProfileResource(context);
  const maxSamples = requestedEnabled
    ? Math.min(
        Math.max(current?.config.max_samples ?? SOLVER_PROFILE_DEFAULT_MAX_SAMPLES, 1),
        SOLVER_PROFILE_DEFAULT_MAX_SAMPLES,
      )
    : current?.config.max_samples ?? SOLVER_PROFILE_DEFAULT_MAX_SAMPLES;
  const sampleEvery = current?.config.sample_every ?? 1;
  const sampleIntervalWallMs = requestedEnabled
    ? Math.max(
        current?.config.sample_interval_wall_ms ??
          SOLVER_PROFILE_DEFAULT_SAMPLE_INTERVAL_WALL_MS,
        SOLVER_PROFILE_DEFAULT_SAMPLE_INTERVAL_WALL_MS,
      )
    : current?.config.sample_interval_wall_ms ?? 0;
  const reason = requestedEnabled
    ? "enable_solver_profile"
    : "disable_solver_profile";

  return {
    client_intent_id: createSolverProfileClientIntentId(reason),
    kind: "set_solver_profile",
    profile: {
      emit_engine_log: false,
      enabled: requestedEnabled,
      max_samples: maxSamples,
      persist_artifact: requestedEnabled,
      sample_every: sampleEvery,
      sample_interval_wall_ms: sampleIntervalWallMs,
    },
    reason,
    requested_at_unix_ms: Date.now(),
    target: { kind: "study" },
  };
}

function createSolverProfileClientIntentId(reason: string): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `diagnostics:solver-profiler:${reason}:${Date.now()}:${random}`;
}

function commandRevision(response: { command_id?: string | null }, fallback: string): string {
  return response.command_id ?? `${fallback}:${Date.now()}`;
}

function invalidateRuntimeControlResources(
  context: CommandContext,
  revision: string | number,
): void {
  context.resources?.invalidate(SIMULATION_COMMANDS_PATH, revision);
  context.resources?.invalidate(SIMULATION_STAGES_EXECUTION_PATH, revision);
  context.resources?.invalidate(SIMULATION_SOLVER_STATUS_PATH, revision);
}

function invalidateSolverProfileResources(
  context: CommandContext,
  revision: string | number,
): void {
  context.resources?.invalidate(SIMULATION_COMMANDS_PATH, revision);
  context.resources?.invalidate(SESSION_STATUS_RESOURCE_KEY, revision);
  context.resources?.invalidate(DIAGNOSTICS_SOLVER_PROFILE_PATH, revision);
  context.resources?.invalidate(DIAGNOSTICS_ENGINE_LOG_PATH, revision);
}

function invalidateCheckpointResources(
  context: CommandContext,
  revision: string | number,
): void {
  context.resources?.invalidate(PERSISTENCE_CHECKPOINTS_PATH, revision);
  context.resources?.invalidate(SESSION_STATUS_RESOURCE_KEY, revision);
}

function invalidateRestoredStateResources(
  context: CommandContext,
  revision: string | number,
): void {
  invalidateCheckpointResources(context, revision);
  context.resources?.invalidate(DATA_FIELDS_PATH, revision);
  context.resources?.invalidatePrefix(DATA_FIELDS_PATH, revision);
  context.resources?.invalidate(DATA_SCALARS_PATH, revision);
  context.resources?.invalidatePrefix(DATA_SCALARS_PATH, revision);
  context.resources?.invalidate(SIMULATION_SOLVER_ENERGIES_CURRENT_PATH, revision);
  context.resources?.invalidate(SIMULATION_SOLVER_ENERGIES_HISTORY_PATH, revision);
  context.resources?.invalidatePrefix(
    SIMULATION_OBJECT_METRICS_PATH.split("{object_id}")[0],
    revision,
  );
  context.resources?.invalidate(VISUALIZATION_STATE_PATH, revision);
}

function hysteresisSnapshotArtifactRefFromLegacyResource(
  snapshotResourceRef: string | null | undefined,
): string | null {
  const trimmed = snapshotResourceRef?.trim();
  const fieldVectorPrefix = DATA_FIELD_VECTOR_PATH.split("{quantity_id}")[0];
  if (
    !trimmed ||
    trimmed.startsWith(fieldVectorPrefix) ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://")
  ) {
    return null;
  }
  return trimmed;
}

function invalidateHysteresisReturnToLiveResources(context: CommandContext): void {
  context.resources?.invalidatePrefix(
    DATA_FIELD_VECTOR_PATH.split("{quantity_id}")[0],
    `hysteresis-return-to-live:${Date.now()}`,
  );
}

function invalidateImportedSessionResources(
  context: CommandContext,
  revision: string | number,
): void {
  invalidateRestoredStateResources(context, revision);
  context.resources?.invalidate(PERSISTENCE_IMPORTS_PATH, revision);
  context.resources?.invalidate(MODEL_SCENE_PATH, revision);
  context.resources?.invalidate(MODEL_READINESS_PATH, revision);
  context.resources?.invalidate(MODEL_STUDY_PATH, revision);
  context.resources?.invalidate(SIMULATION_RUN_CURRENT_PATH, revision);
  context.resources?.invalidate(SIMULATION_STAGES_EXECUTION_PATH, revision);
  context.resources?.invalidate(SIMULATION_SOLVER_STATUS_PATH, revision);
}

function maybeDownloadFmsExport(filename: string, fmsBase64: string): void {
  if (
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof Blob === "undefined" ||
    typeof atob === "undefined"
  ) {
    return;
  }

  const binary = atob(fmsBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const url = URL.createObjectURL(
    new Blob([bytes], { type: "application/octet-stream" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function maybeDownloadBinaryExport(
  filename: string,
  data: BlobPart,
  contentType = "application/octet-stream",
): void {
  if (
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof Blob === "undefined"
  ) {
    return;
  }

  const url = URL.createObjectURL(new Blob([data], { type: contentType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function artifactFileName(artifactRef: string): string {
  return artifactRef.split("/").filter(Boolean).pop() ?? "field-state.h5";
}

function resolveHysteresisPointCommandInput(
  input: unknown,
): HysteresisPointCommandInput | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const candidate = input as Partial<HysteresisPointCommandInput>;
  if (!candidate.stageId || !candidate.point) return null;
  return {
    point: candidate.point,
    stageId: candidate.stageId,
  };
}

function resolveHysteresisLoopCommandInput(
  input: unknown,
): HysteresisLoopCommandInput | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const candidate = input as Partial<HysteresisLoopCommandInput>;
  if (!candidate.stageId || !Array.isArray(candidate.points)) return null;
  return {
    points: candidate.points,
    stageId: candidate.stageId,
  };
}

function hysteresisPointSelectionPayload(input: HysteresisPointCommandInput) {
  return {
    kind: "analysis.chart-point" as const,
    label: `Point ${input.point.point_id} (${input.point.field_value_mT} mT)`,
    nodeId: `analysis:hysteresis:${input.stageId}:point:${input.point.point_id}`,
    objectId: null,
    ref: {
      type: "analysis-chart-point" as const,
      kind: "analysis.chart-point" as const,
      nodeId: `analysis:hysteresis:${input.stageId}:point:${input.point.point_id}`,
      chartId: `hysteresis:${input.stageId}`,
      tableId: `hysteresis:${input.stageId}`,
      seriesId: `hysteresis:${input.stageId}:m`,
      quantity: "m",
      rowIndex: input.point.point_id,
      stageId: input.stageId,
      pointId: input.point.point_id,
      x: input.point.field_value_mT,
      y: input.point.m_parallel,
      snapshotId: input.point.snapshot_id ?? null,
      targetId: `hysteresis-step:${input.stageId}:${input.point.point_id}`,
      targetKind: "hysteresis-step" as const,
      quantityId: "m",
    },
  };
}

function hysteresisPointCsv(input: HysteresisPointCommandInput): string {
  const point = input.point;
  const mAvg = point.m_avg ?? [];
  const rows: Array<[string, string | number | null | undefined]> = [
    ["stage_id", input.stageId],
    ["point_id", point.point_id],
    ["field_value_mT", point.field_value_mT],
    ["protocol_role", point.protocol_role],
    ["branch_id", point.branch_id],
    ["branch_index", point.branch_index],
    ["minor_loop_id", point.minor_loop_id],
    ["m_parallel", point.m_parallel],
    ["m_oop", point.m_oop],
    ["m_ip", point.m_ip],
    ["m_x", mAvg[0]],
    ["m_y", mAvg[1]],
    ["m_z", mAvg[2]],
    ["status", point.status],
    ["settle_status", point.settle_status],
    ["snapshot_id", point.snapshot_id],
    ["snapshot_storage_status", point.snapshot_storage_status],
    ["snapshot_resource_ref", point.snapshot_resource_ref],
  ];
  return [
    "key,value",
    ...rows.map(([key, value]) => `${csvCell(key)},${csvCell(value ?? "")}`),
  ].join("\n");
}

function hysteresisLoopCsv(input: HysteresisLoopCommandInput): string {
  const header = [
    "stage_id",
    "point_id",
    "field_value_mT",
    "protocol_role",
    "branch_id",
    "branch_index",
    "minor_loop_id",
    "m_parallel",
    "m_oop",
    "m_ip",
    "m_x",
    "m_y",
    "m_z",
    "status",
    "settle_status",
    "snapshot_id",
    "snapshot_storage_status",
    "snapshot_resource_ref",
  ];
  const rows = input.points.map((point) => {
    const mAvg = point.m_avg ?? [];
    return [
      input.stageId,
      point.point_id,
      point.field_value_mT,
      point.protocol_role,
      point.branch_id,
      point.branch_index,
      point.minor_loop_id,
      point.m_parallel,
      point.m_oop,
      point.m_ip,
      mAvg[0],
      mAvg[1],
      mAvg[2],
      point.status,
      point.settle_status,
      point.snapshot_id,
      point.snapshot_storage_status,
      point.snapshot_resource_ref,
    ];
  });
  return [
    header.map(csvCell).join(","),
    ...rows.map((row) =>
      row.map((value) => csvCell(value ?? "")).join(","),
    ),
  ].join("\n");
}

function csvCell(value: string | number): string {
  const text = String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function hysteresisBookmarkPointRequest(
  input: HysteresisPointCommandInput,
): HysteresisBookmarkPointRequest {
  return {
    point_id: input.point.point_id,
  };
}

function invalidateHysteresisBookmarkResources(
  context: CommandContext,
  stageId: string,
  revision: number,
): void {
  const encodedStageId = encodeURIComponent(stageId);
  context.resources?.invalidate(
    ANALYSIS_HYSTERESIS_BOOKMARKS_PATH.replace("{stage_id}", encodedStageId),
    revision,
  );
  context.resources?.invalidatePrefix(
    SIMULATION_STAGE_HYSTERESIS_EXECUTION_TREE_PATH.replace(
      "{stage_id}",
      encodedStageId,
    ),
    revision,
  );
}

interface ImportStateInput {
  fmsBase64?: string;
  fms_base64?: string;
  restoreMode?: "resume" | "visualization_only" | "replace_project";
  restore_mode?: "resume" | "visualization_only" | "replace_project";
}

interface FieldStateInput {
  artifactRef?: string;
  artifact_ref?: string;
  contentBase64?: string;
  content_base64?: string;
  fileName?: string;
  file_name?: string;
  format?: string;
  target?: FieldStateTargetRef;
}

interface HysteresisPointCommandInput {
  point: HysteresisPointSchema;
  stageId: string;
}

interface HysteresisLoopCommandInput {
  points: HysteresisPointSchema[];
  stageId: string;
}

function resolveFieldStateInput(input: unknown): FieldStateInput | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  return input as FieldStateInput;
}

function resolveFieldStateTarget(context: CommandContext): FieldStateTargetRef | null {
  const input = resolveFieldStateInput(context.input);
  if (input?.target?.kind && input.target.id) return input.target;

  const selection = context.selection?.get();
  if (selection?.ref?.type === "scene-object") {
    return { kind: "object", id: selection.ref.objectId };
  }
  if (selection?.ref?.type === "airbox") {
    return { kind: "airbox", id: "airbox" };
  }
  if (selection?.objectId) {
    return { kind: "object", id: selection.objectId };
  }
  return null;
}

function fieldStateSaveDisabledReason(context: CommandContext): string | null {
  const apiReason = disabledWithoutApi(context);
  if (apiReason) return apiReason;

  const target = resolveFieldStateTarget(context);
  if (!target) return "Select an object before saving a field state.";
  if (target.kind !== "object") {
    return "Field-state save currently supports selected object magnetization.";
  }
  return null;
}

function fieldStateLoadDisabledReason(context: CommandContext): string | null {
  const apiReason = disabledWithoutApi(context);
  if (apiReason) return apiReason;

  const target = resolveFieldStateTarget(context);
  if (!target) return "Select an object or airbox before loading a field state.";
  if (target.kind !== "object" && target.kind !== "airbox") {
    return "Field-state load supports selected objects and the airbox.";
  }
  return null;
}

function fieldStateQuantityId(target: FieldStateTargetRef): string {
  return target.kind === "airbox" ? "H_eff" : "m";
}

function fieldStateImportMode(target: FieldStateTargetRef): "apply" | "attach" {
  return target.kind === "airbox" ? "attach" : "apply";
}

async function resolveObjectFieldStateTarget(
  context: CommandContext,
): Promise<FieldStateTargetRef | null> {
  const selectedTarget = resolveFieldStateTarget(context);
  if (selectedTarget?.kind === "object") return selectedTarget;

  const scene = await context.api?.model.scene();
  const objects = sceneObjects(scene);
  if (objects.length !== 1) return null;
  return { kind: "object", id: objects[0] };
}

function sceneObjects(scene: unknown): string[] {
  const objects = record(scene).objects;
  if (!Array.isArray(objects)) return [];
  return objects.flatMap((entry) => {
    const objectId = asString(record(entry).id);
    return objectId ? [objectId] : [];
  });
}

function pickFieldStateFileBase64(): Promise<{
  contentBase64: string;
  fileName: string;
} | null> {
  if (
    typeof document === "undefined" ||
    typeof FileReader === "undefined"
  ) {
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.accept = ".h5,.hdf5,.zarr.zip,.field-state.json,application/json";
    input.type = "file";
    input.onchange = () => {
      const file = input.files?.[0] ?? null;
      if (!file) {
        resolve(null);
        return;
      }

      const reader = new FileReader();
      reader.onerror = () =>
        reject(reader.error ?? new Error("Failed to read field-state file."));
      reader.onload = () => {
        const value = typeof reader.result === "string" ? reader.result : "";
        resolve({
          contentBase64: value.includes(",") ? value.split(",").pop() ?? "" : value,
          fileName: file.name,
        });
      };
      reader.readAsDataURL(file);
    };
    input.click();
  });
}

function resolveImportStateInput(input: unknown): ImportStateInput | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const candidate = input as ImportStateInput;
  const fmsBase64 = candidate.fmsBase64 ?? candidate.fms_base64;
  if (typeof fmsBase64 !== "string" || fmsBase64.length === 0) return null;

  return {
    fmsBase64,
    restoreMode: candidate.restoreMode ?? candidate.restore_mode,
  };
}

function pickFmsFileBase64(): Promise<string | null> {
  if (
    typeof document === "undefined" ||
    typeof FileReader === "undefined"
  ) {
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.accept = ".fms,application/octet-stream";
    input.type = "file";
    input.onchange = () => {
      const file = input.files?.[0] ?? null;
      if (!file) {
        resolve(null);
        return;
      }

      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error("Failed to read .fms file."));
      reader.onload = () => {
        const value = typeof reader.result === "string" ? reader.result : "";
        resolve(value.includes(",") ? value.split(",").pop() ?? "" : value);
      };
      reader.readAsDataURL(file);
    };
    input.click();
  });
}

async function submitRuntimeCommand(
  context: CommandContext,
  command: StructuredCommandRequest,
  successMessage: string,
): Promise<{ message: string; status: "completed" | "failed" }> {
  if (!context.api) {
    return { message: "Control-room API is unavailable.", status: "failed" };
  }

  const refreshedCommand = await refreshRuntimeCommandPrecondition(
    context,
    command,
  );
  const response = await context.api.commands.submit(refreshedCommand);
  if (!response.accepted) {
    return {
      message: response.error ?? `${successMessage} rejected.`,
      status: "failed",
    };
  }

  invalidateRuntimeControlResources(
    context,
    commandRevision(response, `study:${refreshedCommand.kind}`),
  );

  return { message: successMessage, status: "completed" };
}

async function refreshRuntimeCommandPrecondition(
  context: CommandContext,
  command: StructuredCommandRequest,
): Promise<StructuredCommandRequest> {
  const commandWithPrecondition = command as RuntimeCommandWithPrecondition;
  const original = commandWithPrecondition.precondition;
  if (!original || !context.api) return command;

  const api = context.api as RuntimePreconditionRefreshApi;
  const [solverResult, stageResult, queueResult, sessionStatusResult] =
    await Promise.allSettled([
    api.simulation?.solver?.status?.(),
    api.simulation?.stages?.execution?.(),
    api.commands?.list?.(),
    original.region_topology_revision === undefined &&
    original.region_membership_revision === undefined &&
    original.region_coefficients_revision === undefined &&
    original.region_initial_state_revision === undefined
      ? undefined
      : api.sessions?.current?.status?.(),
  ]);
  const precondition: RuntimeCommandPrecondition = { ...original };

  if (solverResult.status === "fulfilled") {
    const state = solverResult.value?.runtime_state;
    if (typeof state === "string" && state.length > 0) {
      precondition.runtime_state = state;
    }
  }
  if (
    original.stage_execution_revision !== undefined &&
    stageResult.status === "fulfilled"
  ) {
    const revision = stageResult.value?.revision;
    if (typeof revision === "number" && Number.isFinite(revision)) {
      precondition.stage_execution_revision = revision;
    }
  }
  if (queueResult.status === "fulfilled") {
    const queue = queueResult.value;
    const commandRevision = Array.isArray(queue?.commands)
      ? queue.commands.length
      : null;
    if (commandRevision !== null && Number.isFinite(commandRevision)) {
      precondition.command_revision = commandRevision;
    }
  }
  if (
    sessionStatusResult.status === "fulfilled" &&
    sessionStatusResult.value
  ) {
    const resources = sessionStatusResult.value.resources;
    if (typeof resources.region_topology_revision === "number") {
      precondition.region_topology_revision =
        resources.region_topology_revision;
    }
    if (typeof resources.region_membership_revision === "number") {
      precondition.region_membership_revision =
        resources.region_membership_revision;
    }
    if (typeof resources.region_coefficients_revision === "number") {
      precondition.region_coefficients_revision =
        resources.region_coefficients_revision;
    }
    if (typeof resources.region_initial_state_revision === "number") {
      precondition.region_initial_state_revision =
        resources.region_initial_state_revision;
    }
  }

  return {
    ...command,
    precondition,
  } as StructuredCommandRequest;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function studyStages(scene: unknown): JsonObject[] {
  const stages = record(record(scene).study).stages;
  return Array.isArray(stages)
    ? stages.filter((stage): stage is JsonObject =>
        Boolean(stage && typeof stage === "object" && !Array.isArray(stage)),
      )
    : [];
}

function stageKind(stage: JsonObject): string {
  const kind = stage.kind ?? stage.entrypoint_kind ?? "stage";
  return typeof kind === "string" && kind.trim() ? kind : "stage";
}

function stageIdForKind(kind: string, index: number): string {
  return `${kind.replace(/_/g, "-")}-${index + 1}`;
}

function stageWithDefaultId(stage: JsonObject, index: number): JsonObject {
  if (typeof stage.stage_id === "string" && stage.stage_id.trim()) {
    return stage;
  }
  return {
    ...stage,
    stage_id: stageIdForKind(stageKind(stage), index),
  };
}

function stageSelectionKind(kind: string):
  | "study.stage.action"
  | "study.stage.add_field_drive"
  | "study.stage.autosave"
  | "study.stage.eigenmodes"
  | "study.stage.frequency_response"
  | "study.stage.fft_response"
  | "study.stage.hysteresis"
  | "study.stage.relax"
  | "study.stage.run"
  | "study.stage.table_autosave"
  | "study.stage.save_state" {
  if (kind === "eigenmodes") return "study.stage.eigenmodes";
  if (kind === "add_field_drive") return "study.stage.add_field_drive";
  if (kind === "table_autosave") return "study.stage.table_autosave";
  if (kind === "autosave") return "study.stage.autosave";
  if (kind === "fft_response") return "study.stage.fft_response";
  if (kind === "frequency_response") return "study.stage.frequency_response";
  if (kind === "hysteresis") return "study.stage.hysteresis";
  if (kind === "relax") return "study.stage.relax";
  if (kind === "run") return "study.stage.run";
  if (kind === "save_state") return "study.stage.save_state";
  return "study.stage.action";
}

function selectAuthoredStage(context: CommandContext, stage: JsonObject, index: number): void {
  const kind = stageKind(stage);
  const stageId = typeof stage.stage_id === "string" && stage.stage_id.trim()
    ? stage.stage_id
    : stageIdForKind(kind, index);
  const nodeId = `model:study:stages:stage:${stageId}`;
  context.layout?.setActiveTab("study");
  context.layout?.setPanelVisible("right", true);
  context.selection?.set(
    {
      kind: stageSelectionKind(kind),
      label: `${kind.replace(/_/g, " ")} stage`,
      nodeId,
      objectId: null,
      ref: {
        kind: stageSelectionKind(kind),
        nodeId,
        stageId,
        stageIndex: index,
        type: "study-stage",
      },
    },
    "ribbon",
  );
}

function selectedStageIndex(context: CommandContext): number | null {
  const selection = context.selection?.get();
  const index = selection?.ref?.type === "study-stage"
    ? selection.ref.stageIndex
    : null;
  return typeof index === "number" && Number.isInteger(index) && index >= 0
    ? index
    : null;
}

function selectedStageId(context: CommandContext): string | null {
  const selection = context.selection?.get();
  const stageId = selection?.ref?.type === "study-stage"
    ? selection.ref.stageId
    : null;
  return typeof stageId === "string" && stageId.trim() ? stageId : null;
}

function commandInputStageId(input: unknown): string | null {
  if (!input || typeof input !== "object" || !("stageId" in input)) {
    return null;
  }
  const stageId = (input as { stageId?: unknown }).stageId;
  return typeof stageId === "string" && stageId.trim() ? stageId : null;
}

function sceneRevision(value: unknown): string | number {
  const revision = record(value).scene_revision ?? record(record(value).committed_scene).revision;
  return typeof revision === "number" || typeof revision === "string"
    ? revision
    : Date.now();
}

function sceneBaseRevision(value: unknown): number | null {
  const payload = record(value);
  const candidate =
    payload.scene_revision ??
    payload.revision ??
    record(payload.scene).revision;
  if (typeof candidate === "number") {
    return Number.isFinite(candidate) ? candidate : null;
  }
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  const parsed = Number(candidate);
  return Number.isFinite(parsed) ? parsed : null;
}

function invalidateStudyAuthoringResources(
  context: CommandContext,
  revision: string | number,
): void {
  context.resources?.invalidate(MODEL_SCENE_PATH, revision);
  context.resources?.invalidate(MODEL_READINESS_PATH, revision);
  context.resources?.invalidate(MODEL_STUDY_PATH, revision);
  context.resources?.invalidate(SESSION_STATUS_RESOURCE_KEY, revision);
  context.resources?.invalidate(SIMULATION_STAGES_EXECUTION_PATH, revision);
}

function addStageCommand(
  id: string,
  title: string,
  stage: JsonObject,
  successMessage: string,
  capabilityDisabledReason?: (context: CommandContext) => string | null,
): CommandContribution {
  return {
    id,
    title,
    category: "Study",
    group: "study-authoring",
    scope: "workspace",
    isEnabled: (context) =>
      isApiAvailable(context) &&
      (capabilityDisabledReason?.(context) ?? null) === null,
    disabledReason: (context) =>
      disabledWithoutApi(context) ?? capabilityDisabledReason?.(context) ?? null,
    run: async (context) => {
      if (!context.api) {
        return { message: "Control-room API is unavailable.", status: "failed" };
      }

      const scene = await context.api.model.scene();
      const baseRevision = sceneBaseRevision(scene);
      if (baseRevision === null) {
        return {
          message: "Scene revision is unavailable; refresh the scene and retry.",
          status: "failed",
        };
      }
      const currentStages = studyStages(scene);
      const addedStage = stageWithDefaultId(stage, currentStages.length);
      const nextStages = [
        ...currentStages,
        addedStage,
      ];
      const response = await context.api.model.commitTransaction({
        kind: "merge_patch",
        base_revision: baseRevision,
        merge_patch: {
          study: {
            stages: nextStages,
          },
        },
      });
      const revision = sceneRevision(response);
      invalidateStudyAuthoringResources(context, revision);
      selectAuthoredStage(context, addedStage, currentStages.length);

      return { message: successMessage, status: "completed" };
    },
  };
}

function stageOperationDisabledReason(
  operationId: ActiveLaneOperationId,
): (context: CommandContext) => string | null {
  return (context) => {
    const status = resourceData<LiveStatusResource>(
      context,
      SESSION_STATUS_RESOURCE_KEY,
    );
    const operation = resolveActiveLaneOperation(
      status?.capabilities.active_lane ?? null,
      operationId,
    );
    return operation.enabled ? null : operation.reason;
  };
}

function continueHysteresisToNextStageCommand(): CommandContribution {
  return {
    id: "hysteresis.continue-to-next-stage",
    title: "Continue to Next Stage",
    category: "Study",
    group: "hysteresis",
    scope: "runtime",
    isEnabled: isApiAvailable,
    disabledReason: disabledWithoutApi,
    run: async (context) => {
      if (!context.api) {
        return { message: "Control-room API is unavailable.", status: "failed" };
      }
      const stageId = commandInputStageId(context.input) ?? selectedStageId(context);
      if (!stageId) {
        return {
          message: "Select a hysteresis stage before continuing.",
          status: "failed",
        };
      }

      const scene = await context.api.model.scene();
      const baseRevision = sceneBaseRevision(scene);
      if (baseRevision === null) {
        return {
          message: "Scene revision is unavailable; refresh the scene and retry.",
          status: "failed",
        };
      }
      const currentStages = studyStages(scene);
      const sourceIndex = currentStages.findIndex(
        (stage) => stage.stage_id === stageId,
      );
      if (sourceIndex < 0) {
        return {
          message: `Hysteresis stage ${stageId} is no longer present.`,
          status: "failed",
        };
      }
      if (stageKind(currentStages[sourceIndex]) !== "hysteresis") {
        return {
          message: "Selected stage is not a hysteresis stage.",
          status: "failed",
        };
      }

      const addedStage = stageWithDefaultId(DEFAULT_RUN_STAGE, currentStages.length);
      const nextStages = [
        ...currentStages,
        addedStage,
      ];
      const response = await context.api.model.commitTransaction({
        kind: "merge_patch",
        base_revision: baseRevision,
        merge_patch: {
          study: {
            stages: nextStages,
          },
        },
      });
      const revision = sceneRevision(response);
      invalidateStudyAuthoringResources(context, revision);
      selectAuthoredStage(context, addedStage, currentStages.length);

      return {
        message: `Continuation run stage added after ${stageId}.`,
        status: "completed",
      };
    },
  };
}

function removeSelectedStageCommand(): CommandContribution {
  return {
    id: "study.remove-selected-stage",
    title: "Remove Selected Stage",
    category: "Study",
    group: "study-authoring",
    scope: "selection",
    isEnabled: (context) =>
      Boolean(context.api) && selectedStageIndex(context) !== null,
    disabledReason: (context) => {
      if (!context.api) return "Control Room API is not available.";
      return selectedStageIndex(context) === null
        ? "Select a study stage to remove it."
        : null;
    },
    run: async (context) => {
      if (!context.api) {
        return { message: "Control-room API is unavailable.", status: "failed" };
      }
      const index = selectedStageIndex(context);
      if (index === null) {
        return { message: "Select a study stage to remove it.", status: "failed" };
      }

      const scene = await context.api.model.scene();
      const baseRevision = sceneBaseRevision(scene);
      if (baseRevision === null) {
        return {
          message: "Scene revision is unavailable; refresh the scene and retry.",
          status: "failed",
        };
      }
      const stages = studyStages(scene);
      if (!stages[index]) {
        return { message: "Selected study stage is no longer present.", status: "failed" };
      }
      const nextStages = stages.filter((_, stageIndex) => stageIndex !== index);
      const response = await context.api.model.commitTransaction({
        kind: "merge_patch",
        base_revision: baseRevision,
        merge_patch: {
          study: {
            stages: nextStages,
          },
        },
      });
      const revision = sceneRevision(response);
      invalidateStudyAuthoringResources(context, revision);
      return { message: "Study stage removed.", status: "completed" };
    },
  };
}

function runtimeCommand(
  id: string,
  title: string,
  kind: SimpleStudyRuntimeCommandKind,
  successMessage: string,
): CommandContribution {
  return {
    id,
    title,
    category: "Study",
    group: "study-runtime",
    scope: "runtime",
    isEnabled: (context) => runtimeCommandDisabledReason(context, kind) === null,
    disabledReason: (context) => runtimeCommandDisabledReason(context, kind),
    isActive: (context) => isRuntimeCommandActive(context, kind),
    activeResource: (context) => activeRuntimeCommandResource(context, kind),
    run: (context) =>
      submitRuntimeCommand(
        context,
        buildRuntimeCommandFromContext(context, kind),
        successMessage,
      ),
  };
}

function checkCapability(context: CommandContext, capability: string, actionName: string): string | null {
  const status = resourceData<LiveStatusResource>(context, SESSION_STATUS_RESOURCE_KEY);
  if (!status) return "Session status is unavailable.";
  const caps = status.capabilities as Record<string, unknown>;
  if (!caps?.[capability]) {
    return `Active solver backend does not support ${capability} for ${actionName}.`;
  }
  return null;
}

function plannedCommandMessage(title: string): string {
  return `${title} is not implemented yet.`;
}

function plannedCommandDisabledReason(title: string): () => string {
  return () => plannedCommandMessage(title);
}

function plannedCommandRun(title: string) {
  return () => ({
    message: plannedCommandMessage(title),
    status: "failed" as const,
  });
}

function kPathDisabledReason(context: CommandContext): string | null {
  return (
    checkCapability(context, "eigen_modes", "updating k-path") ??
    plannedCommandMessage("Update k-Path")
  );
}

function fieldCalculationDisabledReason(context: CommandContext): string | null {
  return (
    checkCapability(context, "binary_fields", "field calculation") ??
    runtimeCommandDisabledReason(context, "compute_fields")
  );
}

function studyNavigationCommand(
  id: string,
  title: string,
  kind: "study.root" | "study.stages",
  label: string,
  nodeId: string,
): CommandContribution {
  return {
    id,
    title,
    category: "Study",
    group: "study-navigation",
    scope: "workspace",
    run: (context) => {
      context.selection?.set(
        {
          kind,
          label,
          nodeId,
          objectId: null,
          ref: {
            kind,
            nodeId,
            type: "study",
          },
        },
        "ribbon",
      );
      return { status: "completed" };
    },
  };
}

export const STUDY_RUNTIME_COMMANDS: CommandContribution[] = [
  studyNavigationCommand(
    "study.open-overview",
    "Open Study Overview",
    "study.root",
    "Study",
    "model:study",
  ),
  studyNavigationCommand(
    "study.open-stages",
    "Open Study Stages",
    "study.stages",
    "Stages",
    "model:study:stages",
  ),
  addStageCommand(
    "study.add-relax-stage",
    "Add Relax Stage",
    DEFAULT_RELAX_STAGE,
    "Relax stage added.",
    stageOperationDisabledReason("study.relaxation"),
  ),
  addStageCommand(
    "study.add-field-drive-stage",
    "Add Antenna Stage",
    DEFAULT_ADD_FIELD_DRIVE_STAGE,
    "Antenna instruction added.",
  ),
  addStageCommand(
    "study.add-table-autosave-stage",
    "Add Table Autosave Stage",
    DEFAULT_TABLE_AUTOSAVE_STAGE,
    "Table-autosave instruction added.",
  ),
  addStageCommand(
    "study.add-autosave-stage",
    "Add Autosave Stage",
    DEFAULT_AUTOSAVE_STAGE,
    "Autosave instruction added.",
  ),
  addStageCommand(
    "study.add-fft-response-stage",
    "Add FFT Response Stage",
    DEFAULT_FFT_RESPONSE_STAGE,
    "FFT-response instruction added.",
    stageOperationDisabledReason("study.fft"),
  ),
  addStageCommand(
    "study.add-run-stage",
    "Add Run Stage",
    DEFAULT_RUN_STAGE,
    "Run stage added.",
    stageOperationDisabledReason("study.time_integration"),
  ),
  addStageCommand(
    "study.add-hysteresis-stage",
    "Add Hysteresis Stage",
    DEFAULT_HYSTERESIS_STAGE,
    "Hysteresis stage added.",
  ),
  addStageCommand(
    "study.add-eigenmodes-stage",
    "Add Eigenmodes Stage",
    DEFAULT_EIGENMODES_STAGE,
    "Eigenmodes stage added.",
    stageOperationDisabledReason("study.eigenmodes"),
  ),
  addStageCommand(
    "study.add-frequency-response-stage",
    "Add Frequency Response Stage",
    DEFAULT_FREQUENCY_RESPONSE_STAGE,
    "Frequency response stage added.",
    stageOperationDisabledReason("study.frequency_response"),
  ),
  addStageCommand(
    "study.add-save-state-stage",
    "Add Save State Stage",
    DEFAULT_SAVE_STATE_STAGE,
    "Save-state stage added.",
  ),
  continueHysteresisToNextStageCommand(),
  removeSelectedStageCommand(),
  {
    id: "diagnostics.toggle-solver-profiler",
    title: "Solver Profiler",
    category: "Tools",
    group: "diagnostics",
    scope: "runtime",
    isEnabled: (context) => solverProfileDisabledReason(context) === null,
    disabledReason: solverProfileDisabledReason,
    isActive: solverProfileEnabled,
    run: async (context) => {
      if (!context.api) {
        return { message: "Control-room API is unavailable.", status: "failed" };
      }

      const command = buildSolverProfileCommand(context);
      const response = await context.api.commands.submit(command);
      const enabled = command.profile.enabled === true;
      if (!response.accepted) {
        return {
          message:
            response.error ??
            `Solver profiler ${enabled ? "enable" : "disable"} command rejected.`,
          status: "failed",
        };
      }

      invalidateSolverProfileResources(
        context,
        commandRevision(response, "diagnostics:solver-profiler"),
      );

      return {
        message: enabled
          ? "Solver profiler enabled."
          : "Solver profiler disabled.",
        status: "completed",
      };
    },
  },
  runtimeCommand(
    "study.run",
    "Compute Study",
    "solve",
    "Study compute command accepted.",
  ),
  runtimeCommand(
    "study.pause",
    "Pause Study",
    "pause",
    "Pause command accepted.",
  ),
  runtimeCommand(
    "study.resume",
    "Resume Study",
    "resume",
    "Resume command accepted.",
  ),
  runtimeCommand(
    "study.stop",
    "Stop Study",
    "stop",
    "Stop command accepted.",
  ),
  runtimeCommand(
    "study.skip",
    "Skip Stage",
    "skip",
    "Skip stage command accepted.",
  ),
  runtimeCommand(
    "study.save-vtk",
    "Export VTK",
    "save_vtk",
    "VTK export command accepted.",
  ),
  {
    id: "study.discard-paused-state",
    title: "Discard Paused State",
    category: "Study",
    group: "study-recovery",
    scope: "runtime",
    isEnabled: (context) => discardPausedStateDisabledReason(context) === null,
    disabledReason: discardPausedStateDisabledReason,
    isActive: (context) =>
      isRuntimeCommandActive(context, "stop", "discard_paused_state"),
    activeResource: (context) =>
      activeRuntimeCommandResource(context, "stop", "discard_paused_state"),
    run: (context) =>
      submitRuntimeCommand(
        context,
        buildRuntimeCommandFromContext(context, "stop", {
          precondition: { runtime_state: "paused" },
          reason: "discard_paused_state",
        }),
        "Paused state discard command accepted.",
      ),
  },
  {
    id: "study.save-checkpoint",
    title: "Save Checkpoint",
    category: "Study",
    group: "study-recovery",
    scope: "runtime",
    isEnabled: (context) => saveCheckpointDisabledReason(context) === null,
    disabledReason: saveCheckpointDisabledReason,
    run: async (context) => {
      if (!context.api) {
        return { message: "Control-room API is unavailable.", status: "failed" };
      }

      const response = await context.api.persistence.checkpoints.create({
        profile: "resume",
        reason: "user_requested",
      });
      const revision = response.checkpoint.checkpoint_id;
      invalidateCheckpointResources(context, revision);

      return {
        message: "Checkpoint saved.",
        status: "completed",
      };
    },
  },
  {
    id: "study.restore-checkpoint",
    title: "Restore Checkpoint",
    category: "Study",
    group: "study-recovery",
    scope: "runtime",
    isEnabled: (context) => restoreCheckpointDisabledReason(context) === null,
    disabledReason: restoreCheckpointDisabledReason,
    run: async (context) => {
      if (!context.api) {
        return { message: "Control-room API is unavailable.", status: "failed" };
      }

      const checkpoint = resolveCheckpointForRestore(context);
      if (!checkpoint) {
        return { message: "No checkpoint is selected.", status: "failed" };
      }

      const response = await context.api.persistence.checkpoints.restore(
        checkpoint.checkpoint_id,
        { reason: "user_requested" },
      );
      const revision =
        response.field_revision ?? response.checkpoint.checkpoint_id;
      invalidateRestoredStateResources(context, revision);

      return {
        message: "Checkpoint restored.",
        status: "completed",
      };
    },
  },
  {
    id: "study.save-field-state",
    title: "Save Field State",
    category: "Study",
    group: "study-recovery",
    scope: "runtime",
    isEnabled: (context) => fieldStateSaveDisabledReason(context) === null,
    disabledReason: fieldStateSaveDisabledReason,
    run: async (context) => {
      if (!context.api) {
        return { message: "Control-room API is unavailable.", status: "failed" };
      }
      const target = resolveFieldStateTarget(context);
      if (!target || target.kind !== "object") {
        return {
          message: fieldStateSaveDisabledReason(context) ?? "No field-state target selected.",
          status: "failed",
        };
      }
      const input = resolveFieldStateInput(context.input);
      const fileName =
        input?.fileName ?? input?.file_name ?? `${target.id}-m.h5`;
      const response = await context.api.persistence.fieldStates.export({
        target,
        quantity_id: "m",
        format: input?.format ?? "h5",
        file_name: fileName,
      });
      const artifact = await context.api.data.artifacts.bytes(response.artifact_ref);
      if (artifact.status !== "ready" || !artifact.data) {
        return {
          message: "Field state was exported but the artifact download failed.",
          status: "failed",
        };
      }
      maybeDownloadBinaryExport(
        artifactFileName(response.artifact_ref),
        artifact.data,
      );
      context.resources?.invalidate(
        PERSISTENCE_FIELD_STATE_EXPORTS_PATH,
        response.artifact_ref,
      );

      return {
        message: `Field state saved as ${response.artifact_ref}.`,
        status: "completed",
      };
    },
  },
  {
    id: "study.load-field-state",
    title: "Load Field State",
    category: "Study",
    group: "study-recovery",
    scope: "runtime",
    isEnabled: (context) => fieldStateLoadDisabledReason(context) === null,
    disabledReason: fieldStateLoadDisabledReason,
    run: async (context) => {
      if (!context.api) {
        return { message: "Control-room API is unavailable.", status: "failed" };
      }
      const target = resolveFieldStateTarget(context);
      if (!target) {
        return {
          message: fieldStateLoadDisabledReason(context) ?? "No field-state target selected.",
          status: "failed",
        };
      }
      const quantityId = fieldStateQuantityId(target);
      const mode = fieldStateImportMode(target);
      const input = resolveFieldStateInput(context.input);
      let artifactRef = input?.artifactRef ?? input?.artifact_ref;
      if (!artifactRef) {
        const uploaded =
          input?.contentBase64 || input?.content_base64
            ? {
                contentBase64: input.contentBase64 ?? input.content_base64 ?? "",
                fileName:
                  input.fileName ??
                  input.file_name ??
                  `${target.id}-m.field-state.json`,
              }
            : await pickFieldStateFileBase64();
        if (!uploaded) {
          return {
            message: "No field-state file selected.",
            status: "cancelled",
          };
        }
        const asset = await context.api.persistence.assets.import({
          content_base64: uploaded.contentBase64,
          file_name: uploaded.fileName,
          target_realization: "field_state",
        });
        artifactRef = asset.artifact_ref;
      }
      if (!artifactRef) {
        return {
          message: "No field-state artifact selected.",
          status: "cancelled",
        };
      }

      const inspection = await context.api.persistence.fieldStates.inspectImport({
        artifact_ref: artifactRef,
        target,
        quantity_id: quantityId,
        format: "field_state_json",
      });
      if (inspection.compatibility !== "compatible") {
        return {
          message:
            inspection.warnings[0] ??
            "Selected field-state artifact is not compatible with the current target.",
          status: "failed",
        };
      }
      const response = await context.api.persistence.fieldStates.import({
        artifact_ref: artifactRef,
        target,
        quantity_id: quantityId,
        mode,
      });
      invalidateRestoredStateResources(context, response.field_revision);
      context.resources?.invalidate(
        PERSISTENCE_FIELD_STATE_IMPORT_INSPECTIONS_PATH,
        response.field_revision,
      );
      context.resources?.invalidate(
        PERSISTENCE_FIELD_STATE_IMPORTS_PATH,
        response.field_revision,
      );

      return {
        message: `Field state loaded from ${artifactRef}.`,
        status: "completed",
      };
    },
  },
  {
    id: "study.export-state",
    title: "Export State",
    category: "Study",
    group: "study-recovery",
    scope: "runtime",
    isEnabled: (context) => exportStateDisabledReason(context) === null,
    disabledReason: exportStateDisabledReason,
    run: async (context) => {
      if (!context.api) {
        return { message: "Control-room API is unavailable.", status: "failed" };
      }

      const response = await context.api.persistence.exports.create({
        profile: "resume",
        ui_state: exportControlRoomUiState(context),
      });
      context.resources?.invalidate(PERSISTENCE_EXPORTS_PATH, response.session_id);
      maybeDownloadFmsExport(
        `${response.session_id}-${response.profile}.fms`,
        response.fms_base64,
      );

      return {
        message: "State export created.",
        status: "completed",
      };
    },
  },
  {
    id: "study.import-state",
    title: "Import State",
    category: "Study",
    group: "study-recovery",
    scope: "runtime",
    shortcut: "Ctrl+O",
    isEnabled: isApiAvailable,
    disabledReason: disabledWithoutApi,
    run: async (context) => {
      if (!context.api) {
        return { message: "Control-room API is unavailable.", status: "failed" };
      }

      const input = resolveImportStateInput(context.input);
      const fmsBase64 = input?.fmsBase64 ?? (await pickFmsFileBase64());
      if (!fmsBase64) {
        return { message: "No .fms file selected.", status: "cancelled" };
      }

      const response = await context.api.persistence.imports.commit({
        fms_base64: fmsBase64,
        restore_mode: input?.restoreMode ?? "resume",
      });
      applyControlRoomUiState(context, response.ui_state);
      invalidateImportedSessionResources(context, response.session_id);

      return {
        message: `State imported from ${response.session_id}.`,
        status: "completed",
      };
    },
  },
  {
    id: "study.compute-fields",
    title: "Compute Fields",
    category: "Study",
    group: "study-runtime",
    scope: "runtime",
    isEnabled: (context) =>
      runtimeCommandDisabledReason(context, "compute_fields") === null,
    disabledReason: (context) =>
      runtimeCommandDisabledReason(context, "compute_fields"),
    isActive: (context) => isRuntimeCommandActive(context, "compute_fields"),
    activeResource: (context) =>
      activeRuntimeCommandResource(context, "compute_fields"),
    run: (context) =>
      submitRuntimeCommand(
        context,
        buildRuntimeCommandFromContext(context, "compute_fields"),
        "Compute fields command accepted.",
      ),
  },
  {
    id: "study.compute-energies",
    title: "Compute Energies",
    category: "Study",
    group: "study-runtime",
    scope: "runtime",
    isEnabled: (context) =>
      runtimeCommandDisabledReason(context, "compute_energies") === null,
    disabledReason: (context) =>
      runtimeCommandDisabledReason(context, "compute_energies"),
    isActive: (context) => isRuntimeCommandActive(context, "compute_energies"),
    activeResource: (context) =>
      activeRuntimeCommandResource(context, "compute_energies"),
    run: (context) =>
      submitRuntimeCommand(
        context,
        buildRuntimeCommandFromContext(context, "compute_energies"),
        "Compute energies command accepted.",
      ),
  },
  {
    id: "hysteresis.load-point-in-3d",
    title: "Load in 3D",
    category: "Study",
    group: "hysteresis",
    scope: "runtime",
    isEnabled: () => true,
    run: async (context) => {
      const input = context.input as {
        stageId: string;
        pointId: number;
        fieldVal: number;
        mVal: number;
        snapshotId: string | null;
        snapshotResourceRef?: string | null;
        snapshotStorageStatus?: string | null;
        snapshotStorageReason?: string | null;
        meshIdentity?: string | null;
        fieldOrientation?: string | null;
        measurementAxis?: string | null;
        fieldRevision?: string | number | null;
      };
      if (!input) {
        return { status: "failed", message: "Missing command input." };
      }
      if (!input.snapshotId) {
        return {
          status: "failed",
          message: "This hysteresis point has no saved magnetization snapshot.",
        };
      }
      if (input.snapshotStorageStatus === "missing") {
        return {
          status: "failed",
          message: input.snapshotStorageReason
            ? `Snapshot payload is missing for this hysteresis point: ${input.snapshotStorageReason}`
            : "Snapshot payload is missing for this hysteresis point.",
        };
      }
      if (!context.selection) {
        return { status: "failed", message: "Selection context not available." };
      }
      context.selection.set(
        {
          kind: "analysis.chart-point",
          label: `Point ${input.pointId} (${input.fieldVal} mT)`,
          nodeId: `analysis:hysteresis:${input.stageId}:point:${input.pointId}`,
          objectId: null,
          ref: {
            type: "analysis-chart-point",
            kind: "analysis.chart-point",
            nodeId: `analysis:hysteresis:${input.stageId}:point:${input.pointId}`,
            chartId: `hysteresis:${input.stageId}`,
            tableId: `hysteresis:${input.stageId}`,
            seriesId: `hysteresis:${input.stageId}:m`,
            quantity: "m",
            rowIndex: input.pointId,
            stageId: input.stageId,
            pointId: input.pointId,
            x: input.fieldVal,
            y: input.mVal,
            snapshotId: input.snapshotId,
            resourceRef: input.snapshotResourceRef ?? null,
            targetId: `hysteresis-step:${input.stageId}:${input.pointId}`,
            targetKind: "hysteresis-step",
            quantityId: "m",
            meshIdentity: input.meshIdentity ?? null,
            fieldOrientation: input.fieldOrientation ?? null,
            measurementAxis: input.measurementAxis ?? null,
            fieldRevision: input.fieldRevision ?? null,
          },
        },
        "analysis-plots",
      );
      context.layout?.setActiveViewportMainModule("viewport-3d");
      context.layout?.setFocusedSlot("viewport-main");
      return { status: "completed", message: "Loaded point in 3D." };
    },
  },
  {
    id: "hysteresis.return-to-live",
    title: "Return to Live Field",
    category: "Study",
    group: "hysteresis",
    scope: "runtime",
    isEnabled: () => true,
    run: (context) => {
      if (!context.selection) {
        return { status: "failed", message: "Selection context not available." };
      }
      const input = context.input as { stageId?: string | null } | null;
      let returnedToLive = false;
      if (input?.stageId) {
        const ref = context.selection.get().ref;
        const replayRef =
          ref?.type === "analysis-chart-point" || ref?.type === "hysteresis-snapshot";
        if (
          replayRef &&
          ref.stageId === input.stageId
        ) {
          context.selection.clear("analysis-plots");
          returnedToLive = true;
        } else if (ref === null) {
          returnedToLive = true;
        }
      } else {
        context.selection.clear("analysis-plots");
        returnedToLive = true;
      }
      if (returnedToLive) {
        invalidateHysteresisReturnToLiveResources(context);
      }
      return {
        status: "completed",
        message: "Returned 3D viewport to the live magnetization field.",
      };
    },
  },
  {
    id: "hysteresis.compare-point",
    title: "Compare Point",
    category: "Study",
    group: "hysteresis",
    scope: "runtime",
    isEnabled: () => true,
    run: (context) => {
      const input = resolveHysteresisPointCommandInput(context.input);
      if (!input) {
        return { status: "failed", message: "Missing hysteresis point input." };
      }
      if (!context.selection) {
        return { status: "failed", message: "Selection context not available." };
      }
      context.selection.set(
        hysteresisPointSelectionPayload(input),
        "analysis-plots",
      );
      context.layout?.setActiveViewportMainModule("analysis-plots");
      context.layout?.setFocusedSlot("viewport-main");
      return {
        status: "completed",
        message: `Selected hysteresis point ${input.point.point_id} for comparison.`,
      };
    },
  },
  {
    id: "hysteresis.bookmark-point",
    title: "Bookmark Point",
    category: "Study",
    group: "hysteresis",
    scope: "runtime",
    isEnabled: () => true,
    run: async (context) => {
      const input = resolveHysteresisPointCommandInput(context.input);
      if (!input) {
        return { status: "failed", message: "Missing hysteresis point input." };
      }
      if (!context.api) {
        return {
          status: "failed",
          message: "Control-room API is unavailable.",
        };
      }
      const response = await context.api.analysis.hysteresis.bookmarkPoint(
        input.stageId,
        hysteresisBookmarkPointRequest(input),
      );
      invalidateHysteresisBookmarkResources(context, input.stageId, response.revision);
      return {
        status: "completed",
        message: `Bookmarked hysteresis point ${input.point.point_id}.`,
      };
    },
  },
  {
    id: "hysteresis.export-point-csv",
    title: "Export Point CSV",
    category: "Study",
    group: "hysteresis",
    scope: "runtime",
    isEnabled: () => true,
    run: (context) => {
      const input = resolveHysteresisPointCommandInput(context.input);
      if (!input) {
        return { status: "failed", message: "Missing hysteresis point input." };
      }
      const csv = hysteresisPointCsv(input);
      maybeDownloadBinaryExport(
        `${input.stageId}-point-${input.point.point_id}.csv`,
        new TextEncoder().encode(csv),
        "text/csv;charset=utf-8",
      );
      return {
        status: "completed",
        message: `Exported hysteresis point ${input.point.point_id} as CSV.`,
      };
    },
  },
  {
    id: "hysteresis.export-loop-csv",
    title: "Export Loop CSV",
    category: "Study",
    group: "hysteresis",
    scope: "runtime",
    isEnabled: () => true,
    run: async (context) => {
      let input = resolveHysteresisLoopCommandInput(context.input);
      if (!input) {
        const stageId =
          commandInputStageId(context.input) ?? selectedStageId(context);
        if (stageId && context.api) {
          const pointsResource = await context.api.analysis.hysteresis.points(stageId);
          input = {
            points: Array.isArray(pointsResource.points) ? pointsResource.points : [],
            stageId,
          };
        }
      }
      if (!input) {
        return { status: "failed", message: "Missing hysteresis loop input." };
      }
      if (input.points.length === 0) {
        return {
          status: "failed",
          message: "No hysteresis points are available to export.",
        };
      }
      const csv = hysteresisLoopCsv(input);
      maybeDownloadBinaryExport(
        `${input.stageId}-hysteresis-loop.csv`,
        new TextEncoder().encode(csv),
        "text/csv;charset=utf-8",
      );
      return {
        status: "completed",
        message: `Exported hysteresis loop with ${input.points.length} points as CSV.`,
      };
    },
  },
  {
    id: "hysteresis.use-point-as-initial-state",
    title: "Use as Initial State",
    category: "Study",
    group: "hysteresis",
    scope: "runtime",
    isEnabled: () => true,
    run: async (context) => {
      const input = context.input as {
        stageId: string;
        snapshotId: string | null;
        snapshotArtifactRef?: string | null;
        snapshotResourceRef?: string | null;
      };
      if (!input?.snapshotId) {
        return { status: "failed", message: "No snapshot ID specified." };
      }
      if (!context.api) {
        return { status: "failed", message: "Control-room API is unavailable." };
      }
      const target = await resolveObjectFieldStateTarget(context);
      if (!target) {
        return {
          status: "failed",
          message:
            "Select a single object before using a hysteresis point as the initial state.",
        };
      }
      const artifactRef =
        input.snapshotArtifactRef?.trim() ||
        hysteresisSnapshotArtifactRefFromLegacyResource(input.snapshotResourceRef) ||
        `hysteresis_snapshots/${input.snapshotId}/m.json`;
      const response = await context.api.persistence.fieldStates.import({
        artifact_ref: artifactRef,
        mode: "apply",
        quantity_id: "m",
        target,
      });
      invalidateRestoredStateResources(context, response.field_revision);
      context.resources?.invalidate(
        PERSISTENCE_FIELD_STATE_IMPORTS_PATH,
        response.field_revision,
      );
      return {
        status: "completed",
        message: `Hysteresis point ${input.snapshotId} applied as initial state.`,
      };
    },
  },
  {
    id: "study.open-dynamics-workbench",
    title: "Open Dynamics Workbench",
    category: "Study",
    group: "study-runtime",
    scope: "workspace",
    isEnabled: () => false,
    disabledReason: plannedCommandDisabledReason("Open Dynamics Workbench"),
    run: plannedCommandRun("Open Dynamics Workbench"),
  },
  {
    id: "study.plot-selected-mode",
    title: "Plot Selected Mode",
    category: "Study",
    group: "study-runtime",
    scope: "selection",
    isEnabled: () => false,
    disabledReason: plannedCommandDisabledReason("Plot Selected Mode"),
    run: plannedCommandRun("Plot Selected Mode"),
  },
  {
    id: "study.plot-selected-response-field",
    title: "Plot Selected Response Field",
    category: "Study",
    group: "study-runtime",
    scope: "selection",
    isEnabled: () => false,
    disabledReason: plannedCommandDisabledReason("Plot Selected Response Field"),
    run: plannedCommandRun("Plot Selected Response Field"),
  },
  {
    id: "study.animate-phase",
    title: "Animate Phase",
    category: "Study",
    group: "study-runtime",
    scope: "viewport",
    isEnabled: () => false,
    disabledReason: plannedCommandDisabledReason("Animate Phase"),
    run: plannedCommandRun("Animate Phase"),
  },
  {
    id: "study.compare-selected-peak",
    title: "Compare Selected Peak",
    category: "Study",
    group: "study-runtime",
    scope: "selection",
    isEnabled: () => false,
    disabledReason: plannedCommandDisabledReason("Compare Selected Peak"),
    run: plannedCommandRun("Compare Selected Peak"),
  },
  {
    id: "study.export-selected-metadata",
    title: "Export Selected Metadata",
    category: "Study",
    group: "study-runtime",
    scope: "selection",
    isEnabled: () => false,
    disabledReason: plannedCommandDisabledReason("Export Selected Metadata"),
    run: plannedCommandRun("Export Selected Metadata"),
  },
  {
    id: "study.trigger-field-calculation",
    title: "Trigger Field Calculation",
    category: "Study",
    group: "study-runtime",
    scope: "runtime",
    isEnabled: (context) =>
      fieldCalculationDisabledReason(context) === null,
    disabledReason: (context) => fieldCalculationDisabledReason(context),
    isActive: (context) => isRuntimeCommandActive(context, "compute_fields"),
    activeResource: (context) =>
      activeRuntimeCommandResource(context, "compute_fields"),
    run: (context) =>
      submitRuntimeCommand(
        context,
        buildRuntimeCommandFromContext(context, "compute_fields"),
        "Field calculation command accepted.",
      ),
  },
  {
    id: "study.update-k-path",
    title: "Update k-Path",
    category: "Study",
    group: "study-runtime",
    scope: "runtime",
    isEnabled: (context) => kPathDisabledReason(context) === null,
    disabledReason: kPathDisabledReason,
    run: plannedCommandRun("Update k-Path"),
  },
];
