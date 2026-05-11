"use client";

import { useSyncExternalStore } from "react";

import type { ModuleProps } from "@/kernel/types";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useLayout } from "@/kernel/layout/useLayout";
import { useSelection } from "@/kernel/selection/useSelection";
import { useObjectVisualizationRegistry } from "@/kernel/visualization/useObjectVisualization";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";

import { buildRibbonTabContent } from "./ribbonContributions";
import { RibbonGroupsRow } from "./RibbonGroupsRow";
import { RibbonTabStrip } from "./RibbonTabStrip";
import { RIBBON_TABS } from "./ribbonTypes";

export default function RibbonModule({ kernel, moduleId }: ModuleProps) {
  const { layout, setActiveTab } = useLayout();
  const { selection } = useSelection(moduleId);
  const { snapshot: visualizationSnapshot, visualization } =
    useObjectVisualizationRegistry();
  const visualizationState = useVisualizationStateResource();
  const activeTab = layout.activeModuleTab;
  const commandVersion = useSyncExternalStore(
    (listener) => kernel.commands.subscribe(listener),
    () => kernel.commands.getVersion(),
    () => kernel.commands.getVersion(),
  );

  const tabContent = buildRibbonTabContent(activeTab, {
    api: kernel.api,
    commandContext: createCommandContext("ribbon", kernel),
    commands: kernel.commands,
    resources: kernel.resources,
    selection,
    visualization,
    visualizationSnapshot,
    visualizationState: visualizationState.data,
  });
  void commandVersion;
  const groups = tabContent?.groups ?? [];

  function handleAction(actionId: string): void {
    void kernel.commands.execute(actionId, createCommandContext("ribbon", kernel));
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
