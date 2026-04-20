"use client";

/**
 * F-P1: Bridge hook that syncs useCurrentLiveStream → useSessionRuntimeStore.
 *
 * Mount this once (e.g. in ControlRoomProvider or the workspace shell) to
 * keep the session-runtime Zustand store in sync with the live polling
 * stream.  Components can then subscribe to the store via narrow selectors
 * instead of consuming the full ControlRoom context.
 */

import { useEffect, useRef } from "react";
import { useSessionRuntimeStore } from "../store/useSessionRuntimeStore";
import { deriveSessionReadModel } from "../model/deriveSessionReadModel";
import type { SessionState, ConnectionStatus } from "@/lib/session/types";

const ENABLE_LIVE_DEBUG_LOGS =
  typeof process !== "undefined" && process.env.NODE_ENV !== "production";

/**
 * Sync the live stream state into useSessionRuntimeStore.
 *
 * Call this from the component that owns useCurrentLiveStream():
 * ```tsx
 * const { state, connection, error } = useCurrentLiveStream();
 * useSessionRuntimeBridge(state, connection, error);
 * ```
 */
export function useSessionRuntimeBridge(
  state: SessionState | null,
  connection: ConnectionStatus,
  error: string | null,
): void {
  const applyNormalizedState = useSessionRuntimeStore(
    (s) => s.applyNormalizedState,
  );
  const setConnection = useSessionRuntimeStore((s) => s.setConnection);
  const prevAppliedVersionRef = useRef<number | null>(null);

  // Sync connection status
  const prevConnectionRef = useRef(connection);
  useEffect(() => {
    if (connection !== prevConnectionRef.current || error != null) {
      prevConnectionRef.current = connection;
      setConnection(connection, error);
    }
  }, [connection, error, setConnection]);

  // Sync normalized state
  useEffect(() => {
    const normalized = deriveSessionReadModel(state);
    applyNormalizedState(normalized);
    if (!ENABLE_LIVE_DEBUG_LOGS) {
      return;
    }
    if (normalized.stateVersion == null) {
      return;
    }
    if (prevAppliedVersionRef.current === normalized.stateVersion) {
      return;
    }
    prevAppliedVersionRef.current = normalized.stateVersion;
    console.info("[fullmag-debug][session-runtime] snapshot applied in frontend store", {
      stateVersion: normalized.stateVersion,
      connection,
      sessionId: normalized.session?.session_id ?? null,
      runId: normalized.run?.run_id ?? null,
      workspaceStatus: normalized.workspaceStatus,
      liveStep: normalized.liveState?.step ?? null,
      scalarRows: normalized.scalarRows.length,
      hasPreview: normalized.preview != null,
    });
  }, [state, connection, applyNormalizedState]);
}
