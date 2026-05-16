"use client";

import type { ExplorerTabId } from "./explorerTypes";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/Tabs";

const EXPLORER_TABS: Array<{ id: ExplorerTabId; label: string }> = [
  { id: "model", label: "Model" },
  { id: "resources", label: "Resources" },
  { id: "results", label: "Results" },
  { id: "jobs", label: "Jobs" },
  { id: "diagnostics", label: "Diagnostics" },
];

interface ExplorerTabBarProps {
  activeTab: ExplorerTabId;
  onTabChange: (tabId: ExplorerTabId) => void;
}

export function ExplorerTabBar({ activeTab, onTabChange }: ExplorerTabBarProps) {
  return (
    <Tabs
      className="fm-explorer-tabs"
      value={activeTab}
      onValueChange={(value) => onTabChange(value as ExplorerTabId)}
    >
      <TabsList aria-label="Explorer resource families">
        {EXPLORER_TABS.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
