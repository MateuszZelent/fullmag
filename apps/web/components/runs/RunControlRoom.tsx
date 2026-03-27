"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import { currentLiveApiClient } from "../../lib/liveApiClient";
import { useCurrentLiveStream } from "../../lib/useSessionStream";
import EngineConsole from "../panels/EngineConsole";
import { DEFAULT_MESH_OPTIONS } from "../panels/MeshSettingsPanel";
import type { MeshOptionsState, MeshQualityData } from "../panels/MeshSettingsPanel";
import { DEFAULT_SOLVER_SETTINGS } from "../panels/SolverSettingsPanel";
import type { SolverSettingsState } from "../panels/SolverSettingsPanel";
import type { ClipAxis, FemColorField, FemMeshData, MeshSelectionSnapshot, RenderMode } from "../preview/FemMeshView3D";
import TitleBar from "../shell/TitleBar";
import MenuBar from "../shell/MenuBar";
import RibbonBar from "../shell/RibbonBar";
import StatusBar from "../shell/StatusBar";
import FemWorkspacePanel from "./control-room/FemWorkspacePanel";
import RunSidebar from "./control-room/RunSidebar";
import { ViewportBar, ViewportCanvasArea } from "./control-room/ViewportPanels";
import type { ViewportBarProps, ViewportCanvasAreaProps } from "./control-room/ViewportPanels";
import {
  type FemDockTab,
  type SlicePlane,
  type VectorComponent,
  type ViewportMode,
  FEM_SLICE_COUNT,
  PANEL_SIZES,
  PREVIEW_EVERY_N_DEFAULT,
  PREVIEW_EVERY_N_PRESETS,
  SCALAR_FIELDS,
  asVec3,
  computeMeshFaceDetail,
  fmtDuration,
  fmtSI,
  fmtSIOrDash,
  fmtStepValue,
  materializationProgressFromMessage,
  parseStageExecutionMessage,
} from "./control-room/shared";
import s from "./RunControlRoom.module.css";

/* ── Component ─────────────────────────────────────────────── */

export default function RunControlRoom() {
  const { state, connection, error } = useCurrentLiveStream();
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
  const [runUntilInput, setRunUntilInput] = useState("1e-12");
  const [selectedSidebarNodeId, setSelectedSidebarNodeId] = useState<string | null>(null);
  const [commandBusy, setCommandBusy] = useState(false);
  const [commandMessage, setCommandMessage] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewMessage, setPreviewMessage] = useState<string | null>(null);
  const [meshOptions, setMeshOptions] = useState<MeshOptionsState>(DEFAULT_MESH_OPTIONS);
  const [meshQualityData, setMeshQualityData] = useState<MeshQualityData | null>(null);
  const [meshGenerating, setMeshGenerating] = useState(false);
  const [solverSettings, setSolverSettings] = useState<SolverSettingsState>(DEFAULT_SOLVER_SETTINGS);
  const [solverSetupOpen, setSolverSetupOpen] = useState(false);
  const [meshSelection, setMeshSelection] = useState<MeshSelectionSnapshot>({
    selectedFaceIndices: [],
    primaryFaceIndex: null,
  });

  const session = state?.session;
  const run = state?.run;
  const liveState = state?.live_state;
  const previewConfig = state?.preview_config ?? null;
  const preview = state?.preview ?? null;
  const femMesh = state?.fem_mesh ?? null;
  const scalarRows = state?.scalar_rows ?? [];
  const engineLog = state?.engine_log ?? [];
  const latestEngineMessage = engineLog.length > 0 ? engineLog[engineLog.length - 1]?.message ?? null : null;
  const workspaceStatus = liveState?.status ?? session?.status ?? run?.status ?? "idle";
  const hasSolverTelemetry =
    (liveState?.step ?? 0) > 0 ||
    (run?.total_steps ?? 0) > 0 ||
    scalarRows.length > 0 ||
    workspaceStatus === "completed" ||
    workspaceStatus === "failed";
  const solverNotStartedMessage =
    workspaceStatus === "materializing_script"
      ? "Solver has not started yet. FEM materialization and tetrahedral meshing are still in progress."
      : workspaceStatus === "bootstrapping"
        ? "Solver has not started yet. Workspace bootstrap is still in progress."
        : "Solver telemetry is not available yet.";

  /* When live_state is stale (step===0) but the run manifest has real data,
     fall back to run values so solver/energy panels show actual progress. */
  const liveIsStale = (liveState?.step ?? 0) === 0 && (run?.total_steps ?? 0) > 0;
  const effectiveStep = liveIsStale ? (run?.total_steps ?? 0) : (liveState?.step ?? run?.total_steps ?? 0);
  const effectiveTime = liveIsStale ? (run?.final_time ?? 0) : (liveState?.time ?? run?.final_time ?? 0);
  const effectiveDt = liveIsStale ? 0 : (liveState?.dt ?? 0);
  const effectiveEEx = liveIsStale ? (run?.final_e_ex ?? 0) : (liveState?.e_ex ?? run?.final_e_ex ?? 0);
  const effectiveEDemag = liveIsStale ? (run?.final_e_demag ?? 0) : (liveState?.e_demag ?? run?.final_e_demag ?? 0);
  const effectiveEExt = liveIsStale ? (run?.final_e_ext ?? 0) : (liveState?.e_ext ?? run?.final_e_ext ?? 0);
  const effectiveETotal = liveIsStale ? (run?.final_e_total ?? 0) : (liveState?.e_total ?? run?.final_e_total ?? 0);
  const effectiveDmDt = liveIsStale ? 0 : (liveState?.max_dm_dt ?? 0);
  const effectiveHEff = liveIsStale ? 0 : (liveState?.max_h_eff ?? 0);
  const effectiveHDemag = liveIsStale ? 0 : (liveState?.max_h_demag ?? 0);

  /* Construct a patched liveState for EngineConsole so its Live tab also
     shows run-manifest data when the SSE live state is stale. */
  const effectiveLiveState = liveState && liveIsStale ? {
    ...liveState,
    step: effectiveStep,
    time: effectiveTime,
    dt: effectiveDt,
    e_ex: effectiveEEx,
    e_demag: effectiveEDemag,
    e_ext: effectiveEExt,
    e_total: effectiveETotal,
    max_dm_dt: effectiveDmDt,
    max_h_eff: effectiveHEff,
    max_h_demag: effectiveHDemag,
  } : liveState;

  /* StatusBar metrics */
  const elapsed = session
    ? (session.finished_at_unix_ms > session.started_at_unix_ms
        ? session.finished_at_unix_ms - session.started_at_unix_ms
        : Date.now() - session.started_at_unix_ms)
    : 0;
  const stepsPerSec = elapsed > 0
    ? (effectiveStep / elapsed) * 1000
    : 0;

  const isMeshPreview = preview?.spatial_kind === "mesh";



  /* Detect FEM */
  const planSummary = session?.plan_summary as Record<string, unknown> | undefined;
  const resolvedBackend =
    (typeof planSummary?.resolved_backend === "string" ? planSummary.resolved_backend : null) ??
    (typeof session?.requested_backend === "string" ? session.requested_backend : null);
  const isFemBackend = resolvedBackend === "fem" || femMesh != null || preview?.spatial_kind === "mesh";
  const metadata = state?.metadata as Record<string, unknown> | null;
  const runtimeEngine =
    (metadata?.runtime_engine as Record<string, unknown> | undefined) ?? undefined;
  const runtimeEngineLabel =
    typeof runtimeEngine?.engine_label === "string" ? runtimeEngine.engine_label : null;
  const currentStage = useMemo(
    () => parseStageExecutionMessage(latestEngineMessage),
    [latestEngineMessage],
  );
  const activity = useMemo(() => {
    if (workspaceStatus === "materializing_script") {
      const progressValue = materializationProgressFromMessage(latestEngineMessage);
      const isLongGmshPhase = (latestEngineMessage ?? "").toLowerCase().includes("generating 3d tetrahedral mesh");
      return {
        label: isFemBackend ? "Materializing FEM workspace" : "Materializing workspace",
        detail: latestEngineMessage ?? "Preparing geometry import and execution plan",
        progressMode: isLongGmshPhase ? "indeterminate" as const : "determinate" as const,
        progressValue,
      };
    }

    if (workspaceStatus === "bootstrapping") {
      return {
        label: "Bootstrapping workspace",
        detail: latestEngineMessage ?? "Starting local API and control room",
        progressMode: "indeterminate" as const,
        progressValue: undefined,
      };
    }

    if (workspaceStatus === "running") {
      const stageLabel = currentStage
        ? `Solving ${currentStage.kind} — stage ${currentStage.current}/${currentStage.total}`
        : "Running solver";
      return {
        label: stageLabel,
        detail:
          effectiveStep > 0
            ? `Step ${effectiveStep.toLocaleString()} · t=${fmtSI(effectiveTime, "s")} · ${runtimeEngineLabel ?? session?.requested_backend?.toUpperCase() ?? "runtime"}`
            : latestEngineMessage ?? "Solver startup in progress",
        progressMode: "indeterminate" as const,
        progressValue: undefined,
      };
    }

    if (workspaceStatus === "awaiting_command") {
      return {
        label: "Interactive workspace ready",
        detail: latestEngineMessage ?? "Waiting for the next run or relax command",
        progressMode: "determinate" as const,
        progressValue: 100,
      };
    }

    if (workspaceStatus === "completed") {
      return {
        label: "Run completed",
        detail: latestEngineMessage ?? "Solver finished successfully",
        progressMode: "determinate" as const,
        progressValue: 100,
      };
    }

    if (workspaceStatus === "failed") {
      return {
        label: "Run failed",
        detail: latestEngineMessage ?? "Execution stopped with an error",
        progressMode: "determinate" as const,
        progressValue: 100,
      };
    }

    return {
      label: "Workspace idle",
      detail: latestEngineMessage ?? "No active task",
      progressMode: "idle" as const,
      progressValue: undefined,
    };
  }, [
    effectiveStep,
    effectiveTime,
    currentStage,
    isFemBackend,
    latestEngineMessage,
    runtimeEngineLabel,
    session?.requested_backend,
    workspaceStatus,
  ]);
  const artifactLayout = (metadata?.artifact_layout as Record<string, unknown> | undefined) ?? undefined;
  const executionPlan = (metadata?.execution_plan as Record<string, unknown> | undefined) ?? undefined;
  const backendPlan = (executionPlan?.backend_plan as Record<string, unknown> | undefined) ?? undefined;
  const femArtifactLayout =
    artifactLayout?.backend === "fem" ? artifactLayout : undefined;
  const meshBoundsMin = asVec3(femArtifactLayout?.bounds_min);
  const meshBoundsMax = asVec3(femArtifactLayout?.bounds_max);
  const meshExtent = asVec3(femArtifactLayout?.world_extent);
  const meshName = typeof femArtifactLayout?.mesh_name === "string" ? femArtifactLayout.mesh_name : null;
  const meshSource = typeof femArtifactLayout?.mesh_source === "string" ? femArtifactLayout.mesh_source : null;
  const meshFeOrder = typeof femArtifactLayout?.fe_order === "number" ? femArtifactLayout.fe_order : null;
  const meshHmax = typeof femArtifactLayout?.hmax === "number" ? femArtifactLayout.hmax : null;
  const meshingCapabilities = (metadata?.meshing_capabilities as Record<string, unknown> | undefined) ?? undefined;
  const mesherBackend = typeof meshingCapabilities?.backend === "string" ? meshingCapabilities.backend : null;
  const mesherSourceKind =
    typeof meshingCapabilities?.source_kind === "string" ? meshingCapabilities.source_kind : null;
  const mesherCurrentSettings =
    (meshingCapabilities?.current_settings as Record<string, unknown> | undefined) ?? undefined;


  /* Grid / mesh info — memoized to a stable reference so that a new array from every SSE
     tick does not re-trigger Three.js scene init inside MagnetizationView3D. */
  const _rawSolverGrid = liveState?.grid ?? state?.latest_fields.grid;
  const solverGrid = useMemo<[number, number, number]>(
    () => [_rawSolverGrid?.[0] ?? 0, _rawSolverGrid?.[1] ?? 0, _rawSolverGrid?.[2] ?? 0],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [_rawSolverGrid?.[0], _rawSolverGrid?.[1], _rawSolverGrid?.[2]],
  );
  const _rawPreviewGrid = preview?.preview_grid ?? liveState?.preview_grid ?? state?.latest_fields.grid ?? solverGrid;
  const previewGrid = useMemo<[number, number, number]>(
    () => [_rawPreviewGrid?.[0] ?? 0, _rawPreviewGrid?.[1] ?? 0, _rawPreviewGrid?.[2] ?? 0],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [_rawPreviewGrid?.[0], _rawPreviewGrid?.[1], _rawPreviewGrid?.[2]],
  );
  const totalCells = !isFemBackend ? solverGrid[0] * solverGrid[1] * solverGrid[2] : null;
  const activeCells = useMemo(() => {
    if (typeof artifactLayout?.active_cell_count === "number") return artifactLayout.active_cell_count;
    return totalCells;
  }, [artifactLayout, totalCells]);
  const inactiveCells = useMemo(() => {
    if (typeof artifactLayout?.inactive_cell_count === "number") return artifactLayout.inactive_cell_count;
    if (activeCells != null && totalCells != null) return Math.max(totalCells - activeCells, 0);
    return null;
  }, [activeCells, artifactLayout, totalCells]);
  const activeMaskPresent = artifactLayout?.active_mask_present === true;
  const interactiveEnabled = session?.interactive_session_requested === true;
  const awaitingCommand = session?.status === "awaiting_command";
  const interactiveControlsEnabled = interactiveEnabled && (awaitingCommand || session?.status === "running");
  const liveApi = useMemo(() => currentLiveApiClient(), []);
  const previewDrivenMode: ViewportMode | null =
    preview && !isFemBackend ? (preview.type === "3D" ? "3D" : "2D") : null;
  const effectiveViewMode = previewDrivenMode ?? viewMode;
  const previewControlsActive = Boolean(previewConfig ?? preview);
  const requestedPreviewQuantity =
    previewConfig?.quantity ?? preview?.quantity ?? selectedQuantity;
  const requestedPreviewComponent =
    previewConfig?.component ?? preview?.component ?? "3D";
  const requestedPreviewLayer = previewConfig?.layer ?? preview?.layer ?? 0;
  const requestedPreviewAllLayers =
    previewConfig?.all_layers ?? preview?.all_layers ?? false;
  const requestedPreviewEveryN =
    previewConfig?.every_n ?? PREVIEW_EVERY_N_DEFAULT;
  const requestedPreviewXChosenSize =
    previewConfig?.x_chosen_size ?? preview?.x_chosen_size ?? 0;
  const requestedPreviewYChosenSize =
    previewConfig?.y_chosen_size ?? preview?.y_chosen_size ?? 0;
  const requestedPreviewAutoScale =
    previewConfig?.auto_scale_enabled ?? preview?.auto_scale_enabled ?? true;
  const previewEveryNOptions = useMemo(
    () =>
      Array.from(new Set([...PREVIEW_EVERY_N_PRESETS, requestedPreviewEveryN])).sort(
        (a, b) => a - b,
      ),
    [requestedPreviewEveryN],
  );
  const previewIsStale =
    Boolean(preview && previewConfig && preview.config_revision !== previewConfig.revision);
  const previewVectorComponent: VectorComponent =
    preview?.component && preview.component !== "3D"
      ? (preview.component as VectorComponent)
      : "magnitude";
  const effectiveVectorComponent = isMeshPreview ? previewVectorComponent : component;

  const enqueueCommand = useCallback(async (payload: Record<string, unknown>) => {
    setCommandBusy(true);
    setCommandMessage(null);
    try {
      await liveApi.queueCommand(payload);
      setCommandMessage(`Queued ${String(payload.kind)}`);
    } catch (commandError) {
      setCommandMessage(
        commandError instanceof Error ? commandError.message : "Failed to queue command",
      );
    } finally {
      setCommandBusy(false);
    }
  }, [liveApi]);

  const updatePreview = useCallback(async (path: string, payload: Record<string, unknown> = {}) => {
    setPreviewBusy(true);
    setPreviewMessage(null);
    try {
      await liveApi.updatePreview(path, payload);
    } catch (previewError) {
      setPreviewMessage(
        previewError instanceof Error ? previewError.message : "Failed to update preview",
      );
    } finally {
      setPreviewBusy(false);
    }
  }, [liveApi]);

  /* ── Mesh generation handler ── */
  const handleMeshGenerate = useCallback(async () => {
    setMeshGenerating(true);
    try {
      const opts = meshOptions;
      await liveApi.queueCommand({
        kind: "remesh",
        mesh_options: {
          algorithm_2d: opts.algorithm2d,
          algorithm_3d: opts.algorithm3d,
          hmin: opts.hmin ? parseFloat(opts.hmin) : null,
          size_factor: opts.sizeFactor,
          size_from_curvature: opts.sizeFromCurvature,
          smoothing_steps: opts.smoothingSteps,
          optimize: opts.optimize || null,
          optimize_iterations: opts.optimizeIters,
          compute_quality: opts.computeQuality,
          per_element_quality: opts.perElementQuality,
        },
      });
    } catch (err) {
      setCommandMessage(
        err instanceof Error ? err.message : "Mesh generation failed",
      );
    } finally {
      setMeshGenerating(false);
    }
  }, [meshOptions, liveApi]);

  const openFemMeshWorkspace = useCallback((tab: "mesh" | "quality" = "mesh") => {
    setViewMode("Mesh");
    setFemDockTab(tab);
    setMeshRenderMode((current) => (current === "surface" ? "surface+edges" : current));
  }, []);

  const handleViewModeChange = useCallback((mode: string) => {
    if (mode === "Mesh" && isFemBackend) {
      openFemMeshWorkspace("mesh");
      return;
    }
    setViewMode(mode as ViewportMode);
  }, [isFemBackend, openFemMeshWorkspace]);


  /* Keyboard shortcuts: 1=3D, 2=2D, 3=Mesh */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "1") setViewMode("3D");
      else if (e.key === "2") setViewMode("2D");
      else if (e.key === "3" && isFemBackend) openFemMeshWorkspace("mesh");
      else if (e.key === "`" && e.ctrlKey) { e.preventDefault(); setConsoleCollapsed((v) => !v); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isFemBackend, openFemMeshWorkspace]);

  /* Sparkline data extraction — guard against undefined from backend */
  const eTotalSpark = useMemo(() => scalarRows.slice(-40).map((r) => r.e_total ?? 0), [scalarRows]);
  const dmDtSpark = useMemo(() => scalarRows.slice(-40).map((r) => Math.log10(Math.max(r.max_dm_dt ?? 1e-15, 1e-15))), [scalarRows]);
  const dtSpark = useMemo(() => scalarRows.slice(-40).map((r) => r.solver_dt ?? 0), [scalarRows]);

  /* Quantities */
  const quantityOptions = useMemo(
    () =>
      (state?.quantities ?? [])
        .map((q) => ({
          value: q.id,
          label: q.available
            ? `${q.label} (${q.unit})`
            : `${q.label} (${q.unit}) — waiting for data`,
          disabled: !q.available,
        })),
    [state?.quantities],
  );

  const previewQuantityOptions = useMemo(
    () =>
      (state?.quantities ?? [])
        .filter((q) => q.kind === "vector_field")
        .map((q) => ({
          value: q.id,
          label: q.available
            ? `${q.label} (${q.unit})`
            : `${q.label} (${q.unit}) — waiting for data`,
          disabled: !q.available,
        })),
    [state?.quantities],
  );

  useEffect(() => {
    const options = previewControlsActive ? previewQuantityOptions : quantityOptions;
    if (!options.length) return;
    if (!options.some((opt) => opt.value === selectedQuantity)) {
      const fallback = options.find((opt) => !opt.disabled) ?? options[0];
      setSelectedQuantity(fallback.value);
    }
  }, [previewControlsActive, previewQuantityOptions, quantityOptions, selectedQuantity]);

  useEffect(() => {
    if (requestedPreviewQuantity) {
      setSelectedQuantity(requestedPreviewQuantity);
    }
  }, [requestedPreviewQuantity]);

  const quantityDescriptor = useMemo(
    () =>
      state?.quantities.find((q) => q.id === (preview?.quantity ?? requestedPreviewQuantity)) ??
      null,
    [preview?.quantity, requestedPreviewQuantity, state?.quantities],
  );

  /* Field data */
  const fieldMap = useMemo(
    () => ({
      m: preview?.quantity === "m" && preview.vector_field_values
        ? preview.vector_field_values
        : liveState?.magnetization ?? state?.latest_fields.m ?? null,
      H_ex: state?.latest_fields.h_ex ?? null,
      H_demag: state?.latest_fields.h_demag ?? null,
      H_ext: state?.latest_fields.h_ext ?? null,
      H_eff: state?.latest_fields.h_eff ?? null,
    }),
    [
      liveState?.magnetization,
      preview?.quantity,
      preview?.type,
      preview?.vector_field_values,
      state?.latest_fields.h_demag,
      state?.latest_fields.h_eff,
      state?.latest_fields.h_ex,
      state?.latest_fields.h_ext,
      state?.latest_fields.m,
    ],
  );

  const selectedVectors = useMemo(() => {
    if (preview?.vector_field_values) {
      return new Float64Array(preview.vector_field_values);
    }
    const values = fieldMap[(preview?.quantity ?? selectedQuantity) as keyof typeof fieldMap] ?? null;
    return values ? new Float64Array(values) : null;
  }, [fieldMap, preview?.quantity, preview?.vector_field_values, selectedQuantity]);

  /* FEM mesh data */
  const effectiveFemMesh = useMemo(
    () => (isMeshPreview && preview?.fem_mesh ? preview.fem_mesh : femMesh),
    [femMesh, isMeshPreview, preview?.fem_mesh],
  );
  const [flatNodes, flatFaces] = useMemo(() => {
    if (!effectiveFemMesh) return [null, null];
    return [
      effectiveFemMesh.nodes.flatMap((node) => node),
      effectiveFemMesh.boundary_faces.flatMap((face) => face),
    ];
  }, [effectiveFemMesh]);

  const femMeshData = useMemo<FemMeshData | null>(() => {
    if (!isFemBackend || !effectiveFemMesh || !flatNodes || !flatFaces) return null;
    const nNodes = effectiveFemMesh.nodes.length;
    const nElements = femMesh?.elements.length ?? effectiveFemMesh.elements.length;
    let fieldData: FemMeshData["fieldData"] | undefined;
    if (selectedVectors && selectedVectors.length >= nNodes * 3) {
      const x = new Array<number>(nNodes);
      const y = new Array<number>(nNodes);
      const z = new Array<number>(nNodes);
      for (let i = 0; i < nNodes; i++) {
        x[i] = selectedVectors[i * 3] ?? 0;
        y[i] = selectedVectors[i * 3 + 1] ?? 0;
        z[i] = selectedVectors[i * 3 + 2] ?? 0;
      }
      fieldData = { x, y, z };
    }
    return { nodes: flatNodes, boundaryFaces: flatFaces, nNodes, nElements, fieldData };
  }, [isFemBackend, effectiveFemMesh, femMesh?.elements.length, flatNodes, flatFaces, selectedVectors]);

  const femHasFieldData = Boolean(femMeshData?.fieldData);
  const femMagnetization3DActive =
    isFemBackend &&
    effectiveViewMode === "3D" &&
    (preview?.quantity ?? selectedQuantity) === "m" &&
    femHasFieldData;
  const femShouldShowArrows = isFemBackend && effectiveViewMode === "3D" && femHasFieldData
    ? meshShowArrows
    : false;

  const femTopologyKey = useMemo(() => {
    if (!effectiveFemMesh) return null;
    return `${effectiveFemMesh.nodes.length}:${femMesh?.elements.length ?? effectiveFemMesh.elements.length}:${effectiveFemMesh.boundary_faces.length}`;
  }, [effectiveFemMesh, femMesh?.elements.length]);

  const femColorField = useMemo<FemColorField>(() => {
    const quantityId = preview?.quantity ?? selectedQuantity;
    if (quantityId === "m" && effectiveViewMode === "3D" && femHasFieldData) {
      return "orientation";
    }
    if (effectiveVectorComponent === "x") return "x";
    if (effectiveVectorComponent === "y") return "y";
    if (effectiveVectorComponent === "z") return "z";
    return "magnitude";
  }, [effectiveVectorComponent, effectiveViewMode, femHasFieldData, preview?.quantity, selectedQuantity]);

  useEffect(() => {
    setMeshSelection({ selectedFaceIndices: [], primaryFaceIndex: null });
  }, [femTopologyKey]);

  const isMeshWorkspaceView = isFemBackend && effectiveViewMode === "Mesh";
  const meshFaceDetail = useMemo(
    () => computeMeshFaceDetail(effectiveFemMesh, meshSelection.primaryFaceIndex),
    [effectiveFemMesh, meshSelection.primaryFaceIndex],
  );

  const meshQualitySummary = useMemo(() => {
    if (!effectiveFemMesh) return null;
    const nodes = effectiveFemMesh.nodes;
    const faces = effectiveFemMesh.boundary_faces;
    if (!nodes.length || !faces.length) return null;

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    let good = 0;
    let fair = 0;
    let poor = 0;

    for (const [ia, ib, ic] of faces) {
      const a = nodes[ia];
      const b = nodes[ib];
      const c = nodes[ic];
      if (!a || !b || !c) continue;
      const ab = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const bc = Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]);
      const ca = Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]);
      const maxEdge = Math.max(ab, bc, ca);
      const s2 = (ab + bc + ca) / 2;
      const area = Math.sqrt(Math.max(0, s2 * (s2 - ab) * (s2 - bc) * (s2 - ca)));
      const inradius = s2 > 0 ? area / s2 : 0;
      const ar = inradius > 1e-18 ? maxEdge / (2 * inradius) : 1;
      min = Math.min(min, ar);
      max = Math.max(max, ar);
      sum += ar;
      if (ar < 3) good += 1;
      else if (ar < 6) fair += 1;
      else poor += 1;
    }

    const count = faces.length;
    return {
      min,
      max,
      mean: count > 0 ? sum / count : 0,
      good,
      fair,
      poor,
      count,
    };
  }, [effectiveFemMesh]);

  /* Slice count */
  const maxSliceCount = useMemo(() => {
    if (preview?.spatial_kind === "grid") return 1;
    if (isFemBackend && femMeshData) return FEM_SLICE_COUNT;
    if (plane === "xy") return Math.max(1, previewGrid[2]);
    if (plane === "xz") return Math.max(1, previewGrid[1]);
    return Math.max(1, previewGrid[0]);
  }, [femMeshData, isFemBackend, plane, preview?.spatial_kind, previewGrid]);

  useEffect(() => {
    if (sliceIndex >= maxSliceCount) setSliceIndex(Math.max(0, maxSliceCount - 1));
  }, [maxSliceCount, sliceIndex]);

  /* Derived stats for sidebar */
  const fieldStats = useMemo(() => {
    if (!selectedVectors) return null;
    const n = isFemBackend ? (effectiveFemMesh?.nodes.length ?? 0) : Math.floor(selectedVectors.length / 3);
    if (n <= 0 || selectedVectors.length < n * 3) return null;
    let sumX = 0, sumY = 0, sumZ = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const vx = selectedVectors[i * 3], vy = selectedVectors[i * 3 + 1], vz = selectedVectors[i * 3 + 2];
      sumX += vx; sumY += vy; sumZ += vz;
      if (vx < minX) minX = vx; if (vx > maxX) maxX = vx;
      if (vy < minY) minY = vy; if (vy > maxY) maxY = vy;
      if (vz < minZ) minZ = vz; if (vz > maxZ) maxZ = vz;
    }
    const inv = 1 / n;
    return {
      meanX: sumX * inv, meanY: sumY * inv, meanZ: sumZ * inv,
      minX, minY, minZ, maxX, maxY, maxZ,
    };
  }, [selectedVectors, isFemBackend, effectiveFemMesh]);

  /* Material from metadata */
  const material = useMemo(() => {
    if (!backendPlan) return null;
    const femPlan = backendPlan.Fem as Record<string, unknown> | undefined;
    const fdmPlan = backendPlan.Fdm as Record<string, unknown> | undefined;
    const src = femPlan ?? fdmPlan;
    if (!src) return null;
    const mat = src.material as Record<string, unknown> | undefined;
    return {
      msat: typeof mat?.msat === "number" ? mat.msat : null,
      aex: typeof mat?.aex === "number" ? mat.aex : null,
      alpha: typeof mat?.alpha === "number" ? mat.alpha : null,
      exchangeEnabled: src.enable_exchange === true,
      demagEnabled: src.enable_demag === true,
      zeemanField: Array.isArray(src.zeeman_field) ? src.zeeman_field as number[] : null,
    };
  }, [backendPlan]);

  const isVectorQuantity = quantityDescriptor?.kind === "vector_field";

  const selectedScalarValue = useMemo(() => {
    const scalarKey = SCALAR_FIELDS[selectedQuantity];
    if (!scalarKey) return null;
    const lastRow = scalarRows[scalarRows.length - 1];
    return lastRow ? lastRow[scalarKey as keyof typeof lastRow] ?? null : null;
  }, [scalarRows, selectedQuantity]);

  const emptyStateMessage = useMemo(() => {
    if (isFemBackend && !femMeshData) {
      if (workspaceStatus === "materializing_script") {
        return {
          title: "Materializing FEM mesh",
          description:
            latestEngineMessage ??
            "Importing geometry and preparing the FEM mesh. The surface preview will appear here as soon as the execution plan is ready.",
        };
      }
      if (workspaceStatus === "bootstrapping") {
        return {
          title: "Bootstrapping live workspace",
          description:
            latestEngineMessage ??
            "Starting the local workspace and waiting for the first FEM planning snapshot.",
        };
      }
      return {
        title: "Waiting for FEM preview data",
        description:
          latestEngineMessage ??
          "The mesh topology is not available yet. Check the log tab for the current phase.",
      };
    }
    if (workspaceStatus === "materializing_script") {
      return {
        title: "Materializing workspace",
        description:
          latestEngineMessage ??
          "Preparing the problem description and first preview state.",
      };
    }
    return {
      title: "No preview data yet",
      description:
        latestEngineMessage ??
        "Waiting for the first live field snapshot from the solver.",
    };
  }, [femMeshData, isFemBackend, latestEngineMessage, workspaceStatus]);

  const requestPreviewQuantity = useCallback((nextQuantity: string) => {
    if (isFemBackend && effectiveViewMode === "Mesh") {
      setViewMode("3D");
    }
    if (previewControlsActive) {
      void updatePreview("/quantity", { quantity: nextQuantity });
    } else {
      setSelectedQuantity(nextQuantity);
    }
  }, [effectiveViewMode, isFemBackend, previewControlsActive, updatePreview]);

  const quickPreviewTargets = useMemo(
    () =>
      [
        { id: "m", shortLabel: "M" },
        { id: "H_ex", shortLabel: "H_ex" },
        { id: "H_demag", shortLabel: "H_demag" },
        { id: "H_ext", shortLabel: "H_ext" },
        { id: "H_eff", shortLabel: "H_eff" },
      ].map((entry) => {
        const option = previewQuantityOptions.find((candidate) => candidate.value === entry.id);
        return {
          ...entry,
          available: option ? !option.disabled : entry.id === "m",
        };
      }),
    [previewQuantityOptions],
  );

  /* ── Loading state ─────────────────────────────── */
  if (!state) {
    return (
      <div className={s.loadingShell}>
        {error
          ? `Connection error: ${error}`
          : "Connecting to local live workspace…"}
      </div>
    );
  }

  /* ── Shared viewport props (avoid duplication) ── */
  const viewportBarProps: ViewportBarProps = {
    isMeshWorkspaceView, meshName, effectiveFemMesh, meshRenderMode, meshSelection,
    previewControlsActive, requestedPreviewQuantity, requestedPreviewComponent,
    requestedPreviewEveryN, requestedPreviewXChosenSize, requestedPreviewYChosenSize,
    requestedPreviewAutoScale, requestedPreviewLayer, requestedPreviewAllLayers,
    previewBusy, previewQuantityOptions, quantityOptions, previewEveryNOptions,
    preview, effectiveViewMode, solverGrid, plane, sliceIndex, maxSliceCount, component,
    updatePreview, setSelectedQuantity, setComponent, setPlane, setSliceIndex,
  };

  const viewportCanvasProps: ViewportCanvasAreaProps = {
    effectiveStep, effectiveTime, effectiveDmDt, isVectorQuantity, quantityDescriptor,
    selectedScalarValue, preview, effectiveViewMode, isFemBackend, femMeshData,
    femTopologyKey, femColorField, femMagnetization3DActive, femShouldShowArrows,
    meshRenderMode, meshOpacity, meshClipEnabled, meshClipAxis, meshClipPos,
    selectedQuantity, effectiveVectorComponent, plane, sliceIndex, maxSliceCount,
    selectedVectors, previewGrid, component, emptyStateMessage,
    setMeshRenderMode, setMeshOpacity, setMeshClipEnabled, setMeshClipAxis,
    setMeshClipPos, setMeshShowArrows, setMeshSelection,
  };

  const previewNotices = (
    <>
      {(preview?.auto_downscaled || liveState?.preview_auto_downscaled) && (
        <div
          className={s.previewNotice}
          title={preview?.auto_downscale_message ?? liveState?.preview_auto_downscale_message ?? undefined}
        >
          {preview?.auto_downscale_message ??
            liveState?.preview_auto_downscale_message ??
            `Preview auto-scaled to ${previewGrid[0]}×${previewGrid[1]}×${previewGrid[2]}`}
        </div>
      )}
      {(previewMessage || previewIsStale) && (
        <div className={s.previewStatus}>
          {previewMessage ?? "Preview update pending"}
        </div>
      )}
    </>
  );

  const sessionFooter = { requestedBackend: session?.requested_backend ?? null, scriptPath: session?.script_path ?? null, artifactDir: session?.artifact_dir ?? null };
  const femWorkspaceProps = {
    workspaceStatus, femDockTab, setFemDockTab, openFemMeshWorkspace, effectiveFemMesh, meshFeOrder, meshHmax,
    isMeshWorkspaceView, effectiveViewMode, handleViewModeChange, meshRenderMode, setMeshRenderMode,
    meshFaceDetail, meshSelection, setMeshSelection, meshName, meshSource, meshExtent, meshBoundsMin, meshBoundsMax,
    mesherBackend, mesherSourceKind, mesherCurrentSettings: mesherCurrentSettings ?? null, meshOptions, setMeshOptions,
    meshQualityData, meshGenerating, handleMeshGenerate, previewControlsActive, requestedPreviewQuantity,
    previewQuantityOptions, previewBusy, updatePreview, setSelectedQuantity, requestedPreviewComponent,
    component, setComponent, requestedPreviewEveryN, previewEveryNOptions, meshOpacity, setMeshOpacity,
    meshShowArrows, setMeshShowArrows, meshClipEnabled, setMeshClipEnabled, meshClipAxis, setMeshClipAxis,
    meshClipPos, setMeshClipPos, meshQualitySummary, viewportBarProps, viewportCanvasProps, previewNotices,
  };
  const sidebarProps = {
    isFemBackend, workspaceStatus, effectiveStep, effectiveTime, effectiveDt, effectiveDmDt, effectiveHEff,
    effectiveHDemag, effectiveEEx, effectiveEDemag, effectiveEExt, effectiveETotal, hasSolverTelemetry,
    solverNotStartedMessage, solverSetupOpen, interactiveControlsEnabled, awaitingCommand, commandBusy,
    commandMessage, runUntilInput, setRunUntilInput, enqueueCommand, solverSettings, setSolverSettings,
    runtimeEngineLabel, sessionFooter, selectedSidebarNodeId, setSelectedSidebarNodeId, femDockTab,
    previewControlsActive, requestedPreviewQuantity, requestedPreviewComponent, requestedPreviewEveryN,
    requestedPreviewAutoScale, previewBusy, preview, previewQuantityOptions, previewEveryNOptions,
    quickPreviewTargets, requestPreviewQuantity, updatePreview, material, effectiveFemMesh, femMesh,
    femMeshData, effectiveViewMode, solverGrid, totalCells, activeCells, inactiveCells, activeMaskPresent,
    scalarRows, fieldStats, meshQualitySummary, meshName, meshSource, meshExtent, meshBoundsMin, meshBoundsMax,
    meshFeOrder, meshHmax, mesherBackend, mesherSourceKind, mesherCurrentSettings: mesherCurrentSettings ?? null,
    meshGenerating, handleMeshGenerate, openFemMeshWorkspace, setViewMode, setFemDockTab, setMeshRenderMode,
    dmDtSpark, dtSpark, eTotalSpark,
  };
  const handleSimulationAction = useCallback((action: string) => {
    if (action === "run") void enqueueCommand({ kind: "run" });
    if (action === "pause") void enqueueCommand({ kind: "pause" });
    if (action === "stop") void enqueueCommand({ kind: "stop" });
  }, [enqueueCommand]);

  return (
    <div className={s.shell}>
      <TitleBar
        problemName={session?.problem_name ?? "Local Live Workspace"}
        backend={session?.requested_backend ?? ""}
        runtimeEngine={runtimeEngineLabel ?? undefined}
        status={workspaceStatus}
        connection={connection}
      />
      <MenuBar
        viewMode={effectiveViewMode}
        interactiveEnabled={interactiveEnabled}
        onViewChange={handleViewModeChange}
        onSidebarToggle={() => setSidebarCollapsed((v) => !v)}
        onSimAction={handleSimulationAction}
      />
      <RibbonBar
        viewMode={effectiveViewMode}
        isFemBackend={isFemBackend}
        solverRunning={workspaceStatus === "running"}
        sidebarVisible={!sidebarCollapsed}
        onViewChange={handleViewModeChange}
        onSidebarToggle={() => setSidebarCollapsed((v) => !v)}
        onSimAction={handleSimulationAction}
        onSetup={() => setSolverSetupOpen((v) => !v)}
      />
      <PanelGroup
        orientation="horizontal"
        className={s.body}
        resizeTargetMinimumSize={{ coarse: 40, fine: 12 }}
      >
      <Panel
        id="workspace-main"
        defaultSize={sidebarCollapsed ? "100%" : PANEL_SIZES.bodyMainDefault}
        minSize={PANEL_SIZES.bodyMainMin}
      >
      {/* ═══════ MAIN AREA (viewport + console) ═══════ */}
      <PanelGroup
        orientation="vertical"
        className={s.main}
        resizeTargetMinimumSize={{ coarse: 40, fine: 10 }}
      >
      <Panel
        id="workspace-viewport"
        defaultSize={PANEL_SIZES.viewportDefault}
        minSize={PANEL_SIZES.viewportMin}
      >
      {isFemBackend ? (
        <PanelGroup
          orientation="horizontal"
          className={s.workspaceSplit}
          resizeTargetMinimumSize={{ coarse: 40, fine: 12 }}
        >
          <FemWorkspacePanel {...femWorkspaceProps} />
        </PanelGroup>
      ) : (
      <div className={s.viewport}>
        <ViewportBar {...viewportBarProps} />
        {previewNotices}
        <ViewportCanvasArea {...viewportCanvasProps} />
      </div>
      )}

      </Panel>

      {/* ═══════ RESIZE HANDLE (viewport ↔ console) ═══ */}
      <PanelResizeHandle className={s.resizeHandle} />

      {/* ═══════ BOTTOM CONSOLE ═══════════════════════ */}
      <Panel
        id="workspace-console"
        defaultSize={PANEL_SIZES.consoleDefault}
        minSize={PANEL_SIZES.consoleMin}
        maxSize={PANEL_SIZES.consoleMax}
        collapsible
        collapsedSize="3%"
      >
        <div className={s.console}>
          <EngineConsole
            session={session ?? null}
            run={run ?? null}
            liveState={effectiveLiveState ?? null}
            scalarRows={scalarRows}
            engineLog={engineLog}
            artifacts={state?.artifacts ?? []}
            connection={connection}
            error={error}
            presentationMode="current"
          />
        </div>
      </Panel>
      </PanelGroup>
      {/* end of vertical PanelGroup (viewport + console) */}
      </Panel>
      {/* end of main content Panel */}

      {/* ═══════ RIGHT SIDEBAR (resizable panel) ════ */}
      {!sidebarCollapsed && (
        <>
        <PanelResizeHandle className={s.sidebarResizeHandle} />
        <Panel
          id="workspace-sidebar"
          defaultSize={PANEL_SIZES.sidebarDefault}
          minSize={PANEL_SIZES.sidebarMin}
          maxSize={PANEL_SIZES.sidebarMax}
          collapsible
          collapsedSize="0%"
        >
          <RunSidebar {...sidebarProps} />
        </Panel>
        </>
      )}
      </PanelGroup>

      {/* ═══════ STATUS BAR ════════════════════════════ */}
      <StatusBar
        connection={connection}
        step={effectiveLiveState?.step ?? run?.total_steps ?? 0}
        stepDisplay={fmtStepValue(effectiveLiveState?.step ?? run?.total_steps ?? 0, hasSolverTelemetry)}
        simTime={fmtSIOrDash(effectiveLiveState?.time ?? run?.final_time ?? 0, "s", hasSolverTelemetry)}
        wallTime={elapsed > 0 ? fmtDuration(elapsed) : "—"}
        throughput={stepsPerSec > 0 ? `${stepsPerSec.toFixed(1)} st/s` : "—"}
        backend={session?.requested_backend ?? ""}
        runtimeEngine={runtimeEngineLabel ?? undefined}
        precision={session?.precision ?? ""}
        status={workspaceStatus}
        activityLabel={activity.label}
        activityDetail={activity.detail}
        progressMode={activity.progressMode}
        progressValue={activity.progressValue}
        nodeCount={isFemBackend && femMesh
          ? `${femMesh.nodes.length.toLocaleString()} nodes`
          : totalCells && totalCells > 0
          ? `${totalCells.toLocaleString()} cells`
          : undefined}
      />
    </div>
  );
}
