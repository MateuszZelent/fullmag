"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WorkspaceItemsQuery } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";
import { useResource } from "@/kernel/resources/useResource";

import {
  parseApiItemDetailAnswer,
  parseApiScanReport,
  parseApiWorkspaceItem,
  parseApiWorkspaceList,
  type ApiItemDetailAnswer,
  type ApiItemKind,
  type ApiScanReport,
  type ApiWorkspaceItem,
  type ApiWorkspaceList,
} from "./workspaceApiTypes";

/**
 * The workspace database over the HTTP API, read through the repo's resource
 * layer: one cached resource per query, refetched when something invalidates
 * the `workspace:` prefix (a pin, a forget, a scan), when the window regains
 * focus and when it becomes visible. There is no timer.
 *
 * A backend that predates the routes answers 404/405/501; that is the
 * `unavailable` state, which the start screen answers by falling back to the
 * desktop host's own data. It is not an error.
 */

/** The list the start screen shows: everything, newest first; sorting and search run on the client. */
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

export type WorkspaceApiListState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly list: ApiWorkspaceList }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "error"; readonly message: string };

export type WorkspaceItemDetailState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly answer: ApiItemDetailAnswer }
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

export function detailStateFromResource(
  resource: Pick<ResourceResult<ApiItemDetailAnswer>, "data" | "error" | "status">,
  enabled: boolean,
): WorkspaceItemDetailState {
  if (!enabled || resource.status === "idle") return { kind: "idle" };
  if (resource.data) return { kind: "ready", answer: resource.data };
  if (resource.status === "error" && resource.error) {
    // A 404 here is "no such item" as often as "no such route"; both mean the
    // detail cannot be shown, and the row's own facts still are.
    return isRouteMissing(resource.error)
      ? { kind: "unavailable", reason: WORKSPACE_API_UNAVAILABLE }
      : { kind: "error", message: describe(resource.error) };
  }
  return { kind: "loading" };
}

/** True when enough time passed since the last read for a focus event to count. */
export function focusRefetchDue(now: number, lastRead: number): boolean {
  return now - lastRead >= FOCUS_REFETCH_MIN_MS;
}

let invalidationSequence = 0;
export const nextWorkspaceRevision = (): number => {
  invalidationSequence += 1;
  return invalidationSequence;
};

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

export const workspaceItemDetailResourceKey = (id: string): string =>
  `${WORKSPACE_RESOURCE_PREFIX}item:${encodeURIComponent(id)}`;

export const WORKSPACE_ROOTS_RESOURCE_KEY = `${WORKSPACE_RESOURCE_PREFIX}roots`;

/** Refetches when the window regains focus or becomes visible, merging bursts. */
function useFocusRefetch(refetch: () => void, enabled: boolean): void {
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

export interface WorkspaceItemsController {
  readonly state: WorkspaceApiListState;
  /** Result of the last action, for an aria-live region. */
  readonly announcement: string;
  readonly refresh: () => void;
  /** Each action resolves to a failure message, or null on success. */
  readonly pin: (id: string, pinned: boolean) => Promise<string | null>;
  readonly forget: (id: string) => Promise<string | null>;
  readonly scan: (
    roots?: readonly string[],
  ) => Promise<{ readonly report: ApiScanReport } | { readonly failure: string }>;
  /** Adds one existing absolute path to the database and re-reads the list. */
  readonly addByPath: (
    path: string,
    kind?: ApiItemKind,
  ) => Promise<{ readonly item: ApiWorkspaceItem } | { readonly failure: string }>;
  readonly thumbnailUrl: (id: string) => string;
  /** URL that downloads a result folder as a zip; only result items have one. */
  readonly archiveUrl: (id: string) => string;
  /** True while a scan is running. */
  readonly scanning: boolean;
}

export function useWorkspaceItems(query: WorkspaceItemsQuery = ALL_ITEMS_QUERY): WorkspaceItemsController {
  const { api, resources } = useKernel();
  const queryKey = workspaceItemsResourceKey(query);
  const [announcement, setAnnouncement] = useState("");
  const [scanning, setScanning] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.workspace.items(query, { signal }).then(parseApiWorkspaceList),
    // The key is the identity of the query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, queryKey],
  );

  const resource = useResource<ApiWorkspaceList>({
    abortStaleInflight: true,
    load,
    resourceKey: queryKey,
    retryPolicy: null,
  });
  const { refetch } = resource;
  useFocusRefetch(refetch, true);

  const state = useMemo(
    () => listStateFromResource(resource),
    // `resource` changes identity on every render; only these fields matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resource.data, resource.error, resource.status],
  );

  const invalidate = useCallback(() => {
    resources.invalidatePrefix(WORKSPACE_RESOURCE_PREFIX, nextWorkspaceRevision());
  }, [resources]);

  const act = useCallback(
    async (run: () => Promise<unknown>, failure: string, done: string): Promise<string | null> => {
      try {
        await run();
      } catch (error) {
        const message = `${failure}: ${describe(error)}`;
        if (alive.current) setAnnouncement(message);
        return message;
      }
      if (alive.current) setAnnouncement(done);
      invalidate();
      return null;
    },
    [invalidate],
  );

  const pin = useCallback(
    (id: string, pinned: boolean) =>
      act(
        () => api.workspace.setPinned(id, pinned),
        "Could not change the pin",
        pinned ? "Pinned." : "Unpinned.",
      ),
    [act, api],
  );

  const forget = useCallback(
    (id: string) =>
      act(() => api.workspace.forget(id), "Could not remove the item from recent", "Removed from recent."),
    [act, api],
  );

  const scan = useCallback(
    async (roots?: readonly string[]) => {
      setScanning(true);
      setAnnouncement("Scanning the indexed locations.");
      try {
        const report = parseApiScanReport(await api.workspace.scan(roots));
        if (alive.current) {
          setAnnouncement(
            `Scan finished: ${report.added} added, ${report.updated} updated, ${report.missing} missing.`,
          );
        }
        invalidate();
        return { report };
      } catch (error) {
        const failure = `The scan failed: ${describe(error)}`;
        if (alive.current) setAnnouncement(failure);
        return { failure };
      } finally {
        if (alive.current) setScanning(false);
      }
    },
    [api, invalidate],
  );

  const addByPath = useCallback(
    async (path: string, kind?: ApiItemKind) => {
      try {
        const item = parseApiWorkspaceItem(await api.workspace.addItem(path, kind));
        if (!item) throw new Error("The backend did not describe the added item.");
        if (alive.current) setAnnouncement(`Added ${item.name}.`);
        invalidate();
        return { item };
      } catch (error) {
        const failure = `Could not add ${path}: ${describe(error)}`;
        if (alive.current) setAnnouncement(failure);
        return { failure };
      }
    },
    [api, invalidate],
  );

  const thumbnailUrl = useCallback((id: string) => api.workspace.thumbnailUrl(id), [api]);
  const archiveUrl = useCallback((id: string) => api.workspace.archiveUrl(id), [api]);

  return { state, announcement, refresh: refetch, pin, forget, scan, addByPath, thumbnailUrl, archiveUrl, scanning };
}

/**
 * Detail of one item: the file read by the backend, its events and the items
 * linked to it. Idle while nothing is selected. It refetches with the list
 * (same invalidation prefix) and on focus.
 */
export function useWorkspaceItemDetail(id: string | null): WorkspaceItemDetailState {
  const { api } = useKernel();
  const enabled = id !== null;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => {
      if (id === null) return Promise.reject(new Error("No item is selected."));
      return api.workspace.item(id, { signal }).then(parseApiItemDetailAnswer);
    },
    [api, id],
  );
  const resource = useResource<ApiItemDetailAnswer>({
    abortStaleInflight: true,
    enabled,
    load,
    resourceKey: workspaceItemDetailResourceKey(id ?? ""),
    retryPolicy: null,
  });
  useFocusRefetch(resource.refetch, enabled);
  return useMemo(
    () => detailStateFromResource(resource, enabled),
    // `resource` changes identity on every render; only these fields matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resource.data, resource.error, resource.status, enabled],
  );
}
