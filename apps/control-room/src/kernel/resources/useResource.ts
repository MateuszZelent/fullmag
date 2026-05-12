"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { ResourceRevision } from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import type { ResourceKey, ResourceResult } from "./resourceTypes";
import {
  markResourceError,
  markResourceLoading,
  markResourceReady,
  type ResourceState,
} from "./resourceState";

interface LoadContext {
  signal: AbortSignal;
}

interface UseResourceOptions<TData> {
  load: (context: LoadContext) => Promise<TData>;
  resolveRevision?: (data: TData) => ResourceRevision | null;
  resourceKey: ResourceKey;
}

interface UseResourceState<TData> extends ResourceState<TData> {
  settledExternalRevision: ResourceRevision | null;
  settledResourceKey: ResourceKey | null;
}

/** Minimum delay before retrying after a network/fetch error (ms). */
const ERROR_RETRY_DELAY_MS = 1_000;

function abortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function useResource<TData>({
  load,
  resolveRevision,
  resourceKey,
}: UseResourceOptions<TData>): ResourceResult<TData> {
  const { resources } = useKernel();

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
  const [refreshToken, setRefreshToken] = useState(0);
  const [state, setState] = useState<UseResourceState<TData>>({
    data: null,
    error: null,
    revision: externalRevision,
    settledExternalRevision: null,
    settledResourceKey: null,
    status: "loading",
  });

  // Track consecutive errors to apply backoff before retrying.
  const errorCountRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();

    // If the last attempt failed, wait before retrying to avoid
    // a hot render loop when the backend is unreachable.
    const delay = errorCountRef.current > 0 ? ERROR_RETRY_DELAY_MS : 0;
    const timeoutId = setTimeout(() => {
      load({ signal: controller.signal })
        .then((data) => {
          if (controller.signal.aborted) return;
          errorCountRef.current = 0;

          setState((current) => ({
            ...markResourceReady(
              current,
              data,
              resolveRevision?.(data) ?? externalRevision,
            ),
            settledExternalRevision: externalRevision,
            settledResourceKey: resourceKey,
          }));
        })
        .catch((error: unknown) => {
          if (abortError(error) || controller.signal.aborted) return;
          errorCountRef.current += 1;

          setState((current) => ({
            ...markResourceError(
              current,
              error instanceof Error ? error : new Error(String(error)),
            ),
            settledExternalRevision: externalRevision,
            settledResourceKey: resourceKey,
          }));
        });
    }, delay);

    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [externalRevision, load, refreshToken, resolveRevision, resourceKey]);

  const refetch = useCallback(() => {
    errorCountRef.current = 0;
    setRefreshToken((current) => current + 1);
  }, []);

  const settledForCurrentResource =
    state.settledResourceKey === resourceKey &&
    state.settledExternalRevision === externalRevision;
  const visibleState = settledForCurrentResource
    ? state
    : markResourceLoading(state, externalRevision);

  return { ...visibleState, refetch };
}
