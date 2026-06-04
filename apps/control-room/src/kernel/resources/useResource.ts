"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { ResourceRevision } from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import {
  sharedResourceRuntimeStore,
  type ResourceRuntimeSnapshot,
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
  minRefetchIntervalMs?: number;
  resolveRevision?: (data: TData) => ResourceRevision | null;
  resourceKey: ResourceKey;
}

interface UseResourceSelectorOptions<TData, TSelected>
  extends UseResourceOptions<TData> {
  isEqual?: (previous: TSelected, next: TSelected) => boolean;
  selector: (resource: ResourceResult<TData>) => TSelected;
}

/** Minimum delay before retrying after a network/fetch error (ms). */
const ERROR_RETRY_DELAY_MS = 1_000;
const NOOP_SUBSCRIBE = () => undefined;

export function useResource<TData>({
  enabled = true,
  load,
  minRefetchIntervalMs,
  resolveRevision,
  resourceKey,
}: UseResourceOptions<TData>): ResourceResult<TData> {
  const { resources } = useKernel();
  const runtimeStore = sharedResourceRuntimeStore as ResourceRuntimeStore<TData>;

  // Stabilize the subscribe callback so useSyncExternalStore doesn't
  // unsubscribe/resubscribe on every render.
  const subscribeStable = useCallback(
    (onStoreChange: () => void) =>
      enabled
        ? resources.subscribe(resourceKey, onStoreChange)
        : NOOP_SUBSCRIBE,
    [enabled, resources, resourceKey],
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
      enabled
        ? runtimeStore.subscribe(resourceKey, onStoreChange)
        : NOOP_SUBSCRIBE,
    [enabled, resourceKey, runtimeStore],
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

  useResourceLoader({
    enabled,
    errorCountRef,
    externalRevision,
    load,
    minRefetchIntervalMs,
    refreshToken,
    resolveRevision,
    resourceKey,
    runtimeStore,
  });

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

export function useResourceSelector<TData, TSelected>({
  enabled = true,
  isEqual = Object.is,
  load,
  minRefetchIntervalMs,
  resolveRevision,
  resourceKey,
  selector,
}: UseResourceSelectorOptions<TData, TSelected>): TSelected {
  const { resources } = useKernel();
  const runtimeStore = sharedResourceRuntimeStore as ResourceRuntimeStore<TData>;
  const [refreshToken, setRefreshToken] = useState(0);
  const errorCountRef = useRef(0);
  const selectedRef = useRef<{ selected: TSelected } | null>(null);

  const subscribeStable = useCallback(
    (onStoreChange: () => void) =>
      enabled
        ? resources.subscribe(resourceKey, onStoreChange)
        : NOOP_SUBSCRIBE,
    [enabled, resources, resourceKey],
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

  const refetch = useCallback(() => {
    errorCountRef.current = 0;
    setRefreshToken((current) => current + 1);
  }, []);

  const subscribeRuntime = useCallback(
    (onStoreChange: () => void) =>
      enabled
        ? runtimeStore.subscribe(resourceKey, onStoreChange)
        : NOOP_SUBSCRIBE,
    [enabled, resourceKey, runtimeStore],
  );
  const getRuntimeSelectedSnapshot = useCallback(() => {
    const state = runtimeStore.getSnapshot<TData>(resourceKey);
    const visibleState = visibleResourceResult({
      enabled,
      externalRevision,
      refetch,
      resourceKey,
      state,
    });
    const selected = selector(visibleState);
    const previous = selectedRef.current;
    if (previous && isEqual(previous.selected, selected)) {
      return previous.selected;
    }

    selectedRef.current = { selected };
    return selected;
  }, [
    enabled,
    externalRevision,
    isEqual,
    refetch,
    resourceKey,
    runtimeStore,
    selector,
  ]);

  const selected = useSyncExternalStore(
    subscribeRuntime,
    getRuntimeSelectedSnapshot,
    getRuntimeSelectedSnapshot,
  );

  useResourceLoader({
    enabled,
    errorCountRef,
    externalRevision,
    load,
    minRefetchIntervalMs,
    refreshToken,
    resolveRevision,
    resourceKey,
    runtimeStore,
  });

  return selected;
}

function useResourceLoader<TData>({
  enabled,
  errorCountRef,
  externalRevision,
  load,
  minRefetchIntervalMs = 0,
  refreshToken,
  resolveRevision,
  resourceKey,
  runtimeStore,
}: {
  enabled: boolean;
  errorCountRef: { current: number };
  externalRevision: ResourceRevision | null;
  load: (context: LoadContext) => Promise<TData>;
  minRefetchIntervalMs?: number;
  refreshToken: number;
  resolveRevision?: (data: TData) => ResourceRevision | null;
  resourceKey: ResourceKey;
  runtimeStore: ResourceRuntimeStore<TData>;
}): void {
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
          minRefetchIntervalMs,
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
    errorCountRef,
    externalRevision,
    load,
    minRefetchIntervalMs,
    refreshToken,
    resolveRevision,
    resourceKey,
    runtimeStore,
  ]);
}

function visibleResourceResult<TData>({
  enabled,
  externalRevision,
  refetch,
  resourceKey,
  state,
}: {
  enabled: boolean;
  externalRevision: ResourceRevision | null;
  refetch: () => void;
  resourceKey: ResourceKey;
  state: ResourceRuntimeSnapshot<TData>;
}): ResourceResult<TData> {
  if (!enabled) {
    return {
      data: null,
      error: null,
      refetch,
      revision: externalRevision,
      status: "idle",
    };
  }

  const settledForCurrentResource =
    state.settledResourceKey === resourceKey &&
    (state.settledExternalRevision === externalRevision ||
      state.revision === externalRevision);
  const visibleState = settledForCurrentResource
    ? state
    : markResourceLoading(state, externalRevision);

  return { ...visibleState, refetch };
}
