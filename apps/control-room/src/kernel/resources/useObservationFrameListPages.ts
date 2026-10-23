"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { useKernel } from "../KernelContext";
import {
  observationFrameListQuery, observationFrameListResourceKey, observationFrameListRevision,
  useObservationFrameListResource, type ObservationFrameListResourceOptions,
} from "./observationFrameResources";
import { acceptObservationFramePage, initialObservationFramePages, mergeObservationFramePages } from "./observationFramePagination";
import { useSessionScopedResourceKey } from "./useSessionScopedResourceKey";
import type { ResourceStatus } from "./resourceTypes";

/** Accumulate only explicitly requested pages, retaining selection during refresh. */
export function useObservationFrameListPages({
  enabled = true, limit = 50, runId = null, stageId = null,
}: Omit<ObservationFrameListResourceOptions, "cursor"> = {}) {
  const { api } = useKernel();
  const query = observationFrameListQuery({ limit, runId, stageId });
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(observationFrameListResourceKey(query));
  const owner = JSON.stringify([api.resourceCacheScope, resourceKey]);
  const initial = useMemo(() => initialObservationFramePages(owner), [owner]);
  const [stored, setStored] = useState(initial);
  const retryRequest = useRef<{ owner: string; error: Error | null } | null>(null);
  const [retryTicket, setRetryTicket] = useState<{ owner: string; error: Error | null } | null>(null);
  const state = stored.owner === owner ? stored : initial;
  const active = enabled && sessionIdentity !== null && Boolean(query.run_id);
  const page = useObservationFrameListResource({ enabled: active, limit, runId, stageId, cursor: state.cursor });
  const { data: pageData, status: pageStatus, refreshError: pageRefreshError, refetch: refetchPage } = page;

  const awaitingRequest = state.refresh?.awaitingRequest === true;

  // Adjust this hook's accumulator when its external resource snapshot changes.
  // Guarded render-time adjustment avoids a second committed stale projection.
  if (active && awaitingRequest && (pageStatus === "loading" || pageStatus === "stale")) {
    setStored({ ...state, refresh: { ...state.refresh!, awaitingRequest: false } });
  } else if (active && !awaitingRequest && pageStatus === "ready" && !pageRefreshError && pageData && state.rejectedPage !== pageData) {
    try {
      const next = acceptObservationFramePage(state, pageData);
      if (next !== state) setStored(next);
    } catch (error) {
      setStored({ ...state, error: error instanceof Error ? error : new Error(String(error)), rejectedPage: pageData });
    }
  }
  useEffect(() => {
    // A cached next page still needs a fresh read during bounded Refresh.
    if (active && awaitingRequest) refetchPage();
  }, [active, owner, state.cursor, awaitingRequest, refetchPage]);

  const data = useMemo(() => active ? mergeObservationFramePages(state.pages, state.retained) : null, [active, state.pages, state.retained]);
  const error = state.error ?? page.error ?? page.refreshError ?? null;
  const retrying = Boolean(error && retryTicket?.owner === owner && retryTicket.error === error);
  const pendingCursor = state.pages.at(-1)?.cursor !== state.cursor;
  const loading = active && (retrying || (!error && (Boolean(state.refresh) || pendingCursor || page.status === "loading" || page.status === "stale")));
  const status: ResourceStatus = !active ? "idle" : error ? data ? "stale" : "error" : loading ? data ? "stale" : "loading" : page.status;
  const hasMore = Boolean(data?.next_cursor);

  return {
    data, status, revision: observationFrameListRevision(data),
    error: data ? null : error, refreshError: data ? error : null,
    hasMore, loading,
    loadMore: () => {
      if (!active || loading || error || !data?.next_cursor) return;
      const cursor = data.next_cursor;
      setStored((previous) => {
        const current = previous.owner === owner ? previous : initial;
        if (current.refresh || current.cursor !== current.pages.at(-1)?.cursor) return previous;
        return { ...current, cursor, error: null };
      });
    },
    retry: () => {
      if (!active || (retryRequest.current?.owner === owner && retryRequest.current.error === error)) return;
      const ticket = { owner, error };
      retryRequest.current = ticket;
      setRetryTicket(ticket);
      setStored({ ...state, error: null, rejectedPage: null });
      refetchPage();
    },
    refetch: () => {
      if (!active) return;
      setStored({ ...state, cursor: null, refresh: { remaining: Math.max(1, state.pages.length), pages: [], awaitingRequest: true }, error: null, rejectedPage: null });
    },
  };
}
