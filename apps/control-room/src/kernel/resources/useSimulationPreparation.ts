"use client";

import { useCallback } from "react";

import { SIMULATION_PREPARATION_PATH } from "../api/apiPaths";
import type { SimulationPreparationResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import { statusRefreshIntervalMs } from "../realtime/communicationPolicy";

import { useResource } from "./useResource";

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
    resolveRevision: (data) => data.revision,
    resourceKey: SIMULATION_PREPARATION_PATH,
  });
}
