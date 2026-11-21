"use client";

import type { ExplorerTabId } from "./explorerTypes";
import { PanelChrome } from "@/shared/ui/PanelFrame";

import { EXPLORER_TABS } from "./explorerTabs";

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
