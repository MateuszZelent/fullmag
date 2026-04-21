"use client";

/**
 * Router hook: one entry point for session runtime bridge wiring.
 *
 * Whole-state snapshot bridging has been retired. The Control Room
 * now mounts only the resource-first status bridge and lazy data-plane fetches.
 */

import { useDataPlaneBridge } from "./useDataPlaneBridge";
import { useNewApiBridge } from "./useNewApiBridge";

export function useSessionRuntimeBridgeRouter(): void {
  useNewApiBridge();
  useDataPlaneBridge();
}
