import type { WorkspaceTab } from "@/lib/workspace/workspace-store";

type RenderPolicyTab = Pick<WorkspaceTab, "id" | "kind" | "lifecycle">;

export interface WorkspaceTabRenderPolicyOptions {
  enableWebGLWarmKeepAlive?: boolean;
  warmWebGLTabIds?: ReadonlySet<string> | readonly string[] | null;
  /** @deprecated Hidden WebGL warm keepalive now retains every WebGL tab. */
  recentWebGLTabId?: string | null;
  webGLWarmKeepAliveDisabledByContextLoss?: boolean;
}

export type WorkspaceTabRenderReason =
  | "active"
  | "warm-hidden"
  | "warm-disabled"
  | "unmounted";

export interface WorkspaceTabRenderDecision {
  render: boolean;
  visible: boolean;
  forceMount: boolean;
  reason: WorkspaceTabRenderReason;
}

export function isWebGLWorkspaceTab(tab: Pick<WorkspaceTab, "kind">): boolean {
  return (
    tab.kind === "viewport-3d" ||
    tab.kind === "viewport-2d" ||
    tab.kind === "viewport-mesh" ||
    tab.kind === "result-quantity"
  );
}

export function resolveWorkspaceTabRenderDecision(
  tab: RenderPolicyTab,
  activeTabId: string | null | undefined,
  options: WorkspaceTabRenderPolicyOptions = {},
): WorkspaceTabRenderDecision {
  if (!activeTabId) {
    return { render: false, visible: false, forceMount: false, reason: "unmounted" };
  }
  if (tab.id === activeTabId) {
    return { render: true, visible: true, forceMount: tab.lifecycle === "warm", reason: "active" };
  }
  if (isWebGLWorkspaceTab(tab)) {
    const warmTabIds = options.warmWebGLTabIds;
    const tabWithinWarmBudget =
      !warmTabIds ||
      ("has" in warmTabIds
        ? warmTabIds.has(tab.id)
        : warmTabIds.includes(tab.id));
    const canWarmMount =
      options.enableWebGLWarmKeepAlive === true &&
      !options.webGLWarmKeepAliveDisabledByContextLoss &&
      tabWithinWarmBudget;
    if (canWarmMount) {
      return { render: true, visible: false, forceMount: true, reason: "warm-hidden" };
    }
    return {
      render: false,
      visible: false,
      forceMount: false,
      reason: options.enableWebGLWarmKeepAlive ? "warm-disabled" : "unmounted",
    };
  }
  if (tab.lifecycle === "warm") {
    return { render: true, visible: false, forceMount: true, reason: "warm-hidden" };
  }
  return { render: false, visible: false, forceMount: false, reason: "unmounted" };
}

/**
 * Center-tab panels can own WebGL canvases, Plotly charts, timers, observers,
 * and live subscriptions. Hidden panels must unmount so changing tabs releases
 * CPU/GPU work and browser memory instead of running in the background. WebGL
 * viewport tabs keep their camera/presentation state in stores by default; the
 * feature-flagged warm keepalive path preserves hidden WebGL tabs and can be
 * disabled for the session after hidden context loss.
 */
export function shouldRenderWorkspaceTabPanel(
  tab: RenderPolicyTab,
  activeTabId: string | null | undefined,
): boolean {
  return resolveWorkspaceTabRenderDecision(tab, activeTabId).render;
}
