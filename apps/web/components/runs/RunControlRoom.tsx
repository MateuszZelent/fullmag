"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import AppBar from "../shell/AppBar";
import RibbonBar from "../shell/RibbonBar";
import StatusBar from "../shell/StatusBar";
import {
  useSlice2DToolbarStore,
  type Slice2DToolbarState,
} from "@/src/features/slice2d";
import {
  positionPercentFromSliceIndex,
  resolveEffectiveSlicePlane,
  resolveSliceAxisSelection,
  sliceIndexFromPositionPercent,
  sliceAxisFromPlane,
} from "@/src/features/slice2d/axisMapping";
import type {
  AirboxDisplayPatch,
  ViewportMeshRenderMode,
} from "../shell/ribbon/command-registry";
import { DataPlaneStatusBadges } from "./control-room/DataPlaneStatusBadges";
import RunSidebar from "./control-room/RunSidebar";
import { ViewportBar, ViewportCanvasArea } from "./control-room/ViewportPanels";
import type { Viewport3DHealthReport } from "@/components/preview/FemMeshView3D";
import { ViewportTabBar } from "./control-room/ViewportTabBar";
import { WorkspaceBodyLayout } from "./control-room/WorkspaceBodyLayout";
import FullmagLogo from "../brand/FullmagLogo";
import { recordFrontendDebugEvent } from "../../lib/workspace/navigation-debug";
import type {
  ScriptBuilderCurrentModuleEntry,
  ScriptBuilderMagneticInteractionKind,
} from "../../lib/session/types";
import { defaultMeshEntityViewState } from "../../lib/session/types";
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
import {
  resetSceneEditorToCameraFirst,
  shouldForceCameraFirstViewport,
} from "./control-room/workspaceViewportGuards";
import { useAnalyzeStore } from "@/features/analyze";
import { useWorkspaceGraphBridge } from "@/features/workspace-graph";
import { useGeometryBuilderStore } from "@/features/geometry-builder/store/useGeometryBuilderStore";
import type { PrimitiveKind } from "@/features/geometry-builder/model/types";
import { createScenePrimitiveAuthoringUpdate } from "@/features/geometry-builder/scene/scenePrimitiveAuthoring";
import { useSceneAuthoringActions } from "@/src/hooks/resources/useSceneDocument";
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
import {
  buildPipelineStudyStageNodeId,
  parseStudyNodeContext,
} from "@/lib/study-builder/node-context";
import type {
  StudyPipelineDocument,
  StudyPrimitiveStageKind,
} from "@/lib/study-builder/types";
import { extractFemCpuThreadSummary } from "./control-room/helpers";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  airboxDisplayStateFromRenderMode,
  resolveAirboxDisplayState,
} from "./control-room/airboxDisplay";

const WORKSPACE_ANALYZE_HREF = "/workspace/analyze";

type RibbonPreviewComponent = "3D" | "x" | "y" | "z" | "magnitude";

function surfaceColorFieldFromRibbonComponent(
  component: RibbonPreviewComponent,
): "orientation" | "x" | "y" | "z" | "magnitude" {
  if (component === "x" || component === "y" || component === "z") {
    return component;
  }
  if (component === "3D") {
    return "orientation";
  }
  return "magnitude";
}

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

function syncStudyRuntimeState(
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

function parsePositiveNumber(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function formatWorkspaceStatus(status: string): string {
  return status.replace(/_/g, " ");
}

function commandBlockedReason(
  ctx: {
    interactiveEnabled: boolean;
    runtimeCanAcceptCommands: boolean;
    commandBusy: boolean;
    commandMessage: string | null;
    workspaceStatus: string;
    awaitingCommand: boolean;
    isWaitingForCompute: boolean;
  },
  action: "run" | "pause" | "stop" | "skip",
  builderRunBlocked: boolean,
): string | null {
  if (!ctx.interactiveEnabled) {
    return "Solver commands are disabled because this workspace is not running in interactive mode.";
  }
  if (!ctx.runtimeCanAcceptCommands) {
    return "Solver runtime is busy and cannot accept commands yet.";
  }
  if (ctx.commandBusy) {
    return ctx.commandMessage ?? "A solver command is already being sent.";
  }
  if (action === "run" && builderRunBlocked) {
    return "Compute is blocked because the Geometry builder has changes that must be built or validated first.";
  }

  const status = formatWorkspaceStatus(ctx.workspaceStatus);
  if (action === "run") {
    return "Compute is only available when the workspace is waiting for compute, awaiting a command, or paused. Current status: " + status + ".";
  }
  if (action === "pause") {
    return "Pause is only available while the solver is running. Current status: " + status + ".";
  }
  if (action === "stop") {
    return "Stop is only available while the solver is running, paused, or waiting for compute. Current status: " + status + ".";
  }
  return "Skip is only available while the solver is running or paused. Current status: " + status + ".";
}

function resolveFiniteMin(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.min(...values);
}

function resolveFiniteMax(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.max(...values);
}

function normalizeSliceComponent(
  component: string | null | undefined,
): Slice2DToolbarState["component"] {
  if (component === "x" || component === "y" || component === "z" || component === "magnitude") {
    return component;
  }
  return "magnitude";
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
  const ctx = useMemo(
    () => ({ ..._transport, ..._viewport, ..._cmd, ..._model }),
    [_cmd, _model, _transport, _viewport],
  );
  const slice2DToolbarPatch = useSlice2DToolbarStore((state) => state.patch);
  const patchSlice2DToolbar = useSlice2DToolbarStore((state) => state.patchToolbar);
  const hasNoActiveWorkspace = ctx.error?.includes("no active local live workspace") ?? false;

  /* Local elapsed / throughput – updated every second via setInterval so that
   * the status bar stays live without polluting transportValue with Date.now(). */
  const [_now, _setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ctx.sessionStartedAt || ctx.sessionFinishedAt > ctx.sessionStartedAt) return;
    const id = setInterval(() => _setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ctx.sessionStartedAt, ctx.sessionFinishedAt]);
  const elapsed = ctx.sessionStartedAt
    ? (ctx.sessionFinishedAt > ctx.sessionStartedAt
        ? ctx.sessionFinishedAt - ctx.sessionStartedAt
        : _now - ctx.sessionStartedAt)
    : 0;
  const stepsPerSec = elapsed > 0 ? (ctx.effectiveStep / elapsed) * 1000 : 0;
  const femDiscretization = resolveFemDiscretization(
    ctx.domainCapabilities,
    ctx.isFemBackend,
  );
  const femCpuThreadSummary = useMemo(
    () => extractFemCpuThreadSummary(ctx.engineLog),
    [ctx.engineLog],
  );
  const commandSolverIntegrators = ctx.solverPlan?.integrator ?? ctx.solverSettings.integrator;
  const commandAdaptiveDtMin = ctx.solverPlan?.adaptive?.dtMin;
  const commandAdaptiveDtMax = ctx.solverPlan?.adaptive?.dtMax;
  const commandFixedDtFromPlan = ctx.solverPlan?.fixedTimestep;
  const commandFixedDtFromSettings = parsePositiveNumber(ctx.solverSettings.fixedTimestep);
  const commandSolverDtSamples = useMemo(
    () =>
      ctx.scalarRows
        .slice(-128)
        .map((row) => row.solver_dt)
        .filter(isPositiveFinite),
    [ctx.scalarRows],
  );
  const commandMinDt = useMemo(() => {
    if (!ctx.hasSolverTelemetry) return null;
    return isPositiveFinite(commandAdaptiveDtMin)
      ? commandAdaptiveDtMin
      : resolveFiniteMin(commandSolverDtSamples);
  }, [commandAdaptiveDtMin, ctx.hasSolverTelemetry, commandSolverDtSamples]);
  const commandMaxDt = useMemo(() => {
    if (!ctx.hasSolverTelemetry) return null;
    return isPositiveFinite(commandAdaptiveDtMax)
      ? commandAdaptiveDtMax
      : resolveFiniteMax(commandSolverDtSamples);
  }, [commandAdaptiveDtMax, ctx.hasSolverTelemetry, commandSolverDtSamples]);
  const commandFixedDt = useMemo(() => {
    if (isPositiveFinite(commandFixedDtFromPlan)) {
      return commandFixedDtFromPlan;
    }
    return commandFixedDtFromSettings;
  }, [commandFixedDtFromPlan, commandFixedDtFromSettings]);
  const sidebarCollapsed = ctx.sidebarCollapsed;
  const setSidebarCollapsed = ctx.setSidebarCollapsed;
  const workspaceStage = ctx.workspaceStage;
  const setWorkspaceStage = ctx.setWorkspaceStage;
  const effectiveViewMode = ctx.effectiveViewMode;
  const handleViewModeChange = ctx.handleViewModeChange;
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
  const setRightInspectorTab = useWorkspaceStore((state) => state.setRightInspectorTab);
  const activeCoreTab = useWorkspaceStore((state) => state.activeCoreTab);
  const setActiveCoreTab = useWorkspaceStore((state) => state.setActiveCoreTab);
  const setActiveContextualTab = useWorkspaceStore((state) => state.setActiveContextualTab);
  const workspaceTabsByStage = useWorkspaceStore((state) => state.workspaceTabsByStage);
  const activeWorkspaceTabByStage = useWorkspaceStore((state) => state.activeWorkspaceTabByStage);
  const currentStage = useWorkspaceStore((state) => state.currentStage);
  const analyzeResultsWorkspace = useAnalyzeStore((state) => state.resultsWorkspace);
  const builderModeEnabled = useGeometryBuilderStore((state) => state.builderMode.enabled);
  const builderViewportTool = useGeometryBuilderStore((state) => state.viewportTool);
  const builderRunBlocked = useGeometryBuilderStore((state) =>
    currentStage === "build" && activeCoreTab === "Geometry" && state.builderMode.enabled
      ? state.isRunBlocked()
      : false,
  );
  const builderSelection = useGeometryBuilderStore((state) => state.builderSelection);
  const validateBuilderAll = useGeometryBuilderStore((state) => state.validateAll);
  const setBuilderViewportTool = useGeometryBuilderStore((state) => state.setViewportTool);
  const requestBuilderFocusSelected = useGeometryBuilderStore(
    (state) => state.requestFocusSelected,
  );
  const requestBuilderFrameAll = useGeometryBuilderStore(
    (state) => state.requestFrameAll,
  );
  const setBuilderPrimitiveTransform = useGeometryBuilderStore((state) => state.setPrimitiveTransform);
  const getBuilderPrimitive = useGeometryBuilderStore((state) => state.getPrimitive);
  const getBackendBuildBlockedReason = useGeometryBuilderStore(
    (state) => state.getBackendBuildBlockedReason,
  );
  const builderUniverseOrigin = useGeometryBuilderStore((state) => state.graph.universe.origin);
  const toggleBuilderSnap = useGeometryBuilderStore((state) => state.toggleSnap);
  const disableBuilderMode = useGeometryBuilderStore((state) => state.disableBuilder);
  const [viewportSize, setViewportSize] = useState({ width: 1920, height: 1080 });

  const solverControlDisabledReasons = useMemo(() => {
    const reasonContext = {
      interactiveEnabled: ctx.interactiveEnabled,
      runtimeCanAcceptCommands: ctx.runtimeCanAcceptCommands,
      commandBusy: ctx.commandBusy,
      commandMessage: ctx.commandMessage,
      workspaceStatus: ctx.workspaceStatus,
      awaitingCommand: ctx.awaitingCommand,
      isWaitingForCompute: ctx.isWaitingForCompute,
    };
    return {
      run: ctx.canRunCommand && !builderRunBlocked
        ? null
        : commandBlockedReason(reasonContext, "run", builderRunBlocked),
      pause: ctx.canPauseCommand
        ? null
        : commandBlockedReason(reasonContext, "pause", builderRunBlocked),
      stop: ctx.canStopCommand
        ? null
        : commandBlockedReason(reasonContext, "stop", builderRunBlocked),
      skip: ctx.canSkipCommand
        ? null
        : commandBlockedReason(reasonContext, "skip", builderRunBlocked),
    };
  }, [
    builderRunBlocked,
    ctx.awaitingCommand,
    ctx.canPauseCommand,
    ctx.canRunCommand,
    ctx.canSkipCommand,
    ctx.canStopCommand,
    ctx.commandBusy,
    ctx.commandMessage,
    ctx.interactiveEnabled,
    ctx.isWaitingForCompute,
    ctx.runtimeCanAcceptCommands,
    ctx.workspaceStatus,
  ]);

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
  const workspaceTitle = launchDisplayName(launchIntent) ?? ctx.session?.problem_name ?? "Local Live Workspace";

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

  useEffect(() => {
    const geometryTabSelected = currentStage === "build" && activeCoreTab === "Geometry";
    if (!geometryTabSelected && builderModeEnabled) {
      disableBuilderMode();
    }
    if (!geometryTabSelected) {
      return;
    }
    if (effectiveViewMode !== "3D") {
      handleViewModeChange("3D");
    }
  }, [
    activeCoreTab,
    builderModeEnabled,
    currentStage,
    disableBuilderMode,
    effectiveViewMode,
    handleViewModeChange,
  ]);

  useEffect(() => {
    if (!shouldForceCameraFirstViewport({
      workspaceMode: workspaceStage,
      activeCoreTab,
      effectiveViewMode,
    })) {
      return;
    }
    if (ctx.activeTransformScope !== null) {
      ctx.setActiveTransformScope(null);
    }
    if (ctx.sceneDocument?.editor.active_transform_scope != null || ctx.sceneDocument?.editor.gizmo_mode != null) {
      ctx.setSceneDocument((previous) => resetSceneEditorToCameraFirst(previous));
    }
    if (builderViewportTool !== "camera") {
      setBuilderViewportTool("camera");
    }
  }, [
    activeCoreTab,
    builderViewportTool,
    ctx,
    effectiveViewMode,
    setBuilderViewportTool,
    workspaceStage,
  ]);

  const spatialPreview = ctx.preview?.kind === "spatial" ? ctx.preview : null;
  const [viewportRuntimeHealth, setViewportRuntimeHealth] =
    useState<Viewport3DHealthReport | null>(null);
  const viewport3DStatus = useMemo<{
    status: "active" | "inactive" | "warning";
    reason: string;
    detail: string;
  }>(() => {
    if (ctx.effectiveViewMode !== "3D") {
      return {
        status: "inactive",
        reason: `Current viewport mode is ${ctx.effectiveViewMode}; switch to 3D Viewport.`,
        detail: "The 3D renderer is mounted only for the 3D viewport.",
      };
    }
    if (ctx.previewBusy) {
      return {
        status: "warning",
        reason: "3D preview data is still loading or recomputing.",
        detail: "Visualization can be temporarily empty while field or mesh preview resources are pending.",
      };
    }
    if (femDiscretization) {
      if (!ctx.femMeshData || ctx.femMeshData.nNodes <= 0) {
        return {
          status: "inactive",
          reason: "FEM mesh data is not available.",
          detail: "Build or load a FEM mesh before the 3D visualization can render.",
        };
      }
      if (!ctx.femTopologyKey && !ctx.femMeshData.meshGenerationId) {
        return {
          status: "inactive",
          reason: "FEM topology key is missing.",
          detail: "The 3D viewport needs a stable topology key to mount the FEM renderer.",
        };
      }
      const any3DLayerVisible =
        ctx.femViewportLayers.showPrimitives ||
        ctx.femViewportLayers.showMesh ||
        ctx.femViewportLayers.showQuantity ||
        ctx.femViewportLayers.showMagneticTexture ||
        ctx.meshShowArrows ||
        ctx.airMeshVisible;
      if (!any3DLayerVisible) {
        return {
          status: "inactive",
          reason: "All 3D layers are disabled.",
          detail: "Enable Primitive, Mesh View, Quantity, Texture, Vectors, or Airbox in the View ribbon.",
        };
      }
      if (ctx.objectViewMode === "isolate" && !ctx.selectedObjectId && !ctx.selectedEntityId) {
        return {
          status: "warning",
          reason: "Object isolate mode is active without a selected object.",
          detail: "Switch Display > Context or select an object to restore a visible 3D scope.",
        };
      }
      if (viewportRuntimeHealth && viewportRuntimeHealth.status !== "active") {
        return viewportRuntimeHealth;
      }
      return {
        status: "active",
        reason: viewportRuntimeHealth?.reason ?? "3D visualization is active.",
        detail:
          viewportRuntimeHealth?.detail ??
          `FEM mesh: ${ctx.femMeshData.nNodes.toLocaleString()} nodes, ${ctx.femMeshData.nElements.toLocaleString()} elements.`,
      };
    }
    if (!ctx.previewGrid && !spatialPreview) {
      return {
        status: "inactive",
        reason: "No 3D preview/grid data is available.",
        detail: "Run or compute a preview quantity before using the 3D visualization.",
      };
    }
    return {
      status: "active",
      reason: "3D visualization is active.",
      detail: "Structured-grid preview data is available for the 3D renderer.",
    };
  }, [
    ctx.airMeshVisible,
    ctx.effectiveViewMode,
    ctx.femMeshData,
    ctx.femTopologyKey,
    ctx.femViewportLayers.showMagneticTexture,
    ctx.femViewportLayers.showMesh,
    ctx.femViewportLayers.showPrimitives,
    ctx.femViewportLayers.showQuantity,
    ctx.meshShowArrows,
    ctx.objectViewMode,
    ctx.previewBusy,
    ctx.previewGrid,
    ctx.selectedEntityId,
    ctx.selectedObjectId,
    femDiscretization,
    spatialPreview,
    viewportRuntimeHealth,
  ]);
  const handleViewportHealthChange = useCallback((report: Viewport3DHealthReport) => {
    setViewportRuntimeHealth((previous) => {
      if (
        previous?.status === report.status &&
        previous.reason === report.reason &&
        previous.detail === report.detail
      ) {
        return previous;
      }
      return report;
    });
  }, []);
  useEffect(() => {
    const handleHealthEvent = (event: Event) => {
      const detail = (event as CustomEvent<Viewport3DHealthReport>).detail;
      if (
        !detail ||
        (detail.status !== "active" &&
          detail.status !== "inactive" &&
          detail.status !== "warning")
      ) {
        return;
      }
      handleViewportHealthChange(detail);
    };
    window.addEventListener("fullmag:viewport3d-health", handleHealthEvent);
    return () => window.removeEventListener("fullmag:viewport3d-health", handleHealthEvent);
  }, [handleViewportHealthChange]);
  const [meshBuildDialogOpen, setMeshBuildDialogOpen] = useState(false);
  const [meshBuildIntent, setMeshBuildIntent] = useState<ReturnType<typeof meshBuildIntentForNode> | null>(null);
  const [meshBuildError, setMeshBuildError] = useState<string | null>(null);
  const [meshBuildOpenedAt, setMeshBuildOpenedAt] = useState<number | null>(null);
  const [meshBuildNotice, setMeshBuildNotice] = useState<{ title: string; message: string } | null>(null);
  const awaitingMeshBuildCompletionRef = useRef(false);
  const meshBuildAutoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const meshBuildNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    enabled:
      FRONTEND_DIAGNOSTIC_FLAGS.workspace.enableGraphV2 &&
      FRONTEND_DIAGNOSTIC_FLAGS.workspace.enableWorkspaceGraphBridge,
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

  const openAnalyzeCenterTab = useCallback(
    (
      selection?: Parameters<typeof ctx.openAnalyze>[0],
      debug?: { nodeId?: string; resultWorkspaceId?: string; source?: string },
    ) => {
      setActiveCoreTab("Results");
      setActiveContextualTab(null);
      ctx.openAnalyzeSurface({
        selection,
        resultWorkspaceId: debug?.resultWorkspaceId,
        source: debug?.source ?? "run-control-room",
      });
      if (pathname !== WORKSPACE_ANALYZE_HREF) {
        recordFrontendDebugEvent("run-control-room", "router_replace_analyze_tab", debug ?? {});
        router.replace(WORKSPACE_ANALYZE_HREF);
      }
    },
    [ctx, pathname, router, setActiveContextualTab, setActiveCoreTab],
  );

  const handleSelectModelNode = useCallback((nodeId: string) => {
    ctx.setSelectedSidebarNodeId(nodeId);
    ctx.setSelectedObjectId(resolveSelectedObjectId(nodeId, ctx.modelBuilderGraph));
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
    if (ctx.sidebarCollapsed) {
      ctx.setSidebarCollapsed(false);
    }
    if (nodeId === "antennas" || nodeId.startsWith("ant-")) {
      maybePreviewAntennaField();
    }
  }, [
    ctx,
    maybePreviewAntennaField,
    openAnalyzeCenterTab,
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

  const selectedBuilderPrimitiveId =
    builderSelection.type === "primitive" ? builderSelection.id : null;
  const sceneAuthoring = useSceneAuthoringActions();

  const handleBuilderAddPrimitive = useCallback((kind: PrimitiveKind) => {
    setActiveCoreTab("Geometry");
    if (builderModeEnabled) {
      disableBuilderMode();
    }
    if (ctx.effectiveViewMode !== "3D") {
      ctx.handleViewModeChange("3D");
    }
    const referenceOverlay =
      ctx.selectedObjectId
        ? ctx.objectOverlays.find((overlay) => overlay.id === ctx.selectedObjectId) ?? null
        : null;
    const fallbackOverlay = ctx.objectOverlays[0] ?? null;
    const prev = ctx.sceneDocument;
    if (!prev) return;
    let update: ReturnType<typeof createScenePrimitiveAuthoringUpdate>;
    try {
      update = createScenePrimitiveAuthoringUpdate({
        scene: prev,
        kind,
        placementOverlay: referenceOverlay ?? fallbackOverlay,
      });
    } catch (error) {
      console.warn("scene primitive creation is not available", error);
      return;
    }
    ctx.setSceneDocument(update.scene);
    void sceneAuthoring
      .createObject(update.createObjectRequest)
      .then(() => sceneAuthoring.updateSceneMergePatch(update.postCreateMergePatch))
      .then((committedScene) => {
        ctx.setSceneDocument(committedScene);
      })
      .catch((error) => {
        console.error("failed to commit authoring primitive to backend scene", error);
        void sceneAuthoring
          .updateSceneMergePatch(update.mergePatch)
          .then((committedScene) => {
            ctx.setSceneDocument(committedScene);
          })
          .catch((fallbackError) => {
            console.error("failed to fallback commit authoring primitive merge patch", fallbackError);
            ctx.setSceneDocument(prev);
          });
      });
    if (ctx.sidebarCollapsed) {
      ctx.setSidebarCollapsed(false);
    }
    ctx.setSelectedSidebarNodeId(`geo-${update.selectedObjectId}`);
    ctx.setSelectedObjectId(update.selectedObjectId);
    ctx.setSelectedEntityId(null);
    ctx.setFocusedEntityId(null);
    ctx.requestFocusObject(update.selectedObjectId);
    setRightInspectorOpen(true);
    ctx.setActiveTransformScope("object");
    setBuilderViewportTool("move");
  }, [
    builderModeEnabled,
    ctx,
    disableBuilderMode,
    sceneAuthoring,
    setActiveCoreTab,
    setRightInspectorOpen,
    setBuilderViewportTool,
  ]);

  const handleBuilderSetViewportMode = useCallback((mode: "camera" | "manipulate") => {
    setBuilderViewportTool(mode === "camera" ? "camera" : selectedBuilderPrimitiveId ? "move" : "select");
  }, [selectedBuilderPrimitiveId, setBuilderViewportTool]);

  const handleBuilderSetTransformTool = useCallback((tool: "move" | "rotate" | "scale") => {
    setBuilderViewportTool(tool);
    if (activeCoreTab === "Geometry" && ctx.selectedObjectId) {
      ctx.setActiveTransformScope("object");
      ctx.setSceneDocument((prev) =>
        prev
          ? {
              ...prev,
              editor: {
                ...prev.editor,
                active_transform_scope: "object",
                gizmo_mode: tool === "move" ? "translate" : tool,
              },
            }
          : prev,
      );
    }
  }, [activeCoreTab, ctx, setBuilderViewportTool]);

  const handleBuilderCenterInUniverse = useCallback((primitiveId: string) => {
    const primitive = getBuilderPrimitive(primitiveId);
    if (!primitive) return;
    setBuilderPrimitiveTransform(primitiveId, {
      ...primitive.transform,
      translation: [...builderUniverseOrigin],
    });
  }, [builderUniverseOrigin, getBuilderPrimitive, setBuilderPrimitiveTransform]);

  const handleBuilderBuildGeometry = useCallback(() => {
    setRightInspectorOpen(true);
  }, [setRightInspectorOpen]);

  const handleBuilderBuildMesh = useCallback(async () => {
    const backendBlockedReason = getBackendBuildBlockedReason(Boolean(femDiscretization));
    if (backendBlockedReason || !femDiscretization || !ctx.sceneDocument?.objects.length) {
      setRightInspectorOpen(true);
      return;
    }
    try {
      await ctx.handleStudyDomainMeshGenerate("geometry_scene_build_mesh");
    } catch {
      // Mesh pipeline already surfaces command errors in the shared command state.
    }
  }, [ctx, femDiscretization, getBackendBuildBlockedReason, setRightInspectorOpen]);

  const handleBuilderBuildAll = useCallback(() => {
    void handleBuilderBuildMesh();
  }, [
    handleBuilderBuildMesh,
  ]);

  const handleBuilderValidateGeometry = useCallback(() => {
    void validateBuilderAll();
    setRightInspectorOpen(true);
  }, [setRightInspectorOpen, validateBuilderAll]);

  const handleBuilderFocusSelected = useCallback(() => {
    requestBuilderFocusSelected();
    setBuilderViewportTool("camera");
  }, [requestBuilderFocusSelected, setBuilderViewportTool]);

  const handleBuilderFrameAll = useCallback(() => {
    requestBuilderFrameAll();
    setBuilderViewportTool("camera");
  }, [requestBuilderFrameAll, setBuilderViewportTool]);

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
      ctx.handleViewModeChange("3D");
      ctx.setSelectedObjectId(objectId);
      ctx.setSelectedSidebarNodeId(`mag-${objectId}`);
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
        return assignMagneticPreset(prev, magnetizationRef, descriptor, {
          objectId,
        });
      });
    },
    [ctx],
  );

  const handleSetTransformScope = useCallback(
    (scope: "camera" | "object" | "texture") => {
      ctx.handleViewModeChange("3D");
      const nextScope = scope === "camera" ? null : scope;
      ctx.setActiveTransformScope(nextScope);
      ctx.setSceneDocument((prev) =>
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
    [ctx],
  );

  const handleSetTextureTransformMode = useCallback(
    (objectId: string, mode: "translate" | "rotate" | "scale") => {
      ctx.handleViewModeChange("3D");
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
    syncStudyRuntimeState(ctx, compiled.stages);
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
    awaitingMeshBuildCompletionRef.current = true;
    if (meshBuildAutoCloseTimerRef.current) {
      clearTimeout(meshBuildAutoCloseTimerRef.current);
      meshBuildAutoCloseTimerRef.current = null;
    }
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
    ctx.handleViewModeChange("3D");
  }, [ctx, hasSharedAirboxDomain, openMeshNode]);

  const handleOpenMeshStatistics = useCallback(() => {
    const nodeId = hasSharedAirboxDomain ? "mesh-statistics" : "universe-mesh-statistics";
    ctx.setSelectedSidebarNodeId(nodeId);
    setRightInspectorOpen(true);
    setRightInspectorTab("properties");
  }, [ctx, hasSharedAirboxDomain, setRightInspectorOpen, setRightInspectorTab]);

  const handleOpenMeshQuality = useCallback(() => {
    openMeshNode(hasSharedAirboxDomain ? "mesh-quality" : "universe-mesh-quality");
    ctx.handleViewModeChange("3D");
  }, [ctx, hasSharedAirboxDomain, openMeshNode]);

  const handleOpenMeshSize = useCallback(() => {
    if (ctx.selectedSidebarNodeId?.startsWith("geo-") && ctx.selectedSidebarNodeId.endsWith("-mesh")) {
      handleSelectModelNode(ctx.selectedSidebarNodeId);
      ctx.openFemMeshWorkspace("mesher");
      ctx.handleViewModeChange("3D");
      return;
    }
    openMeshNode(hasSharedAirboxDomain ? "universe-airbox-mesh" : "universe-mesh-size");
    ctx.handleViewModeChange("3D");
  }, [ctx, handleSelectModelNode, hasSharedAirboxDomain, openMeshNode]);

  const handleOpenMeshTransition = useCallback(() => {
    openMeshNode(hasSharedAirboxDomain ? "mesh-transition" : "universe-mesh-transition");
    ctx.openFemMeshWorkspace("mesher");
    ctx.handleViewModeChange("3D");
  }, [ctx, hasSharedAirboxDomain, openMeshNode]);

  const handleOpenMeshMethod = useCallback(() => {
    openMeshNode(hasSharedAirboxDomain ? "mesh-algorithm" : "universe-mesh-algorithm");
    ctx.openFemMeshWorkspace("mesher");
    ctx.handleViewModeChange("3D");
  }, [ctx, hasSharedAirboxDomain, openMeshNode]);

  const handleOpenMeshOptimization = useCallback(() => {
    openMeshNode(hasSharedAirboxDomain ? "mesh-quality" : "universe-mesh-quality");
    ctx.openFemMeshWorkspace("mesher");
    ctx.handleViewModeChange("3D");
  }, [ctx, hasSharedAirboxDomain, openMeshNode]);

  const handleOpenMeshPipeline = useCallback(() => {
    openMeshNode(hasSharedAirboxDomain ? "mesh-pipeline" : "universe-mesh-pipeline");
    ctx.handleViewModeChange("3D");
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
      openAnalyzeCenterTab(undefined, {
        resultWorkspaceId: id,
        source: "create_result_entry",
      });
    },
    [ctx, openAnalyzeCenterTab],
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

  useEffect(() => {
    if (!awaitingMeshBuildCompletionRef.current) {
      return;
    }
    if (meshBuildRuntime.status === "failure") {
      awaitingMeshBuildCompletionRef.current = false;
      return;
    }
    const succeeded =
      !meshBuildRuntime.generating &&
      !meshBuildRuntime.errorMessage &&
      !ctx.meshConfigDirty;
    if (!succeeded) {
      return;
    }
    awaitingMeshBuildCompletionRef.current = false;
    const nodeCount = ctx.meshWorkspace?.mesh_summary?.node_count ?? ctx.femMesh?.nodes.length ?? 0;
    const elementCount = ctx.meshWorkspace?.mesh_summary?.element_count ?? ctx.femMesh?.elements.length ?? 0;
    setMeshBuildNotice({
      title: "Mesh build completed",
      message: `${nodeCount.toLocaleString()} nodes · ${elementCount.toLocaleString()} tetrahedra. Viewport is now updated.`,
    });
    if (meshBuildDialogOpen) {
      meshBuildAutoCloseTimerRef.current = setTimeout(() => {
        setMeshBuildDialogOpen(false);
      }, 1200);
    }
  }, [
    ctx.femMesh?.elements.length,
    ctx.femMesh?.nodes.length,
    ctx.meshConfigDirty,
    ctx.meshWorkspace?.mesh_summary?.element_count,
    ctx.meshWorkspace?.mesh_summary?.node_count,
    meshBuildDialogOpen,
    meshBuildRuntime.errorMessage,
    meshBuildRuntime.generating,
    meshBuildRuntime.status,
  ]);

  useEffect(() => {
    if (!meshBuildNotice) {
      return;
    }
    if (meshBuildNoticeTimerRef.current) {
      clearTimeout(meshBuildNoticeTimerRef.current);
    }
    meshBuildNoticeTimerRef.current = setTimeout(() => {
      setMeshBuildNotice(null);
    }, 4800);
    return () => {
      if (meshBuildNoticeTimerRef.current) {
        clearTimeout(meshBuildNoticeTimerRef.current);
        meshBuildNoticeTimerRef.current = null;
      }
    };
  }, [meshBuildNotice]);

  useEffect(() => () => {
    if (meshBuildAutoCloseTimerRef.current) {
      clearTimeout(meshBuildAutoCloseTimerRef.current);
    }
    if (meshBuildNoticeTimerRef.current) {
      clearTimeout(meshBuildNoticeTimerRef.current);
    }
  }, []);

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
    if (!ctx.selectedSidebarNodeId || !ctx.selectedSidebarNodeId.startsWith("res-")) {
      ctx.setSelectedSidebarNodeId(hasEigenArtifacts ? "res-eigenmodes" : "results");
    }
    openAnalyzeCenterTab(
      hasEigenArtifacts ? { tab: "spectrum", selectedModeIndex: null } : undefined,
      { source: "auto_results" },
    );
  }, [
    ctx,
    currentResultsEntryKey,
    hasEigenArtifacts,
    hasResultsAvailable,
    openAnalyzeCenterTab,
  ]);

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
      {(ctx.previewMessage || ctx.previewIsStale || ctx.previewIsInitialSampleStale) && (
        <div className="px-2.5 py-1.5 border-b border-border/40 bg-card/40 text-muted-foreground text-xs leading-snug">
          {ctx.previewMessage ??
            (ctx.previewIsInitialSampleStale
              ? "Showing bootstrap preview until first live preview sample arrives 2"
              : "Preview update pending")}
        </div>
      )}
    </>
  );

  const handleRibbonPreviewComponent = (component: RibbonPreviewComponent) => {
    const nextComponent = component === "3D" ? "magnitude" : component;
    ctx.setComponent(nextComponent);
    void ctx.patchDisplay({
      view_mode: component === "3D" ? "3d" : "2d",
      field_component: nextComponent,
    });
    const nextColorField = surfaceColorFieldFromRibbonComponent(component);
    ctx.setMeshEntityViewState((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const part of ctx.meshParts) {
        if (part.role !== "magnetic_object") {
          continue;
        }
        const current = next[part.id] ?? defaultMeshEntityViewState(part);
        if (current.colorField === nextColorField) {
          if (!next[part.id]) {
            next[part.id] = current;
            changed = true;
          }
          continue;
        }
        next[part.id] = { ...current, colorField: nextColorField };
        changed = true;
      }
      return changed ? next : previous;
    });
  };

  const handleRibbonPreviewEveryN = (everyN: number) => {
    void ctx.patchDisplay({ vector_density: everyN });
  };

  const handleRibbonPreviewMaxPoints = (maxPoints: number) => {
    void ctx.patchDisplay({ max_points: maxPoints });
  };

  const handleRibbonPreviewColormap = (colormap: string) => {
    void ctx.patchDisplay({ colormap });
  };

  const handleRibbonPreviewAutoScale = (enabled: boolean) => {
    void ctx.patchDisplay({ auto_contrast: enabled });
  };

  const effectiveSlicePlane = resolveEffectiveSlicePlane({
    plane: ctx.plane,
    clipAxis: ctx.meshClipAxis,
    preferClipAxis: Boolean(femDiscretization),
  });

  const slice2DToolbar = useMemo<Slice2DToolbarState>(() => ({
    quantityId: String(ctx.requestedPreviewQuantity ?? ctx.selectedQuantity ?? "m"),
    component: normalizeSliceComponent(ctx.requestedPreviewComponent ?? ctx.component),
    axis: sliceAxisFromPlane(effectiveSlicePlane),
    mode: ctx.requestedPreviewAllLayers ? "all_layers" : "single",
    layerIndex: ctx.sliceIndex,
    positionPercent: femDiscretization
      ? (ctx.meshClipPos ?? 50)
      : positionPercentFromSliceIndex({
        grid: ctx.previewGrid,
        plane: effectiveSlicePlane,
        sliceIndex: ctx.sliceIndex,
      }),
    thicknessPercent: null,
    colormap: "viridis",
    autoContrast: Boolean(ctx.requestedPreviewAutoScale ?? true),
    showPrimitives: ctx.femViewportLayers.showPrimitives,
    showMesh: ctx.femViewportLayers.showMesh,
    showMagneticTexture: ctx.femViewportLayers.showMagneticTexture,
    showAirbox: ctx.airMeshVisible,
    showQuantity: ctx.femViewportLayers.showQuantity,
    showVectors: Boolean(ctx.meshShowArrows),
    renderMode: ctx.meshShowArrows ? "vectors" : "heatmap",
    ...slice2DToolbarPatch,
  }), [
    ctx.airMeshVisible,
    ctx.component,
    ctx.femViewportLayers,
    ctx.meshClipPos,
    ctx.meshClipAxis,
    ctx.meshShowArrows,
    ctx.previewGrid,
    ctx.requestedPreviewAllLayers,
    ctx.requestedPreviewAutoScale,
    ctx.requestedPreviewComponent,
    ctx.requestedPreviewQuantity,
    ctx.selectedQuantity,
    ctx.sliceIndex,
    effectiveSlicePlane,
    slice2DToolbarPatch,
  ]);

  const airboxParts = ctx.meshParts.filter((part) => part.role === "air" || part.role === "outer_boundary");
  const airboxRepresentativePart = airboxParts[0] ?? ctx.airPart;
  const airMeshRenderMode: ViewportMeshRenderMode | null = airboxRepresentativePart
    ? (ctx.meshEntityViewState[airboxRepresentativePart.id]?.renderMode
      ?? defaultMeshEntityViewState(airboxRepresentativePart).renderMode)
    : null;
  const airboxDisplayState = airboxRepresentativePart
    ? (() => {
        const modeDefaults = airboxDisplayStateFromRenderMode(airMeshRenderMode ?? "wireframe");
        const partDefaults = defaultMeshEntityViewState(airboxRepresentativePart);
        const current = ctx.meshEntityViewState[airboxRepresentativePart.id];
        return {
          ...modeDefaults,
          geometryVisible: current?.geometryVisible ?? true,
          wireframeScope: current?.wireframeScope ?? modeDefaults.wireframeScope ?? partDefaults.wireframeScope ?? "surface",
          pointsScope: current?.pointsScope ?? modeDefaults.pointsScope ?? partDefaults.pointsScope ?? "surface",
          vectorsScope: current?.vectorsScope ?? modeDefaults.vectorsScope ?? partDefaults.vectorsScope ?? "surface",
        };
      })()
    : airboxDisplayStateFromRenderMode("wireframe");
  const handleRibbonSlice2DToolbar = (patch: Partial<Slice2DToolbarState>) => {
    patchSlice2DToolbar(patch);
    if (patch.quantityId) {
      ctx.requestPreviewQuantity(patch.quantityId);
    }
    if (patch.component) {
      handleRibbonPreviewComponent(patch.component);
    }
    if (patch.axis) {
      const nextSliceAxis = resolveSliceAxisSelection({
        axis: patch.axis,
        syncClipAxis: Boolean(femDiscretization),
      });
      ctx.setPlane(nextSliceAxis.plane);
      if (nextSliceAxis.clipAxis) {
        ctx.setMeshClipAxis(nextSliceAxis.clipAxis);
      }
    }
    if (patch.mode) {
      void ctx.patchDisplay({ slice_mode: patch.mode === "all_layers" ? "all" : patch.mode });
    }
    if (typeof patch.layerIndex === "number") {
      ctx.setSliceIndex(patch.layerIndex);
      void ctx.patchDisplay({ slice_layer: patch.layerIndex });
      if (femDiscretization) {
        ctx.setMeshClipPos(
          positionPercentFromSliceIndex({
            grid: ctx.previewGrid,
            plane: effectiveSlicePlane,
            sliceIndex: patch.layerIndex,
          }),
        );
      }
    }
    if (typeof patch.positionPercent === "number") {
      const nextSliceIndex = sliceIndexFromPositionPercent({
        grid: ctx.previewGrid,
        plane: effectiveSlicePlane,
        positionPercent: patch.positionPercent,
      });
      ctx.setMeshClipPos(patch.positionPercent);
      ctx.setSliceIndex(nextSliceIndex);
      void ctx.patchDisplay({ slice_layer: nextSliceIndex });
    }
    if (patch.colormap) {
      handleRibbonPreviewColormap(patch.colormap);
    }
    if (typeof patch.autoContrast === "boolean") {
      handleRibbonPreviewAutoScale(patch.autoContrast);
    }
    if (typeof patch.showVectors === "boolean") {
      ctx.setMeshShowArrows(patch.showVectors);
      void ctx.patchDisplay({ vector_glyphs: patch.showVectors });
      if (!patch.showVectors && ctx.femViewportLayers.showMagneticTexture && !ctx.femViewportLayers.showQuantity) {
        ctx.requestPreviewQuantity("m");
      }
    }
    if (typeof patch.showPrimitives === "boolean") {
      ctx.setFemViewportLayers((previous) => ({ ...previous, showPrimitives: patch.showPrimitives ?? previous.showPrimitives }));
    }
    if (typeof patch.showMesh === "boolean") {
      ctx.setFemViewportLayers((previous) => ({ ...previous, showMesh: patch.showMesh ?? previous.showMesh }));
    }
    if (typeof patch.showAirbox === "boolean") {
      const nextVisible = patch.showAirbox;
      ctx.setAirMeshVisible(nextVisible);
      ctx.setMeshEntityViewState((previous) => {
        let changed = false;
        const next = { ...previous };
        for (const part of airboxParts) {
          const current = next[part.id] ?? defaultMeshEntityViewState(part);
          if (current.visible === nextVisible) {
            if (!next[part.id]) {
              next[part.id] = current;
              changed = true;
            }
            continue;
          }
          next[part.id] = { ...current, visible: nextVisible };
          changed = true;
        }
        return changed ? next : previous;
      });
    }
    if (typeof patch.showMagneticTexture === "boolean") {
      ctx.setFemViewportLayers((previous) => ({
        ...previous,
        showMagneticTexture: patch.showMagneticTexture ?? previous.showMagneticTexture,
        showQuantity: patch.showMagneticTexture ? false : previous.showQuantity,
      }));
      if (patch.showMagneticTexture) {
        ctx.requestPreviewQuantity("m");
      }
    }
    if (typeof patch.showQuantity === "boolean") {
      ctx.setFemViewportLayers((previous) => ({
        ...previous,
        showQuantity: patch.showQuantity ?? previous.showQuantity,
        showMagneticTexture: patch.showQuantity ? false : previous.showMagneticTexture,
      }));
    }
  };

  const handleRibbonFemArrowStyle = (patch: Partial<{
    colorMode: "orientation" | "x" | "y" | "z" | "magnitude" | "monochrome";
    monoColor: string;
    alpha: number;
    lengthScale: number;
    thickness: number;
    domain: "auto" | "magnetic_only" | "full_domain" | "airbox_only";
    ferromagnetVisibility: "hide" | "ghost";
  }>) => {
    if (patch.colorMode) ctx.setFemArrowColorMode(patch.colorMode);
    if (patch.monoColor) ctx.setFemArrowMonoColor(patch.monoColor);
    if (typeof patch.alpha === "number") ctx.setFemArrowAlpha(patch.alpha);
    if (typeof patch.lengthScale === "number") ctx.setFemArrowLengthScale(patch.lengthScale);
    if (typeof patch.thickness === "number") ctx.setFemArrowThickness(patch.thickness);
    if (patch.domain) ctx.setFemVectorDomainFilter(patch.domain);
    if (patch.ferromagnetVisibility) ctx.setFemFerromagnetVisibilityMode(patch.ferromagnetVisibility);
  };

  const airboxVectorDomainRef = useRef<{
    active: boolean;
    vectorDomainFilter: "auto" | "magnetic_only" | "full_domain" | "airbox_only";
    ferromagnetVisibilityMode: "hide" | "ghost";
  } | null>(null);

  const handleRibbonAirboxDisplay = (patch: AirboxDisplayPatch) => {
    if (typeof patch.vectors === "boolean") {
      ctx.setMeshShowArrows(patch.vectors);
      if (patch.vectors) {
        ctx.setAirMeshVisible(true);
        if (!airboxVectorDomainRef.current?.active) {
          airboxVectorDomainRef.current = {
            active: true,
            vectorDomainFilter: ctx.femVectorDomainFilter,
            ferromagnetVisibilityMode: ctx.femFerromagnetVisibilityMode,
          };
        }
        ctx.setFemVectorDomainFilter("airbox_only");
        if (ctx.femFerromagnetVisibilityMode === "hide") {
          ctx.setFemFerromagnetVisibilityMode("ghost");
        }
      } else if (airboxVectorDomainRef.current?.active) {
        const saved = airboxVectorDomainRef.current;
        ctx.setFemVectorDomainFilter(saved.vectorDomainFilter);
        ctx.setFemFerromagnetVisibilityMode(saved.ferromagnetVisibilityMode);
        airboxVectorDomainRef.current = null;
      } else {
        ctx.setFemVectorDomainFilter("auto");
      }
    }
    if (typeof patch.opacity === "number") {
      ctx.setAirMeshOpacity(patch.opacity);
    }
    const updatesRender =
      typeof patch.visible === "boolean" ||
      typeof patch.geometry === "boolean" ||
      typeof patch.opacity === "number" ||
      typeof patch.shaded === "boolean" ||
      typeof patch.wireframe === "boolean" ||
      typeof patch.points === "boolean" ||
      typeof patch.wireframeScope === "string" ||
      typeof patch.pointsScope === "string" ||
      typeof patch.vectorsScope === "string" ||
      typeof patch.renderMode === "string";
    if (!updatesRender || airboxParts.length === 0) {
      return;
    }
    if (typeof patch.visible === "boolean") {
      ctx.setAirMeshVisible(patch.visible);
    }
    ctx.setMeshEntityViewState((previous) => {
      let changed = false;
      const next = { ...previous };
      const representativePart =
        airboxParts.find((part) => part.role === "air") ?? airboxParts[0];
      const representativeCurrent =
        next[representativePart.id] ?? defaultMeshEntityViewState(representativePart);
      const representativeModeDefaults = airboxDisplayStateFromRenderMode(
        representativeCurrent.renderMode,
      );
      const sharedCurrentDisplay = {
        ...representativeModeDefaults,
        geometryVisible: representativeCurrent.geometryVisible ?? true,
        wireframeScope:
          representativeCurrent.wireframeScope ??
          representativeModeDefaults.wireframeScope,
        pointsScope:
          representativeCurrent.pointsScope ??
          representativeModeDefaults.pointsScope,
        vectorsScope:
          representativeCurrent.vectorsScope ??
          representativeModeDefaults.vectorsScope,
      };
      for (const part of airboxParts) {
        const current = next[part.id] ?? defaultMeshEntityViewState(part);
        const nextDisplay = resolveAirboxDisplayState(sharedCurrentDisplay, patch);
        const nextVisible = typeof patch.visible === "boolean"
          ? patch.visible
          : current.visible;
        const nextOpacity = typeof patch.opacity === "number" ? patch.opacity : current.opacity;
        if (
          current.visible === nextVisible &&
          (current.geometryVisible ?? true) === nextDisplay.geometryVisible &&
          current.renderMode === nextDisplay.renderMode &&
          current.opacity === nextOpacity &&
          (current.wireframeScope ?? "surface") === nextDisplay.wireframeScope &&
          (current.pointsScope ?? "surface") === nextDisplay.pointsScope &&
          (current.vectorsScope ?? "surface") === nextDisplay.vectorsScope
        ) {
          if (!next[part.id]) {
            next[part.id] = current;
            changed = true;
          }
          continue;
        }
        next[part.id] = {
          ...current,
          visible: nextVisible,
          geometryVisible: nextDisplay.geometryVisible,
          renderMode: nextDisplay.renderMode,
          wireframeScope: nextDisplay.wireframeScope,
          pointsScope: nextDisplay.pointsScope,
          vectorsScope: nextDisplay.vectorsScope,
          opacity: nextOpacity,
        };
        changed = true;
      }
      return changed ? next : previous;
    });
  };

  const selectedObjectPartIds = ctx.selectedObjectId
    ? ctx.meshParts
        .filter((part) => part.object_id === ctx.selectedObjectId || part.geometry_id === ctx.selectedObjectId)
        .map((part) => part.id)
    : [];
  const selectedObjectRepresentativePart = selectedObjectPartIds[0]
    ? ctx.meshParts.find((part) => part.id === selectedObjectPartIds[0]) ?? null
    : null;
  const selectedObjectOpacity = selectedObjectRepresentativePart
    ? (ctx.meshEntityViewState[selectedObjectRepresentativePart.id]?.opacity
      ?? defaultMeshEntityViewState(selectedObjectRepresentativePart).opacity)
    : null;
  const selectedObjectRenderMode = selectedObjectRepresentativePart
    ? (selectedObjectPartIds.some((partId) => ctx.meshEntityViewState[partId]?.renderMode !== undefined)
      ? (ctx.meshEntityViewState[selectedObjectRepresentativePart.id]?.renderMode ?? null)
      : "inherit")
    : null;
  const selectedObjectTextureVisible = selectedObjectRepresentativePart
    ? ((ctx.meshEntityViewState[selectedObjectRepresentativePart.id]?.colorField
      ?? defaultMeshEntityViewState(selectedObjectRepresentativePart).colorField) !== "none")
    : null;
  const handleRibbonSelectedObjectOpacity = (opacity: number) => {
    if (selectedObjectPartIds.length === 0) return;
    ctx.setMeshEntityViewState((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const partId of selectedObjectPartIds) {
        const part = ctx.meshParts.find((entry) => entry.id === partId);
        if (!part) continue;
        const current = next[partId] ?? defaultMeshEntityViewState(part);
        if (current.opacity === opacity) continue;
        next[partId] = { ...current, opacity };
        changed = true;
      }
      return changed ? next : previous;
    });
  };
  const handleRibbonSelectedObjectRenderMode = useCallback(
    (mode: ViewportMeshRenderMode | "inherit") => {
      if (mode === "inherit") {
        if (selectedObjectPartIds.length === 0) return;
        ctx.setMeshEntityViewState((previous) => {
          let changed = false;
          const next = { ...previous };
          for (const partId of selectedObjectPartIds) {
            if (!(partId in next)) continue;
            delete next[partId];
            changed = true;
          }
          return changed ? next : previous;
        });
        return;
      }
      const nextMode = mode;
      if (selectedObjectPartIds.length === 0) return;
      ctx.setMeshEntityViewState((previous) => {
        let changed = false;
        const next = { ...previous };
        for (const partId of selectedObjectPartIds) {
          const part = ctx.meshParts.find((entry) => entry.id === partId);
          if (!part) continue;
          const current = next[partId] ?? defaultMeshEntityViewState(part);
          if (current.renderMode === nextMode) continue;
          next[partId] = { ...current, renderMode: nextMode };
          changed = true;
        }
        return changed ? next : previous;
      });
    },
    [ctx.meshParts, ctx.setMeshEntityViewState, selectedObjectPartIds],
  );
  const handleRibbonSelectedObjectTextureVisible = useCallback(
    (visible: boolean) => {
      if (selectedObjectPartIds.length === 0) return;
      ctx.setMeshEntityViewState((previous) => {
        let changed = false;
        const next = { ...previous };
        for (const partId of selectedObjectPartIds) {
          const part = ctx.meshParts.find((entry) => entry.id === partId);
          if (!part || part.role !== "magnetic_object") continue;
          const current = next[partId] ?? defaultMeshEntityViewState(part);
          const nextColorField = visible ? "orientation" : "none";
          if (current.colorField === nextColorField) continue;
          next[partId] = { ...current, colorField: nextColorField };
          changed = true;
        }
        return changed ? next : previous;
      });
    },
    [ctx.meshParts, ctx.setMeshEntityViewState, selectedObjectPartIds],
  );
  const handleRibbonClearSelectedDisplayOverrides = useCallback(() => {
    if (selectedObjectPartIds.length === 0) return;
    ctx.setMeshEntityViewState((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const partId of selectedObjectPartIds) {
        if (!(partId in next)) continue;
        delete next[partId];
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [ctx.setMeshEntityViewState, selectedObjectPartIds]);

  const handleRibbonMeshRenderMode = useCallback((nextMode: ViewportMeshRenderMode) => {
    ctx.setMeshRenderMode(nextMode);
    const nonAirParts = ctx.meshParts.filter(
      (part) => part.role !== "air" && part.role !== "outer_boundary",
    );
    if (nonAirParts.length === 0) return;
    ctx.setMeshEntityViewState((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const part of nonAirParts) {
        const current = next[part.id] ?? defaultMeshEntityViewState(part);
        if (current.renderMode === nextMode) continue;
        next[part.id] = { ...current, renderMode: nextMode };
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [ctx.meshParts, ctx.setMeshEntityViewState, ctx.setMeshRenderMode]);

  /* ── Loading state ── */
  if (!ctx.session) {
    if (hasNoActiveWorkspace) {
      return (
        <div className="relative flex h-full min-h-screen flex-col items-center justify-center overflow-hidden bg-background p-8 text-center text-sm text-muted-foreground">
          <div className="pointer-events-none absolute left-1/2 top-1/2 h-[40vw] max-h-[500px] w-[40vw] max-w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/5 blur-[100px]" />

          <div className="relative z-10 flex w-full max-w-md flex-col items-center gap-6 rounded-md border border-border/60 bg-card/70 p-8 shadow-sm">
            <div className="flex h-16 w-16 items-center justify-center rounded-md border border-border/70 bg-background/70">
              <FullmagLogo size={52} className="drop-shadow-[0_0_16px_rgba(137,180,250,0.35)]" />
            </div>
            <div className="flex flex-col items-center gap-2">
              <h1 className="text-lg font-semibold text-foreground">No active workspace</h1>
              <p className="max-w-sm leading-6 text-muted-foreground">
                Start or open a simulation from the launcher before entering the control room.
              </p>
            </div>
            <button
              type="button"
              onClick={() => router.push("/")}
              className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
            >
              Open launcher
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="flex h-full flex-col items-center justify-center overflow-hidden bg-background p-8 text-sm text-muted-foreground relative">
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-[40vw] max-h-[500px] w-[40vw] max-w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/5 blur-[100px]" />

        <div className="relative z-10 flex w-full max-w-sm flex-col items-center gap-8">
          <div className="relative flex h-20 w-28 items-center justify-center">
            <div className="absolute inset-0 rounded-2xl border border-primary/20 bg-card/40 shadow-2xl backdrop-blur-xl" />
            <FullmagLogo size={96} animate className="relative z-10 drop-shadow-[0_0_20px_rgba(137,180,250,0.4)]" />
          </div>

          <div className="flex flex-col items-center gap-3 text-center">
            <span className="flex items-center gap-3">
              <span className="h-5 w-5 animate-spin rounded-full border-[3px] border-primary/20 border-t-primary" />
              <span className="text-xs font-bold uppercase tracking-[0.2em] text-primary/90">
                {ctx.error ? "Connection Error" : "Initializing Workspace"}
              </span>
            </span>
            <span className="text-xs font-medium text-muted-foreground/70">
              {ctx.error ? ctx.error : "Connecting to local Fullmag session..."}
            </span>
          </div>
        </div>
      </div>
    );
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
        runtimeStatus={ctx.workspaceStatus as "idle" | "running" | "paused" | "failed" | "awaiting_command"}
        canRun={ctx.canRunCommand && !builderRunBlocked}
        canPause={ctx.canPauseCommand}
        canStop={ctx.canStopCommand}
        canSkip={ctx.canSkipCommand}
        runDisabledReason={solverControlDisabledReasons.run}
        pauseDisabledReason={solverControlDisabledReasons.pause}
        stopDisabledReason={solverControlDisabledReasons.stop}
        skipDisabledReason={solverControlDisabledReasons.skip}
        onRun={() => ctx.handleSimulationAction(ctx.primaryRunAction)}
        onPause={() => ctx.handleSimulationAction("pause")}
        onStop={() => ctx.handleSimulationAction("stop")}
        onSkip={() => ctx.handleSimulationAction("skip")}
      />
      {FRONTEND_DIAGNOSTIC_FLAGS.shell.showRibbonBar ? <RibbonBar
        workspaceMode={ctx.workspaceStage}
        viewMode={ctx.effectiveViewMode}
        femDiscretization={femDiscretization}
        domainCapabilities={ctx.domainCapabilities}
        solverRunning={ctx.workspaceStatus === "running"}
        sidebarVisible={!ctx.sidebarCollapsed}
        selectedNodeId={ctx.selectedSidebarNodeId}
        canRun={ctx.canRunCommand && !builderRunBlocked}
        canRelax={ctx.canRelaxCommand && !builderRunBlocked}
        canPause={ctx.canPauseCommand}
        canStop={ctx.canStopCommand}
        canSkip={ctx.canSkipCommand}
        runDisabledReason={solverControlDisabledReasons.run}
        pauseDisabledReason={solverControlDisabledReasons.pause}
        stopDisabledReason={solverControlDisabledReasons.stop}
        skipDisabledReason={solverControlDisabledReasons.skip}
        runAction={ctx.primaryRunAction}
        runLabel={ctx.primaryRunLabel}
        viewport3DStatus={viewport3DStatus.status}
        viewport3DStatusReason={viewport3DStatus.reason}
        viewport3DStatusDetail={viewport3DStatus.detail}
        onViewChange={ctx.handleViewModeChange}
        onSidebarToggle={() => ctx.setSidebarCollapsed((v) => !v)}
        onCreateVisualizationPreset={handleCreateVisualizationPreset}
        airboxVisible={ctx.airMeshVisible}
        viewportAxesScope={ctx.viewportAxesScope}
        universeWireframeVisible={ctx.universeWireframeVisible}
        viewportLegendVisible={ctx.viewportLegendVisible}
        onToggleAirbox={() => ctx.setAirMeshVisible((visible) => !visible)}
        onSetViewportAxesScope={ctx.setViewportAxesScope}
        onToggleUniverseWireframe={() => ctx.setUniverseWireframeVisible((visible) => !visible)}
        onToggleViewportLegend={() => ctx.setViewportLegendVisible((visible) => !visible)}
        onSimAction={ctx.handleSimulationAction}
        quickPreviewTargets={ctx.quickPreviewTargets}
        selectedQuantity={ctx.requestedPreviewQuantity}
        requestedPreviewComponent={ctx.requestedPreviewComponent}
        requestedPreviewEveryN={ctx.requestedPreviewEveryN}
        requestedPreviewMaxPoints={ctx.requestedPreviewMaxPoints}
        requestedPreviewAutoScale={ctx.requestedPreviewAutoScale}
        requestedPreviewQuantityDataStatus={ctx.requestedPreviewQuantityDataStatus}
        primitiveVisible={ctx.femViewportLayers.showPrimitives}
        magneticTextureVisible={ctx.femViewportLayers.showMagneticTexture}
        magneticTextureDensity={ctx.femTextureDownsampleCells}
        quantityShaderVisible={ctx.femViewportLayers.showQuantity}
        femVectorGlyphBudget={ctx.femVectorGlyphBudget}
        meshRenderMode={ctx.meshRenderMode}
        meshOpacity={ctx.meshOpacity}
        selectedObjectTextureVisible={selectedObjectTextureVisible}
        selectedObjectOpacity={selectedObjectOpacity}
        selectedObjectRenderMode={selectedObjectRenderMode}
        meshClipEnabled={ctx.meshClipEnabled}
        meshClipAxis={ctx.meshClipAxis}
        meshClipPos={ctx.meshClipPos}
        meshClipFlip={ctx.meshClipFlip}
        meshShowArrows={ctx.meshShowArrows}
        femArrowColorMode={ctx.femArrowColorMode}
        femArrowMonoColor={ctx.femArrowMonoColor}
        femArrowAlpha={ctx.femArrowAlpha}
        femArrowLengthScale={ctx.femArrowLengthScale}
        femArrowThickness={ctx.femArrowThickness}
        femVectorDomainFilter={ctx.femVectorDomainFilter}
        femFerromagnetVisibilityMode={ctx.femFerromagnetVisibilityMode}
        airMeshOpacity={ctx.airMeshOpacity}
        airMeshRenderMode={airMeshRenderMode}
        airMeshGeometryVisible={airboxDisplayState.geometryVisible}
        airMeshWireframeScope={airboxDisplayState.wireframeScope}
        airMeshPointsScope={airboxDisplayState.pointsScope}
        airMeshVectorsScope={airboxDisplayState.vectorsScope}
        slice2DEnabled={ctx.effectiveViewMode === "2D"}
        slice2DToolbar={slice2DToolbar}
        slice2DDiagnostics={null}
        previewPending={ctx.previewBusy}
        onQuickPreviewSelect={ctx.requestPreviewQuantity}
        onSetPreviewComponent={handleRibbonPreviewComponent}
        onSetPreviewEveryN={handleRibbonPreviewEveryN}
        onSetPreviewMaxPoints={handleRibbonPreviewMaxPoints}
        onSetFemVectorGlyphBudget={ctx.setFemVectorGlyphBudget}
        onSetPreviewColormap={handleRibbonPreviewColormap}
        onSetPreviewAutoScale={handleRibbonPreviewAutoScale}
        onSetPrimitiveVisible={(visible) =>
          ctx.setFemViewportLayers((previous) => ({
            ...previous,
            showPrimitives: visible,
          }))
        }
        onSetMagneticTextureVisible={(visible) => {
          ctx.setFemViewportLayers((previous) => ({
            ...previous,
            showMagneticTexture: visible,
            showQuantity: visible ? false : previous.showQuantity,
          }));
          if (visible) {
            ctx.requestPreviewQuantity("m");
          }
        }}
        onSetMagneticTextureDensity={ctx.setFemTextureDownsampleCells}
        onSetQuantityShaderVisible={(visible) =>
          ctx.setFemViewportLayers((previous) => ({
            ...previous,
            showQuantity: visible,
            showMagneticTexture: visible ? false : previous.showMagneticTexture,
          }))
        }
        onCapture={ctx.handleCapture}
        onExport={ctx.handleExport}
        onStateExport={() => void ctx.handleStateExport("compact")}
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
        onOpenMeshStatistics={handleOpenMeshStatistics}
        onOpenMeshQuality={handleOpenMeshQuality}
        onOpenMeshSizeSettings={handleOpenMeshSize}
        onOpenMeshTransitionSettings={handleOpenMeshTransition}
        onOpenMeshMethodSettings={handleOpenMeshMethod}
        onOpenMeshOptimizationSettings={handleOpenMeshOptimization}
        onOpenMeshPipeline={handleOpenMeshPipeline}
        selectedObjectId={ctx.selectedObjectId}
        objectViewMode={ctx.objectViewMode}
        sceneObjectCount={ctx.sceneDocument?.objects.length ?? 0}
        onRequestObjectFocus={ctx.requestFocusObject}
        onSetObjectViewMode={ctx.setObjectViewMode}
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
        activeTransformScope={ctx.activeTransformScope}
        onSetTransformScope={handleSetTransformScope}
        onSetMeshRenderMode={handleRibbonMeshRenderMode}
        onSetMeshOpacity={ctx.setMeshOpacity}
        onSetSelectedObjectTextureVisible={handleRibbonSelectedObjectTextureVisible}
        onSetSelectedObjectOpacity={handleRibbonSelectedObjectOpacity}
        onSetSelectedObjectRenderMode={handleRibbonSelectedObjectRenderMode}
        onClearSelectedDisplayOverrides={handleRibbonClearSelectedDisplayOverrides}
        onSetMeshClipEnabled={ctx.setMeshClipEnabled}
        onSetMeshClipAxis={ctx.setMeshClipAxis}
        onSetMeshClipPos={ctx.setMeshClipPos}
        onSetMeshClipFlip={ctx.setMeshClipFlip}
        onSetMeshShowArrows={ctx.setMeshShowArrows}
        onSetFemArrowStyle={handleRibbonFemArrowStyle}
        onSetAirboxDisplay={handleRibbonAirboxDisplay}
        onSetSlice2DToolbar={handleRibbonSlice2DToolbar}
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
          leftCollapsed={ctx.sidebarCollapsed}
          leftPanel={<RunSidebar />}
          center={
            <>
              {FRONTEND_DIAGNOSTIC_FLAGS.shell.showViewportBar ? <ViewportBar /> : null}
              {FRONTEND_DIAGNOSTIC_FLAGS.shell.showPreviewNotices ? previewNotices : null}
              <ViewportTabBar />
              <ViewportCanvasArea onViewportHealthChange={handleViewportHealthChange} />
            </>
          }
          rightOpen={rightInspectorOpen}
          rightPanel={
            ctx.effectiveViewMode === "Analyze" || activeCoreTab === "Results" ? (
              <AnalyzeRightInspector />
            ) : builderModeEnabled || activeCoreTab === "Geometry" ? (
              <BuildRightInspector />
            ) : (
              <StudyRightInspector />
            )
          }
          rightDefaultSize={rightInspectorDefaultSize}
          rightMinSize={rightInspectorMinSize}
          rightMaxSize={rightInspectorMaxSize}
        />
      )}

      {FRONTEND_DIAGNOSTIC_FLAGS.shell.showStatusBar ? <StatusBar
        connection={ctx.connection}
        step={ctx.effectiveLiveState?.step ?? ctx.run?.total_steps ?? 0}
        stepDisplay={fmtStepValue(ctx.effectiveLiveState?.step ?? ctx.run?.total_steps ?? 0, ctx.hasSolverTelemetry)}
        simTime={fmtSIOrDash(ctx.effectiveLiveState?.time ?? ctx.run?.final_time ?? 0, "s", ctx.hasSolverTelemetry)}
        wallTime={elapsed > 0 ? fmtDuration(elapsed) : "—"}
        throughput={stepsPerSec > 0 ? `${stepsPerSec.toFixed(1)} st/s` : "—"}
        backend={ctx.session?.requested_backend ?? ""}
        runtimeEngine={ctx.runtimeEngineLabel ?? undefined}
        runtimeGpuLabel={ctx.runtimeEngineGpuLabel ?? undefined}
        precision={ctx.session?.precision ?? ""}
        requestedCpuThreads={ctx.session?.requested_cpu_threads ?? ctx.requestedRuntimeSelection.requested_cpu_threads ?? null}
        resolvedCpuThreads={ctx.session?.resolved_cpu_threads ?? null}
        requestedFemOmpThreads={femCpuThreadSummary?.requestedOmpThreads ?? null}
        effectiveFemOmpThreads={femCpuThreadSummary?.effectiveOmpThreads ?? null}
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
        hasSolverTelemetry={ctx.hasSolverTelemetry}
        solverDt={ctx.effectiveDt}
        solverMinDt={commandMinDt}
        solverMaxDt={commandMaxDt}
        solverFixedDt={commandFixedDt}
        solverIntegrator={commandSolverIntegrators}
        nodeCount={femDiscretization && ctx.femMesh
          ? `${ctx.femMesh.nodes.length.toLocaleString()} nodes`
          : ctx.totalCells && ctx.totalCells > 0
            ? `${ctx.totalCells.toLocaleString()} cells`
            : undefined}
      /> : null}

      {/* FE-005: Data-plane status badges (production-safe, compact) */}
      {FRONTEND_DIAGNOSTIC_FLAGS.shell.showStatusBar ? <DataPlaneStatusBadges /> : null}

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
