"use client";

import type { ModuleProps } from "@/kernel/types";
import { useLayout } from "@/kernel/layout/useLayout";

import { ALL_TAB_CONTENT } from "./ribbonContributions";
import { RibbonGroupsRow } from "./RibbonGroupsRow";
import { RibbonTabStrip } from "./RibbonTabStrip";
import { RIBBON_TABS } from "./ribbonTypes";

export default function RibbonModule({ kernel }: ModuleProps) {
  const { layout, setActiveTab } = useLayout();
  const activeTab = layout.activeModuleTab;

  const tabContent = ALL_TAB_CONTENT[activeTab];
  const groups = tabContent?.groups ?? [];

  function handleAction(actionId: string): void {
    void kernel.commands.execute(actionId, { source: "ribbon" });
  }

  return (
    <div className="fm-ribbon">
      <RibbonTabStrip
        activeTabId={activeTab}
        tabs={RIBBON_TABS}
        onTabClick={setActiveTab}
      />
      <RibbonGroupsRow groups={groups} onAction={handleAction} />
    </div>
  );
}
