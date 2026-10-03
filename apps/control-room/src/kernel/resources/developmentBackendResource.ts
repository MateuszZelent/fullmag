"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";

import { PLATFORM_DEVELOPMENT_BACKEND_PATH } from "../api/apiPaths";
import type { DevelopmentBackendResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import { useResource } from "./useResource";

export const DEVELOPMENT_BACKEND_REFRESH_INTERVAL_MS = 5_000;

interface DocumentVisibilitySnapshot {
  readonly hasBeenVisible: boolean;
  readonly visible: boolean;
}

const SERVER_DOCUMENT_VISIBILITY_SNAPSHOT: DocumentVisibilitySnapshot = {
  hasBeenVisible: false,
  visible: false,
};

export function developmentBackendResourceKey(
  clientScope: string,
): string {
  return `${clientScope}|${PLATFORM_DEVELOPMENT_BACKEND_PATH}`;
}

export function useDevelopmentBackendResource() {
  const { api } = useKernel();
  const visibility = useDocumentVisibility();
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

  const resource = useResource<DevelopmentBackendResource>({
    abortStaleInflight: true,
    enabled: visibility.hasBeenVisible,
    load,
    minRefetchIntervalMs: DEVELOPMENT_BACKEND_REFRESH_INTERVAL_MS,
    resourceKey,
    resolveRevision,
    retryPolicy: null,
  });

  useEffect(() => {
    if (
      !visibility.visible ||
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
  }, [resource.data, resource.refetch, resource.status, visibility.visible]);

  return resource;
}

function useDocumentVisibility(): DocumentVisibilitySnapshot {
  const store = useMemo(() => new DocumentVisibilityStore(), []);
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
}

class DocumentVisibilityStore {
  private snapshot = SERVER_DOCUMENT_VISIBILITY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private listening = false;

  readonly getSnapshot = (): DocumentVisibilitySnapshot => this.snapshot;

  readonly getServerSnapshot = (): DocumentVisibilitySnapshot =>
    SERVER_DOCUMENT_VISIBILITY_SNAPSHOT;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (typeof document === "undefined") return () => undefined;

    this.listeners.add(listener);
    if (!this.listening) {
      document.addEventListener("visibilitychange", this.handleVisibilityChange);
      this.listening = true;
      this.refresh();
    }

    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.listening) {
        document.removeEventListener(
          "visibilitychange",
          this.handleVisibilityChange,
        );
        this.listening = false;
      }
    };
  };

  private readonly handleVisibilityChange = (): void => {
    this.refresh();
  };

  private refresh(): void {
    const visible = document.visibilityState === "visible";
    const hasBeenVisible = this.snapshot.hasBeenVisible || visible;
    if (
      visible === this.snapshot.visible &&
      hasBeenVisible === this.snapshot.hasBeenVisible
    ) {
      return;
    }

    this.snapshot = { hasBeenVisible, visible };
    for (const listener of this.listeners) listener();
  }
}
