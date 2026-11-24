"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ChevronUp } from "lucide-react";

import type { CommandFeedbackNotice } from "@/kernel/commands/CommandFeedbackController";
import {
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  MESHING_CAPABILITIES_PATH,
  MESHING_SUMMARY_PATH,
  MODEL_GEOMETRY_CAPABILITIES_PATH,
  MODEL_SCENE_PATH,
  PERSISTENCE_CHECKPOINTS_PATH,
  VISUALIZATION_STATE_PATH,
} from "@/kernel/api/apiPaths";
import type { ModuleProps } from "@/kernel/types";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useLayoutActions, useLayoutSelector } from "@/kernel/layout/useLayout";
import { WorkspaceRenderProfiler } from "@/kernel/performance/reactRenderProfiler";
import {
  useFdmMultilayerLayoutResource,
  useGeometryCapabilitiesResource,
  useGeometryValidationResource,
  useMeshBuildCurrent,
  useMeshBuildLatestSuccessful,
  useMeshCapabilitiesResource,
  useMeshSemanticsResource,
  useMeshSharedDomainManifestResource,
  useMeshSummaryResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { visualizationSceneObjectIds } from "@/kernel/selection/visualizationTargetResolver";
import {
  shouldLoadRuntimeMeshBuild,
  shouldLoadRuntimeMeshManifest,
  shouldLoadRuntimeMeshSummary,
  shouldLoadRuntimeCommandQueue,
  shouldLoadRuntimeStageExecution,
  buildRuntimeCommandControlResourceData,
  useCommandQueueResource,
  useCommandDetailResource,
  useCheckpointCatalogResource,
  useFieldCatalogResource,
  useQuantityCatalogResource,
  useModelReadinessResource,
  useSolverStatusResource,
  useStageExecutionResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  SESSION_STATUS_RESOURCE_KEY,
  useSessionStatusSelector,
} from "@/kernel/resources/useSessionStatus";
import { resolveSessionDiscretization } from "@/kernel/resources/sessionDiscretization";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import { useAnalysisFieldOverlay } from "@/kernel/visualization/AnalysisFieldOverlayController";

import { ANALYSIS_FEATURE_MANIFESTS } from "@/kernel/analysis-modules/analysisModuleManifests";
import {
  EMPTY_OBJECT_VISUALIZATION_SNAPSHOT,
  useObjectVisualizationController,
  useObjectVisualizationSelector,
} from "@/kernel/visualization/useObjectVisualization";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import { CommandDetailDialog } from "@/shared/runtime/CommandDetailDialog";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";

import {
  buildAnalysisContextTabContent,
  buildRibbonTabContent,
  resolveRibbonVisualizationTarget,
  ribbonTabHasContent,
} from "./ribbonContributions";
import {
  RIBBON_VISUALIZATION_APPLY_GLOBAL_QUANTITY_COMMAND,
  type ApplyGlobalQuantityInput,
} from "./ribbonCommands";
import {
  ribbonTabNeedsRuntimeResources,
  ribbonTabNeedsSessionStatusResources,
} from "./ribbonResourcePolicy";
import { RibbonGroupsRow } from "./RibbonGroupsRow";
import { RibbonDensityControl } from "./RibbonDensityControl";
import { RibbonTabStrip } from "./RibbonTabStrip";
import { RibbonTargetBarControl } from "./RibbonTargetBarControl";
import { extractRibbonSceneObjects } from "./ribbonTargetContext";
import {
  getRibbonDensity,
  getServerRibbonDensity,
  setRibbonDensity,
  getRibbonExpanded,
  getServerRibbonExpanded,
  setRibbonExpanded,
  subscribeRibbonExpanded,
  toggleRibbonExpanded,
  subscribeRibbonDensity,
} from "./ribbonPreference";
import {
  ANALYSIS_CONTEXT_TAB_ID,
  RIBBON_TABS,
  type RibbonStripTabDef,
  type RibbonStripTabId,
} from "./ribbonTypes";
import { selectRibbonRuntimeStatus, ribbonRuntimeStatusEquals, contextualAnalysisModuleIdForSelection, type ContextualTabDismissalState, contextualTabDismissalForModuleChange, contextualRibbonTabIsActive } from "./RibbonModule.model";

const EMPTY_COMMAND_FEEDBACK_NOTICES: readonly CommandFeedbackNotice[] =
  Object.freeze([]);
const noopSubscribe = () => () => {};

export default function RibbonModule({ kernel }: ModuleProps) {
  const ribbonDensity = useSyncExternalStore(
    subscribeRibbonDensity,
    getRibbonDensity,
    getServerRibbonDensity,
  );
  const ribbonExpanded = useSyncExternalStore(
    subscribeRibbonExpanded,
    getRibbonExpanded,
    getServerRibbonExpanded,
  );
  // Ctrl+F1 collapses and expands the ribbon, as in desktop office suites.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "F1" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        toggleRibbonExpanded();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const subscribeCommandFeedback = useCallback(
    (listener: () => void) =>
      kernel.commandFeedback?.subscribe(listener) ?? noopSubscribe(),
    [kernel.commandFeedback],
  );
  const getCommandFeedbackSnapshot = useCallback(
    () => kernel.commandFeedback?.getSnapshot() ?? EMPTY_COMMAND_FEEDBACK_NOTICES,
    [kernel.commandFeedback],
  );
  const commandFeedbackNotices = useSyncExternalStore(
    subscribeCommandFeedback,
    getCommandFeedbackSnapshot,
    () => EMPTY_COMMAND_FEEDBACK_NOTICES,
  );
  const [selectedCommandId, setSelectedCommandId] = useState<string | null>(null);
  const [pendingGlobalQuantity, setPendingGlobalQuantity] =
    useState<ApplyGlobalQuantityInput | null>(null);
  const visibleRibbonTabs = useMemo(
    () => RIBBON_TABS.filter((tab) => ribbonTabHasContent(tab.id, kernel.commands)),
    [kernel.commands],
  );
  const storedActiveTab = useLayoutSelector((layout) => layout.activeModuleTab);
  // A restored tab that no longer has working actions falls back to Workspace.
  const activeTab = visibleRibbonTabs.some((tab) => tab.id === storedActiveTab)
    ? storedActiveTab
    : "home";
  const activeViewportMainModuleId = useLayoutSelector(
    (layout) => layout.activeViewportMainModuleId,
  );
  const viewportCompanion = useLayoutSelector(
    (layout) => layout.viewportCompanion ?? null,
  );
  const { setActiveTab } = useLayoutActions();
  const selection = useSelectionSelector((currentSelection) => currentSelection);
  const visualization = useObjectVisualizationController();
  const visualizationSnapshot = useObjectVisualizationSelector((snapshot) =>
    activeTab === "view" ? snapshot : EMPTY_OBJECT_VISUALIZATION_SNAPSHOT,
  );
  const needsGeometryResources =
    activeTab === "geometry" || activeTab === "mesh";
  const needsRuntimeResources = ribbonTabNeedsRuntimeResources(activeTab);
  const modelReadiness = useModelReadinessResource({ enabled: true });
  const needsGuideMeshResources = Boolean(
    modelReadiness.data?.checks.some(
      (check) =>
        check.id === "discretization" &&
        check.state !== "complete" &&
        check.target_resource === "meshing/builds/current",
    ),
  );
  const needsMeshResources =
    activeTab === "mesh" ||
    needsRuntimeResources ||
    needsGuideMeshResources ||
    (activeTab === "view" && selection.ref?.type === "mesh-part");
  const needsVisualizationResources = activeTab === "view";
  const visualizationState = useVisualizationStateResource({
    enabled: needsVisualizationResources,
  });
  const fieldCatalog = useFieldCatalogResource({
    enabled: needsVisualizationResources,
  });
  const quantityCatalog = useQuantityCatalogResource({
    enabled: needsVisualizationResources,
  });
  const geometryCapabilities = useGeometryCapabilitiesResource({
    enabled: needsGeometryResources || needsRuntimeResources || needsGuideMeshResources,
  });
  const geometryValidation = useGeometryValidationResource({
    enabled: needsGeometryResources || needsRuntimeResources || needsGuideMeshResources,
  });
  const needsSessionStatusResources = ribbonTabNeedsSessionStatusResources(
    activeTab,
    needsMeshResources,
  );
  const sessionStatusData = useSessionStatusSelector(
    selectRibbonRuntimeStatus,
    {
      enabled: needsSessionStatusResources,
      isEqual: ribbonRuntimeStatusEquals,
    },
  );
  const meshBuildCurrent = useMeshBuildCurrent({
    enabled: shouldLoadRuntimeMeshBuild(needsMeshResources, sessionStatusData),
  });
  const meshBuildLatest = useMeshBuildLatestSuccessful({
    enabled: shouldLoadRuntimeMeshBuild(needsMeshResources, sessionStatusData),
  });
  const meshCapabilities = useMeshCapabilitiesResource({
    enabled: needsMeshResources,
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
  const scene = useSceneResource({
    enabled:
      activeTab === "home" ||
      activeTab === "view" ||
      activeTab === "definitions" ||
      activeTab === "geometry" ||
      activeTab === "materials" ||
      activeTab === "mesh" ||
      activeTab === "physics" ||
      activeTab === "study" ||
      activeTab === "results" ||
      activeTab === "automation" ||
      needsGuideMeshResources,
  });
  const isTargetScopedTab =
    activeTab === "view" ||
    activeTab === "geometry" ||
    activeTab === "materials" ||
    activeTab === "physics" ||
    activeTab === "mesh";
  const fdmMultilayerLayout = useFdmMultilayerLayoutResource({
    enabled:
      isTargetScopedTab &&
      sessionStatusData?.domain?.discretization === "fdm",
  });
  const ribbonSceneObjects = useMemo(
    () => extractRibbonSceneObjects(scene.data),
    [scene.data],
  );
  const resolvedDiscretization =
    sessionStatusData === null
      ? "unknown"
      : resolveSessionDiscretization(sessionStatusData) ?? "unknown";
  const sceneObjectIds = useMemo(
    () => visualizationSceneObjectIds(scene.data),
    [scene.data],
  );
  const selectedMeshPart = useMemo(
    () =>
      selection.ref?.type === "mesh-part"
        ? meshManifest.data?.mesh_parts?.find(
            (part) => part.id === selection.ref?.nodeId,
          ) ?? null
        : null,
    [meshManifest.data?.mesh_parts, selection.ref],
  );
  const commandQueue = useCommandQueueResource({
    enabled: shouldLoadRuntimeCommandQueue(
      needsRuntimeResources,
      sessionStatusData,
    ),
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
  const objectMoveToolState = useSyncExternalStore(
    (listener) => kernel.objectMoveTool.subscribe(listener),
    () => kernel.objectMoveTool.getSnapshot(),
    () => null,
  );

  const visualizationTarget = useMemo(
    () =>
      resolveRibbonVisualizationTarget({
        discretization: resolvedDiscretization,
        fdmMultilayerLayout: fdmMultilayerLayout.data,
        sceneObjectIds,
        selectedMeshPart,
        selection,
        sessionStatus: sessionStatusData,
        visualizationState: visualizationState.data,
      }),
    [
      fdmMultilayerLayout.data,
      resolvedDiscretization,
      sceneObjectIds,
      selectedMeshPart,
      selection,
      sessionStatusData,
      visualizationState.data,
    ],
  );

  const commandContext = useMemo(
    () =>
      createCommandContext("ribbon", kernel, {
        resourceData: {
          ...buildRuntimeCommandControlResourceData({
            commandQueue: needsRuntimeResources ? commandQueue.data : null,
            geometryValidation: geometryValidation.data,
            meshBuildCurrent: meshBuildCurrent.data,
            meshManifest: meshManifest.data,
            modelReadinessData: modelReadiness.data,
            modelReadinessStatus: modelReadiness.status,
            sessionStatus: needsSessionStatusResources
              ? sessionStatusData
              : null,
            solverStatus: needsRuntimeResources ? solverStatus.data : null,
            stageExecution: needsRuntimeResources ? stageExecution.data : null,
          }),
          [SESSION_STATUS_RESOURCE_KEY]: needsSessionStatusResources
            ? sessionStatusData
            : null,
          [MESHING_BUILDS_LATEST_SUCCESSFUL_PATH]: meshBuildLatest.data,
          [MESHING_CAPABILITIES_PATH]: meshCapabilities.data,
          [MESHING_SUMMARY_PATH]: meshSummary.data,
          [MODEL_GEOMETRY_CAPABILITIES_PATH]: geometryCapabilities.data,
          [MODEL_SCENE_PATH]: scene.status === "ready" &&
            (activeTab !== "physics" || scene.sessionScopeKey === kernel.commands.getSessionScopeKey?.())
            ? scene.data : null,
          [PERSISTENCE_CHECKPOINTS_PATH]: needsRuntimeResources
            ? checkpointCatalog.data
            : null,
          [VISUALIZATION_STATE_PATH]: visualizationState.data,
        },
        sourceDetail: activeTab,
        visualizationTarget,
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
      meshCapabilities.data,
      meshManifest.data,
      meshSummary.data,
      scene.data,
      scene.status,
      scene.sessionScopeKey,
      modelReadiness.data,
      modelReadiness.status,
      needsSessionStatusResources,
      sessionStatusData,
      solverStatus.data,
      stageExecution.data,
      visualizationState.data,
      visualizationTarget,
    ],
  );

  const activeOverlay = useAnalysisFieldOverlay(kernel.analysisFieldOverlay, {
    ignorePhase: true,
  });
  const activeAnalysisFieldId = activeOverlay?.fieldId ?? null;
  const activeAnalysisFieldLabel = activeOverlay?.label ?? null;
  const activeAnalysisField = useMemo(
    () =>
      activeAnalysisFieldId
        ? { fieldId: activeAnalysisFieldId, label: activeAnalysisFieldLabel ?? activeAnalysisFieldId }
        : null,
    [activeAnalysisFieldId, activeAnalysisFieldLabel],
  );

  // Contextual tab of the analysis module that owns the selected Results node
  // (ADR 0054). It is shown, and active, whenever such a node is selected;
  // choosing another tab dismisses it until a different module's node is selected.
  // Read independently of `selection`, which is only populated on the View and
  // Geometry tabs; the contextual tab must follow every Results selection.
  const contextModuleId = useSelectionSelector(contextualAnalysisModuleIdForSelection);
  const contextModuleTitle = contextModuleId
    ? ANALYSIS_FEATURE_MANIFESTS.find((manifest) => manifest.id === contextModuleId)?.title ?? null
    : null;
  const [contextualTabDismissal, setContextualTabDismissal] =
    useState<ContextualTabDismissalState>(() => ({
      contextModuleId,
      dismissed: false,
    }));
  if (contextualTabDismissal.contextModuleId !== contextModuleId) {
    setContextualTabDismissal((state) =>
      contextualTabDismissalForModuleChange(state, contextModuleId)
    );
  }
  const contextTabActive = contextualRibbonTabIsActive(
    contextualTabDismissal,
    contextModuleId,
    Boolean(contextModuleTitle),
  );
  const stripActiveTab: RibbonStripTabId = contextTabActive ? ANALYSIS_CONTEXT_TAB_ID : activeTab;
  const stripTabs = useMemo<readonly RibbonStripTabDef[]>(() => {
    if (!contextModuleTitle) return visibleRibbonTabs;
    const resultsIndex = visibleRibbonTabs.findIndex((tab) => tab.id === "results");
    return [
      ...visibleRibbonTabs.slice(0, resultsIndex + 1),
      { contextual: true, id: ANALYSIS_CONTEXT_TAB_ID, label: contextModuleTitle },
      ...visibleRibbonTabs.slice(resultsIndex + 1),
    ];
  }, [contextModuleTitle, visibleRibbonTabs]);
  const handleTabClick = useCallback(
    (tabId: RibbonStripTabId) => {
      if (tabId === ANALYSIS_CONTEXT_TAB_ID) {
        setContextualTabDismissal({ contextModuleId, dismissed: false });
        return;
      }
      setContextualTabDismissal({
        contextModuleId,
        dismissed: contextModuleId !== null,
      });
      setActiveTab(tabId);
    },
    [contextModuleId, setActiveTab],
  );

  const tabContent = useMemo(
    () => {
      void commandVersion;
      void objectMoveToolState;
      // Active command state reads the live layout from commandContext.
      // These narrow subscriptions invalidate this memo when the composition changes.
      void activeViewportMainModuleId;
      void viewportCompanion;
      const buildContext = {
        activeAnalysisField,
        api: kernel.api,
        commandContext,
        commandFeedback: commandFeedbackNotices,
        commandQueue: commandQueue.data ?? null,
        commands: kernel.commands,
        fdmMultilayerLayout: fdmMultilayerLayout.data,
        fieldCatalog: fieldCatalog.data,
        quantityCatalog: quantityCatalog.data,
        meshBuildCurrent: meshBuildCurrent.data,
        meshBuildLatest: meshBuildLatest.data,
        meshCapabilities: meshCapabilities.data,
        meshSemantics: meshSemantics.data,
        meshSummary: meshSummary.data,
        resources: kernel.resources,
        scene: scene.data,
        selection,
        sceneObjectIds,
        selectedMeshPart,
        sessionStatus: sessionStatusData,
        visualization,
        visualizationSnapshot,
        visualizationState: visualizationState.data,
      };
      return contextTabActive
        ? buildAnalysisContextTabContent(buildContext)
        : buildRibbonTabContent(activeTab, buildContext);
    },
    [
      activeAnalysisField,
      activeViewportMainModuleId,
      activeTab,
      commandFeedbackNotices,
      commandQueue.data,
      contextTabActive,
      commandContext,
      commandVersion,
      objectMoveToolState,
      fdmMultilayerLayout.data,
      fieldCatalog.data,
      quantityCatalog.data,
      kernel.api,
      kernel.commands,
      kernel.resources,
      meshBuildCurrent.data,
      meshBuildLatest.data,
      meshCapabilities.data,
      meshSemantics.data,
      meshSummary.data,
      scene.data,
      selection,
      sceneObjectIds,
      selectedMeshPart,
      sessionStatusData,
      visualization,
      visualizationSnapshot,
      visualizationState.data,
      viewportCompanion,
    ],
  );
  const groups = tabContent?.groups ?? [];

  function handleAction(actionId: string, input?: unknown): void {
    if (
      actionId === RIBBON_VISUALIZATION_APPLY_GLOBAL_QUANTITY_COMMAND &&
      isGlobalQuantityConfirmationInput(input)
    ) {
      setPendingGlobalQuantity(input);
      return;
    }
    void kernel.commands.execute(actionId, commandContext, input);
  }

  function confirmGlobalQuantity(): void {
    if (!pendingGlobalQuantity) return;
    const input: ApplyGlobalQuantityInput = {
      ...pendingGlobalQuantity,
      requiresConfirmation: false,
    };
    setPendingGlobalQuantity(null);
    void kernel.commands.execute(
      RIBBON_VISUALIZATION_APPLY_GLOBAL_QUANTITY_COMMAND,
      commandContext,
      input,
    );
  }

  return (
    <WorkspaceRenderProfiler id="RibbonModule">
      <div className="fm-ribbon" data-density={ribbonDensity} data-expanded={ribbonExpanded}>
      <div className="fm-ribbon__tabbar">
        <RibbonTabStrip
          activeTabId={stripActiveTab}
          tabs={stripTabs}
          onTabClick={handleTabClick}
          onTabPress={(tabId) => {
            // A collapsed ribbon opens on the tab the user picks.
            if (!ribbonExpanded) setRibbonExpanded(true);
            handleTabClick(tabId);
          }}
          onTabDoubleClick={(tabId) => {
            if (tabId === stripActiveTab) toggleRibbonExpanded();
          }}
        />
        <div className="fm-ribbon__chrome">
          {isTargetScopedTab ? (
            <RibbonTargetBarControl
              activeTab={activeTab}
              discretization={resolvedDiscretization}
              fdmMultilayerLayout={fdmMultilayerLayout.data}
              sceneObjects={ribbonSceneObjects}
              selection={selection}
              visualizationTarget={visualizationTarget}
              onAction={handleAction}
            />
          ) : null}
          {ribbonExpanded ? (
            <RibbonDensityControl density={ribbonDensity} onChange={setRibbonDensity} />
          ) : null}
          <button
            aria-controls="fm-ribbon-tabpanel"
            aria-expanded={ribbonExpanded}
            aria-label={ribbonExpanded ? "Collapse ribbon" : "Expand ribbon"}
            className="fm-ribbon__toggle"
            title={ribbonExpanded ? "Collapse ribbon (Ctrl+F1)" : "Expand ribbon (Ctrl+F1)"}
            type="button"
            onClick={() => toggleRibbonExpanded()}
          >
            <ChevronUp aria-hidden="true" size={15} />
          </button>
        </div>
      </div>
      <RibbonGroupsRow
        groups={groups}
        activeTabId={stripActiveTab}
        density={ribbonDensity}
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
      <Dialog
        open={pendingGlobalQuantity !== null}
        onOpenChange={(open) => {
          if (!open) setPendingGlobalQuantity(null);
        }}
      >
        <DialogContent aria-describedby="fm-global-quantity-description">
          <DialogHeader>
            <DialogTitle>Apply Global Quantity</DialogTitle>
            <DialogDescription id="fm-global-quantity-description">
              This will replace per-target quantity choices with{" "}
              {pendingGlobalQuantity?.activeQuantityId ?? "the selected quantity"}.
            </DialogDescription>
          </DialogHeader>
          <p className="fm-dialog__description">
            {pendingGlobalQuantity?.targetQuantityOverrideCount ?? 0} target
            quantities are currently different from the global quantity.
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button type="button" variant="primary" onClick={confirmGlobalQuantity}>
              Apply Globally
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </WorkspaceRenderProfiler>
  );
}

function isGlobalQuantityConfirmationInput(
  input: unknown,
): input is ApplyGlobalQuantityInput {
  return (
    Boolean(input) &&
    typeof input === "object" &&
    (input as ApplyGlobalQuantityInput).requiresConfirmation === true &&
    typeof (input as ApplyGlobalQuantityInput).activeQuantityId === "string"
  );
}
