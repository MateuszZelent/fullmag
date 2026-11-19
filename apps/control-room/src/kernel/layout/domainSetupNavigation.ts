import { useLayoutEffect } from "react";

import type { KernelApi } from "../types";

/**
 * "Configure now" in the New simulation dialog opens the Universe Inspector
 * once the created session is confirmed. The workspace shell switches
 * subtrees while a session is created, which remounts the dialog, so the
 * intent lives here instead of in dialog state.
 */
let pendingSessionId: string | null = null;

export function requestDomainSetupNavigation(sessionId: string): void {
  pendingSessionId = sessionId;
}

export function pendingDomainSetupNavigation(): string | null {
  return pendingSessionId;
}

export function cancelDomainSetupNavigation(): void {
  pendingSessionId = null;
}

/**
 * Applies a pending request for the confirmed session. Call it after the
 * session-transition selection clearing so the Universe selection survives.
 */
export function useDomainSetupNavigation(
  kernel: KernelApi,
  sessionId: string | null,
  scopeKey: string | null,
): void {
  useLayoutEffect(() => {
    if (!sessionId || scopeKey === null || pendingSessionId !== sessionId) return;
    pendingSessionId = null;
    kernel.layout.setPanelVisible("right", true);
    kernel.selection.set(
      {
        kind: "universe.root",
        label: "Universe",
        nodeId: "model:universe",
        objectId: null,
        ref: null,
      },
      "ribbon",
    );
  }, [kernel, sessionId, scopeKey]);
}
