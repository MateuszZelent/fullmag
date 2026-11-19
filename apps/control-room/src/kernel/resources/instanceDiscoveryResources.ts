"use client";

import { useCallback, useEffect } from "react";

import { PLATFORM_INSTANCES_PATH } from "../api/apiPaths";
import type { InstanceDiscoveryResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import type { ResourceResult } from "./resourceTypes";
import { useResource } from "./useResource";

/** Refresh cadence while instance status is on screen (Home or an instance tab). */
export const INSTANCE_DISCOVERY_REFRESH_MS = 5_000;

// Several components mount discovery at once (tab strip, frames, route sync).
// A forced refetch aborts the request in flight, so a visibility change must
// trigger one shared refresh, not one per consumer.
const SHARED_REFRESH_DEBOUNCE_MS = 1_000;
let lastSharedRefreshAtMs = Number.NEGATIVE_INFINITY;

function claimSharedRefresh(nowMs: number): boolean {
  if (nowMs - lastSharedRefreshAtMs < SHARED_REFRESH_DEBOUNCE_MS) return false;
  lastSharedRefreshAtMs = nowMs;
  return true;
}

export interface InstanceDiscoveryOptions {
  readonly enabled?: boolean;
  /**
   * Keep instance status current while it is on screen (one owner per page).
   * Otherwise discovery loads once and again when the page becomes visible,
   * so an idle workspace issues no requests.
   */
  readonly live?: boolean;
}

/**
 * Fullmag instances on this host (ADR 0069). Discovery runs in the backend, so
 * closed ports never reach the browser console.
 */
export function useInstanceDiscovery({
  enabled = true,
  live = false,
}: InstanceDiscoveryOptions = {}): ResourceResult<InstanceDiscoveryResource> {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.platform.instances({ signal }),
    [api],
  );
  const resource = useResource<InstanceDiscoveryResource>({
    enabled,
    load,
    // Every discovery probes the whole port window; shared refreshes of the
    // page must not run it more often than the strip's own cadence.
    minRefetchIntervalMs: INSTANCE_DISCOVERY_REFRESH_MS,
    notifyOnError: false,
    resolveRevision: () => null,
    resourceKey: PLATFORM_INSTANCES_PATH,
  });
  const refetch = resource.refetch;
  useEffect(() => {
    if (!enabled) return;
    const refreshVisible = () => {
      if (document.visibilityState === "visible" && claimSharedRefresh(Date.now())) {
        refetch();
      }
    };
    document.addEventListener("visibilitychange", refreshVisible);
    const timer = live ? window.setInterval(refreshVisible, INSTANCE_DISCOVERY_REFRESH_MS) : undefined;
    return () => {
      document.removeEventListener("visibilitychange", refreshVisible);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [enabled, live, refetch]);
  return resource;
}
