"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { Route } from "next";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import AppBar from "../shell/AppBar";
import RibbonBar from "../shell/RibbonBar";
import StatusBar from "../shell/StatusBar";
import RunSidebar from "./control-room/RunSidebar";
import { ViewportBar, ViewportCanvasArea } from "./control-room/ViewportPanels";
import FullmagLogo from "../brand/FullmagLogo";
import { recordFrontendDebugEvent } from "../../lib/workspace/navigation-debug";
import type {
  ScriptBuilderCurrentModuleEntry,
  ScriptBuilderMagneticInteractionKind,
} from "../../lib/session/types";
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
import {
  useTransport,
  useViewport,
  useCommand,
  useModel,
} from "./control-room/context-hooks";
import {
  PANEL_SIZES,
  fmtDuration,
  resolveAntennaNodeName,
  resolveSelectedObjectId,
  fmtSIOrDash,
  fmtStepValue,
  materializationProgressFromMessage,
  resolveStudyStageExecutionState,
} from "./control-room/shared";
import { parseAnalyzeTreeNode } from "./control-room/analyzeSelection";
import { parseResultNodeContext } from "@/features/analyze/model/resultNodeContext";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import BackendErrorNotice from "./control-room/BackendErrorNotice";
import MeshBuildModal from "./control-room/MeshBuildModal";
import {
  buildMeshBuildStages,
  deriveMeshBuildRuntimeState,
  deriveEffectiveMeshTargets,
  deriveMeshBuildProgressValue,
  meshBuildIntentForNode,
  meshWorkspaceNodeToDockTab,
} from "./control-room/meshWorkspace";
import { buildVisualizationPresetNodeId } from "./control-room/visualizationPresets";
import {
  BuildRightInspector,
  StudyRightInspector,
  AnalyzeRightInspector,
} from "../workspace/modes/WorkspaceModeInspectors";
import { useAnalyzeStore } from "@/features/analyze";
import { useWorkspaceGraphBridge } from "@/features/workspace-graph";
import type { WorkspaceMode } from "./control-room/context-hooks";
import SettingsDialog from "../workspace/overlays/SettingsDialog";
import PhysicsDocsDrawer from "../workspace/overlays/PhysicsDocsDrawer";
import WorkspaceDockingShell from "../workspace/docking/WorkspaceDockingShell";
import { useActiveStageLayout, useWorkspaceStore } from "@/lib/workspace/workspace-store";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { recordFrontendRender } from "@/lib/debug/frontendPerfDebug";
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
import {
  buildPipelineStudyStageNodeId,
  parseStudyNodeContext,
} from "@/lib/study-builder/node-context";
import type {
  StudyPipelineDocument,
  StudyPrimitiveStageKind,
} from "@/lib/study-builder/types";

function launchDisplayName(intent: ReturnType<typeof useWorkspaceStore.getState>["launchIntent"]): string | null {
  if (!intent) return null;
  if (intent.displayName) return intent.displayName;
  if (intent.entryPath) {
    const parts = intent.entryPath.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? intent.entryPath;
  }
  return intent.resumeProjectId;
}

function nextAntennaName(
  prefix: string,
  modules: readonly ScriptBuilderCurrentModuleEntry[],
): string {
  let index = modules.length + 1;
  while (modules.some((module) => module.name === `${prefix}_${index}`)) {
    index += 1;
  }
  return `${prefix}_${index}`;
}

function makeRibbonAntenna(
  kind: "MicrostripAntenna" | "CPWAntenna",
  modules: readonly ScriptBuilderCurrentModuleEntry[],
): ScriptBuilderCurrentModuleEntry {
  return {
    kind: "antenna_field_source",
    name: nextAntennaName(kind === "CPWAntenna" ? "cpw" : "microstrip", modules),
    solver: "mqs_2p5d_az",
    air_box_factor: 12,
    antenna_kind: kind,
    antenna_params:
      kind === "CPWAntenna"
        ? {
            signal_width: 1e-6,
            gap: 0.25e-6,
            ground_width: 1e-6,
            thickness: 100e-9,
            height_above_magnet: 200e-9,
            preview_length: 5e-6,
            center_x: 0,
            center_y: 0,
            current_distribution: "uniform",
          }
        : {
            width: 1e-6,
            thickness: 100e-9,
            height_above_magnet: 200e-9,
            preview_length: 5e-6,
            center_x: 0,
            center_y: 0,
            current_distribution: "uniform",
          },
    drive: {
      current_a: 0.01,
      frequency_hz: null,
      phase_rad: 0,
      waveform: null,
    },
  };
}

function syncStudyCompatibilityState(
  ctx: { setRunUntilInput: (v: string) => void; setSolverSettings: React.Dispatch<React.SetStateAction<any>> },
  stages: ReturnType<typeof materializeStudyPipeline>["stages"],
): void {
  const firstRun = stages.find((stage) => stage.kind === "run");
  const firstRelax = stages.find((stage) => stage.kind === "relax");
  if (firstRun?.until_seconds) {
    ctx.setRunUntilInput(firstRun.until_seconds);
  }
  if (firstRelax) {
    ctx.setSolverSettings((current: any) => ({
      ...current,
      integrator: firstRelax.integrator || current.integrator,
      fixedTimestep: firstRelax.fixed_timestep || current.fixedTimestep,
      relaxAlgorithm: firstRelax.relax_algorithm || current.relaxAlgorithm,
      torqueTolerance: firstRelax.torque_tolerance || current.torqueTolerance,
      energyTolerance: firstRelax.energy_tolerance || current.energyTolerance,
      maxRelaxSteps: firstRelax.max_steps || current.maxRelaxSteps,
    }));
  }
}

function resolveStudyAnchorNodeId(
  document: StudyPipelineDocument,
  selectedNodeId: string | null,
): string | null {
  const studyNode = parseStudyNodeContext(selectedNodeId);
  if (studyNode?.kind !== "study-stage") {
    return null;
  }
  if (studyNode.source === "pipeline") {
    return studyNode.stageKey;
  }
  const flatIndex = Number(studyNode.stageKey);
  return Number.isFinite(flatIndex) ? document.nodes[flatIndex]?.id ?? null : null;
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
  const ctx = { ..._transport, ..._viewport, ..._cmd, ..._model };
  const sidebarCollapsed = ctx.sidebarCollapsed;
  const setSidebarCollapsed = ctx.setSidebarCollapsed;
  const workspaceMode = ctx.workspaceMode;
  const setWorkspaceMode = ctx.setWorkspaceMode;
  const quickPreviewTargets = ctx.quickPreviewTargets;
  const requestPreviewQuantity = ctx.requestPreviewQuantity;
  const scriptPath = ctx.sessionFooter.scriptPath;
  const scriptSyncBusy = ctx.scriptSyncBusy;
  const syncScriptBuilder = ctx.syncScriptBuilder;
  const openFemMeshWorkspace = ctx.openFemMeshWorkspace;
  const router = useRouter();
  const pathname = usePathname();
  const activeStageLayout = useActiveStageLayout();
  const launchIntent = useWorkspaceStore((state) => state.launchIntent);
  const rightInspectorOpen = useWorkspaceStore((state) => state.rightInspectorOpen);
  const setRightInspectorOpen = useWorkspaceStore((state) => state.setRightInspectorOpen);
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

  const viewportPanelDefaultSize = compactVerticalLayout ? "90%" : PANEL_SIZES.viewportDefault;
  const rightInspectorDefaultSize = compactHorizontalLayout ? "18%" : PANEL_SIZES.rightInspectorDefault;
  const rightInspectorMinSize = compactHorizontalLayout ? "10%" : PANEL_SIZES.rightInspectorMin;
  const rightInspectorMaxSize = compactHorizontalLayout ? "36%" : PANEL_SIZES.rightInspectorMax;
  const workspaceTitle = launchDisplayName(launchIntent) ?? ctx.session?.problem_name ?? "Local Live Workspace";

  useEffect(() => {
    if (!initialWorkspaceMode) return;
    if (workspaceMode !== initialWorkspaceMode) {
      setWorkspaceMode(initialWorkspaceMode);
    }
  }, [initialWorkspaceMode, setWorkspaceMode, workspaceMode]);

  useEffect(() => {
    setRightInspectorOpen(Boolean(activeStageLayout.rightDock));
  }, [activeStageLayout.rightDock, setRightInspectorOpen]);

  const spatialPreview = ctx.preview?.kind === "spatial" ? ctx.preview : null;
  const [meshBuildDialogOpen, setMeshBuildDialogOpen] = useState(false);
  const [meshBuildIntent, setMeshBuildIntent] = useState<ReturnType<typeof meshBuildIntentForNode> | null>(null);
  const [meshBuildError, setMeshBuildError] = useState<string | null>(null);
  const [meshBuildOpenedAt, setMeshBuildOpenedAt] = useState<number | null>(null);
  const [dismissedBackendErrorAt, setDismissedBackendErrorAt] = useState<number | null>(null);
  const selectedAntennaName = useMemo(
    () =>
      resolveAntennaNodeName(
        ctx.selectedSidebarNodeId,
        ctx.scriptBuilderCurrentModules.map((module) => module.name),
      ),
    [ctx.selectedSidebarNodeId, ctx.scriptBuilderCurrentModules],
  );
  const authoringStudyDocument = useMemo<StudyPipelineDocument>(
    () => (ctx.studyPipeline as StudyPipelineDocument | null) ?? migrateFlatStagesToStudyPipeline(ctx.studyStages),
    [ctx.studyPipeline, ctx.studyStages],
  );
  useWorkspaceGraphBridge({
    projectLabel: workspaceTitle,
    workspaceMode: currentStage,
    workspaceTabs: workspaceTabsByStage,
    activeWorkspaceTabByStage,
    selectedNodeId: ctx.selectedSidebarNodeId,
    studyPipeline: authoringStudyDocument,
    resultsWorkspace: analyzeResultsWorkspace,
    quantities: ctx.quantities,
    scalarRows: ctx.scalarRows,
    requestedPreviewQuantity: ctx.requestedPreviewQuantity,
    requestedPreviewComponent: ctx.requestedPreviewComponent,
    plane: ctx.plane,
    sliceIndex: ctx.sliceIndex,
    viewMode: ctx.effectiveViewMode,
    renderMode: ctx.meshRenderMode,
  });
  useKeyboardShortcuts();

  const maybePreviewAntennaField = useCallback(() => {
    if (quickPreviewTargets.some((target) => target.id === "H_ant" && target.available)) {
      requestPreviewQuantity("H_ant");
    }
  }, [quickPreviewTargets, requestPreviewQuantity]);

  const handleSelectModelNode = useCallback((nodeId: string) => {
    ctx.setSelectedSidebarNodeId(nodeId);
    ctx.setSelectedObjectId(resolveSelectedObjectId(nodeId, ctx.modelBuilderGraph));
    const analyzeTarget = parseAnalyzeTreeNode(nodeId);
    if (analyzeTarget) {
      ctx.setWorkspaceMode("analyze");
      setActiveCoreTab("Results");
      setActiveContextualTab(null);
      ctx.openAnalyze(analyzeTarget);
      if (pathname !== "/analyze") {
        recordFrontendDebugEvent("run-control-room", "router_push_analyze_from_tree", {
          nodeId,
          source: "analyze_target",
        });
        router.push("/analyze");
      }
      return;
    }
    const resultContext = parseResultNodeContext(nodeId);
    if (nodeId.startsWith("res-analysis-")) {
      ctx.setWorkspaceMode("analyze");
      setActiveCoreTab("Results");
      setActiveContextualTab(null);
      ctx.openResultWorkspaceEntry(nodeId.replace("res-analysis-", ""));
      if (pathname !== "/analyze") {
        recordFrontendDebugEvent("run-control-room", "router_push_analyze_from_tree", {
          nodeId,
          source: "result_workspace",
        });
        router.push("/analyze");
      }
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
      ctx.setWorkspaceMode("analyze");
      setActiveCoreTab("Results");
      setActiveContextualTab(null);
      if (pathname !== "/analyze") {
        recordFrontendDebugEvent("run-control-room", "router_push_analyze_from_tree", {
          nodeId,
          source: "results_node",
        });
        router.push("/analyze");
      }
      return;
    }
    if (ctx.sidebarCollapsed) {
      ctx.setSidebarCollapsed(false);
    }
    if (nodeId === "antennas" || nodeId.startsWith("ant-")) {
      maybePreviewAntennaField();
    }
  }, [
    ctx,
    maybePreviewAntennaField,
    pathname,
    router,
    setActiveContextualTab,
    setActiveCoreTab,
  ]);

  const handleAddAntenna = useCallback((kind: "MicrostripAntenna" | "CPWAntenna") => {
    const nextModule = makeRibbonAntenna(kind, ctx.scriptBuilderCurrentModules);
    ctx.setScriptBuilderCurrentModules((prev) => [...prev, nextModule]);
    if (ctx.sidebarCollapsed) {
      ctx.setSidebarCollapsed(false);
    }
    ctx.setSelectedSidebarNodeId(`ant-${nextModule.name}`);
    ctx.setSelectedObjectId(null);
    maybePreviewAntennaField();
  }, [ctx, maybePreviewAntennaField]);

  const handleCreateVisualizationPreset = useCallback(() => {
    const ref = ctx.createVisualizationPreset("project");
    const nodeId = buildVisualizationPresetNodeId(ref.source, ref.preset_id);
    handleSelectModelNode(nodeId);
    ctx.applyVisualizationPreset(ref);
  }, [ctx, handleSelectModelNode]);

  const handleObjectAddInteraction = useCallback(
    (objectId: string, kind: ScriptBuilderMagneticInteractionKind) => {
      if (!objectId) return;
      ctx.setSceneDocument((prev) => {
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
      if (ctx.sidebarCollapsed) {
        ctx.setSidebarCollapsed(false);
      }
      ctx.setSelectedObjectId(objectId);
      ctx.setSelectedSidebarNodeId(`physobj-${objectId}`);
    },
    [ctx],
  );

  const handleAssignMagnetizationPreset = useCallback(
    (objectId: string, kind: MagneticPresetKind) => {
      ctx.setViewMode("3D");
      ctx.setSelectedObjectId(objectId);
      ctx.setSelectedSidebarNodeId(`mag-${objectId}`);
      ctx.setActiveTransformScope("texture");
      ctx.setSceneDocument((prev) => {
        if (!prev) return prev;
        const target = prev.objects.find(
          (object) => object.id === objectId || object.name === objectId,
        );
        if (!target) return prev;
        const magnetizationRef = target.magnetization_ref;
        if (!magnetizationRef) return prev;
        const descriptor = MAGNETIC_PRESET_CATALOG.find((entry) => entry.kind === kind);
        if (!descriptor) return prev;
        const next = assignMagneticPreset(prev, magnetizationRef, descriptor, {
          objectId,
        });
        return {
          ...next,
          editor: {
            ...next.editor,
            active_transform_scope: "texture",
            gizmo_mode: "translate",
          },
        };
      });
    },
    [ctx],
  );

  const handleSetTextureTransformMode = useCallback(
    (objectId: string, mode: "translate" | "rotate" | "scale") => {
      ctx.setViewMode("3D");
      ctx.setSelectedObjectId(objectId);
      ctx.setSelectedSidebarNodeId(`mag-${objectId}-transform`);
      ctx.setActiveTransformScope("texture");
      ctx.setSceneDocument((prev) => {
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
    [ctx],
  );

  const commitStudyDocument = useCallback((next: StudyPipelineDocument, nextSelectedNodeId?: string | null) => {
    const compiled = materializeStudyPipeline(next);
    ctx.setStudyPipeline(next);
    ctx.setStudyStages(compiled.stages);
    syncStudyCompatibilityState(ctx, compiled.stages);
    if (nextSelectedNodeId) {
      handleSelectModelNode(nextSelectedNodeId);
    }
  }, [ctx, handleSelectModelNode]);

  const handleStudyAddPrimitive = useCallback((
    kind: StudyPrimitiveStageKind,
    placement: "append" | "before" | "after",
  ) => {
    const nextNode = createPrimitiveNode(kind);
    const anchorId = resolveStudyAnchorNodeId(authoringStudyDocument, ctx.selectedSidebarNodeId);
    const nextDocument =
      !anchorId || placement === "append"
        ? appendNode(authoringStudyDocument, nextNode)
        : insertNodeNear(authoringStudyDocument, anchorId, placement, nextNode);
    commitStudyDocument(nextDocument, buildPipelineStudyStageNodeId(nextNode.id));
  }, [authoringStudyDocument, commitStudyDocument, ctx.selectedSidebarNodeId]);

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
    const anchorId = resolveStudyAnchorNodeId(authoringStudyDocument, ctx.selectedSidebarNodeId);
    const nextDocument =
      !anchorId || placement === "append"
        ? appendNode(authoringStudyDocument, nextNode)
        : insertNodeNear(authoringStudyDocument, anchorId, placement, nextNode);
    commitStudyDocument(nextDocument, buildPipelineStudyStageNodeId(nextNode.id));
  }, [authoringStudyDocument, commitStudyDocument, ctx.selectedSidebarNodeId]);

  const handleStudyDuplicateSelected = useCallback(() => {
    const anchorId = resolveStudyAnchorNodeId(authoringStudyDocument, ctx.selectedSidebarNodeId);
    if (!anchorId) return;
    commitStudyDocument(duplicateNode(authoringStudyDocument, anchorId));
  }, [authoringStudyDocument, commitStudyDocument, ctx.selectedSidebarNodeId]);

  const handleStudyToggleSelectedEnabled = useCallback(() => {
    const anchorId = resolveStudyAnchorNodeId(authoringStudyDocument, ctx.selectedSidebarNodeId);
    if (!anchorId) return;
    commitStudyDocument(toggleNodeEnabled(authoringStudyDocument, anchorId));
  }, [authoringStudyDocument, commitStudyDocument, ctx.selectedSidebarNodeId]);

  const hasSharedAirboxDomain =
    ctx.effectiveFemMesh?.domain_mesh_mode === "shared_domain_mesh_with_air";
  const activeMeshIntent = useMemo(
    () =>
      meshBuildIntentForNode({
        mode: "selected",
        nodeId: ctx.selectedSidebarNodeId,
        sceneDocument: ctx.sceneDocument,
        modelBuilderGraph: ctx.modelBuilderGraph,
        hasSharedAirboxDomain,
      }),
    [ctx.modelBuilderGraph, ctx.sceneDocument, ctx.selectedSidebarNodeId, hasSharedAirboxDomain],
  );
  const effectiveMeshTargets = useMemo(
    () =>
      deriveEffectiveMeshTargets({
        sceneDocument: ctx.sceneDocument,
        meshOptions: ctx.meshOptions,
      }),
    [ctx.meshOptions, ctx.sceneDocument],
  );
  const meshBuildStages = useMemo(
    () =>
      buildMeshBuildStages({
        meshWorkspace: ctx.meshWorkspace,
        workspaceStatus: ctx.workspaceStatus,
        meshGenerating: ctx.meshGenerating,
        scriptSyncBusy: ctx.scriptSyncBusy,
        latestActivityLabel: ctx.activity.label ?? null,
        latestActivityDetail: ctx.activity.detail ?? null,
        commandMessage: ctx.commandMessage,
        engineLog: ctx.engineLog,
      }),
    [
      ctx.activity.detail,
      ctx.activity.label,
      ctx.commandMessage,
      ctx.engineLog,
      ctx.meshWorkspace,
      ctx.meshGenerating,
      ctx.scriptSyncBusy,
      ctx.workspaceStatus,
    ],
  );
  const meshBuildRuntime = useMemo(
    () =>
      deriveMeshBuildRuntimeState({
        meshWorkspace: ctx.meshWorkspace,
        commandStatus: ctx.commandStatus,
        meshGenerating: ctx.meshGenerating,
        scriptSyncBusy: ctx.scriptSyncBusy,
      }),
    [ctx.commandStatus, ctx.meshGenerating, ctx.meshWorkspace, ctx.scriptSyncBusy],
  );
  const meshBuildProgress = useMemo(
    () =>
      deriveMeshBuildProgressValue(
        meshBuildStages,
        ctx.activity.progressMode === "determinate" ? ctx.activity.progressValue : null,
      ),
    [ctx.activity.progressMode, ctx.activity.progressValue, meshBuildStages],
  );
  const activeBackendError = useMemo(
    () =>
      ctx.latestBackendError &&
      ctx.latestBackendError.timestampUnixMs !== dismissedBackendErrorAt
        ? ctx.latestBackendError
        : null,
    [ctx.latestBackendError, dismissedBackendErrorAt],
  );
  const meshBuildBackendError = useMemo(
    () =>
      ctx.latestBackendError &&
      meshBuildOpenedAt != null &&
      ctx.latestBackendError.timestampUnixMs >= meshBuildOpenedAt
        ? ctx.latestBackendError
        : null,
    [ctx.latestBackendError, meshBuildOpenedAt],
  );
  const footerPipeline = useMemo(() => {
    const meshPhases = ctx.meshWorkspace?.mesh_pipeline_status ?? [];
    const doneMeshPhases = meshPhases.filter((phase) => phase.status === "done").length;
    const activeMeshPhase = meshPhases.find((phase) => phase.status === "active");
    if (ctx.workspaceStatus === "bootstrapping") {
      return {
        label: "Bootstrap pipeline",
        detail: ctx.activity.detail,
        mode: "indeterminate" as const,
        value: undefined,
      };
    }
    if (ctx.workspaceStatus === "materializing_script") {
      const progress = materializationProgressFromMessage(ctx.activity.detail ?? null);
      return {
        label: activeMeshPhase ? `Mesh pipeline · ${activeMeshPhase.label}` : "Materialization pipeline",
        detail: activeMeshPhase?.detail ?? ctx.activity.detail,
        mode: "determinate" as const,
        value: progress,
      };
    }
    if (meshPhases.length > 0 && meshBuildRuntime.generating) {
      const activeIndex = meshPhases.findIndex((phase) => phase.status === "active");
      const completed = doneMeshPhases + (activeIndex >= 0 ? 0.5 : 0);
      return {
        label: activeMeshPhase ? `Mesh pipeline · ${activeMeshPhase.label}` : "Mesh pipeline",
        detail: activeMeshPhase?.detail ?? ctx.activity.detail,
        mode: "determinate" as const,
        value: Math.min(100, (completed / meshPhases.length) * 100),
      };
    }
    return {
      label: "Workspace pipeline",
      detail: ctx.activity.detail,
      mode: "determinate" as const,
      value: ctx.workspaceStatus === "running" || ctx.workspaceStatus === "completed" || ctx.workspaceStatus === "awaiting_command" ? 100 : 0,
    };
  }, [
    ctx.activity.detail,
    ctx.meshWorkspace?.mesh_pipeline_status,
    ctx.workspaceStatus,
    meshBuildRuntime.generating,
  ]);
  const footerStage = useMemo(() => {
    const stages = ctx.studyStages ?? [];
    const resolved = resolveStudyStageExecutionState({
      stageExecution: ctx.stageExecution,
      totalStages: stages.length,
      workspaceStatus: ctx.workspaceStatus,
      activityLabel: ctx.activity.label,
    });
    const declaredTotal = resolved.declaredTotal;
    if (declaredTotal <= 0) {
      return {
        label: "Study stages",
        detail: "No scripted stages declared",
        mode: "idle" as const,
        value: undefined,
      };
    }
    const completedStages = resolved.completedStageIndexes.length;
    const activeStageNumber =
      resolved.activeStageIndex != null ? resolved.activeStageIndex + 1 : completedStages;
    const inFlightWeight =
      resolved.activeStageIndex != null && ctx.workspaceStatus === "running"
        ? 0.5
        : ctx.workspaceStatus === "completed" || ctx.workspaceStatus === "awaiting_command"
          ? 0
          : 0;
    const progress = Math.min(100, ((completedStages + inFlightWeight) / declaredTotal) * 100);
    const activeStageKind =
      resolved.activeStageKind ??
      (resolved.activeStageIndex != null
        ? stages[resolved.activeStageIndex]?.kind ?? null
        : null);
    return {
      label: `Study stages ${Math.max(activeStageNumber, completedStages)}/${declaredTotal}`,
      detail:
        resolved.activeStageIndex != null
          ? `Running ${activeStageKind ?? "stage"}`
          : activeStageKind ?? stages[Math.max(0, completedStages - 1)]?.kind ?? "Waiting for first scripted stage",
      mode: "determinate" as const,
      value: ctx.workspaceStatus === "completed" || ctx.workspaceStatus === "awaiting_command" ? 100 : progress,
    };
  }, [ctx.activity.label, ctx.stageExecution, ctx.studyStages, ctx.workspaceStatus]);

  const ensureMeshBuildModal = useCallback((intent: ReturnType<typeof meshBuildIntentForNode>) => {
    setMeshBuildError(null);
    setMeshBuildIntent(intent);
    setMeshBuildOpenedAt(Date.now());
    setMeshBuildDialogOpen(true);
  }, []);

  const syncIfPossible = useCallback(async () => {
    if (!scriptPath || scriptSyncBusy) {
      return;
    }
    await syncScriptBuilder();
  }, [scriptPath, scriptSyncBusy, syncScriptBuilder]);

  const openMeshNode = useCallback((nodeId: string) => {
    handleSelectModelNode(nodeId);
    const dockTab = meshWorkspaceNodeToDockTab(nodeId);
    if (dockTab) {
      openFemMeshWorkspace(dockTab);
    }
  }, [handleSelectModelNode, openFemMeshWorkspace]);

  const handleBuildMeshSelected = useCallback(async () => {
    const intent = meshBuildIntentForNode({
      mode: "selected",
      nodeId: ctx.selectedSidebarNodeId,
      sceneDocument: ctx.sceneDocument,
      modelBuilderGraph: ctx.modelBuilderGraph,
      hasSharedAirboxDomain,
    });
    ensureMeshBuildModal(intent);
    try {
      switch (intent.buildIntent.target.kind) {
        case "object_mesh":
          await ctx.handleObjectMeshOverrideRebuild(intent.buildIntent.target.object_id);
          return;
        case "airbox":
          await syncIfPossible();
          await ctx.handleAirboxMeshGenerate();
          return;
        case "study_domain":
          await syncIfPossible();
          await ctx.handleStudyDomainMeshGenerate("manual_ui_rebuild_selected");
          return;
      }
    } catch (error) {
      setMeshBuildError(error instanceof Error ? error.message : "Mesh build failed");
    }
  }, [ctx, ensureMeshBuildModal, hasSharedAirboxDomain, syncIfPossible]);

  const handleBuildMeshAll = useCallback(async () => {
    const intent = meshBuildIntentForNode({
      mode: "all",
      nodeId: ctx.selectedSidebarNodeId,
      sceneDocument: ctx.sceneDocument,
      modelBuilderGraph: ctx.modelBuilderGraph,
      hasSharedAirboxDomain,
    });
    ensureMeshBuildModal(intent);
    try {
      await syncIfPossible();
      await ctx.handleStudyDomainMeshGenerate("manual_ui_rebuild_all");
    } catch (error) {
      setMeshBuildError(error instanceof Error ? error.message : "Mesh build failed");
    }
  }, [ctx, ensureMeshBuildModal, hasSharedAirboxDomain, syncIfPossible]);

  const handleOpenMeshInspector = useCallback(() => {
    openMeshNode(hasSharedAirboxDomain ? "mesh-view" : "universe-mesh-view");
    ctx.handleViewModeChange("Mesh");
  }, [ctx, hasSharedAirboxDomain, openMeshNode]);

  const handleOpenMeshQuality = useCallback(() => {
    openMeshNode(hasSharedAirboxDomain ? "mesh-quality" : "universe-mesh-quality");
    ctx.handleViewModeChange("Mesh");
  }, [ctx, hasSharedAirboxDomain, openMeshNode]);

  const handleOpenMeshSize = useCallback(() => {
    if (ctx.selectedSidebarNodeId?.startsWith("geo-") && ctx.selectedSidebarNodeId.endsWith("-mesh")) {
      handleSelectModelNode(ctx.selectedSidebarNodeId);
      ctx.openFemMeshWorkspace("mesher");
      ctx.handleViewModeChange("Mesh");
      return;
    }
    openMeshNode(hasSharedAirboxDomain ? "universe-airbox-mesh" : "universe-mesh-size");
    ctx.handleViewModeChange("Mesh");
  }, [ctx, handleSelectModelNode, hasSharedAirboxDomain, openMeshNode]);

  const handleOpenMeshMethod = useCallback(() => {
    openMeshNode(hasSharedAirboxDomain ? "mesh-pipeline" : "universe-mesh-size");
    ctx.openFemMeshWorkspace("mesher");
    ctx.handleViewModeChange("Mesh");
  }, [ctx, hasSharedAirboxDomain, openMeshNode]);

  const handleOpenMeshPipeline = useCallback(() => {
    openMeshNode(hasSharedAirboxDomain ? "mesh-pipeline" : "universe-mesh-pipeline");
    ctx.handleViewModeChange("Mesh");
  }, [ctx, hasSharedAirboxDomain, openMeshNode]);
  const handleAddResultAnalysis = useCallback(
    (
      kind:
        | "spectrum"
        | "dispersion"
        | "modes"
        | "time-traces"
        | "vortex-frequency"
        | "vortex-trajectory"
        | "vortex-orbit"
        | "quantity"
        | "table",
    ) => {
      const now = Date.now();
      const quantityId = ctx.requestedPreviewQuantity;
      const quantityLabel = ctx.quantityDescriptor?.label ?? quantityId;
      const quantityBadge = ctx.quantityDescriptor?.unit ?? null;
      const id =
        kind === "spectrum"
          ? ctx.addResultWorkspaceEntry({
              key: `user:spectrum:${now}`,
              kind: "spectrum",
              label: "Eigen Spectrum",
              badge: "manual",
              openAfterCreate: true,
            })
          : kind === "dispersion"
            ? ctx.addResultWorkspaceEntry({
                key: `user:dispersion:${now}`,
                kind: "dispersion",
                label: "Eigen Dispersion",
                badge: "manual",
                openAfterCreate: true,
              })
            : kind === "modes"
              ? ctx.addResultWorkspaceEntry({
                  key: `user:modes:${now}`,
                  kind: "modes",
                  label: "Mode Inspector",
                  badge: "manual",
                  openAfterCreate: true,
                })
              : kind === "time-traces"
                ? ctx.addResultWorkspaceEntry({
                    key: `user:vortex:time-traces:${now}`,
                    kind: "time-traces",
                    label: "Vortex Time Traces",
                    badge: "manual",
                    openAfterCreate: true,
                  })
                : kind === "vortex-frequency"
                  ? ctx.addResultWorkspaceEntry({
                      key: `user:vortex:frequency:${now}`,
                      kind: "vortex-frequency",
                      label: "Vortex FFT / PSD",
                      badge: "manual",
                      openAfterCreate: true,
                    })
                  : kind === "vortex-trajectory"
                    ? ctx.addResultWorkspaceEntry({
                        key: `user:vortex:trajectory:${now}`,
                        kind: "vortex-trajectory",
                        label: "Vortex Trajectory",
                        badge: "manual",
                        openAfterCreate: true,
                      })
                    : kind === "vortex-orbit"
                      ? ctx.addResultWorkspaceEntry({
                          key: `user:vortex:orbit:${now}`,
                          kind: "vortex-orbit",
                          label: "Vortex Orbit Amplitude",
                          badge: "manual",
                          openAfterCreate: true,
                        })
            : kind === "table"
              ? ctx.addResultWorkspaceEntry({
                  key: `user:table:${now}`,
                  kind: "table",
                  label: "Results Table",
                  badge: quantityLabel,
                  openAfterCreate: true,
                })
              : ctx.addResultWorkspaceEntry({
                  key: `user:quantity:${quantityId}:${now}`,
                  kind: "quantity",
                  label: quantityLabel,
                  quantityId,
                  badge: quantityBadge,
                  openAfterCreate: true,
                });
      ctx.openResultWorkspaceEntry(id);
      ctx.setSelectedSidebarNodeId(`res-analysis-${id}`);
      ctx.setWorkspaceMode("analyze");
      setActiveCoreTab("Results");
      setActiveContextualTab(null);
      if (pathname !== "/analyze") {
        router.push("/analyze");
      }
    },
    [ctx, pathname, router, setActiveContextualTab, setActiveCoreTab],
  );

  const handleBackgroundMeshBuild = useCallback(() => {
    setMeshBuildDialogOpen(false);
  }, []);

  const handleCloseMeshBuildDialog = useCallback(() => {
    setMeshBuildDialogOpen(false);
    if (!meshBuildRuntime.generating) {
      setMeshBuildError(null);
      setMeshBuildOpenedAt(null);
    }
  }, [meshBuildRuntime.generating]);

  const handleStageChange = useCallback((stage: WorkspaceMode) => {
    ctx.setWorkspaceMode(stage);
    setActiveContextualTab(null);
    if (stage === "build") setActiveCoreTab("Geometry");
    else if (stage === "study") setActiveCoreTab("Study");
    else setActiveCoreTab("Results");
    const targetPath = `/${stage}`;
    if (pathname !== targetPath) {
      recordFrontendDebugEvent("run-control-room", "router_push_stage_change", {
        stage,
        targetPath,
      });
      router.push(targetPath as Route);
    }
  }, [ctx, pathname, router, setActiveContextualTab, setActiveCoreTab]);

  const hasEigenArtifacts = useMemo(
    () =>
      ctx.artifacts.some(
        (artifact) =>
          artifact.path === "eigen/spectrum.json" ||
          artifact.path === "eigen/metadata/eigen_summary.json" ||
          artifact.path.startsWith("eigen/modes/"),
      ),
    [ctx.artifacts],
  );
  const hasResultsAvailable = useMemo(() => {
    const hasScalarRows = ctx.scalarRows.length > 0;
    const hasRuntimeSteps = (ctx.run?.total_steps ?? 0) > 0;
    return hasScalarRows || hasRuntimeSteps || hasEigenArtifacts;
  }, [ctx.run?.total_steps, ctx.scalarRows.length, hasEigenArtifacts]);
  const autoResultsEntryKeyRef = useRef<string | null>(null);
  const currentResultsEntryKey = `${ctx.session?.session_id ?? "none"}:${ctx.run?.run_id ?? ctx.session?.run_id ?? "none"}`;

  useEffect(() => {
    const solveFinished =
      ctx.workspaceStatus === "awaiting_command" || ctx.workspaceStatus === "completed";
    if (!solveFinished || !hasResultsAvailable) {
      return;
    }
    if (autoResultsEntryKeyRef.current === currentResultsEntryKey) {
      return;
    }
    autoResultsEntryKeyRef.current = currentResultsEntryKey;
    ctx.setWorkspaceMode("analyze");
    setActiveCoreTab("Results");
    setActiveContextualTab(null);
    if (!ctx.selectedSidebarNodeId || !ctx.selectedSidebarNodeId.startsWith("res-")) {
      ctx.setSelectedSidebarNodeId(hasEigenArtifacts ? "res-eigenmodes" : "results");
    }
    if (hasEigenArtifacts) {
      ctx.openAnalyze({ tab: "spectrum", selectedModeIndex: null });
    }
    if (pathname !== "/analyze") {
      recordFrontendDebugEvent("run-control-room", "router_push_auto_results", {
        hasEigenArtifacts,
        currentResultsEntryKey,
      });
      router.push("/analyze");
    }
  }, [
    ctx,
    currentResultsEntryKey,
    hasEigenArtifacts,
    hasResultsAvailable,
    pathname,
    router,
    setActiveContextualTab,
    setActiveCoreTab,
  ]);

  /* ── Loading state ── */
  if (!ctx.session) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-sm text-muted-foreground h-full bg-background relative overflow-hidden">
        {/* Subtle background glow */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[40vw] h-[40vw] max-w-[500px] max-h-[500px] bg-primary/5 blur-[100px] rounded-full pointer-events-none" />
        
        <div className="flex flex-col items-center gap-8 relative z-10 w-full max-w-sm">
          <div className="relative flex items-center justify-center w-28 h-20">
            <div className="absolute inset-0 rounded-2xl border border-primary/20 bg-card/40 backdrop-blur-xl shadow-2xl" />
            <FullmagLogo size={96} animate className="relative z-10 drop-shadow-[0_0_20px_rgba(137,180,250,0.4)]" />
          </div>
          
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="flex items-center gap-3">
              <span className="w-5 h-5 rounded-full border-[3px] border-primary/20 border-t-primary animate-spin" />
              <span className="font-bold tracking-[0.2em] text-primary/90 uppercase text-xs">
                {ctx.error ? "Connection Error" : "Initializing Workspace"}
              </span>
            </span>
            <span className="text-muted-foreground/70 text-xs font-medium">
              {ctx.error ? ctx.error : "Connecting to local Fullmag session..."}
            </span>
          </div>
        </div>
      </div>
    );
  }

  const previewNotices = (
    <>
      {(spatialPreview?.auto_downscaled || ctx.liveState?.preview_auto_downscaled) && (
        <div
          className="px-2.5 py-1.5 border-b border-amber-500/30 bg-amber-500/10 text-amber-500 text-xs leading-snug"
          title={
            spatialPreview?.auto_downscale_message ??
            ctx.liveState?.preview_auto_downscale_message ??
            undefined
          }
        >
          {spatialPreview?.auto_downscale_message ??
            ctx.liveState?.preview_auto_downscale_message ??
            `Preview auto-fit to ${ctx.previewGrid[0]}×${ctx.previewGrid[1]}×${ctx.previewGrid[2]}`}
        </div>
      )}
      {(ctx.previewMessage || ctx.previewIsStale || ctx.previewIsBootstrapStale) && (
        <div className="px-2.5 py-1.5 border-b border-border/40 bg-card/40 text-muted-foreground text-xs leading-snug">
          {ctx.previewMessage ??
            (ctx.previewIsBootstrapStale
              ? "Showing bootstrap preview until first live preview sample arrives"
              : "Preview update pending")}
        </div>
      )}
    </>
  );

  return (
    <div className="h-full flex flex-col bg-background font-sans text-foreground text-base overflow-hidden">
      <AppBar
        problemName={workspaceTitle}
        backend={ctx.session?.requested_backend ?? ""}
        runtimeEngine={ctx.runtimeEngineLabel ?? undefined}
        runtimeGpuLabel={ctx.runtimeEngineGpuLabel ?? undefined}
        status={ctx.workspaceStatus}
        connection={ctx.connection}
        commandBusy={ctx.commandBusy}
        commandMessage={ctx.commandMessage}
        canSyncScriptBuilder={Boolean(ctx.sessionFooter.scriptPath)}
        scriptSyncBusy={ctx.scriptSyncBusy}
        onSyncScriptBuilder={() => void ctx.syncScriptBuilder()}
        workspaceMode={ctx.workspaceMode}
        resultsAvailable={hasResultsAvailable}
        onPerspectiveChange={handleStageChange}
      />
      {FRONTEND_DIAGNOSTIC_FLAGS.shell.showRibbonBar ? <RibbonBar
        workspaceMode={ctx.workspaceMode}
        viewMode={ctx.effectiveViewMode}
        isFemBackend={ctx.isFemBackend}
        solverRunning={ctx.workspaceStatus === "running"}
        sidebarVisible={!ctx.sidebarCollapsed}
        selectedNodeId={ctx.selectedSidebarNodeId}
        canRun={ctx.canRunCommand}
        canRelax={ctx.canRelaxCommand}
        canPause={ctx.canPauseCommand}
        canStop={ctx.canStopCommand}
        runAction={ctx.primaryRunAction}
        runLabel={ctx.primaryRunLabel}
        onViewChange={ctx.handleViewModeChange}
        onSidebarToggle={() => ctx.setSidebarCollapsed((v) => !v)}
        onCreateVisualizationPreset={handleCreateVisualizationPreset}
        onSimAction={ctx.handleSimulationAction}
        quickPreviewTargets={ctx.quickPreviewTargets}
        selectedQuantity={ctx.requestedPreviewQuantity}
        previewPending={ctx.previewBusy}
        onQuickPreviewSelect={ctx.requestPreviewQuantity}
        onCapture={ctx.handleCapture}
        onExport={ctx.handleExport}
        onStateExport={() => void ctx.handleStateExport("json")}
        antennaSources={ctx.scriptBuilderCurrentModules.map((module) => ({
          name: module.name,
          kind: module.antenna_kind === "CPWAntenna" ? "CPW" : "Microstrip",
          currentA: module.drive.current_a,
        }))}
        selectedAntennaName={selectedAntennaName}
        onAddAntenna={handleAddAntenna}
        onSelectModelNode={handleSelectModelNode}
        meshGenerating={ctx.meshGenerating}
        meshConfigDirty={ctx.meshConfigDirty}
        meshTargetLabel={activeMeshIntent.targetLabel}
        onBuildMeshSelected={() => void handleBuildMeshSelected()}
        onBuildMeshAll={() => void handleBuildMeshAll()}
        onOpenMeshInspector={handleOpenMeshInspector}
        onOpenMeshQuality={handleOpenMeshQuality}
        onOpenMeshSizeSettings={handleOpenMeshSize}
        onOpenMeshMethodSettings={handleOpenMeshMethod}
        onOpenMeshPipeline={handleOpenMeshPipeline}
        selectedObjectId={ctx.selectedObjectId}
        onRequestObjectFocus={ctx.requestFocusObject}
        hasSharedAirboxDomain={hasSharedAirboxDomain}
        canSyncScriptBuilder={Boolean(ctx.sessionFooter.scriptPath)}
        scriptSyncBusy={ctx.scriptSyncBusy}
        onSyncScriptBuilder={() => void ctx.syncScriptBuilder()}
        onStudyAddPrimitive={handleStudyAddPrimitive}
        onStudyAddMacro={handleStudyAddMacro}
        onStudyDuplicateSelected={handleStudyDuplicateSelected}
        onStudyToggleSelectedEnabled={handleStudyToggleSelectedEnabled}
        onAddResultAnalysis={handleAddResultAnalysis}
        onObjectAddInteraction={handleObjectAddInteraction}
        onAssignMagnetizationPreset={handleAssignMagnetizationPreset}
        onSetTextureTransformMode={handleSetTextureTransformMode}
      /> : null}
      {FRONTEND_DIAGNOSTIC_FLAGS.shell.showBackendErrorNotice && activeBackendError ? (
        <div className="border-b border-rose-500/20 bg-rose-950/10 px-3 py-3">
          <BackendErrorNotice
            error={activeBackendError}
            onDismiss={() => setDismissedBackendErrorAt(activeBackendError.timestampUnixMs)}
          />
        </div>
      ) : null}
      {FRONTEND_DIAGNOSTIC_FLAGS.shell.useDockingShell ? (
        <WorkspaceDockingShell />
      ) : (
        <PanelGroup
          orientation="horizontal"
          className="flex flex-row flex-1 min-h-0 min-w-0 overflow-hidden"
          resizeTargetMinimumSize={{ coarse: 40, fine: 12 }}
        >
          {FRONTEND_DIAGNOSTIC_FLAGS.shell.showSidebar && !ctx.sidebarCollapsed && (
            <>
              <Panel
                id="workspace-sidebar"
                defaultSize={PANEL_SIZES.sidebarDefault}
                minSize={PANEL_SIZES.sidebarMin}
                maxSize={PANEL_SIZES.sidebarMax}
                collapsible
                collapsedSize="0%"
              >
                <RunSidebar />
              </Panel>
              <PanelResizeHandle className="h-full w-2 bg-transparent cursor-ew-resize flex items-center justify-center transition-colors relative hover:bg-muted/50 active:bg-muted/50 after:content-[''] after:absolute after:top-1/2 after:left-1/2 after:-translate-x-1/2 after:-translate-y-1/2 after:w-[2px] after:h-9 after:rounded-full after:bg-border hover:after:bg-primary active:after:bg-primary z-50" />
            </>
          )}

          <Panel
            id="workspace-main"
            defaultSize={ctx.sidebarCollapsed ? "100%" : PANEL_SIZES.bodyMainDefault}
            minSize={PANEL_SIZES.bodyMainMin}
          >
            <Panel
              id="workspace-viewport"
              defaultSize={viewportPanelDefaultSize}
              minSize={PANEL_SIZES.viewportMin}
            >
              <div className="flex flex-row h-full min-h-0 min-w-0 overflow-hidden bg-background flex-1 relative">
                <div className="flex flex-col flex-1 min-w-0 min-h-0">
                  {FRONTEND_DIAGNOSTIC_FLAGS.shell.showViewportBar ? <ViewportBar /> : null}
                  {FRONTEND_DIAGNOSTIC_FLAGS.shell.showPreviewNotices ? previewNotices : null}
                  <ViewportCanvasArea />
                </div>
              </div>
            </Panel>
          </Panel>

          {/* ── Right inspector (mode-specific) ── */}
          {FRONTEND_DIAGNOSTIC_FLAGS.shell.showRightInspector && rightInspectorOpen ? (
            <>
              <PanelResizeHandle className="h-full w-2 bg-transparent cursor-ew-resize flex items-center justify-center transition-colors relative hover:bg-muted/50 active:bg-muted/50 after:content-[''] after:absolute after:top-1/2 after:left-1/2 after:-translate-x-1/2 after:-translate-y-1/2 after:w-[2px] after:h-9 after:rounded-full after:bg-border hover:after:bg-primary active:after:bg-primary z-50" />
              <Panel
                id="workspace-right-inspector"
                defaultSize={rightInspectorDefaultSize}
                minSize={rightInspectorMinSize}
                maxSize={rightInspectorMaxSize}
                collapsible
                collapsedSize={0}
              >
                {ctx.workspaceMode === "build" && <BuildRightInspector />}
                {ctx.workspaceMode === "study" && <StudyRightInspector />}
                {ctx.workspaceMode === "analyze" && <AnalyzeRightInspector />}
              </Panel>
            </>
          ) : null}
        </PanelGroup>
      )}

      {FRONTEND_DIAGNOSTIC_FLAGS.shell.showStatusBar ? <StatusBar
        connection={ctx.connection}
        step={ctx.effectiveLiveState?.step ?? ctx.run?.total_steps ?? 0}
        stepDisplay={fmtStepValue(ctx.effectiveLiveState?.step ?? ctx.run?.total_steps ?? 0, ctx.hasSolverTelemetry)}
        simTime={fmtSIOrDash(ctx.effectiveLiveState?.time ?? ctx.run?.final_time ?? 0, "s", ctx.hasSolverTelemetry)}
        wallTime={ctx.elapsed > 0 ? fmtDuration(ctx.elapsed) : "—"}
        throughput={ctx.stepsPerSec > 0 ? `${ctx.stepsPerSec.toFixed(1)} st/s` : "—"}
        backend={ctx.session?.requested_backend ?? ""}
        runtimeEngine={ctx.runtimeEngineLabel ?? undefined}
        runtimeGpuLabel={ctx.runtimeEngineGpuLabel ?? undefined}
        precision={ctx.session?.precision ?? ""}
        status={ctx.workspaceStatus}
        activityLabel={ctx.activity.label}
        activityDetail={ctx.activity.detail}
        progressMode={ctx.activity.progressMode}
        progressValue={ctx.activity.progressValue}
        commandMessage={ctx.commandMessage}
        commandState={
          ctx.activeCommandState === "acknowledged"
            ? "progress"
            : ctx.activeCommandState === "completed"
              ? "success"
              : ctx.activeCommandState === "rejected"
                ? "rejected"
                : undefined
        }
        displayLabel={ctx.selectedQuantityLabel}
        displayDetail={
          ctx.selectedScalarValue != null
            ? `${ctx.selectedScalarValue.toExponential(4)} ${ctx.selectedQuantityUnit ?? ""}`.trim()
            : ctx.isVectorQuantity
              ? ctx.requestedPreviewComponent
              : "scalar"
        }
        previewPending={ctx.previewBusy}
        runtimeCanAcceptCommands={ctx.runtimeCanAcceptCommands}
        pipelineLabel={footerPipeline.label}
        pipelineDetail={footerPipeline.detail}
        pipelineProgressMode={footerPipeline.mode}
        pipelineProgressValue={footerPipeline.value}
        stageLabel={footerStage.label}
        stageDetail={footerStage.detail}
        stageProgressMode={footerStage.mode}
        stageProgressValue={footerStage.value}
        eTotalSpark={ctx.eTotalSpark}
        dmDtSpark={ctx.dmDtSpark}
        dtSpark={ctx.dtSpark}
        hasSolverTelemetry={ctx.hasSolverTelemetry}
        nodeCount={ctx.isFemBackend && ctx.femMesh
          ? `${ctx.femMesh.nodes.length.toLocaleString()} nodes`
          : ctx.totalCells && ctx.totalCells > 0
            ? `${ctx.totalCells.toLocaleString()} cells`
            : undefined}
      /> : null}

      <MeshBuildModal
        open={meshBuildDialogOpen}
        generating={meshBuildRuntime.generating}
        intent={meshBuildIntent}
        stages={meshBuildStages}
        progressValue={meshBuildProgress}
        engineLog={ctx.engineLog}
        meshWorkspace={ctx.meshWorkspace}
        effectiveTargets={effectiveMeshTargets}
        errorMessage={meshBuildError ?? meshBuildRuntime.errorMessage}
        errorDetails={meshBuildBackendError}
        onBackground={handleBackgroundMeshBuild}
        onClose={handleCloseMeshBuildDialog}
      />

      {/* ── Workspace overlays (settings, docs) ── */}
      {FRONTEND_DIAGNOSTIC_FLAGS.shell.showWorkspaceOverlays ? <SettingsDialog /> : null}
      {FRONTEND_DIAGNOSTIC_FLAGS.shell.showWorkspaceOverlays ? <PhysicsDocsDrawer /> : null}
    </div>
  );
}

/* ── Public export ── */

export default function RunControlRoom({ initialWorkspaceMode }: { initialWorkspaceMode?: WorkspaceMode }) {
  return (
    <ControlRoomProvider>
      <ControlRoomShell initialWorkspaceMode={initialWorkspaceMode} />
    </ControlRoomProvider>
  );
}
