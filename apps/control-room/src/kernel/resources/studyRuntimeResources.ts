"use client";

import { useCallback, useMemo } from "react";

import {
  ANALYSIS_FREQUENCY_RESPONSE_MAGNETIC_SWEEP_V1_PATH,
  DATA_FIELD_META_PATH,
  DATA_FIELDS_PATH,
  DATA_SCALARS_PATH,
  DATA_TABLE_COLUMNS_PATH,
  DATA_TABLE_PATH,
  DATA_TABLE_ROWS_PATH,
  DATA_TABLES_PATH,
  DIAGNOSTICS_CPU_PATH,
  DIAGNOSTICS_ENGINE_LOG_PATH,
  DIAGNOSTICS_GPU_PATH,
  DIAGNOSTICS_SOLVER_PROFILE_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MESHING_BUILDS_CURRENT_PATH,
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  MESHING_SUMMARY_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_SCENE_PATH,
  PERSISTENCE_CHECKPOINT_PATH,
  PERSISTENCE_CHECKPOINTS_PATH,
  SIMULATION_COMMAND_DETAIL_PATH,
  SIMULATION_COMMANDS_PATH,
  SIMULATION_OBJECT_METRICS_PATH,
  SIMULATION_RUN_CURRENT_PATH,
  SIMULATION_SOLVER_ENERGIES_CURRENT_PATH,
  SIMULATION_SOLVER_ENERGIES_HISTORY_PATH,
  SIMULATION_SOLVER_STATUS_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
} from "../api/apiPaths";
import { ControlRoomApiError } from "../api/ControlRoomApi";
import type {
  BinaryResourceResult,
  CommandQueueStatusResource,
  CommandDetailResource,
  CheckpointEntry,
  CheckpointListResource,
  CurrentRunResource,
  EngineLogResource,
  FieldCatalogResource,
  FieldMetaResource,
  CpuTelemetryResource,
  GpuTelemetryResource,
  LiveStatusResource,
  MagneticResponseSweepResource,
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
} from "../api/apiTypes";
import { normalizeQuantityIdOrDefault } from "../api/quantityIds";
import type { DecodedTableRows } from "../api/codecs";
import { useKernel } from "../KernelContext";
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
import { useResource } from "./useResource";

function ignoreMissingResource<T>(error: unknown): T | null {
  if (error instanceof ControlRoomApiError && error.status === 404) {
    return null;
  }
  throw error;
}

interface RuntimeResourceOptions {
  enabled?: boolean;
}

export const STUDY_RUNTIME_CONTROL_RESOURCE_KEYS = [
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MESHING_BUILDS_CURRENT_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  SESSION_STATUS_RESOURCE_KEY,
  SIMULATION_COMMANDS_PATH,
  SIMULATION_SOLVER_STATUS_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
] as const;

const RUNTIME_COMMAND_CONTROL_STATUS_RESOURCE_KEYS = [
  "command_completion_revision",
  "commands_revision",
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
        | "command_completion_revision"
        | "commands_revision"
        | "mesh_build_revision"
        | "mesh_revision"
        | "scene_revision"
        | "stages_revision"
  >;
  run: Pick<NonNullable<LiveStatusResource["run"]>, "run_id"> | null;
  session: Pick<LiveStatusResource["session"], "session_id">;
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
      command_completion_revision:
        status.data.resources.command_completion_revision,
      commands_revision: status.data.resources.commands_revision,
      mesh_build_revision: status.data.resources.mesh_build_revision,
      mesh_revision: status.data.resources.mesh_revision,
      scene_revision: status.data.resources.scene_revision,
      stages_revision: status.data.resources.stages_revision,
    },
    run: status.data.run ? { run_id: status.data.run.run_id } : null,
    session: {
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
    previous.resources.command_completion_revision ===
      next.resources.command_completion_revision &&
    previous.resources.commands_revision === next.resources.commands_revision &&
    previous.resources.mesh_build_revision ===
      next.resources.mesh_build_revision &&
    previous.resources.mesh_revision === next.resources.mesh_revision &&
    previous.resources.scene_revision === next.resources.scene_revision &&
    previous.resources.stages_revision === next.resources.stages_revision &&
    previous.run?.run_id === next.run?.run_id &&
    previous.session.session_id === next.session.session_id
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
        resources: Pick<LiveStatusResource["resources"], "mesh_revision">;
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
    hasPositiveRevision(status.resources.mesh_revision)
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

function hasPositiveRevision(revision: number | null | undefined): boolean {
  return typeof revision === "number" && revision > 0;
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

export function resolveFieldMetaResourceKey(quantityId: string): string {
  return resolveFieldMetaResourceKeyWithComponent(quantityId, null);
}

export function resolveFieldMetaResourceKeyWithComponent(
  quantityId: string,
  component: string | null | undefined,
): string {
  const path = DATA_FIELD_META_PATH.replace(
    "{quantity_id}",
    encodeURIComponent(normalizeQuantityIdOrDefault(quantityId)),
  );
  return component ? `${path}?component=${encodeURIComponent(component)}` : path;
}

export function useFieldMetaResource({
  enabled = true,
  component = null,
  quantityId,
}: RuntimeResourceOptions & { component?: string | null; quantityId: string }) {
  const { api } = useKernel();
  const resolvedQuantityId = useMemo(
    () => normalizeQuantityIdOrDefault(quantityId),
    [quantityId],
  );
  const resourceKey = useMemo(
    () => resolveFieldMetaResourceKeyWithComponent(resolvedQuantityId, component),
    [component, resolvedQuantityId],
  );
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.data.fields
        .meta(resolvedQuantityId, { component }, { signal })
        .catch(ignoreMissingResource<FieldMetaResource>),
    [api, component, resolvedQuantityId],
  );

  return useResource<FieldMetaResource | null>({
    enabled,
    load,
    resolveRevision: (data) => data?.field_revision ?? null,
    resourceKey,
  });
}

export function useScalarWindowResource({
  columns,
  enabled = true,
  limit = 200,
  sinceRevision,
}: ScalarWindowQuery & { enabled?: boolean } = {}) {
  const { api } = useKernel();
  const resourceKey = scalarWindowResourceKey({ columns, limit, sinceRevision });
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.data.scalars
        .window({ columns, limit, sinceRevision }, { signal })
        .catch(ignoreMissingResource<ScalarWindowResource>),
    [api, columns, limit, sinceRevision],
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
    ({ signal }: { signal: AbortSignal }) =>
      api.diagnostics
        .solverProfile({ signal })
        .catch(ignoreMissingResource<SolverProfileResource>),
    [api],
  );

  return useResource<SolverProfileResource | null>({
    enabled,
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey: DIAGNOSTICS_SOLVER_PROFILE_PATH,
  });
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
}: RuntimeResourceOptions = {}): Readonly<Record<string, unknown>> {
  const sessionStatus = useSessionStatusSelector(selectRuntimeCommandControlSessionStatus, {
    enabled,
    isEqual: runtimeCommandControlSessionStatusEquals,
  });
  const commandQueue = useCommandQueueResource({
    enabled: shouldLoadRuntimeCommandQueue(enabled, sessionStatus),
  });
  const geometryValidation = useGeometryValidationResource({ enabled });
  const meshBuildCurrent = useMeshBuildCurrent({
    enabled: shouldLoadRuntimeMeshBuild(enabled, sessionStatus),
  });
  const meshManifest = useMeshSharedDomainManifestResource({
    enabled: shouldLoadRuntimeMeshManifest(enabled, sessionStatus),
  });
  const solverStatus = useSolverStatusResource({ enabled });
  const stageExecution = useStageExecutionResource({
    enabled: shouldLoadRuntimeStageExecution(enabled, sessionStatus),
  });

  return useMemo(
    () => ({
      [MESHING_SHARED_DOMAIN_MANIFEST_PATH]: meshManifest.data,
      [MESHING_BUILDS_CURRENT_PATH]: meshBuildCurrent.data,
      [MODEL_GEOMETRY_VALIDATION_PATH]: geometryValidation.data,
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

function scalarWindowResourceKey({
  columns,
  limit,
  sinceRevision,
}: ScalarWindowQuery): string {
  const params = new URLSearchParams();
  if (limit !== undefined) {
    params.set("limit", String(limit));
  }
  if (sinceRevision !== undefined) {
    params.set("since_revision", String(sinceRevision));
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
