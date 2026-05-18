"use client";

import { useCallback, useMemo } from "react";

import {
  DATA_SCALARS_PATH,
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
  CommandQueueStatusResource,
  CommandDetailResource,
  CheckpointEntry,
  CheckpointListResource,
  CurrentRunResource,
  EngineLogResource,
  GpuTelemetryResource,
  ObjectMetricsResource,
  SolverEnergyCurrentResource,
  SolverEnergyHistoryResource,
  SolverProfileResource,
  SolverStatusResource,
  StageExecutionResource,
  ScalarWindowQuery,
  ScalarWindowResource,
} from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import {
  useGeometryValidationResource,
  useMeshBuildCurrent,
  useMeshBuildLatestSuccessful,
  useMeshSharedDomainManifestResource,
  useMeshSummaryResource,
  useSceneResource,
} from "./geometryLifecycleResources";
import { SESSION_STATUS_RESOURCE_KEY, useSessionStatus } from "./useSessionStatus";
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

export function useSolverEnergyHistoryResource(limit = 200) {
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
    load,
    resolveRevision: (data) => data?.revision ?? null,
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
    resolveRevision: (data) => data?.revision ?? null,
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
  const commandQueue = useCommandQueueResource({ enabled });
  const currentRun = useCurrentRunResource({ enabled });
  const geometryValidation = useGeometryValidationResource({ enabled });
  const meshBuildCurrent = useMeshBuildCurrent({ enabled });
  const meshBuildLatest = useMeshBuildLatestSuccessful({ enabled });
  const meshManifest = useMeshSharedDomainManifestResource({ enabled });
  const meshSummary = useMeshSummaryResource({ enabled });
  const scene = useSceneResource({ enabled });
  const sessionStatus = useSessionStatus();
  const stageExecution = useStageExecutionResource({ enabled });
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
      [SESSION_STATUS_RESOURCE_KEY]: enabled ? sessionStatus.data : null,
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
      sessionStatus.data,
      solverProfile.data,
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
