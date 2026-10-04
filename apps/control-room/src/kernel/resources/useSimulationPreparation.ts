"use client";

import { useCallback, useEffect, useRef } from "react";

import { SIMULATION_PREPARATION_PATH } from "../api/apiPaths";
import type { SimulationPreparationResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import {
  errorRetryDelayMs,
  statusRefreshIntervalMs,
} from "../realtime/communicationPolicy";

import { useSessionScopedResourceKey } from "./useSessionScopedResourceKey";
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
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    SIMULATION_PREPARATION_PATH,
  );
  const effectiveEnabled = enabled && sessionIdentity !== null;
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.simulation.preparation({ sessionScopeKey, signal }),
    [api],
  );

  const preparation = useResource<SimulationPreparationResource>({
    enabled: effectiveEnabled,
    load,
    minRefetchIntervalMs: statusRefreshIntervalMs(),
    resolveRevision: resolvePreparationRevision,
    resourceKey,
  });
  const retriedRequiredRevision = useRef<number | null>(null);

  useEffect(() => {
    if (!effectiveEnabled || requiredRevision === null || requiredRevision <= 0) return;
    if ((preparation.data?.revision ?? 0) >= requiredRevision) return;
    const currentRevision = resources.getRevision(resourceKey);
    if (
      currentRevision === requiredRevision ||
      (typeof currentRevision === "number" && currentRevision > requiredRevision)
    ) {
      return;
    }
    resources.invalidate(resourceKey, requiredRevision);
  }, [
    effectiveEnabled,
    preparation.data?.revision,
    requiredRevision,
    resourceKey,
    resources,
  ]);

  useEffect(() => {
    const loadedRevision = preparation.data?.revision ?? 0;
    if (
      !effectiveEnabled ||
      requiredRevision === null ||
      requiredRevision <= 0 ||
      loadedRevision >= requiredRevision ||
      preparation.status !== "error" ||
      !isTransientPreparationLoadError(preparation.error) ||
      retriedRequiredRevision.current === requiredRevision
    ) {
      return;
    }

    retriedRequiredRevision.current = requiredRevision;
    const timeoutId = setTimeout(preparation.refetch, errorRetryDelayMs());
    return () => clearTimeout(timeoutId);
  }, [
    effectiveEnabled,
    preparation.data?.revision,
    preparation.error,
    preparation.refetch,
    preparation.status,
    requiredRevision,
  ]);

  return preparation;
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
