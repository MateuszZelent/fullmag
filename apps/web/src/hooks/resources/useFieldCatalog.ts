"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { FieldCatalog } from "../../api/contracts";
import { getLiveApiClient } from "../../api/client/LiveApiClient";
import { LiveApiError } from "../../api/client/errors/LiveApiError";

interface UseFieldCatalogResult {
  catalog: FieldCatalog | null;
  loading: boolean;
  error: LiveApiError | null;
  refresh: () => void;
}

export function useFieldCatalog(): UseFieldCatalogResult {
  const [catalog, setCatalog] = useState<FieldCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LiveApiError | null>(null);
  const mountedRef = useRef(true);

  const fetchCatalog = useCallback(async () => {
    setLoading(true);
    try {
      const nextCatalog = await getLiveApiClient().fields.getCatalog();
      if (!mountedRef.current) {
        return;
      }
      setCatalog(nextCatalog);
      setError(null);
      setLoading(false);
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      setError(
        err instanceof LiveApiError
          ? err
          : LiveApiError.networkError("field-catalog", err),
      );
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void fetchCatalog();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchCatalog]);

  return {
    catalog,
    loading,
    error,
    refresh: () => {
      void fetchCatalog();
    },
  };
}
