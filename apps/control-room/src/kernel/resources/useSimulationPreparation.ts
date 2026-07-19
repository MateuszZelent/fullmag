"use client";

import { useCallback } from "react";

import { SIMULATION_PREPARATION_PATH } from "../api/apiPaths";
import type { SimulationPreparationResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import { statusRefreshIntervalMs } from "../realtime/communicationPolicy";

import { useResource } from "./useResource";

function resolvePreparationRevision(data: SimulationPreparationResource) {
  return data.revision;
}

export function useSimulationPreparation({ enabled = true } = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.simulation.preparation({ signal }),
    [api],
  );

  return useResource<SimulationPreparationResource>({
    enabled,
    load,
    minRefetchIntervalMs: statusRefreshIntervalMs(),
    resolveRevision: resolvePreparationRevision,
    resourceKey: SIMULATION_PREPARATION_PATH,
  });
}
