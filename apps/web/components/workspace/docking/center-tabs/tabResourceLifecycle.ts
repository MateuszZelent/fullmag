import type { WorkspaceMode, WorkspaceTab } from "@/lib/workspace/workspace-store";
import { workspaceViewportResourceOwnerId } from "@/lib/workspace/viewport-resource-owner";
import { isKeepAliveWorkspaceTab, isWebGLWorkspaceTab } from "./tabRenderPolicy";

export interface WorkspaceTabResourceDisposal {
  ownerId: string;
  reason: "tab-close" | "tab-hide";
}

export interface WorkspaceTabResourceLifecycleSnapshot {
  stage: WorkspaceMode;
  tabs: readonly WorkspaceTab[];
  activeTabId: string | null;
}

export function resolveWorkspaceTabResourceDisposals(
  previous: WorkspaceTabResourceLifecycleSnapshot | null,
  current: WorkspaceTabResourceLifecycleSnapshot,
): WorkspaceTabResourceDisposal[] {
  if (!previous) {
    return [];
  }

  const disposals: WorkspaceTabResourceDisposal[] = [];
  const currentTabIds = new Set(current.tabs.map((tab) => tab.id));

  for (const previousTab of previous.tabs) {
    if (!currentTabIds.has(previousTab.id)) {
      disposals.push({
        ownerId: workspaceViewportResourceOwnerId(previous.stage, previousTab.id),
        reason: "tab-close",
      });
    }
  }

  if (previous.activeTabId && previous.activeTabId !== current.activeTabId) {
    const previousActiveTab = previous.tabs.find((tab) => tab.id === previous.activeTabId) ?? null;
    if (
      previousActiveTab &&
      isWebGLWorkspaceTab(previousActiveTab) &&
      !isKeepAliveWorkspaceTab(previousActiveTab)
    ) {
      disposals.push({
        ownerId: workspaceViewportResourceOwnerId(previous.stage, previousActiveTab.id),
        reason: "tab-hide",
      });
    }
  }

  return dedupeDisposals(disposals);
}

function dedupeDisposals(
  disposals: WorkspaceTabResourceDisposal[],
): WorkspaceTabResourceDisposal[] {
  const seen = new Set<string>();
  const next: WorkspaceTabResourceDisposal[] = [];
  for (const disposal of disposals) {
    const key = `${disposal.ownerId}:${disposal.reason}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(disposal);
  }
  return next;
}
