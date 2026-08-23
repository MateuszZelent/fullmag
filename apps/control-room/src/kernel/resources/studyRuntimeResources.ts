"use client";

import { useCallback, useEffect, useMemo } from "react";

import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DIAGNOSTICS_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
  ANALYSIS_EIGEN_MODE_V2_PATH,
  ANALYSIS_FREQUENCY_RESPONSE_MAGNETIC_SWEEP_V1_PATH,
  ANALYSIS_HYSTERESIS_POINTS_PATH,
  ANALYSIS_HYSTERESIS_METRICS_PATH,
  ANALYSIS_HYSTERESIS_SATURATION_PATH,
  ANALYSIS_HYSTERESIS_ADAPTIVE_REFINEMENT_PATH,
  ANALYSIS_HYSTERESIS_BOOKMARKS_PATH,
  ANALYSIS_HYSTERESIS_BRANCHES_PATH,
  ANALYSIS_HYSTERESIS_FAMILY_PATH,
  ANALYSIS_HYSTERESIS_MINOR_LOOPS_PATH,
  ANALYSIS_HYSTERESIS_POINT_PATH,
  ANALYSIS_HYSTERESIS_REVERSAL_FIELDS_PATH,
  ANALYSIS_HYSTERESIS_STAGE_SETTLE_TRACE_PATH,
  ANALYSIS_HYSTERESIS_SETTLE_TRACE_PATH,
  ANALYSIS_OBJECT_TOPOLOGICAL_CHARGE_PATH,
  DATA_FIELD_META_PATH,
  DATA_ARTIFACTS_PATH,
  DATA_FIELDS_PATH,
  DATA_QUANTITIES_PATH,
  DATA_SCALARS_PATH,
  DATA_TABLE_COLUMNS_PATH,
  DATA_TABLE_PATH,
  DATA_TABLE_ROWS_PATH,
  DATA_TABLES_PATH,
  DIAGNOSTICS_CPU_PATH,
  DIAGNOSTICS_ENGINE_LOG_PATH,
  DIAGNOSTICS_GPU_PATH,
  DIAGNOSTICS_SOLVER_PROFILE_PATH,
  MESHING_PERIODIC_PAIRS_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MESHING_BUILDS_CURRENT_PATH,
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  MESHING_SUMMARY_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_READINESS_PATH,
  MODEL_SCENE_PATH,
  PERSISTENCE_CHECKPOINT_PATH,
  PERSISTENCE_CHECKPOINTS_PATH,
  SIMULATION_COMMAND_DETAIL_PATH,
  SIMULATION_COMMANDS_PATH,
  SIMULATION_OBJECT_METRICS_PATH,
  SIMULATION_RUN_CURRENT_PATH,
  SIMULATION_RUN_PATH,
  SIMULATION_STAGE_HYSTERESIS_EXECUTION_TREE_PATH,
  SIMULATION_STAGE_HYSTERESIS_ORIENTATION_PATH,
  SIMULATION_STAGE_HYSTERESIS_PLAN_PATH,
  SIMULATION_STAGE_HYSTERESIS_PROGRESS_PATH,
  SIMULATION_STAGE_HYSTERESIS_PROTOCOL_PATH,
  SIMULATION_STAGE_HYSTERESIS_SATURATION_PATH,
  SIMULATION_STAGE_HYSTERESIS_SETTLE_PIPELINE_PATH,
  SIMULATION_SOLVER_ENERGIES_CURRENT_PATH,
  SIMULATION_SOLVER_ENERGIES_HISTORY_PATH,
  SIMULATION_SOLVER_STATUS_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
} from "../api/apiPaths";
import { ControlRoomApiError } from "../api/ControlRoomApi";
import type {
  BinaryResourceResult,
  ArtifactResource,
  CommandQueueStatusResource,
  CommandDetailResource,
  CheckpointEntry,
  CheckpointListResource,
  CurrentRunResource,
  EngineLogResource,
  FieldCatalogResource,
  QuantityCatalogResource,
  FieldMetaResource,
  FieldMetaQuery,
  CpuTelemetryResource,
  GpuTelemetryResource,
  LiveStatusResource,
  FrequencyDomainFieldResource,
  FrequencyDomainJsonArtifactResource,
  FrequencyDomainManifestResource,
  FrequencyDomainSweepProgressResource,
  FrequencyDomainTextArtifactResource,
  JsonValue,
  MagneticResponseSweepResource,
  MeshPeriodicPairsResource,
  ModelReadinessResource,
  ObjectMetricsResource,
  SolverEnergyCurrentResource,
  SolverEnergyHistoryResource,
  SolverProfileResource,
  SolverStatusResource,
  StageExecutionResource,
  ScalarWindowQuery,
  ScalarWindowResource,
  TableColumnMeta,
  TableListResource,
  TableResource,
  TableRowsQuery,
  TableRowsResource,
  HysteresisAdaptiveRefinementResource,
  HysteresisAngularFamilyResource,
  HysteresisBookmarksResource,
  HysteresisBranchesResource,
  HysteresisBranchSchema,
  HysteresisMinorLoopsResource,
  HysteresisMinorLoopSchema,
  HysteresisPointSchema,
  HysteresisPointsResource,
  HysteresisMetricsResource,
  HysteresisReversalFieldsResource,
  HysteresisExecutionTreeResource,
  HysteresisOrientationSchema,
  HysteresisProgressSchema,
  HysteresisProtocolSchema,
  HysteresisSaturationResource,
  HysteresisSettlePipelineSchema,
  HysteresisSettleTraceEntrySchema,
  HysteresisSettleTraceResource,
  HysteresisStagePlanSchema,
  HysteresisStageSaturationSchema,
  TopologicalChargeQuery,
  TopologicalChargeResource,
} from "../api/apiTypes";
import { normalizeQuantityIdOrDefault } from "../api/quantityIds";
import type { DecodedTableRows } from "../api/codecs";
import { useKernel } from "../KernelContext";
import {
  createSolverTraceObserver,
  solverTraceNow,
} from "../diagnostics/solverTrace";
import { tableRowsMinRefetchIntervalMs } from "../realtime/communicationPolicy";

import {
  useGeometryValidationResource,
  useMeshBuildCurrent,
  useMeshBuildLatestSuccessful,
  useMeshSharedDomainManifestResource,
  useMeshSummaryResource,
  useSceneResource,
} from "./geometryLifecycleResources";
import {
  SESSION_STATUS_RESOURCE_KEY,
  useSessionStatusSelector,
} from "./useSessionStatus";
import { emitResourceLoadFailed } from "./resourceLoadFailure";
import { useResource } from "./useResource";

/** Browser trace state is bounded and mutates only on sampled profile events. */
export const solverTraceObserver = createSolverTraceObserver();

function ignoreMissingResource<T>(error: unknown): T | null {
  if (error instanceof ControlRoomApiError && error.status === 404) {
    return null;
  }
  throw error;
}

function ignoreMissingFieldMetaResource<T>({
  bus,
  error,
  resourceKey,
}: {
  bus: ReturnType<typeof useKernel>["bus"];
  error: unknown;
  resourceKey: string;
}): T | null {
  if (error instanceof ControlRoomApiError && error.status === 404) {
    emitResourceLoadFailed({
      bus,
      error,
      resourceKey,
      revision: null,
      situation: "Loading field metadata for the selected quantity",
    });
    return null;
  }
  throw error;
}

interface RuntimeResourceOptions {
  enabled?: boolean;
}

interface RuntimeCommandControlResourceOptions extends RuntimeResourceOptions {
  includeSharedDomainReadiness?: boolean;
  includeStageExecution?: boolean;
}

export const STUDY_RUNTIME_CONTROL_RESOURCE_KEYS = [
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MESHING_BUILDS_CURRENT_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_READINESS_PATH,
  SESSION_STATUS_RESOURCE_KEY,
  SIMULATION_COMMANDS_PATH,
  SIMULATION_SOLVER_STATUS_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
] as const;

const RUNTIME_COMMAND_CONTROL_STATUS_RESOURCE_KEYS = [
  "command_completion_revision",
  "commands_revision",
  "domain_generation_id",
  "mesh_build_revision",
  "mesh_revision",
  "scene_revision",
  "stages_revision",
] as const satisfies ReadonlyArray<keyof LiveStatusResource["resources"]>;

type StudyRuntimeCommandSessionStatus = {
  capabilities: Pick<
    LiveStatusResource["capabilities"],
    "binary_fields" | "explicit_topology"
  >;
  domain: Pick<LiveStatusResource["domain"], "discretization">;
  resources: Pick<
    LiveStatusResource["resources"],
    | "artifact_revision"
    | "artifacts_revision"
    | "command_completion_revision"
    | "commands_revision"
    | "domain_generation_id"
    | "mesh_build_revision"
    | "mesh_revision"
    | "scene_revision"
    | "stages_revision"
  >;
  run: Pick<NonNullable<LiveStatusResource["run"]>, "run_id"> | null;
  session: Pick<LiveStatusResource["session"], "session_epoch" | "session_id">;
};

export function selectStudyRuntimeCommandSessionStatus(status: {
  data: LiveStatusResource | null;
}): StudyRuntimeCommandSessionStatus | null {
  if (!status.data) return null;
  return {
    capabilities: {
      binary_fields: status.data.capabilities.binary_fields,
      explicit_topology: status.data.capabilities.explicit_topology,
    },
    domain: {
      discretization: status.data.domain.discretization,
    },
    resources: {
      artifact_revision: status.data.resources.artifact_revision,
      artifacts_revision: status.data.resources.artifacts_revision,
      command_completion_revision:
        status.data.resources.command_completion_revision,
      commands_revision: status.data.resources.commands_revision,
      domain_generation_id: status.data.resources.domain_generation_id,
      mesh_build_revision: status.data.resources.mesh_build_revision,
      mesh_revision: status.data.resources.mesh_revision,
      scene_revision: status.data.resources.scene_revision,
      stages_revision: status.data.resources.stages_revision,
    },
    run: status.data.run ? { run_id: status.data.run.run_id } : null,
    session: {
      session_epoch: status.data.session.session_epoch,
      session_id: status.data.session.session_id,
    },
  };
}

export function studyRuntimeCommandSessionStatusEquals(
  previous: StudyRuntimeCommandSessionStatus | null,
  next: StudyRuntimeCommandSessionStatus | null,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;
  return (
    previous.capabilities.binary_fields === next.capabilities.binary_fields &&
    previous.capabilities.explicit_topology ===
      next.capabilities.explicit_topology &&
    previous.domain.discretization === next.domain.discretization &&
    previous.resources.artifact_revision === next.resources.artifact_revision &&
    previous.resources.artifacts_revision === next.resources.artifacts_revision &&
    previous.resources.command_completion_revision ===
      next.resources.command_completion_revision &&
    previous.resources.commands_revision === next.resources.commands_revision &&
    previous.resources.domain_generation_id ===
      next.resources.domain_generation_id &&
    previous.resources.mesh_build_revision ===
      next.resources.mesh_build_revision &&
    previous.resources.mesh_revision === next.resources.mesh_revision &&
    previous.resources.scene_revision === next.resources.scene_revision &&
    previous.resources.stages_revision === next.resources.stages_revision &&
    previous.run?.run_id === next.run?.run_id &&
    previous.session.session_id === next.session.session_id &&
    previous.session.session_epoch === next.session.session_epoch
  );
}

export function selectRuntimeCommandControlSessionStatus(status: {
  data: LiveStatusResource | null;
}): LiveStatusResource | null {
  return status.data;
}

export function runtimeCommandControlSessionStatusEquals(
  previous: LiveStatusResource | null,
  next: LiveStatusResource | null,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;
  if (previous.capabilities.binary_fields !== next.capabilities.binary_fields) {
    return false;
  }
  if (
    previous.capabilities.explicit_topology !==
    next.capabilities.explicit_topology
  ) {
    return false;
  }
  if (previous.domain.discretization !== next.domain.discretization) {
    return false;
  }
  if (previous.session.session_id !== next.session.session_id) {
    return false;
  }
  if (previous.session.session_epoch !== next.session.session_epoch) {
    return false;
  }
  if (previous.run?.run_id !== next.run?.run_id) {
    return false;
  }

  return RUNTIME_COMMAND_CONTROL_STATUS_RESOURCE_KEYS.every(
    (key) => previous.resources[key] === next.resources[key],
  );
}

export function shouldLoadRuntimeStageExecution(
  enabled: boolean,
  status:
    | {
        resources: Pick<
          LiveStatusResource["resources"],
          "stages_revision"
        >;
      }
    | null
    | undefined,
): boolean {
  if (!enabled) return false;
  return hasPositiveRevision(status?.resources.stages_revision);
}

export function shouldLoadRuntimeCommandQueue(
  enabled: boolean,
  status:
    | {
        resources: Pick<
          LiveStatusResource["resources"],
          "commands_revision"
        >;
      }
    | null
    | undefined,
): boolean {
  if (!enabled) return false;
  return hasPositiveRevision(status?.resources.commands_revision);
}

export function shouldLoadRuntimeMeshBuild(
  enabled: boolean,
  status:
    | {
        resources: Pick<
          LiveStatusResource["resources"],
          "mesh_build_revision"
        >;
      }
    | null
    | undefined,
): boolean {
  if (!enabled) return false;
  return hasPositiveRevision(status?.resources.mesh_build_revision);
}

export function shouldLoadRuntimeMeshSummary(
  enabled: boolean,
  status:
    | {
        resources: Pick<
          LiveStatusResource["resources"],
          "mesh_build_revision" | "mesh_revision"
        >;
      }
    | null
    | undefined,
): boolean {
  if (!enabled) return false;
  return (
    hasPositiveRevision(status?.resources.mesh_revision) ||
    hasPositiveRevision(status?.resources.mesh_build_revision)
  );
}

export function shouldLoadRuntimeMeshManifest(
  enabled: boolean,
  status:
    | {
        capabilities: Pick<
          LiveStatusResource["capabilities"],
          "explicit_topology"
        >;
        domain: Pick<LiveStatusResource["domain"], "discretization">;
        resources: Pick<LiveStatusResource["resources"], "mesh_revision"> &
          Partial<
            Pick<LiveStatusResource["resources"], "domain_generation_id">
          >;
      }
    | null
    | undefined,
): boolean {
  if (!enabled || !status) return false;
  const requiresSharedDomain =
    status.capabilities.explicit_topology ||
    status.domain.discretization.toLowerCase() === "fem";
  return (
    requiresSharedDomain &&
    (hasPositiveRevision(status.resources.mesh_revision) ||
      hasPositiveRevision(status.resources.domain_generation_id))
  );
}

export function shouldLoadRuntimeCurrentRun(
  enabled: boolean,
  status: { run?: unknown | null } | null | undefined,
): boolean {
  if (!enabled) return false;
  return status?.run != null;
}

export function shouldLoadRuntimeScalars(
  enabled: boolean,
  status:
    | {
        resources: Pick<
          LiveStatusResource["resources"],
          "scalars_revision"
        >;
      }
    | null
    | undefined,
): boolean {
  if (!enabled) return false;
  return hasPositiveRevision(status?.resources.scalars_revision);
}

export function shouldLoadFrequencyDomainManifest(
  enabled: boolean,
  status:
    | {
        resources: Pick<
          LiveStatusResource["resources"],
          "artifact_revision" | "artifacts_revision" | "stages_revision"
        >;
      }
    | null
    | undefined,
): boolean {
  if (!enabled) return false;
  return (
    hasPositiveRevision(status?.resources.artifact_revision) ||
    hasPositiveRevision(status?.resources.artifacts_revision) ||
    hasPositiveRevision(status?.resources.stages_revision)
  );
}

export function frequencyDomainManifestRevision(
  data: FrequencyDomainManifestResource | null,
): string | null {
  if (!data) return null;
  const progress = data.response_progress;
  const cancelRequested = data.response_cancel_requested;
  const resultManifest = data.result_manifest;
  return [
    data.schema_version,
    data.response.status,
    data.eigenmodes.status,
    progress
      ? `progress:${frequencyDomainSweepProgressRevision(progress)}`
      : "progress:null",
    cancelRequested
      ? `cancel:${frequencyDomainSweepProgressRevision(cancelRequested)}`
      : "cancel:null",
    resultManifest
      ? `result:${resultManifest.status}:${resultManifest.artifact_path}:${resultManifest.resource_key}`
      : "result:null",
  ].join("|");
}

export function frequencyDomainSweepProgressRevision(
  data: FrequencyDomainSweepProgressResource | null,
): string | null {
  return data
    ? [
        data.status,
        data.complete,
        data.completed_frequency_points,
        data.total_frequency_points,
        data.current_frequency_hz,
        data.frequency_min_hz,
        data.frequency_max_hz,
        data.demag_mode,
        data.progress_json,
        data.written_frequency_point_artifacts,
        data.partial_artifacts_available,
        data.latest_artifact_manifest_path,
      ].join(":")
    : null;
}

export function frequencyDomainTextArtifactRevision(
  data: FrequencyDomainTextArtifactResource | null,
): string | null {
  if (!data) return null;
  const text = data.text ?? "";
  let checksum = 0;
  for (let index = 0; index < text.length; index += 1) {
    checksum = Math.imul(31, checksum) + text.charCodeAt(index);
    checksum >>>= 0;
  }
  return [
    data.schema_version,
    data.status,
    data.artifact_path,
    data.resource_key,
    data.content_type,
    data.path_metadata == null ? "" : JSON.stringify(data.path_metadata),
    data.missing_reason ?? "",
    text.length,
    checksum.toString(16),
  ].join("|");
}

function hasPositiveRevision(
  revision: number | string | null | undefined,
): boolean {
  return (
    (typeof revision === "number" && revision > 0) ||
    (typeof revision === "string" && /^[1-9]\d*$/.test(revision))
  );
}

export function useCommandQueueResource({
  enabled = true,
}: RuntimeResourceOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.commands.list({ signal }),
    [api],
  );

  return useResource<CommandQueueStatusResource>({
    enabled,
    load,
    resolveRevision: (data) => data.revision,
    resourceKey: SIMULATION_COMMANDS_PATH,
  });
}

export function useCommandDetailResource(
  commandId: string | null | undefined,
) {
  const { api } = useKernel();
  const resourceKey = commandId
    ? SIMULATION_COMMAND_DETAIL_PATH.replace("{command_id}", commandId)
    : `${SIMULATION_COMMANDS_PATH}:none`;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      commandId
        ? api.commands
            .detail(commandId, { signal })
            .catch(ignoreMissingResource<CommandDetailResource>)
        : Promise.resolve(null),
    [api, commandId],
  );

  return useResource<CommandDetailResource | null>({
    enabled: Boolean(commandId),
    load,
    resolveRevision: (data) => data?.seq ?? null,
    resourceKey,
  });
}

export function useCurrentRunResource({
  enabled = true,
}: RuntimeResourceOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.simulation
        .currentRun({ signal })
        .catch(ignoreMissingResource<CurrentRunResource>),
    [api],
  );

  return useResource<CurrentRunResource | null>({
    enabled,
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey: SIMULATION_RUN_CURRENT_PATH,
  });
}

export function useResultContextRunResource(
  runId: string | null | undefined,
  { enabled = true }: RuntimeResourceOptions = {},
) {
  const { api } = useKernel();
  const resourceKey = runId
    ? SIMULATION_RUN_PATH.replace("{run_id}", runId)
    : `${SIMULATION_RUN_PATH}:none`;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      runId
        ? api.simulation
            .run(runId, { signal })
            .catch(ignoreMissingResource<CurrentRunResource>)
        : Promise.resolve(null),
    [api, runId],
  );

  return useResource<CurrentRunResource | null>({
    enabled: enabled && Boolean(runId),
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey,
  });
}

export function useStageExecutionResource({
  enabled = true,
}: RuntimeResourceOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.simulation.stages
        .execution({ signal })
        .catch(ignoreMissingResource<StageExecutionResource>),
    [api],
  );

  return useResource<StageExecutionResource | null>({
    enabled,
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey: SIMULATION_STAGES_EXECUTION_PATH,
  });
}

export function useArtifactsResource({
  enabled = true,
}: RuntimeResourceOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.data.artifacts.list({ signal }),
    [api],
  );

  return useResource<ArtifactResource[]>({
    enabled,
    load,
    resolveRevision: (artifacts) => artifacts
      .map((artifact) => {
        const autosave = artifact.stage_autosave;
        return autosave
          ? `${artifact.path}:${autosave.stages.map((stage) => `${stage.stage_id}:${stage.status}:${stage.table_sample_count}:${stage.field_sample_count}`).join(",")}`
          : `${artifact.path}:${artifact.kind}`;
      })
      .join("|"),
    resourceKey: DATA_ARTIFACTS_PATH,
  });
}

export function useMeshPeriodicPairsResource({
  enabled = true,
}: RuntimeResourceOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.meshing
        .periodicPairs({ signal })
        .catch(ignoreMissingResource<MeshPeriodicPairsResource>),
    [api],
  );

  return useResource<MeshPeriodicPairsResource | null>({
    enabled,
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey: MESHING_PERIODIC_PAIRS_PATH,
  });
}

export function useHysteresisStagePlanResource(
  stageId: string | null | undefined,
  { enabled = true }: RuntimeResourceOptions = {},
) {
  const { api } = useKernel();
  const resourceKey = stageId
    ? SIMULATION_STAGE_HYSTERESIS_PLAN_PATH.replace("{stage_id}", stageId)
    : `${SIMULATION_STAGE_HYSTERESIS_PLAN_PATH}:none`;

  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      stageId
        ? api.simulation.stages.hysteresis
            .plan(stageId, { signal })
            .catch(ignoreMissingResource<HysteresisStagePlanSchema>)
        : Promise.resolve(null),
    [api, stageId],
  );

  return useResource<HysteresisStagePlanSchema | null>({
    enabled: enabled && Boolean(stageId),
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey,
  });
}

export function useHysteresisProtocolResource(
  stageId: string | null | undefined,
  { enabled = true }: RuntimeResourceOptions = {},
) {
  const { api } = useKernel();
  const resourceKey = stageId
    ? SIMULATION_STAGE_HYSTERESIS_PROTOCOL_PATH.replace("{stage_id}", stageId)
    : `${SIMULATION_STAGE_HYSTERESIS_PROTOCOL_PATH}:none`;

  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      stageId
        ? api.simulation.stages.hysteresis
            .protocol(stageId, { signal })
            .catch(ignoreMissingResource<HysteresisProtocolSchema>)
        : Promise.resolve(null),
    [api, stageId],
  );

  return useResource<HysteresisProtocolSchema | null>({
    enabled: enabled && Boolean(stageId),
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey,
  });
}

export function useHysteresisStageSaturationResource(
  stageId: string | null | undefined,
  { enabled = true }: RuntimeResourceOptions = {},
) {
  const { api } = useKernel();
  const resourceKey = stageId
    ? SIMULATION_STAGE_HYSTERESIS_SATURATION_PATH.replace(
        "{stage_id}",
        stageId,
      )
    : `${SIMULATION_STAGE_HYSTERESIS_SATURATION_PATH}:none`;

  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      stageId
        ? api.simulation.stages.hysteresis
            .saturation(stageId, { signal })
            .catch(ignoreMissingResource<HysteresisStageSaturationSchema>)
        : Promise.resolve(null),
    [api, stageId],
  );

  return useResource<HysteresisStageSaturationSchema | null>({
    enabled: enabled && Boolean(stageId),
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey,
  });
}

export function useHysteresisOrientationResource(
  stageId: string | null | undefined,
  { enabled = true }: RuntimeResourceOptions = {},
) {
  const { api } = useKernel();
  const resourceKey = stageId
    ? SIMULATION_STAGE_HYSTERESIS_ORIENTATION_PATH.replace("{stage_id}", stageId)
    : `${SIMULATION_STAGE_HYSTERESIS_ORIENTATION_PATH}:none`;

  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      stageId
        ? api.simulation.stages.hysteresis
            .orientation(stageId, { signal })
            .catch(ignoreMissingResource<HysteresisOrientationSchema>)
        : Promise.resolve(null),
    [api, stageId],
  );

  return useResource<HysteresisOrientationSchema | null>({
    enabled: enabled && Boolean(stageId),
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey,
  });
}

export function useHysteresisSettlePipelineResource(
  stageId: string | null | undefined,
  { enabled = true }: RuntimeResourceOptions = {},
) {
  const { api } = useKernel();
  const resourceKey = stageId
    ? SIMULATION_STAGE_HYSTERESIS_SETTLE_PIPELINE_PATH.replace(
        "{stage_id}",
        stageId,
      )
    : `${SIMULATION_STAGE_HYSTERESIS_SETTLE_PIPELINE_PATH}:none`;

  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      stageId
        ? api.simulation.stages.hysteresis
            .settlePipeline(stageId, { signal })
            .catch(ignoreMissingResource<HysteresisSettlePipelineSchema>)
        : Promise.resolve(null),
    [api, stageId],
  );

  return useResource<HysteresisSettlePipelineSchema | null>({
    enabled: enabled && Boolean(stageId),
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey,
  });
}

export function useHysteresisExecutionTreeResource(
  stageId: string | null | undefined,
  {
    after = 3,
    before = 2,
    enabled = true,
    include_bookmarks = true,
    include_snapshots = true,
    include_warnings = true,
    window = "active",
  }: RuntimeResourceOptions & {
    after?: number;
    before?: number;
    include_bookmarks?: boolean;
    include_snapshots?: boolean;
    include_warnings?: boolean;
    window?: string;
  } = {},
) {
  const { api } = useKernel();
  const resourceKey = stageId
    ? resolveHysteresisExecutionTreeResourceKey(stageId, {
        after,
        before,
        include_bookmarks,
        include_snapshots,
        include_warnings,
        window,
      })
    : `${SIMULATION_STAGE_HYSTERESIS_EXECUTION_TREE_PATH}:none`;

  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      stageId
        ? api.simulation.stages.hysteresis
            .executionTree(
              stageId,
              {
                after,
                before,
                include_bookmarks,
                include_snapshots,
                include_warnings,
                window,
              },
              { signal },
            )
            .catch(ignoreMissingResource<HysteresisExecutionTreeResource>)
        : Promise.resolve(null),
    [
      after,
      api,
      before,
      include_bookmarks,
      include_snapshots,
      include_warnings,
      stageId,
      window,
    ],
  );

  return useResource<HysteresisExecutionTreeResource | null>({
    enabled: enabled && Boolean(stageId),
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey,
  });
}

export function resolveHysteresisExecutionTreeResourceKey(
  stageId: string,
  query: {
    after: number;
    before: number;
    include_bookmarks: boolean;
    include_snapshots: boolean;
    include_warnings: boolean;
    window: string;
  },
): string {
  const path = SIMULATION_STAGE_HYSTERESIS_EXECUTION_TREE_PATH.replace(
    "{stage_id}",
    encodeURIComponent(stageId),
  );
  const params = [
    ["after", String(query.after)],
    ["before", String(query.before)],
    ["include_bookmarks", String(query.include_bookmarks)],
    ["include_snapshots", String(query.include_snapshots)],
    ["include_warnings", String(query.include_warnings)],
    ["window", query.window],
  ];
  return `${path}?${params
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&")}`;
}

export function useHysteresisProgressResource(
  stageId: string | null | undefined,
  { enabled = true }: RuntimeResourceOptions = {},
) {
  const { api } = useKernel();
  const resourceKey = stageId
    ? SIMULATION_STAGE_HYSTERESIS_PROGRESS_PATH.replace("{stage_id}", stageId)
    : `${SIMULATION_STAGE_HYSTERESIS_PROGRESS_PATH}:none`;

  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      stageId
        ? api.simulation.stages.hysteresis
            .progress(stageId, { signal })
            .catch(ignoreMissingResource<HysteresisProgressSchema>)
        : Promise.resolve(null),
    [api, stageId],
  );

  return useResource<HysteresisProgressSchema | null>({
    enabled: enabled && Boolean(stageId),
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey,
  });
}

export function useSolverStatusResource({
  enabled = true,
}: RuntimeResourceOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.simulation.solver
        .status({ signal })
        .catch(ignoreMissingResource<SolverStatusResource>),
    [api],
  );

  return useResource<SolverStatusResource | null>({
    enabled,
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey: SIMULATION_SOLVER_STATUS_PATH,
  });
}

export function useSolverEnergyCurrentResource({
  enabled = true,
}: RuntimeResourceOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.simulation.solver.energies
        .current({ signal })
        .catch(ignoreMissingResource<SolverEnergyCurrentResource>),
    [api],
  );

  return useResource<SolverEnergyCurrentResource | null>({
    enabled,
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey: SIMULATION_SOLVER_ENERGIES_CURRENT_PATH,
  });
}

export function useSolverEnergyHistoryResource(
  limit = 200,
  { enabled = true }: RuntimeResourceOptions = {},
) {
  const { api } = useKernel();
  const resourceKey = `${SIMULATION_SOLVER_ENERGIES_HISTORY_PATH}?limit=${limit}`;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.simulation.solver.energies
        .history(limit, { signal })
        .catch(ignoreMissingResource<SolverEnergyHistoryResource>),
    [api, limit],
  );

  return useResource<SolverEnergyHistoryResource | null>({
    enabled,
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey,
  });
}

export function useMagneticResponseSweepResource({
  enabled = true,
}: RuntimeResourceOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.analysis.frequencyResponse
        .magneticSweepV1({ signal })
        .catch(ignoreMissingResource<MagneticResponseSweepResource>),
    [api],
  );

  return useResource<MagneticResponseSweepResource | null>({
    enabled,
    load,
    resourceKey: ANALYSIS_FREQUENCY_RESPONSE_MAGNETIC_SWEEP_V1_PATH,
  });
}

export function useFrequencyDomainManifestResource({
  enabled = true,
}: RuntimeResourceOptions = {}) {
  const { api } = useKernel();
  const sessionStatus = useSessionStatusSelector(
    selectStudyRuntimeCommandSessionStatus,
    { isEqual: studyRuntimeCommandSessionStatusEquals },
  );
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.analysis.frequencyDomain
        .manifestV1({ signal })
        .catch(ignoreMissingResource<FrequencyDomainManifestResource>),
    [api],
  );

  return useResource<FrequencyDomainManifestResource | null>({
    enabled: shouldLoadFrequencyDomainManifest(enabled, sessionStatus),
    load,
    resolveRevision: frequencyDomainManifestRevision,
    resourceKey: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
  });
}

export function useFrequencyDomainEigenSpectrumResource({
  enabled = true,
}: RuntimeResourceOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.analysis.frequencyDomain.eigenSpectrumV2({ signal }),
    [api],
  );
  return useFrequencyDomainJsonResource(
    ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
    load,
    enabled,
  );
}

export function useFrequencyDomainEigenBranchesResource({
  enabled = true,
}: RuntimeResourceOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.analysis.frequencyDomain.eigenBranchesV2({ signal }),
    [api],
  );
  return useFrequencyDomainJsonResource(
    ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
    load,
    enabled,
  );
}

export function useFrequencyDomainEigenDiagnosticsResource({
  enabled = true,
}: RuntimeResourceOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.analysis.frequencyDomain.eigenDiagnosticsV2({ signal }),
    [api],
  );
  return useFrequencyDomainJsonResource(
    ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DIAGNOSTICS_V2_PATH,
    load,
    enabled,
  );
}

export function useFrequencyDomainEigenDispersionResource({
  enabled = true,
}: RuntimeResourceOptions = {}) {
  const { api } = useKernel();
  const sessionStatus = useSessionStatusSelector(
    selectStudyRuntimeCommandSessionStatus,
    { isEqual: studyRuntimeCommandSessionStatusEquals },
  );
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.analysis.frequencyDomain.eigenDispersion({ signal }),
    [api],
  );
  return useResource<FrequencyDomainTextArtifactResource | null>({
    enabled: shouldLoadFrequencyDomainManifest(enabled, sessionStatus),
    load,
    resolveRevision: frequencyDomainTextArtifactRevision,
    resourceKey: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
  });
}

export function useFrequencyDomainEigenModeResource(
  sampleIndex: number | null | undefined,
  modeIndex: number | null | undefined,
  { enabled = true }: RuntimeResourceOptions = {},
) {
  const { api } = useKernel();
  const sessionStatus = useSessionStatusSelector(
    selectStudyRuntimeCommandSessionStatus,
    { isEqual: studyRuntimeCommandSessionStatusEquals },
  );
  const resourceKey =
    sampleIndex != null && modeIndex != null
      ? ANALYSIS_EIGEN_MODE_V2_PATH
          .replace("{sample_index}", String(sampleIndex))
          .replace("{mode_index}", String(modeIndex))
      : `${ANALYSIS_EIGEN_MODE_V2_PATH}:none`;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      sampleIndex != null && modeIndex != null
        ? api.analysis.eigen
            .modeV2(sampleIndex, modeIndex, { signal })
            .catch(ignoreMissingResource<JsonValue>)
        : Promise.resolve(null),
    [api, modeIndex, sampleIndex],
  );
  return useResource<JsonValue | null>({
    enabled:
      sampleIndex != null &&
      modeIndex != null &&
      shouldLoadFrequencyDomainManifest(enabled, sessionStatus),
    load,
    resolveRevision: (data) =>
      data && typeof data === "object" && !Array.isArray(data)
        ? String(data.schema_version ?? data.revision ?? resourceKey)
        : null,
    resourceKey,
  });
}

export function useFrequencyDomainResponseSweepResource({
  enabled = true,
}: RuntimeResourceOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.analysis.frequencyDomain.responseMagneticSweep({ signal }),
    [api],
  );
  return useFrequencyDomainJsonResource(
    ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    load,
    enabled,
  );
}

export function useMagneticResponseSweepV2Resource(
  options: RuntimeResourceOptions = {},
) {
  return useFrequencyDomainResponseSweepResource(options);
}

export function useFrequencyDomainResponseProgressResource({
  enabled = true,
}: RuntimeResourceOptions = {}) {
  const { api } = useKernel();
  const sessionStatus = useSessionStatusSelector(
    selectStudyRuntimeCommandSessionStatus,
    { isEqual: studyRuntimeCommandSessionStatusEquals },
  );
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.analysis.frequencyDomain.responseProgressV1({ signal }),
    [api],
  );
  return useResource<FrequencyDomainSweepProgressResource | null>({
    enabled: shouldLoadFrequencyDomainManifest(enabled, sessionStatus),
    load,
    resolveRevision: frequencyDomainSweepProgressRevision,
    resourceKey: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
  });
}

export function useFrequencyDomainResponseCancelRequestedResource({
  enabled = true,
}: RuntimeResourceOptions = {}) {
  const { api } = useKernel();
  const sessionStatus = useSessionStatusSelector(
    selectStudyRuntimeCommandSessionStatus,
    { isEqual: studyRuntimeCommandSessionStatusEquals },
  );
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.analysis.frequencyDomain
        .responseCancelRequestedV1({ signal })
        .catch(ignoreMissingResource<FrequencyDomainSweepProgressResource>),
    [api],
  );
  return useResource<FrequencyDomainSweepProgressResource | null>({
    enabled: shouldLoadFrequencyDomainManifest(enabled, sessionStatus),
    load,
    resolveRevision: frequencyDomainSweepProgressRevision,
    resourceKey: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
  });
}

export function useFrequencyDomainResponseDiagnosticsResource({
  enabled = true,
}: RuntimeResourceOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.analysis.frequencyDomain.responseDiagnosticsV1({ signal }),
    [api],
  );
  return useFrequencyDomainJsonResource(
    ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
    load,
    enabled,
  );
}

export function useFrequencyDomainEigenModeFieldMetaResource(
  sampleIndex: number | null | undefined,
  modeIndex: number | null | undefined,
  { enabled = true }: RuntimeResourceOptions = {},
) {
  const { api } = useKernel();
  const sessionStatus = useSessionStatusSelector(
    selectStudyRuntimeCommandSessionStatus,
    { isEqual: studyRuntimeCommandSessionStatusEquals },
  );
  const resourceKey =
    sampleIndex != null && modeIndex != null
      ? ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH
          .replace("{sample_index}", String(sampleIndex))
          .replace("{mode_index}", String(modeIndex))
      : `${ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH}:none`;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      sampleIndex != null && modeIndex != null
        ? api.analysis.frequencyDomain.eigenModeFieldMeta(
            sampleIndex,
            modeIndex,
            {
              signal,
            },
          )
        : Promise.resolve(null),
    [api, modeIndex, sampleIndex],
  );
  return useResource<FrequencyDomainFieldResource | null>({
    enabled:
      sampleIndex != null &&
      modeIndex != null &&
      shouldLoadFrequencyDomainManifest(enabled, sessionStatus),
    load,
    resolveRevision: (data) => data ? `${data.status}:${data.artifact_path}` : null,
    resourceKey,
  });
}

export function useFrequencyDomainResponseFrequencyPointResource(
  frequencyIndex: number | null | undefined,
  { enabled = true }: RuntimeResourceOptions = {},
) {
  const { api } = useKernel();
  const resourceKey =
    frequencyIndex != null
      ? ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH.replace(
          "{frequency_index}",
          String(frequencyIndex),
        )
      : `${ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH}:none`;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      frequencyIndex != null
        ? api.analysis.frequencyDomain.responseFrequencyPoint(frequencyIndex, {
            signal,
          })
        : Promise.resolve(null),
    [api, frequencyIndex],
  );
  return useFrequencyDomainIndexedJsonResource(resourceKey, load, enabled);
}

export function useFrequencyResponsePointResource(
  frequencyIndex: number | null | undefined,
  options: RuntimeResourceOptions = {},
) {
  return useFrequencyDomainResponseFrequencyPointResource(frequencyIndex, options);
}

export function useFrequencyDomainResponseFieldMetaResource(
  frequencyIndex: number | null | undefined,
  { enabled = true }: RuntimeResourceOptions = {},
) {
  const { api } = useKernel();
  const sessionStatus = useSessionStatusSelector(
    selectStudyRuntimeCommandSessionStatus,
    { isEqual: studyRuntimeCommandSessionStatusEquals },
  );
  const resourceKey =
    frequencyIndex != null
      ? ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH.replace(
          "{frequency_index}",
          String(frequencyIndex),
        )
      : `${ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH}:none`;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      frequencyIndex != null
        ? api.analysis.frequencyDomain.responseFieldMeta(frequencyIndex, { signal })
        : Promise.resolve(null),
    [api, frequencyIndex],
  );
  return useResource<FrequencyDomainFieldResource | null>({
    enabled:
      frequencyIndex != null &&
      shouldLoadFrequencyDomainManifest(enabled, sessionStatus),
    load,
    resolveRevision: (data) => data ? `${data.status}:${data.artifact_path}` : null,
    resourceKey,
  });
}

export function useFrequencyResponseFieldMetaResource(
  frequencyIndex: number | null | undefined,
  options: RuntimeResourceOptions = {},
) {
  return useFrequencyDomainResponseFieldMetaResource(frequencyIndex, options);
}

function useFrequencyDomainJsonResource(
  resourceKey: string,
  load: (context: { signal: AbortSignal }) => Promise<FrequencyDomainJsonArtifactResource>,
  enabled: boolean,
) {
  const sessionStatus = useSessionStatusSelector(
    selectStudyRuntimeCommandSessionStatus,
    { isEqual: studyRuntimeCommandSessionStatusEquals },
  );
  return useResource<FrequencyDomainJsonArtifactResource | null>({
    enabled: shouldLoadFrequencyDomainManifest(enabled, sessionStatus),
    load,
    resolveRevision: (data) => data ? `${data.status}:${data.artifact_path}` : null,
    resourceKey,
  });
}

function useFrequencyDomainIndexedJsonResource(
  resourceKey: string,
  load: (context: { signal: AbortSignal }) => Promise<FrequencyDomainJsonArtifactResource | null>,
  enabled: boolean,
) {
  const sessionStatus = useSessionStatusSelector(
    selectStudyRuntimeCommandSessionStatus,
    { isEqual: studyRuntimeCommandSessionStatusEquals },
  );
  return useResource<FrequencyDomainJsonArtifactResource | null>({
    enabled: shouldLoadFrequencyDomainManifest(enabled, sessionStatus),
    load,
    resolveRevision: (data) => data ? `${data.status}:${data.artifact_path}` : null,
    resourceKey,
  });
}

export function useHysteresisPointsResource(
  stageId: string | null | undefined,
  { enabled = true }: RuntimeResourceOptions = {},
) {
  const { api } = useKernel();
  const resourceKey = stageId
    ? ANALYSIS_HYSTERESIS_POINTS_PATH.replace("{stage_id}", stageId)
    : `${ANALYSIS_HYSTERESIS_POINTS_PATH}:none`;

  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      stageId
        ? api.analysis.hysteresis
            .points(stageId, { signal })
            .catch(ignoreMissingResource<HysteresisPointsResource>)
        : Promise.resolve(null),
    [api, stageId],
  );

  return useResource<HysteresisPointsResource | null>({
    enabled: enabled && Boolean(stageId),
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey,
  });
}

export function useHysteresisMetricsResource(
  stageId: string | null | undefined,
  { enabled = true }: RuntimeResourceOptions = {},
) {
  const { api } = useKernel();
  const resourceKey = stageId
    ? ANALYSIS_HYSTERESIS_METRICS_PATH.replace("{stage_id}", stageId)
    : `${ANALYSIS_HYSTERESIS_METRICS_PATH}:none`;

  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      stageId
        ? api.analysis.hysteresis
            .metrics(stageId, { signal })
            .catch(ignoreMissingResource<HysteresisMetricsResource>)
        : Promise.resolve(null),
    [api, stageId],
  );

  return useResource<HysteresisMetricsResource | null>({
    enabled: enabled && Boolean(stageId),
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey,
  });
}

export function useHysteresisSaturationResource(
  stageId: string | null | undefined,
  { enabled = true }: RuntimeResourceOptions = {},
) {
  const { api } = useKernel();
  const resourceKey = stageId
    ? ANALYSIS_HYSTERESIS_SATURATION_PATH.replace("{stage_id}", stageId)
    : `${ANALYSIS_HYSTERESIS_SATURATION_PATH}:none`;

  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      stageId
        ? api.analysis.hysteresis
            .saturation(stageId, { signal })
            .catch(ignoreMissingResource<HysteresisSaturationResource>)
        : Promise.resolve(null),
    [api, stageId],
  );

  return useResource<HysteresisSaturationResource | null>({
    enabled: enabled && Boolean(stageId),
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey,
  });
}

export function useHysteresisAdaptiveRefinementResource(
  stageId: string | null | undefined,
  { enabled = true }: RuntimeResourceOptions = {},
) {
  const { api } = useKernel();
  const resourceKey = stageId
    ? ANALYSIS_HYSTERESIS_ADAPTIVE_REFINEMENT_PATH.replace("{stage_id}", stageId)
    : `${ANALYSIS_HYSTERESIS_ADAPTIVE_REFINEMENT_PATH}:none`;

  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      stageId
        ? api.analysis.hysteresis
            .adaptiveRefinement(stageId, { signal })
            .catch(ignoreMissingResource<HysteresisAdaptiveRefinementResource>)
        : Promise.resolve(null),
    [api, stageId],
  );

  return useResource<HysteresisAdaptiveRefinementResource | null>({
    enabled: enabled && Boolean(stageId),
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey,
  });
}

export type HysteresisBranch = HysteresisBranchSchema;
export type HysteresisMinorLoop = HysteresisMinorLoopSchema;
export type HysteresisSettleTraceEntry = HysteresisSettleTraceEntrySchema;

export function useHysteresisStageSettleTraceResource(
  stageId: string | null | undefined,
  { enabled = true }: RuntimeResourceOptions = {},
) {
  const { api } = useKernel();
  const resourceKey = stageId
    ? ANALYSIS_HYSTERESIS_STAGE_SETTLE_TRACE_PATH.replace("{stage_id}", stageId)
    : `${ANALYSIS_HYSTERESIS_STAGE_SETTLE_TRACE_PATH}:none`;

  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      stageId
        ? api.analysis.hysteresis
            .stageSettleTrace(stageId, { signal })
            .catch(ignoreMissingResource<HysteresisSettleTraceResource>)
        : Promise.resolve(null),
    [api, stageId],
  );

  return useResource<HysteresisSettleTraceResource | null>({
    enabled: enabled && Boolean(stageId),
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey,
  });
}

export function useHysteresisBookmarksResource(
  stageId: string | null | undefined,
  { enabled = true }: RuntimeResourceOptions = {},
) {
  const { api } = useKernel();
  const resourceKey = stageId
    ? ANALYSIS_HYSTERESIS_BOOKMARKS_PATH.replace("{stage_id}", stageId)
    : `${ANALYSIS_HYSTERESIS_BOOKMARKS_PATH}:none`;

  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      stageId
        ? api.analysis.hysteresis
            .bookmarks(stageId, { signal })
            .catch(ignoreMissingResource<HysteresisBookmarksResource>)
        : Promise.resolve(null),
    [api, stageId],
  );

  return useResource<HysteresisBookmarksResource | null>({
    enabled: enabled && Boolean(stageId),
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey,
  });
}

export function useHysteresisBranchesResource(
  stageId: string | null | undefined,
  { enabled = true }: RuntimeResourceOptions = {},
) {
  const { api } = useKernel();
  const resourceKey = stageId
    ? ANALYSIS_HYSTERESIS_BRANCHES_PATH.replace("{stage_id}", stageId)
    : `${ANALYSIS_HYSTERESIS_BRANCHES_PATH}:none`;

  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      stageId
        ? api.analysis.hysteresis
            .branches(stageId, { signal })
            .catch(ignoreMissingResource<HysteresisBranchesResource>)
        : Promise.resolve(null),
    [api, stageId],
  );

  return useResource<HysteresisBranchesResource | null>({
    enabled: enabled && Boolean(stageId),
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey,
  });
}

export function useHysteresisFamilyResource(
  stageId: string | null | undefined,
  { enabled = true }: RuntimeResourceOptions = {},
) {
  const { api } = useKernel();
  const resourceKey = stageId
    ? ANALYSIS_HYSTERESIS_FAMILY_PATH.replace("{stage_id}", stageId)
    : `${ANALYSIS_HYSTERESIS_FAMILY_PATH}:none`;

  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      stageId
        ? api.analysis.hysteresis
            .family(stageId, { signal })
            .catch(ignoreMissingResource<HysteresisAngularFamilyResource>)
        : Promise.resolve(null),
    [api, stageId],
  );

  return useResource<HysteresisAngularFamilyResource | null>({
    enabled: enabled && Boolean(stageId),
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey,
  });
}

export function useHysteresisMinorLoopsResource(
  stageId: string | null | undefined,
  { enabled = true }: RuntimeResourceOptions = {},
) {
  const { api } = useKernel();
  const resourceKey = stageId
    ? ANALYSIS_HYSTERESIS_MINOR_LOOPS_PATH.replace("{stage_id}", stageId)
    : `${ANALYSIS_HYSTERESIS_MINOR_LOOPS_PATH}:none`;

  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      stageId
        ? api.analysis.hysteresis
            .minorLoops(stageId, { signal })
            .catch(ignoreMissingResource<HysteresisMinorLoopsResource>)
        : Promise.resolve(null),
    [api, stageId],
  );

  return useResource<HysteresisMinorLoopsResource | null>({
    enabled: enabled && Boolean(stageId),
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey,
  });
}

export function useHysteresisPointResource(
  stageId: string | null | undefined,
  pointId: number | null | undefined,
  { enabled = true }: RuntimeResourceOptions = {},
) {
  const { api } = useKernel();
  const resourceKey =
    stageId && pointId != null
      ? ANALYSIS_HYSTERESIS_POINT_PATH
          .replace("{stage_id}", stageId)
          .replace("{point_id}", String(pointId))
      : `${ANALYSIS_HYSTERESIS_POINT_PATH}:none`;

  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      stageId && pointId != null
        ? api.analysis.hysteresis
            .point(stageId, pointId, { signal })
            .catch(ignoreMissingResource<HysteresisPointSchema>)
        : Promise.resolve(null),
    [api, pointId, stageId],
  );

  return useResource<HysteresisPointSchema | null>({
    enabled: enabled && Boolean(stageId) && pointId != null,
    load,
    resourceKey,
  });
}

export function useHysteresisSettleTraceResource(
  stageId: string | null | undefined,
  pointId: number | null | undefined,
  { enabled = true }: RuntimeResourceOptions = {},
) {
  const { api } = useKernel();
  const resourceKey =
    stageId && pointId != null
      ? ANALYSIS_HYSTERESIS_SETTLE_TRACE_PATH
          .replace("{stage_id}", stageId)
          .replace("{point_id}", String(pointId))
      : `${ANALYSIS_HYSTERESIS_SETTLE_TRACE_PATH}:none`;

  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      stageId && pointId != null
        ? api.analysis.hysteresis
            .settleTrace(stageId, pointId, { signal })
            .catch(ignoreMissingResource<HysteresisSettleTraceEntry[]>)
        : Promise.resolve(null),
    [api, pointId, stageId],
  );

  return useResource<HysteresisSettleTraceEntry[] | null>({
    enabled: enabled && Boolean(stageId) && pointId != null,
    load,
    resolveRevision: (data) => data?.length ?? null,
    resourceKey,
  });
}

export function useHysteresisReversalFieldsResource(
  stageId: string | null | undefined,
  { enabled = true }: RuntimeResourceOptions = {},
) {
  const { api } = useKernel();
  const resourceKey = stageId
    ? ANALYSIS_HYSTERESIS_REVERSAL_FIELDS_PATH.replace("{stage_id}", stageId)
    : `${ANALYSIS_HYSTERESIS_REVERSAL_FIELDS_PATH}:none`;

  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      stageId
        ? api.analysis.hysteresis
            .reversalFields(stageId, { signal })
            .catch(ignoreMissingResource<HysteresisReversalFieldsResource>)
        : Promise.resolve(null),
    [api, stageId],
  );

  return useResource<HysteresisReversalFieldsResource | null>({
    enabled: enabled && Boolean(stageId),
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey,
  });
}

export function useFieldCatalogResource({
  enabled = true,
}: RuntimeResourceOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.data.fields.catalog({ signal }),
    [api],
  );

  return useResource<FieldCatalogResource>({
    enabled,
    load,
    resolveRevision: (data) => data.revision,
    resourceKey: DATA_FIELDS_PATH,
  });
}

export function useQuantityCatalogResource({
  enabled = true,
}: RuntimeResourceOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.data.quantities.catalog({ signal }),
    [api],
  );

  return useResource<QuantityCatalogResource>({
    enabled,
    load,
    resolveRevision: (data) => data.schema_version,
    resourceKey: DATA_QUANTITIES_PATH,
  });
}

function fieldMetaQueryEntries(query: FieldMetaQuery): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  const push = (key: keyof FieldMetaQuery) => {
    const value =
      key === "scope_id"
        ? normalizeFieldMetaScopeId(query.scope_kind, query.scope_id)
        : query[key];
    if (typeof value === "string" && value.length > 0) {
      entries.push([key, value]);
    }
  };
  push("component");
  push("owner_object_id");
  push("scope_id");
  push("scope_kind");
  push("snapshot_id");
  push("stage_id");
  return entries;
}

function normalizeFieldMetaScopeId(
  scopeKind: FieldMetaQuery["scope_kind"],
  scopeId: FieldMetaQuery["scope_id"],
): string | null | undefined {
  if (
    scopeKind === "object" &&
    typeof scopeId === "string" &&
    scopeId.startsWith("object:")
  ) {
    return scopeId.slice("object:".length);
  }
  return scopeId;
}

export function resolveFieldMetaResourceKey(
  quantityId: string,
  query: FieldMetaQuery = {},
): string {
  const path = DATA_FIELD_META_PATH.replace(
    "{quantity_id}",
    encodeURIComponent(normalizeQuantityIdOrDefault(quantityId)),
  );
  const params = fieldMetaQueryEntries(query)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return params ? `${path}?${params}` : path;
}

export function resolveFieldMetaResourceKeyWithComponent(
  quantityId: string,
  component: string | null | undefined,
): string {
  return resolveFieldMetaResourceKey(quantityId, { component });
}

export function fieldMetaFreshnessRevision(
  data: FieldMetaResource | null,
): string | null {
  if (!data) return null;
  return [
    data.observation_frame?.observation_frame_id ?? "observation-frame:unavailable",
    data.field_revision,
    data.state,
    data.source_revision,
    data.source_step,
    data.stale_by_steps,
    data.materialized_at_unix_ms,
    data.materialization_wall_time_ns,
    data.materialization_error ?? "",
  ].join(":");
}

export function useFieldMetaResource({
  enabled = true,
  component = null,
  owner_object_id = null,
  scope_id = null,
  scope_kind = null,
  snapshot_id = null,
  stage_id = null,
  quantityId,
}: RuntimeResourceOptions & FieldMetaQuery & { quantityId: string }) {
  const { api, bus } = useKernel();
  const resolvedQuantityId = useMemo(
    () => normalizeQuantityIdOrDefault(quantityId),
    [quantityId],
  );
  const query = useMemo(
    () => ({
      component,
      ...(owner_object_id ? { owner_object_id } : {}),
      scope_id,
      scope_kind,
      snapshot_id,
      stage_id,
    }),
    [component, owner_object_id, scope_id, scope_kind, snapshot_id, stage_id],
  );
  const resourceKey = useMemo(
    () => resolveFieldMetaResourceKey(resolvedQuantityId, query),
    [query, resolvedQuantityId],
  );
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.data.fields
        .meta(resolvedQuantityId, query, { signal })
        .catch((error: unknown) =>
          ignoreMissingFieldMetaResource<FieldMetaResource>({
            bus,
            error,
            resourceKey,
          }),
        ),
    [api, bus, query, resolvedQuantityId, resourceKey],
  );

  return useResource<FieldMetaResource | null>({
    enabled,
    load,
    resolveRevision: fieldMetaFreshnessRevision,
    resourceKey,
  });
}

export function useScalarWindowResource({
  columns,
  enabled = true,
  limit = 200,
  sinceRevision,
  tail,
}: ScalarWindowQuery & { enabled?: boolean } = {}) {
  const { api } = useKernel();
  const resourceKey = scalarWindowResourceKey({ columns, limit, sinceRevision, tail });
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.data.scalars
        .window({ columns, limit, sinceRevision, tail }, { signal })
        .catch(ignoreMissingResource<ScalarWindowResource>),
    [api, columns, limit, sinceRevision, tail],
  );

  return useResource<ScalarWindowResource | null>({
    enabled,
    load,
    minRefetchIntervalMs: tableRowsMinRefetchIntervalMs(),
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey,
  });
}

export function useTableListResource({ enabled = true }: RuntimeResourceOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.data.tables
        .list({ signal })
        .catch(ignoreMissingResource<TableListResource>),
    [api],
  );

  return useResource<TableListResource | null>({
    enabled,
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey: DATA_TABLES_PATH,
  });
}

export function useTableResource(
  tableId = "default",
  { enabled = true }: RuntimeResourceOptions = {},
) {
  const { api } = useKernel();
  const resourceKey = DATA_TABLE_PATH.replace("{table_id}", tableId);
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.data.tables
        .detail(tableId, { signal })
        .catch(ignoreMissingResource<TableResource>),
    [api, tableId],
  );

  return useResource<TableResource | null>({
    enabled,
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey,
  });
}

export function useTableColumnsResource(
  tableId = "default",
  { enabled = true }: RuntimeResourceOptions = {},
) {
  const { api } = useKernel();
  const resourceKey = DATA_TABLE_COLUMNS_PATH.replace("{table_id}", tableId);
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.data.tables
        .columns(tableId, { signal })
        .catch(ignoreMissingResource<TableColumnMeta[]>),
    [api, tableId],
  );

  return useResource<TableColumnMeta[] | null>({
    enabled,
    load,
    resolveRevision: (data) => data?.length ?? null,
    resourceKey,
  });
}

export function useTableRowsResource(
  tableId = "default",
  {
    columns,
    cursor,
    decimation,
    enabled = true,
    fromRow,
    fromT,
    includeTail,
    limit = 5_000,
    targetPoints,
    toRow,
    toT,
  }: TableRowsQuery & { enabled?: boolean } = {},
) {
  const { api } = useKernel();
  const resourceKey = tableRowsResourceKey(tableId, {
    columns,
    cursor,
    decimation,
    fromRow,
    fromT,
    includeTail,
    limit,
    targetPoints,
    toRow,
    toT,
  });
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.data.tables
        .rows(
          tableId,
          {
            columns,
            cursor,
            decimation,
            fromRow,
            fromT,
            includeTail,
            limit,
            targetPoints,
            toRow,
            toT,
          },
          { signal },
        )
        .catch(ignoreMissingResource<TableRowsResource>),
    [
      api,
      columns,
      cursor,
      decimation,
      fromRow,
      fromT,
      includeTail,
      limit,
      tableId,
      targetPoints,
      toRow,
      toT,
    ],
  );

  return useResource<TableRowsResource | null>({
    enabled,
    load,
    minRefetchIntervalMs: tableRowsMinRefetchIntervalMs(),
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey,
  });
}

export function useTableRowsBinaryResource(
  tableId = "default",
  {
    columns,
    cursor,
    decimation,
    enabled = true,
    pauseLoad = false,
    fromRow,
    fromT,
    includeTail,
    limit = 5_000,
    targetPoints,
    toRow,
    toT,
  }: TableRowsQuery & { enabled?: boolean; pauseLoad?: boolean } = {},
) {
  const { api } = useKernel();
  const resourceKey = `${tableRowsResourceKey(tableId, {
    columns,
    cursor,
    decimation,
    fromRow,
    fromT,
    includeTail,
    limit,
    targetPoints,
    toRow,
    toT,
  })}#binary`;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.data.tables
        .rowsBinary(
          tableId,
          {
            columns,
            cursor,
            decimation,
            fromRow,
            fromT,
            includeTail,
            limit,
            targetPoints,
            toRow,
            toT,
          },
          { signal },
        )
        .catch(ignoreMissingResource<BinaryResourceResult<DecodedTableRows>>),
    [
      api,
      columns,
      cursor,
      decimation,
      fromRow,
      fromT,
      includeTail,
      limit,
      tableId,
      targetPoints,
      toRow,
      toT,
    ],
  );

  return useResource<BinaryResourceResult<DecodedTableRows> | null>({
    enabled,
    load,
    minRefetchIntervalMs: tableRowsMinRefetchIntervalMs(),
    pauseLoad,
    resolveRevision: (data) =>
      data?.status === "ready" ? data.data.revision : null,
    resourceKey,
  });
}

export function useCheckpointCatalogResource({
  enabled = true,
}: RuntimeResourceOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.persistence.checkpoints
        .list({ signal })
        .catch(ignoreMissingResource<CheckpointListResource>),
    [api],
  );

  return useResource<CheckpointListResource | null>({
    enabled,
    load,
    resolveRevision: (data) => data?.checkpoints.at(0)?.created_at ?? null,
    resourceKey: PERSISTENCE_CHECKPOINTS_PATH,
  });
}

export function useCheckpointDetailResource(
  checkpointId: string | null | undefined,
) {
  const { api } = useKernel();
  const resourceKey = checkpointId
    ? PERSISTENCE_CHECKPOINT_PATH.replace("{checkpoint_id}", checkpointId)
    : `${PERSISTENCE_CHECKPOINTS_PATH}:none`;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      checkpointId
        ? api.persistence.checkpoints
            .detail(checkpointId, { signal })
            .catch(ignoreMissingResource<CheckpointEntry>)
        : Promise.resolve(null),
    [api, checkpointId],
  );

  return useResource<CheckpointEntry | null>({
    enabled: Boolean(checkpointId),
    load,
    resolveRevision: (data) => data?.created_at ?? null,
    resourceKey,
  });
}

export function useEngineLogResource({
  enabled = true,
}: RuntimeResourceOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.diagnostics
        .engineLog({ signal })
        .catch(ignoreMissingResource<EngineLogResource>),
    [api],
  );

  return useResource<EngineLogResource | null>({
    enabled,
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey: DIAGNOSTICS_ENGINE_LOG_PATH,
  });
}

export function useGpuTelemetryResource({
  enabled = true,
}: RuntimeResourceOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.diagnostics.gpuTelemetry({ signal }),
    [api],
  );

  return useResource<GpuTelemetryResource>({
    enabled,
    load,
    resolveRevision: (data) => data.sample_time_unix_ms,
    resourceKey: DIAGNOSTICS_GPU_PATH,
  });
}

export function useCpuTelemetryResource({
  enabled = true,
}: RuntimeResourceOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.diagnostics.cpuTelemetry({ signal }),
    [api],
  );

  return useResource<CpuTelemetryResource>({
    enabled,
    load,
    resolveRevision: (data) => data.sample_time_unix_ms,
    resourceKey: DIAGNOSTICS_CPU_PATH,
  });
}

export function useSolverProfileResource({
  enabled = true,
}: RuntimeResourceOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    async ({ signal }: { signal: AbortSignal }) => {
      const startedAtMs = solverTraceNow();
      const profile = await api.diagnostics
        .solverProfile({ signal })
        .catch(ignoreMissingResource<SolverProfileResource>);
      solverTraceObserver.observeProfileLoad(
        profile,
        startedAtMs,
        solverTraceNow(),
      );
      return profile;
    },
    [api],
  );

  const resource = useResource<SolverProfileResource | null>({
    enabled,
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey: DIAGNOSTICS_SOLVER_PROFILE_PATH,
  });

  useEffect(() => {
    if (!enabled || !resource.data) return;
    solverTraceObserver.observeProfileCommit(resource.data);
  }, [enabled, resource.data]);

  const mergedProfile = useMemo(
    () => solverTraceObserver.mergeProfile(resource.data),
    [resource.data],
  );
  return { ...resource, data: mergedProfile };
}

export function useModelReadinessResource({
  enabled = true,
}: RuntimeResourceOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.model.readiness({ signal }),
    [api],
  );

  return useResource<ModelReadinessResource>({
    enabled,
    load,
    resolveRevision: (data) => data.scene_revision,
    resourceKey: MODEL_READINESS_PATH,
  });
}

export function readyCommandResourceData<T>(
  data: T | null,
  status: string,
): T | null {
  return status === "ready" ? data : null;
}

export function useStudyRuntimeCommandResourceData({
  enabled = true,
}: RuntimeResourceOptions = {}): Readonly<Record<string, unknown>> {
  const sessionStatus = useSessionStatusSelector(
    selectStudyRuntimeCommandSessionStatus,
    { enabled, isEqual: studyRuntimeCommandSessionStatusEquals },
  );
  const commandQueue = useCommandQueueResource({
    enabled: shouldLoadRuntimeCommandQueue(enabled, sessionStatus),
  });
  const currentRun = useCurrentRunResource({
    enabled: shouldLoadRuntimeCurrentRun(enabled, sessionStatus),
  });
  const geometryValidation = useGeometryValidationResource({ enabled });
  const modelReadiness = useModelReadinessResource({ enabled });
  const meshBuildCurrent = useMeshBuildCurrent({
    enabled: shouldLoadRuntimeMeshBuild(enabled, sessionStatus),
  });
  const meshBuildLatest = useMeshBuildLatestSuccessful({
    enabled: shouldLoadRuntimeMeshBuild(enabled, sessionStatus),
  });
  const meshManifest = useMeshSharedDomainManifestResource({
    enabled: shouldLoadRuntimeMeshManifest(enabled, sessionStatus),
  });
  const meshSummary = useMeshSummaryResource({
    enabled: shouldLoadRuntimeMeshSummary(enabled, sessionStatus),
  });
  const scene = useSceneResource({ enabled });
  const stageExecution = useStageExecutionResource({
    enabled: shouldLoadRuntimeStageExecution(enabled, sessionStatus),
  });
  const solverStatus = useSolverStatusResource({ enabled });
  const solverProfile = useSolverProfileResource({ enabled });
  const checkpointCatalog = useCheckpointCatalogResource({ enabled });

  return useMemo(
    () => ({
      [DIAGNOSTICS_SOLVER_PROFILE_PATH]: solverProfile.data,
      [MESHING_SHARED_DOMAIN_MANIFEST_PATH]: meshManifest.data,
      [MESHING_BUILDS_CURRENT_PATH]: meshBuildCurrent.data,
      [MESHING_BUILDS_LATEST_SUCCESSFUL_PATH]: meshBuildLatest.data,
      [MESHING_SUMMARY_PATH]: meshSummary.data,
      [MODEL_GEOMETRY_VALIDATION_PATH]: geometryValidation.data,
      [MODEL_READINESS_PATH]: readyCommandResourceData(
        modelReadiness.data,
        modelReadiness.status,
      ),
      [MODEL_SCENE_PATH]: scene.data,
      [PERSISTENCE_CHECKPOINTS_PATH]: checkpointCatalog.data,
      [SESSION_STATUS_RESOURCE_KEY]: enabled ? sessionStatus : null,
      [SIMULATION_COMMANDS_PATH]: commandQueue.data,
      [SIMULATION_RUN_CURRENT_PATH]: currentRun.data,
      [SIMULATION_SOLVER_STATUS_PATH]: solverStatus.data,
      [SIMULATION_STAGES_EXECUTION_PATH]: stageExecution.data,
    }),
    [
      checkpointCatalog.data,
      commandQueue.data,
      currentRun.data,
      enabled,
      geometryValidation.data,
      meshBuildCurrent.data,
      meshBuildLatest.data,
      meshManifest.data,
      meshSummary.data,
      modelReadiness.data,
      modelReadiness.status,
      scene.data,
      sessionStatus,
      solverProfile.data,
      solverStatus.data,
      stageExecution.data,
    ],
  );
}

export function useRuntimeCommandControlResourceData({
  enabled = true,
  includeSharedDomainReadiness = true,
  includeStageExecution = true,
}: RuntimeCommandControlResourceOptions = {}): Readonly<Record<string, unknown>> {
  const sessionStatus = useSessionStatusSelector(selectRuntimeCommandControlSessionStatus, {
    enabled,
    isEqual: runtimeCommandControlSessionStatusEquals,
  });
  const commandQueue = useCommandQueueResource({
    enabled: shouldLoadRuntimeCommandQueue(enabled, sessionStatus),
  });
  const geometryValidation = useGeometryValidationResource({ enabled });
  const modelReadiness = useModelReadinessResource({ enabled });
  const meshBuildCurrent = useMeshBuildCurrent({
    enabled:
      includeSharedDomainReadiness &&
      shouldLoadRuntimeMeshBuild(enabled, sessionStatus),
  });
  const meshManifest = useMeshSharedDomainManifestResource({
    enabled:
      includeSharedDomainReadiness &&
      shouldLoadRuntimeMeshManifest(enabled, sessionStatus),
  });
  const solverStatus = useSolverStatusResource({ enabled });
  const stageExecution = useStageExecutionResource({
    enabled:
      includeStageExecution &&
      shouldLoadRuntimeStageExecution(enabled, sessionStatus),
  });

  return useMemo(
    () => ({
      [MESHING_SHARED_DOMAIN_MANIFEST_PATH]: meshManifest.data,
      [MESHING_BUILDS_CURRENT_PATH]: meshBuildCurrent.data,
      [MODEL_GEOMETRY_VALIDATION_PATH]: geometryValidation.data,
      [MODEL_READINESS_PATH]: readyCommandResourceData(
        modelReadiness.data,
        modelReadiness.status,
      ),
      [SESSION_STATUS_RESOURCE_KEY]: enabled ? sessionStatus : null,
      [SIMULATION_COMMANDS_PATH]: commandQueue.data,
      [SIMULATION_SOLVER_STATUS_PATH]: solverStatus.data,
      [SIMULATION_STAGES_EXECUTION_PATH]: stageExecution.data,
    }),
    [
      commandQueue.data,
      enabled,
      geometryValidation.data,
      meshBuildCurrent.data,
      meshManifest.data,
      modelReadiness.data,
      modelReadiness.status,
      sessionStatus,
      solverStatus.data,
      stageExecution.data,
    ],
  );
}

export function useObjectMetricsResource(objectId: string | null | undefined) {
  const { api } = useKernel();
  const resourceKey = objectId
    ? SIMULATION_OBJECT_METRICS_PATH.replace("{object_id}", objectId)
    : `${SIMULATION_OBJECT_METRICS_PATH}:none`;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      objectId
        ? api.simulation.objects
            .metrics(objectId, { signal })
            .catch(ignoreMissingResource<ObjectMetricsResource>)
        : Promise.resolve(null),
    [api, objectId],
  );

  return useResource<ObjectMetricsResource | null>({
    enabled: Boolean(objectId),
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey,
  });
}

export function useObjectTopologicalChargeResource(
  objectId: string | null | undefined,
  options: RuntimeResourceOptions & {
    pauseLoad?: boolean;
    query?: TopologicalChargeQuery;
  } = {},
) {
  const { api } = useKernel();
  const queryToken = JSON.stringify(options.query ?? {});
  const resourceKey = objectId
    ? `${ANALYSIS_OBJECT_TOPOLOGICAL_CHARGE_PATH.replace("{object_id}", objectId)}?${queryToken}`
    : `${ANALYSIS_OBJECT_TOPOLOGICAL_CHARGE_PATH}:none`;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      objectId
        ? api.analysis.extensions.objects
            .topologicalCharge(objectId, JSON.parse(queryToken) as TopologicalChargeQuery, { signal })
            .catch(ignoreMissingResource<TopologicalChargeResource>)
        : Promise.resolve(null),
    [api, objectId, queryToken],
  );

  return useResource<TopologicalChargeResource | null>({
    enabled: Boolean(objectId) && options.enabled !== false,
    load,
    pauseLoad: options.pauseLoad,
    resolveRevision: (data) => data?.resource_revision ?? null,
    resourceKey,
  });
}

function scalarWindowResourceKey({
  columns,
  limit,
  sinceRevision,
  tail,
}: ScalarWindowQuery): string {
  const params = new URLSearchParams();
  if (limit !== undefined) {
    params.set("limit", String(limit));
  }
  if (sinceRevision !== undefined) {
    params.set("since_revision", String(sinceRevision));
  }
  if (tail !== undefined) {
    params.set("tail", String(tail));
  }
  if (columns && columns.length > 0) {
    params.set("columns", columns.join(","));
  }
  const query = params.toString();
  return query ? `${DATA_SCALARS_PATH}?${query}` : DATA_SCALARS_PATH;
}

function tableRowsResourceKey(
  tableId: string,
  {
    columns,
    cursor,
    decimation,
    fromRow,
    fromT,
    includeTail,
    limit,
    targetPoints,
    toRow,
    toT,
  }: TableRowsQuery,
): string {
  const params = new URLSearchParams();
  if (columns && columns.length > 0) {
    params.set("columns", columns.join(","));
  }
  if (cursor !== undefined) {
    params.set("cursor", String(cursor));
  }
  if (decimation !== undefined) {
    params.set("decimation", decimation);
  }
  if (fromRow !== undefined) {
    params.set("from_row", String(fromRow));
  }
  if (fromT !== undefined) {
    params.set("from_t", String(fromT));
  }
  if (includeTail !== undefined) {
    params.set("include_tail", String(includeTail));
  }
  if (limit !== undefined) {
    params.set("limit", String(limit));
  }
  if (targetPoints !== undefined) {
    params.set("target_points", String(targetPoints));
  }
  if (toRow !== undefined) {
    params.set("to_row", String(toRow));
  }
  if (toT !== undefined) {
    params.set("to_t", String(toT));
  }
  const query = params.toString();
  const path = DATA_TABLE_ROWS_PATH.replace("{table_id}", tableId);
  return query ? `${path}?${query}` : path;
}
