"use client";

import { useSyncExternalStore } from "react";

import {
  MESHING_BUILDS_CURRENT_PATH,
  MODEL_GEOMETRY_CAPABILITIES_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
} from "@/kernel/api/apiPaths";
import type { ModuleProps } from "@/kernel/types";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useLayout } from "@/kernel/layout/useLayout";
import {
  useGeometryCapabilitiesResource,
  useGeometryValidationResource,
  useMeshBuildCurrent,
} from "@/kernel/resources/geometryLifecycleResources";
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
  const geometryCapabilities = useGeometryCapabilitiesResource();
  const geometryValidation = useGeometryValidationResource();
  const meshBuildCurrent = useMeshBuildCurrent();
  const activeTab = layout.activeModuleTab;
  const commandVersion = useSyncExternalStore(
    (listener) => kernel.commands.subscribe(listener),
    () => kernel.commands.getVersion(),
    () => kernel.commands.getVersion(),
  );

  const commandContext = createCommandContext("ribbon", kernel, {
    resourceData: {
      [MESHING_BUILDS_CURRENT_PATH]: meshBuildCurrent.data,
      [MODEL_GEOMETRY_CAPABILITIES_PATH]: geometryCapabilities.data,
      [MODEL_GEOMETRY_VALIDATION_PATH]: geometryValidation.data,
    },
  });

  const tabContent = buildRibbonTabContent(activeTab, {
    api: kernel.api,
    commandContext,
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
    void kernel.commands.execute(actionId, commandContext);
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
