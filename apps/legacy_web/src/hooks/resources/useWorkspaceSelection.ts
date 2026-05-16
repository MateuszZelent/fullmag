"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  WorkspaceSelectionReplaceRequest,
  WorkspaceSelectionResource,
} from "../../api/types";
import { getLiveSessionClient } from "../../api/client/LiveSessionClient";
import { LiveApiError } from "../../api/client/errors/LiveApiError";

interface UseWorkspaceSelectionResult {
  selection: WorkspaceSelectionResource | null;
  loading: boolean;
  error: LiveApiError | null;
  refresh: () => Promise<void>;
  replaceSelection: (
    request: WorkspaceSelectionReplaceRequest,
  ) => Promise<WorkspaceSelectionResource | null>;
}

export function useWorkspaceSelection(options?: {
  enabled?: boolean;
  sessionKey?: string | null;
  revision?: number | null;
}): UseWorkspaceSelectionResult {
  const enabled = options?.enabled ?? true;
  const sessionKey = options?.sessionKey ?? null;
  const revision = options?.revision ?? null;
  const [selection, setSelection] = useState<WorkspaceSelectionResource | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<LiveApiError | null>(null);
  const mountedRef = useRef(true);
  const lastFetchedIdentityRef = useRef<string | null>(null);

  const fetchIdentity = sessionKey
    ? `${sessionKey}:${revision == null ? "no-revision" : revision}`
    : null;

  const fetchWorkspaceSelection = useCallback(async () => {
    if (!enabled || !sessionKey) {
      if (mountedRef.current) {
        setSelection(null);
        setError(null);
        setLoading(false);
      }
      return;
    }

    setLoading(true);
    try {
      const nextSelection = await getLiveSessionClient().workspace.getSelection();
      if (!mountedRef.current) {
        return;
      }
      lastFetchedIdentityRef.current = `${sessionKey}:${nextSelection.revision}`;
      setSelection(nextSelection);
      setError(null);
      setLoading(false);
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      const apiError =
        err instanceof LiveApiError
          ? err
          : LiveApiError.networkError("workspace-selection", err);
      if (apiError.status === 404) {
        lastFetchedIdentityRef.current = fetchIdentity;
        setSelection(null);
        setError(null);
        setLoading(false);
        return;
      }
      lastFetchedIdentityRef.current = fetchIdentity;
      setError(apiError);
      setLoading(false);
    }
  }, [enabled, fetchIdentity, sessionKey]);

  const replaceSelection = useCallback(
    async (
      request: WorkspaceSelectionReplaceRequest,
    ): Promise<WorkspaceSelectionResource | null> => {
      if (!enabled || !sessionKey) {
        return null;
      }
      setLoading(true);
      try {
        const nextSelection = await getLiveSessionClient().workspace.replaceSelection(request);
        if (!mountedRef.current) {
          return nextSelection;
        }
        lastFetchedIdentityRef.current = `${sessionKey}:${nextSelection.revision}`;
        setSelection(nextSelection);
        setError(null);
        setLoading(false);
        return nextSelection;
      } catch (err) {
        if (!mountedRef.current) {
          return null;
        }
        const apiError =
          err instanceof LiveApiError
            ? err
            : LiveApiError.networkError("workspace-selection", err);
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
      setSelection(null);
      setError(null);
      setLoading(false);
      return () => {
        mountedRef.current = false;
      };
    }

    if (lastFetchedIdentityRef.current !== fetchIdentity) {
      void fetchWorkspaceSelection();
    }

    return () => {
      mountedRef.current = false;
    };
  }, [enabled, fetchIdentity, fetchWorkspaceSelection, sessionKey]);

  return {
    selection,
    loading,
    error,
    refresh: fetchWorkspaceSelection,
    replaceSelection,
  };
}
