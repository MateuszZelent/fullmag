"use client";

/**
 * Router hook: one entry point for session runtime bridge wiring.
 *
 * We keep a single call site in ControlRoomContext and can switch between
 * legacy stream-based transport and the resource-first status transport with
 * one flag.
 */

import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import type { ConnectionStatus } from "@/lib/session/types";
import type { SessionState } from "@/lib/session/types";
import { useSessionRuntimeBridge } from "./useSessionRuntimeBridge";
import { useDataPlaneBridge } from "./useDataPlaneBridge";
import { useNewApiBridge } from "./useNewApiBridge";

type SessionRuntimeBridgeRouterOptions = {
  state: SessionState | null;
  connection: ConnectionStatus;
  error: string | null;
};

export function useSessionRuntimeBridgeRouter(
  options: SessionRuntimeBridgeRouterOptions,
): void {
  const useResourceFirst =
    FRONTEND_DIAGNOSTIC_FLAGS.dataPlaneRollout.resourceFirstSessionRuntime;

  // Legacy adapter path (bootstrap/poll and full snapshot model).
  useSessionRuntimeBridge(options.state, options.connection, options.error, {
    enabled: !useResourceFirst,
  });

  // Resource-first status-first path.
  useNewApiBridge({ enabled: useResourceFirst });

  // Data-plane lazy fetches used only by resource-first path.
  useDataPlaneBridge({ enabled: useResourceFirst });
}

