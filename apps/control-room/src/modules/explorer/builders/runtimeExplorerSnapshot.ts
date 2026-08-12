import {
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
  DIAGNOSTICS_SOLVER_PROFILE_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  PLATFORM_CAPABILITIES_PATH,
  PLATFORM_HEALTH_PATH,
  SESSION_STATUS_PATH,
  SIMULATION_COMMAND_DETAIL_PATH,
  SIMULATION_COMMANDS_PATH,
  SIMULATION_RUN_CURRENT_PATH,
  SIMULATION_SOLVER_STATUS_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
} from "@/kernel/api/apiPaths";
import type {
  CommandDetailResource,
  CommandQueueStatusResource,
  CurrentRunResource,
  FrequencyDomainManifestResource,
  GeometryValidationResource,
  HealthResource,
  LiveStatusResource,
  MeshSharedDomainManifestResource,
  PlatformCapabilitiesResource,
  ResourceRevision,
  SolverProfileResource,
  SolverStatusResource,
  StageExecutionResource,
} from "@/kernel/api/apiTypes";
import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import type { ResourceStatus } from "@/kernel/resources/resourceTypes";
import type {
  RuntimeExecutionDetail,
  RuntimeExplorerDetail,
} from "@/kernel/resources/runtimeExplorerTypes";

import type {
  ExplorerAvailability,
  ExplorerExecutionState,
  ExplorerNodeStatus,
  ExplorerResourceState,
} from "../explorerTypes";

export interface RuntimeResourceSnapshot<T> {
  data: T | null;
  error: string | null;
  missing: boolean;
  revision: ResourceRevision | null;
  status: ResourceStatus;
}

export interface RuntimeExplorerSourceSnapshot {
  commandDetails: RuntimeResourceSnapshot<CommandDetailResource[]>;
  commandQueue: RuntimeResourceSnapshot<CommandQueueStatusResource>;
  currentRun: RuntimeResourceSnapshot<CurrentRunResource>;
  frequencyDomainManifest: RuntimeResourceSnapshot<FrequencyDomainManifestResource>;
  geometryValidation: RuntimeResourceSnapshot<GeometryValidationResource>;
  meshManifest: RuntimeResourceSnapshot<MeshSharedDomainManifestResource>;
  platformCapabilities: RuntimeResourceSnapshot<PlatformCapabilitiesResource>;
  platformHealth: RuntimeResourceSnapshot<HealthResource>;
  sessionStatus: RuntimeResourceSnapshot<LiveStatusResource>;
  solverProfile: RuntimeResourceSnapshot<SolverProfileResource>;
  solverStatus: RuntimeResourceSnapshot<SolverStatusResource>;
  stageExecution: RuntimeResourceSnapshot<StageExecutionResource>;
}

export interface RuntimeResourceDescriptor {
  detail: RuntimeExplorerDetail;
  family: "analysis" | "diagnostics" | "meshing" | "platform" | "session" | "simulation";
  id: string;
  label: string;
  state: RuntimeNodeState;
}

export interface RuntimeJobDescriptor {
  detail: RuntimeExplorerDetail;
  id: string;
  kind: "command" | "run" | "stage";
  label: string;
  state: RuntimeNodeState;
}

export interface RuntimeDiagnosticDescriptor {
  detail: RuntimeExplorerDetail;
  id: string;
  kind: "capability" | "frequency-domain" | "health" | "mesh" | "performance" | "problem" | "solver";
  label: string;
  state: RuntimeNodeState;
}

export interface RuntimeNodeState {
  availability: ExplorerAvailability;
  executionState: ExplorerExecutionState;
  resourceState: ExplorerResourceState;
  status: ExplorerNodeStatus;
}

export interface RuntimeExplorerSnapshot {
  diagnostics: readonly RuntimeDiagnosticDescriptor[];
  jobs: readonly RuntimeJobDescriptor[];
  resources: readonly RuntimeResourceDescriptor[];
  source: RuntimeExplorerSourceSnapshot;
}

export function runtimeResourceSnapshot<T>(resource: {
  data: T | null;
  error: Error | null;
  revision: ResourceRevision | null;
  status: ResourceStatus;
}): RuntimeResourceSnapshot<T> {
  return {
    data: resource.data,
    error: resource.error?.message ?? null,
    missing: resource.error instanceof ControlRoomApiError && resource.error.status === 404,
    revision: resource.revision,
    status: resource.status,
  };
}

export function runtimeResourceSnapshotEquals<T>(
  left: RuntimeResourceSnapshot<T>,
  right: RuntimeResourceSnapshot<T>,
): boolean {
  return left.data === right.data &&
    left.error === right.error &&
    left.missing === right.missing &&
    left.revision === right.revision &&
    left.status === right.status;
}

export function runtimeExplorerSnapshotFromResources(
  source: RuntimeExplorerSourceSnapshot,
): RuntimeExplorerSnapshot {
  return {
    diagnostics: diagnosticDescriptors(source),
    jobs: jobDescriptors(source),
    resources: resourceDescriptors(source),
    source,
  };
}

function resourceDescriptors(source: RuntimeExplorerSourceSnapshot): RuntimeResourceDescriptor[] {
  const runOwner = source.currentRun.data ? `run:${source.currentRun.data.run_id}` : null;
  const sessionOwner = source.currentRun.data
    ? `session:${source.currentRun.data.session_id}`
    : source.sessionStatus.data
      ? `session:${source.sessionStatus.data.session.session_id}`
      : null;
  const manifest = source.frequencyDomainManifest.data;
  return [
    resourceDescriptor("resources:platform:health", "Health", "platform", PLATFORM_HEALTH_PATH, source.platformHealth, "platform", {
      schema: source.platformHealth.data?.api_contract_version ?? null,
    }),
    resourceDescriptor("resources:platform:capabilities", "Runtime Capabilities", "platform", PLATFORM_CAPABILITIES_PATH, source.platformCapabilities, "platform", {
      schema: source.platformCapabilities.data?.profile_version ?? null,
    }),
    resourceDescriptor("resources:session:status", "Session Status", "session", SESSION_STATUS_PATH, source.sessionStatus, sessionOwner, {
      generation: source.sessionStatus.data?.resources.domain_generation_id ?? null,
      schema: source.sessionStatus.data?.api_contract_version ?? null,
    }),
    resourceDescriptor("resources:simulation:current-run", "Current Run", "simulation", SIMULATION_RUN_CURRENT_PATH, source.currentRun, runOwner, {
      location: source.currentRun.data?.artifact_dir ?? null,
    }),
    resourceDescriptor("resources:simulation:stages", "Stage Execution", "simulation", SIMULATION_STAGES_EXECUTION_PATH, source.stageExecution, runOwner),
    resourceDescriptor("resources:simulation:commands", "Commands", "simulation", SIMULATION_COMMANDS_PATH, source.commandQueue, sessionOwner),
    resourceDescriptor("resources:simulation:solver-status", "Solver Status", "simulation", SIMULATION_SOLVER_STATUS_PATH, source.solverStatus, runOwner),
    resourceDescriptor("resources:meshing:shared-domain-manifest", "Shared-domain Mesh", "meshing", MESHING_SHARED_DOMAIN_MANIFEST_PATH, source.meshManifest, source.meshManifest.data ? `mesh:${source.meshManifest.data.mesh_id}` : sessionOwner, {
      generation: source.meshManifest.data?.generation_id ?? null,
      schema: source.meshManifest.data?.topology_schema_version == null
        ? null
        : `topology.v${source.meshManifest.data.topology_schema_version}`,
    }),
    resourceDescriptor("resources:diagnostics:solver-profile", "Solver Profile", "diagnostics", DIAGNOSTICS_SOLVER_PROFILE_PATH, source.solverProfile, runOwner),
    resourceDescriptor("resources:analysis:frequency-domain:manifest", "Frequency-domain Manifest", "analysis", ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH, source.frequencyDomainManifest, runOwner, {
      location: manifest?.result_manifest?.artifact_path ?? null,
      schema: manifest?.schema_version ?? null,
    }),
  ];
}

function resourceDescriptor<T>(
  id: string,
  label: string,
  family: RuntimeResourceDescriptor["family"],
  key: string,
  source: RuntimeResourceSnapshot<T>,
  owner: string | null,
  overrides: { generation?: string | null; location?: string | null; schema?: string | null } = {},
): RuntimeResourceDescriptor {
  return {
    detail: detail({
      category: "resource",
      generation: overrides.generation ?? null,
      key,
      location: overrides.location ?? key,
      message: source.error,
      owner,
      revision: source.revision,
      schema: overrides.schema ?? null,
      source,
    }),
    family,
    id,
    label,
    state: resourceNodeState(source),
  };
}

function jobDescriptors(source: RuntimeExplorerSourceSnapshot): RuntimeJobDescriptor[] {
  const descriptors: RuntimeJobDescriptor[] = [];
  const run = source.currentRun.data;
  if (run) {
    descriptors.push({
      detail: detail({
        category: "job",
        facts: [
          { label: "Steps", value: String(run.total_steps) },
          { label: "Started", value: run.started_at },
        ],
        key: SIMULATION_RUN_CURRENT_PATH,
        location: run.artifact_dir,
        owner: `run:${run.run_id}`,
        requestedExecution: executionDetail({
          backend: run.requested_backend,
          device: run.requested_device,
          mode: run.requested_mode,
          precision: run.requested_precision,
        }),
        resolvedExecution: executionDetail({
          backend: run.resolved_backend,
          device: run.resolved_device,
          engine_id: run.resolved_engine_id,
          mode: run.resolved_mode,
          precision: run.resolved_precision,
          runtime_family: run.resolved_runtime_family,
          worker: run.resolved_worker,
        }),
        revision: run.revision,
        source: source.currentRun,
      }),
      id: `jobs:run:${encodeId(run.run_id)}`,
      kind: "run",
      label: `Run ${run.run_id}`,
      state: executionNodeState(run.status, source.currentRun),
    });
  }

  for (const stage of [...(source.stageExecution.data?.stages ?? [])].sort((left, right) => left.index - right.index)) {
    descriptors.push({
      detail: detail({
        category: "job",
        facts: [
          { label: "Stage kind", value: stage.kind ?? "unavailable" },
          { label: "Progress", value: stage.progress_label ?? stage.progress_detail ?? "unavailable" },
          { label: "Stop reason", value: stage.reason ?? "unavailable" },
        ],
        key: SIMULATION_STAGES_EXECUTION_PATH,
        owner: run ? `run:${run.run_id}` : null,
        revision: source.stageExecution.revision,
        source: source.stageExecution,
      }),
      id: `jobs:stage:${encodeId(stage.stage_id)}`,
      kind: "stage",
      label: stage.label ?? `Stage ${stage.index + 1}`,
      state: executionNodeState(stage.status, source.stageExecution),
    });
  }

  const details = new Map((source.commandDetails.data ?? []).map((entry) => [entry.command_id, entry]));
  for (const command of [...(source.commandQueue.data?.commands ?? [])].sort((left, right) => left.seq - right.seq)) {
    const commandDetail = details.get(command.command_id);
    descriptors.push({
      detail: detail({
        category: "job",
        facts: [
          { label: "Command", value: command.kind },
          { label: "Sequence", value: String(command.seq) },
          { label: "Completion", value: command.completion_status ?? "unavailable" },
        ],
        key: SIMULATION_COMMAND_DETAIL_PATH,
        message: command.error ?? command.reason ?? source.commandDetails.error,
        owner: commandDetail?.run_id ? `run:${commandDetail.run_id}` : null,
        requestedExecution: executionDetail(commandDetail?.requested_execution),
        resolvedExecution: executionDetail(commandDetail?.resolved_execution),
        revision: commandDetail?.seq ?? command.seq,
        source: source.commandQueue,
      }),
      id: `jobs:command:${encodeId(command.command_id)}`,
      kind: "command",
      label: `${command.kind} · ${command.command_id}`,
      state: executionNodeState(command.status, source.commandQueue),
    });
  }
  return descriptors;
}

function diagnosticDescriptors(source: RuntimeExplorerSourceSnapshot): RuntimeDiagnosticDescriptor[] {
  const run = source.currentRun.data;
  const sessionOwner = source.sessionStatus.data
    ? `session:${source.sessionStatus.data.session.session_id}`
    : run
      ? `session:${run.session_id}`
      : null;
  const geometry = source.geometryValidation.data;
  const health = source.platformHealth.data;
  const capabilities = source.platformCapabilities.data;
  const solver = source.solverStatus.data;
  const mesh = source.meshManifest.data;
  const frequency = source.frequencyDomainManifest.data;
  const profile = source.solverProfile.data;

  return [
    diagnosticDescriptor("problem", "Problem", MODEL_GEOMETRY_VALIDATION_PATH, source.geometryValidation, sessionOwner, geometry
      ? [
          { label: "Status", value: geometry.status },
          { label: "Backend", value: geometry.backend_target },
          { label: "Problems", value: String(geometry.diagnostics.length) },
        ]
      : [], geometry?.diagnostics.find((entry) => entry.severity === "error")?.message ?? null),
    diagnosticDescriptor("health", "Health", PLATFORM_HEALTH_PATH, source.platformHealth, "platform", health
      ? [
          { label: "Status", value: health.status },
          { label: "Active session", value: String(health.active_session) },
          { label: "Uptime", value: `${health.uptime_seconds} s` },
        ]
      : []),
    diagnosticDescriptor("capability", "Capabilities", PLATFORM_CAPABILITIES_PATH, source.platformCapabilities, "platform", capabilities
      ? [
          { label: "Profile", value: capabilities.profile_version },
          { label: "Engines", value: String(capabilities.engines.length) },
        ]
      : []),
    diagnosticDescriptor("solver", "Solver", SIMULATION_SOLVER_STATUS_PATH, source.solverStatus, solver?.run_id ? `run:${solver.run_id}` : run ? `run:${run.run_id}` : null, solver
      ? [
          { label: "Runtime", value: solver.runtime_state },
          { label: "Status", value: solver.runtime_status_kind },
          { label: "Warnings", value: String(solver.warnings.length) },
        ]
      : [], solver?.last_error ?? null),
    diagnosticDescriptor("mesh", "Mesh", MESHING_SHARED_DOMAIN_MANIFEST_PATH, source.meshManifest, mesh ? `mesh:${mesh.mesh_id}` : sessionOwner, mesh
      ? [
          { label: "Mesh", value: mesh.mesh_name },
          { label: "Generation", value: mesh.generation_id ?? "unavailable" },
          { label: "Fingerprint", value: mesh.topology_fingerprint },
        ]
      : []),
    diagnosticDescriptor("frequency-domain", "Frequency Domain", ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH, source.frequencyDomainManifest, run ? `run:${run.run_id}` : null, frequency
      ? [
          { label: "Schema", value: frequency.schema_version },
          { label: "Modal solver", value: String(frequency.eigenmodes.modal_solver_available) },
          { label: "Driven response", value: String(frequency.response.driven_response_available) },
        ]
      : []),
    diagnosticDescriptor("performance", "Performance", DIAGNOSTICS_SOLVER_PROFILE_PATH, source.solverProfile, run ? `run:${run.run_id}` : null, profile
      ? [
          { label: "State", value: profile.state },
          { label: "Samples", value: String(profile.latest_samples.length) },
          {
            label: "Persistence failed",
            value: profile.persistence_failed === undefined
              ? "unavailable"
              : String(profile.persistence_failed),
          },
        ]
      : []),
  ];
}

function diagnosticDescriptor<T>(
  kind: RuntimeDiagnosticDescriptor["kind"],
  label: string,
  key: string,
  source: RuntimeResourceSnapshot<T>,
  owner: string | null,
  facts: RuntimeExplorerDetail["facts"],
  message: string | null = null,
): RuntimeDiagnosticDescriptor {
  return {
    detail: detail({
      category: "diagnostic",
      facts,
      key,
      message: message ?? source.error ?? (source.status === "ready" && source.data === null
        ? `${label} resource is unavailable.`
        : null),
      owner,
      revision: source.revision,
      source,
    }),
    id: `diagnostics:${kind}`,
    kind,
    label,
    state: resourceNodeState(source),
  };
}

function detail<T>({
  category,
  facts = [],
  generation = null,
  key,
  location = null,
  message = null,
  owner = null,
  requestedExecution = null,
  resolvedExecution = null,
  revision = null,
  schema = null,
  source,
}: {
  category: RuntimeExplorerDetail["category"];
  facts?: RuntimeExplorerDetail["facts"];
  generation?: string | null;
  key: string;
  location?: string | null;
  message?: string | null;
  owner?: string | null;
  requestedExecution?: RuntimeExecutionDetail | null;
  resolvedExecution?: RuntimeExecutionDetail | null;
  revision?: ResourceRevision | null;
  schema?: string | null;
  source: RuntimeResourceSnapshot<T>;
}): RuntimeExplorerDetail {
  return {
    cache: null,
    category,
    contractGap: source.missing || (source.status === "ready" && source.data === null),
    facts,
    generation,
    key,
    location,
    message,
    owner,
    requestedExecution,
    resolvedExecution,
    revision,
    schema,
    sizeBytes: null,
    sourceStatus: source.status === "ready" && source.data === null
      ? "unavailable"
      : source.status,
  };
}

function executionDetail(input: {
  backend?: string | null;
  device?: string | null;
  engine_id?: string | null;
  mode?: string | null;
  precision?: string | null;
  runtime_family?: string | null;
  worker?: string | null;
} | null | undefined): RuntimeExecutionDetail | null {
  if (!input) return null;
  return {
    backend: input.backend ?? null,
    device: input.device ?? null,
    engineId: input.engine_id ?? null,
    mode: input.mode ?? null,
    precision: input.precision ?? null,
    runtimeFamily: input.runtime_family ?? null,
    worker: input.worker ?? null,
  };
}

function resourceNodeState<T>(source: RuntimeResourceSnapshot<T>): RuntimeNodeState {
  if (source.missing) {
    return { availability: "unavailable", executionState: "not_started", resourceState: "error", status: "unavailable" };
  }
  if (source.status === "error") {
    return { availability: "unavailable", executionState: "failed", resourceState: "error", status: "failed" };
  }
  if (source.status === "stale") {
    return { availability: source.data ? "partial" : "unavailable", executionState: "not_started", resourceState: "stale", status: "stale" };
  }
  if (source.status === "loading") {
    return { availability: "unavailable", executionState: "not_started", resourceState: "loading", status: "unavailable" };
  }
  if (source.status === "idle" || source.data === null) {
    return { availability: "unavailable", executionState: "not_started", resourceState: source.status, status: "unavailable" };
  }
  return { availability: "available", executionState: "not_started", resourceState: "ready", status: "ready" };
}

function executionNodeState(status: string, source: RuntimeResourceSnapshot<unknown>): RuntimeNodeState {
  if (source.status === "error") return resourceNodeState(source);
  if (source.status === "stale") return resourceNodeState(source);
  const normalized = status.trim().toLowerCase();
  const executionState: ExplorerExecutionState =
    normalized === "queued" || normalized === "pending" || normalized === "accepted"
      ? "queued"
      : normalized === "running" || normalized === "dispatched"
        ? "running"
        : normalized === "paused"
          ? "paused"
          : normalized === "completed" || normalized === "complete" || normalized === "succeeded" || normalized === "ready"
            ? "completed"
            : normalized === "cancelled" || normalized === "canceled" || normalized === "cancel_requested"
              ? "cancelled"
              : normalized === "failed" || normalized === "rejected" || normalized === "error"
                ? "failed"
                : "not_started";
  const nodeStatus: ExplorerNodeStatus = executionState === "not_started" ? "unavailable" : executionState;
  return {
    availability: executionState === "not_started" ? "unavailable" : "available",
    executionState,
    resourceState: source.status,
    status: nodeStatus,
  };
}

function encodeId(value: string): string {
  return encodeURIComponent(value);
}
