"use client";

import { Activity, BarChart3, Box, Database, ListChecks, type LucideIcon } from "lucide-react";

import type { ExplorerTabId } from "./explorerTypes";
import { PanelChrome } from "@/shared/ui/PanelFrame";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/Tabs";

const EXPLORER_TABS: Array<{ id: ExplorerTabId; label: string; icon: LucideIcon }> = [
  { id: "model", label: "Model", icon: Box },
  { id: "resources", label: "Resources", icon: Database },
  { id: "results", label: "Results", icon: BarChart3 },
  { id: "jobs", label: "Jobs", icon: ListChecks },
  { id: "diagnostics", label: "Diagnostics", icon: Activity },
];

interface ExplorerTabBarProps {
  activeTab: ExplorerTabId;
  onTabChange: (tabId: ExplorerTabId) => void;
}

/** In a narrow panel inactive tabs collapse to their icon so all five stay visible. */
export function ExplorerTabBar({ activeTab, onTabChange }: ExplorerTabBarProps) {
  return (
    <Tabs
      className="fm-explorer-tabs"
      value={activeTab}
      onValueChange={(value) => onTabChange(value as ExplorerTabId)}
    >
      <PanelChrome><TabsList aria-label="Explorer resource families">
        {EXPLORER_TABS.map(({ id, label, icon: Icon }) => (
          <TabsTrigger aria-label={label} key={id} title={label} value={id}>
            <Icon aria-hidden="true" size={13} />
            <span className="fm-explorer-tabs__label">{label}</span>
          </TabsTrigger>
        ))}
      </TabsList></PanelChrome>
    </Tabs>
  );
}
