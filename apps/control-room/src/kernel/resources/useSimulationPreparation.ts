"use client";

import { useCallback, useEffect, useRef } from "react";

import { SIMULATION_PREPARATION_PATH } from "../api/apiPaths";
import type { SimulationPreparationResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import {
  errorRetryDelayMs,
  statusRefreshIntervalMs,
} from "../realtime/communicationPolicy";

import { useSimulationPreparationSessionScope } from "./useSessionStatus";
import { sessionScopedResourceKey } from "./sessionResourceIdentity";
import {
  preparationMinimumRevision,
  preparationPublicationState,
  preparationRetryKey,
} from "./simulationPreparationPublication";
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
  const { sessionIdentity, preparationRevision } = useSimulationPreparationSessionScope();
  const resourceKey = sessionIdentity
    ? sessionScopedResourceKey(sessionIdentity, SIMULATION_PREPARATION_PATH)
    : SIMULATION_PREPARATION_PATH;
  const publication = preparationPublicationState(preparationRevision, requiredRevision);
  const minimumRevision = preparationMinimumRevision(preparationRevision, requiredRevision);
  const effectiveEnabled = enabled && sessionIdentity !== null && publication !== "absent";
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.simulation.preparation({ sessionScopeKey, signal }),
    [api],
  );

  const preparation = useResource<SimulationPreparationResource>({
    enabled: effectiveEnabled,
    pauseLoad: publication === "unknown",
    load,
    minRefetchIntervalMs: statusRefreshIntervalMs(),
    resolveRevision: resolvePreparationRevision,
    resourceKey,
  });
  const retriedPublication = useRef<string | null>(null);
  const refreshedPublication = useRef<string | null>(null);
  const retryKey = preparationRetryKey(resourceKey, minimumRevision);
  const requestRefetch = preparation.refetch;
  const refetch = useCallback(() => {
    if (!effectiveEnabled || publication !== "published") return;
    requestRefetch();
  }, [effectiveEnabled, publication, requestRefetch]);

  useEffect(() => {
    if (!effectiveEnabled || minimumRevision === null) return;
    if ((preparation.data?.revision ?? 0) >= minimumRevision) return;
    const currentRevision = resources.getRevision(resourceKey);
    if (
      currentRevision === minimumRevision ||
      (typeof currentRevision === "number" && currentRevision > minimumRevision)
    ) {
      // A transport revision is not proof that the loaded preparation meets the minimum.
      if (preparation.status === "ready" && refreshedPublication.current !== retryKey) {
        refreshedPublication.current = retryKey;
        refetch();
      }
      return;
    }
    resources.invalidate(resourceKey, minimumRevision);
  }, [
    effectiveEnabled,
    preparation.data?.revision,
    preparation.status,
    minimumRevision,
    refetch,
    retryKey,
    resourceKey,
    resources,
  ]);

  useEffect(() => {
    const loadedRevision = preparation.data?.revision ?? 0;
    if (
      !effectiveEnabled ||
      publication !== "published" ||
      minimumRevision === null ||
      retryKey === null ||
      loadedRevision >= minimumRevision ||
      preparation.status !== "error" ||
      !isTransientPreparationLoadError(preparation.error) ||
      retriedPublication.current === retryKey
    ) {
      return;
    }

    const timeoutId = setTimeout(() => {
      retriedPublication.current = retryKey;
      refetch();
    }, errorRetryDelayMs());
    return () => clearTimeout(timeoutId);
  }, [
    effectiveEnabled,
    preparation.data?.revision,
    preparation.error,
    preparation.status,
    publication,
    minimumRevision,
    refetch,
    retryKey,
  ]);

  return { ...preparation, refetch };
}

function isTransientPreparationLoadError(error: Error | null): boolean {
  if (!error) return false;
  const message = error.message.toLowerCase();
  if (message.includes("contract version mismatch")) return false;
  if (!("status" in error)) return true;
  const status = (error as Error & { status: unknown }).status;
  return (
    typeof status !== "number" ||
    status === 0 ||
    status === 408 ||
    status === 429 ||
    status >= 500
  );
}
