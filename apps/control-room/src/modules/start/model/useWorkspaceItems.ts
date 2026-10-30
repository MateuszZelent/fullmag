"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WorkspaceItemsQuery } from "@/kernel/api/apiTypes";
import { parseApiWorkspaceItem, type ApiWorkspaceItem } from "@/kernel/api/workspaceItems";
import { useKernel } from "@/kernel/KernelContext";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";
import { useResource } from "@/kernel/resources/useResource";
import {
  ALL_ITEMS_QUERY,
  WORKSPACE_API_UNAVAILABLE,
  WORKSPACE_RESOURCE_PREFIX,
  isRouteMissing,
  useFocusRefetch,
  useWorkspaceItemsResource,
  type WorkspaceApiListState,
} from "@/kernel/resources/workspaceItemsResource";

import { parseFramesPage, type FramesPage } from "./framesModel";
import {
  parseApiItemDetailAnswer,
  parseApiScanReport,
  type ApiItemDetailAnswer,
  type ApiItemKind,
  type ApiScanReport,
} from "./workspaceApiTypes";

export {
  ALL_ITEMS_QUERY,
  FOCUS_REFETCH_MIN_MS,
  WORKSPACE_API_UNAVAILABLE,
  WORKSPACE_RESOURCE_PREFIX,
  WORKSPACE_ROOTS_RESOURCE_KEY,
  focusRefetchDue,
  isRouteMissing,
  listStateFromResource,
  nextWorkspaceRevision,
  workspaceItemsResourceKey,
} from "@/kernel/resources/workspaceItemsResource";
export type { WorkspaceApiListState } from "@/kernel/resources/workspaceItemsResource";

export type WorkspaceItemDetailState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly answer: ApiItemDetailAnswer }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "error"; readonly message: string };

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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

export const workspaceItemDetailResourceKey = (id: string): string =>
  `${WORKSPACE_RESOURCE_PREFIX}item:${encodeURIComponent(id)}`;

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
  /** One page of a result folder's saved-frame index; rejects with a readable message. */
  readonly loadFrames: (id: string, from: number, limit: number) => Promise<FramesPage>;
  /** True while a scan is running. */
  readonly scanning: boolean;
}

export function useWorkspaceItems(query: WorkspaceItemsQuery = ALL_ITEMS_QUERY): WorkspaceItemsController {
  const { api } = useKernel();
  const { state, refresh, invalidate } = useWorkspaceItemsResource(query);
  const [announcement, setAnnouncement] = useState("");
  const [scanning, setScanning] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

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
  const loadFrames = useCallback(
    async (id: string, from: number, limit: number) => {
      const page = parseFramesPage(await api.workspace.frames(id, from, limit));
      if (!page) throw new Error("The backend did not return a page of the frame index.");
      return page;
    },
    [api],
  );

  return {
    state,
    announcement,
    refresh,
    pin,
    forget,
    scan,
    addByPath,
    thumbnailUrl,
    archiveUrl,
    loadFrames,
    scanning,
  };
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
