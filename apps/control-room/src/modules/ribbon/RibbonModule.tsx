"use client";

import { useMemo, useSyncExternalStore } from "react";

import {
  MESHING_BUILDS_CURRENT_PATH,
  MODEL_GEOMETRY_CAPABILITIES_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  VISUALIZATION_STATE_PATH,
} from "@/kernel/api/apiPaths";
import type { ModuleProps } from "@/kernel/types";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useLayout } from "@/kernel/layout/useLayout";
import {
  useGeometryCapabilitiesResource,
  useGeometryValidationResource,
  useMeshBuildCurrent,
  useMeshBuildLatestSuccessful,
  useMeshSemanticsResource,
  useMeshSummaryResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { useSessionStatus } from "@/kernel/resources/useSessionStatus";
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
  const activeTab = layout.activeModuleTab;
  const needsGeometryResources =
    activeTab === "geometry" || activeTab === "mesh";
  const needsMeshResources = activeTab === "mesh";
  const needsVisualizationResources = activeTab === "view";
  const visualizationState = useVisualizationStateResource({
    enabled: needsVisualizationResources,
  });
  const geometryCapabilities = useGeometryCapabilitiesResource({
    enabled: needsGeometryResources,
  });
  const geometryValidation = useGeometryValidationResource({
    enabled: needsGeometryResources,
  });
  const meshBuildCurrent = useMeshBuildCurrent({ enabled: needsMeshResources });
  const meshBuildLatest = useMeshBuildLatestSuccessful({
    enabled: needsMeshResources,
  });
  const meshSummary = useMeshSummaryResource({ enabled: needsMeshResources });
  const meshSemantics = useMeshSemanticsResource({
    enabled: needsMeshResources,
  });
  const sessionStatus = useSessionStatus();
  const commandVersion = useSyncExternalStore(
    (listener) => kernel.commands.subscribe(listener),
    () => kernel.commands.getVersion(),
    () => kernel.commands.getVersion(),
  );

  const commandContext = useMemo(
    () =>
      createCommandContext("ribbon", kernel, {
        resourceData: {
          [MESHING_BUILDS_CURRENT_PATH]: meshBuildCurrent.data,
          [MODEL_GEOMETRY_CAPABILITIES_PATH]: geometryCapabilities.data,
          [MODEL_GEOMETRY_VALIDATION_PATH]: geometryValidation.data,
          [VISUALIZATION_STATE_PATH]: visualizationState.data,
        },
      }),
    [
      geometryCapabilities.data,
      geometryValidation.data,
      kernel,
      meshBuildCurrent.data,
      visualizationState.data,
    ],
  );

  const tabContent = useMemo(
    () => {
      void commandVersion;
      return buildRibbonTabContent(activeTab, {
        api: kernel.api,
        commandContext,
        commands: kernel.commands,
        meshBuildCurrent: meshBuildCurrent.data,
        meshBuildLatest: meshBuildLatest.data,
        meshSemantics: meshSemantics.data,
        meshSummary: meshSummary.data,
        resources: kernel.resources,
        selection,
        sessionStatus: sessionStatus.data,
        visualization,
        visualizationSnapshot,
        visualizationState: visualizationState.data,
      });
    },
    [
      activeTab,
      commandContext,
      commandVersion,
      kernel.api,
      kernel.commands,
      kernel.resources,
      meshBuildCurrent.data,
      meshBuildLatest.data,
      meshSemantics.data,
      meshSummary.data,
      selection,
      sessionStatus.data,
      visualization,
      visualizationSnapshot,
      visualizationState.data,
    ],
  );
  const groups = tabContent?.groups ?? [];

  function handleAction(actionId: string, input?: unknown): void {
    void kernel.commands.execute(actionId, commandContext, input);
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
