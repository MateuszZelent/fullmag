"use client";

import { useCallback } from "react";

import { VISUALIZATION_CLIENT_ACKS_PATH } from "../api/apiPaths";
import type { VisualizationClientAckResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import { useResource } from "../resources/useResource";

export const VISUALIZATION_CLIENT_ACKS_RESOURCE_KEY =
  VISUALIZATION_CLIENT_ACKS_PATH;

export function resolveVisualizationClientAcksRevision(
  resource: VisualizationClientAckResource,
): number {
  return resource.revision;
}

export function useVisualizationClientAcksResource({
  enabled = true,
}: { enabled?: boolean } = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.visualization.acks({ signal }),
    [api],
  );

  return useResource<VisualizationClientAckResource>({
    enabled,
    load,
    resolveRevision: resolveVisualizationClientAcksRevision,
    resourceKey: VISUALIZATION_CLIENT_ACKS_RESOURCE_KEY,
  });
}
