"use client";

import { useCallback } from "react";

import type { LiveStatusResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import { useResource } from "./useResource";

export const SESSION_STATUS_RESOURCE_KEY = "session:status";

export function useSessionStatus() {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.sessions.current.status({ signal }),
    [api],
  );
  const resolveRevision = useCallback((status: LiveStatusResource) => {
    return status.resources.session ?? status.resources.status ?? null;
  }, []);

  return useResource({
    load,
    resolveRevision,
    resourceKey: SESSION_STATUS_RESOURCE_KEY,
  });
}
