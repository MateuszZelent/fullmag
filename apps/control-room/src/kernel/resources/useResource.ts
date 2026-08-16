"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
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
  type ResourceRetryPolicy,
  type ResourceRuntimeSnapshot,
  type ResourceRuntimeStore,
} from "./ResourceRuntimeStore";
import {
  emitResourceLoadFailed,
  normalizeResourceLoadFailure,
} from "./resourceLoadFailure";
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
  retryPolicy?: ResourceRetryPolicy | null;
  resolveRevision?: (data: TData) => ResourceRevision | null;
  resourceKey: ResourceKey;
}

interface UseResourceSelectorOptions<TData, TSelected>
  extends UseResourceOptions<TData> {
  isEqual?: (previous: TSelected, next: TSelected) => boolean;
  selector: (resource: ResourceResult<TData>) => TSelected;
}

const NOOP_SUBSCRIBE = () => undefined;
const NOOP_REFETCH = () => undefined;
const NOOP_RESOLVE_REVISION = () => null;
const DEFAULT_RESOURCE_RETRYABLE_REASON_CODES = [
  "field_materialization_pending",
  "field_pending",
  "field_unmaterialized",
  "materialization_pending",
  "not_ready",
  "pending",
  "temporary_not_found",
  "transient_not_found",
] as const;
const getServerRevision = (): ResourceRevision | null => null;
const SERVER_RUNTIME_SNAPSHOT: ResourceRuntimeSnapshot<unknown> = {
  data: null,
  error: null,
  revision: null,
  settledExternalRevision: null,
  settledResourceKey: null,
  status: "loading",
};

function getServerRuntimeSnapshot<TData>(): ResourceRuntimeSnapshot<TData> {
  return SERVER_RUNTIME_SNAPSHOT as ResourceRuntimeSnapshot<TData>;
}

export function useResource<TData>({
  abortStaleInflight = false,
  enabled = true,
  load,
  minRefetchIntervalMs,
  pauseLoad = false,
  retryPolicy,
  resolveRevision,
  resourceKey,
}: UseResourceOptions<TData>): ResourceResult<TData> {
  const { bus, diagnosticRecorder, resources } = useKernel();
  const runtimeStore = sharedResourceRuntimeStore as ResourceRuntimeStore<TData>;
  const effectiveRetryPolicy = useMemo(
    () => resolveResourceRetryPolicy(retryPolicy),
    [retryPolicy],
  );

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
    getServerRevision,
  );

  const subscribeRuntime = useCallback(
    (onStoreChange: () => void) =>
      enabled
        ? runtimeStore.subscribe(resourceKey, onStoreChange)
        : NOOP_SUBSCRIBE,
    [enabled, resourceKey, runtimeStore],
  );
  const getRuntimeSnapshot = useCallback(
    () => runtimeStore.getSnapshot<TData>(resourceKey),
    [resourceKey, runtimeStore],
  );
  const state = useSyncExternalStore<ResourceRuntimeSnapshot<TData>>(
    subscribeRuntime,
    getRuntimeSnapshot,
    getServerRuntimeSnapshot,
  );
  const [refreshToken, setRefreshToken] = useState(0);
  const [loadedRefreshToken, setLoadedRefreshToken] = useState(refreshToken);

  // Track consecutive errors to apply backoff before retrying.
  const errorCountRef = useRef(0);

  useResourceLoader({
    abortStaleInflight,
    bus,
    diagnosticRecorder,
    enabled,
    errorCountRef,
    externalRevision,
    load,
    loadedRefreshToken,
    minRefetchIntervalMs,
    pauseLoad,
    retryPolicy: effectiveRetryPolicy,
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
  retryPolicy,
  resolveRevision,
  resourceKey,
  selector,
}: UseResourceSelectorOptions<TData, TSelected>): TSelected {
  const { bus, diagnosticRecorder, resources } = useKernel();
  const runtimeStore = sharedResourceRuntimeStore as ResourceRuntimeStore<TData>;
  const effectiveRetryPolicy = useMemo(
    () => resolveResourceRetryPolicy(retryPolicy),
    [retryPolicy],
  );
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
    getServerRevision,
  );

  const refetch = useCallback(() => {
    errorCountRef.current = 0;
    setRefreshToken((current) => current + 1);
  }, []);

  const serverSelectedSnapshot = useMemo(
    () => selector({
      data: null,
      error: null,
      refetch: NOOP_REFETCH,
      revision: null,
      status: enabled && !pauseLoad ? "loading" : "idle",
    }),
    [enabled, pauseLoad, selector],
  );

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
    () => serverSelectedSnapshot,
  );

  useResourceLoader({
    abortStaleInflight,
    bus,
    diagnosticRecorder,
    enabled,
    errorCountRef,
    externalRevision,
    load,
    loadedRefreshToken,
    minRefetchIntervalMs,
    pauseLoad,
    retryPolicy: effectiveRetryPolicy,
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
  bus,
  diagnosticRecorder,
  enabled,
  errorCountRef,
  externalRevision,
  load,
  loadedRefreshToken,
  minRefetchIntervalMs = 0,
  pauseLoad = false,
  retryPolicy,
  refreshToken,
  resolveRevision,
  resourceKey,
  runtimeStore,
  setLoadedRefreshToken,
}: {
  abortStaleInflight?: boolean;
  bus: KernelApi["bus"];
  diagnosticRecorder: KernelApi["diagnosticRecorder"];
  enabled: boolean;
  errorCountRef: { current: number };
  externalRevision: ResourceRevision | null;
  load: (context: LoadContext) => Promise<TData>;
  loadedRefreshToken: number;
  minRefetchIntervalMs?: number;
  pauseLoad?: boolean;
  retryPolicy?: ResourceRetryPolicy;
  refreshToken: number;
  resolveRevision?: (data: TData) => ResourceRevision | null;
  resourceKey: ResourceKey;
  runtimeStore: ResourceRuntimeStore<TData>;
  setLoadedRefreshToken: (token: number) => void;
}): void {
  const loadLatest = useEffectEvent(load);
  const resolveRevisionLatest = useEffectEvent(
    resolveRevision ?? NOOP_RESOLVE_REVISION,
  );

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

    const snapshotAtEffect = runtimeStore.getSnapshot(resourceKey);
    const externalRevisionChanged =
      snapshotAtEffect.settledResourceKey === resourceKey &&
      snapshotAtEffect.settledExternalRevision !== externalRevision;
    if (externalRevisionChanged) {
      runtimeStore.cancelRetry(resourceKey);
    }

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
          load: loadLatest,
          minRefetchIntervalMs,
          retryPolicy,
          resolveRevision: resolveRevisionLatest,
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
          if (snapshot.status === "error") {
            const error =
              snapshot.error ??
              new Error("Resource load failed without error detail");
            const failure = normalizeResourceLoadFailure(error);
            emitResourceLoadFailed({
              bus,
              error,
              resourceKey,
              revision: externalRevision,
            });
            recordResourceHookDiagnostic({
              action: "miss",
              diagnosticRecorder,
              detail: {
                cause: failure.cause,
                errorName: failure.errorName,
                reason: "load-failed",
                status: failure.status,
              },
              resourceKey,
              revision: externalRevision,
              severity: "warning",
            });
            errorCountRef.current += 1;
          } else {
            errorCountRef.current = 0;
          }
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
    bus,
    diagnosticRecorder,
    enabled,
    errorCountRef,
    externalRevision,
    loadedRefreshToken,
    minRefetchIntervalMs,
    pauseLoad,
    retryPolicy,
    refreshToken,
    resourceKey,
    runtimeStore,
    setLoadedRefreshToken,
  ]);
}

function resolveResourceRetryPolicy(
  policy: ResourceRetryPolicy | null | undefined,
): ResourceRetryPolicy | undefined {
  if (policy === null) return undefined;
  return (
    policy ?? {
      deadlineMs: 5_000,
      maxAttempts: 3,
      retryAfterMs: errorRetryDelayMs(),
      retryableReasonCodes: DEFAULT_RESOURCE_RETRYABLE_REASON_CODES,
    }
  );
}

function recordResourceHookDiagnostic({
  action,
  detail,
  diagnosticRecorder,
  resourceKey,
  revision,
  severity = "info",
}: {
  action: "abort" | "hit" | "miss" | "set" | "stale-skip";
  detail: Record<string, boolean | number | string | null>;
  diagnosticRecorder: KernelApi["diagnosticRecorder"];
  resourceKey: ResourceKey;
  revision: ResourceRevision | null;
  severity?: "info" | "warning";
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
    severity,
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
  if (
    !manualRefreshPending &&
    state.status === "error" &&
    state.data === null &&
    state.settledResourceKey === resourceKey &&
    state.settledExternalRevision === externalRevision
  ) {
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
