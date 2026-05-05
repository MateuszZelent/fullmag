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
import { recordFrontendDebugEvent } from "../../lib/workspace/navigation-debug";
import type { ScriptBuilderMagneticInteractionKind } from "../../lib/session/types";
import {
  MAGNETIC_PRESET_CATALOG,
  type MagneticPresetKind,
} from "../../lib/magnetizationPresetCatalog";
import {
  ensureObjectPhysicsStack,
  upsertObjectInteraction,
} from "../../lib/session/magneticPhysics";
import {
  assignMagneticPreset,
} from "../../lib/session/magnetizationAssetActions";
import {
  ControlRoomProvider,
} from "./control-room/ControlRoomContext";
import { useAutoResultsNavigation } from "./control-room/useAutoResultsNavigation";
import { useBuilderRibbonActions } from "./control-room/useBuilderRibbonActions";
import { useRibbonVisualizationActions } from "./control-room/useRibbonVisualizationActions";
import { useSelectedObjectRibbonDisplay } from "./control-room/useSelectedObjectRibbonDisplay";
import { useViewport3DStatus } from "./control-room/useViewport3DStatus";
import {
  useTransport,
  useViewport,
  useCommand,
  useModel,
} from "./control-room/context-hooks";
import {
  PANEL_SIZES,
  resolveAntennaNodeName,
  resolveSelectedObjectId,
} from "./control-room/shared";
import { parseAnalyzeTreeNode } from "./control-room/analyzeSelection";
import { parseResultNodeContext } from "@/features/analyze/model/resultNodeContext";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import BackendErrorNotice from "./control-room/BackendErrorNotice";
import MeshBuildModal from "./control-room/MeshBuildModal";
import { buildVisualizationPresetNodeId } from "./control-room/visualizationPresets";
import { WorkspaceRightToolbox } from "../workspace/modes/WorkspaceModeInspectors";
import { useAnalyzeStore } from "@/features/analyze";
import { useWorkspaceGraphBridge } from "@/features/workspace-graph";
import type { WorkspaceMode } from "./control-room/context-hooks";
import SettingsDialog from "../workspace/overlays/SettingsDialog";
import PhysicsDocsDrawer from "../workspace/overlays/PhysicsDocsDrawer";
import WorkspaceDockingShell from "../workspace/docking/WorkspaceDockingShell";
import { useActiveStageLayout, useWorkspaceStore } from "@/lib/workspace/workspace-store";
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
  buildResultWorkspaceEntryInput,
  launchDisplayName,
  makeRibbonAntenna,
  resolveStudyAnchorNodeId,
  type ResultAnalysisKind,
  syncStudyRuntimeState,
} from "./control-room/controlRoomShellHelpers";
import { useMeshBuildFlow } from "./control-room/useMeshBuildFlow";

const WORKSPACE_ANALYZE_HREF = "/workspace/analyze";

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
  const hasNoActiveWorkspace = _cmd.error?.includes("no active local live workspace") ?? false;

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
  const [dismissedBackendErrorAt, setDismissedBackendErrorAt] = useState<number | null>(null);
  const selectedAntennaName = useMemo(
    () =>
      resolveAntennaNodeName(
        _model.selectedSidebarNodeId,
        _cmd.scriptBuilderCurrentModules.map((module) => module.name),
      ),
    [_model.selectedSidebarNodeId, _cmd.scriptBuilderCurrentModules],
  );
  const authoringStudyDocument = useMemo<StudyPipelineDocument>(
    () => (_model.studyPipeline as StudyPipelineDocument | null) ?? migrateFlatStagesToStudyPipeline(_model.studyStages),
    [_model.studyPipeline, _model.studyStages],
  );
  useWorkspaceGraphBridge({
    enabled:
      FRONTEND_DIAGNOSTIC_FLAGS.workspace.enableGraphV2 &&
      FRONTEND_DIAGNOSTIC_FLAGS.workspace.enableWorkspaceGraphBridge,
    projectLabel: workspaceTitle,
    workspaceMode: currentStage,
    workspaceTabs: workspaceTabsByStage,
    activeWorkspaceTabByStage,
    selectedNodeId: _model.selectedSidebarNodeId,
    studyPipeline: authoringStudyDocument,
    resultsWorkspace: analyzeResultsWorkspace,
    quantities: _cmd.quantities,
    scalarRows: _transport.scalarRows,
    requestedPreviewQuantity: _viewport.requestedPreviewQuantity,
    requestedPreviewComponent: _viewport.requestedPreviewComponent,
    plane: _viewport.plane,
    sliceIndex: _viewport.sliceIndex,
    viewMode: _viewport.effectiveViewMode,
    renderMode: _model.meshRenderMode,
  });
  useKeyboardShortcuts();

  const maybePreviewAntennaField = useCallback(() => {
    if (quickPreviewTargets.some((target) => target.id === "H_ant" && target.available)) {
      requestPreviewQuantity("H_ant");
    }
  }, [quickPreviewTargets, requestPreviewQuantity]);

  const openAnalyzeCenterTab = useCallback(
    (
      selection?: Parameters<typeof _model.openAnalyze>[0],
      debug?: { nodeId?: string; resultWorkspaceId?: string; source?: string },
    ) => {
      setActiveCoreTab("Results");
      setActiveContextualTab(null);
      _model.openAnalyzeSurface({
        selection,
        resultWorkspaceId: debug?.resultWorkspaceId,
        source: debug?.source ?? "run-control-room",
      });
      if (pathname !== WORKSPACE_ANALYZE_HREF) {
        recordFrontendDebugEvent("run-control-room", "router_replace_analyze_tab", debug ?? {});
        router.replace(WORKSPACE_ANALYZE_HREF);
      }
    },
    [_model.openAnalyzeSurface, pathname, router, setActiveContextualTab, setActiveCoreTab],
  );

  const handleSelectModelNode = useCallback((nodeId: string) => {
    _model.setSelectedSidebarNodeId(nodeId);
    _model.setSelectedObjectId(resolveSelectedObjectId(nodeId, _model.modelBuilderGraph));
    const analyzeTarget = parseAnalyzeTreeNode(nodeId);
    if (analyzeTarget) {
      openAnalyzeCenterTab(analyzeTarget, { nodeId, source: "analyze_target" });
      return;
    }
    const resultContext = parseResultNodeContext(nodeId);
    if (nodeId.startsWith("res-analysis-")) {
      openAnalyzeCenterTab(undefined, {
        nodeId,
        resultWorkspaceId: nodeId.replace("res-analysis-", ""),
        source: "result_workspace",
      });
      return;
    }
    if (
      resultContext?.kind === "results-solution" ||
      resultContext?.kind === "results-dataset" ||
      resultContext?.kind === "results-dataset-solution" ||
      resultContext?.kind === "results-derived-value" ||
      resultContext?.kind === "results-plot-group" ||
      resultContext?.kind === "results-table" ||
      resultContext?.kind === "results-export-node" ||
      resultContext?.kind === "results-report"
    ) {
      openAnalyzeCenterTab(undefined, { nodeId, source: "results_node" });
      return;
    }
    if (_viewport.sidebarCollapsed) {
      _viewport.setSidebarCollapsed(false);
    }
    if (nodeId === "antennas" || nodeId.startsWith("ant-")) {
      maybePreviewAntennaField();
    }
  }, [
    _model.modelBuilderGraph,
    _model.setSelectedSidebarNodeId,
    _model.setSelectedObjectId,
    _viewport.sidebarCollapsed,
    _viewport.setSidebarCollapsed,
    maybePreviewAntennaField,
    openAnalyzeCenterTab,
  ]);

  const handleAddAntenna = useCallback((kind: "MicrostripAntenna" | "CPWAntenna") => {
    const nextModule = makeRibbonAntenna(kind, _cmd.scriptBuilderCurrentModules);
    _model.setScriptBuilderCurrentModules((prev) => [...prev, nextModule]);
    if (_viewport.sidebarCollapsed) {
      _viewport.setSidebarCollapsed(false);
    }
    _model.setSelectedSidebarNodeId(`ant-${nextModule.name}`);
    _model.setSelectedObjectId(null);
    maybePreviewAntennaField();
  }, [_cmd.scriptBuilderCurrentModules, _model.setScriptBuilderCurrentModules, _viewport.sidebarCollapsed, _viewport.setSidebarCollapsed, _model.setSelectedSidebarNodeId, _model.setSelectedObjectId, maybePreviewAntennaField]);

  const handleCreateVisualizationPreset = useCallback(() => {
    const ref = _model.createVisualizationPreset("project");
    const nodeId = buildVisualizationPresetNodeId(ref.source, ref.preset_id);
    handleSelectModelNode(nodeId);
    _model.applyVisualizationPreset(ref);
  }, [_model.createVisualizationPreset, _model.applyVisualizationPreset, handleSelectModelNode]);

  const handleObjectAddInteraction = useCallback(
    (objectId: string, kind: ScriptBuilderMagneticInteractionKind) => {
      if (!objectId) return;
      _model.setSceneDocument((prev) => {
        if (!prev) return prev;
        const target = prev.objects.find(
          (object) => object.id === objectId || object.name === objectId,
        );
        if (!target) return prev;
        const material = prev.materials.find((entry) => entry.id === target.material_ref);
        const currentStack = ensureObjectPhysicsStack(
          target.physics_stack,
          material?.properties.Dind ?? null,
        );
        const nextStack = upsertObjectInteraction(currentStack, kind, { enabled: true });
        const nextObjectName = target.name || target.id;
        return {
          ...prev,
          objects: prev.objects.map((object) =>
            object.id === target.id || object.name === nextObjectName
              ? { ...object, physics_stack: nextStack }
              : object,
          ),
          materials:
            kind === "interfacial_dmi"
              ? prev.materials.map((entry) =>
                  entry.id === target.material_ref
                    ? {
                        ...entry,
                        properties: {
                          ...entry.properties,
                          Dind:
                            entry.properties.Dind != null
                              ? entry.properties.Dind
                              : Number(nextStack.find((item) => item.kind === "interfacial_dmi")?.params?.dind ?? 1e-3),
                        },
                      }
                    : entry,
                )
              : prev.materials,
        };
      });
      if (_viewport.sidebarCollapsed) {
        _viewport.setSidebarCollapsed(false);
      }
      _model.setSelectedObjectId(objectId);
      _model.setSelectedSidebarNodeId(`physobj-${objectId}`);
    },
    [_model.setSceneDocument, _model.setSelectedObjectId, _model.setSelectedSidebarNodeId, _viewport.sidebarCollapsed, _viewport.setSidebarCollapsed],
  );

  const handleAssignMagnetizationPreset = useCallback(
    (objectId: string, kind: MagneticPresetKind) => {
      _viewport.handleViewModeChange("3D");
      _model.setSelectedObjectId(objectId);
      _model.setSelectedSidebarNodeId(`mag-${objectId}`);
      _model.setSceneDocument((prev) => {
        if (!prev) return prev;
        const target = prev.objects.find(
          (object) => object.id === objectId || object.name === objectId,
        );
        if (!target) return prev;
        const magnetizationRef = target.magnetization_ref;
        if (!magnetizationRef) return prev;
        const descriptor = MAGNETIC_PRESET_CATALOG.find((entry) => entry.kind === kind);
        if (!descriptor) return prev;
        return assignMagneticPreset(prev, magnetizationRef, descriptor, {
          objectId,
        });
      });
    },
    [_model.setSceneDocument, _model.setSelectedObjectId, _model.setSelectedSidebarNodeId, _viewport.handleViewModeChange],
  );

  const handleSetTransformScope = useCallback(
    (scope: "camera" | "object" | "texture") => {
      _viewport.handleViewModeChange("3D");
      const nextScope = scope === "camera" ? null : scope;
      _model.setActiveTransformScope(nextScope);
      _model.setSceneDocument((prev) =>
        prev
          ? {
              ...prev,
              editor: {
                ...prev.editor,
                active_transform_scope: nextScope,
              },
            }
          : prev,
      );
    },
    [_model.setActiveTransformScope, _model.setSceneDocument, _viewport.handleViewModeChange],
  );

  const handleSetTextureTransformMode = useCallback(
    (objectId: string, mode: "translate" | "rotate" | "scale") => {
      _viewport.handleViewModeChange("3D");
      _model.setSelectedObjectId(objectId);
      _model.setSelectedSidebarNodeId(`mag-${objectId}-transform`);
      _model.setActiveTransformScope("texture");
      _model.setSceneDocument((prev) => {
        if (!prev) return prev;
        const target = prev.objects.find(
          (object) => object.id === objectId || object.name === objectId,
        );
        if (!target) return prev;
        const magnetizationRef = target.magnetization_ref;
        if (!magnetizationRef) return prev;
        const asset = prev.magnetization_assets.find(
          (entry) => entry.id === magnetizationRef,
        );
        let next = prev;
        if (asset?.kind !== "preset_texture") {
          const fallback = MAGNETIC_PRESET_CATALOG.find((entry) => entry.kind === "uniform");
          if (fallback) {
            next = assignMagneticPreset(next, magnetizationRef, fallback, {
              objectId,
            });
          }
        }
        return {
          ...next,
          editor: {
            ...next.editor,
            active_transform_scope: "texture",
            gizmo_mode: mode,
          },
        };
      });
    },
    [_model.setActiveTransformScope, _model.setSceneDocument, _model.setSelectedObjectId, _model.setSelectedSidebarNodeId, _viewport.handleViewModeChange],
  );

  const commitStudyDocument = useCallback((next: StudyPipelineDocument, nextSelectedNodeId?: string | null) => {
    const compiled = materializeStudyPipeline(next);
    _model.setStudyPipeline(next);
    _model.setStudyStages(compiled.stages);
    syncStudyRuntimeState({ setRunUntilInput: _cmd.setRunUntilInput, setSolverSettings: _model.setSolverSettings }, compiled.stages);
    if (nextSelectedNodeId) {
      handleSelectModelNode(nextSelectedNodeId);
    }
  }, [_cmd.setRunUntilInput, _model.setSolverSettings, _model.setStudyPipeline, _model.setStudyStages, handleSelectModelNode]);

  const handleStudyAddPrimitive = useCallback((
    kind: StudyPrimitiveStageKind,
    placement: "append" | "before" | "after",
  ) => {
    const nextNode = createPrimitiveNode(kind);
    const anchorId = resolveStudyAnchorNodeId(authoringStudyDocument, _model.selectedSidebarNodeId);
    const nextDocument =
      !anchorId || placement === "append"
        ? appendNode(authoringStudyDocument, nextNode)
        : insertNodeNear(authoringStudyDocument, anchorId, placement, nextNode);
    commitStudyDocument(nextDocument, buildPipelineStudyStageNodeId(nextNode.id));
  }, [authoringStudyDocument, commitStudyDocument, _model.selectedSidebarNodeId]);

  const handleStudyAddMacro = useCallback((
    kind:
      | "hysteresis_loop"
      | "field_sweep_relax"
      | "field_sweep_relax_snapshot"
      | "relax_run"
      | "relax_eigenmodes"
      | "parameter_sweep"
      | "current_sweep_run"
      | "dc_bias_plus_rf_probe",
    placement: "append" | "before" | "after",
  ) => {
    const nextNode = createMacroNode(kind);
    const anchorId = resolveStudyAnchorNodeId(authoringStudyDocument, _model.selectedSidebarNodeId);
    const nextDocument =
      !anchorId || placement === "append"
        ? appendNode(authoringStudyDocument, nextNode)
        : insertNodeNear(authoringStudyDocument, anchorId, placement, nextNode);
    commitStudyDocument(nextDocument, buildPipelineStudyStageNodeId(nextNode.id));
  }, [authoringStudyDocument, commitStudyDocument, _model.selectedSidebarNodeId]);

  const handleStudyDuplicateSelected = useCallback(() => {
    const anchorId = resolveStudyAnchorNodeId(authoringStudyDocument, _model.selectedSidebarNodeId);
    if (!anchorId) return;
    commitStudyDocument(duplicateNode(authoringStudyDocument, anchorId));
  }, [authoringStudyDocument, commitStudyDocument, _model.selectedSidebarNodeId]);

  const handleStudyToggleSelectedEnabled = useCallback(() => {
    const anchorId = resolveStudyAnchorNodeId(authoringStudyDocument, _model.selectedSidebarNodeId);
    if (!anchorId) return;
    commitStudyDocument(toggleNodeEnabled(authoringStudyDocument, anchorId));
  }, [authoringStudyDocument, commitStudyDocument, _model.selectedSidebarNodeId]);

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
  const handleAddResultAnalysis = useCallback(
    (kind: ResultAnalysisKind) => {
      const quantityId = _viewport.requestedPreviewQuantity;
      const quantityLabel = _viewport.quantityDescriptor?.label ?? quantityId;
      const quantityBadge = _viewport.quantityDescriptor?.unit ?? null;
      const id = _model.addResultWorkspaceEntry(buildResultWorkspaceEntryInput(kind, {
        now: Date.now(),
        quantityId,
        quantityLabel,
        quantityBadge,
      }));
      openAnalyzeCenterTab(undefined, {
        resultWorkspaceId: id,
        source: "create_result_entry",
      });
    },
    [_model.addResultWorkspaceEntry, _viewport.requestedPreviewQuantity, _viewport.quantityDescriptor, openAnalyzeCenterTab],
  );

  useAutoResultsNavigation({
    artifacts: _cmd.artifacts,
    openAnalyzeCenterTab,
    run: _cmd.run,
    scalarRows: _transport.scalarRows,
    selectedSidebarNodeId: _model.selectedSidebarNodeId,
    session: _cmd.session,
    setSelectedSidebarNodeId: _model.setSelectedSidebarNodeId,
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

  /* ── Loading state ── */
  if (!_cmd.session) {
    if (hasNoActiveWorkspace) {
      return <NoActiveWorkspaceState onOpenLauncher={() => router.push("/")} />;
    }

    return <InitializingWorkspaceState error={_cmd.error} />;
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
    <div className="h-full flex flex-col bg-background font-sans text-foreground text-base overflow-hidden">
      <ControlRoomAppBar problemName={workspaceTitle} />
      {FRONTEND_DIAGNOSTIC_FLAGS.shell.showRibbonBar ? <ControlRoomRibbonBar
        viewport3DStatus={viewport3DStatus.status}
        viewport3DStatusReason={viewport3DStatus.reason}
        viewport3DStatusDetail={viewport3DStatus.detail}
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
        airMeshRenderMode={airMeshRenderMode}
        airMeshGeometryVisible={airboxDisplayState.geometryVisible}
        airMeshSurfaceVisible={airboxDisplayState.surface}
        airMeshWireframeVisible={airboxDisplayState.wireframe}
        airMeshPointsVisible={airboxDisplayState.points}
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
        onSetMagneticTextureDensity={_model.setFemTextureDownsampleCells}
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
