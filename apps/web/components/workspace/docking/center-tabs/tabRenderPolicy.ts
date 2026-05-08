import type { WorkspaceTab } from "@/lib/workspace/workspace-store";
import {
  isCore3DWorkspaceTab,
  isWebGLWorkspaceTabKind,
} from "@/lib/workspace/workspace-tab-policy";

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

export function isKeepAliveWorkspaceTab(tab: Pick<WorkspaceTab, "id" | "kind">): boolean {
  return isCore3DWorkspaceTab(tab);
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
      forceMount: tab.mountPolicy === "hidden-mounted",
      reason: "active",
    };
  }
  if (isKeepAliveWorkspaceTab(tab)) {
    return { render: true, visible: false, forceMount: true, reason: "hidden-mounted" };
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
 * and live subscriptions. Only the primary 3D viewport stays mounted while
 * hidden; it receives viewportVisible=false so its render loop pauses. Other
 * WebGL tabs remain active-only to avoid GPU memory growth.
 */
export function shouldRenderWorkspaceTabPanel(
  tab: RenderPolicyTab,
  activeTabId: string | null | undefined,
): boolean {
  return resolveWorkspaceTabRenderDecision(tab, activeTabId).render;
}
