"use client";

import { useCallback } from "react";

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
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.visualization.state({ signal }),
    [api],
  );

  return useResource({
    enabled,
    load,
    resolveRevision: resolveVisualizationStateRevision,
    resourceKey: VISUALIZATION_STATE_RESOURCE_KEY,
  });
}
