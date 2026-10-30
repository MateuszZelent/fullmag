"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { VISUALIZATION_STATE_PATH } from "../api/apiPaths";
import type { VisualizationStateResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import { useResource } from "../resources/useResource";
import { useSessionScopedResourceKey } from "../resources/useSessionScopedResourceKey";

export const VISUALIZATION_STATE_RESOURCE_KEY = VISUALIZATION_STATE_PATH;

export function resolveVisualizationStateRevision(
  state: VisualizationStateResource,
): number {
  return state.revision;
}

export function useVisualizationStateResource({
  enabled = true,
}: { enabled?: boolean } = {}) {
  const { api, cameraRegistry, visualization, visualizationSync } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    VISUALIZATION_STATE_RESOURCE_KEY,
  );
  const sessionScopeKey = sessionIdentity
    ? resourceKey.slice(0, resourceKey.indexOf("|"))
    : null;
  const load = useCallback(
    ({
      sessionScopeKey,
      signal,
    }: {
      sessionScopeKey?: string;
      signal: AbortSignal;
    }) => api.visualization.state({ sessionScopeKey, signal }),
    [api],
  );
  const syncVersion = useSyncExternalStore(
    (onStoreChange) => visualizationSync.subscribe(onStoreChange),
    () => visualizationSync.getSnapshot().version,
    () => visualizationSync.getSnapshot().version,
  );

  const resource = useResource({
    enabled: enabled && sessionIdentity !== null,
    load,
    resolveRevision: resolveVisualizationStateRevision,
    resourceKey,
  });

  useEffect(() => {
    visualizationSync.setSessionScopeKey(sessionScopeKey);
  }, [sessionScopeKey, visualizationSync]);

  useEffect(() => {
    visualizationSync.observeRemoteState(resource.data);
    cameraRegistry.observeRemoteState(resource.data);
    if (resource.data) {
      visualization.acknowledgePendingTargetPatches(resource.data);
    }
  }, [cameraRegistry, resource.data, visualization, visualizationSync]);

  // Applying a pending patch builds a new state object. Recompute it only when
  // the remote state or the sync snapshot changes; otherwise every render
  // during a pending patch hands consumers a new identity and memoized views
  // (the 2D render model) rebuild and re-publish evidence in a loop.
  const optimisticData = useMemo(
    () => visualizationSync.applyOptimisticState(resource.data),
    // syncVersion bumps on every snapshot change applyOptimisticState reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resource.data, syncVersion, visualizationSync],
  );

  return {
    ...resource,
    data: resource.data,
    optimisticData,
    rawData: resource.data,
  };
}
