"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { SceneDocument } from "@/lib/session/types";
import { getLiveApiClient } from "../../api/client/LiveApiClient";
import { LiveApiError } from "../../api/client/errors/LiveApiError";

interface UseSceneDocumentResult {
  document: SceneDocument | null;
  loading: boolean;
  error: LiveApiError | null;
  refresh: () => Promise<void>;
}

export function useSceneDocument(options?: {
  enabled?: boolean;
  sessionKey?: string | null;
}): UseSceneDocumentResult {
  const enabled = options?.enabled ?? true;
  const sessionKey = options?.sessionKey ?? null;
  const [document, setDocument] = useState<SceneDocument | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<LiveApiError | null>(null);
  const mountedRef = useRef(true);
  const lastFetchedSessionKeyRef = useRef<string | null>(null);

  const fetchSceneDocument = useCallback(async () => {
    if (!enabled || !sessionKey) {
      if (mountedRef.current) {
        setDocument(null);
        setError(null);
        setLoading(false);
      }
      return;
    }

    setLoading(true);
    try {
      const nextDocument = await getLiveApiClient().scene.get();
      if (!mountedRef.current) {
        return;
      }
      lastFetchedSessionKeyRef.current = sessionKey;
      setDocument(nextDocument);
      setError(null);
      setLoading(false);
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      setError(
        err instanceof LiveApiError
          ? err
          : LiveApiError.networkError("scene-document", err),
      );
      setLoading(false);
    }
  }, [enabled, sessionKey]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled || !sessionKey) {
      lastFetchedSessionKeyRef.current = null;
      setDocument(null);
      setError(null);
      setLoading(false);
      return () => {
        mountedRef.current = false;
      };
    }

    if (lastFetchedSessionKeyRef.current !== sessionKey) {
      void fetchSceneDocument();
    }

    return () => {
      mountedRef.current = false;
    };
  }, [enabled, fetchSceneDocument, sessionKey]);

  return {
    document,
    loading,
    error,
    refresh: fetchSceneDocument,
  };
}
