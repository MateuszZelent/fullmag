"use client";

import { useCallback } from "react";

import { VISUALIZATION_CLIENT_ACKS_PATH } from "../api/apiPaths";
import type { VisualizationClientAckResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import { useResource } from "../resources/useResource";
import { useSessionScopedResourceKey } from "../resources/useSessionScopedResourceKey";

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
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    VISUALIZATION_CLIENT_ACKS_RESOURCE_KEY,
  );
  const load = useCallback(
    ({
      sessionScopeKey,
      signal,
    }: {
      sessionScopeKey?: string;
      signal: AbortSignal;
    }) => api.visualization.acks({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<VisualizationClientAckResource>({
    enabled: enabled && sessionIdentity !== null,
    load,
    resolveRevision: resolveVisualizationClientAcksRevision,
    resourceKey,
  });
}
