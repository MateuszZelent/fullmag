"use client";

import { useCallback, useEffect, useState } from "react";

import { PLATFORM_DEVELOPMENT_BACKEND_PATH } from "../api/apiPaths";
import type { DevelopmentBackendResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import { useResource } from "./useResource";

export const DEVELOPMENT_BACKEND_REFRESH_INTERVAL_MS = 5_000;

export function developmentBackendResourceKey(
  clientScope: string,
): string {
  return `${clientScope}|${PLATFORM_DEVELOPMENT_BACKEND_PATH}`;
}

export function useDevelopmentBackendResource() {
  const { api } = useKernel();
  const visible = useDocumentVisibility();
  const [hasBeenVisible, setHasBeenVisible] = useState(false);
  const resourceKey = developmentBackendResourceKey(api.resourceCacheScope);
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.platform.developmentBackend({ signal }),
    [api],
  );
  const resolveRevision = useCallback(
    (resource: DevelopmentBackendResource) => resource.revision,
    [],
  );

  useEffect(() => {
    if (visible) setHasBeenVisible(true);
  }, [visible]);

  const resource = useResource<DevelopmentBackendResource>({
    abortStaleInflight: true,
    enabled: hasBeenVisible,
    load,
    minRefetchIntervalMs: DEVELOPMENT_BACKEND_REFRESH_INTERVAL_MS,
    resourceKey,
    resolveRevision,
    retryPolicy: null,
  });

  useEffect(() => {
    if (
      !visible ||
      resource.status !== "ready" ||
      !resource.data?.configured ||
      resource.data.state === "disabled" ||
      resource.data.state === "unknown"
    ) {
      return;
    }

    const timeoutId = window.setTimeout(
      resource.refetch,
      DEVELOPMENT_BACKEND_REFRESH_INTERVAL_MS,
    );
    return () => window.clearTimeout(timeoutId);
  }, [resource.data, resource.refetch, resource.status, visible]);

  return resource;
}

function useDocumentVisibility(): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const updateVisibility = () => {
      setVisible(document.visibilityState === "visible");
    };

    updateVisibility();
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, []);

  return visible;
}
