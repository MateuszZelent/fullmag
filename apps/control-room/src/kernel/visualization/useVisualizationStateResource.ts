"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

import { VISUALIZATION_STATE_PATH } from "../api/apiPaths";
import type { VisualizationStateResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import { useResource } from "../resources/useResource";

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
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.visualization.state({ signal }),
    [api],
  );
  useSyncExternalStore(
    (onStoreChange) => visualizationSync.subscribe(onStoreChange),
    () => visualizationSync.getSnapshot().version,
    () => visualizationSync.getSnapshot().version,
  );

  const resource = useResource({
    enabled,
    load,
    resolveRevision: resolveVisualizationStateRevision,
    resourceKey: VISUALIZATION_STATE_RESOURCE_KEY,
  });

  useEffect(() => {
    visualizationSync.observeRemoteState(resource.data);
    cameraRegistry.observeRemoteState(resource.data);
    if (resource.data) {
      visualization.acknowledgePendingTargetPatches(resource.data);
    }
  }, [cameraRegistry, resource.data, visualization, visualizationSync]);

  const optimisticData = visualizationSync.applyOptimisticState(resource.data);

  return {
    ...resource,
    data: optimisticData,
    rawData: resource.data,
  };
}
