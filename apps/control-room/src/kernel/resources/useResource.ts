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
import type { KernelApi } from "../types";
import { DIAGNOSTIC_EVENT_NAMES } from "../performance/diagnostic-recorder/diagnosticRecorderTypes";
import { errorRetryDelayMs } from "../realtime/communicationPolicy";

import {
  sharedResourceRuntimeStore,
  type ResourceRuntimeSnapshot,
  type ResourceRuntimeStore,
} from "./ResourceRuntimeStore";
import type { ResourceKey, ResourceResult } from "./resourceTypes";
import { markResourceLoading, type ResourceState } from "./resourceState";

interface LoadContext {
  signal: AbortSignal;
}

interface UseResourceOptions<TData> {
  abortStaleInflight?: boolean;
  enabled?: boolean;
  load: (context: LoadContext) => Promise<TData>;
  minRefetchIntervalMs?: number;
  pauseLoad?: boolean;
  resolveRevision?: (data: TData) => ResourceRevision | null;
  resourceKey: ResourceKey;
}

interface UseResourceSelectorOptions<TData, TSelected>
  extends UseResourceOptions<TData> {
  isEqual?: (previous: TSelected, next: TSelected) => boolean;
  selector: (resource: ResourceResult<TData>) => TSelected;
}

const NOOP_SUBSCRIBE = () => undefined;

export function useResource<TData>({
  abortStaleInflight = false,
  enabled = true,
  load,
  minRefetchIntervalMs,
  pauseLoad = false,
  resolveRevision,
  resourceKey,
}: UseResourceOptions<TData>): ResourceResult<TData> {
  const { diagnosticRecorder, resources } = useKernel();
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
  const [loadedRefreshToken, setLoadedRefreshToken] = useState(refreshToken);

  // Track consecutive errors to apply backoff before retrying.
  const errorCountRef = useRef(0);

  useResourceLoader({
    abortStaleInflight,
    diagnosticRecorder,
    enabled,
    errorCountRef,
    externalRevision,
    load,
    loadedRefreshToken,
    minRefetchIntervalMs,
    pauseLoad,
    refreshToken,
    resolveRevision,
    resourceKey,
    runtimeStore,
    setLoadedRefreshToken,
  });

  const refetch = useCallback(() => {
    errorCountRef.current = 0;
    setRefreshToken((current) => current + 1);
  }, []);

  if (!enabled) {
    return {
      data: null,
      error: null,
      refetch,
      revision: externalRevision,
      status: "idle",
    };
  }

  const visibleState = visibleResourceState({
    externalRevision,
    manualRefreshPending: refreshToken !== loadedRefreshToken,
    pauseLoad,
    resourceKey,
    state,
  });

  return { ...visibleState, refetch };
}

export function useResourceSelector<TData, TSelected>({
  abortStaleInflight = false,
  enabled = true,
  isEqual = Object.is,
  load,
  minRefetchIntervalMs,
  pauseLoad = false,
  resolveRevision,
  resourceKey,
  selector,
}: UseResourceSelectorOptions<TData, TSelected>): TSelected {
  const { diagnosticRecorder, resources } = useKernel();
  const runtimeStore = sharedResourceRuntimeStore as ResourceRuntimeStore<TData>;
  const [refreshToken, setRefreshToken] = useState(0);
  const [loadedRefreshToken, setLoadedRefreshToken] = useState(refreshToken);
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
      manualRefreshPending: refreshToken !== loadedRefreshToken,
      pauseLoad,
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
    loadedRefreshToken,
    pauseLoad,
    refetch,
    resourceKey,
    refreshToken,
    runtimeStore,
    selector,
  ]);

  const selected = useSyncExternalStore(
    subscribeRuntime,
    getRuntimeSelectedSnapshot,
    getRuntimeSelectedSnapshot,
  );

  useResourceLoader({
    abortStaleInflight,
    diagnosticRecorder,
    enabled,
    errorCountRef,
    externalRevision,
    load,
    loadedRefreshToken,
    minRefetchIntervalMs,
    pauseLoad,
    refreshToken,
    resolveRevision,
    resourceKey,
    runtimeStore,
    setLoadedRefreshToken,
  });

  return selected;
}

function useResourceLoader<TData>({
  abortStaleInflight = false,
  diagnosticRecorder,
  enabled,
  errorCountRef,
  externalRevision,
  load,
  loadedRefreshToken,
  minRefetchIntervalMs = 0,
  pauseLoad = false,
  refreshToken,
  resolveRevision,
  resourceKey,
  runtimeStore,
  setLoadedRefreshToken,
}: {
  abortStaleInflight?: boolean;
  diagnosticRecorder: KernelApi["diagnosticRecorder"];
  enabled: boolean;
  errorCountRef: { current: number };
  externalRevision: ResourceRevision | null;
  load: (context: LoadContext) => Promise<TData>;
  loadedRefreshToken: number;
  minRefetchIntervalMs?: number;
  pauseLoad?: boolean;
  refreshToken: number;
  resolveRevision?: (data: TData) => ResourceRevision | null;
  resourceKey: ResourceKey;
  runtimeStore: ResourceRuntimeStore<TData>;
  setLoadedRefreshToken: (token: number) => void;
}): void {
  useEffect(() => {
    if (!enabled) return;
    const hasManualRefresh = refreshToken !== loadedRefreshToken;
    if (pauseLoad && !hasManualRefresh) {
      runtimeStore.pauseLoad(resourceKey);
      recordResourceHookDiagnostic({
        action: "stale-skip",
        diagnosticRecorder,
        detail: { reason: "pause-load" },
        resourceKey,
        revision: externalRevision,
      });
      return;
    }
    let cancelled = false;
    let completed = false;
    let started = false;

    // If the last attempt failed, wait before retrying to avoid
    // a hot render loop when the backend is unreachable.
    const delay = errorCountRef.current > 0 ? errorRetryDelayMs() : 0;
    const timeoutId = setTimeout(() => {
      started = true;
      const snapshotBeforeLoad = runtimeStore.getSnapshot(resourceKey);
      recordResourceHookDiagnostic({
        action: resourceSettledForRevision(
          snapshotBeforeLoad,
          resourceKey,
          externalRevision,
        )
          ? "hit"
          : "miss",
        diagnosticRecorder,
        detail: {
          abortStaleInflight,
          force: hasManualRefresh,
          minRefetchIntervalMs,
        },
        resourceKey,
        revision: externalRevision,
      });
      runtimeStore
        .ensureLoad({
          abortStaleInflight,
          externalRevision,
          force: hasManualRefresh,
          load,
          minRefetchIntervalMs,
          resolveRevision,
          resourceKey,
        })
        .then((snapshot) => {
          completed = true;
          if (cancelled) return;
          if (hasManualRefresh) {
            setLoadedRefreshToken(refreshToken);
          }
          if (snapshot.status === "ready") {
            recordResourceHookDiagnostic({
              action: "set",
              diagnosticRecorder,
              detail: { status: snapshot.status },
              resourceKey,
              revision: snapshot.revision,
            });
          }
          errorCountRef.current =
            snapshot.status === "error" ? errorCountRef.current + 1 : 0;
        });
    }, delay);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      if (started && !completed) {
        recordResourceHookDiagnostic({
          action: "abort",
          diagnosticRecorder,
          detail: { reason: "effect-cleanup" },
          resourceKey,
          revision: externalRevision,
        });
      }
    };
  }, [
    abortStaleInflight,
    diagnosticRecorder,
    enabled,
    errorCountRef,
    externalRevision,
    load,
    loadedRefreshToken,
    minRefetchIntervalMs,
    pauseLoad,
    refreshToken,
    resolveRevision,
    resourceKey,
    runtimeStore,
    setLoadedRefreshToken,
  ]);
}

function recordResourceHookDiagnostic({
  action,
  detail,
  diagnosticRecorder,
  resourceKey,
  revision,
}: {
  action: "abort" | "hit" | "miss" | "set" | "stale-skip";
  detail: Record<string, boolean | number | string | null>;
  diagnosticRecorder: KernelApi["diagnosticRecorder"];
  resourceKey: ResourceKey;
  revision: ResourceRevision | null;
}): void {
  diagnosticRecorder.record({
    byteLength: null,
    cacheAction: action,
    detail,
    droppedCount: 0,
    durationMs: null,
    id: "",
    kind: "resource-hook",
    lane: "resource-cache",
    name:
      action === "set"
        ? DIAGNOSTIC_EVENT_NAMES.resourceCacheSet
        : `resource-hook.${action}`,
    resourceKey,
    revision,
    severity: "info",
    startTimeMs: null,
    timestampMs: Date.now(),
  });
}

function resourceSettledForRevision<TData>(
  snapshot: ResourceRuntimeSnapshot<TData>,
  resourceKey: ResourceKey,
  externalRevision: ResourceRevision | null,
): boolean {
  return (
    snapshot.status === "ready" &&
    snapshot.settledResourceKey === resourceKey &&
    (snapshot.settledExternalRevision === externalRevision ||
      snapshot.revision === externalRevision)
  );
}

function visibleResourceResult<TData>({
  enabled,
  externalRevision,
  manualRefreshPending,
  pauseLoad,
  refetch,
  resourceKey,
  state,
}: {
  enabled: boolean;
  externalRevision: ResourceRevision | null;
  manualRefreshPending: boolean;
  pauseLoad: boolean;
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

  const visibleState = visibleResourceState({
    externalRevision,
    manualRefreshPending,
    pauseLoad,
    resourceKey,
    state,
  });

  return { ...visibleState, refetch };
}

function visibleResourceState<TData>({
  externalRevision,
  manualRefreshPending,
  pauseLoad,
  resourceKey,
  state,
}: {
  externalRevision: ResourceRevision | null;
  manualRefreshPending: boolean;
  pauseLoad: boolean;
  resourceKey: ResourceKey;
  state: ResourceRuntimeSnapshot<TData>;
}): ResourceState<TData> {
  if (resourceSettledForRevision(state, resourceKey, externalRevision)) {
    return state;
  }
  if (pauseLoad && !manualRefreshPending) {
    if (state.status === "error") {
      return state;
    }
    return {
      ...state,
      error: null,
      revision: externalRevision,
      status: state.data ? "stale" : "idle",
    };
  }
  return markResourceLoading(state, externalRevision);
}
