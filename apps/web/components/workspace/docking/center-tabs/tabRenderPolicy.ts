import type { WorkspaceTab } from "@/lib/workspace/workspace-store";
import { isWebGLWorkspaceTabKind } from "@/lib/workspace/workspace-tab-policy";

type RenderPolicyTab = Pick<WorkspaceTab, "id" | "kind" | "mountPolicy">;

export type WorkspaceTabRenderReason =
  | "active"
  | "hidden-mounted"
  | "active-only-hidden"
  | "unmounted";

export interface WorkspaceTabRenderDecision {
  render: boolean;
  visible: boolean;
  forceMount: boolean;
  reason: WorkspaceTabRenderReason;
}

export function isWebGLWorkspaceTab(tab: Pick<WorkspaceTab, "kind">): boolean {
  return isWebGLWorkspaceTabKind(tab.kind);
}

export function resolveWorkspaceTabRenderDecision(
  tab: RenderPolicyTab,
  activeTabId: string | null | undefined,
): WorkspaceTabRenderDecision {
  if (!activeTabId) {
    return { render: false, visible: false, forceMount: false, reason: "unmounted" };
  }
  if (tab.id === activeTabId) {
    return {
      render: true,
      visible: true,
      forceMount: !isWebGLWorkspaceTab(tab) && tab.mountPolicy === "hidden-mounted",
      reason: "active",
    };
  }
  if (isWebGLWorkspaceTab(tab)) {
    return {
      render: false,
      visible: false,
      forceMount: false,
      reason: "active-only-hidden",
    };
  }
  if (tab.mountPolicy === "hidden-mounted") {
    return { render: true, visible: false, forceMount: true, reason: "hidden-mounted" };
  }
  return { render: false, visible: false, forceMount: false, reason: "active-only-hidden" };
}

/**
 * Center-tab panels can own WebGL canvases, Plotly charts, timers, observers,
 * and live subscriptions. Hidden panels must unmount so changing tabs releases
 * CPU/GPU work and browser memory instead of running in the background. WebGL
 * viewport tabs keep their camera/presentation state in stores by default.
 * Hidden WebGL tabs are intentionally active-only: keeping hidden canvases warm
 * retains GPU contexts and has caused tab-switch memory growth.
 */
export function shouldRenderWorkspaceTabPanel(
  tab: RenderPolicyTab,
  activeTabId: string | null | undefined,
): boolean {
  return resolveWorkspaceTabRenderDecision(tab, activeTabId).render;
}
