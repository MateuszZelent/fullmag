"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { ResourceRevision } from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import {
  sharedResourceRuntimeStore,
  type ResourceRuntimeStore,
} from "./ResourceRuntimeStore";
import type { ResourceKey, ResourceResult } from "./resourceTypes";
import { markResourceLoading } from "./resourceState";

interface LoadContext {
  signal: AbortSignal;
}

interface UseResourceOptions<TData> {
  enabled?: boolean;
  load: (context: LoadContext) => Promise<TData>;
  resolveRevision?: (data: TData) => ResourceRevision | null;
  resourceKey: ResourceKey;
}

/** Minimum delay before retrying after a network/fetch error (ms). */
const ERROR_RETRY_DELAY_MS = 1_000;

export function useResource<TData>({
  enabled = true,
  load,
  resolveRevision,
  resourceKey,
}: UseResourceOptions<TData>): ResourceResult<TData> {
  const { resources } = useKernel();
  const runtimeStore = sharedResourceRuntimeStore as ResourceRuntimeStore<TData>;

  // Stabilize the subscribe callback so useSyncExternalStore doesn't
  // unsubscribe/resubscribe on every render.
  const subscribeStable = useCallback(
    (onStoreChange: () => void) =>
      resources.subscribe(resourceKey, onStoreChange),
    [resources, resourceKey],
  );
  const getSnapshot = useCallback(
    () => resources.getRevision(resourceKey),
    [resources, resourceKey],
  );

  const externalRevision = useSyncExternalStore(
    subscribeStable,
    getSnapshot,
    getSnapshot,
  );

  const subscribeRuntime = useCallback(
    (onStoreChange: () => void) =>
      runtimeStore.subscribe(resourceKey, onStoreChange),
    [resourceKey, runtimeStore],
  );
  const getRuntimeSnapshot = useCallback(
    () => runtimeStore.getSnapshot(resourceKey),
    [resourceKey, runtimeStore],
  );
  const state = useSyncExternalStore(
    subscribeRuntime,
    getRuntimeSnapshot,
    getRuntimeSnapshot,
  );
  const [refreshToken, setRefreshToken] = useState(0);

  // Track consecutive errors to apply backoff before retrying.
  const errorCountRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    // If the last attempt failed, wait before retrying to avoid
    // a hot render loop when the backend is unreachable.
    const delay = errorCountRef.current > 0 ? ERROR_RETRY_DELAY_MS : 0;
    const timeoutId = setTimeout(() => {
      runtimeStore
        .ensureLoad({
          externalRevision,
          force: refreshToken > 0,
          load,
          resolveRevision,
          resourceKey,
        })
        .then((snapshot) => {
          if (cancelled) return;
          errorCountRef.current =
            snapshot.status === "error" ? errorCountRef.current + 1 : 0;
        });
    }, delay);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [
    enabled,
    externalRevision,
    load,
    refreshToken,
    resolveRevision,
    resourceKey,
    runtimeStore,
  ]);

  const refetch = useCallback(() => {
    errorCountRef.current = 0;
    setRefreshToken((current) => current + 1);
  }, []);

  const settledForCurrentResource =
    state.settledResourceKey === resourceKey &&
    (state.settledExternalRevision === externalRevision ||
      state.revision === externalRevision);
  if (!enabled) {
    return {
      data: null,
      error: null,
      refetch,
      revision: externalRevision,
      status: "idle",
    };
  }

  const visibleState = settledForCurrentResource
    ? state
    : markResourceLoading(state, externalRevision);

  return { ...visibleState, refetch };
}
