"use client";

/**
 * Hook: polls /status at adaptive intervals.
 * Faster polling during active solver, slower when idle.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import type { LiveStatus } from "../../api/generated/openapi-types";
import { getLiveApiClient } from "../../api/client/LiveApiClient";
import { LiveApiError } from "../../api/client/errors/LiveApiError";
import { LiveRealtimeClient } from "../../api/realtime/LiveRealtimeClient";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";

const IDLE_INTERVAL_MS = 3000;
const ACTIVE_INTERVAL_MS = 500;
const ERROR_BACKOFF_MS = 5000;
const WS_IDLE_INTERVAL_MS = 10_000;
const WS_ACTIVE_INTERVAL_MS = 2_000;

interface UseLiveStatusResult {
  status: LiveStatus | null;
  loading: boolean;
  error: LiveApiError | null;
  refresh: () => Promise<void>;
}

export function useLiveStatus(options?: { enabled?: boolean }): UseLiveStatusResult {
  const enabled = options?.enabled ?? true;
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LiveApiError | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const realtimeClientRef = useRef<LiveRealtimeClient | null>(null);
  const refreshQueuedRef = useRef(false);

  const poll = useCallback(async function pollStatus(): Promise<void> {
    try {
      const client = getLiveApiClient();
      const result = await client.status.get();
      if (!mountedRef.current) return;
      setStatus(result);
      setError(null);
      setLoading(false);

      // Adaptive interval based on solver state
      const isActive =
        result.solver.state === "running" ||
        result.solver.state === "initializing";
      const websocketEnabled = FRONTEND_DIAGNOSTIC_FLAGS.session.enableLiveWebSocket;
      const interval = websocketEnabled
        ? isActive
          ? WS_ACTIVE_INTERVAL_MS
          : WS_IDLE_INTERVAL_MS
        : isActive
          ? ACTIVE_INTERVAL_MS
          : IDLE_INTERVAL_MS;
      timerRef.current = setTimeout(pollStatus, interval);
    } catch (err) {
      if (!mountedRef.current) return;
      const apiErr =
        err instanceof LiveApiError
          ? err
          : LiveApiError.networkError("status", err);
      setError(apiErr);
      setLoading(false);
      timerRef.current = setTimeout(poll, ERROR_BACKOFF_MS);
    }
  }, []);

  const queueRefresh = useCallback(() => {
    if (refreshQueuedRef.current) {
      return;
    }
    refreshQueuedRef.current = true;
    window.setTimeout(() => {
      refreshQueuedRef.current = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      void poll();
    }, 0);
  }, [poll]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setError(null);
      return;
    }
    mountedRef.current = true;
    setLoading(true);
    poll();
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [poll, enabled]);

  useEffect(() => {
    if (!enabled || !FRONTEND_DIAGNOSTIC_FLAGS.session.enableLiveWebSocket) {
      realtimeClientRef.current?.close();
      realtimeClientRef.current = null;
      return;
    }
    const client = new LiveRealtimeClient({
      baseUrl: getLiveApiClient().getBaseUrl(),
      onEvent: (event) => {
        if (event.type === "heartbeat") {
          return;
        }
        queueRefresh();
      },
      onError: (realtimeError) => {
        if (!mountedRef.current) {
          return;
        }
        setError((previous) => previous ?? LiveApiError.networkError("realtime", realtimeError));
      },
    });
    realtimeClientRef.current = client;
    client.connect();
    return () => {
      client.close();
      if (realtimeClientRef.current === client) {
        realtimeClientRef.current = null;
      }
    };
  }, [enabled, queueRefresh]);

  return {
    status,
    loading,
    error,
    refresh: async () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      await poll();
    },
  };
}
