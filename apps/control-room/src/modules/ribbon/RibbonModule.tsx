"use client";

import { useMemo, useState, useSyncExternalStore } from "react";

import {
  MESHING_BUILDS_CURRENT_PATH,
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MESHING_SUMMARY_PATH,
  MODEL_GEOMETRY_CAPABILITIES_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  PERSISTENCE_CHECKPOINTS_PATH,
  SIMULATION_COMMANDS_PATH,
  SIMULATION_SOLVER_STATUS_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
  VISUALIZATION_STATE_PATH,
} from "@/kernel/api/apiPaths";
import type { ModuleProps } from "@/kernel/types";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useLayoutActions, useLayoutSelector } from "@/kernel/layout/useLayout";
import { WorkspaceRenderProfiler } from "@/kernel/performance/reactRenderProfiler";
import {
  useGeometryCapabilitiesResource,
  useGeometryValidationResource,
  useMeshBuildCurrent,
  useMeshBuildLatestSuccessful,
  useMeshSemanticsResource,
  useMeshSharedDomainManifestResource,
  useMeshSummaryResource,
} from "@/kernel/resources/geometryLifecycleResources";
import {
  shouldLoadRuntimeMeshBuild,
  shouldLoadRuntimeMeshManifest,
  shouldLoadRuntimeMeshSummary,
  shouldLoadRuntimeStageExecution,
  useCommandQueueResource,
  useCommandDetailResource,
  useCheckpointCatalogResource,
  useSolverStatusResource,
  useStageExecutionResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  SESSION_STATUS_RESOURCE_KEY,
  useSessionStatusSelector,
} from "@/kernel/resources/useSessionStatus";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import { EMPTY_SELECTION } from "@/kernel/selection/selectionTypes";
import {
  EMPTY_OBJECT_VISUALIZATION_SNAPSHOT,
  useObjectVisualizationController,
  useObjectVisualizationSelector,
} from "@/kernel/visualization/useObjectVisualization";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import { CommandDetailDialog } from "@/shared/runtime/CommandDetailDialog";

import { buildRibbonTabContent } from "./ribbonContributions";
import { ribbonTabNeedsRuntimeResources } from "./ribbonResourcePolicy";
import { RibbonGroupsRow } from "./RibbonGroupsRow";
import { RibbonTabStrip } from "./RibbonTabStrip";
import { RIBBON_TABS } from "./ribbonTypes";

export default function RibbonModule({ kernel }: ModuleProps) {
  const [selectedCommandId, setSelectedCommandId] = useState<string | null>(null);
  const activeTab = useLayoutSelector((layout) => layout.activeModuleTab);
  const { setActiveTab } = useLayoutActions();
  const selection = useSelectionSelector((currentSelection) =>
    activeTab === "view" ? currentSelection : EMPTY_SELECTION,
  );
  const visualization = useObjectVisualizationController();
  const visualizationSnapshot = useObjectVisualizationSelector((snapshot) =>
    activeTab === "view" ? snapshot : EMPTY_OBJECT_VISUALIZATION_SNAPSHOT,
  );
  const needsGeometryResources =
    activeTab === "geometry" || activeTab === "mesh";
  const needsRuntimeResources = ribbonTabNeedsRuntimeResources(activeTab);
  const needsMeshResources = activeTab === "mesh" || needsRuntimeResources;
  const needsVisualizationResources = activeTab === "view";
  const visualizationState = useVisualizationStateResource({
    enabled: needsVisualizationResources,
  });
  const geometryCapabilities = useGeometryCapabilitiesResource({
    enabled: needsGeometryResources || needsRuntimeResources,
  });
  const geometryValidation = useGeometryValidationResource({
    enabled: needsGeometryResources || needsRuntimeResources,
  });
  const needsSessionStatusResources = needsMeshResources || needsRuntimeResources;
  const sessionStatusData = useSessionStatusSelector(
    (sessionStatus) =>
      needsSessionStatusResources ? sessionStatus.data : null,
    { enabled: needsSessionStatusResources },
  );
  const meshBuildCurrent = useMeshBuildCurrent({
    enabled: shouldLoadRuntimeMeshBuild(needsMeshResources, sessionStatusData),
  });
  const meshBuildLatest = useMeshBuildLatestSuccessful({
    enabled: shouldLoadRuntimeMeshBuild(needsMeshResources, sessionStatusData),
  });
  const meshManifest = useMeshSharedDomainManifestResource({
    enabled: shouldLoadRuntimeMeshManifest(
      needsMeshResources,
      sessionStatusData,
    ),
  });
  const meshSummary = useMeshSummaryResource({
    enabled: shouldLoadRuntimeMeshSummary(
      needsMeshResources,
      sessionStatusData,
    ),
  });
  const meshSemantics = useMeshSemanticsResource({
    enabled: needsMeshResources,
  });
  const commandQueue = useCommandQueueResource({
    enabled: needsRuntimeResources,
  });
  const solverStatus = useSolverStatusResource({
    enabled: needsRuntimeResources,
  });
  const stageExecution = useStageExecutionResource({
    enabled: shouldLoadRuntimeStageExecution(
      needsRuntimeResources,
      sessionStatusData,
    ),
  });
  const checkpointCatalog = useCheckpointCatalogResource({
    enabled: needsRuntimeResources,
  });
  const commandDetail = useCommandDetailResource(selectedCommandId);
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
          [MESHING_BUILDS_LATEST_SUCCESSFUL_PATH]: meshBuildLatest.data,
          [MESHING_SHARED_DOMAIN_MANIFEST_PATH]: meshManifest.data,
          [MESHING_SUMMARY_PATH]: meshSummary.data,
          [MODEL_GEOMETRY_CAPABILITIES_PATH]: geometryCapabilities.data,
          [MODEL_GEOMETRY_VALIDATION_PATH]: geometryValidation.data,
          [PERSISTENCE_CHECKPOINTS_PATH]: needsRuntimeResources
            ? checkpointCatalog.data
            : null,
          [SIMULATION_COMMANDS_PATH]: needsRuntimeResources
            ? commandQueue.data
            : null,
          [SIMULATION_SOLVER_STATUS_PATH]: needsRuntimeResources
            ? solverStatus.data
            : null,
          [SIMULATION_STAGES_EXECUTION_PATH]: needsRuntimeResources
            ? stageExecution.data
            : null,
          [SESSION_STATUS_RESOURCE_KEY]: needsRuntimeResources
            ? sessionStatusData
            : null,
          [VISUALIZATION_STATE_PATH]: visualizationState.data,
        },
        sourceDetail: activeTab,
      }),
    [
      activeTab,
      geometryCapabilities.data,
      geometryValidation.data,
      kernel,
      checkpointCatalog.data,
      commandQueue.data,
      meshBuildCurrent.data,
      needsRuntimeResources,
      meshBuildLatest.data,
      meshManifest.data,
      meshSummary.data,
      sessionStatusData,
      solverStatus.data,
      stageExecution.data,
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
        sessionStatus: sessionStatusData,
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
      sessionStatusData,
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
    <WorkspaceRenderProfiler id="RibbonModule">
      <div className="fm-ribbon">
      <RibbonTabStrip
        activeTabId={activeTab}
        tabs={RIBBON_TABS}
        onTabClick={setActiveTab}
      />
      <RibbonGroupsRow
        groups={groups}
        onAction={handleAction}
        onCommandDetail={setSelectedCommandId}
      />
      <CommandDetailDialog
        commandId={selectedCommandId}
        detail={commandDetail}
        onOpenChange={(open) => {
          if (!open) setSelectedCommandId(null);
        }}
      />
      </div>
    </WorkspaceRenderProfiler>
  );
}
