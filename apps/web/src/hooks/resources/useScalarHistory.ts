"use client";

/**
 * Hook: fetches scalar window incrementally, appending new rows.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { getLiveApiClient } from "../../api/client/LiveApiClient";
import { LiveApiError } from "../../api/client/errors/LiveApiError";
import {
  mergeScalarWindows,
  type LegacyScalarRow,
} from "../../api/client/modules/ScalarHistoryAdapter";

interface UseScalarHistoryResult {
  scalars: LegacyScalarRow[];
  totalRows: number;
  loading: boolean;
  error: LiveApiError | null;
  refresh: () => void;
}

const POLL_INTERVAL_MS = 2000;

export function useScalarHistory(
  scalarRevision: number | null,
): UseScalarHistoryResult {
  const [scalars, setScalars] = useState<LegacyScalarRow[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<LiveApiError | null>(null);
  const lastRevRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const fetchScalars = useCallback(async () => {
    setLoading(true);
    try {
      const client = getLiveApiClient();
      const window = await client.scalars.getWindow({
        sinceRevision: lastRevRef.current,
      });
      if (!mountedRef.current) return;

      setScalars((prev) => mergeScalarWindows(prev, window));
      lastRevRef.current = window.revision;
      setTotalRows(window.total_rows);
      setError(null);
      setLoading(false);
    } catch (err) {
      if (!mountedRef.current) return;
      const apiErr =
        err instanceof LiveApiError
          ? err
          : LiveApiError.networkError("scalars", err);
      setError(apiErr);
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(() => {
    lastRevRef.current = 0;
    setScalars([]);
    fetchScalars();
  }, [fetchScalars]);

  useEffect(() => {
    mountedRef.current = true;

    const poll = () => {
      fetchScalars().then(() => {
        if (mountedRef.current) {
          timerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
        }
      });
    };

    if (scalarRevision != null) {
      poll();
    }

    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [scalarRevision, fetchScalars]);

  return { scalars, totalRows, loading, error, refresh };
}
