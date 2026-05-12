"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  WorkspaceRibbonReplaceRequest,
  WorkspaceRibbonResource,
} from "../../api/types";
import { getLiveSessionClient } from "../../api/client/LiveSessionClient";
import { LiveApiError } from "../../api/client/errors/LiveApiError";

interface UseWorkspaceRibbonResult {
  ribbon: WorkspaceRibbonResource | null;
  loading: boolean;
  error: LiveApiError | null;
  refresh: () => Promise<void>;
  replaceRibbon: (
    request: WorkspaceRibbonReplaceRequest,
  ) => Promise<WorkspaceRibbonResource | null>;
}

export function useWorkspaceRibbon(options?: {
  enabled?: boolean;
  sessionKey?: string | null;
  revision?: number | null;
}): UseWorkspaceRibbonResult {
  const enabled = options?.enabled ?? true;
  const sessionKey = options?.sessionKey ?? null;
  const revision = options?.revision ?? null;
  const [ribbon, setRibbon] = useState<WorkspaceRibbonResource | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<LiveApiError | null>(null);
  const mountedRef = useRef(true);
  const lastFetchedIdentityRef = useRef<string | null>(null);

  const fetchIdentity = sessionKey
    ? `${sessionKey}:${revision == null ? "no-revision" : revision}`
    : null;

  const fetchWorkspaceRibbon = useCallback(async () => {
    if (!enabled || !sessionKey) {
      if (mountedRef.current) {
        setRibbon(null);
        setError(null);
        setLoading(false);
      }
      return;
    }

    setLoading(true);
    try {
      const nextRibbon = await getLiveSessionClient().workspace.getRibbon();
      if (!mountedRef.current) {
        return;
      }
      lastFetchedIdentityRef.current = `${sessionKey}:${nextRibbon.revision}`;
      setRibbon(nextRibbon);
      setError(null);
      setLoading(false);
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      const apiError =
        err instanceof LiveApiError
          ? err
          : LiveApiError.networkError("workspace-ribbon", err);
      if (apiError.status === 404) {
        lastFetchedIdentityRef.current = fetchIdentity;
        setRibbon(null);
        setError(null);
        setLoading(false);
        return;
      }
      lastFetchedIdentityRef.current = fetchIdentity;
      setError(apiError);
      setLoading(false);
    }
  }, [enabled, fetchIdentity, sessionKey]);

  const replaceRibbon = useCallback(
    async (
      request: WorkspaceRibbonReplaceRequest,
    ): Promise<WorkspaceRibbonResource | null> => {
      if (!enabled || !sessionKey) {
        return null;
      }
      setLoading(true);
      try {
        const nextRibbon = await getLiveSessionClient().workspace.replaceRibbon(request);
        if (!mountedRef.current) {
          return nextRibbon;
        }
        lastFetchedIdentityRef.current = `${sessionKey}:${nextRibbon.revision}`;
        setRibbon(nextRibbon);
        setError(null);
        setLoading(false);
        return nextRibbon;
      } catch (err) {
        if (!mountedRef.current) {
          return null;
        }
        const apiError =
          err instanceof LiveApiError
            ? err
            : LiveApiError.networkError("workspace-ribbon", err);
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
      setRibbon(null);
      setError(null);
      setLoading(false);
      return () => {
        mountedRef.current = false;
      };
    }

    if (lastFetchedIdentityRef.current !== fetchIdentity) {
      void fetchWorkspaceRibbon();
    }

    return () => {
      mountedRef.current = false;
    };
  }, [enabled, fetchIdentity, fetchWorkspaceRibbon, sessionKey]);

  return {
    ribbon,
    loading,
    error,
    refresh: fetchWorkspaceRibbon,
    replaceRibbon,
  };
}
