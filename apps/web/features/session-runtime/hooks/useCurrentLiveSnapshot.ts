"use client";

/**
 * Transitional snapshot bridge for compatibility-only callers.
 *
 * Active Control Room runtime disables this path when the resource-first
 * bridge is enabled, but we keep it temporarily for compatibility wrappers
 * that still expect a whole-state SessionState payload.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionStatus, SessionState } from "@/lib/session/types";
import { getLiveApiClient } from "@/src/api/client/LiveApiClient";
import { LiveApiError } from "@/src/api/client/errors/LiveApiError";

const IDLE_INTERVAL_MS = 3000;
const ACTIVE_INTERVAL_MS = 500;
const ERROR_BACKOFF_MS = 5000;

interface UseCurrentLiveSnapshotResult {
  state: SessionState | null;
  connection: ConnectionStatus;
  error: string | null;
  refresh: (options?: { forceBootstrap?: boolean }) => Promise<void>;
}

export function useCurrentLiveSnapshot(
  options?: { enabled?: boolean },
): UseCurrentLiveSnapshotResult {
  const enabled = options?.enabled ?? true;
  const [state, setState] = useState<SessionState | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async function pollSnapshot(): Promise<void> {
    try {
      const nextState = await getLiveApiClient().session.current();
      if (!mountedRef.current) return;
      setState(nextState);
      setConnection("connected");
      setError(null);
      const isActive =
        nextState.live_state?.status === "running" ||
        nextState.live_state?.status === "bootstrapping" ||
        nextState.runtime_status?.code === "running" ||
        nextState.runtime_status?.code === "bootstrapping";
      timerRef.current = setTimeout(pollSnapshot, isActive ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS);
    } catch (err) {
      if (!mountedRef.current) return;
      const apiErr = err instanceof LiveApiError ? err : LiveApiError.networkError("current-state", err);
      setConnection("disconnected");
      setError(apiErr.message ?? "failed to load current live state");
      timerRef.current = setTimeout(poll, ERROR_BACKOFF_MS);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) {
      setConnection("connecting");
      setError(null);
      setState(null);
      return () => {
        mountedRef.current = false;
        if (timerRef.current) clearTimeout(timerRef.current);
      };
    }

    void poll();
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [enabled, poll]);

  return {
    state,
    connection,
    error,
    refresh: async () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      await poll();
    },
  };
}
