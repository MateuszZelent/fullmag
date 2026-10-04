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

/**
 * Keep a confirmed collection authoritative while a later refresh is failing.
 * The resource retains its last data on refresh errors; dropping the shell in
 * that state would turn a transport interruption into a destructive UI reset.
 */
export function resolveSessionCollectionResourceState(
  resource: Pick<ResourceResult<SessionListResource>, "data" | "status">,
): SessionCollectionState {
  if (resource.data) return resolveSessionCollectionState(resource.data);
  return resource.status === "error" ? "error" : "loading";
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
  const state = resolveSessionCollectionResourceState(resource);

  return { resource, state };
}
