import {
  DATA_FIELDS_PATH,
  DATA_SCALARS_PATH,
  DIAGNOSTICS_ENGINE_LOG_PATH,
  DIAGNOSTICS_SOLVER_PROFILE_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MESHING_BUILDS_CURRENT_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_SCENE_PATH,
  MODEL_STUDY_PATH,
  PERSISTENCE_CHECKPOINTS_PATH,
  PERSISTENCE_EXPORTS_PATH,
  PERSISTENCE_IMPORTS_PATH,
  SIMULATION_COMMANDS_PATH,
  SIMULATION_OBJECT_METRICS_PATH,
  SIMULATION_RUN_CURRENT_PATH,
  SIMULATION_SOLVER_ENERGIES_CURRENT_PATH,
  SIMULATION_SOLVER_ENERGIES_HISTORY_PATH,
  SIMULATION_SOLVER_STATUS_PATH,
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
  CurrentRunResource,
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
import {
  applyControlRoomUiState,
  exportControlRoomUiState,
} from "../persistence/controlRoomUiState";
import { SESSION_STATUS_RESOURCE_KEY } from "../resources/useSessionStatus";

import {
  buildStudyRuntimeCommand,
  type SimpleStudyRuntimeCommandKind,
} from "./studyRuntimeCommandAdapters";

type JsonRecord = Record<string, unknown>;
type SolverProfileCommandRequest = Extract<
  StructuredCommandRequest,
  { kind: "set_solver_profile" }
>;

const DEFAULT_RELAX_STAGE: JsonObject = {
  entrypoint_kind: "relax",
  energy_tolerance: "",
  fixed_timestep: "",
  integrator: "auto",
  kind: "relax",
  max_physical_time_s: "",
  max_pseudotime_s: "",
  max_steps: "10000",
  relax_algorithm: "llg_overdamped",
  torque_tolerance_apm: DEFAULT_RELAX_TORQUE_APM,
};

const DEFAULT_RUN_STAGE: JsonObject = {
  demag_interval_s: "",
  entrypoint_kind: "run",
  fixed_timestep: "",
  integrator: "auto",
  kind: "run",
  until_seconds: "1e-9",
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
  if (backendControl && !backendControl.enabled) {
    return backendControl.reason ?? "Runtime command is unavailable.";
  }

  if (
    kind === "solve" &&
    queue?.commands.some((command) =>
      ACTIVE_RUNTIME_COMMAND_STATUSES.has(command.status),
    )
  ) {
    return "A runtime command is already active.";
  }

  const state = runtimeState(context);
  if (!state) return "Runtime state is unavailable.";

  switch (kind) {
    case "pause":
      return state === "running" ? null : "Runtime is not running.";
    case "resume":
      return state === "paused" ? null : "Runtime is not paused.";
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

  if (kind === "compute_fields" && !status.capabilities.binary_fields) {
    return "Field data plane is unavailable.";
  }

  const sceneRevision = status.resources.scene_revision;
  if (sceneRevision == null) return "No scene model is loaded.";

  if (hasRuntimeGeometryBlocker(context)) {
    return "Resolve geometry validation blockers before running runtime commands.";
  }

  if (isMeshBuildRunning(context)) {
    return "A mesh build is still running.";
  }

  if (!requiresExplicitMesh(status)) return null;

  if (status.resources.mesh_revision <= 0) {
    return "Build a shared-domain mesh before running FEM runtime commands.";
  }

  const manifest = resourceData<MeshSharedDomainManifestResource>(
    context,
    MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  );
  if (!manifest) return "Shared-domain mesh manifest is unavailable.";
  if (manifest.source_scene_revision == null) {
    return sharedDomainMeshReadyWithoutSceneProvenance(context)
      ? null
      : "Shared-domain mesh provenance is unavailable; rebuild the mesh.";
  }
  if (manifest.source_scene_revision !== sceneRevision) {
    return "Rebuild the shared-domain mesh for the current scene before running.";
  }

  return null;
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
      phase.id.toLowerCase() === "ready" &&
      meshReadyStatus(phase.status.toLowerCase()),
  );
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
  overrides: RuntimeCommandPrecondition = {},
): RuntimeCommandPrecondition | undefined {
  const stage = resourceData<StageExecutionResource>(
    context,
    SIMULATION_STAGES_EXECUTION_PATH,
  );
  const state = runtimeState(context);
  const commandRevision = commandRevisionPrecondition(context);
  const precondition: RuntimeCommandPrecondition = {
    ...(state ? { runtime_state: state } : {}),
    ...(stage ? { stage_execution_revision: stage.revision } : {}),
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
    precondition: runtimeCommandPrecondition(context, options.precondition),
    reason: options.reason,
    target:
      options.target ??
      (kind === "pause" ||
      kind === "resume" ||
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
    ? Math.max(current?.config.max_samples ?? 4096, 4096)
    : current?.config.max_samples ?? 4096;
  const sampleEvery = current?.config.sample_every ?? 1;
  const reason = requestedEnabled
    ? "enable_solver_profile"
    : "disable_solver_profile";

  return {
    client_intent_id: createSolverProfileClientIntentId(reason),
    kind: "set_solver_profile",
    profile: {
      emit_engine_log: requestedEnabled,
      enabled: requestedEnabled,
      max_samples: maxSamples,
      persist_artifact: requestedEnabled,
      sample_every: sampleEvery,
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

function invalidateImportedSessionResources(
  context: CommandContext,
  revision: string | number,
): void {
  invalidateRestoredStateResources(context, revision);
  context.resources?.invalidate(PERSISTENCE_IMPORTS_PATH, revision);
  context.resources?.invalidate(MODEL_SCENE_PATH, revision);
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

interface ImportStateInput {
  fmsBase64?: string;
  fms_base64?: string;
  restoreMode?: string;
  restore_mode?: string;
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

  const response = await context.api.commands.submit(command);
  if (!response.accepted) {
    return {
      message: response.error ?? `${successMessage} rejected.`,
      status: "failed",
    };
  }

  invalidateRuntimeControlResources(
    context,
    commandRevision(response, `study:${command.kind}`),
  );

  return { message: successMessage, status: "completed" };
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

function sceneRevision(value: unknown): string | number {
  const revision = record(value).scene_revision ?? record(record(value).committed_scene).revision;
  return typeof revision === "number" || typeof revision === "string"
    ? revision
    : Date.now();
}

function addStageCommand(
  id: string,
  title: string,
  stage: JsonObject,
  successMessage: string,
): CommandContribution {
  return {
    id,
    title,
    category: "Study",
    group: "study-authoring",
    scope: "workspace",
    isEnabled: isApiAvailable,
    disabledReason: disabledWithoutApi,
    run: async (context) => {
      if (!context.api) {
        return { message: "Control-room API is unavailable.", status: "failed" };
      }

      const scene = await context.api.model.scene();
      const nextStages = [...studyStages(scene), stage];
      const response = await context.api.model.commitTransaction({
        kind: "merge_patch",
        merge_patch: {
          study: {
            stages: nextStages,
          },
        },
      });
      const revision = sceneRevision(response);
      context.resources?.invalidate(MODEL_SCENE_PATH, revision);
      context.resources?.invalidate(MODEL_STUDY_PATH, revision);
      context.resources?.invalidate(SESSION_STATUS_RESOURCE_KEY, revision);

      return { message: successMessage, status: "completed" };
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

export const STUDY_RUNTIME_COMMANDS: CommandContribution[] = [
  addStageCommand(
    "study.add-relax-stage",
    "Add Relax Stage",
    DEFAULT_RELAX_STAGE,
    "Relax stage added.",
  ),
  addStageCommand(
    "study.add-run-stage",
    "Add Run Stage",
    DEFAULT_RUN_STAGE,
    "Run stage added.",
  ),
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
    run: async (context) => {
      if (!context.api) {
        return { message: "Control-room API is unavailable.", status: "failed" };
      }

      const response = await context.api.commands.submit({
        ...buildRuntimeCommandFromContext(context, "compute_fields"),
      });
      if (!response.accepted) {
        return {
          message: response.error ?? "Compute fields command rejected.",
          status: "failed",
        };
      }

      const revision = commandRevision(response, "compute-fields");
      invalidateRuntimeControlResources(context, revision);

      return {
        message: "Compute fields command accepted.",
        status: "completed",
      };
    },
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
    run: async (context) => {
      if (!context.api) {
        return { message: "Control-room API is unavailable.", status: "failed" };
      }

      const response = await context.api.commands.submit({
        ...buildRuntimeCommandFromContext(context, "compute_energies"),
      });
      if (!response.accepted) {
        return {
          message: response.error ?? "Compute energies command rejected.",
          status: "failed",
        };
      }

      const revision = commandRevision(response, "compute-energies");
      invalidateRuntimeControlResources(context, revision);

      return {
        message: "Compute energies command accepted.",
        status: "completed",
      };
    },
  },
];
