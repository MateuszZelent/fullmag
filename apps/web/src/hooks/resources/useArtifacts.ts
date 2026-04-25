"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ArtifactEntry } from "../../api/contracts";
import { getLiveApiClient } from "../../api/client/LiveApiClient";
import { ResourceCache } from "../../api/client/cache/ResourceCache";
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
  const eTagRef = useRef<string | null>(null);
  const revisionRef = useRef(0);

  const fetchArtifacts = useCallback(async () => {
    setLoading(true);
    try {
      const client = getLiveApiClient();
      const cacheKey = ResourceCache.domainKey(0, "artifacts:list");
      const cached = client.getCache().get<ArtifactEntry[]>(cacheKey);
      const response = await client.artifacts.listResponse({
        cache: "default",
        headers:
          eTagRef.current != null
            ? {
                "If-None-Match": eTagRef.current,
              }
            : undefined,
      });
      const nextArtifacts =
        response.status === 304 && cached ? cached.data : (response.data ?? []);
      if (response.status !== 304) {
        revisionRef.current += 1;
        eTagRef.current = response.headers.get("etag");
        client.getCache().set(
          cacheKey,
          nextArtifacts,
          revisionRef.current,
          0,
          eTagRef.current,
        );
      }
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
