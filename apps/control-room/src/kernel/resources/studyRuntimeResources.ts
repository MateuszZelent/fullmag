"use client";

import { useCallback } from "react";

import {
  SIMULATION_COMMANDS_PATH,
  SIMULATION_RUN_CURRENT_PATH,
  SIMULATION_SOLVER_ENERGIES_CURRENT_PATH,
  SIMULATION_SOLVER_ENERGIES_HISTORY_PATH,
  SIMULATION_SOLVER_STATUS_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
} from "../api/apiPaths";
import { ControlRoomApiError } from "../api/ControlRoomApi";
import type {
  CommandQueueStatusResource,
  CurrentRunResource,
  SolverEnergyCurrentResource,
  SolverEnergyHistoryResource,
  SolverStatusResource,
  StageExecutionResource,
} from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import { useResource } from "./useResource";

function ignoreMissingResource<T>(error: unknown): T | null {
  if (error instanceof ControlRoomApiError && error.status === 404) {
    return null;
  }
  throw error;
}

export function useCommandQueueResource() {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.commands.list({ signal }),
    [api],
  );

  return useResource<CommandQueueStatusResource>({
    load,
    resolveRevision: (data) => data.revision,
    resourceKey: SIMULATION_COMMANDS_PATH,
  });
}

export function useCurrentRunResource() {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.simulation
        .currentRun({ signal })
        .catch(ignoreMissingResource<CurrentRunResource>),
    [api],
  );

  return useResource<CurrentRunResource | null>({
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey: SIMULATION_RUN_CURRENT_PATH,
  });
}

export function useStageExecutionResource() {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.simulation.stages
        .execution({ signal })
        .catch(ignoreMissingResource<StageExecutionResource>),
    [api],
  );

  return useResource<StageExecutionResource | null>({
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey: SIMULATION_STAGES_EXECUTION_PATH,
  });
}

export function useSolverStatusResource() {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.simulation.solver
        .status({ signal })
        .catch(ignoreMissingResource<SolverStatusResource>),
    [api],
  );

  return useResource<SolverStatusResource | null>({
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey: SIMULATION_SOLVER_STATUS_PATH,
  });
}

export function useSolverEnergyCurrentResource() {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.simulation.solver.energies
        .current({ signal })
        .catch(ignoreMissingResource<SolverEnergyCurrentResource>),
    [api],
  );

  return useResource<SolverEnergyCurrentResource | null>({
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
