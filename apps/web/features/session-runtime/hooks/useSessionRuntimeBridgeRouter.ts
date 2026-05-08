"use client";

/**
 * Router hook: one entry point for session runtime bridge wiring.
 *
 * Whole-state snapshot bridging has been retired. The Control Room
 * now mounts only the resource-first status bridge and lazy data-plane fetches.
 */

import { useDataPlaneBridge } from "./useDataPlaneBridge";
import { useNewApiBridge } from "./useNewApiBridge";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { useSessionRuntimeStore } from "../store/useSessionRuntimeStore";

export function useSessionRuntimeBridgeRouter(): void {
  const sessionId = useSessionRuntimeStore((s) => s.session?.session_id);
  useNewApiBridge();
  useDataPlaneBridge({
    enabled:
      FRONTEND_DIAGNOSTIC_FLAGS.leakIsolation.enableSessionDataPlaneBridge &&
      Boolean(sessionId),
  });
}
