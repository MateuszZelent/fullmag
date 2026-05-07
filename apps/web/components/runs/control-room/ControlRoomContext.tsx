"use client";

import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useShallow } from "zustand/react/shallow";
import type { VisualizationStateResource } from "@/src/api/types";
import { createControlRoomApi } from "./controlRoomApi";
import { useSceneDocument } from "@/src/hooks/resources/useSceneDocument";
import { useStageExecution } from "@/src/hooks/resources/useStageExecution";
import { useMeshWorkspaceResourceState } from "@/src/hooks/resources/useMeshResources";
import { useWorkspaceSelection } from "@/src/hooks/resources/useWorkspaceSelection";
import { useVisualizationStateResource } from "@/src/hooks/resources/useVisualizationStateResource";
import { useSessionRuntimeBridgeRouter } from "../../../features/session-runtime/hooks/useSessionRuntimeBridgeRouter";
import { useSessionRuntimeStore } from "../../../features/session-runtime/store/useSessionRuntimeStore";
import {
  useFdmVisualizationSettings,
  useViewportRenderState,
} from "../../../features/visualization/hooks/useVizSlice";
import { useVisualizationStore, selectEffectiveViewportVizState } from "../../../features/visualization/store/useVisualizationStore";
import { useSelectionStore } from "../../../features/selection/store/useSelectionStore";
import {
  selectLastBuiltMeshConfigSignature,
  selectMeshGenerating,
  selectMeshOptionsState,
  selectMeshSelection,
  useMeshConfigStore,
} from "../../../features/mesh-config/store/useMeshConfigStore";
import {
  selectModelBuilderGraph,
  selectMeshPerGeometryPayload,
  selectRemoteSceneDocument,
  selectSceneDocumentDraft,
  selectSceneObjects,
  selectScriptBuilderCurrentModules,
  selectScriptBuilderDemagRealization,
  selectScriptBuilderExcitationAnalysis,
  selectScriptBuilderGeometries,
  selectScriptBuilderUniverse,
  selectSolverPlan,
  selectSolverSettings,
  selectStudyPipeline,
  selectStudyStages,
  useDocumentStore,
} from "../../../features/document/store/useDocumentStore";
import {
  selectCommandErrorMessage,
  selectCommandPostInFlight,
  selectPreviewMessage,
  selectPreviewPostInFlight,
  selectRunUntilInput,
  selectScriptSyncBusy,
  selectScriptSyncMessage,
  selectStateIoBusy,
  selectStateIoMessage,
  useCommandStore,
} from "../../../features/command/store/useCommandStore";
import {
  DEFAULT_FEM_VIEWPORT_LAYER_STATE,
  type FemViewportLayerState,
} from "@/features/viewport-unified/model/unifiedViewportTypes";
import { useWorkspaceStore } from "../../../lib/workspace/workspace-store";
import { useBuilderAutoSync } from "./hooks/useBuilderAutoSync";
import { useDomainLayout } from "./hooks/useDomainLayout";
import { useFemMeshDerived } from "./hooks/useFemMeshDerived";
import { useMeshCommandPipeline } from "./hooks/useMeshCommandPipeline";
import { useVisualizationPresets } from "./hooks/useVisualizationPresets";
import { useWorkspaceActions } from "./hooks/useWorkspaceActions";
import { useSessionHydration } from "../../../features/session-orchestrator/hooks/useSessionHydration";
import {
  DEFAULT_AIR_MESH_OPACITY,
  DEFAULT_FDM_VISUALIZATION_SETTINGS,
  EMPTY_ARTIFACTS,
  EMPTY_ENGINE_LOG,
  EMPTY_QUANTITIES,
  EMPTY_SCALAR_ROWS,
  loadLocalActiveVisualizationRef,
  loadLocalVisualizationPresets,
} from "./controlRoomUtils";
import { scalarRowsTipFingerprint } from "@/lib/plots/scalarRows";
import type {
  DisplaySelection,
  EngineLogEntry,
  FemLiveMesh,
  MeshWorkspaceState,
  ScriptBuilderStageState,
} from "@/lib/session/types";
import type {
  MeshEntityViewStateMap,
  ModelBuilderGraphV2,
  SceneDocument,
  VisualizationPreset,
  VisualizationPresetFdmState,
  VisualizationPresetRef,
  ScriptBuilderCurrentModuleEntry,
  ScriptBuilderExcitationAnalysisEntry,
  ScriptBuilderGeometryEntry,
  ScriptBuilderUniverseState,
  StudyPipelineDocumentState,
} from "../../../lib/session/types";
import { serializeModelBuilderGraphV2 } from "../../../lib/session/modelBuilderGraph";
import {
  buildSceneDocumentFromScriptBuilder,
} from "../../../lib/session/sceneDocument";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import {
  isFemDiscretization,
} from "@/src/domain/capabilities";
import type { SolverSettingsState } from "../../panels/SolverSettingsPanel";
import type { MeshQualityData } from "@/lib/mesh/options";
import type {
  ClipAxis,
  FemMeshData,
  RenderMode,
} from "@/components/preview/FemMeshView3D";
import {
  type FemDockTab,
  type FocusObjectRequest,
  type ObjectViewMode,
  type SlicePlane,
  type VectorComponent,
  type ViewportScope,
  type ViewportMode,
  resolveSelectedObjectId,
  resolveViewportScope,
} from "./shared";
import {
  buildScriptBuilderSignature,
  buildScriptBuilderUpdatePayload,
  extractSolverPlan,
  meshOptionsToBuilder,
  solverSettingsToBuilder,
} from "./helpers";
import {
  buildMeshConfigurationSignature,
} from "./meshWorkspace";
import {
  resolveViewportSelectionScope,
} from "../../../features/viewport-fem/model/femViewportSelection";
import {
  buildViewportDisplayReset,
  visualizationPatchForViewportDisplayDefaults,
  type ViewportDisplayDefaults,
} from "../../../features/viewport-fem/model/femResetCommand";

import {
  DEFAULT_ANALYZE_SELECTION,
} from "./analyzeSelection";
import type { VisibleSubmeshSnapshot } from "./submeshSnapshot";
import { resetSceneEditorToCameraFirst } from "./workspaceViewportGuards";
import {
  projectResolvedRenderPlanToViewportState,
  resolveRenderPlanFromVisualizationState,
  type ViewportVisualizationState,
} from "./visualizationStateSync";
import {
  resolvePersistedWorkspaceSelection,
  resolveRemoteWorkspaceSelectionHydration,
  workspaceSelectionIdentity,
} from "./workspaceSelectionGuards";
import { ControlRoomContextProviders } from "./ControlRoomContextProviders";
import { ControlRoomConnectingState } from "./ControlRoomConnectingState";
import {
  fieldFrameIdentity,
  isQuantitySelectable,
  vectorHead,
} from "./controlRoomContextHelpers";
import {
  planeFromSliceAxis,
  sliceIndexFromPositionPercent,
} from "@/src/features/slice2d/axisMapping";

/* Context interfaces, hooks, and React context objects are in context-hooks.tsx */
export {
  useTransport,
  useViewport,
  useCommand,
  useModel,
  TransportCtx,
  ViewportCtx,
  CommandCtx,
  ModelCtx,
} from "./context-hooks";
export type {
  TransportContextValue,
  ViewportContextValue,
  CommandContextValue,
  ModelContextValue,
  WorkspaceStage,
  WorkspaceMode,
  ResultWorkspaceEntry,
  ResultWorkspaceKind,
  QuantityDataStatus,
} from "./context-hooks";
import { useModelBuilderActions } from "./hooks/useModelBuilderActions";
import { useAnalyzeWorkspaceState } from "./hooks/useAnalyzeWorkspaceState";
import { useAutoResultWorkspaceEntries } from "./hooks/useAutoResultWorkspaceEntries";
import { useEffectiveLiveTelemetry } from "./hooks/useEffectiveLiveTelemetry";
import { useFemMeshTopologyHydration } from "./hooks/useFemMeshTopologyHydration";
import { useGpuTelemetry } from "./hooks/useGpuTelemetry";
import { usePreviewSelectionState } from "./hooks/usePreviewSelectionState";
import { useQuantityPresentationState } from "./hooks/useQuantityPresentationState";
import { useSceneEditorDraftSync } from "./hooks/useSceneEditorDraftSync";
import { useVisualizationPresetPersistence } from "./hooks/useVisualizationPresetPersistence";
import { useViewportFieldData } from "./hooks/useViewportFieldData";
import { useWorkspaceSelectionPersistence } from "./hooks/useWorkspaceSelectionPersistence";
import {
  resolveViewportSelectedObjectId,
} from "./viewportSelection";
import type {
  TransportContextValue,
  ViewportContextValue,
  CommandContextValue,
  ModelContextValue,
  WorkspaceStage,
  WorkspaceMode,
} from "./context-hooks";

const ENABLE_VIEWPORT_DATA_DEBUG_LOGS =
  FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging &&
  FRONTEND_DIAGNOSTIC_FLAGS.interactions.trace &&
  typeof process !== "undefined" &&
  process.env.NODE_ENV !== "production";


/* ── Provider ── */
export function ControlRoomProvider({ children }: { children: ReactNode }) {
  const liveApi = useMemo(() => createControlRoomApi(), []);
  const runtimeConnection = useSessionRuntimeStore((s) => s.connection);
  const runtimeConnectionError = useSessionRuntimeStore((s) => s.error);
  const runtimeDomainCapabilities = useSessionRuntimeStore((s) => s.domainCapabilities);
  const runtimeSession = useSessionRuntimeStore((s) => s.session);
  const runtimeRun = useSessionRuntimeStore((s) => s.run);
  const runtimeMetadata = useSessionRuntimeStore((s) => s.metadata);
  const runtimeLiveState = useSessionRuntimeStore((s) => s.liveState);
  const runtimePreview = useSessionRuntimeStore((s) => s.preview);
  const runtimeFemMesh = useSessionRuntimeStore((s) => s.femMesh);
  const runtimeScriptBuilder = useSessionRuntimeStore((s) => s.scriptBuilder);
  const runtimeRuntimeStatus = useSessionRuntimeStore((s) => s.runtimeStatus);
  const runtimeCommandStatus = useSessionRuntimeStore((s) => s.commandStatus);
  const runtimeEngineLog = useSessionRuntimeStore((s) => s.engineLog);
  const runtimeScalarRows = useSessionRuntimeStore((s) => s.scalarRows);
  const runtimeQuantities = useSessionRuntimeStore((s) => s.quantities);
  const runtimeArtifacts = useSessionRuntimeStore((s) => s.artifacts);
  const runtimeResourceRevisions = useSessionRuntimeStore((s) => s.resourceRevisions);
  const runtimeDisplaySelection = useSessionRuntimeStore((s) => s.displaySelection);
  const runtimePreviewConfig = useSessionRuntimeStore((s) => s.previewConfig);
  const runtimeLatestFieldFrames = useSessionRuntimeStore((s) => s.latestFieldFrames);
  const runtimeLatestFieldGrid = useSessionRuntimeStore((s) => s.latestFieldGrid);
  const connection = runtimeConnection;
  const error = runtimeConnectionError;
  const refreshLiveState = useCallback(async () => {
    await liveApi.getStatus();
  }, [liveApi]);
  const visualizationStateRevision = runtimeResourceRevisions?.display_revision ?? null;
  const {
    state: visualizationStateResource,
  } = useVisualizationStateResource({
    enabled: Boolean(runtimeSession?.session_id),
    sessionKey: runtimeSession?.session_id ?? null,
    revision: visualizationStateRevision,
  });

  // Runtime bridge adapter: sync Control Room transport into session-runtime store.
  useSessionRuntimeBridgeRouter();

  /* ── Local UI state ── */
  const workspaceMode = useWorkspaceStore((s) => s.currentStage);
  const _setPerspective = useWorkspaceStore((s) => s.setCurrentStage);
  const workspaceTabs = useWorkspaceStore((s) => s.workspaceTabsByStage[s.currentStage]);
  const activeWorkspaceTabId = useWorkspaceStore(
    (s) => s.activeWorkspaceTabByStage[s.currentStage],
  );
  const openWorkspaceTab = useWorkspaceStore((s) => s.openTab);
  const activateWorkspaceTab = useWorkspaceStore((s) => s.activateTab);
  const closeWorkspaceTab = useWorkspaceStore((s) => s.closeTab);
  const pinWorkspaceTab = useWorkspaceStore((s) => s.pinTab);
  const syncWorkspaceTabsFromArtifacts = useWorkspaceStore((s) => s.syncTabsFromArtifacts);
  const setWorkspaceMode = useCallback(
    (v: WorkspaceMode | ((prev: WorkspaceMode) => WorkspaceMode)) => {
      _setPerspective(typeof v === "function" ? v(workspaceMode) : v);
    },
    [_setPerspective, workspaceMode],
  );
  const workspaceStage = workspaceMode === "build" ? "build" : "study";
  const setWorkspaceStage = useCallback(
    (v: WorkspaceStage | ((prev: WorkspaceStage) => WorkspaceStage)) => {
      _setPerspective(typeof v === "function" ? v(workspaceStage) : v);
    },
    [_setPerspective, workspaceStage],
  );
  const [viewMode, setViewMode] = useState<ViewportMode>("3D");
  const [component, setComponent] = useState<VectorComponent>("magnitude");
  const [plane, setPlane] = useState<SlicePlane>("xy");
  const [sliceIndex, setSliceIndex] = useState(0);
  const [selectedQuantity, setSelectedQuantity] = useState("m");
  const [consoleCollapsed, setConsoleCollapsed] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [femDockTab, setFemDockTab] = useState<FemDockTab>("mesh");
  // ── Viewport chrome: owned by useVisualizationStore (Phase 5.1) ──
  const viz = useViewportRenderState();
  const fdmVisualizationSettings = useFdmVisualizationSettings();
  const femViewportLayers = viz.femViewportLayers;
  const setFdmVisualizationSettings = useVisualizationStore(
    (s) => s.setFdmVisualizationSettings,
  );
  const runUntilInput = useCommandStore(selectRunUntilInput);
  const setRunUntilInput = useCommandStore((s) => s.setRunUntilInput);
  const selectedSidebarNodeId = useSelectionStore((s) => s.selectedSidebarNodeId);
  const selectedObjectId = useSelectionStore((s) => s.selectedObjectId);
  const selectedEntityId = useSelectionStore((s) => s.selectedEntityId);
  const focusedEntityId = useSelectionStore((s) => s.focusedEntityId);
  const viewportScope = useSelectionStore((s) => s.viewportScope);
  const focusObjectRequest = useSelectionStore((s) => s.focusObjectRequest);
  const setSelectedSidebarNodeId = useSelectionStore((s) => s.setSelectedSidebarNodeId);
  const setSelectedObjectId = useSelectionStore((s) => s.setSelectedObjectId);
  const setSelectedEntityId = useSelectionStore((s) => s.setSelectedEntityId);
  const setFocusedEntityId = useSelectionStore((s) => s.setFocusedEntityId);
  const setViewportScope = useSelectionStore((s) => s.setViewportScope);
  const setFocusObjectRequest = useSelectionStore((s) => s.setFocusObjectRequest);
  const {
    activeResultWorkspaceId,
    addResultWorkspaceEntry,
    analyzeSelection,
    openAnalyze,
    refreshAnalyze,
    resultWorkspaceEntries,
    selectAnalyzeMode,
    selectAnalyzeTab,
    setActiveResultWorkspaceId,
    setAnalyzeSelection,
    setResultWorkspaceEntries,
  } = useAnalyzeWorkspaceState({
    activateAnalyzeView: () => setViewMode("Analyze"),
  });
  const [cameraFitRequestSeed, setCameraFitRequestSeed] = useState(0);
  const requestViewportCameraFit = useCallback(() => {
    setCameraFitRequestSeed((seed) => seed + 1);
  }, []);
  const [objectViewMode, setObjectViewMode] = useState<ObjectViewMode>("context");
  const [activeTransformScope, setActiveTransformScope] = useState<"object" | "texture" | null>(null);
  const [meshEntityViewState, setMeshEntityViewState] = useState<MeshEntityViewStateMap>({});
  const [visibleSubmeshSnapshot, setVisibleSubmeshSnapshot] =
    useState<VisibleSubmeshSnapshot | null>(null);
  const commandPostInFlight = useCommandStore(selectCommandPostInFlight);
  const commandErrorMessage = useCommandStore(selectCommandErrorMessage);
  const scriptSyncBusy = useCommandStore(selectScriptSyncBusy);
  const scriptSyncMessage = useCommandStore(selectScriptSyncMessage);
  const stateIoBusy = useCommandStore(selectStateIoBusy);
  const stateIoMessage = useCommandStore(selectStateIoMessage);
  const previewPostInFlight = useCommandStore(selectPreviewPostInFlight);
  const previewMessage = useCommandStore(selectPreviewMessage);
  const setCommandPostInFlight = useCommandStore((s) => s.setCommandPostInFlight);
  const setCommandErrorMessage = useCommandStore((s) => s.setCommandErrorMessage);
  const setScriptSyncBusy = useCommandStore((s) => s.setScriptSyncBusy);
  const setScriptSyncMessage = useCommandStore((s) => s.setScriptSyncMessage);
  const setStateIoBusy = useCommandStore((s) => s.setStateIoBusy);
  const setStateIoMessage = useCommandStore((s) => s.setStateIoMessage);
  const setPreviewPostInFlight = useCommandStore((s) => s.setPreviewPostInFlight);
  const setPreviewMessage = useCommandStore((s) => s.setPreviewMessage);
  const [optimisticDisplaySelection, setOptimisticDisplaySelection] =
    useState<DisplaySelection | null>(null);
  const meshOptionsState = useMeshConfigStore(selectMeshOptionsState);
  const meshGenerating = useMeshConfigStore(selectMeshGenerating);
  const lastBuiltMeshConfigSignature = useMeshConfigStore(selectLastBuiltMeshConfigSignature);
  const setMeshOptionsState = useMeshConfigStore((s) => s.setMeshOptions);
  const setMeshGenerating = useMeshConfigStore((s) => s.setMeshGenerating);
  const setLastBuiltMeshConfigSignature = useMeshConfigStore(
    (s) => s.setLastBuiltMeshConfigSignature,
  );
  const [frontendTraceLog, setFrontendTraceLog] = useState<EngineLogEntry[]>([]);
  const femTopologyKeyRef = useRef<string | null>(null);
  const femMeshDataRef = useRef<FemMeshData | null>(null);
  const femFieldBuffersRef = useRef<{
    nNodes: number;
    x: Float64Array;
    y: Float64Array;
    z: Float64Array;
  } | null>(null);
  const meshConfigSignatureRef = useRef<string | null>(null);
  const pendingMeshConfigSignatureRef = useRef<string | null>(null);
  const lastLoggedCommandStatusRef = useRef<string | null>(null);
  const lastAppliedVisualizationPresetRef = useRef<string | null>(null);
  const solverSettingsState = useDocumentStore(selectSolverSettings);
  const solverPlan = useDocumentStore(selectSolverPlan);
  const modelBuilderGraph = useDocumentStore(selectModelBuilderGraph);
  const sceneDocumentDraft = useDocumentStore(selectSceneDocumentDraft);
  const remoteSceneDocument = useDocumentStore(selectRemoteSceneDocument);
  const sceneObjects = useDocumentStore(selectSceneObjects);
  const meshPerGeometryPayload = useDocumentStore(selectMeshPerGeometryPayload);
  const setSolverSettingsState = useDocumentStore((s) => s.setSolverSettings);
  const setSolverPlan = useDocumentStore((s) => s.setSolverPlan);
  const setModelBuilderGraph = useDocumentStore((s) => s.setModelBuilderGraph);
  const setSceneDocumentDraft = useDocumentStore((s) => s.setSceneDocumentDraft);
  const setRemoteSceneDocument = useDocumentStore((s) => s.setRemoteSceneDocument);
  const [localVisualizationPresets, setLocalVisualizationPresets] = useState<VisualizationPreset[]>(
    () => loadLocalVisualizationPresets(),
  );
  const [activeVisualizationPresetRef, setActiveVisualizationPresetRef] =
    useState<VisualizationPresetRef | null>(() => loadLocalActiveVisualizationRef());
  const meshSelection = useMeshConfigStore(selectMeshSelection);
  const setMeshSelection = useMeshConfigStore((s) => s.setMeshSelection);
  const stickyViewportObjectIdRef = useRef<string | null>(null);
  const lastFieldDataRevisionRef = useRef<string | null>(null);
  const fieldDataTimestampRef = useRef<number | null>(null);
  const previewGridRef = useRef<[number, number, number]>([1, 1, 1]);
  const applyVisualizationStateResource = useCallback((state: VisualizationStateResource) => {
    const plan = resolveRenderPlanFromVisualizationState(state, femViewportLayers);
    const nextPlane = planeFromSliceAxis(plan.slice.axis);
    const nextSliceIndex =
      typeof plan.slice.layerIndex === "number"
        ? Math.max(0, Math.trunc(plan.slice.layerIndex))
        : sliceIndexFromPositionPercent({
            grid: previewGridRef.current,
            plane: nextPlane,
            positionPercent: plan.slice.positionPercent,
          });

    setSelectedQuantity((previous) =>
      previous === plan.quantity.activeQuantityId
        ? previous
        : plan.quantity.activeQuantityId,
    );
    setComponent((previous) =>
      previous === plan.quantity.fieldComponent
        ? previous
        : plan.quantity.fieldComponent,
    );
    setPlane((previous) => (previous === nextPlane ? previous : nextPlane));
    setSliceIndex((previous) => (previous === nextSliceIndex ? previous : nextSliceIndex));
    useVisualizationStore
      .getState()
      .applyFromRenderPlan(
        projectResolvedRenderPlanToViewportState(plan, useVisualizationStore.getState()),
      );
  }, [femViewportLayers]);

  const resolvedRenderPlan = useMemo(
    () =>
      visualizationStateResource
        ? resolveRenderPlanFromVisualizationState(visualizationStateResource, femViewportLayers)
        : null,
    [femViewportLayers, visualizationStateResource],
  );

  // Push the render plan into the viz store so hooks can derive effective state.
  useEffect(() => {
    useVisualizationStore.getState().setResolvedRenderPlan(resolvedRenderPlan);
  }, [resolvedRenderPlan]);

  const effectiveViewportVisualizationState = useVisualizationStore(
    useShallow(selectEffectiveViewportVizState),
  );

  useEffect(() => {
    if (!visualizationStateResource) {
      return;
    }
    applyVisualizationStateResource(visualizationStateResource);
  }, [applyVisualizationStateResource, visualizationStateResource]);

  const activeWorkspaceTab = useMemo(
    () => workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId) ?? null,
    [activeWorkspaceTabId, workspaceTabs],
  );

  useEffect(() => {
    if (!activeWorkspaceTab) return;
    const payloadMode = activeWorkspaceTab.payload?.viewMode;
    const inferredMode: ViewportMode | null =
      payloadMode === "3D" || payloadMode === "2D" || payloadMode === "Mesh" || payloadMode === "Analyze"
        ? payloadMode === "Mesh"
          ? "3D"
          : payloadMode
        : activeWorkspaceTab.id === "core:3d"
          ? "3D"
          : activeWorkspaceTab.id === "core:2d"
            ? "2D"
            : activeWorkspaceTab.id === "core:mesh"
              ? "3D"
              : activeWorkspaceTab.id === "core:analyze"
                ? "Analyze"
                : null;
    if (!inferredMode || inferredMode === viewMode) return;
    if (inferredMode === "2D") {
      setComponent((prev) => (prev === "magnitude" ? "x" : prev));
    }
    setViewMode(inferredMode);
  }, [activeWorkspaceTab, viewMode]);

  /* ── Derived runtime state ── */
  const session = runtimeSession;
  const sceneResourceSessionKey =
    runtimeSession?.session_id ??
    session?.session_id ??
    null;
  const { document: resourceSceneDocument } = useSceneDocument({
    enabled: true,
    sessionKey: sceneResourceSessionKey,
    revision: runtimeResourceRevisions?.scene_revision ?? null,
  });
  const { stageExecution: resourceStageExecution } = useStageExecution({
    enabled: Boolean(
      sceneResourceSessionKey &&
        runtimeResourceRevisions?.stages_revision &&
        runtimeResourceRevisions.stages_revision > 0,
    ),
    sessionKey: sceneResourceSessionKey,
    revision: runtimeResourceRevisions?.stages_revision ?? null,
  });
  const {
    selection: workspaceSelection,
    loading: workspaceSelectionLoading,
    replaceSelection: replaceWorkspaceSelection,
  } = useWorkspaceSelection({
    enabled: true,
    sessionKey: sceneResourceSessionKey,
    revision: runtimeResourceRevisions?.workspace_revision ?? null,
  });
  const {
    meshWorkspace: resourceMeshWorkspace,
  } = useMeshWorkspaceResourceState({
    enabled: true,
    sessionKey: sceneResourceSessionKey,
    meshRevision: runtimeResourceRevisions?.mesh_revision ?? null,
    meshBuildRevision: runtimeResourceRevisions?.mesh_build_revision ?? null,
  });
  const workspaceSelectionHydratingRef = useRef(false);
  const lastPersistedWorkspaceSelectionRef = useRef<string | null>(null);
  const pendingWorkspaceSelectionIdentityRef = useRef<string | null>(null);
  const metadata = runtimeMetadata;
  const problemMeta =
    metadata?.problem_meta && typeof metadata.problem_meta === "object"
      ? (metadata.problem_meta as Record<string, unknown>)
      : null;
  const sourceHash =
    typeof metadata?.source_hash === "string"
      ? metadata.source_hash
      : (typeof problemMeta?.source_hash === "string" ? problemMeta.source_hash : null);
  const workspaceHydrationKey = session
    ? `${session.started_at_unix_ms}:${session.run_id}:${session.script_path}:${sourceHash ?? "no-source-hash"}`
    : null;
  const markPendingWorkspaceSelection = useCallback(
    (nextNodeId: string | null) => {
      const source = sceneDocumentDraft ?? modelBuilderGraph;
      let nextObjectId = resolveSelectedObjectId(nextNodeId, source);
      if (!nextObjectId && nextNodeId) {
        const objectNodePrefixes = ["physobj-", "geo-", "reg-", "mat-", "mag-", "obj-"];
        const matchedPrefix = objectNodePrefixes.find((prefix) => nextNodeId.startsWith(prefix));
        if (matchedPrefix) {
          const suffix = nextNodeId.slice(matchedPrefix.length);
          nextObjectId = matchedPrefix === "geo-" && suffix.endsWith("-mesh")
            ? suffix.slice(0, -"mesh".length - 1)
            : suffix.split("/")[0] || null;
        }
      }
      pendingWorkspaceSelectionIdentityRef.current = workspaceSelectionIdentity({
        selected_node_id: nextNodeId,
        selected_object_id: nextObjectId,
        selected_entity_id: nextObjectId ? null : selectedEntityId,
      });
    },
    [modelBuilderGraph, sceneDocumentDraft, selectedEntityId],
  );
  const setSelectedSidebarNodeIdFromUi = useCallback<Dispatch<SetStateAction<string | null>>>(
    (next) => {
      setSelectedSidebarNodeId((previous) => {
        const resolved = typeof next === "function" ? next(previous) : next;
        markPendingWorkspaceSelection(resolved);
        return resolved;
      });
    },
    [markPendingWorkspaceSelection],
  );
  const run = runtimeRun;
  const liveState = runtimeLiveState;
  const displaySelection = runtimeDisplaySelection;
  const previewConfig = runtimePreviewConfig;
  const preview = runtimePreview;
  const spatialPreview = preview?.kind === "spatial" ? preview : null;
  const globalScalarPreview = preview?.kind === "global_scalar" ? preview : null;
  const streamFemMesh = runtimeFemMesh ?? liveState?.fem_mesh ?? null;
  const femMesh = useFemMeshTopologyHydration({
    enabled: FRONTEND_DIAGNOSTIC_FLAGS.dataPlaneRollout.binaryFemTopologyTransport,
    liveApi,
    streamFemMesh,
  });
  useEffect(() => {
    setRemoteSceneDocument(resourceSceneDocument);
  }, [resourceSceneDocument, setRemoteSceneDocument]);
  const meshConfigSignature = useMemo(
    () => buildMeshConfigurationSignature(sceneDocumentDraft ?? remoteSceneDocument),
    [remoteSceneDocument, sceneDocumentDraft],
  );
  meshConfigSignatureRef.current = meshConfigSignature;
  const scriptBuilder = runtimeScriptBuilder;
  const remoteModelBuilderGraph = null as ModelBuilderGraphV2 | null;
  const scriptInitialState = scriptBuilder?.initial_state ?? null;
  const studyStages = useDocumentStore(selectStudyStages);
  const studyPipeline = useDocumentStore(selectStudyPipeline);
  const scriptBuilderDemagRealization = useDocumentStore(selectScriptBuilderDemagRealization);
  const scriptBuilderUniverse = useDocumentStore(selectScriptBuilderUniverse);
  const scriptBuilderGeometries = useDocumentStore(selectScriptBuilderGeometries);
  const scriptBuilderCurrentModules = useDocumentStore(selectScriptBuilderCurrentModules);
  const scriptBuilderExcitationAnalysis = useDocumentStore(
    selectScriptBuilderExcitationAnalysis,
  );
  const runtimeStatus = runtimeRuntimeStatus;
  const commandStatus = runtimeCommandStatus;
  const stageExecution = resourceStageExecution;
  const capabilities = null;
  // Reference-stable scalarRows: only changes ref when the history tip changes.
  // This prevents cascading useMemo invalidation on unrelated runtime ticks.
  const rawScalarRows = runtimeScalarRows.length > 0 ? runtimeScalarRows : EMPTY_SCALAR_ROWS;
  const stableScalarRowsRef = useRef(rawScalarRows);
  const scalarRowsFingerprintRef = useRef("");
  const scalarRowsFp = scalarRowsTipFingerprint(rawScalarRows);
  if (scalarRowsFp !== scalarRowsFingerprintRef.current) {
    scalarRowsFingerprintRef.current = scalarRowsFp;
    stableScalarRowsRef.current = rawScalarRows;
  }
  const scalarRows = stableScalarRowsRef.current;
  const scalarRowsTotal = scalarRows.length;
  const engineLog = runtimeEngineLog.length > 0 ? runtimeEngineLog : EMPTY_ENGINE_LOG;
  const quantities = runtimeQuantities.length > 0 ? runtimeQuantities : EMPTY_QUANTITIES;
  const artifactsArr = runtimeArtifacts.length > 0 ? runtimeArtifacts : EMPTY_ARTIFACTS;
  const meshWorkspace = resourceMeshWorkspace as MeshWorkspaceState | null;
  // Derive quality data from the session-carried summary (P1-1 fix).
  const meshQualityData = useMemo<MeshQualityData | null>(() => {
    const s = meshWorkspace?.mesh_quality_summary;
    if (!s) return null;
    return {
      nElements: s.n_elements,
      sicnMin: s.sicn_min,
      sicnMax: s.sicn_max,
      sicnMean: s.sicn_mean,
      sicnP5: s.sicn_p5,
      sicnHistogram: [],
      gammaMin: s.gamma_min,
      gammaMean: s.gamma_mean,
      gammaHistogram: [],
      volumeMin: 0,
      volumeMax: 0,
      volumeMean: 0,
      volumeStd: 0,
      avgQuality: s.avg_quality,
    };
  }, [meshWorkspace?.mesh_quality_summary]);
  const runtimeEngine = (metadata?.runtime_engine as Record<string, unknown> | undefined) ?? undefined;
  const runtimeEngineLabel = typeof runtimeEngine?.engine_label === "string" ? runtimeEngine.engine_label : null;
  const runtimeEngineAccelerator =
    typeof runtimeEngine?.accelerator === "string" ? runtimeEngine.accelerator : null;
  const runtimeEngineDeviceName =
    typeof runtimeEngine?.device_name === "string" ? runtimeEngine.device_name : null;
  const latestEngineMessage = engineLog.length > 0 ? engineLog[engineLog.length - 1]?.message ?? null : null;
  const workspaceStatus =
    runtimeStatus?.code ?? liveState?.status ?? session?.status ?? run?.status ?? "idle";
  const runtimeUsesGpu = runtimeEngineAccelerator === "gpu" || /gpu|cuda/i.test(runtimeEngineLabel ?? "");
  const gpuTelemetry = useGpuTelemetry({ liveApi, runtimeUsesGpu });

  useEffect(() => {
    syncWorkspaceTabsFromArtifacts(
      workspaceStage,
      artifactsArr.map((artifact) => artifact.path),
    );
  }, [artifactsArr, syncWorkspaceTabsFromArtifacts, workspaceStage]);

  const modelBuilderDefaults = useMemo(
    () => ({
      revision:
        remoteModelBuilderGraph?.revision ?? scriptBuilder?.revision ?? 0,
      solver: solverSettingsToBuilder(solverSettingsState),
      mesh: meshOptionsToBuilder(meshOptionsState),
      initialState: scriptInitialState,
    }),
    [
      meshOptionsState,
      remoteModelBuilderGraph?.revision,
      scriptBuilder?.revision,
      scriptInitialState,
      solverSettingsState,
    ],
  );

  useEffect(() => {
    setSelectedSidebarNodeId(null);
    setAnalyzeSelection(DEFAULT_ANALYZE_SELECTION);
    setResultWorkspaceEntries([]);
    setActiveResultWorkspaceId(null);
    setSelectedObjectId(null);
    setViewportScope("universe");
    setFocusObjectRequest(null);
    setObjectViewMode("context");
    setActiveTransformScope(null);
    useVisualizationStore.getState().patch({
      airMeshVisible: false,
      airMeshOpacity: DEFAULT_AIR_MESH_OPACITY,
      femArrowColorMode: "orientation",
      femArrowMonoColor: "#00c2ff",
      femArrowAlpha: 1,
      femArrowLengthScale: 1,
      femArrowThickness: 1,
    });
    setMeshEntityViewState({});
    setSelectedEntityId(null);
    setFocusedEntityId(null);
    setFdmVisualizationSettings(DEFAULT_FDM_VISUALIZATION_SETTINGS);
    setActiveVisualizationPresetRef(null);
    setSceneDocumentDraft((previousScene) =>
      resetSceneEditorToCameraFirst(previousScene),
    );
    lastAppliedVisualizationPresetRef.current = null;
    lastPersistedWorkspaceSelectionRef.current = null;
    pendingWorkspaceSelectionIdentityRef.current = null;
    workspaceSelectionHydratingRef.current = false;
  }, [workspaceHydrationKey]);

  useEffect(() => {
    if (!sceneResourceSessionKey) {
      lastPersistedWorkspaceSelectionRef.current = null;
      pendingWorkspaceSelectionIdentityRef.current = null;
      workspaceSelectionHydratingRef.current = false;
      return;
    }
    if (!workspaceSelection) {
      return;
    }
    const nextIdentity = workspaceSelectionIdentity(workspaceSelection);
    const currentIdentity = workspaceSelectionIdentity({
      selected_node_id: selectedSidebarNodeId,
      selected_object_id: selectedObjectId,
      selected_entity_id: selectedEntityId,
    });
    const decision = resolveRemoteWorkspaceSelectionHydration({
      remoteIdentity: nextIdentity,
      currentIdentity,
      pendingIdentity: pendingWorkspaceSelectionIdentityRef.current,
    });
    if (decision.kind === "confirm-pending") {
      lastPersistedWorkspaceSelectionRef.current = nextIdentity;
      pendingWorkspaceSelectionIdentityRef.current = null;
      return;
    }
    if (decision.kind === "noop") {
      lastPersistedWorkspaceSelectionRef.current = nextIdentity;
      return;
    }
    if (decision.kind === "reject-stale-pending") {
      if (ENABLE_VIEWPORT_DATA_DEBUG_LOGS) {
        console.debug("[ControlRoomContext] Ignoring stale workspace selection hydration", {
          currentIdentity,
          pendingIdentity: pendingWorkspaceSelectionIdentityRef.current,
          remoteIdentity: nextIdentity,
        });
      }
      return;
    }
    lastPersistedWorkspaceSelectionRef.current = nextIdentity;
    pendingWorkspaceSelectionIdentityRef.current = null;
    workspaceSelectionHydratingRef.current = true;
    setSelectedSidebarNodeId(workspaceSelection.selected_node_id ?? null);
    setSelectedObjectId(workspaceSelection.selected_object_id ?? null);
    setSelectedEntityId(workspaceSelection.selected_entity_id ?? null);
    queueMicrotask(() => {
      workspaceSelectionHydratingRef.current = false;
    });
  }, [
    sceneResourceSessionKey,
    selectedEntityId,
    selectedObjectId,
    selectedSidebarNodeId,
    workspaceSelection,
  ]);

  useEffect(() => {
    const scope = resolveViewportScope(
      selectedSidebarNodeId,
      sceneDocumentDraft ?? remoteSceneDocument ?? modelBuilderGraph,
    );
    if (scope) {
      setViewportScope(scope);
    }
  }, [modelBuilderGraph, remoteSceneDocument, sceneDocumentDraft, selectedSidebarNodeId]);

  const hasSolverTelemetry =
    (liveState?.step ?? 0) > 0 ||
    (run?.total_steps ?? 0) > 0 ||
    scalarRows.length > 0 ||
    workspaceStatus === "completed" ||
    workspaceStatus === "failed";

  /* Detect FEM */
  const planSummary = session?.plan_summary as Record<string, unknown> | undefined;
  const scriptBackendHint =
    (typeof scriptBuilder?.backend === "string" ? scriptBuilder.backend : null) ??
    (typeof remoteSceneDocument?.study?.backend === "string"
      ? remoteSceneDocument.study.backend
      : null) ??
    modelBuilderGraph?.study.backend ??
    null;
  const resolvedBackend =
    (typeof planSummary?.resolved_backend === "string" ? planSummary.resolved_backend : null) ??
    ((typeof session?.requested_backend === "string" && session.requested_backend !== "auto")
      ? session.requested_backend
      : null) ??
    scriptBackendHint;
  const isFemBackend =
    resolvedBackend === "fem" || femMesh != null || spatialPreview?.spatial_kind === "mesh";
  const domainCapabilities = runtimeDomainCapabilities ?? null;
  const effectiveIsFemBackend = domainCapabilities
    ? isFemDiscretization(domainCapabilities)
    : isFemBackend;

  const solverNotStartedMessage =
    workspaceStatus === "materializing_script"
      ? (effectiveIsFemBackend
          ? "Solver has not started yet. FEM materialization and tetrahedral meshing are still in progress."
          : "Solver has not started yet. Workspace materialization is still in progress.")
      : workspaceStatus === "bootstrapping"
        ? "Solver has not started yet. Workspace bootstrap is still in progress."
        : workspaceStatus === "waiting_for_compute"
          ? (effectiveIsFemBackend
              ? "Waiting for compute — adjust mesh in the control room, then click COMPUTE."
              : "Waiting for compute — inspect the workspace in the control room, then click COMPUTE.")
          : "Solver telemetry is not available yet.";

  const isWaitingForCompute = workspaceStatus === "waiting_for_compute";

  /* Effective solver values (fallback to run manifest when live is stale) */
  const {
    effectiveDmDt,
    effectiveDt,
    effectiveEAni,
    effectiveEDemag,
    effectiveEDmi,
    effectiveEEx,
    effectiveEExt,
    effectiveETotal,
    effectiveHDemag,
    effectiveHEff,
    effectiveLiveState,
    effectiveStep,
    effectiveTime,
    effectiveTorqueT,
  } = useEffectiveLiveTelemetry({
    liveState,
    run,
    scalarRows,
  });

  /* Status bar — expose stable timestamps instead of Date.now() so that
   * transportValue is not recreated on every render while the session runs.
   * Consumers that display live elapsed time compute it themselves via
   * a local setInterval(Date.now - sessionStartedAt, 1000). */
  const sessionStartedAt = session?.started_at_unix_ms ?? 0;
  const sessionFinishedAt = session?.finished_at_unix_ms ?? 0;

  const extractedSolverPlan = useMemo(() => extractSolverPlan(metadata, session), [metadata, session]);
  useEffect(() => {
    setSolverPlan(extractedSolverPlan);
  }, [extractedSolverPlan, setSolverPlan]);
  const quantityDescriptorById = useMemo(
    () => new Map(quantities.map((quantity) => [quantity.id, quantity] as const)),
    [quantities],
  );
  const kindForQuantity = useCallback((quantity: string): DisplaySelection["kind"] => {
    const desc = quantityDescriptorById.get(quantity);
    if (!desc) return "vector_field";
    switch (desc.kind) {
      case "spatial_scalar":
        return "spatial_scalar";
      case "global_scalar":
        return "global_scalar";
      default:
        return "vector_field";
    }
  }, [quantityDescriptorById]);
  const solverSettings = solverSettingsState;
  const meshOptions = meshOptionsState;
  const localBuilderDraft = useMemo(
    () =>
      sceneDocumentDraft ??
      buildScriptBuilderUpdatePayload(
        modelBuilderGraph,
        {
          solverSettings,
          meshOptions,
          demagRealization: scriptBuilderDemagRealization,
          universe: scriptBuilderUniverse,
          stages: studyStages,
          geometries: scriptBuilderGeometries,
          currentModules: scriptBuilderCurrentModules,
          excitationAnalysis: scriptBuilderExcitationAnalysis,
        },
      ),
    [
      modelBuilderGraph,
      meshOptions,
      sceneDocumentDraft,
      solverSettings,
      scriptBuilderDemagRealization,
      scriptBuilderUniverse,
      studyStages,
      scriptBuilderGeometries,
      scriptBuilderCurrentModules,
      scriptBuilderExcitationAnalysis,
    ],
  );
  const {
    setSolverSettings,
    setMeshOptions,
    setStudyStages,
    setStudyPipeline,
    setRequestedRuntimeSelection,
    setScriptBuilderDemagRealization,
    setScriptBuilderUniverse,
    setScriptBuilderGeometries,
    setScriptBuilderCurrentModules,
    setScriptBuilderExcitationAnalysis,
    setSceneDocument,
  } = useModelBuilderActions({
    modelBuilderDefaults,
    sceneDocumentDraft,
    localBuilderDraft,
    patchStudyRuntime: liveApi.patchStudyRuntime,
    setModelBuilderGraph,
    setSceneDocumentDraft,
    setSolverSettingsState,
    setMeshOptionsState,
  });
  const projectVisualizationPresets = useMemo(
    () => localBuilderDraft?.editor.visualization_presets ?? [],
    [localBuilderDraft?.editor.visualization_presets],
  );
  useEffect(() => {
    if (!selectedObjectId) {
      return;
    }
    if (
      sceneObjects.some(
        (object) => object.id === selectedObjectId || object.name === selectedObjectId,
      )
    ) {
      return;
    }
    setSelectedObjectId(null);
  }, [sceneObjects, selectedObjectId]);
  useEffect(() => {
    if (selectedObjectId) {
      stickyViewportObjectIdRef.current = selectedObjectId;
      return;
    }
    const viewportSelection = resolveViewportSelectedObjectId({
      selectedObjectId,
      selectedSidebarNodeId,
      stickyObjectId: stickyViewportObjectIdRef.current,
    });
    if (!viewportSelection) {
      stickyViewportObjectIdRef.current = null;
    }
  }, [selectedObjectId, selectedSidebarNodeId]);
  const viewportSelectedObjectId = useMemo(
    () =>
      resolveViewportSelectedObjectId({
        selectedObjectId,
        selectedSidebarNodeId,
        stickyObjectId: stickyViewportObjectIdRef.current,
      }),
    [selectedObjectId, selectedSidebarNodeId],
  );
  const localBuilderSignature = useMemo(
    () =>
      sceneDocumentDraft != null
        ? JSON.stringify(sceneDocumentDraft)
        : buildScriptBuilderSignature(modelBuilderGraph, {
            solverSettings,
            meshOptions,
            demagRealization: scriptBuilderDemagRealization,
            universe: scriptBuilderUniverse,
            stages: studyStages,
            geometries: scriptBuilderGeometries,
            currentModules: scriptBuilderCurrentModules,
            excitationAnalysis: scriptBuilderExcitationAnalysis,
          }),
    [
      modelBuilderGraph,
      meshOptions,
      sceneDocumentDraft,
      solverSettings,
      scriptBuilderDemagRealization,
      scriptBuilderUniverse,
      studyStages,
      scriptBuilderGeometries,
      scriptBuilderCurrentModules,
      scriptBuilderExcitationAnalysis,
    ],
  );
  const remoteBuilderSignature = useMemo(
    () => {
      if (remoteModelBuilderGraph) {
        return buildScriptBuilderSignature(remoteModelBuilderGraph, {
          solverSettings,
          meshOptions,
          demagRealization: scriptBuilderDemagRealization,
          universe: scriptBuilderUniverse,
          stages: studyStages,
          geometries: scriptBuilderGeometries,
          currentModules: scriptBuilderCurrentModules,
          excitationAnalysis: scriptBuilderExcitationAnalysis,
        });
      }
      if (!scriptBuilder) {
        return null;
      }
      return JSON.stringify(
        remoteSceneDocument ?? buildSceneDocumentFromScriptBuilder(scriptBuilder),
      );
    },
    [
      remoteSceneDocument,
      remoteModelBuilderGraph,
      scriptBuilder,
      meshOptions,
      solverSettings,
      scriptBuilderDemagRealization,
      scriptBuilderUniverse,
      studyStages,
      scriptBuilderGeometries,
      scriptBuilderCurrentModules,
      scriptBuilderExcitationAnalysis,
    ],
  );

  /* ── Builder auto-sync (extracted hook) ── */
  const builderAutoSync = useBuilderAutoSync();

  useSessionHydration({
    builderAutoSync,
    meshOptions,
    pendingMeshConfigSignatureRef,
    remoteModelBuilderGraph,
    remoteSceneDocument,
    scriptBuilder,
    solverPlan,
    solverSettings,
    workspaceHydrationKey,
    workspaceSelection,
    setActiveVisualizationPresetRef,
    setFocusedEntityId,
    setLastBuiltMeshConfigSignature,
    setMeshEntityViewState,
    setMeshOptionsState,
    setModelBuilderGraph,
    setObjectViewMode,
    setRunUntilInput,
    setSceneDocumentDraft,
    setSelectedEntityId,
    setSelectedObjectId,
    setSolverSettingsState,
  });

  useWorkspaceSelectionPersistence({
    lastPersistedWorkspaceSelectionRef,
    pendingWorkspaceSelectionIdentityRef,
    replaceWorkspaceSelection,
    sceneResourceSessionKey,
    selectedEntityId,
    selectedObjectId,
    selectedSidebarNodeId,
    workspaceSelectionHydratingRef,
    workspaceSelectionLoading,
  });

  useSceneEditorDraftSync({
    activeTransformScope,
    activeVisualizationPresetRef,
    effectiveViewportVisualizationState,
    focusedEntityId,
    meshEntityViewState,
    objectViewMode,
    projectVisualizationPresets,
    selectedEntityId,
    selectedObjectId,
    setSceneDocumentDraft,
  });

  useEffect(() => {
    if (!workspaceHydrationKey || !modelBuilderGraph) {
      return;
    }
    const projectedScene = buildSceneDocumentFromScriptBuilder({
      revision: modelBuilderGraph.revision,
      initial_state: modelBuilderGraph.study.initial_state,
      ...serializeModelBuilderGraphV2(modelBuilderGraph),
    });
    projectedScene.study.requested_backend = modelBuilderGraph.study.requested_backend;
    projectedScene.study.requested_device = modelBuilderGraph.study.requested_device;
    projectedScene.study.requested_precision = modelBuilderGraph.study.requested_precision;
    projectedScene.study.requested_mode = modelBuilderGraph.study.requested_mode;
    setSceneDocumentDraft((previousScene) => {
      if (!previousScene) {
        return projectedScene;
      }
      return {
        ...projectedScene,
        scene: previousScene.scene,
        outputs: previousScene.outputs,
        editor: previousScene.editor,
        objects: projectedScene.objects.map((object) => {
          const existing = previousScene.objects.find(
            (candidate) => candidate.id === object.id || candidate.name === object.name,
          );
          if (!existing) {
            return object;
          }
          return {
            ...existing,
            id: object.id,
            name: object.name,
            geometry: object.geometry,
            transform: {
              ...existing.transform,
              translation: object.transform.translation,
            },
            material_ref: object.material_ref,
            region_name: object.region_name,
            magnetization_ref: object.magnetization_ref,
            physics_stack: object.physics_stack,
            mesh_override: object.mesh_override,
          };
        }),
        materials: projectedScene.materials.map((material) => {
          const existing = previousScene.materials.find(
            (candidate) => candidate.id === material.id,
          );
          return existing
            ? {
                ...existing,
                id: material.id,
                properties: material.properties,
              }
            : material;
        }),
        magnetization_assets: projectedScene.magnetization_assets.map((asset) => {
          const existing = previousScene.magnetization_assets.find(
            (candidate) => candidate.id === asset.id,
          );
          if (!existing) {
            return asset;
          }
          const samePreset =
            existing.kind === asset.kind &&
            existing.preset_kind === asset.preset_kind;
          return {
            ...asset,
            id: asset.id,
            mapping: samePreset ? existing.mapping : asset.mapping,
            texture_transform: samePreset
              ? existing.texture_transform
              : asset.texture_transform,
          };
        }),
      };
    });
  }, [modelBuilderGraph, workspaceHydrationKey]);

  /* Scene draft sync is explicit (manual/script sync) — no hidden auto-push effect. */

  useVisualizationPresetPersistence({
    activeVisualizationPresetRef,
    localVisualizationPresets,
  });

  const {
    currentStage,
    activity,
    runtimeEngineGpuDevice,
    runtimeEngineGpuLabel,
    artifactLayout,
    meshBoundsMin,
    meshBoundsMax,
    meshExtent,
    meshName,
    meshSource,
    meshFeOrder,
    meshHmax,
    meshSummary,
    liveMeshName,
    builderObjectOverlays,
    builderObjectBounds,
    domainFrame,
    worldExtent,
    worldCenter,
    worldExtentSource,
    antennaOverlays,
    meshingCapabilities,
    mesherBackend,
    mesherSourceKind,
    mesherCurrentSettings,
    solverGrid,
    previewGrid,
    totalCells,
    activeCells,
    inactiveCells,
    activeMaskPresent,
    activeMask,
    interactiveEnabled,
    awaitingCommand,
    runtimeCanAcceptCommands,
    interactiveControlsEnabled,
  } = useDomainLayout({
    latestEngineMessage,
    workspaceStatus,
    isFemBackend,
    domainCapabilities,
    effectiveStep,
    effectiveTime,
    runtimeEngineLabel,
    runtimeEngineDeviceName,
    session,
    gpuTelemetry,
    metadata,
    femMesh,
    scriptBuilderGeometries,
    scriptBuilderUniverse,
    scriptBuilderCurrentModules,
    meshWorkspace,
    liveState,
    latestFieldGrid: runtimeLatestFieldGrid,
    spatialPreview,
    scriptBuilder,
    runtimeStatus,
    isWaitingForCompute,
  });
  previewGridRef.current = previewGrid;

  const {
    activeFemGenerationSignature,
    activeQuantityId,
    cachedFieldQuantities,
    effectiveVectorComponent,
    effectiveViewMode,
    isGlobalScalarQuantity,
    isMeshPreview,
    previewBusy,
    previewControlsActive,
    previewEveryNOptions,
    previewIsInitialSampleStale,
    previewIsStale,
    previewMaxPointOptions,
    requestedDisplaySelection,
    requestedPreviewAllLayers,
    requestedPreviewAutoScale,
    requestedPreviewComponent,
    requestedPreviewEveryN,
    requestedPreviewLayer,
    requestedPreviewMaxPoints,
    requestedPreviewQuantity,
    requestedPreviewXChosenSize,
    requestedPreviewYChosenSize,
    renderPreview,
  } = usePreviewSelectionState({
    component,
    displaySelection,
    effectiveStep,
    optimisticDisplaySelection,
    preview,
    previewConfig,
    previewPostInFlight,
    quantityDescriptorById,
    runtimeFemMesh,
    runtimeLatestFieldFrames,
    selectedQuantity,
    spatialPreview,
    viewMode,
    kindForQuantity,
  });

  const {
    appendFrontendTrace,
    enqueueCommand,
    buildMeshOptionsPayload,
    enqueueStudyDomainRemesh,
    patchDisplay,
    updatePreview,
    meshGenTopologyRef,
    meshGenGenerationRef,
    femGenerationIdRef,
    handleStudyDomainMeshGenerate,
    handleAirboxMeshGenerate,
    handleObjectMeshOverrideRebuild,
    handleLassoRefine,
  } = useMeshCommandPipeline({
    liveApi,
    meshPerGeometryPayload,
    requestedDisplaySelection,
    kindForQuantity,
    meshOptions,
    setMeshOptions,
    meshHmax,
    session,
    localBuilderDraft,
    localBuilderSignature,
    builderAutoSync,
    femMeshDataRef,
    femTopologyKeyRef,
    pendingMeshConfigSignatureRef,
    meshConfigSignatureRef,
    setCommandPostInFlight,
    setCommandErrorMessage,
    setFrontendTraceLog,
    setPreviewPostInFlight,
    setPreviewMessage,
    setOptimisticDisplaySelection,
    setMeshGenerating,
    setScriptSyncBusy,
    setScriptSyncMessage,
    applyVisualizationStateResource,
  });

  const {
    handleCompute,
    openFemMeshWorkspace,
    requestFocusObject,
    applyAntennaTranslation,
    applyGeometryTranslation,
    applyMeshWorkspacePreset,
    handleViewModeChange,
    handleSimulationAction,
    handleCapture,
    handleExport,
    handleStateExport,
    handleStateImport,
    syncScriptBuilder,
    activeCommandKind,
    activeCommandState,
    commandMessage,
    commandBusy,
    canRunCommand,
    canRelaxCommand,
    canPauseCommand,
    canStopCommand,
    canSkipCommand,
    primaryRunAction,
    primaryRunLabel,
    requestDisplayQuantity,
    requestPreviewQuantity,
    openAnalyzeSurface,
    openResultWorkspaceEntry,
    renameResultWorkspaceEntry,
    removeResultWorkspaceEntry,
    duplicateResultWorkspaceEntry,
    setResultWorkspacePinned,
  } = useWorkspaceActions({
    enqueueCommand,
    patchDisplay,
    updatePreview,
    appendFrontendTrace,
    liveApi,
    builderAutoSync,
    localBuilderDraft,
    remoteSceneDocument,
    refreshLiveState,
    localBuilderSignature,
    session,
    isFemBackend,
    domainCapabilities,
    workspaceStatus,
    effectiveViewMode,
    meshRenderMode: effectiveViewportVisualizationState.meshRenderMode,
    previewControlsActive,
    selectedQuantity,
    runUntilInput,
    solverSettings,
    commandPostInFlight,
    commandErrorMessage,
    commandStatus,
    isWaitingForCompute,
    interactiveEnabled,
    awaitingCommand,
    runtimeCanAcceptCommands,
    resultWorkspaceEntries,
    optimisticDisplaySelection,
    displaySelection,
    cachedFieldQuantities,
    setViewMode,
    setFemDockTab,
    setComponent,
    setSelectedSidebarNodeId: setSelectedSidebarNodeIdFromUi,
    setSelectedQuantity,
    setFocusObjectRequest,
    setScriptBuilderCurrentModules,
    setSceneDocument,
    setActiveResultWorkspaceId,
    setResultWorkspaceEntries,
    setCommandErrorMessage,
    setStateIoBusy,
    setStateIoMessage,
    setScriptSyncBusy,
    setScriptSyncMessage,
    setConsoleCollapsed,
    setOptimisticDisplaySelection,
    setPreviewMessage,
    openAnalyze,
    addResultWorkspaceEntry,
    lastLoggedCommandStatusRef,
  });

  /* Visualization presets — extracted to useVisualizationPresets hook */

  const {
    buildVisualizationPresetFromCurrent,
    createVisualizationPreset,
    updateVisualizationPreset,
    renameVisualizationPreset,
    duplicateVisualizationPreset,
    copyVisualizationPresetToSource,
    deleteVisualizationPreset,
    applyVisualizationPreset,
  } = useVisualizationPresets({
    effectiveViewMode,
    isFemBackend,
    domainCapabilities,
    requestedPreviewQuantity,
    meshRenderMode: effectiveViewportVisualizationState.meshRenderMode,
    meshOpacity: effectiveViewportVisualizationState.meshOpacity,
    meshClipEnabled: effectiveViewportVisualizationState.meshClipEnabled,
    meshClipAxis: effectiveViewportVisualizationState.meshClipAxis,
    meshClipPos: effectiveViewportVisualizationState.meshClipPos,
    meshShowArrows: effectiveViewportVisualizationState.meshShowArrows,
    requestedPreviewMaxPoints,
    femArrowColorMode: effectiveViewportVisualizationState.femArrowColorMode,
    femArrowMonoColor: effectiveViewportVisualizationState.femArrowMonoColor,
    femArrowAlpha: effectiveViewportVisualizationState.femArrowAlpha,
    femArrowLengthScale: effectiveViewportVisualizationState.femArrowLengthScale,
    femArrowThickness: effectiveViewportVisualizationState.femArrowThickness,
    objectViewMode,
    femVectorDomainFilter: effectiveViewportVisualizationState.femVectorDomainFilter,
    femFerromagnetVisibilityMode: effectiveViewportVisualizationState.femFerromagnetVisibilityMode,
    airMeshVisible: effectiveViewportVisualizationState.airMeshVisible,
    airMeshOpacity: effectiveViewportVisualizationState.airMeshOpacity,
    meshEntityViewState,
    fdmVisualizationSettings,
    component,
    plane,
    sliceIndex,
    selectedQuantity,
    cachedFieldQuantities,
    projectVisualizationPresets,
    localVisualizationPresets,
    activeVisualizationPresetRef,
    previewControlsActive,
    lastAppliedVisualizationPresetRef,
    setSceneDocumentDraft,
    setLocalVisualizationPresets,
    setActiveVisualizationPresetRef,
    setSelectedQuantity,
    handleViewModeChange,
    setComponent,
    setPlane,
    setSliceIndex,
    setObjectViewMode,
    setMeshEntityViewState,
    setFdmVisualizationSettings,
    patchDisplay,
  });

  const {
    dmDtSpark,
    dtSpark,
    eTotalSpark,
    previewQuantityOptions,
    quantityDataStatusById,
    quantityOptions,
    requestedPreviewQuantityDataStatus,
  } = useQuantityPresentationState({
    cachedFieldQuantities,
    quantities,
    renderPreview,
    requestedPreviewQuantity,
    scalarRows,
    selectedQuantity,
    setSelectedQuantity,
  });

  useEffect(() => {
    if (requestedPreviewQuantity) setSelectedQuantity(requestedPreviewQuantity);
  }, [requestedPreviewQuantity]);

  useEffect(() => {
    if (
      isFemBackend &&
      effectiveViewMode === "3D" &&
      effectiveViewportVisualizationState.femViewportLayers.showMagneticTexture &&
      !effectiveViewportVisualizationState.femViewportLayers.showQuantity &&
      selectedQuantity !== "m"
    ) {
      setSelectedQuantity("m");
    }
  }, [
    effectiveViewMode,
    effectiveViewportVisualizationState.femViewportLayers.showMagneticTexture,
    effectiveViewportVisualizationState.femViewportLayers.showQuantity,
    isFemBackend,
    selectedQuantity,
  ]);

  const {
    fieldDataRevision,
    fieldDataTimestamp,
    liveFieldSourceStep,
    previewSourceStep,
    scopedActiveMask,
    selectedFieldDomain,
    selectedFieldNComp,
    selectedVectors,
    selectedVectorSource,
  } = useViewportFieldData({
    activeFemGenerationSignature,
    activeQuantityId,
    activeTransformScope,
    binaryFieldTransportEnabled: FRONTEND_DIAGNOSTIC_FLAGS.dataPlaneRollout.binaryFieldTransport,
    debugLogsEnabled: ENABLE_VIEWPORT_DATA_DEBUG_LOGS,
    effectiveIsFemBackend,
    effectiveStep,
    effectiveViewMode,
    effectiveViewportVisualizationState,
    femMesh,
    isFemBackend,
    isGlobalScalarQuantity,
    isWaitingForCompute,
    latestFieldFrames: runtimeLatestFieldFrames,
    liveApi,
    meshEntityViewState,
    quantityDescriptorById,
    remoteSceneDocument,
    renderPreview,
    requestedPreviewQuantity,
    previewControlsActive,
    sceneDocumentDraft,
    selectedObjectId,
    selectedSidebarNodeId,
    workspaceStatus,
  });

  const quantityDescriptor = useMemo(
    () => (activeQuantityId ? quantityDescriptorById.get(activeQuantityId) ?? null : null),
    [activeQuantityId, quantityDescriptorById],
  );
  const hasVectorData = Boolean(selectedVectors && selectedVectors.length > 0);
  const isVectorQuantity =
    requestedDisplaySelection.kind === "vector_field" ||
    quantityDescriptor?.kind === "vector_field" ||
    (!isGlobalScalarQuantity(activeQuantityId) && hasVectorData);

  const quickPreviewTargets = useMemo(
    () => quantities
      .filter((quantity) => quantity.interactive_preview && quantity.quick_access_label)
      .map((quantity) => ({
        id: quantity.id,
        shortLabel: quantity.quick_access_label ?? quantity.label,
        available: isQuantitySelectable(quantity),
      })),
    [quantities],
  );

  const selectedScalarValue = useMemo(() => {
    return globalScalarPreview?.value ?? null;
  }, [globalScalarPreview]);
  const selectedQuantityLabel = quantityDescriptor?.label ?? requestedPreviewQuantity;
  const selectedQuantityUnit = quantityDescriptor?.unit ?? null;
  useAutoResultWorkspaceEntries({
    activeResultWorkspaceId,
    addResultWorkspaceEntry,
    analyzeSelection,
    artifacts: artifactsArr,
    requestedPreviewQuantity,
    resultWorkspaceEntries,
    selectedQuantityLabel,
    selectedQuantityUnit,
    setActiveResultWorkspaceId,
    viewMode,
  });

  /* FEM mesh data — extracted to useFemMeshDerived hook */
  const {
    effectiveFemMesh, meshParts, magneticParts, airPart, airRelatedParts, interfaceParts,
    visibleMeshPartIds, visibleMagneticObjectIds, selectedMeshPart, focusedMeshPart,
    objectOverlays, femMeshData, femHasFieldData, femMagnetization3DActive, femShouldShowArrows,
    arrowVisibility,
    femTopologyKey, femColorField, isMeshWorkspaceView, meshWorkspacePreset,
    meshConfigDirty, meshFaceDetail, meshQualitySummary, maxSliceCount,
    fieldStats, material, emptyStateMessage, sessionFooter, latestBackendError, mergedEngineLog,
  } = useFemMeshDerived({
    isMeshPreview,
    renderPreview,
    femMesh,
    meshEntityViewState,
    selectedEntityId,
    focusedEntityId,
    scriptBuilderGeometries,
    selectedVectors,
    selectedFieldNComp,
    selectedFieldDomain,
    fieldDataRevision,
    activeMask: scopedActiveMask ?? activeMask,
    spatialPreview,
    meshShowArrows: effectiveViewportVisualizationState.meshShowArrows,
    effectiveViewMode,
    activeQuantityId,
    isFemBackend,
    domainCapabilities,
    meshGenerating,
    commandStatus,
    meshSummary,
    meshWorkspace,
    selectedSidebarNodeId,
    selectedObjectId,
    airMeshVisible: effectiveViewportVisualizationState.airMeshVisible,
    airMeshOpacity: effectiveViewportVisualizationState.airMeshOpacity,
    effectiveVectorComponent,
    sliceIndex,
    plane,
    previewGrid,
    solverPlan,
    workspaceStatus,
    latestEngineMessage,
    session,
    engineLog,
    frontendTraceLog,
    meshRenderMode: effectiveViewportVisualizationState.meshRenderMode,
    femDockTab,
    meshConfigSignature,
    lastBuiltMeshConfigSignature,
    meshSelection,
    femFieldBuffersRef,
    femMeshDataRef,
    femTopologyKeyRef,
    femGenerationIdRef,
    meshGenTopologyRef,
    meshGenGenerationRef,
    pendingMeshConfigSignatureRef,
    meshConfigSignatureRef,
    setMeshEntityViewState,
    setSelectedEntityId,
    setFocusedEntityId,
    setMeshGenerating,
    setLastBuiltMeshConfigSignature,
    setSliceIndex,
    setMeshSelection,
    appendFrontendTrace,
  });

  /* ═══════════════════════════════════════════════════════════════
   * SPLIT useMemo — each context domain has its own memo so that
   * a telemetry tick does NOT invalidate model/command/viewport.
   * ═══════════════════════════════════════════════════════════════ */

  const transportValue = useMemo<TransportContextValue>(() => ({
    effectiveStep, effectiveTime, effectiveDt, effectiveDmDt, effectiveTorqueT, effectiveHEff, effectiveHDemag,
    effectiveEEx, effectiveEDemag, effectiveEExt, effectiveEAni, effectiveEDmi, effectiveETotal,
    sessionStartedAt, sessionFinishedAt,
    liveState, effectiveLiveState, scalarRows, scalarRowsTotal,
    dmDtSpark, dtSpark, eTotalSpark,
    preview,
    selectedVectors,
    selectedVectorSourceKind: selectedVectorSource.source,
    liveFieldSourceStep,
    previewSourceStep,
    fieldDataRevision,
    fieldDataTimestamp,
    fieldStats,
    hasSolverTelemetry,
  }), [
    effectiveStep, effectiveTime, effectiveDt, effectiveDmDt, effectiveTorqueT, effectiveHEff, effectiveHDemag,
    effectiveEEx, effectiveEDemag, effectiveEExt, effectiveEAni, effectiveEDmi, effectiveETotal,
    sessionStartedAt, sessionFinishedAt,
    liveState, effectiveLiveState, scalarRows, scalarRowsTotal,
    dmDtSpark, dtSpark, eTotalSpark,
    preview,
    selectedVectors,
    selectedVectorSource.source,
    liveFieldSourceStep,
    previewSourceStep,
    fieldDataRevision,
    fieldDataTimestamp,
    fieldStats,
    hasSolverTelemetry,
  ]);

  const viewportValue = useMemo<ViewportContextValue>(() => ({
    workspaceStage, setWorkspaceStage,
    workspaceMode, setWorkspaceMode,
    viewMode, effectiveViewMode, component, plane, sliceIndex, selectedQuantity,
    consoleCollapsed, sidebarCollapsed,
    quantityOptions, previewQuantityOptions, quantityDescriptor, isVectorQuantity,
    quickPreviewTargets, selectedScalarValue, selectedQuantityLabel, selectedQuantityUnit,
    solverGrid, previewGrid, totalCells, activeCells, inactiveCells, activeMaskPresent, activeMask,
    maxSliceCount, effectiveVectorComponent, emptyStateMessage,
    previewBusy, previewMessage, previewControlsActive,
    requestedPreviewQuantity, requestedPreviewComponent, requestedPreviewLayer,
    requestedPreviewAllLayers, requestedPreviewEveryN,
    requestedPreviewXChosenSize, requestedPreviewYChosenSize, requestedPreviewAutoScale,
    requestedPreviewMaxPoints, requestedPreviewQuantityDataStatus,
    previewEveryNOptions, previewMaxPointOptions,
    previewIsStale, previewIsInitialSampleStale,
    setViewMode, setComponent, setPlane, setSliceIndex, setSelectedQuantity,
    setConsoleCollapsed, setSidebarCollapsed,
    patchDisplay,
    updatePreview, handleViewModeChange, handleCapture, handleExport,
    requestDisplayQuantity, requestPreviewQuantity,
  }), [
    setWorkspaceMode,
    setWorkspaceStage,
    workspaceStage,
    workspaceMode,
    viewMode, effectiveViewMode, component, plane, sliceIndex, selectedQuantity,
    consoleCollapsed, sidebarCollapsed,
    quantityOptions, previewQuantityOptions, quantityDescriptor, isVectorQuantity,
    quickPreviewTargets, selectedScalarValue, selectedQuantityLabel, selectedQuantityUnit,
    solverGrid, previewGrid, totalCells, activeCells, inactiveCells, activeMaskPresent, activeMask,
    maxSliceCount, effectiveVectorComponent, emptyStateMessage,
    previewBusy, previewMessage, previewControlsActive,
    requestedPreviewQuantity, requestedPreviewComponent, requestedPreviewLayer,
    requestedPreviewAllLayers, requestedPreviewEveryN,
    requestedPreviewXChosenSize, requestedPreviewYChosenSize, requestedPreviewAutoScale,
    requestedPreviewMaxPoints, requestedPreviewQuantityDataStatus,
    previewEveryNOptions, previewMaxPointOptions,
    previewIsStale, previewIsInitialSampleStale,
    patchDisplay,
    updatePreview, handleViewModeChange, handleCapture, handleExport,
    requestDisplayQuantity, requestPreviewQuantity,
  ]);

  const commandValue = useMemo<CommandContextValue>(() => ({
    connection, error, session, run, capabilities, domainCapabilities, metadata, engineLog: mergedEngineLog, quantities, artifacts: artifactsArr,
    workspaceStatus, isWaitingForCompute, solverNotStartedMessage, isFemBackend: effectiveIsFemBackend, runtimeEngineLabel,
    runtimeEngineGpuLabel, runtimeEngineGpuDevice,
    activity, sessionFooter, runtimeStatus, stageExecution, runtimeCanAcceptCommands,
    commandStatus, activeCommandKind, activeCommandState,
    canRunCommand, canRelaxCommand, canPauseCommand, canStopCommand, canSkipCommand, primaryRunAction, primaryRunLabel,
    interactiveEnabled, interactiveControlsEnabled, awaitingCommand, commandBusy, commandMessage,
    latestBackendError,
    scriptSyncBusy, scriptSyncMessage, stateIoBusy, stateIoMessage, scriptInitialState, scriptBuilderGeometries, scriptBuilderCurrentModules, scriptBuilderExcitationAnalysis, runUntilInput,
    setRunUntilInput, enqueueCommand, handleCompute, handleSimulationAction,
    handleStateExport, handleStateImport, syncScriptBuilder,
  }), [
    connection, error, session, run, capabilities, domainCapabilities, metadata, mergedEngineLog, quantities, artifactsArr,
    workspaceStatus, isWaitingForCompute, solverNotStartedMessage, effectiveIsFemBackend, runtimeEngineLabel,
    runtimeEngineGpuLabel, runtimeEngineGpuDevice,
    activity, sessionFooter, runtimeStatus, stageExecution, runtimeCanAcceptCommands,
    commandStatus, activeCommandKind, activeCommandState,
    canRunCommand, canRelaxCommand, canPauseCommand, canStopCommand, canSkipCommand, primaryRunAction, primaryRunLabel,
    interactiveEnabled, interactiveControlsEnabled, awaitingCommand, commandBusy, commandMessage,
    latestBackendError,
    scriptSyncBusy, scriptSyncMessage, stateIoBusy, stateIoMessage, scriptInitialState, scriptBuilderGeometries, scriptBuilderCurrentModules, scriptBuilderExcitationAnalysis, runUntilInput,
    enqueueCommand, handleCompute, handleSimulationAction,
    handleStateExport, handleStateImport, syncScriptBuilder,
  ]);

  /* ── P2-2: Explicit viewport display reset command ── */
  const resetViewportDisplayState = useCallback(() => {
    const scope = resolveViewportSelectionScope({
      selectedSidebarNodeId,
      selectedObjectId,
      selectedEntityId,
      meshParts,
    });
    const result = buildViewportDisplayReset(
      scope,
      meshParts,
      meshEntityViewState,
      visibleMeshPartIds,
    );
    setMeshEntityViewState(result.meshEntityViewState);
    if (result.resetGlobals) {
      void patchDisplay(visualizationPatchForViewportDisplayDefaults(result.globals));
      useVisualizationStore.getState().patch({
        femViewportLayers: DEFAULT_FEM_VIEWPORT_LAYER_STATE,
      });
    }
  }, [
    selectedSidebarNodeId, selectedObjectId, selectedEntityId,
    meshParts, meshEntityViewState, visibleMeshPartIds, patchDisplay,
  ]);

  const modelValue = useMemo<ModelContextValue>(() => ({
    sceneResourceSessionKey,
    resourceRevisions: runtimeResourceRevisions,
    sceneDocument: localBuilderDraft,
    remoteSceneDocument,
    modelBuilderGraph,
    requestedRuntimeSelection: {
      requested_backend:
        localBuilderDraft?.study.requested_backend ??
        modelBuilderGraph?.study.requested_backend ??
        "auto",
      requested_device:
        localBuilderDraft?.study.requested_device ??
        modelBuilderGraph?.study.requested_device ??
        "auto",
      requested_precision:
        localBuilderDraft?.study.requested_precision ??
        modelBuilderGraph?.study.requested_precision ??
        "double",
      requested_mode:
        localBuilderDraft?.study.requested_mode ??
        modelBuilderGraph?.study.requested_mode ??
        "strict",
      requested_cpu_threads:
        localBuilderDraft?.study.requested_cpu_threads ??
        modelBuilderGraph?.study.requested_cpu_threads ??
        null,
    },
    material, solverPlan, solverSettings, studyStages, studyPipeline, scriptBuilderDemagRealization, scriptBuilderUniverse, scriptBuilderGeometries, scriptBuilderCurrentModules, scriptBuilderExcitationAnalysis, antennaOverlays, objectOverlays, femMesh, resolvedRenderPlan,
    visualizationProjectPresets: projectVisualizationPresets,
    visualizationLocalPresets: localVisualizationPresets,
    activeVisualizationPresetRef,
    meshSelection, meshOptions, meshQualityData, meshGenerating, femDockTab,
    effectiveFemMesh, femMeshData, femTopologyKey, femColorField,
    femMagnetization3DActive, femShouldShowArrows, arrowVisibility, isMeshWorkspaceView,
    meshFaceDetail, meshQualitySummary, meshWorkspace,
    meshConfigDirty, meshConfigSignature, lastBuiltMeshConfigSignature,
    meshName: effectiveFemMesh?.mesh_name ?? meshSummary?.mesh_name ?? liveMeshName ?? meshName,
    meshSource: meshSummary?.mesh_source ?? meshSource,
    meshExtent: meshSummary?.mesh_extent ?? meshExtent,
    meshBoundsMin: meshSummary?.bounds_min ?? meshBoundsMin,
    meshBoundsMax: meshSummary?.bounds_max ?? meshBoundsMax,
    meshFeOrder: meshSummary?.order ?? meshFeOrder,
    domainFrame: effectiveFemMesh?.domain_frame ?? meshSummary?.domain_frame ?? domainFrame,
    worldExtent,
    worldCenter,
    worldExtentSource: meshSummary?.world_extent_source ?? worldExtentSource,
    meshHmax: Number.isFinite(meshSummary?.hmax ?? NaN) ? (meshSummary?.hmax ?? null) : meshHmax,
    mesherBackend, mesherSourceKind, mesherCurrentSettings,
    meshWorkspacePreset,
    viewportSelectedObjectId,
    cameraFitRequestSeed,
    objectViewMode,
    activeTransformScope,
    meshEntityViewState,
    visibleSubmeshSnapshot,
    meshParts,
    visibleMeshPartIds,
    visibleMagneticObjectIds,
    selectedMeshPart,
    focusedMeshPart,
    magneticParts,
    airPart,
    interfaceParts,
    analyzeSelection,
    resultWorkspaceEntries,
    activeResultWorkspaceId,
    workspaceTabs,
    activeWorkspaceTabId,
    setSolverSettings, setSceneDocument, refreshLiveState, setRequestedRuntimeSelection, setStudyStages, setStudyPipeline, setScriptBuilderDemagRealization, setScriptBuilderUniverse, setScriptBuilderGeometries, setScriptBuilderCurrentModules, setScriptBuilderExcitationAnalysis,
    setMeshSelection, setMeshOptions, setFemDockTab,
    setObjectViewMode, setActiveTransformScope, setMeshEntityViewState, setVisibleSubmeshSnapshot, setAnalyzeSelection, openAnalyze, selectAnalyzeTab, selectAnalyzeMode, refreshAnalyze, addResultWorkspaceEntry, openAnalyzeSurface, openResultWorkspaceEntry, renameResultWorkspaceEntry, removeResultWorkspaceEntry, duplicateResultWorkspaceEntry, setResultWorkspacePinned, requestFocusObject, requestViewportCameraFit, applyAntennaTranslation, applyGeometryTranslation, handleStudyDomainMeshGenerate, handleAirboxMeshGenerate, handleObjectMeshOverrideRebuild, handleLassoRefine, openFemMeshWorkspace, applyMeshWorkspacePreset,
    openWorkspaceTab, activateWorkspaceTab, closeWorkspaceTab, pinWorkspaceTab,
    createVisualizationPreset, setActiveVisualizationPresetRef, applyVisualizationPreset, renameVisualizationPreset, duplicateVisualizationPreset, deleteVisualizationPreset, copyVisualizationPresetToSource, updateVisualizationPreset,
    resetViewportDisplayState,
  }), [
    sceneResourceSessionKey, runtimeResourceRevisions,
    localBuilderDraft, remoteSceneDocument, modelBuilderGraph, material, solverPlan, solverSettings, studyStages, studyPipeline, scriptBuilderDemagRealization, scriptBuilderUniverse, scriptBuilderGeometries, scriptBuilderCurrentModules, scriptBuilderExcitationAnalysis, antennaOverlays, objectOverlays, femMesh, resolvedRenderPlan,
    projectVisualizationPresets, localVisualizationPresets, activeVisualizationPresetRef,
    meshSelection, meshOptions, meshQualityData, meshGenerating, femDockTab,
    effectiveFemMesh, femMeshData, femTopologyKey, femColorField,
    femMagnetization3DActive, femShouldShowArrows, arrowVisibility, isMeshWorkspaceView,
    meshFaceDetail, meshQualitySummary, meshWorkspace,
    meshConfigDirty, meshConfigSignature, lastBuiltMeshConfigSignature,
    meshSummary, meshName, meshSource, meshExtent, meshBoundsMin, meshBoundsMax, meshFeOrder, liveMeshName,
    domainFrame, worldExtent, worldCenter, worldExtentSource, meshHmax, mesherBackend, mesherSourceKind, mesherCurrentSettings,
    meshWorkspacePreset,
    viewportSelectedObjectId, cameraFitRequestSeed, objectViewMode, meshEntityViewState, visibleSubmeshSnapshot, meshParts, visibleMeshPartIds, visibleMagneticObjectIds, selectedMeshPart, focusedMeshPart, magneticParts, airPart, interfaceParts, analyzeSelection, resultWorkspaceEntries, activeResultWorkspaceId, workspaceTabs, activeWorkspaceTabId, requestFocusObject, requestViewportCameraFit,
    setSceneDocument, refreshLiveState, setRequestedRuntimeSelection, setStudyStages, setStudyPipeline, setScriptBuilderDemagRealization, setScriptBuilderUniverse, setScriptBuilderGeometries, setScriptBuilderCurrentModules, setScriptBuilderExcitationAnalysis,
    handleStudyDomainMeshGenerate, handleAirboxMeshGenerate, handleObjectMeshOverrideRebuild, handleLassoRefine, openFemMeshWorkspace, applyMeshWorkspacePreset, createVisualizationPreset, setActiveVisualizationPresetRef, applyVisualizationPreset, renameVisualizationPreset, duplicateVisualizationPreset, deleteVisualizationPreset, copyVisualizationPresetToSource, updateVisualizationPreset, openAnalyze, selectAnalyzeTab, selectAnalyzeMode, refreshAnalyze, addResultWorkspaceEntry, openAnalyzeSurface, openResultWorkspaceEntry, renameResultWorkspaceEntry, removeResultWorkspaceEntry, duplicateResultWorkspaceEntry, setResultWorkspacePinned, openWorkspaceTab, activateWorkspaceTab, closeWorkspaceTab, pinWorkspaceTab,
    applyAntennaTranslation, applyGeometryTranslation, setMeshOptions, setSolverSettings, activeTransformScope,
    resetViewportDisplayState,
  ]);

  const controlRoomReady =
    connection !== "connecting" &&
    (session != null || remoteSceneDocument != null || error != null);

  if (!controlRoomReady) {
    return <ControlRoomConnectingState />;
  }

  return (
    <ControlRoomContextProviders
      transportValue={transportValue}
      viewportValue={viewportValue}
      commandValue={commandValue}
      modelValue={modelValue}
    >
      {children}
    </ControlRoomContextProviders>
  );
}
