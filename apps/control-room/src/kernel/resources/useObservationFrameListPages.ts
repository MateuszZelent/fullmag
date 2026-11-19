"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { DATA_OBSERVATION_FRAMES_PATH } from "../api/apiPaths";
import type { ObservationFrameListResource, ObservationFrameResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import { createResourcePartialLoadError } from "./ResourceRuntimeStore";
import {
  loadObservationFrameWindow,
  mergeObservationFramePages,
  validateObservationFramePage,
} from "./observationFramePagination";
import {
  observationFrameListQuery,
  observationFrameListResourceKey,
  observationFrameListRevision,
} from "./observationFrameResources";
import type { ResourceStatus } from "./resourceTypes";
import { useResource } from "./useResource";
import { useSessionScopedResourceKey } from "./useSessionScopedResourceKey";

type Operation = "append" | "refresh";

interface Request {
  kind: Operation;
  acknowledgement: object;
  previousError: Error | null;
}

interface PageWindow {
  acknowledgement: object | null;
  pages: ObservationFrameListResource[] | null;
}

interface PageView {
  owner: string;
  pages: ObservationFrameListResource[];
  retained: ObservationFrameResource | null;
  observed: PageWindow | null;
  request: Request | null;
  failed: Operation | null;
  error: Error | null;
}

export function useObservationFrameListPages({
  enabled = true,
  runId,
  selectedFrameId = null,
}: {
  enabled?: boolean;
  runId: string | null;
  selectedFrameId?: string | null;
}) {
  const { api } = useKernel();
  const query = useMemo(() => observationFrameListQuery({ runId, limit: 50 }), [runId]);
  // This cached value is a window of pages, so it cannot share the single-page
  // entry used by the Inspector. Operation identities never enter the key.
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    `${observationFrameListResourceKey(query)}&__fm_view=explorer-pages`,
  );
  const owner = JSON.stringify([api.resourceCacheScope, resourceKey]);
  const active = enabled && sessionIdentity !== null && Boolean(query.run_id);
  const initial = useMemo<PageView>(() => ({
    owner, pages: [], retained: null, observed: null, request: null, failed: null, error: null,
  }), [owner]);
  const [stored, setStored] = useState(initial);
  const view = stored.owner === owner ? stored : initial;
  const clickedOwner = useRef<string | null>(null);
  const resource = useResource<PageWindow>({
    abortStaleInflight: true,
    enabled: active,
    resourceKey,
    revisionKey: DATA_OBSERVATION_FRAMES_PATH,
    resolveRevision: (window) => observationFrameListRevision(
      mergeObservationFramePages(window.pages ?? [], null),
    ),
    load: async ({ sessionScopeKey, signal }) => {
      const acknowledgement = view.request?.acknowledgement ?? null;
      try {
        const pages = await loadObservationFrameWindow(view.pages, view.request?.kind === "append", async (cursor) => {
          const pageQuery = { ...query, cursor: cursor ?? undefined };
          const data = await api.data.observationFrames.list(pageQuery, { sessionScopeKey, signal });
          return validateObservationFramePage(data, pageQuery);
        });
        return { acknowledgement, pages };
      } catch (error) {
        if (signal.aborted) throw error;
        // The resource still reports a real load failure, with its diagnostic
        // metadata, but the pager can recognize the failed request's owner.
        throw createResourcePartialLoadError(
          error instanceof Error ? error.message : String(error),
          { acknowledgement, pages: null } satisfies PageWindow,
          error,
        );
      }
    },
  });

  const result = resource.data;
  const loadError = resource.error ?? resource.refreshError ?? null;
  const resourceError = loadError?.name === "ResourcePartialLoadError" && loadError.cause instanceof Error
    ? loadError.cause : loadError;
  const previousSelection = view.retained?.frame_id === selectedFrameId ? view.retained : null;
  // A ready resource can still represent the preceding cached result while
  // useResource schedules a manual refetch. Only the request's own acknowledgement
  // can replace the window or unblock pagination.
  let nextView = view;
  if (active && result && result !== view.observed &&
    (!view.request || result.acknowledgement === view.request.acknowledgement)) {
    if (result.pages && resource.status === "ready") {
      const selected = view.pages.flatMap((page) => page.frames)
        .find((frame) => frame.frame_id === selectedFrameId) ?? previousSelection;
      const retained = result.pages.at(-1)?.next_cursor &&
        !result.pages.some((page) => page.frames.some((frame) => frame.frame_id === selectedFrameId))
        ? selected : null;
      nextView = { ...view, pages: result.pages, retained, observed: result, request: null, failed: null, error: null };
    } else if (!result.pages && resourceError) {
      nextView = { ...view, observed: result, request: null, failed: view.request?.kind ?? "refresh", error: resourceError };
    }
  } else if (active && view.request && resourceError?.name === "TimeoutError" &&
    resourceError !== view.request.previousError) {
    nextView = { ...view, request: null, failed: view.request.kind, error: resourceError };
  }
  if (nextView.retained && nextView.retained.frame_id !== selectedFrameId) {
    nextView = { ...nextView, retained: null };
  }
  if (nextView !== view) setStored(nextView);

  useEffect(() => {
    if (!view.request && clickedOwner.current === owner) clickedOwner.current = null;
  }, [owner, view.request]);

  const data = useMemo(() => active ? mergeObservationFramePages(view.pages, previousSelection) : null, [active, view.pages, previousSelection]);
  const error = view.request ? null : view.error ?? resourceError;
  const loading = active && (view.request !== null || (!error && (resource.status === "loading" || resource.status === "stale")));
  const hasMore = Boolean(data?.next_cursor);
  const status: ResourceStatus = !active ? "idle" : error
    ? data ? "stale" : "error"
    : loading ? data ? "stale" : "loading"
    : resource.status;

  const start = (kind: Operation) => {
    if (!active || loading || clickedOwner.current === owner || (kind === "append" && !hasMore)) return;
    clickedOwner.current = owner;
    setStored({ ...view, request: { kind, acknowledgement: {}, previousError: resourceError }, failed: null, error: null });
    resource.refetch();
  };

  return {
    data,
    status,
    revision: observationFrameListRevision(data),
    error: data ? null : error,
    refreshError: data ? error : null,
    loading,
    hasMore,
    loadMore: () => start("append"),
    refetch: () => start("refresh"),
    retry: () => start(view.failed ?? "refresh"),
  };
}
