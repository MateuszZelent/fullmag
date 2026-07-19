"use client";

import { useCallback, useEffect } from "react";

import { SIMULATION_PREPARATION_PATH } from "../api/apiPaths";
import type { SimulationPreparationResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import { statusRefreshIntervalMs } from "../realtime/communicationPolicy";

import { useResource } from "./useResource";

function resolvePreparationRevision(data: SimulationPreparationResource) {
  return data.revision;
}

export function useSimulationPreparation({
  enabled = true,
  requiredRevision = null,
}: {
  enabled?: boolean;
  requiredRevision?: number | null;
} = {}) {
  const { api, resources } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.simulation.preparation({ signal }),
    [api],
  );

  const preparation = useResource<SimulationPreparationResource>({
    enabled,
    load,
    minRefetchIntervalMs: statusRefreshIntervalMs(),
    resolveRevision: resolvePreparationRevision,
    resourceKey: SIMULATION_PREPARATION_PATH,
  });

  useEffect(() => {
    if (!enabled || requiredRevision === null || requiredRevision <= 0) return;
    if ((preparation.data?.revision ?? 0) >= requiredRevision) return;
    const currentRevision = resources.getRevision(SIMULATION_PREPARATION_PATH);
    if (
      currentRevision === requiredRevision ||
      (typeof currentRevision === "number" && currentRevision > requiredRevision)
    ) {
      return;
    }
    resources.invalidate(SIMULATION_PREPARATION_PATH, requiredRevision);
  }, [enabled, preparation.data?.revision, requiredRevision, resources]);

  return preparation;
}
