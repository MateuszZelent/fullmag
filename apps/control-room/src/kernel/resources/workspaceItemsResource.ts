"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";

import type { WorkspaceItemsQuery } from "@/kernel/api/apiTypes";
import {
  parseApiWorkspaceList,
  type ApiWorkspaceList,
} from "@/kernel/api/workspaceItems";
import { useKernel } from "@/kernel/KernelContext";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";
import { useResource } from "@/kernel/resources/useResource";

/** The list the start screen and Saved Results browser can share. */
export const ALL_ITEMS_QUERY: WorkspaceItemsQuery = {
  kind: "all",
  sort: "last_used",
  limit: 500,
  includeMissing: true,
};

export const WORKSPACE_RESOURCE_PREFIX = "workspace:";
/** Focus events closer together than this share one refetch. */
export const FOCUS_REFETCH_MIN_MS = 750;
export const WORKSPACE_API_UNAVAILABLE =
  "This backend does not serve the workspace database yet.";

/** True when enough time passed since the last read for a focus event to count. */
export function focusRefetchDue(now: number, lastRead: number): boolean {
  return now - lastRead >= FOCUS_REFETCH_MIN_MS;
}

export type WorkspaceApiListState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly list: ApiWorkspaceList }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "error"; readonly message: string };

/** The status codes of a server that does not know the route. */
export function isRouteMissing(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("status" in error)) return false;
  const { status } = error as { status: unknown };
  return status === 404 || status === 405 || status === 501;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function listStateFromResource(
  resource: Pick<ResourceResult<ApiWorkspaceList>, "data" | "error" | "status">,
): WorkspaceApiListState {
  // A failed re-read keeps the list that is already on screen.
  if (resource.data) return { kind: "ready", list: resource.data };
  if (resource.status === "error" && resource.error) {
    return isRouteMissing(resource.error)
      ? { kind: "unavailable", reason: WORKSPACE_API_UNAVAILABLE }
      : { kind: "error", message: describe(resource.error) };
  }
  return { kind: "loading" };
}

export function workspaceItemsResourceKey(query: WorkspaceItemsQuery): string {
  const parts = [
    `kind=${query.kind ?? "all"}`,
    `sort=${query.sort ?? "last_used"}`,
    `search=${encodeURIComponent(query.search ?? "")}`,
    `limit=${query.limit ?? ""}`,
    `missing=${query.includeMissing === undefined ? "" : String(query.includeMissing)}`,
  ];
  return `${WORKSPACE_RESOURCE_PREFIX}items?${parts.join("&")}`;
}

export const WORKSPACE_ROOTS_RESOURCE_KEY = `${WORKSPACE_RESOURCE_PREFIX}roots`;

let invalidationSequence = 0;
export const nextWorkspaceRevision = (): number => {
  invalidationSequence += 1;
  return invalidationSequence;
};

/** Refetches when the window regains focus or becomes visible, merging bursts. */
export function useFocusRefetch(refetch: () => void, enabled: boolean): void {
  const lastRead = useRef(0);
  const refetchLatest = useRef(refetch);
  useEffect(() => {
    refetchLatest.current = refetch;
  }, [refetch]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return undefined;
    lastRead.current = Date.now();
    const onFocus = () => {
      const now = Date.now();
      if (!focusRefetchDue(now, lastRead.current)) return;
      lastRead.current = now;
      refetchLatest.current();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") onFocus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);
}

export interface WorkspaceItemsResourceController {
  readonly state: WorkspaceApiListState;
  readonly refresh: () => void;
  /** Invalidate all workspace list/detail resources after a mutation. */
  readonly invalidate: () => void;
}

/**
 * Shared workspace-item list resource. Start and Results use the same query
 * key and invalidation prefix, so they cannot observe different list caches.
 */
export function useWorkspaceItemsResource(
  query: WorkspaceItemsQuery = ALL_ITEMS_QUERY,
): WorkspaceItemsResourceController {
  const { api, resources } = useKernel();
  const queryKey = workspaceItemsResourceKey(query);
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.workspace.items(query, { signal }).then(parseApiWorkspaceList),
    // The key is the identity of the query; avoid reloading for an equivalent
    // object supplied by a caller on a later render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, queryKey],
  );
  const resource = useResource<ApiWorkspaceList>({
    abortStaleInflight: true,
    load,
    resourceKey: queryKey,
    retryPolicy: null,
  });
  useFocusRefetch(resource.refetch, true);

  const state = useMemo(
    () => listStateFromResource(resource),
    // `resource` changes identity on every render; only these fields matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resource.data, resource.error, resource.status],
  );
  const invalidate = useCallback(() => {
    resources.invalidatePrefix(WORKSPACE_RESOURCE_PREFIX, nextWorkspaceRevision());
  }, [resources]);

  return { state, refresh: resource.refetch, invalidate };
}
