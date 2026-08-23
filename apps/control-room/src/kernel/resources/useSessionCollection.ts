"use client";

import { useCallback } from "react";

import { SESSIONS_PATH } from "../api/apiPaths";
import type { SessionListResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import type { ResourceResult } from "./resourceTypes";
import { useResource } from "./useResource";

export type SessionCollectionState = "error" | "loading" | "no-session" | "ready";

export function resolveSessionCollectionState(
  collection: SessionListResource,
): Exclude<SessionCollectionState, "error" | "loading"> {
  return collection.sessions.length > 0 ? "ready" : "no-session";
}

export function useSessionCollection(): {
  readonly resource: ResourceResult<SessionListResource>;
  readonly state: SessionCollectionState;
} {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.sessions.list({ signal }),
    [api],
  );
  const resource = useResource<SessionListResource>({
    load,
    resolveRevision: () => null,
    resourceKey: SESSIONS_PATH,
  });
  const state =
    resource.status === "error"
      ? "error"
      : resource.data
        ? resolveSessionCollectionState(resource.data)
        : "loading";

  return { resource, state };
}
