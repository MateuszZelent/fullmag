"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { DataPlaneStatusBadges } from "./control-room/DataPlaneStatusBadges";
import RunSidebar from "./control-room/RunSidebar";
import { ViewportBar, ViewportCanvasArea } from "./control-room/ViewportPanels";
import { ViewportTabBar } from "./control-room/ViewportTabBar";
import { WorkspaceBodyLayout } from "./control-room/WorkspaceBodyLayout";
import ControlRoomAppBar from "./control-room/ControlRoomAppBar";
import ControlRoomPreviewNotices from "./control-room/ControlRoomPreviewNotices";
import ControlRoomRibbonBar from "./control-room/ControlRoomRibbonBar";
import ControlRoomStatusBar from "./control-room/ControlRoomStatusBar";
import {
  InitializingWorkspaceState,
  NoActiveWorkspaceState,
} from "./control-room/ControlRoomStartupStates";



import {
  ControlRoomProvider,
} from "./control-room/ControlRoomContext";
import { useAutoResultsNavigation } from "./control-room/useAutoResultsNavigation";
import { useBuilderRibbonActions } from "./control-room/useBuilderRibbonActions";
import { useRibbonVisualizationActions } from "./control-room/useRibbonVisualizationActions";
import { useSelectedObjectRibbonDisplay } from "./control-room/useSelectedObjectRibbonDisplay";
import { useViewport3DStatus } from "./control-room/useViewport3DStatus";
import { useRibbonHandlers } from "./control-room/hooks/useRibbonHandlers";
import {
  useTransport,
  useViewport,
  useCommand,
  useModel,
} from "./control-room/context-hooks";
import {
  PANEL_SIZES,
} from "./control-room/shared";

import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import BackendErrorNotice from "./control-room/BackendErrorNotice";
import MeshBuildModal from "./control-room/MeshBuildModal";

import { WorkspaceRightToolbox } from "../workspace/modes/WorkspaceModeInspectors";
import { useAnalyzeStore } from "@/features/analyze";
import {
  useSelectionActions,
  useSelectedSidebarNodeId,
} from "@/features/selection";
import { useRenderMode } from "@/features/visualization/hooks/useVizSlice";
import { useVisualizationStore } from "@/features/visualization/store/useVisualizationStore";
import { useWorkspaceGraphBridge } from "@/features/workspace-graph";
import type { WorkspaceMode } from "./control-room/context-hooks";
import SettingsDialog from "../workspace/overlays/SettingsDialog";
import PhysicsDocsDrawer from "../workspace/overlays/PhysicsDocsDrawer";
import WorkspaceDockingShell from "../workspace/docking/WorkspaceDockingShell";
import { useActiveStageLayout, useWorkspaceStore } from "@/lib/workspace/workspace-store";
import {
  createDefaultDockLayout,
  resolveDockResponsivePreset,
} from "@/components/workspace/docking/dockLayoutDefaults";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { recordFrontendRender } from "@/lib/debug/frontendPerfDebug";
import { resolveFemDiscretization } from "@/src/domain/capabilities";
import {
  appendNode,
  createMacroNode,
  createPrimitiveNode,
  duplicateNode,
  insertNodeNear,
  toggleNodeEnabled,
} from "@/lib/study-builder/operations";
import { materializeStudyPipeline } from "@/lib/study-builder/materialize";
import { migrateFlatStagesToStudyPipeline } from "@/lib/study-builder/migrate";
import { buildPipelineStudyStageNodeId } from "@/lib/study-builder/node-context";
import type {
  StudyPipelineDocument,
  StudyPrimitiveStageKind,
} from "@/lib/study-builder/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  visualizationPatchForClip,
  visualizationPatchForFemLayers,
  visualizationPatchForOpacity,
} from "./control-room/visualizationStateSync";
import {
  launchDisplayName,
  resolveControlRoomStartupState,
} from "./control-room/controlRoomShellHelpers";
import { useMeshBuildFlow } from "./control-room/useMeshBuildFlow";
import type { DockLayoutModel } from "@/lib/workspace/dockLayoutContract";
import type { WorkspacePanelId } from "@/components/shell/ribbon/command-registry";
const DEFAULT_PANEL_DOCKS = {
  build: {
    explorer: "model",
    inspector: "properties",
    telemetry: "messages",
  },
  study: {
    explorer: "study-tree",
    inspector: "solver",
    telemetry: "jobs",
  },
  analyze: {
    explorer: "results-tree",
    inspector: "display",
    telemetry: "charts",
  },
} as const;
const PANEL_COMPONENT_BY_ID: Record<WorkspacePanelId, "dock-left" | "dock-right" | "dock-bottom"> = {
  explorer: "dock-left",
  inspector: "dock-right",
  telemetry: "dock-bottom",
};

function cloneDockLayoutModel(model: DockLayoutModel): DockLayoutModel {
  return JSON.parse(JSON.stringify(model)) as DockLayoutModel;
}

function layoutNodeContainsComponent(node: unknown, component: string): boolean {
  if (!node || typeof node !== "object") {
    return false;
  }
  const typedNode = node as {
    type?: string;
    component?: string;
    children?: unknown[];
  };
  if (typedNode.type === "tab") {
    return typedNode.component === component;
  }
  if (Array.isArray(typedNode.children)) {
    return typedNode.children.some((child) => layoutNodeContainsComponent(child, component));
  }
  return false;
}

function replaceLayoutPanelNode(
  node: unknown,
  component: string,
  replacement: unknown,
): { nextNode: unknown; replaced: boolean } {
  if (!node || typeof node !== "object") {
    return { nextNode: node, replaced: false };
  }
  const typedNode = node as {
    type?: string;
    children?: unknown[];
  };
  if (typedNode.type === "tabset" && layoutNodeContainsComponent(typedNode, component)) {
    return { nextNode: replacement, replaced: true };
  }
  if (!Array.isArray(typedNode.children)) {
    return { nextNode: node, replaced: false };
  }
  let replaced = false;
  const nextChildren = typedNode.children.map((child) => {
    if (replaced || !layoutNodeContainsComponent(child, component)) {
      return child;
    }
    const result = replaceLayoutPanelNode(child, component, replacement);
    replaced = result.replaced;
    return result.nextNode;
  });
  if (!replaced) {
    return { nextNode: node, replaced: false };
  }
  return {
    nextNode: {
      ...typedNode,
      children: nextChildren,
    },
    replaced: true,
  };
}

function findPanelNodeInLayout(node: unknown, component: string): unknown | null {
  if (!node || typeof node !== "object") {
    return null;
  }
  const typedNode = node as {
    type?: string;
    children?: unknown[];
  };
  if (typedNode.type === "tabset" && layoutNodeContainsComponent(typedNode, component)) {
    return typedNode;
  }
  if (!Array.isArray(typedNode.children)) {
    return null;
  }
  for (const child of typedNode.children) {
    if (!layoutNodeContainsComponent(child, component)) {
      continue;
    }
    const nested = findPanelNodeInLayout(child, component);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function replaceBorderPanelNode(
  borders: unknown,
  component: string,
  replacement: unknown,
): unknown[] {
  const currentBorders = Array.isArray(borders) ? borders : [];
  let replaced = false;
  const nextBorders = currentBorders.map((border) => {
    if (replaced || !layoutNodeContainsComponent(border, component)) {
      return border;
    }
    replaced = true;
    return replacement;
  });
  if (replaced || !replacement) {
    return nextBorders;
  }
  return [...nextBorders, replacement];
}

function resetDockPanelSize(
  model: DockLayoutModel,
  defaultModel: DockLayoutModel,
  panel: WorkspacePanelId,
): DockLayoutModel {
  const component = PANEL_COMPONENT_BY_ID[panel];
  const nextModel = cloneDockLayoutModel(model);
  const defaultLayout = defaultModel.layout;
  const defaultBorders = Array.isArray(defaultModel.borders) ? defaultModel.borders : [];
  const layoutReplacement = findPanelNodeInLayout(defaultLayout, component);
  const borderReplacement = defaultBorders.find((border) => layoutNodeContainsComponent(border, component)) ?? null;

  if (layoutReplacement) {
    const replacedLayout = replaceLayoutPanelNode(nextModel.layout, component, layoutReplacement);
    nextModel.layout = replacedLayout.nextNode as DockLayoutModel["layout"];
  }
  if (borderReplacement) {
    nextModel.borders = replaceBorderPanelNode(nextModel.borders, component, borderReplacement) as DockLayoutModel["borders"];
  }
  return nextModel;
}

/* ── Inner shell (consumes context) ── */

export function ControlRoomShell({ initialWorkspaceMode }: { initialWorkspaceMode?: WorkspaceMode }) {
  if (FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging) {
    recordFrontendRender("ControlRoomShell", {
      initialWorkspaceMode: initialWorkspaceMode ?? "study",
    });
  }
  /* Granular hooks replacing useControlRoom */
  const _transport = useTransport();
  const _viewport = useViewport();
  const _cmd = useCommand();
  const _model = useModel();
  const selectedSidebarNodeId = useSelectedSidebarNodeId();
  const { setSelectedObjectId } = useSelectionActions();
  const meshRenderMode = useRenderMode();
  const setMagneticTextureDensity = useVisualizationStore((s) => s.setFemTextureDownsampleCells);
  const startupState = resolveControlRoomStartupState({
    hasSession: _cmd.session != null,
    error: _cmd.error,
  });

  const femDiscretization = resolveFemDiscretization(
    _cmd.domainCapabilities,
    _cmd.isFemBackend,
  );
  const sidebarCollapsed = _viewport.sidebarCollapsed;
  const setSidebarCollapsed = _viewport.setSidebarCollapsed;
  const workspaceStage = _viewport.workspaceStage;
  const setWorkspaceStage = _viewport.setWorkspaceStage;
  const effectiveViewMode = _viewport.effectiveViewMode;
  const handleViewModeChange = _viewport.handleViewModeChange;
  const quickPreviewTargets = _viewport.quickPreviewTargets;
  const requestPreviewQuantity = _viewport.requestPreviewQuantity;
  const scriptPath = _cmd.sessionFooter.scriptPath;
  const router = useRouter();
  const pathname = usePathname();
  const activeStageLayout = useActiveStageLayout();
  const launchIntent = useWorkspaceStore((state) => state.launchIntent);
  const rightInspectorOpen = useWorkspaceStore((state) => state.rightInspectorOpen);
  const setRightInspectorOpen = useWorkspaceStore((state) => state.setRightInspectorOpen);
  const setRightInspectorTab = useWorkspaceStore((state) => state.setRightInspectorTab);
  const dockLayoutByStage = useWorkspaceStore((state) => state.dockLayoutByStage);
  const setLeftDock = useWorkspaceStore((state) => state.setLeftDock);
  const setRightDock = useWorkspaceStore((state) => state.setRightDock);
  const setBottomDock = useWorkspaceStore((state) => state.setBottomDock);
  const setDockLayout = useWorkspaceStore((state) => state.setDockLayout);
  const activeCoreTab = useWorkspaceStore((state) => state.activeCoreTab);
  const setActiveCoreTab = useWorkspaceStore((state) => state.setActiveCoreTab);
  const setActiveContextualTab = useWorkspaceStore((state) => state.setActiveContextualTab);
  const workspaceTabsByStage = useWorkspaceStore((state) => state.workspaceTabsByStage);
  const activeWorkspaceTabByStage = useWorkspaceStore((state) => state.activeWorkspaceTabByStage);
  const currentStage = useWorkspaceStore((state) => state.currentStage);
  const analyzeResultsWorkspace = useAnalyzeStore((state) => state.resultsWorkspace);
  const [viewportSize, setViewportSize] = useState({ width: 1920, height: 1080 });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => {
      setViewportSize({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const compactHorizontalLayout = viewportSize.width < 1360;
  const autoCollapseSidebar = viewportSize.width < 1080;
  const compactVerticalLayout = viewportSize.height < 940;

  useEffect(() => {
    if (autoCollapseSidebar && !sidebarCollapsed) {
      setSidebarCollapsed(true);
    }
  }, [autoCollapseSidebar, setSidebarCollapsed, sidebarCollapsed]);

  const rightInspectorDefaultSize = compactHorizontalLayout ? "18%" : PANEL_SIZES.rightInspectorDefault;
  const rightInspectorMinSize = compactHorizontalLayout ? "10%" : PANEL_SIZES.rightInspectorMin;
  const rightInspectorMaxSize = compactHorizontalLayout ? "36%" : PANEL_SIZES.rightInspectorMax;
  const workspaceTitle = launchDisplayName(launchIntent) ?? _cmd.session?.problem_name ?? "Local Live Workspace";

  useEffect(() => {
    if (!initialWorkspaceMode) return;
    const initialStage = initialWorkspaceMode === "build" ? "build" : "study";
    if (workspaceStage !== initialStage) {
      setWorkspaceStage(initialStage);
    }
  }, [initialWorkspaceMode, setWorkspaceStage, workspaceStage]);

  useEffect(() => {
    const next = Boolean(activeStageLayout.rightDock);
    if (rightInspectorOpen !== next) {
      setRightInspectorOpen(next);
    }
  }, [activeStageLayout.rightDock, rightInspectorOpen, setRightInspectorOpen]);

  const handleRestoreWorkspacePanel = useCallback(
    (panel: WorkspacePanelId) => {
      const stage = currentStage;
      const preset = resolveDockResponsivePreset(viewportSize.width);
      const currentEnvelope = dockLayoutByStage[stage][preset];
      const currentModel = currentEnvelope?.model ?? createDefaultDockLayout(preset);
      const defaultModel = createDefaultDockLayout(preset);

      if (panel === "explorer") {
        setSidebarCollapsed(false);
        setLeftDock(stage, DEFAULT_PANEL_DOCKS[stage].explorer);
      } else if (panel === "inspector") {
        setRightInspectorOpen(true);
        setRightDock(stage, DEFAULT_PANEL_DOCKS[stage].inspector);
      } else {
        setBottomDock(stage, DEFAULT_PANEL_DOCKS[stage].telemetry);
      }

      setDockLayout(stage, preset, resetDockPanelSize(currentModel, defaultModel, panel));
    },
    [
      currentStage,
      dockLayoutByStage,
      setBottomDock,
      setDockLayout,
      setLeftDock,
      setRightDock,
      setRightInspectorOpen,
      setSidebarCollapsed,
      viewportSize.width,
    ],
  );

  const handleHideWorkspacePanel = useCallback(
    (panel: WorkspacePanelId) => {
      const stage = currentStage;
      if (panel === "explorer") {
        setSidebarCollapsed(true);
        setLeftDock(stage, null);
        return;
      }
      if (panel === "inspector") {
        setRightInspectorOpen(false);
        setRightDock(stage, null);
        return;
      }
      setBottomDock(stage, null);
    },
    [
      currentStage,
      setBottomDock,
      setLeftDock,
      setRightDock,
      setRightInspectorOpen,
      setSidebarCollapsed,
    ],
  );

  const explorerVisible = !sidebarCollapsed && Boolean(activeStageLayout.leftDock);
  const inspectorVisible = rightInspectorOpen && Boolean(activeStageLayout.rightDock);
  const telemetryVisible = Boolean(activeStageLayout.bottomDock);

  const spatialPreview = _transport.preview?.kind === "spatial" ? _transport.preview : null;
  const { handleViewportHealthChange, viewport3DStatus } = useViewport3DStatus({
    femDiscretization,
    model: _model,
    spatialPreview,
    viewport: _viewport,
  });
  const {
    builderModeEnabled,
    handleBuilderAddPrimitive,
    handleBuilderBuildAll,
    handleBuilderBuildGeometry,
    handleBuilderBuildMesh,
    handleBuilderCenterInUniverse,
    handleBuilderFocusSelected,
    handleBuilderFrameAll,
    handleBuilderSetTransformTool,
    handleBuilderSetViewportMode,
    handleBuilderValidateGeometry,
    toggleBuilderSnap,
  } = useBuilderRibbonActions({
    activeCoreTab,
    currentStage,
    femDiscretization,
    model: _model,
    setActiveCoreTab,
    setRightInspectorOpen,
    viewport: _viewport,
    workspaceStage,
  });
  const authoringStudyDocument = useMemo<StudyPipelineDocument>(
    () => (_model.studyPipeline as StudyPipelineDocument | null) ?? migrateFlatStagesToStudyPipeline(_model.studyStages),
    [_model.studyPipeline, _model.studyStages],
  );

  const {
    selectedAntennaName,
    openAnalyzeCenterTab,
    handleSelectModelNode,
    handleAddAntenna,
    handleCreateVisualizationPreset,
    handleObjectAddInteraction,
    handleAssignMagnetizationPreset,
    handleSetTransformScope,
    handleSetTextureTransformMode,
    handleStudyAddPrimitive,
    handleStudyAddMacro,
    handleStudyDuplicateSelected,
    handleStudyToggleSelectedEnabled,
    handleAddResultAnalysis,
  } = useRibbonHandlers({
    _model,
    _cmd,
    _viewport,
    selectedSidebarNodeId,
    authoringStudyDocument,
    setActiveCoreTab,
    setActiveContextualTab,
  });
  useWorkspaceGraphBridge({
    enabled:
      FRONTEND_DIAGNOSTIC_FLAGS.workspace.enableGraphV2 &&
      FRONTEND_DIAGNOSTIC_FLAGS.workspace.enableWorkspaceGraphBridge,
    projectLabel: workspaceTitle,
    workspaceMode: currentStage,
    workspaceTabs: workspaceTabsByStage,
    activeWorkspaceTabByStage,
    selectedNodeId: selectedSidebarNodeId,
    studyPipeline: authoringStudyDocument,
    resultsWorkspace: analyzeResultsWorkspace,
    quantities: _cmd.quantities,
    scalarRows: _transport.scalarRows,
    requestedPreviewQuantity: _viewport.requestedPreviewQuantity,
    requestedPreviewComponent: _viewport.requestedPreviewComponent,
    plane: _viewport.plane,
    sliceIndex: _viewport.sliceIndex,
    viewMode: _viewport.effectiveViewMode,
    renderMode: meshRenderMode,
  });
  useKeyboardShortcuts();

  const [dismissedBackendErrorAt, setDismissedBackendErrorAt] = useState<number | null>(null);

  const hasSharedAirboxDomain =
    _model.effectiveFemMesh?.domain_mesh_mode === "shared_domain_mesh_with_air";
  const activeBackendError = useMemo(
    () =>
      _cmd.latestBackendError &&
      _cmd.latestBackendError.timestampUnixMs !== dismissedBackendErrorAt
        ? _cmd.latestBackendError
        : null,
    [_cmd.latestBackendError, dismissedBackendErrorAt],
  );
  const {
    activeMeshIntent,
    effectiveMeshTargets,
    meshBuildBackendError,
    meshBuildDialogOpen,
    meshBuildError,
    meshBuildIntent,
    meshBuildNotice,
    meshBuildProgress,
    meshBuildRuntime,
    meshBuildStages,
    handleBackgroundMeshBuild,
    handleBuildMeshAll,
    handleBuildMeshSelected,
    handleCloseMeshBuildDialog,
    handleOpenMeshInspector,
    handleOpenMeshMethod,
    handleOpenMeshOptimization,
    handleOpenMeshPipeline,
    handleOpenMeshQuality,
    handleOpenMeshSize,
    handleOpenMeshStatistics,
    handleOpenMeshTransition,
  } = useMeshBuildFlow({
    command: _cmd,
    model: _model,
    viewport: _viewport,
    hasSharedAirboxDomain,
    scriptPath,
    selectModelNode: handleSelectModelNode,
    setRightInspectorOpen,
    setRightInspectorTab,
  });

  useAutoResultsNavigation({
    artifacts: _cmd.artifacts,
    openAnalyzeCenterTab,
    run: _cmd.run,
    scalarRows: _transport.scalarRows,
    selectedSidebarNodeId: selectedSidebarNodeId,
    session: _cmd.session,
    selectSidebarNode: _model.selectSidebarNode,
    workspaceStatus: _cmd.workspaceStatus,
  });

  const {
    airboxDisplayState,
    airMeshRenderMode,
    handleDispatchVisualization,
    handleRibbonAirboxDisplay,
    handleRibbonFemArrowStyle,
    handleRibbonMeshRenderMode,
    handleRibbonPreviewAutoScale,
    handleRibbonPreviewColormap,
    handleRibbonPreviewComponent,
    handleRibbonPreviewEveryN,
    handleRibbonPreviewMaxPoints,
    handleRibbonSlice2DToolbar,
    ribbonAirboxVisible,
    ribbonFemLayers,
    slice2DToolbar,
  } = useRibbonVisualizationActions({
    femDiscretization,
    model: _model,
    viewport: _viewport,
  });

  const {
    selectedObjectOpacity,
    selectedObjectRenderMode,
    selectedObjectTextureVisible,
    handleClearSelectedDisplayOverrides,
    handleSelectedObjectOpacity,
    handleSelectedObjectRenderMode,
    handleSelectedObjectTextureVisible,
  } = useSelectedObjectRibbonDisplay(_model);

  /* ── Startup state ── */
  if (startupState === "no-active-workspace") {
    return <NoActiveWorkspaceState onOpenLauncher={() => router.push("/")} />;
  }

  if (!FRONTEND_DIAGNOSTIC_FLAGS.workspace.enableControlRoomShell) {
    return (
      <div className="flex min-h-[50vh] w-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
        ControlRoomShell disabled by diagnostic flag:
        <code className="mx-1">workspace.enableControlRoomShell = false</code>.
      </div>
    );
  }

  return (
    <div className="relative h-full flex flex-col overflow-hidden bg-background font-sans text-base text-foreground">
      <ControlRoomAppBar problemName={workspaceTitle} />
      {FRONTEND_DIAGNOSTIC_FLAGS.shell.showRibbonBar ? <ControlRoomRibbonBar
        viewport3DStatus={viewport3DStatus.status}
        viewport3DStatusReason={viewport3DStatus.reason}
        viewport3DStatusDetail={viewport3DStatus.detail}
        explorerVisible={explorerVisible}
        inspectorVisible={inspectorVisible}
        telemetryVisible={telemetryVisible}
        onCreateVisualizationPreset={handleCreateVisualizationPreset}
        airboxVisible={ribbonAirboxVisible}
        onToggleAirbox={() =>
          void _viewport.patchDisplay({
            layers: {
              airbox: {
                visible: !ribbonAirboxVisible,
              },
            },
          })
        }
        primitiveVisible={ribbonFemLayers.showPrimitives}
        magneticTextureVisible={ribbonFemLayers.showMagneticTexture}
        quantityShaderVisible={ribbonFemLayers.showQuantity}
        selectedObjectTextureVisible={selectedObjectTextureVisible}
        selectedObjectOpacity={selectedObjectOpacity}
        selectedObjectRenderMode={selectedObjectRenderMode}
        meshTrim={_model.resolvedRenderPlan?.trim ?? null}
        airMeshRenderMode={airMeshRenderMode}
        airMeshGeometryVisible={airboxDisplayState.geometryVisible}
        airMeshSurfaceVisible={airboxDisplayState.surface}
        airMeshWireframeVisible={airboxDisplayState.wireframe}
        airMeshPointsVisible={airboxDisplayState.points}
        airMeshVectorsVisible={airboxDisplayState.vectorsVisible}
        airMeshWireframeScope={airboxDisplayState.wireframeScope}
        airMeshPointsScope={airboxDisplayState.pointsScope}
        airMeshVectorsScope={airboxDisplayState.vectorsScope}
        slice2DEnabled={_viewport.effectiveViewMode === "2D"}
        slice2DToolbar={slice2DToolbar}
        slice2DDiagnostics={null}
        previewPending={_viewport.previewBusy}
        onSetPreviewComponent={handleRibbonPreviewComponent}
        onSetPreviewEveryN={handleRibbonPreviewEveryN}
        onSetPreviewMaxPoints={handleRibbonPreviewMaxPoints}
        onSetPreviewColormap={handleRibbonPreviewColormap}
        onSetPreviewAutoScale={handleRibbonPreviewAutoScale}
        onPatchVisualizationState={(patch) => { void _viewport.patchDisplay(patch); }}
        onSetPrimitiveVisible={(visible) =>
          void _viewport.patchDisplay(visualizationPatchForFemLayers({
            ...ribbonFemLayers,
            showPrimitives: visible,
          }))
        }
        onSetMagneticTextureVisible={(visible) => {
          void _viewport.patchDisplay(visualizationPatchForFemLayers({
            ...ribbonFemLayers,
            showMagneticTexture: visible,
            showQuantity: visible ? false : ribbonFemLayers.showQuantity,
          }));
          if (visible) {
            _viewport.requestPreviewQuantity("m");
          }
        }}
        onSetMagneticTextureDensity={setMagneticTextureDensity}
        onSetQuantityShaderVisible={(visible) =>
          void _viewport.patchDisplay(visualizationPatchForFemLayers({
            ...ribbonFemLayers,
            showQuantity: visible,
            showMagneticTexture: visible ? false : ribbonFemLayers.showMagneticTexture,
          }))
        }
        antennaSources={_cmd.scriptBuilderCurrentModules.map((module) => ({
          name: module.name,
          kind: module.antenna_kind === "CPWAntenna" ? "CPW" : "Microstrip",
          currentA: module.drive.current_a,
        }))}
        selectedAntennaName={selectedAntennaName}
        onAddAntenna={handleAddAntenna}
        onSelectModelNode={handleSelectModelNode}
        meshTargetLabel={activeMeshIntent.targetLabel}
        onBuildMeshSelected={() => void handleBuildMeshSelected()}
        onBuildMeshAll={() => void handleBuildMeshAll()}
        onOpenMeshInspector={handleOpenMeshInspector}
        onOpenMeshStatistics={handleOpenMeshStatistics}
        onOpenMeshQuality={handleOpenMeshQuality}
        onOpenMeshSizeSettings={handleOpenMeshSize}
        onOpenMeshTransitionSettings={handleOpenMeshTransition}
        onOpenMeshMethodSettings={handleOpenMeshMethod}
        onOpenMeshOptimizationSettings={handleOpenMeshOptimization}
        onOpenMeshPipeline={handleOpenMeshPipeline}
        hasSharedAirboxDomain={hasSharedAirboxDomain}
        onStudyAddPrimitive={handleStudyAddPrimitive}
        onStudyAddMacro={handleStudyAddMacro}
        onStudyDuplicateSelected={handleStudyDuplicateSelected}
        onStudyToggleSelectedEnabled={handleStudyToggleSelectedEnabled}
        onAddResultAnalysis={handleAddResultAnalysis}
        onObjectAddInteraction={handleObjectAddInteraction}
        onAssignMagnetizationPreset={handleAssignMagnetizationPreset}
        onSetTransformScope={handleSetTransformScope}
        onSetMeshRenderMode={handleRibbonMeshRenderMode}
        onSetMeshOpacity={(opacity) =>
          void _viewport.patchDisplay(visualizationPatchForOpacity(opacity))
        }
        onSetSelectedObjectTextureVisible={handleSelectedObjectTextureVisible}
        onSetSelectedObjectOpacity={handleSelectedObjectOpacity}
        onSetSelectedObjectRenderMode={handleSelectedObjectRenderMode}
        onClearSelectedDisplayOverrides={handleClearSelectedDisplayOverrides}
        onSetMeshClipEnabled={(enabled) =>
          void _viewport.patchDisplay(visualizationPatchForClip({ enabled }))
        }
        onSetMeshClipAxis={(axis) =>
          void _viewport.patchDisplay(visualizationPatchForClip({ axis }))
        }
        onSetMeshClipPos={(positionPercent) =>
          void _viewport.patchDisplay(visualizationPatchForClip({ positionPercent }))
        }
        onSetMeshClipFlip={(flipped) =>
          void _viewport.patchDisplay(visualizationPatchForClip({ flipped }))
        }
        onSetMeshShowArrows={(visible) =>
          void _viewport.patchDisplay({
            layers: {
              vectors: {
                visible,
              },
            },
          })
        }
        onSetFemArrowStyle={handleRibbonFemArrowStyle}
        onSetAirboxDisplay={handleRibbonAirboxDisplay}
        onSetSlice2DToolbar={handleRibbonSlice2DToolbar}
        onRestoreWorkspacePanel={handleRestoreWorkspacePanel}
        onHideWorkspacePanel={handleHideWorkspacePanel}
        onDispatchVisualization={handleDispatchVisualization}
        onSetTextureTransformMode={handleSetTextureTransformMode}
        onBuilderAddPrimitive={handleBuilderAddPrimitive}
        onBuilderBuildGeometry={handleBuilderBuildGeometry}
        onBuilderBuildMesh={() => { void handleBuilderBuildMesh(); }}
        onBuilderBuildAll={handleBuilderBuildAll}
        onBuilderValidateGeometry={handleBuilderValidateGeometry}
        onBuilderSetViewportMode={handleBuilderSetViewportMode}
        onBuilderSetTransformTool={handleBuilderSetTransformTool}
        onBuilderToggleSnap={toggleBuilderSnap}
        onBuilderFocusSelected={handleBuilderFocusSelected}
        onBuilderFrameAll={handleBuilderFrameAll}
        onBuilderCenterInUniverse={handleBuilderCenterInUniverse}
      /> : null}
      {FRONTEND_DIAGNOSTIC_FLAGS.shell.showBackendErrorNotice && activeBackendError ? (
        <div className="border-b border-rose-500/20 bg-rose-950/10 px-3 py-3">
          <BackendErrorNotice
            error={activeBackendError}
            onDismiss={() => setDismissedBackendErrorAt(activeBackendError.timestampUnixMs)}
          />
        </div>
      ) : null}
      {FRONTEND_DIAGNOSTIC_FLAGS.shell.useDockingShell &&
      FRONTEND_DIAGNOSTIC_FLAGS.workspace.enableWorkspaceDockingShell ? (
        <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
          {FRONTEND_DIAGNOSTIC_FLAGS.workspace.enableDockingTooltipProviders ? (
            <TooltipProvider delayDuration={250}>
              <WorkspaceDockingShell />
            </TooltipProvider>
          ) : (
            <WorkspaceDockingShell />
          )}
        </div>
      ) : (
        <WorkspaceBodyLayout
          leftCollapsed={_viewport.sidebarCollapsed}
          leftPanel={<RunSidebar />}
          center={
            <>
              {FRONTEND_DIAGNOSTIC_FLAGS.shell.showViewportBar ? <ViewportBar /> : null}
              {FRONTEND_DIAGNOSTIC_FLAGS.shell.showPreviewNotices ? (
                <ControlRoomPreviewNotices
                  liveState={_transport.liveState}
                  previewGrid={_viewport.previewGrid}
                  previewIsInitialSampleStale={_viewport.previewIsInitialSampleStale}
                  previewIsStale={_viewport.previewIsStale}
                  previewMessage={_viewport.previewMessage}
                  spatialPreview={spatialPreview}
                />
              ) : null}
              <ViewportTabBar />
              <ViewportCanvasArea onViewportHealthChange={handleViewportHealthChange} />
            </>
          }
          rightOpen={rightInspectorOpen}
          rightPanel={<WorkspaceRightToolbox />}
          rightDefaultSize={rightInspectorDefaultSize}
          rightMinSize={rightInspectorMinSize}
          rightMaxSize={rightInspectorMaxSize}
        />
      )}

      {FRONTEND_DIAGNOSTIC_FLAGS.shell.showStatusBar ? (
        <ControlRoomStatusBar meshBuildGenerating={meshBuildRuntime.generating} />
      ) : null}

      {/* FE-005: Data-plane status badges (production-safe, compact) */}
      {FRONTEND_DIAGNOSTIC_FLAGS.shell.showStatusBar ? <DataPlaneStatusBadges /> : null}

      <MeshBuildModal
        open={meshBuildDialogOpen}
        generating={meshBuildRuntime.generating}
        intent={meshBuildIntent}
        stages={meshBuildStages}
        progressValue={meshBuildProgress}
        engineLog={_cmd.engineLog}
        meshWorkspace={_model.meshWorkspace}
        effectiveTargets={effectiveMeshTargets}
        errorMessage={meshBuildError ?? meshBuildRuntime.errorMessage}
        errorDetails={meshBuildBackendError}
        onBackground={handleBackgroundMeshBuild}
        onClose={handleCloseMeshBuildDialog}
      />
      {meshBuildNotice ? (
        <div className="pointer-events-none fixed right-5 top-20 z-[170] w-[min(420px,calc(100vw-2rem))]">
          <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-3 text-emerald-100 shadow-[0_14px_40px_rgba(0,0,0,0.35)] backdrop-blur-md">
            <div className="text-[0.68rem] font-semibold uppercase tracking-[0.15em] text-emerald-200/90">
              {meshBuildNotice.title}
            </div>
            <div className="mt-1 text-sm leading-relaxed text-emerald-50/95">
              {meshBuildNotice.message}
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Workspace overlays (settings, docs) ── */}
      {FRONTEND_DIAGNOSTIC_FLAGS.shell.showWorkspaceOverlays ? <SettingsDialog /> : null}
      {FRONTEND_DIAGNOSTIC_FLAGS.shell.showWorkspaceOverlays ? <PhysicsDocsDrawer /> : null}

      {startupState === "initializing" ? (
        <div className="absolute inset-0 z-[180]">
          <InitializingWorkspaceState error={_cmd.error} />
        </div>
      ) : null}
    </div>
  );
}

/* ── Public export ── */

export default function RunControlRoom({ initialWorkspaceMode }: { initialWorkspaceMode?: WorkspaceMode }) {
  if (!FRONTEND_DIAGNOSTIC_FLAGS.workspace.enableRunControlRoom) {
    return (
      <div className="flex min-h-[50vh] w-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
        RunControlRoom disabled by diagnostic flag:
        <code className="mx-1">workspace.enableRunControlRoom = false</code>.
      </div>
    );
  }
  return (
    <ControlRoomProvider>
      <ControlRoomShell initialWorkspaceMode={initialWorkspaceMode} />
    </ControlRoomProvider>
  );
}
