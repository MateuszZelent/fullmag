"use client";

import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";

import { currentLiveApiClient } from "@/lib/liveApiClient";
import { coerceScalarRows } from "@/lib/plots/scalarRows";
import { mergeScalarRowsDelta } from "@/lib/session/merge";
import type { ScalarRow } from "@/lib/session/types";

interface UseScalarChartHistoryOptions {
  enabled: boolean;
  sessionKey: string | null;
  liveRows: ScalarRow[];
  scalarRowsTotal: number;
}

interface UseScalarChartHistoryResult {
  rows: ScalarRow[];
  deferredRows: ScalarRow[];
  source: "live-window" | "full-history";
  loading: boolean;
  hydrated: boolean;
  error: string | null;
}

interface ScalarChartHistoryState {
  sessionKey: string | null;
  rows: ScalarRow[];
  loading: boolean;
  hydrated: boolean;
  error: string | null;
}

type ScalarChartHistoryAction =
  | { type: "session_reset"; sessionKey: string | null; liveRows: ScalarRow[] }
  | {
      type: "live_delta";
      sessionKey: string | null;
      liveRows: ScalarRow[];
      scalarRowsTotal: number;
    }
  | { type: "full_history_start"; sessionKey: string | null }
  | { type: "hydrate_live_window"; sessionKey: string | null }
  | {
      type: "full_history_ready";
      sessionKey: string | null;
      fetchedRows: ScalarRow[];
      scalarRowsTotal: number;
    }
  | { type: "full_history_failed"; sessionKey: string | null; error: string };

function baseState(
  sessionKey: string | null,
  liveRows: ScalarRow[],
): ScalarChartHistoryState {
  return {
    sessionKey,
    rows: liveRows,
    loading: false,
    hydrated: false,
    error: null,
  };
}

function ensureSessionState(
  state: ScalarChartHistoryState,
  sessionKey: string | null,
  liveRows: ScalarRow[],
): ScalarChartHistoryState {
  return state.sessionKey === sessionKey ? state : baseState(sessionKey, liveRows);
}

function reducer(
  state: ScalarChartHistoryState,
  action: ScalarChartHistoryAction,
): ScalarChartHistoryState {
  switch (action.type) {
    case "session_reset":
      return baseState(action.sessionKey, action.liveRows);
    case "live_delta": {
      const current = ensureSessionState(state, action.sessionKey, action.liveRows);
      return {
        ...current,
        rows: mergeScalarRowsDelta(
          current.rows,
          action.liveRows,
          action.scalarRowsTotal,
          null,
        ),
      };
    }
    case "full_history_start": {
      const current = ensureSessionState(state, action.sessionKey, state.rows);
      return { ...current, loading: true, error: null };
    }
    case "hydrate_live_window": {
      const current = ensureSessionState(state, action.sessionKey, state.rows);
      return { ...current, hydrated: true, loading: false, error: null };
    }
    case "full_history_ready": {
      const current = ensureSessionState(state, action.sessionKey, state.rows);
      return {
        ...current,
        rows: mergeScalarRowsDelta(
          action.fetchedRows,
          current.rows,
          action.scalarRowsTotal,
          null,
        ),
        loading: false,
        hydrated: true,
        error: null,
      };
    }
    case "full_history_failed": {
      const current = ensureSessionState(state, action.sessionKey, state.rows);
      return {
        ...current,
        loading: false,
        error: action.error,
      };
    }
  }
}

export function useScalarChartHistory({
  enabled,
  sessionKey,
  liveRows,
  scalarRowsTotal,
}: UseScalarChartHistoryOptions): UseScalarChartHistoryResult {
  const client = useMemo(() => currentLiveApiClient(), []);
  const [state, dispatch] = useReducer(
    reducer,
    baseState(sessionKey, liveRows),
  );
  const liveRowsRef = useRef(liveRows);
  const fetchedSessionRef = useRef<string | null>(null);
  /** Track last fetched total so we can refetch when backend publishes more rows. */
  const fetchedTotalRef = useRef<number>(0);

  useEffect(() => {
    liveRowsRef.current = liveRows;
  }, [liveRows]);

  useEffect(() => {
    fetchedSessionRef.current = null;
    fetchedTotalRef.current = 0;
    dispatch({
      type: "session_reset",
      sessionKey,
      liveRows: liveRowsRef.current,
    });
  }, [sessionKey]);

  useEffect(() => {
    startTransition(() => {
      dispatch({
        type: "live_delta",
        sessionKey,
        liveRows,
        scalarRowsTotal,
      });
    });
  }, [liveRows, scalarRowsTotal, sessionKey]);

  useEffect(() => {
    if (!enabled || !sessionKey) {
      return undefined;
    }
    if (fetchedSessionRef.current === sessionKey) {
      // CH-004 fix: allow refetch when scalarRowsTotal has grown significantly
      // beyond what we previously fetched (at least 10% more rows or 100+ new rows).
      const growth = scalarRowsTotal - fetchedTotalRef.current;
      const significantGrowth = growth > 100 || growth > fetchedTotalRef.current * 0.1;
      if (!significantGrowth) {
        return undefined;
      }
    }
    if (scalarRowsTotal <= liveRows.length) {
      fetchedSessionRef.current = sessionKey;
      fetchedTotalRef.current = scalarRowsTotal;
      startTransition(() => {
        dispatch({ type: "hydrate_live_window", sessionKey });
      });
      return undefined;
    }

    const abortController = new AbortController();
    startTransition(() => {
      dispatch({ type: "full_history_start", sessionKey });
    });

    void client
      .fetchScalarsHistory({ signal: abortController.signal })
      .then((response) => {
        if (abortController.signal.aborted) {
          return;
        }
        fetchedSessionRef.current = sessionKey;
        fetchedTotalRef.current = scalarRowsTotal;
        const fetchedRows = coerceScalarRows(response.scalar_rows);
        startTransition(() => {
          dispatch({
            type: "full_history_ready",
            sessionKey,
            fetchedRows,
            scalarRowsTotal,
          });
        });
      })
      .catch((fetchError: unknown) => {
        if (abortController.signal.aborted) {
          return;
        }
        // CH-004 fix: Do NOT set fetchedSessionRef on failure — this allows
        // automatic retry when scalarRowsTotal grows or the effect re-fires.
        const message =
          fetchError instanceof Error
            ? fetchError.message
            : "Failed to load full scalar history";
        startTransition(() => {
          dispatch({
            type: "full_history_failed",
            sessionKey,
            error: message,
          });
        });
      });

    return () => {
      abortController.abort();
    };
  }, [client, enabled, liveRows.length, scalarRowsTotal, sessionKey]);

  const deferredRows = useDeferredValue(state.rows);
  const source: "live-window" | "full-history" =
    state.hydrated &&
    state.rows.length >= scalarRowsTotal &&
    scalarRowsTotal > liveRows.length
      ? "full-history"
      : "live-window";

  return {
    rows: state.rows,
    deferredRows,
    source,
    loading: state.loading,
    hydrated: state.hydrated,
    error: state.error,
  };
}
