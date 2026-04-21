"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  WorkspaceSelectionReplaceRequest,
  WorkspaceSelectionResource,
} from "../../api/types";
import { getLiveApiClient } from "../../api/client/LiveApiClient";
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
}): UseWorkspaceSelectionResult {
  const enabled = options?.enabled ?? true;
  const sessionKey = options?.sessionKey ?? null;
  const [selection, setSelection] = useState<WorkspaceSelectionResource | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<LiveApiError | null>(null);
  const mountedRef = useRef(true);
  const lastFetchedSessionKeyRef = useRef<string | null>(null);

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
      const nextSelection = await getLiveApiClient().workspace.getSelection();
      if (!mountedRef.current) {
        return;
      }
      lastFetchedSessionKeyRef.current = sessionKey;
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
        setSelection(null);
        setError(null);
        setLoading(false);
        return;
      }
      setError(apiError);
      setLoading(false);
    }
  }, [enabled, sessionKey]);

  const replaceSelection = useCallback(
    async (
      request: WorkspaceSelectionReplaceRequest,
    ): Promise<WorkspaceSelectionResource | null> => {
      if (!enabled || !sessionKey) {
        return null;
      }
      setLoading(true);
      try {
        const nextSelection = await getLiveApiClient().workspace.replaceSelection(request);
        if (!mountedRef.current) {
          return nextSelection;
        }
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
      lastFetchedSessionKeyRef.current = null;
      setSelection(null);
      setError(null);
      setLoading(false);
      return () => {
        mountedRef.current = false;
      };
    }

    if (lastFetchedSessionKeyRef.current !== sessionKey) {
      void fetchWorkspaceSelection();
    }

    return () => {
      mountedRef.current = false;
    };
  }, [enabled, fetchWorkspaceSelection, sessionKey]);

  return {
    selection,
    loading,
    error,
    refresh: fetchWorkspaceSelection,
    replaceSelection,
  };
}
