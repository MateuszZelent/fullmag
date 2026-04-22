"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  WorkspaceLayoutReplaceRequest,
  WorkspaceLayoutResource,
} from "../../api/types";
import { getLiveApiClient } from "../../api/client/LiveApiClient";
import { LiveApiError } from "../../api/client/errors/LiveApiError";

interface UseWorkspaceLayoutResult {
  layout: WorkspaceLayoutResource | null;
  loading: boolean;
  error: LiveApiError | null;
  refresh: () => Promise<void>;
  replaceLayout: (
    request: WorkspaceLayoutReplaceRequest,
  ) => Promise<WorkspaceLayoutResource | null>;
}

export function useWorkspaceLayout(options?: {
  enabled?: boolean;
  sessionKey?: string | null;
  revision?: number | null;
}): UseWorkspaceLayoutResult {
  const enabled = options?.enabled ?? true;
  const sessionKey = options?.sessionKey ?? null;
  const revision = options?.revision ?? null;
  const [layout, setLayout] = useState<WorkspaceLayoutResource | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<LiveApiError | null>(null);
  const mountedRef = useRef(true);
  const lastFetchedIdentityRef = useRef<string | null>(null);

  const fetchIdentity = sessionKey
    ? `${sessionKey}:${revision == null ? "no-revision" : revision}`
    : null;

  const fetchWorkspaceLayout = useCallback(async () => {
    if (!enabled || !sessionKey) {
      if (mountedRef.current) {
        setLayout(null);
        setError(null);
        setLoading(false);
      }
      return;
    }

    setLoading(true);
    try {
      const nextLayout = await getLiveApiClient().workspace.getLayout();
      if (!mountedRef.current) {
        return;
      }
      lastFetchedIdentityRef.current = `${sessionKey}:${nextLayout.revision}`;
      setLayout(nextLayout);
      setError(null);
      setLoading(false);
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      const apiError =
        err instanceof LiveApiError
          ? err
          : LiveApiError.networkError("workspace-layout", err);
      if (apiError.status === 404) {
        lastFetchedIdentityRef.current = fetchIdentity;
        setLayout(null);
        setError(null);
        setLoading(false);
        return;
      }
      lastFetchedIdentityRef.current = fetchIdentity;
      setError(apiError);
      setLoading(false);
    }
  }, [enabled, fetchIdentity, sessionKey]);

  const replaceLayout = useCallback(
    async (
      request: WorkspaceLayoutReplaceRequest,
    ): Promise<WorkspaceLayoutResource | null> => {
      if (!enabled || !sessionKey) {
        return null;
      }
      setLoading(true);
      try {
        const nextLayout = await getLiveApiClient().workspace.replaceLayout(request);
        if (!mountedRef.current) {
          return nextLayout;
        }
        lastFetchedIdentityRef.current = `${sessionKey}:${nextLayout.revision}`;
        setLayout(nextLayout);
        setError(null);
        setLoading(false);
        return nextLayout;
      } catch (err) {
        if (!mountedRef.current) {
          return null;
        }
        const apiError =
          err instanceof LiveApiError
            ? err
            : LiveApiError.networkError("workspace-layout", err);
        setError(apiError);
        setLoading(false);
        return null;
      }
    },
    [enabled, sessionKey],
  );

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled || !sessionKey) {
      lastFetchedIdentityRef.current = null;
      setLayout(null);
      setError(null);
      setLoading(false);
      return () => {
        mountedRef.current = false;
      };
    }

    if (lastFetchedIdentityRef.current !== fetchIdentity) {
      void fetchWorkspaceLayout();
    }

    return () => {
      mountedRef.current = false;
    };
  }, [enabled, fetchIdentity, fetchWorkspaceLayout, sessionKey]);

  return {
    layout,
    loading,
    error,
    refresh: fetchWorkspaceLayout,
    replaceLayout,
  };
}
