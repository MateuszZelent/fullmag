"use client";

import { useCallback } from "react";

import type { LiveStatusResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import { useResource } from "./useResource";

export const SESSION_STATUS_RESOURCE_KEY = "session:status";

export function resolveSessionStatusRevision(
  status: LiveStatusResource,
): number | null {
  const revisions = Object.values(status.resources).filter(
    (revision): revision is number => typeof revision === "number",
  );

  return revisions.length > 0 ? Math.max(...revisions) : null;
}

export function useSessionStatus() {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.sessions.current.status({ signal }),
    [api],
  );

  return useResource({
    load,
    resolveRevision: resolveSessionStatusRevision,
    resourceKey: SESSION_STATUS_RESOURCE_KEY,
  });
}
