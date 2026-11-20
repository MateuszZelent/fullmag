"use client";

import { Activity, BarChart3, Box, Database, ListChecks, type LucideIcon } from "lucide-react";

import type { ExplorerTabId } from "./explorerTypes";
import { PanelChrome } from "@/shared/ui/PanelFrame";

/** Explorer resource families; the tab bar and the left side rail share this list. */
export const EXPLORER_TABS: ReadonlyArray<{ id: ExplorerTabId; label: string; icon: LucideIcon }> = [
  { id: "model", label: "Model", icon: Box },
  { id: "resources", label: "Resources", icon: Database },
  { id: "results", label: "Results", icon: BarChart3 },
  { id: "jobs", label: "Jobs", icon: ListChecks },
  { id: "diagnostics", label: "Diagnostics", icon: Activity },
];

interface ExplorerTabBarProps {
  activeTab: ExplorerTabId;
}

/**
 * The left side rail switches resource families (specs/frontend-v2/10 §1a);
 * the panel chrome names the open family.
 */
export function ExplorerTabBar({ activeTab }: ExplorerTabBarProps) {
  const tab = EXPLORER_TABS.find(({ id }) => id === activeTab) ?? EXPLORER_TABS[0];
  const Icon = tab.icon;
  return (
    <PanelChrome>
      <span className="fm-panel-chrome__title fm-explorer-tabs__title">
        <Icon aria-hidden="true" size={14} />
        {tab.label}
      </span>
    </PanelChrome>
  );
}
