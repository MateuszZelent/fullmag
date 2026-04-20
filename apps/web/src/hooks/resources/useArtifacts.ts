"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ArtifactEntry } from "../../api/types";
import { getLiveApiClient } from "../../api/client/LiveApiClient";
import { LiveApiError } from "../../api/client/errors/LiveApiError";

interface UseArtifactsResult {
  artifacts: ArtifactEntry[];
  loading: boolean;
  error: LiveApiError | null;
  refresh: () => void;
}

export function useArtifacts(): UseArtifactsResult {
  const [artifacts, setArtifacts] = useState<ArtifactEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LiveApiError | null>(null);
  const mountedRef = useRef(true);

  const fetchArtifacts = useCallback(async () => {
    setLoading(true);
    try {
      const nextArtifacts = await getLiveApiClient().artifacts.list();
      if (!mountedRef.current) {
        return;
      }
      setArtifacts(nextArtifacts);
      setError(null);
      setLoading(false);
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      setError(
        err instanceof LiveApiError
          ? err
          : LiveApiError.networkError("artifacts", err),
      );
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void fetchArtifacts();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchArtifacts]);

  return {
    artifacts,
    loading,
    error,
    refresh: () => {
      void fetchArtifacts();
    },
  };
}
