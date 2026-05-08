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

export function useSessionRuntimeBridgeRouter(): void {
  useNewApiBridge();
  useDataPlaneBridge({
    enabled: FRONTEND_DIAGNOSTIC_FLAGS.leakIsolation.enableSessionDataPlaneBridge,
  });
}
