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
}): UseWorkspaceLayoutResult {
  const enabled = options?.enabled ?? true;
  const sessionKey = options?.sessionKey ?? null;
  const [layout, setLayout] = useState<WorkspaceLayoutResource | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<LiveApiError | null>(null);
  const mountedRef = useRef(true);
  const lastFetchedSessionKeyRef = useRef<string | null>(null);

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
      lastFetchedSessionKeyRef.current = sessionKey;
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
        setLayout(null);
        setError(null);
        setLoading(false);
        return;
      }
      setError(apiError);
      setLoading(false);
    }
  }, [enabled, sessionKey]);

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
      lastFetchedSessionKeyRef.current = null;
      setLayout(null);
      setError(null);
      setLoading(false);
      return () => {
        mountedRef.current = false;
      };
    }

    if (lastFetchedSessionKeyRef.current !== sessionKey) {
      void fetchWorkspaceLayout();
    }

    return () => {
      mountedRef.current = false;
    };
  }, [enabled, fetchWorkspaceLayout, sessionKey]);

  return {
    layout,
    loading,
    error,
    refresh: fetchWorkspaceLayout,
    replaceLayout,
  };
}
