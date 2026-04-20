"use client";

/**
 * Bridge router: feature-flag gate between legacy and new API bridges.
 *
 * When USE_NEW_API is enabled, delegates to useNewApiBridge().
 * Otherwise, this is a no-op — the caller must still invoke
 * useSessionRuntimeBridge() manually with the legacy stream args.
 *
 * Usage in ControlRoomProvider / workspace shell:
 * ```tsx
 * // Legacy path (always available):
 * const { state, connection, error } = useCurrentLiveStream();
 * useSessionRuntimeBridgeRouter(state, connection, error);
 * ```
 *
 * When USE_NEW_API=true, the legacy args are ignored and polling
 * happens through useLiveStatus() inside useNewApiBridge().
 */

import { USE_NEW_API } from "@/src/config/featureFlags";
import { useSessionRuntimeBridge } from "./useSessionRuntimeBridge";
import { useNewApiBridge } from "./useNewApiBridge";
import type { SessionState, ConnectionStatus } from "@/lib/session/types";

export function useSessionRuntimeBridgeRouter(
  state: SessionState | null,
  connection: ConnectionStatus,
  error: string | null,
): void {
  if (USE_NEW_API) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useNewApiBridge();
  } else {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useSessionRuntimeBridge(state, connection, error);
  }
}
