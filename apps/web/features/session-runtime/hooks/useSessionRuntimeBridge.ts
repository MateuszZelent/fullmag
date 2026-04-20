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
  options?: { enabled?: boolean },
): void {
  const enabled = options?.enabled ?? true;
  const applyNormalizedState = useSessionRuntimeStore(
    (s) => s.applyNormalizedState,
  );
  const setConnection = useSessionRuntimeStore((s) => s.setConnection);
  const prevAppliedVersionRef = useRef<number | null>(null);

  // Sync connection status
  const prevConnectionRef = useRef(connection);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    if (connection !== prevConnectionRef.current || error != null) {
      prevConnectionRef.current = connection;
      setConnection(connection, error);
    }
  }, [enabled, connection, error, setConnection]);

  // Sync normalized state
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const nextStateVersion =
      typeof state?.state_version === "number" ? state.state_version : null;
    if (
      nextStateVersion != null &&
      prevAppliedVersionRef.current === nextStateVersion
    ) {
      return;
    }
    const normalized = deriveSessionReadModel(state);
    if (
      normalized.stateVersion != null &&
      prevAppliedVersionRef.current === normalized.stateVersion
    ) {
      return;
    }
    applyNormalizedState(normalized);
    if (!ENABLE_LIVE_DEBUG_LOGS) {
      prevAppliedVersionRef.current = normalized.stateVersion;
      return;
    }
    if (normalized.stateVersion == null) {
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
  }, [enabled, state, connection, applyNormalizedState]);
}
