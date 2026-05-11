"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import type { ResourceRevision } from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import type { ResourceKey, ResourceResult, ResourceStatus } from "./resourceTypes";

interface LoadContext {
  signal: AbortSignal;
}

interface UseResourceOptions<TData> {
  load: (context: LoadContext) => Promise<TData>;
  resolveRevision?: (data: TData) => ResourceRevision | null;
  resourceKey: ResourceKey;
}

interface ResourceState<TData> {
  data: TData | null;
  error: Error | null;
  revision: ResourceRevision | null;
  status: ResourceStatus;
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

        setState({
          data,
          error: null,
          revision: resolveRevision?.(data) ?? externalRevision,
          status: "ready",
        });
      })
      .catch((error: unknown) => {
        if (abortError(error) || controller.signal.aborted) return;

        setState((current) => ({
          ...current,
          error: error instanceof Error ? error : new Error(String(error)),
          status: "error",
        }));
      });

    return () => controller.abort();
  }, [externalRevision, load, refreshToken, resolveRevision, resourceKey]);

  const refetch = useCallback(() => {
    setRefreshToken((current) => current + 1);
  }, []);

  return { ...state, refetch };
}
