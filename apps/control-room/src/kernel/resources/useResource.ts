"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

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

function abortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function useResource<TData>({
  load,
  resolveRevision,
  resourceKey,
}: UseResourceOptions<TData>): ResourceResult<TData> {
  const { resources } = useKernel();
  const externalRevision = useSyncExternalStore(
    (onStoreChange) =>
      resources.subscribe(resourceKey, () => {
        onStoreChange();
      }),
    () => resources.getRevision(resourceKey),
    () => resources.getRevision(resourceKey),
  );
  const [refreshToken, setRefreshToken] = useState(0);
  const [state, setState] = useState<ResourceState<TData>>({
    data: null,
    error: null,
    revision: externalRevision,
    status: "loading",
  });

  useEffect(() => {
    const controller = new AbortController();

    load({ signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;

        setState((current) =>
          markResourceReady(
            current,
            data,
            resolveRevision?.(data) ?? externalRevision,
          ),
        );
      })
      .catch((error: unknown) => {
        if (abortError(error) || controller.signal.aborted) return;

        setState((current) =>
          markResourceError(
            current,
            error instanceof Error ? error : new Error(String(error)),
          ),
        );
      });

    return () => controller.abort();
  }, [externalRevision, load, refreshToken, resolveRevision, resourceKey]);

  const refetch = useCallback(() => {
    setRefreshToken((current) => current + 1);
  }, []);

  const visibleState =
    externalRevision !== state.revision
      ? markResourceLoading(state, externalRevision)
      : state;

  return { ...visibleState, refetch };
}
