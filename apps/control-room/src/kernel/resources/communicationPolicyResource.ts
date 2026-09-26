"use client";

import { useCallback } from "react";

import { SESSION_EVENTS_COMMUNICATION_POLICY_PATH } from "../api/apiPaths";
import type { RealtimeCommunicationPolicyResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import { useResource } from "./useResource";
import { useSessionScopedResourceKey } from "./useSessionScopedResourceKey";

export const COMMUNICATION_POLICY_RESOURCE_KEY =
  SESSION_EVENTS_COMMUNICATION_POLICY_PATH;

export function useCommunicationPolicyResource(
  options: { enabled?: boolean } = {},
) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    COMMUNICATION_POLICY_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.events.communicationPolicy({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<RealtimeCommunicationPolicyResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: (data) => data.revision,
    resourceKey,
  });
}
