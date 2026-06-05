"use client";

import { useCallback } from "react";

import { SESSION_EVENTS_COMMUNICATION_POLICY_PATH } from "../api/apiPaths";
import type { RealtimeCommunicationPolicyResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import { useResource } from "./useResource";

export const COMMUNICATION_POLICY_RESOURCE_KEY =
  SESSION_EVENTS_COMMUNICATION_POLICY_PATH;

export function useCommunicationPolicyResource(
  options: { enabled?: boolean } = {},
) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.events.communicationPolicy({ signal }),
    [api],
  );

  return useResource<RealtimeCommunicationPolicyResource>({
    enabled: options.enabled,
    load,
    resolveRevision: (data) => data.revision,
    resourceKey: COMMUNICATION_POLICY_RESOURCE_KEY,
  });
}
