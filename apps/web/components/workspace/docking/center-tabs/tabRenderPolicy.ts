import type { WorkspaceTab } from "@/lib/workspace/workspace-store";

/**
 * Center-tab panels can own WebGL canvases, Plotly charts, timers, observers,
 * and live subscriptions. Hidden panels must unmount so changing tabs releases
 * CPU/GPU work and browser memory instead of running in the background.
 */
export function shouldRenderWorkspaceTabPanel(
  tab: Pick<WorkspaceTab, "id" | "lifecycle">,
  activeTabId: string | null | undefined,
): boolean {
  if (!activeTabId) {
    return false;
  }
  return tab.id === activeTabId || tab.lifecycle === "warm";
}
