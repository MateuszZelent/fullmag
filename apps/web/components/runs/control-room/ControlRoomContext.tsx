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
import {
  currentLiveApiClient,
  type GpuTelemetryResponse,
} from "../../../lib/liveApiClient";
import { useCurrentLiveStream } from "../../../lib/useSessionStream";
import { useSessionRuntimeBridge } from "../../../features/session-runtime/hooks/useSessionRuntimeBridge";
import { useWorkspaceStore } from "../../../lib/workspace/workspace-store";
import { useBuilderAutoSync } from "./hooks/useBuilderAutoSync";
import { useDomainLayout } from "./hooks/useDomainLayout";
import { useFemMeshDerived } from "./hooks/useFemMeshDerived";
import { useMeshCommandPipeline } from "./hooks/useMeshCommandPipeline";
import { useVisualizationPresets } from "./hooks/useVisualizationPresets";
import { useWorkspaceActions } from "./hooks/useWorkspaceActions";
import {
  DEFAULT_AIR_MESH_OPACITY,
  DEFAULT_FDM_VISUALIZATION_SETTINGS,
  EMPTY_ARTIFACTS,
  EMPTY_ENGINE_LOG,
  EMPTY_QUANTITIES,
  EMPTY_SCALAR_ROWS,
  GPU_TELEMETRY_POLL_MS,
  loadLocalActiveVisualizationRef,
  loadLocalVisualizationPresets,
  normalizePersistedMeshEntityViewState,
  normalizePersistedObjectViewMode,
  normalizeVisualizationPresetRef,
  resultWorkspaceIcon,
  samePersistedMeshEntityViewState,
  sameVisualizationPresetRef,
  sameVisualizationPresets,
  serializeMeshEntityViewStateForScene,
} from "./controlRoomUtils";
import type {
  DisplaySelection,
  EngineLogEntry,
  MeshWorkspaceState,
  ScriptBuilderStageState,
} from "../../../lib/useSessionStream";
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
import {
  buildModelBuilderGraphV2,
  selectModelBuilderCurrentModules,
  selectModelBuilderExcitationAnalysis,
  selectModelBuilderGeometries,
  selectModelBuilderStudyPipeline,
  selectModelBuilderStages,
  selectModelBuilderUniverse,
  serializeModelBuilderGraphV2,
} from "../../../lib/session/modelBuilderGraph";
import {
  buildSceneDocumentFromScriptBuilder,
} from "../../../lib/session/sceneDocument";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { DEFAULT_SOLVER_SETTINGS } from "../../panels/SolverSettingsPanel";
import type { SolverSettingsState } from "../../panels/SolverSettingsPanel";
import { DEFAULT_MESH_OPTIONS } from "@/lib/mesh/options";
import type { MeshOptionsState, MeshQualityData } from "@/lib/mesh/options";
import type {
  ClipAxis,
  FemMeshData,
  MeshSelectionSnapshot,
  RenderMode,
} from "../../preview/FemMeshView3D";
import {
  type FemDockTab,
  type FocusObjectRequest,
  type ObjectViewMode,
  type SlicePlane,
  type VectorComponent,
  type ViewportScope,
  type ViewportMode,
  PREVIEW_EVERY_N_DEFAULT,
  PREVIEW_EVERY_N_PRESETS,
  PREVIEW_MAX_POINTS_DEFAULT,
  PREVIEW_MAX_POINTS_PRESETS,
  resolveViewportScope,
} from "./shared";
import {
  buildScriptBuilderSignature,
  buildScriptBuilderUpdatePayload,
  extractSolverPlan,
  meshOptionsFromBuilder,
  meshOptionsToBuilder,
  solverSettingsFromBuilder,
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
  type ViewportDisplayDefaults,
} from "../../../features/viewport-fem/model/femResetCommand";
import {
  LOCAL_ACTIVE_VISUALIZATION_PRESET_STORAGE_KEY,
  LOCAL_VISUALIZATION_PRESETS_STORAGE_KEY,
} from "./visualizationPresets";
import {
  DEFAULT_ANALYZE_SELECTION,
  nextAnalyzeRefresh,
  type AnalyzeSelectionState,
  type AnalyzeTab,
} from "./analyzeSelection";
import type { VisibleSubmeshSnapshot } from "./submeshSnapshot";

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
  WorkspaceMode,
  ResultWorkspaceEntry,
  ResultWorkspaceKind,
} from "./context-hooks";
import { useModelBuilderActions } from "./hooks/useModelBuilderActions";
import {
  TransportCtx,
  ViewportCtx,
  CommandCtx,
  ModelCtx,
} from "./context-hooks";
import type {
  TransportContextValue,
  ViewportContextValue,
  CommandContextValue,
  ModelContextValue,
  WorkspaceMode,
  ResultWorkspaceEntry,
  ResultWorkspaceKind,
} from "./context-hooks";

/* ── Provider ── */
export function ControlRoomProvider({ children }: { children: ReactNode }) {
  const { state, connection, error } = useCurrentLiveStream();

  // F-P1: sync live stream into the session-runtime Zustand store
  useSessionRuntimeBridge(state, connection, error);

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
  const [viewMode, setViewMode] = useState<ViewportMode>("3D");
  const [component, setComponent] = useState<VectorComponent>("magnitude");
  const [plane, setPlane] = useState<SlicePlane>("xy");
  const [sliceIndex, setSliceIndex] = useState(0);
  const [selectedQuantity, setSelectedQuantity] = useState("m");
  const [consoleCollapsed, setConsoleCollapsed] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [femDockTab, setFemDockTab] = useState<FemDockTab>("mesh");
  const [meshRenderMode, setMeshRenderMode] = useState<RenderMode>("surface");
  const [meshOpacity, setMeshOpacity] = useState(100);
  const [meshClipEnabled, setMeshClipEnabled] = useState(false);
  const [meshClipAxis, setMeshClipAxis] = useState<ClipAxis>("x");
  const [meshClipPos, setMeshClipPos] = useState(50);
  const [meshShowArrows, setMeshShowArrows] = useState(true);
  const [femArrowColorMode, setFemArrowColorMode] = useState<
    "orientation" | "x" | "y" | "z" | "magnitude" | "monochrome"
  >("orientation");
  const [femArrowMonoColor, setFemArrowMonoColor] = useState("#00c2ff");
  const [femArrowAlpha, setFemArrowAlpha] = useState(1);
  const [femArrowLengthScale, setFemArrowLengthScale] = useState(1);
  const [femArrowThickness, setFemArrowThickness] = useState(1);
  const [femVectorDomainFilter, setFemVectorDomainFilter] = useState<
    "auto" | "magnetic_only" | "full_domain" | "airbox_only"
  >("auto");
  const [femFerromagnetVisibilityMode, setFemFerromagnetVisibilityMode] = useState<
    "hide" | "ghost"
  >("hide");
  const [fdmVisualizationSettings, setFdmVisualizationSettings] =
    useState<VisualizationPresetFdmState>(DEFAULT_FDM_VISUALIZATION_SETTINGS);
  const [runUntilInput, setRunUntilInput] = useState("1e-12");
  const [selectedSidebarNodeId, setSelectedSidebarNodeId] = useState<string | null>(null);
  const [analyzeSelection, setAnalyzeSelection] =
    useState<AnalyzeSelectionState>(DEFAULT_ANALYZE_SELECTION);
  const [resultWorkspaceEntries, setResultWorkspaceEntries] = useState<ResultWorkspaceEntry[]>([]);
  const [activeResultWorkspaceId, setActiveResultWorkspaceId] = useState<string | null>(null);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [viewportScope, setViewportScope] = useState<ViewportScope>("universe");
  const [focusObjectRequest, setFocusObjectRequest] = useState<FocusObjectRequest | null>(null);
  const [objectViewMode, setObjectViewMode] = useState<ObjectViewMode>("context");
  const [activeTransformScope, setActiveTransformScope] = useState<"object" | "texture" | null>(null);
  const [airMeshVisible, setAirMeshVisible] = useState(false);
  const [airMeshOpacity, setAirMeshOpacity] = useState(DEFAULT_AIR_MESH_OPACITY);
  const [meshEntityViewState, setMeshEntityViewState] = useState<MeshEntityViewStateMap>({});
  const [visibleSubmeshSnapshot, setVisibleSubmeshSnapshot] =
    useState<VisibleSubmeshSnapshot | null>(null);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [focusedEntityId, setFocusedEntityId] = useState<string | null>(null);
  const [commandPostInFlight, setCommandPostInFlight] = useState(false);
  const [commandErrorMessage, setCommandErrorMessage] = useState<string | null>(null);
  const [scriptSyncBusy, setScriptSyncBusy] = useState(false);
  const [scriptSyncMessage, setScriptSyncMessage] = useState<string | null>(null);
  const [stateIoBusy, setStateIoBusy] = useState(false);
  const [stateIoMessage, setStateIoMessage] = useState<string | null>(null);
  const [previewPostInFlight, setPreviewPostInFlight] = useState(false);
  const [previewMessage, setPreviewMessage] = useState<string | null>(null);
  const [optimisticDisplaySelection, setOptimisticDisplaySelection] =
    useState<DisplaySelection | null>(null);
  const [meshOptionsState, setMeshOptionsState] = useState<MeshOptionsState>(DEFAULT_MESH_OPTIONS);
  const [meshGenerating, setMeshGenerating] = useState(false);
  const [lastBuiltMeshConfigSignature, setLastBuiltMeshConfigSignature] = useState<string | null>(null);
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
  const [solverSettingsState, setSolverSettingsState] =
    useState<SolverSettingsState>(DEFAULT_SOLVER_SETTINGS);
  const [modelBuilderGraph, setModelBuilderGraph] = useState<ModelBuilderGraphV2 | null>(null);
  const [sceneDocumentDraft, setSceneDocumentDraft] = useState<SceneDocument | null>(null);
  const [localVisualizationPresets, setLocalVisualizationPresets] = useState<VisualizationPreset[]>(
    () => loadLocalVisualizationPresets(),
  );
  const [activeVisualizationPresetRef, setActiveVisualizationPresetRef] =
    useState<VisualizationPresetRef | null>(() => loadLocalActiveVisualizationRef());
  const [meshSelection, setMeshSelection] = useState<MeshSelectionSnapshot>({
    selectedFaceIndices: [],
    primaryFaceIndex: null,
  });

  const activeWorkspaceTab = useMemo(
    () => workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId) ?? null,
    [activeWorkspaceTabId, workspaceTabs],
  );

  useEffect(() => {
    if (!activeWorkspaceTab) return;
    const payloadMode = activeWorkspaceTab.payload?.viewMode;
    const inferredMode: ViewportMode | null =
      payloadMode === "3D" || payloadMode === "2D" || payloadMode === "Mesh" || payloadMode === "Analyze"
        ? payloadMode
        : activeWorkspaceTab.id === "core:3d"
          ? "3D"
          : activeWorkspaceTab.id === "core:2d"
            ? "2D"
            : activeWorkspaceTab.id === "core:mesh"
              ? "Mesh"
              : activeWorkspaceTab.id === "core:analyze"
                ? "Analyze"
                : null;
    if (!inferredMode || inferredMode === viewMode) return;
    if (inferredMode === "2D") {
      setComponent((prev) => (prev === "magnitude" ? "x" : prev));
    }
    setViewMode(inferredMode);
  }, [activeWorkspaceTab, viewMode]);

  /* ── Derived from SSE state ── */
  const session = state?.session ?? null;
  const metadata = (state?.metadata as Record<string, unknown> | null) ?? null;
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
  const openAnalyze = useCallback((next?: Partial<AnalyzeSelectionState>) => {
    startTransition(() => {
      setViewMode("Analyze");
    });
    setAnalyzeSelection((prev) => ({
      ...prev,
      ...next,
    }));
  }, []);
  const selectAnalyzeTab = useCallback((tab: AnalyzeTab) => {
    setAnalyzeSelection((prev) => ({
      ...prev,
      tab,
    }));
  }, []);
  const selectAnalyzeMode = useCallback((index: number | null) => {
    setAnalyzeSelection((prev) => ({
      ...prev,
      tab: "modes",
      selectedModeIndex: index,
    }));
  }, []);
  const refreshAnalyze = useCallback(() => {
    setAnalyzeSelection((prev) => nextAnalyzeRefresh(prev));
  }, []);
  const addResultWorkspaceEntry = useCallback(
    (entry: {
      key?: string | null;
      kind: ResultWorkspaceKind;
      label: string;
      quantityId?: string | null;
      icon?: string;
      badge?: string | null;
      pinned?: boolean;
      openAfterCreate?: boolean;
    }) => {
      const key = entry.key?.trim().length ? entry.key.trim() : `${entry.kind}:${entry.label}`;
      const existing = resultWorkspaceEntries.find((candidate) => candidate.key === key);
      if (existing) {
        if (entry.openAfterCreate) {
          setActiveResultWorkspaceId(existing.id);
        }
        return existing.id;
      }
      const now = Date.now();
      const created: ResultWorkspaceEntry = {
        id: `${entry.kind}-${now}-${Math.floor(Math.random() * 10000)}`,
        key,
        kind: entry.kind,
        label: entry.label,
        quantityId: entry.quantityId ?? null,
        icon: entry.icon ?? resultWorkspaceIcon(entry.kind),
        badge: entry.badge ?? null,
        pinned: entry.pinned ?? !key.startsWith("auto:"),
        createdAtUnixMs: now,
      };
      setResultWorkspaceEntries((prev) => [...prev, created]);
      if (entry.openAfterCreate) {
        setActiveResultWorkspaceId(created.id);
      }
      return created.id;
    },
    [resultWorkspaceEntries],
  );
  const run = state?.run ?? null;
  const liveState = state?.live_state ?? null;
  const displaySelection = state?.display_selection ?? null;
  const previewConfig = state?.preview_config ?? null;
  const preview = state?.preview ?? null;
  const spatialPreview = preview?.kind === "spatial" ? preview : null;
  const globalScalarPreview = preview?.kind === "global_scalar" ? preview : null;
  const femMesh = state?.fem_mesh ?? liveState?.fem_mesh ?? null;
  const remoteSceneDocument = state?.scene_document ?? null;
  const meshConfigSignature = useMemo(
    () => buildMeshConfigurationSignature(sceneDocumentDraft ?? remoteSceneDocument),
    [remoteSceneDocument, sceneDocumentDraft],
  );
  meshConfigSignatureRef.current = meshConfigSignature;
  const scriptBuilder = state?.script_builder ?? null;
  const remoteModelBuilderGraph = state?.model_builder_graph ?? null;
  const scriptInitialState = scriptBuilder?.initial_state ?? null;
  const studyStages = useMemo(
    () => selectModelBuilderStages(modelBuilderGraph),
    [modelBuilderGraph],
  );
  const studyPipeline = useMemo(
    () => selectModelBuilderStudyPipeline(modelBuilderGraph),
    [modelBuilderGraph],
  );
  const scriptBuilderDemagRealization = useMemo(
    () => modelBuilderGraph?.study.demag_realization ?? null,
    [modelBuilderGraph],
  );
  const scriptBuilderUniverse = useMemo(
    () => selectModelBuilderUniverse(modelBuilderGraph),
    [modelBuilderGraph],
  );
  const scriptBuilderGeometries = useMemo(
    () => selectModelBuilderGeometries(modelBuilderGraph),
    [modelBuilderGraph],
  );
  const scriptBuilderCurrentModules = useMemo(
    () => selectModelBuilderCurrentModules(modelBuilderGraph),
    [modelBuilderGraph],
  );
  const scriptBuilderExcitationAnalysis = useMemo(
    () => selectModelBuilderExcitationAnalysis(modelBuilderGraph),
    [modelBuilderGraph],
  );
  const runtimeStatus = state?.runtime_status ?? null;
  const commandStatus = state?.command_status ?? null;
  const stageExecution = state?.stage_execution ?? null;
  const scalarRows = state?.scalar_rows ?? EMPTY_SCALAR_ROWS;
  const engineLog = state?.engine_log ?? EMPTY_ENGINE_LOG;
  const quantities = state?.quantities ?? EMPTY_QUANTITIES;
  const artifactsArr = state?.artifacts ?? EMPTY_ARTIFACTS;
  const meshWorkspace = (state?.mesh_workspace as MeshWorkspaceState | null) ?? null;
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
  const [gpuTelemetry, setGpuTelemetry] = useState<GpuTelemetryResponse | null>(null);
  const liveApi = useMemo(() => currentLiveApiClient(), []);
  const latestEngineMessage = engineLog.length > 0 ? engineLog[engineLog.length - 1]?.message ?? null : null;
  const workspaceStatus =
    runtimeStatus?.code ?? liveState?.status ?? session?.status ?? run?.status ?? "idle";
  const runtimeUsesGpu = runtimeEngineAccelerator === "gpu" || /gpu|cuda/i.test(runtimeEngineLabel ?? "");

  useEffect(() => {
    syncWorkspaceTabsFromArtifacts(
      "analyze",
      artifactsArr.map((artifact) => artifact.path),
    );
  }, [artifactsArr, syncWorkspaceTabsFromArtifacts]);

  useEffect(() => {
    if (!runtimeUsesGpu) {
      setGpuTelemetry(null);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const next = await liveApi.fetchGpuTelemetry();
        if (!cancelled) {
          setGpuTelemetry(next);
        }
      } catch {
        if (!cancelled) {
          setGpuTelemetry(null);
        }
      } finally {
        if (!cancelled) {
          timer = setTimeout(poll, GPU_TELEMETRY_POLL_MS);
        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [liveApi, runtimeUsesGpu]);
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
    setAirMeshVisible(false);
    setAirMeshOpacity(DEFAULT_AIR_MESH_OPACITY);
    setMeshEntityViewState({});
    setSelectedEntityId(null);
    setFocusedEntityId(null);
    setFemArrowColorMode("orientation");
    setFemArrowMonoColor("#00c2ff");
    setFemArrowAlpha(1);
    setFemArrowLengthScale(1);
    setFemArrowThickness(1);
    setFdmVisualizationSettings(DEFAULT_FDM_VISUALIZATION_SETTINGS);
    setActiveVisualizationPresetRef(null);
    lastAppliedVisualizationPresetRef.current = null;
  }, [workspaceHydrationKey]);

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

  const solverNotStartedMessage =
    workspaceStatus === "materializing_script"
      ? (isFemBackend
          ? "Solver has not started yet. FEM materialization and tetrahedral meshing are still in progress."
          : "Solver has not started yet. Workspace materialization is still in progress.")
      : workspaceStatus === "bootstrapping"
        ? "Solver has not started yet. Workspace bootstrap is still in progress."
        : workspaceStatus === "waiting_for_compute"
          ? (isFemBackend
              ? "Waiting for compute — adjust mesh in the control room, then click COMPUTE."
              : "Waiting for compute — inspect the workspace in the control room, then click COMPUTE.")
          : "Solver telemetry is not available yet.";

  const isWaitingForCompute = workspaceStatus === "waiting_for_compute";

  /* Effective solver values (fallback to run manifest when live is stale) */
  const liveIsStale = (liveState?.step ?? 0) === 0 && (run?.total_steps ?? 0) > 0;
  const effectiveStep = liveIsStale ? (run?.total_steps ?? 0) : (liveState?.step ?? run?.total_steps ?? 0);
  const effectiveTime = liveIsStale ? (run?.final_time ?? 0) : (liveState?.time ?? run?.final_time ?? 0);
  const effectiveDt = liveIsStale ? 0 : (liveState?.dt ?? 0);
  const effectiveEEx = liveIsStale ? (run?.final_e_ex ?? 0) : (liveState?.e_ex ?? run?.final_e_ex ?? 0);
  const effectiveEDemag = liveIsStale ? (run?.final_e_demag ?? 0) : (liveState?.e_demag ?? run?.final_e_demag ?? 0);
  const effectiveEExt = liveIsStale ? (run?.final_e_ext ?? 0) : (liveState?.e_ext ?? run?.final_e_ext ?? 0);
  const effectiveEAni = liveIsStale ? (run?.final_e_ani ?? 0) : (liveState?.e_ani ?? run?.final_e_ani ?? 0);
  const effectiveEDmi = liveIsStale ? (run?.final_e_dmi ?? 0) : (liveState?.e_dmi ?? run?.final_e_dmi ?? 0);
  const effectiveETotal = liveIsStale ? (run?.final_e_total ?? 0) : (liveState?.e_total ?? run?.final_e_total ?? 0);
  const effectiveDmDt = liveIsStale ? 0 : (liveState?.max_dm_dt ?? 0);
  const effectiveHEff = liveIsStale ? 0 : (liveState?.max_h_eff ?? 0);
  const effectiveHDemag = liveIsStale ? 0 : (liveState?.max_h_demag ?? 0);

  const effectiveLiveState = useMemo(() => {
    if (!liveState) return null;
    if (!liveIsStale) return liveState;
    return {
      ...liveState,
      step: effectiveStep, time: effectiveTime, dt: effectiveDt,
      e_ex: effectiveEEx, e_demag: effectiveEDemag, e_ext: effectiveEExt, e_ani: effectiveEAni, e_dmi: effectiveEDmi, e_total: effectiveETotal,
      max_dm_dt: effectiveDmDt, max_h_eff: effectiveHEff, max_h_demag: effectiveHDemag,
    };
  }, [liveState, liveIsStale, effectiveStep, effectiveTime, effectiveDt,
      effectiveEEx, effectiveEDemag, effectiveEExt, effectiveEAni, effectiveEDmi, effectiveETotal,
      effectiveDmDt, effectiveHEff, effectiveHDemag]);

  /* Status bar */
  const elapsed = session
    ? (session.finished_at_unix_ms > session.started_at_unix_ms
        ? session.finished_at_unix_ms - session.started_at_unix_ms
        : Date.now() - session.started_at_unix_ms)
    : 0;
  const stepsPerSec = elapsed > 0 ? (effectiveStep / elapsed) * 1000 : 0;

  const solverPlan = useMemo(() => extractSolverPlan(metadata, session), [metadata, session]);
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
    sceneObjects,
    meshPerGeometryPayload,
  } = useModelBuilderActions({
    modelBuilderDefaults,
    sceneDocumentDraft,
    localBuilderDraft,
    remoteSceneDocument,
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

  /* Hydrate solver-settings panel from the actual backend plan on first load. */
  const [solverSettingsHydrated, setSolverSettingsHydrated] = useState(false);
  useEffect(() => {
    builderAutoSync.resetAutoSync();
    pendingMeshConfigSignatureRef.current = null;
    setLastBuiltMeshConfigSignature(null);
    setSolverSettingsHydrated(false);
    setModelBuilderGraph(null);
    setSceneDocumentDraft(null);
  }, [workspaceHydrationKey]);

  useEffect(() => {
    if (solverSettingsHydrated || !solverPlan || scriptBuilder || remoteModelBuilderGraph) return;
    setSolverSettingsState((prev) => ({
      ...prev,
      integrator: solverPlan.integrator ?? prev.integrator,
      fixedTimestep:
        solverPlan.fixedTimestep != null ? String(solverPlan.fixedTimestep) : prev.fixedTimestep,
      relaxAlgorithm: solverPlan.relaxation?.algorithm ?? prev.relaxAlgorithm,
      torqueTolerance:
        solverPlan.relaxation?.torqueTolerance != null
          ? String(solverPlan.relaxation.torqueTolerance)
          : prev.torqueTolerance,
      energyTolerance:
        solverPlan.relaxation?.energyTolerance != null
          ? String(solverPlan.relaxation.energyTolerance)
          : prev.energyTolerance,
      maxRelaxSteps:
        solverPlan.relaxation?.maxSteps != null
          ? String(solverPlan.relaxation.maxSteps)
          : prev.maxRelaxSteps,
    }));
    setSolverSettingsHydrated(true);
  }, [remoteModelBuilderGraph, scriptBuilder, solverPlan, solverSettingsHydrated]);

  useEffect(() => {
    const incomingGraph =
      remoteModelBuilderGraph ?? (scriptBuilder ? buildModelBuilderGraphV2(scriptBuilder) : null);
    if (!workspaceHydrationKey || !incomingGraph) {
      return;
    }
    if (builderAutoSync.isHydrated(workspaceHydrationKey)) {
      return;
    }
    setSolverSettingsState((prev) => ({
      ...prev,
      ...solverSettingsFromBuilder(incomingGraph.study.solver),
    }));
    setMeshOptionsState((prev) => ({
      ...prev,
      ...meshOptionsFromBuilder(incomingGraph.study.mesh_defaults),
    }));
    setModelBuilderGraph(incomingGraph);
    const hydratedScene =
      remoteSceneDocument ??
      buildSceneDocumentFromScriptBuilder({
        revision: incomingGraph.revision,
        initial_state: incomingGraph.study.initial_state,
        ...serializeModelBuilderGraphV2(incomingGraph),
      });
    hydratedScene.study.requested_backend =
      remoteSceneDocument?.study.requested_backend ?? incomingGraph.study.requested_backend;
    hydratedScene.study.requested_device =
      remoteSceneDocument?.study.requested_device ?? incomingGraph.study.requested_device;
    hydratedScene.study.requested_precision =
      remoteSceneDocument?.study.requested_precision ?? incomingGraph.study.requested_precision;
    hydratedScene.study.requested_mode =
      remoteSceneDocument?.study.requested_mode ?? incomingGraph.study.requested_mode;
    setSceneDocumentDraft(hydratedScene);
    setLastBuiltMeshConfigSignature(buildMeshConfigurationSignature(hydratedScene));
    pendingMeshConfigSignatureRef.current = null;
    setSelectedObjectId(hydratedScene.editor.selected_object_id);
    setObjectViewMode(normalizePersistedObjectViewMode(hydratedScene.editor.object_view_mode));
    setFemVectorDomainFilter(hydratedScene.editor.vector_domain_filter ?? "auto");
    setFemFerromagnetVisibilityMode(
      hydratedScene.editor.ferromagnet_visibility_mode ?? "hide",
    );
    setAirMeshVisible(
      airboxDisabledByDefault
        ? false
        : (hydratedScene.editor.air_mesh_visible ?? false),
    );
    setAirMeshOpacity(
      typeof hydratedScene.editor.air_mesh_opacity === "number" &&
        Number.isFinite(hydratedScene.editor.air_mesh_opacity)
        ? hydratedScene.editor.air_mesh_opacity
        : DEFAULT_AIR_MESH_OPACITY,
    );
    setMeshEntityViewState(
      normalizePersistedMeshEntityViewState(hydratedScene.editor.mesh_entity_view_state),
    );
    setSelectedEntityId(hydratedScene.editor.selected_entity_id);
    setFocusedEntityId(hydratedScene.editor.focused_entity_id);
    setActiveVisualizationPresetRef(
      normalizeVisualizationPresetRef(hydratedScene.editor.active_visualization_preset_ref),
    );
    const firstRunStage = incomingGraph.study.stages.find(
      (stage) => stage.kind === "run" && stage.until_seconds.trim().length > 0,
    );
    if (firstRunStage) {
      setRunUntilInput(firstRunStage.until_seconds);
    }
    builderAutoSync.markHydrated(workspaceHydrationKey);
    builderAutoSync.gateAutoSync(2500);
    builderAutoSync.bumpGateVersion();
    builderAutoSync.recordPushSignature(buildScriptBuilderSignature(incomingGraph, {
      solverSettings,
      meshOptions,
      universe: incomingGraph.universe.value,
      demagRealization: incomingGraph.study.demag_realization,
      stages: incomingGraph.study.stages,
      geometries: incomingGraph.objects.items.map((objectNode) => objectNode.geometry),
      currentModules: incomingGraph.current_modules.modules,
      excitationAnalysis: incomingGraph.current_modules.excitation_analysis,
    }));
    setSolverSettingsHydrated(true);
  }, [
    meshOptions,
    remoteSceneDocument,
    remoteModelBuilderGraph,
    scriptBuilder,
    solverSettings,
    workspaceHydrationKey,
  ]);

  useEffect(() => {
    const persistedMeshEntityViewState = serializeMeshEntityViewStateForScene(meshEntityViewState);
    const normalizedActivePresetRef = normalizeVisualizationPresetRef(
      activeVisualizationPresetRef,
    );
    setSceneDocumentDraft((previousScene) => {
      if (!previousScene) {
        return previousScene;
      }
      const previousEditor = previousScene.editor;
      const nextAirMeshOpacity = Number.isFinite(airMeshOpacity)
        ? airMeshOpacity
        : DEFAULT_AIR_MESH_OPACITY;
      if (
        previousEditor.selected_object_id === selectedObjectId &&
        previousEditor.selected_entity_id === selectedEntityId &&
        previousEditor.focused_entity_id === focusedEntityId &&
        previousEditor.object_view_mode === objectViewMode &&
        previousEditor.vector_domain_filter === femVectorDomainFilter &&
        previousEditor.ferromagnet_visibility_mode === femFerromagnetVisibilityMode &&
        previousEditor.active_transform_scope === activeTransformScope &&
        previousEditor.air_mesh_visible === airMeshVisible &&
        previousEditor.air_mesh_opacity === nextAirMeshOpacity &&
        sameVisualizationPresets(
          previousEditor.visualization_presets,
          projectVisualizationPresets,
        ) &&
        sameVisualizationPresetRef(
          previousEditor.active_visualization_preset_ref,
          normalizedActivePresetRef,
        ) &&
        samePersistedMeshEntityViewState(
          previousEditor.mesh_entity_view_state,
          persistedMeshEntityViewState,
        )
      ) {
        return previousScene;
      }
      return {
        ...previousScene,
        editor: {
          ...previousEditor,
          selected_object_id: selectedObjectId,
          selected_entity_id: selectedEntityId,
          focused_entity_id: focusedEntityId,
          object_view_mode: objectViewMode,
          vector_domain_filter: femVectorDomainFilter,
          ferromagnet_visibility_mode: femFerromagnetVisibilityMode,
          active_transform_scope: activeTransformScope,
          air_mesh_visible: airMeshVisible,
          air_mesh_opacity: nextAirMeshOpacity,
          mesh_entity_view_state: persistedMeshEntityViewState,
          visualization_presets: projectVisualizationPresets,
          active_visualization_preset_ref: normalizedActivePresetRef,
        },
      };
    });
  }, [
    airMeshOpacity,
    airMeshVisible,
    femFerromagnetVisibilityMode,
    femVectorDomainFilter,
    activeVisualizationPresetRef,
    focusedEntityId,
    meshEntityViewState,
    objectViewMode,
    projectVisualizationPresets,
    activeTransformScope,
    selectedEntityId,
    selectedObjectId,
  ]);

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
          return existing
            ? {
                ...asset,
                ...existing,
                id: asset.id,
              }
            : asset;
        }),
      };
    });
  }, [modelBuilderGraph, workspaceHydrationKey]);

  /* Scene draft sync is explicit (manual/script sync) — no hidden auto-push effect. */

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.setItem(
        LOCAL_VISUALIZATION_PRESETS_STORAGE_KEY,
        JSON.stringify(localVisualizationPresets),
      );
    } catch {
      // Ignore storage failures (private mode / quota).
    }
  }, [localVisualizationPresets]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      if (activeVisualizationPresetRef) {
        window.localStorage.setItem(
          LOCAL_ACTIVE_VISUALIZATION_PRESET_STORAGE_KEY,
          JSON.stringify(activeVisualizationPresetRef),
        );
      } else {
        window.localStorage.removeItem(LOCAL_ACTIVE_VISUALIZATION_PRESET_STORAGE_KEY);
      }
    } catch {
      // Ignore storage failures (private mode / quota).
    }
  }, [activeVisualizationPresetRef]);

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
    state,
    spatialPreview,
    scriptBuilder,
    runtimeStatus,
    isWaitingForCompute,
  });

  /* Preview derived — keep the user's explicit viewport mode stable.
   * A transient preview payload should not silently downgrade 3D to 2D. */
  const effectiveViewMode = viewMode;
  const requestedDisplaySelection = useMemo<DisplaySelection>(() => {
    if (optimisticDisplaySelection) {
      return optimisticDisplaySelection;
    }
    const quantity =
      displaySelection?.selection.quantity ?? previewConfig?.quantity ?? preview?.quantity ?? "m";
    return {
      quantity,
      kind: displaySelection?.selection.kind ?? kindForQuantity(quantity),
      component:
        displaySelection?.selection.component ??
        previewConfig?.component ??
        spatialPreview?.component ??
        "3D",
      layer:
        displaySelection?.selection.layer ??
        previewConfig?.layer ??
        spatialPreview?.layer ??
        0,
      all_layers:
        displaySelection?.selection.all_layers ??
        previewConfig?.all_layers ??
        spatialPreview?.all_layers ??
        false,
      x_chosen_size:
        displaySelection?.selection.x_chosen_size ??
        previewConfig?.x_chosen_size ??
        spatialPreview?.x_chosen_size ??
        0,
      y_chosen_size:
        displaySelection?.selection.y_chosen_size ??
        previewConfig?.y_chosen_size ??
        spatialPreview?.y_chosen_size ??
        0,
      every_n:
        displaySelection?.selection.every_n ?? previewConfig?.every_n ?? PREVIEW_EVERY_N_DEFAULT,
      max_points:
        displaySelection?.selection.max_points ??
        previewConfig?.max_points ??
        spatialPreview?.max_points ??
        PREVIEW_MAX_POINTS_DEFAULT,
      auto_scale_enabled:
        displaySelection?.selection.auto_scale_enabled ??
        previewConfig?.auto_scale_enabled ??
        spatialPreview?.auto_scale_enabled ??
        true,
    };
  }, [displaySelection, kindForQuantity, optimisticDisplaySelection, preview, previewConfig, spatialPreview]);
  const currentPreviewRevision = displaySelection?.revision ?? previewConfig?.revision ?? null;
  const previewControlsActive = Boolean(displaySelection ?? previewConfig ?? preview);
  const requestedPreviewQuantity = requestedDisplaySelection.quantity;
  const requestedPreviewComponent = requestedDisplaySelection.component;
  const requestedPreviewLayer = requestedDisplaySelection.layer;
  const requestedPreviewAllLayers = requestedDisplaySelection.all_layers;
  const requestedPreviewEveryN = requestedDisplaySelection.every_n;
  const requestedPreviewXChosenSize = requestedDisplaySelection.x_chosen_size;
  const requestedPreviewYChosenSize = requestedDisplaySelection.y_chosen_size;
  const requestedPreviewAutoScale = requestedDisplaySelection.auto_scale_enabled;
  const requestedPreviewMaxPoints = requestedDisplaySelection.max_points;

  const previewEveryNOptions = useMemo(
    () => Array.from(new Set([...PREVIEW_EVERY_N_PRESETS, requestedPreviewEveryN])).sort((a, b) => a - b),
    [requestedPreviewEveryN],
  );
  const previewMaxPointOptions = useMemo(() => {
    const values = new Set<number>([...PREVIEW_MAX_POINTS_PRESETS, requestedPreviewMaxPoints]);
    return Array.from(values).sort((a, b) => { if (a === 0) return 1; if (b === 0) return -1; return a - b; });
  }, [requestedPreviewMaxPoints]);

  const isGlobalScalarQuantity = useCallback(
    (quantity: string | null | undefined) =>
      Boolean(quantity && quantityDescriptorById.get(quantity)?.kind === "global_scalar"),
    [quantityDescriptorById],
  );
  const previewIsStale = Boolean(
    preview &&
    currentPreviewRevision != null &&
    preview.config_revision !== currentPreviewRevision,
  );
  const previewIsBootstrapStale = Boolean(previewControlsActive && preview && effectiveStep > 0 && preview.source_step === 0);
  const displaySelectionPending = optimisticDisplaySelection != null;
  const previewBusy = previewPostInFlight || displaySelectionPending;
  const renderPreview = spatialPreview;
  // `activeQuantityId` is the single source of truth for "what quantity does
  // the user want to see right now".  It is always derived from local
  // `selectedQuantity` state — never from `preview?.quantity`.  The old path
  // read from the backend preview response which introduced coupling between
  // the data-plane (what to render) and the control-plane (what the backend
  // last computed for the preview widget).
  const activeQuantityId = selectedQuantity;
  const isMeshPreview = renderPreview?.spatial_kind === "mesh";
  const previewVectorComponent: VectorComponent =
    renderPreview?.component && renderPreview.component !== "3D"
      ? (renderPreview.component as VectorComponent)
      : "magnitude";
  const effectiveVectorComponent = isMeshPreview ? previewVectorComponent : component;

  const {
    appendFrontendTrace,
    enqueueCommand,
    buildMeshOptionsPayload,
    enqueueStudyDomainRemesh,
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
  });

  /* Visualization presets — extracted to useVisualizationPresets hook */

  // Set of quantity IDs whose field buffers are already cached locally.
  // Used by requestPreviewQuantity and applyVisualizationPreset to skip
  // the control-plane POST when the field is already in memory.
  const cachedFieldQuantities = useMemo<ReadonlySet<string>>(() => {
    const frames = state?.latest_fields?.frames;
    if (!frames) return new Set<string>();
    return new Set(Object.keys(frames));
  }, [state?.latest_fields?.frames]);

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
    requestedPreviewQuantity,
    meshRenderMode,
    meshOpacity,
    meshClipEnabled,
    meshClipAxis,
    meshClipPos,
    meshShowArrows,
    requestedPreviewMaxPoints,
    femArrowColorMode,
    femArrowMonoColor,
    femArrowAlpha,
    femArrowLengthScale,
    femArrowThickness,
    objectViewMode,
    femVectorDomainFilter,
    femFerromagnetVisibilityMode,
    airMeshVisible,
    airMeshOpacity,
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
    setViewMode,
    setComponent,
    setPlane,
    setSliceIndex,
    setMeshRenderMode,
    setMeshOpacity,
    setMeshClipEnabled,
    setMeshClipAxis,
    setMeshClipPos,
    setMeshShowArrows,
    setFemArrowColorMode,
    setFemArrowMonoColor,
    setFemArrowAlpha,
    setFemArrowLengthScale,
    setFemArrowThickness,
    setObjectViewMode,
    setFemVectorDomainFilter,
    setFemFerromagnetVisibilityMode,
    setAirMeshVisible,
    setAirMeshOpacity,
    setMeshEntityViewState,
    setFdmVisualizationSettings,
    updatePreview,
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
    requestPreviewQuantity,
    openResultWorkspaceEntry,
    renameResultWorkspaceEntry,
    removeResultWorkspaceEntry,
    duplicateResultWorkspaceEntry,
    setResultWorkspacePinned,
  } = useWorkspaceActions({
    enqueueCommand,
    updatePreview,
    appendFrontendTrace,
    liveApi,
    builderAutoSync,
    localBuilderDraft,
    localBuilderSignature,
    session,
    isFemBackend,
    workspaceStatus,
    effectiveViewMode,
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
    setMeshRenderMode,
    setMeshClipEnabled,
    setMeshOpacity,
    setComponent,
    setSelectedSidebarNodeId,
    setSelectedQuantity,
    setFocusObjectRequest,
    setScriptBuilderCurrentModules,
    setSceneDocument,
    setWorkspaceMode,
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

  /* Sparklines */
  const eTotalSpark = useMemo(() => scalarRows.slice(-40).map((r) => r.e_total ?? 0), [scalarRows]);
  const dmDtSpark = useMemo(() => scalarRows.slice(-40).map((r) => Math.log10(Math.max(r.max_dm_dt ?? 1e-15, 1e-15))), [scalarRows]);
  const dtSpark = useMemo(() => scalarRows.slice(-40).map((r) => r.solver_dt ?? 0), [scalarRows]);

  /* Quantity options */
  const quantityOptions = useMemo(
    () => (quantities).map((q) => ({
      value: q.id,
      label: q.available ? `${q.label} (${q.unit})` : `${q.label} (${q.unit}) — waiting for data`,
      disabled: !q.available,
    })),
    [quantities],
  );
  const previewQuantityOptions = useMemo(
    () => (quantities).filter((q) => q.interactive_preview).map((q) => ({
      value: q.id,
      label: q.available ? `${q.label} (${q.unit})` : `${q.label} (${q.unit}) — waiting for data`,
      disabled: !q.available,
    })),
    [quantities],
  );

  useEffect(() => {
    const options = quantityOptions;
    if (!options.length) return;
    if (!options.some((opt) => opt.value === selectedQuantity)) {
      const fallback = options.find((opt) => !opt.disabled) ?? options[0];
      setSelectedQuantity(fallback.value);
    }
  }, [quantityOptions, selectedQuantity]);

  useEffect(() => {
    if (requestedPreviewQuantity) setSelectedQuantity(requestedPreviewQuantity);
  }, [requestedPreviewQuantity]);

  const latestFieldFrames = state?.latest_fields.frames ?? {};
  const fieldMap = useMemo<Record<string, Float64Array | null>>(
    () =>
      Object.fromEntries(
        Object.entries(latestFieldFrames).map(([quantityId, frame]) => [
          quantityId,
          frame.values,
        ]),
      ) as Record<string, Float64Array | null>,
    [latestFieldFrames],
  );
  const selectedFieldFrame = activeQuantityId ? latestFieldFrames[activeQuantityId] ?? null : null;
  const selectedFieldNComp =
    selectedFieldFrame?.n_comp
    ?? (activeQuantityId ? quantityDescriptorById.get(activeQuantityId)?.n_comp ?? 3 : 3);
  const selectedFieldDomain =
    (selectedFieldFrame?.domain as "magnetic_only" | "full_domain" | "surface_only" | null | undefined)
    ?? null;
  const renderPreviewMatchesActiveQuantity = renderPreview?.quantity === activeQuantityId;

  const selectedVectors = useMemo(() => {
    if (isGlobalScalarQuantity(activeQuantityId)) return null;
    const liveField = fieldMap[activeQuantityId] ?? null;
    // In FEM mode prefer full-resolution live vectors from latest_fields/live_state.
    // Preview payloads can be decimated or stale right after scene-document texture edits.
    if (isFemBackend && liveField && liveField.length > 0) {
      return liveField;
    }
    if (renderPreviewMatchesActiveQuantity && renderPreview?.vector_field_values) {
      return renderPreview.vector_field_values;
    }
    return liveField;
  }, [
    activeQuantityId,
    fieldMap,
    isFemBackend,
    isGlobalScalarQuantity,
    renderPreviewMatchesActiveQuantity,
    renderPreview?.vector_field_values,
  ]);

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
        available: quantity.available,
      })),
    [quantities],
  );

  const selectedScalarValue = useMemo(() => {
    return globalScalarPreview?.value ?? null;
  }, [globalScalarPreview]);
  const selectedQuantityLabel = quantityDescriptor?.label ?? requestedPreviewQuantity;
  const selectedQuantityUnit = quantityDescriptor?.unit ?? null;
  const activeQuantityEntryId = useMemo(() => {
    if (!requestedPreviewQuantity) {
      return null;
    }
    return (
      resultWorkspaceEntries.find(
        (entry) => entry.kind === "quantity" && entry.quantityId === requestedPreviewQuantity,
      )?.id ?? null
    );
  }, [requestedPreviewQuantity, resultWorkspaceEntries]);

  useEffect(() => {
    if (!requestedPreviewQuantity) {
      return;
    }
    const badge = selectedQuantityUnit ?? null;
    addResultWorkspaceEntry({
      key: `auto:quantity:${requestedPreviewQuantity}`,
      kind: "quantity",
      label: selectedQuantityLabel,
      quantityId: requestedPreviewQuantity,
      badge,
      openAfterCreate: false,
    });
  }, [
    addResultWorkspaceEntry,
    requestedPreviewQuantity,
    selectedQuantityLabel,
    selectedQuantityUnit,
  ]);

  useEffect(() => {
    if (!requestedPreviewQuantity || activeResultWorkspaceId != null) {
      return;
    }
    if (activeQuantityEntryId && activeResultWorkspaceId !== activeQuantityEntryId) {
      setActiveResultWorkspaceId(activeQuantityEntryId);
    }
  }, [activeQuantityEntryId, activeResultWorkspaceId, requestedPreviewQuantity]);

  useEffect(() => {
    const hasSpectrumArtifact = artifactsArr.some(
      (artifact) =>
        artifact.path === "eigen/spectrum.json" ||
        artifact.path === "eigen/metadata/eigen_summary.json",
    );
    if (!hasSpectrumArtifact) {
      return;
    }
    addResultWorkspaceEntry({
      key: "auto:eigen:spectrum",
      kind: "spectrum",
      label: "Eigen Spectrum",
      badge: "auto",
      openAfterCreate: false,
    });
  }, [addResultWorkspaceEntry, artifactsArr]);

  useEffect(() => {
    if (viewMode !== "Analyze") {
      return;
    }
    const descriptor =
      analyzeSelection.domain === "vortex"
        ? (analyzeSelection.tab === "time-traces"
            ? { key: "auto:vortex:time-traces", kind: "time-traces", label: "Vortex Time Traces" }
            : analyzeSelection.tab === "vortex-frequency"
              ? { key: "auto:vortex:frequency", kind: "vortex-frequency", label: "Vortex FFT / PSD" }
              : analyzeSelection.tab === "vortex-orbit"
                ? { key: "auto:vortex:orbit", kind: "vortex-orbit", label: "Vortex Orbit Amplitude" }
                : { key: "auto:vortex:trajectory", kind: "vortex-trajectory", label: "Vortex Trajectory" })
        : (analyzeSelection.tab === "dispersion"
            ? { key: "auto:eigen:dispersion", kind: "dispersion", label: "Eigen Dispersion" }
            : analyzeSelection.tab === "modes"
              ? { key: "auto:eigen:modes", kind: "modes", label: "Mode Inspector" }
              : { key: "auto:eigen:spectrum", kind: "spectrum", label: "Eigen Spectrum" });
    const id = addResultWorkspaceEntry({
      key: descriptor.key,
      kind: descriptor.kind as ResultWorkspaceKind,
      label: descriptor.label,
      openAfterCreate: false,
    });
    if (activeResultWorkspaceId !== id) {
      setActiveResultWorkspaceId(id);
    }
  }, [
    activeResultWorkspaceId,
    addResultWorkspaceEntry,
    analyzeSelection.domain,
    analyzeSelection.tab,
    viewMode,
  ]);

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
    activeMask,
    spatialPreview,
    meshShowArrows,
    effectiveViewMode,
    activeQuantityId,
    isFemBackend,
    meshGenerating,
    commandStatus,
    meshSummary,
    meshWorkspace,
    selectedSidebarNodeId,
    selectedObjectId,
    airMeshVisible,
    airMeshOpacity,
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
    meshRenderMode,
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
    effectiveStep, effectiveTime, effectiveDt, effectiveDmDt, effectiveHEff, effectiveHDemag,
    effectiveEEx, effectiveEDemag, effectiveEExt, effectiveEAni, effectiveEDmi, effectiveETotal,
    elapsed, stepsPerSec,
    liveState, effectiveLiveState, scalarRows,
    dmDtSpark, dtSpark, eTotalSpark,
    preview, selectedVectors, fieldStats, hasSolverTelemetry,
  }), [
    effectiveStep, effectiveTime, effectiveDt, effectiveDmDt, effectiveHEff, effectiveHDemag,
    effectiveEEx, effectiveEDemag, effectiveEExt, effectiveEAni, effectiveEDmi, effectiveETotal,
    elapsed, stepsPerSec,
    liveState, effectiveLiveState, scalarRows,
    dmDtSpark, dtSpark, eTotalSpark,
    preview, selectedVectors, fieldStats, hasSolverTelemetry,
  ]);

  const viewportValue = useMemo<ViewportContextValue>(() => ({
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
    requestedPreviewMaxPoints, previewEveryNOptions, previewMaxPointOptions,
    previewIsStale, previewIsBootstrapStale,
    setViewMode, setComponent, setPlane, setSliceIndex, setSelectedQuantity,
    setConsoleCollapsed, setSidebarCollapsed,
    updatePreview, handleViewModeChange, handleCapture, handleExport, requestPreviewQuantity,
  }), [
    setWorkspaceMode,
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
    requestedPreviewMaxPoints, previewEveryNOptions, previewMaxPointOptions,
    previewIsStale, previewIsBootstrapStale,
    updatePreview, handleViewModeChange, handleCapture, handleExport, requestPreviewQuantity,
  ]);

  const commandValue = useMemo<CommandContextValue>(() => ({
    connection, error, session, run, metadata, engineLog: mergedEngineLog, quantities, artifacts: artifactsArr,
    workspaceStatus, isWaitingForCompute, solverNotStartedMessage, isFemBackend, runtimeEngineLabel,
    runtimeEngineGpuLabel, runtimeEngineGpuDevice,
    activity, sessionFooter, runtimeStatus, stageExecution, runtimeCanAcceptCommands,
    commandStatus, activeCommandKind, activeCommandState,
    canRunCommand, canRelaxCommand, canPauseCommand, canStopCommand, canSkipCommand: false, primaryRunAction, primaryRunLabel,
    interactiveEnabled, interactiveControlsEnabled, awaitingCommand, commandBusy, commandMessage,
    latestBackendError,
    scriptSyncBusy, scriptSyncMessage, stateIoBusy, stateIoMessage, scriptInitialState, scriptBuilderGeometries, scriptBuilderCurrentModules, scriptBuilderExcitationAnalysis, runUntilInput,
    setRunUntilInput, enqueueCommand, handleCompute, handleSimulationAction,
    handleStateExport, handleStateImport, syncScriptBuilder,
  }), [
    connection, error, session, run, metadata, mergedEngineLog, quantities, artifactsArr,
    workspaceStatus, isWaitingForCompute, solverNotStartedMessage, isFemBackend, runtimeEngineLabel,
    runtimeEngineGpuLabel, runtimeEngineGpuDevice,
    activity, sessionFooter, runtimeStatus, stageExecution, runtimeCanAcceptCommands,
    commandStatus, activeCommandKind, activeCommandState,
    canRunCommand, canRelaxCommand, canPauseCommand, canStopCommand, primaryRunAction, primaryRunLabel,
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
      setMeshRenderMode(result.globals.meshRenderMode as RenderMode);
      setMeshOpacity(result.globals.meshOpacity);
      setMeshClipEnabled(result.globals.meshClipEnabled);
      setMeshClipAxis(result.globals.meshClipAxis as ClipAxis);
      setMeshClipPos(result.globals.meshClipPos);
      setMeshShowArrows(result.globals.meshShowArrows);
      setAirMeshVisible(result.globals.airMeshVisible);
      setAirMeshOpacity(result.globals.airMeshOpacity);
    }
  }, [
    selectedSidebarNodeId, selectedObjectId, selectedEntityId,
    meshParts, meshEntityViewState, visibleMeshPartIds,
  ]);

  const modelValue = useMemo<ModelContextValue>(() => ({
    sceneDocument: localBuilderDraft,
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
    },
    material, solverPlan, solverSettings, studyStages, studyPipeline, scriptBuilderDemagRealization, scriptBuilderUniverse, scriptBuilderGeometries, scriptBuilderCurrentModules, scriptBuilderExcitationAnalysis, antennaOverlays, objectOverlays, femMesh,
    meshRenderMode, meshOpacity, meshClipEnabled, meshClipAxis, meshClipPos, meshShowArrows,
    femArrowColorMode, femArrowMonoColor, femArrowAlpha, femArrowLengthScale, femArrowThickness,
    femVectorDomainFilter, femFerromagnetVisibilityMode,
    fdmVisualizationSettings,
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
    selectedSidebarNodeId,
    selectedObjectId,
    viewportScope,
    focusObjectRequest,
    objectViewMode,
    activeTransformScope,
    airMeshVisible,
    airMeshOpacity,
    meshEntityViewState,
    visibleSubmeshSnapshot,
    selectedEntityId,
    focusedEntityId,
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
    setSolverSettings, setSceneDocument, setRequestedRuntimeSelection, setStudyStages, setStudyPipeline, setScriptBuilderDemagRealization, setScriptBuilderUniverse, setScriptBuilderGeometries, setScriptBuilderCurrentModules, setScriptBuilderExcitationAnalysis, setMeshRenderMode, setMeshOpacity, setMeshClipEnabled, setMeshClipAxis,
    setMeshClipPos, setMeshShowArrows, setFemArrowColorMode, setFemArrowMonoColor, setFemArrowAlpha, setFemArrowLengthScale, setFemArrowThickness, setFdmVisualizationSettings, setMeshSelection, setMeshOptions, setFemDockTab,
    setFemVectorDomainFilter, setFemFerromagnetVisibilityMode,
    setSelectedSidebarNodeId, setSelectedObjectId, setViewportScope, setObjectViewMode, setActiveTransformScope, setAirMeshVisible, setAirMeshOpacity, setMeshEntityViewState, setVisibleSubmeshSnapshot, setSelectedEntityId, setFocusedEntityId, setAnalyzeSelection, openAnalyze, selectAnalyzeTab, selectAnalyzeMode, refreshAnalyze, addResultWorkspaceEntry, openResultWorkspaceEntry, renameResultWorkspaceEntry, removeResultWorkspaceEntry, duplicateResultWorkspaceEntry, setResultWorkspacePinned, requestFocusObject, applyAntennaTranslation, applyGeometryTranslation, handleStudyDomainMeshGenerate, handleAirboxMeshGenerate, handleObjectMeshOverrideRebuild, handleLassoRefine, openFemMeshWorkspace, applyMeshWorkspacePreset,
    openWorkspaceTab, activateWorkspaceTab, closeWorkspaceTab, pinWorkspaceTab,
    createVisualizationPreset, setActiveVisualizationPresetRef, applyVisualizationPreset, renameVisualizationPreset, duplicateVisualizationPreset, deleteVisualizationPreset, copyVisualizationPresetToSource, updateVisualizationPreset,
    resetViewportDisplayState,
  }), [
    localBuilderDraft, modelBuilderGraph, material, solverPlan, solverSettings, studyStages, studyPipeline, scriptBuilderDemagRealization, scriptBuilderUniverse, scriptBuilderGeometries, scriptBuilderCurrentModules, scriptBuilderExcitationAnalysis, antennaOverlays, objectOverlays, femMesh,
    meshRenderMode, meshOpacity, meshClipEnabled, meshClipAxis, meshClipPos, meshShowArrows,
    femArrowColorMode, femArrowMonoColor, femArrowAlpha, femArrowLengthScale, femArrowThickness,
    femVectorDomainFilter, femFerromagnetVisibilityMode,
    fdmVisualizationSettings, projectVisualizationPresets, localVisualizationPresets, activeVisualizationPresetRef,
    meshSelection, meshOptions, meshQualityData, meshGenerating, femDockTab,
    effectiveFemMesh, femMeshData, femTopologyKey, femColorField,
    femMagnetization3DActive, femShouldShowArrows, arrowVisibility, isMeshWorkspaceView,
    meshFaceDetail, meshQualitySummary, meshWorkspace,
    meshConfigDirty, meshConfigSignature, lastBuiltMeshConfigSignature,
    meshSummary, meshName, meshSource, meshExtent, meshBoundsMin, meshBoundsMax, meshFeOrder, liveMeshName,
    domainFrame, worldExtent, worldCenter, worldExtentSource, meshHmax, mesherBackend, mesherSourceKind, mesherCurrentSettings,
    meshWorkspacePreset,
    selectedSidebarNodeId, selectedObjectId, viewportScope, focusObjectRequest, objectViewMode, airMeshVisible, airMeshOpacity, meshEntityViewState, visibleSubmeshSnapshot, selectedEntityId, focusedEntityId, meshParts, visibleMeshPartIds, visibleMagneticObjectIds, selectedMeshPart, focusedMeshPart, magneticParts, airPart, interfaceParts, analyzeSelection, resultWorkspaceEntries, activeResultWorkspaceId, workspaceTabs, activeWorkspaceTabId, requestFocusObject,
    setSceneDocument, setRequestedRuntimeSelection, setStudyStages, setStudyPipeline, setScriptBuilderDemagRealization, setScriptBuilderUniverse, setScriptBuilderGeometries, setScriptBuilderCurrentModules, setScriptBuilderExcitationAnalysis,
    handleStudyDomainMeshGenerate, handleAirboxMeshGenerate, handleObjectMeshOverrideRebuild, handleLassoRefine, openFemMeshWorkspace, applyMeshWorkspacePreset, createVisualizationPreset, setActiveVisualizationPresetRef, applyVisualizationPreset, renameVisualizationPreset, duplicateVisualizationPreset, deleteVisualizationPreset, copyVisualizationPresetToSource, updateVisualizationPreset, openAnalyze, selectAnalyzeTab, selectAnalyzeMode, refreshAnalyze, addResultWorkspaceEntry, openResultWorkspaceEntry, renameResultWorkspaceEntry, removeResultWorkspaceEntry, duplicateResultWorkspaceEntry, setResultWorkspacePinned, openWorkspaceTab, activateWorkspaceTab, closeWorkspaceTab, pinWorkspaceTab,
    applyAntennaTranslation, applyGeometryTranslation, setMeshOptions, setSolverSettings, activeTransformScope,
    resetViewportDisplayState,
  ]);

  if (!state) {
    return (
      <div className="flex flex-col items-center justify-center h-full w-full">
        <div className="flex flex-col items-center gap-3 text-muted-foreground animate-pulse">
          <div className="w-8 h-8 border-2 border-current border-t-transparent rounded-full animate-spin" />
          <span className="text-sm font-medium tracking-wide">Connecting to live workspace…</span>
        </div>
      </div>
    );
  }

  return (
    <TransportCtx.Provider value={transportValue}>
      <ViewportCtx.Provider value={viewportValue}>
        <CommandCtx.Provider value={commandValue}>
          <ModelCtx.Provider value={modelValue}>
            {children}
          </ModelCtx.Provider>
        </CommandCtx.Provider>
      </ViewportCtx.Provider>
    </TransportCtx.Provider>
  );
}
  const airboxDisabledByDefault =
    FRONTEND_DIAGNOSTIC_FLAGS.femViewport.airboxDisabledByDefault;
