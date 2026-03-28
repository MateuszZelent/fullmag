"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import { currentLiveApiClient } from "../../../lib/liveApiClient";
import { useCurrentLiveStream } from "../../../lib/useSessionStream";
import type {
  ArtifactEntry,
  EngineLogEntry,
  FemLiveMesh,
  LiveState,
  PreviewState,
  QuantityDescriptor,
  RunManifest,
  ScalarRow,
  SessionManifest,
} from "../../../lib/useSessionStream";
import { DEFAULT_SOLVER_SETTINGS } from "../../panels/SolverSettingsPanel";
import type { SolverSettingsState } from "../../panels/SolverSettingsPanel";
import { DEFAULT_MESH_OPTIONS } from "../../panels/MeshSettingsPanel";
import type { MeshOptionsState, MeshQualityData } from "../../panels/MeshSettingsPanel";
import type {
  ClipAxis,
  FemColorField,
  FemMeshData,
  MeshSelectionSnapshot,
  RenderMode,
} from "../../preview/FemMeshView3D";
import {
  type FemDockTab,
  type SlicePlane,
  type VectorComponent,
  type ViewportMode,
  FEM_SLICE_COUNT,
  PREVIEW_EVERY_N_DEFAULT,
  PREVIEW_EVERY_N_PRESETS,
  PREVIEW_MAX_POINTS_DEFAULT,
  PREVIEW_MAX_POINTS_PRESETS,
  SCALAR_FIELDS,
  asVec3,
  computeMeshFaceDetail,
  fmtDuration,
  fmtSI,
  materializationProgressFromMessage,
  parseOptionalNumber,
  parseStageExecutionMessage,
} from "./shared";

/* ── Stable empty arrays ── */
const EMPTY_SCALAR_ROWS: ScalarRow[] = [];
const EMPTY_ENGINE_LOG: EngineLogEntry[] = [];

/* ── Activity descriptor ── */
export interface ActivityInfo {
  label: string;
  detail: string;
  progressMode: "idle" | "indeterminate" | "determinate";
  progressValue: number | undefined;
}

/* ── Material summary ── */
export interface MaterialSummary {
  msat: number | null;
  aex: number | null;
  alpha: number | null;
  exchangeEnabled: boolean;
  demagEnabled: boolean;
  zeemanField: number[] | null;
  name: string | null;
}

export interface SolverAdaptiveSummary {
  atol: number | null;
  dtInitial: number | null;
  dtMin: number | null;
  dtMax: number | null;
  safety: number | null;
}

export interface SolverRelaxationSummary {
  algorithm: string | null;
  torqueTolerance: number | null;
  energyTolerance: number | null;
  maxSteps: number | null;
}

export interface SolverPlanSummary {
  backendKind: string | null;
  requestedBackend: string | null;
  resolvedBackend: string | null;
  executionMode: string | null;
  precision: string | null;
  integrator: string | null;
  fixedTimestep: number | null;
  adaptive: SolverAdaptiveSummary | null;
  relaxation: SolverRelaxationSummary | null;
  gyromagneticRatio: number | null;
  exchangeBoundary: string | null;
  externalField: [number, number, number] | null;
  exchangeEnabled: boolean;
  demagEnabled: boolean;
  cellSize: [number, number, number] | null;
  gridCells: [number, number, number] | null;
  meshName: string | null;
  meshSource: string | null;
  feOrder: number | null;
  hmax: number | null;
  materialName: string | null;
  materialMsat: number | null;
  materialAex: number | null;
  materialAlpha: number | null;
  notes: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function extractSolverPlan(
  metadata: Record<string, unknown> | null,
  session: SessionManifest | null,
): SolverPlanSummary | null {
  const executionPlan = asRecord(metadata?.execution_plan);
  const backendPlan = asRecord(executionPlan?.backend_plan);
  if (!backendPlan) return null;

  const common = asRecord(executionPlan?.common);
  const material = asRecord(backendPlan.material);
  const adaptive = asRecord(backendPlan.adaptive_timestep);
  const relaxation = asRecord(backendPlan.relaxation);
  const planSummary = asRecord(session?.plan_summary);

  return {
    backendKind: asString(backendPlan.kind),
    requestedBackend:
      asString(common?.requested_backend) ?? asString(planSummary?.requested_backend) ?? session?.requested_backend ?? null,
    resolvedBackend:
      asString(common?.resolved_backend) ?? asString(planSummary?.resolved_backend) ?? null,
    executionMode:
      asString(common?.execution_mode) ?? asString(planSummary?.execution_mode) ?? session?.execution_mode ?? null,
    precision: asString(backendPlan.precision) ?? session?.precision ?? null,
    integrator: asString(backendPlan.integrator),
    fixedTimestep: asNumber(backendPlan.fixed_timestep),
    adaptive: adaptive
      ? {
          atol: asNumber(adaptive.atol),
          dtInitial: asNumber(adaptive.dt_initial),
          dtMin: asNumber(adaptive.dt_min),
          dtMax: asNumber(adaptive.dt_max),
          safety: asNumber(adaptive.safety),
        }
      : null,
    relaxation: relaxation
      ? {
          algorithm: asString(relaxation.algorithm),
          torqueTolerance: asNumber(relaxation.torque_tolerance),
          energyTolerance: asNumber(relaxation.energy_tolerance),
          maxSteps: asNumber(relaxation.max_steps),
        }
      : null,
    gyromagneticRatio: asNumber(backendPlan.gyromagnetic_ratio),
    exchangeBoundary: asString(backendPlan.exchange_bc),
    externalField: asVec3(backendPlan.external_field),
    exchangeEnabled: backendPlan.enable_exchange === true,
    demagEnabled: backendPlan.enable_demag === true,
    cellSize: asVec3(backendPlan.cell_size),
    gridCells: asVec3(asRecord(backendPlan.grid)?.cells),
    meshName: asString(backendPlan.mesh_name),
    meshSource: asString(backendPlan.mesh_source),
    feOrder: asNumber(backendPlan.fe_order),
    hmax: asNumber(backendPlan.hmax),
    materialName: asString(material?.name),
    materialMsat: asNumber(material?.saturation_magnetisation),
    materialAex: asNumber(material?.exchange_stiffness),
    materialAlpha: asNumber(material?.damping),
    notes: asStringArray(planSummary?.notes),
  };
}

/* ── Preview option ── */
export interface PreviewOption {
  value: string;
  label: string;
  disabled: boolean;
}

/* ── Quick preview target ── */
export interface QuickPreviewTarget {
  id: string;
  shortLabel: string;
  available: boolean;
}

/* ── Session footer ── */
export interface SessionFooterData {
  requestedBackend: string | null;
  scriptPath: string | null;
  artifactDir: string | null;
}

/* ── Field stats ── */
export interface FieldStats {
  meanX: number; meanY: number; meanZ: number;
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

/* ── Mesh quality summary ── */
export interface MeshQualitySummary {
  min: number; max: number; mean: number;
  good: number; fair: number; poor: number;
  count: number;
}

/* ── Context shape ── */
export interface ControlRoomState {
  /* Connection */
  connection: "connecting" | "connected" | "disconnected";
  error: string | null;

  /* Raw session data */
  session: SessionManifest | null;
  run: RunManifest | null;
  liveState: LiveState | null;
  effectiveLiveState: LiveState | null;
  preview: PreviewState | null;
  femMesh: FemLiveMesh | null;
  scalarRows: ScalarRow[];
  engineLog: EngineLogEntry[];
  quantities: QuantityDescriptor[];
  artifacts: ArtifactEntry[];
  metadata: Record<string, unknown> | null;

  /* Workspace status */
  workspaceStatus: string;
  hasSolverTelemetry: boolean;
  solverNotStartedMessage: string;
  isFemBackend: boolean;
  runtimeEngineLabel: string | null;
  activity: ActivityInfo;
  sessionFooter: SessionFooterData;

  /* Effective solver telemetry */
  effectiveStep: number;
  effectiveTime: number;
  effectiveDt: number;
  effectiveDmDt: number;
  effectiveHEff: number;
  effectiveHDemag: number;
  effectiveEEx: number;
  effectiveEDemag: number;
  effectiveEExt: number;
  effectiveETotal: number;

  /* Status bar extras */
  elapsed: number;
  stepsPerSec: number;

  /* View state */
  viewMode: ViewportMode;
  effectiveViewMode: ViewportMode;
  component: VectorComponent;
  plane: SlicePlane;
  sliceIndex: number;
  selectedQuantity: string;
  consoleCollapsed: boolean;
  sidebarCollapsed: boolean;

  /* Mesh state */
  meshRenderMode: RenderMode;
  meshOpacity: number;
  meshClipEnabled: boolean;
  meshClipAxis: ClipAxis;
  meshClipPos: number;
  meshShowArrows: boolean;
  meshSelection: MeshSelectionSnapshot;
  meshOptions: MeshOptionsState;
  meshQualityData: MeshQualityData | null;
  meshGenerating: boolean;

  /* FEM dock */
  femDockTab: FemDockTab;

  /* Solver settings */
  solverSettings: SolverSettingsState;
  solverSetupOpen: boolean;

  /* Interactive */
  interactiveEnabled: boolean;
  interactiveControlsEnabled: boolean;
  awaitingCommand: boolean;
  commandBusy: boolean;
  commandMessage: string | null;
  runUntilInput: string;

  /* Preview config */
  previewBusy: boolean;
  previewMessage: string | null;
  previewControlsActive: boolean;
  requestedPreviewQuantity: string;
  requestedPreviewComponent: string;
  requestedPreviewLayer: number;
  requestedPreviewAllLayers: boolean;
  requestedPreviewEveryN: number;
  requestedPreviewXChosenSize: number;
  requestedPreviewYChosenSize: number;
  requestedPreviewAutoScale: boolean;
  requestedPreviewMaxPoints: number;
  previewEveryNOptions: number[];
  previewMaxPointOptions: number[];
  previewIsStale: boolean;
  previewIsBootstrapStale: boolean;

  /* Quantity options */
  quantityOptions: PreviewOption[];
  previewQuantityOptions: PreviewOption[];
  quantityDescriptor: QuantityDescriptor | null;
  isVectorQuantity: boolean;
  quickPreviewTargets: QuickPreviewTarget[];
  selectedScalarValue: number | null;

  /* Grid / topology */
  solverGrid: [number, number, number];
  previewGrid: [number, number, number];
  totalCells: number | null;
  activeCells: number | null;
  inactiveCells: number | null;
  activeMaskPresent: boolean;
  activeMask: boolean[] | null;
  maxSliceCount: number;

  /* FEM derived */
  effectiveFemMesh: FemLiveMesh | null;
  femMeshData: FemMeshData | null;
  femTopologyKey: string | null;
  femColorField: FemColorField;
  femMagnetization3DActive: boolean;
  femShouldShowArrows: boolean;
  isMeshWorkspaceView: boolean;
  meshFaceDetail: ReturnType<typeof computeMeshFaceDetail>;
  meshQualitySummary: MeshQualitySummary | null;

  /* Field data */
  selectedVectors: Float64Array | null;
  effectiveVectorComponent: VectorComponent;
  fieldStats: FieldStats | null;

  /* Material */
  material: MaterialSummary | null;
  solverPlan: SolverPlanSummary | null;

  /* Sparklines */
  dmDtSpark: number[];
  dtSpark: number[];
  eTotalSpark: number[];

  /* Mesh metadata */
  meshName: string | null;
  meshSource: string | null;
  meshExtent: [number, number, number] | null;
  meshBoundsMin: [number, number, number] | null;
  meshBoundsMax: [number, number, number] | null;
  meshFeOrder: number | null;
  /** Physical world extent [x,y,z] in metres — works for both FDM and FEM */
  worldExtent: [number, number, number] | null;
  meshHmax: number | null;
  mesherBackend: string | null;
  mesherSourceKind: string | null;
  mesherCurrentSettings: Record<string, unknown> | null;

  /* Sidebar */
  selectedSidebarNodeId: string | null;

  /* Empty state */
  emptyStateMessage: { title: string; description: string };
}

export interface ControlRoomActions {
  setViewMode: React.Dispatch<React.SetStateAction<ViewportMode>>;
  setComponent: React.Dispatch<React.SetStateAction<VectorComponent>>;
  setPlane: React.Dispatch<React.SetStateAction<SlicePlane>>;
  setSliceIndex: React.Dispatch<React.SetStateAction<number>>;
  setSelectedQuantity: React.Dispatch<React.SetStateAction<string>>;
  setConsoleCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setSidebarCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setMeshRenderMode: React.Dispatch<React.SetStateAction<RenderMode>>;
  setMeshOpacity: React.Dispatch<React.SetStateAction<number>>;
  setMeshClipEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  setMeshClipAxis: React.Dispatch<React.SetStateAction<ClipAxis>>;
  setMeshClipPos: React.Dispatch<React.SetStateAction<number>>;
  setMeshShowArrows: React.Dispatch<React.SetStateAction<boolean>>;
  setMeshSelection: React.Dispatch<React.SetStateAction<MeshSelectionSnapshot>>;
  setMeshOptions: React.Dispatch<React.SetStateAction<MeshOptionsState>>;
  setFemDockTab: React.Dispatch<React.SetStateAction<FemDockTab>>;
  setSolverSettings: React.Dispatch<React.SetStateAction<SolverSettingsState>>;
  setSolverSetupOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setRunUntilInput: React.Dispatch<React.SetStateAction<string>>;
  setSelectedSidebarNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  enqueueCommand: (payload: Record<string, unknown>) => Promise<void>;
  updatePreview: (path: string, payload?: Record<string, unknown>) => Promise<void>;
  handleMeshGenerate: () => Promise<void>;
  openFemMeshWorkspace: (tab?: "mesh" | "quality") => void;
  handleViewModeChange: (mode: string) => void;
  handleSimulationAction: (action: string) => void;
  handleCapture: () => void;
  handleExport: () => void;
  requestPreviewQuantity: (nextQuantity: string) => void;
}

export type ControlRoomContextValue = ControlRoomState & ControlRoomActions;

const ControlRoomContext = createContext<ControlRoomContextValue | null>(null);

/* ── Hook ── */
export function useControlRoom(): ControlRoomContextValue {
  const ctx = useContext(ControlRoomContext);
  if (!ctx) throw new Error("useControlRoom must be used within <ControlRoomProvider>");
  return ctx;
}

/* ── Provider ── */
export function ControlRoomProvider({ children }: { children: ReactNode }) {
  const { state, connection, error } = useCurrentLiveStream();

  /* ── Local UI state ── */
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

  /* ── Derived from SSE state ── */
  const session = state?.session ?? null;
  const run = state?.run ?? null;
  const liveState = state?.live_state ?? null;
  const previewConfig = state?.preview_config ?? null;
  const preview = state?.preview ?? null;
  const femMesh = state?.fem_mesh ?? null;
  const scalarRows = state?.scalar_rows ?? EMPTY_SCALAR_ROWS;
  const engineLog = state?.engine_log ?? EMPTY_ENGINE_LOG;
  const quantities = state?.quantities ?? [];
  const artifactsArr = state?.artifacts ?? [];
  const metadata = (state?.metadata as Record<string, unknown> | null) ?? null;
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

  /* Effective solver values (fallback to run manifest when live is stale) */
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

  const effectiveLiveState = useMemo(() => {
    if (!liveState) return null;
    if (!liveIsStale) return liveState;
    return {
      ...liveState,
      step: effectiveStep, time: effectiveTime, dt: effectiveDt,
      e_ex: effectiveEEx, e_demag: effectiveEDemag, e_ext: effectiveEExt, e_total: effectiveETotal,
      max_dm_dt: effectiveDmDt, max_h_eff: effectiveHEff, max_h_demag: effectiveHDemag,
    };
  }, [liveState, liveIsStale, effectiveStep, effectiveTime, effectiveDt,
      effectiveEEx, effectiveEDemag, effectiveEExt, effectiveETotal,
      effectiveDmDt, effectiveHEff, effectiveHDemag]);

  /* Status bar */
  const elapsed = session
    ? (session.finished_at_unix_ms > session.started_at_unix_ms
        ? session.finished_at_unix_ms - session.started_at_unix_ms
        : Date.now() - session.started_at_unix_ms)
    : 0;
  const stepsPerSec = elapsed > 0 ? (effectiveStep / elapsed) * 1000 : 0;

  /* Detect FEM */
  const planSummary = session?.plan_summary as Record<string, unknown> | undefined;
  const resolvedBackend =
    (typeof planSummary?.resolved_backend === "string" ? planSummary.resolved_backend : null) ??
    (typeof session?.requested_backend === "string" ? session.requested_backend : null);
  const isFemBackend = resolvedBackend === "fem" || femMesh != null || preview?.spatial_kind === "mesh";

  const runtimeEngine = (metadata?.runtime_engine as Record<string, unknown> | undefined) ?? undefined;
  const runtimeEngineLabel = typeof runtimeEngine?.engine_label === "string" ? runtimeEngine.engine_label : null;
  const solverPlan = useMemo(() => extractSolverPlan(metadata, session), [metadata, session]);

  /* Hydrate solver-settings panel from the actual backend plan on first load. */
  const [solverSettingsHydrated, setSolverSettingsHydrated] = useState(false);
  useEffect(() => {
    if (solverSettingsHydrated || !solverPlan) return;
    setSolverSettings((prev) => ({
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
  }, [solverPlan, solverSettingsHydrated]);

  const currentStage = useMemo(() => parseStageExecutionMessage(latestEngineMessage), [latestEngineMessage]);

  const activity = useMemo<ActivityInfo>(() => {
    if (workspaceStatus === "materializing_script") {
      const pv = materializationProgressFromMessage(latestEngineMessage);
      const isLong = (latestEngineMessage ?? "").toLowerCase().includes("generating 3d tetrahedral mesh");
      return { label: isFemBackend ? "Materializing FEM workspace" : "Materializing workspace",
               detail: latestEngineMessage ?? "Preparing geometry import and execution plan",
               progressMode: isLong ? "indeterminate" : "determinate", progressValue: pv };
    }
    if (workspaceStatus === "bootstrapping")
      return { label: "Bootstrapping workspace", detail: latestEngineMessage ?? "Starting local API and control room",
               progressMode: "indeterminate", progressValue: undefined };
    if (workspaceStatus === "running") {
      const sl = currentStage ? `Solving ${currentStage.kind} — stage ${currentStage.current}/${currentStage.total}` : "Running solver";
      return { label: sl, detail: effectiveStep > 0
        ? `Step ${effectiveStep.toLocaleString()} · t=${fmtSI(effectiveTime, "s")} · ${runtimeEngineLabel ?? session?.requested_backend?.toUpperCase() ?? "runtime"}`
        : latestEngineMessage ?? "Solver startup in progress", progressMode: "indeterminate", progressValue: undefined };
    }
    if (workspaceStatus === "awaiting_command")
      return { label: "Interactive workspace ready", detail: latestEngineMessage ?? "Waiting for the next run or relax command",
               progressMode: "determinate", progressValue: 100 };
    if (workspaceStatus === "completed")
      return { label: "Run completed", detail: latestEngineMessage ?? "Solver finished successfully",
               progressMode: "determinate", progressValue: 100 };
    if (workspaceStatus === "failed")
      return { label: "Run failed", detail: latestEngineMessage ?? "Execution stopped with an error",
               progressMode: "determinate", progressValue: 100 };
    return { label: "Workspace idle", detail: latestEngineMessage ?? "No active task",
             progressMode: "idle", progressValue: undefined };
  }, [effectiveStep, effectiveTime, currentStage, isFemBackend, latestEngineMessage, runtimeEngineLabel, session?.requested_backend, workspaceStatus]);

  /* Artifact / execution plan metadata */
  const artifactLayout = (metadata?.artifact_layout as Record<string, unknown> | undefined) ?? undefined;
  const femArtifactLayout = artifactLayout?.backend === "fem" ? artifactLayout : undefined;
  const meshBoundsMin = asVec3(femArtifactLayout?.bounds_min) ?? asVec3(artifactLayout?.bounds_min);
  const meshBoundsMax = asVec3(femArtifactLayout?.bounds_max) ?? asVec3(artifactLayout?.bounds_max);
  const meshExtent = asVec3(femArtifactLayout?.world_extent) ?? asVec3(artifactLayout?.world_extent);
  const meshName = typeof femArtifactLayout?.mesh_name === "string" ? femArtifactLayout.mesh_name : null;
  const meshSource = typeof femArtifactLayout?.mesh_source === "string" ? femArtifactLayout.mesh_source : null;
  const meshFeOrder = typeof femArtifactLayout?.fe_order === "number" ? femArtifactLayout.fe_order : null;
  const meshHmax = typeof femArtifactLayout?.hmax === "number" ? femArtifactLayout.hmax : null;

  /* Unified world extent (metres) for both FDM and FEM */
  const worldExtent = useMemo<[number, number, number] | null>(() => {
    // FEM: use meshExtent directly
    if (meshExtent) return meshExtent;
    // FDM: compute from grid_cells × cell_size
    const gridCells = asVec3(artifactLayout?.grid_cells);
    const cellSize = asVec3(artifactLayout?.cell_size);
    if (gridCells && cellSize) {
      return [
        gridCells[0] * cellSize[0],
        gridCells[1] * cellSize[1],
        gridCells[2] * cellSize[2],
      ];
    }
    return null;
  }, [meshExtent, artifactLayout]);
  const meshingCapabilities = (metadata?.meshing_capabilities as Record<string, unknown> | undefined) ?? undefined;
  const mesherBackend = typeof meshingCapabilities?.backend === "string" ? meshingCapabilities.backend : null;
  const mesherSourceKind = typeof meshingCapabilities?.source_kind === "string" ? meshingCapabilities.source_kind : null;
  const mesherCurrentSettings = (meshingCapabilities?.current_settings as Record<string, unknown> | undefined) ?? null;

  /* Grid */
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
  const activeMask = useMemo<boolean[] | null>(() => {
    const raw = artifactLayout?.active_mask;
    if (!Array.isArray(raw)) return null;
    return raw.map((v: unknown) => Boolean(v));
  }, [artifactLayout]);

  /* Interactive */
  const interactiveEnabled = session?.interactive_session_requested === true;
  const awaitingCommand = session?.status === "awaiting_command";
  const interactiveControlsEnabled = interactiveEnabled && (awaitingCommand || session?.status === "running");
  const liveApi = useMemo(() => currentLiveApiClient(), []);

  /* Preview derived */
  const previewDrivenMode: ViewportMode | null =
    preview && !isFemBackend && viewMode !== "Mesh" ? (preview.type === "3D" ? "3D" : "2D") : null;
  const effectiveViewMode = previewDrivenMode ?? viewMode;
  const previewControlsActive = Boolean(previewConfig ?? preview);
  const requestedPreviewQuantity = previewConfig?.quantity ?? preview?.quantity ?? selectedQuantity;
  const requestedPreviewComponent = previewConfig?.component ?? preview?.component ?? "3D";
  const requestedPreviewLayer = previewConfig?.layer ?? preview?.layer ?? 0;
  const requestedPreviewAllLayers = previewConfig?.all_layers ?? preview?.all_layers ?? false;
  const requestedPreviewEveryN = previewConfig?.every_n ?? PREVIEW_EVERY_N_DEFAULT;
  const requestedPreviewXChosenSize = previewConfig?.x_chosen_size ?? preview?.x_chosen_size ?? 0;
  const requestedPreviewYChosenSize = previewConfig?.y_chosen_size ?? preview?.y_chosen_size ?? 0;
  const requestedPreviewAutoScale = previewConfig?.auto_scale_enabled ?? preview?.auto_scale_enabled ?? true;
  const requestedPreviewMaxPoints = previewConfig?.max_points ?? preview?.max_points ?? PREVIEW_MAX_POINTS_DEFAULT;

  const previewEveryNOptions = useMemo(
    () => Array.from(new Set([...PREVIEW_EVERY_N_PRESETS, requestedPreviewEveryN])).sort((a, b) => a - b),
    [requestedPreviewEveryN],
  );
  const previewMaxPointOptions = useMemo(() => {
    const values = new Set<number>([...PREVIEW_MAX_POINTS_PRESETS, requestedPreviewMaxPoints]);
    return Array.from(values).sort((a, b) => { if (a === 0) return 1; if (b === 0) return -1; return a - b; });
  }, [requestedPreviewMaxPoints]);

  const previewIsStale = Boolean(preview && previewConfig && preview.config_revision !== previewConfig.revision);
  const previewIsBootstrapStale = Boolean(previewControlsActive && preview && effectiveStep > 0 && preview.source_step === 0);
  const renderPreview = preview;
  const isMeshPreview = renderPreview?.spatial_kind === "mesh";
  const previewVectorComponent: VectorComponent =
    renderPreview?.component && renderPreview.component !== "3D"
      ? (renderPreview.component as VectorComponent)
      : "magnitude";
  const effectiveVectorComponent = isMeshPreview ? previewVectorComponent : component;

  /* Callbacks */
  const enqueueCommand = useCallback(async (payload: Record<string, unknown>) => {
    setCommandBusy(true); setCommandMessage(null);
    try { await liveApi.queueCommand(payload); setCommandMessage(`Queued ${String(payload.kind)}`); }
    catch (e) { setCommandMessage(e instanceof Error ? e.message : "Failed to queue command"); }
    finally { setCommandBusy(false); }
  }, [liveApi]);

  const updatePreview = useCallback(async (path: string, payload: Record<string, unknown> = {}) => {
    setPreviewBusy(true); setPreviewMessage(null);
    try { await liveApi.updatePreview(path, payload); }
    catch (e) { setPreviewMessage(e instanceof Error ? e.message : "Failed to update preview"); }
    finally { setPreviewBusy(false); }
  }, [liveApi]);

  const handleMeshGenerate = useCallback(async () => {
    setMeshGenerating(true);
    try {
      await liveApi.queueCommand({
        kind: "remesh",
        mesh_options: {
          algorithm_2d: meshOptions.algorithm2d, algorithm_3d: meshOptions.algorithm3d,
          hmin: meshOptions.hmin ? parseFloat(meshOptions.hmin) : null,
          size_factor: meshOptions.sizeFactor, size_from_curvature: meshOptions.sizeFromCurvature,
          smoothing_steps: meshOptions.smoothingSteps, optimize: meshOptions.optimize || null,
          optimize_iterations: meshOptions.optimizeIters, compute_quality: meshOptions.computeQuality,
          per_element_quality: meshOptions.perElementQuality,
        },
      });
    } catch (err) { setCommandMessage(err instanceof Error ? err.message : "Mesh generation failed"); }
    finally { setMeshGenerating(false); }
  }, [meshOptions, liveApi]);

  const openFemMeshWorkspace = useCallback((tab: "mesh" | "quality" = "mesh") => {
    setViewMode("Mesh"); setFemDockTab(tab);
    setMeshRenderMode((c) => (c === "surface" ? "surface+edges" : c));
  }, []);

  const handleViewModeChange = useCallback((mode: string) => {
    if (mode === "Mesh") { if (isFemBackend) openFemMeshWorkspace("mesh"); setViewMode("Mesh"); return; }
    setViewMode(mode as ViewportMode);
  }, [isFemBackend, openFemMeshWorkspace]);

  const handleSimulationAction = useCallback((action: string) => {
    if (action === "run") {
      const untilSeconds = parseOptionalNumber(runUntilInput);
      if (untilSeconds == null || untilSeconds <= 0) {
        setCommandMessage("Run requires a positive stop time");
        return;
      }
      void enqueueCommand({ kind: "run", until_seconds: untilSeconds });
      return;
    }

    if (action === "relax") {
      const maxSteps = parseOptionalNumber(solverSettings.maxRelaxSteps);
      if (maxSteps == null || maxSteps <= 0) {
        setCommandMessage("Relax requires a positive max step count");
        return;
      }
      void enqueueCommand({
        kind: "relax",
        max_steps: maxSteps,
        torque_tolerance: parseOptionalNumber(solverSettings.torqueTolerance),
        energy_tolerance: parseOptionalNumber(solverSettings.energyTolerance),
      });
      return;
    }

    if (action === "pause") {
      void enqueueCommand({ kind: "pause" });
      return;
    }

    if (action === "stop") {
      void enqueueCommand({ kind: "stop" });
    }
  }, [
    enqueueCommand,
    runUntilInput,
    solverSettings.energyTolerance,
    solverSettings.maxRelaxSteps,
    solverSettings.torqueTolerance,
  ]);

  const handleCapture = useCallback(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".viewport canvas, [class*='viewport'] canvas");
    if (!canvas) return;
    const link = document.createElement("a");
    link.download = `fullmag_snapshot_${Date.now()}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  }, []);

  const handleExport = useCallback(() => { void enqueueCommand({ kind: "save_vtk" }); }, [enqueueCommand]);

  const requestPreviewQuantity = useCallback((nextQuantity: string) => {
    if (isFemBackend && effectiveViewMode === "Mesh") setViewMode("3D");
    if (previewControlsActive) void updatePreview("/quantity", { quantity: nextQuantity });
    else setSelectedQuantity(nextQuantity);
  }, [effectiveViewMode, isFemBackend, previewControlsActive, updatePreview]);

  /* Keyboard shortcuts */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "1") setViewMode("3D");
      else if (e.key === "2") setViewMode("2D");
      else if (e.key === "3") handleViewModeChange("Mesh");
      else if (e.key === "`" && e.ctrlKey) { e.preventDefault(); setConsoleCollapsed((v) => !v); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleViewModeChange]);

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
    () => (quantities).filter((q) => q.kind === "vector_field").map((q) => ({
      value: q.id,
      label: q.available ? `${q.label} (${q.unit})` : `${q.label} (${q.unit}) — waiting for data`,
      disabled: !q.available,
    })),
    [quantities],
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
    if (requestedPreviewQuantity) setSelectedQuantity(requestedPreviewQuantity);
  }, [requestedPreviewQuantity]);

  const quantityDescriptor = useMemo(
    () => quantities.find((q) => q.id === (renderPreview?.quantity ?? requestedPreviewQuantity)) ?? null,
    [renderPreview?.quantity, requestedPreviewQuantity, quantities],
  );
  const isVectorQuantity = quantityDescriptor?.kind === "vector_field";

  const quickPreviewTargets = useMemo(
    () => [
      { id: "m", shortLabel: "M" }, { id: "H_ex", shortLabel: "H_ex" },
      { id: "H_demag", shortLabel: "H_demag" }, { id: "H_ext", shortLabel: "H_ext" },
      { id: "H_eff", shortLabel: "H_eff" },
    ].map((entry) => {
      const option = previewQuantityOptions.find((c) => c.value === entry.id);
      return { ...entry, available: option ? !option.disabled : entry.id === "m" };
    }),
    [previewQuantityOptions],
  );

  const selectedScalarValue = useMemo(() => {
    const scalarKey = SCALAR_FIELDS[selectedQuantity];
    if (!scalarKey) return null;
    const lastRow = scalarRows[scalarRows.length - 1];
    return lastRow ? (lastRow[scalarKey as keyof typeof lastRow] as number) ?? null : null;
  }, [scalarRows, selectedQuantity]);

  /* Field data */
  const fieldMap = useMemo(
    () => ({
      m: liveState?.magnetization ?? state?.latest_fields.m ?? null,
      H_ex: state?.latest_fields.h_ex ?? null,
      H_demag: state?.latest_fields.h_demag ?? null,
      H_ext: state?.latest_fields.h_ext ?? null,
      H_eff: state?.latest_fields.h_eff ?? null,
    }),
    [liveState?.magnetization, state?.latest_fields.h_demag, state?.latest_fields.h_eff,
     state?.latest_fields.h_ex, state?.latest_fields.h_ext, state?.latest_fields.m],
  );

  const selectedVectors = useMemo(() => {
    if (renderPreview?.vector_field_values) return new Float64Array(renderPreview.vector_field_values);
    if (previewControlsActive) { const bv = fieldMap.m; return bv ? new Float64Array(bv) : null; }
    const values = fieldMap[selectedQuantity as keyof typeof fieldMap] ?? null;
    return values ? new Float64Array(values) : null;
  }, [fieldMap, previewControlsActive, renderPreview?.vector_field_values, selectedQuantity]);

  /* FEM mesh data */
  const effectiveFemMesh = useMemo(
    () => (isMeshPreview && renderPreview?.fem_mesh ? renderPreview.fem_mesh : femMesh),
    [femMesh, isMeshPreview, renderPreview?.fem_mesh],
  );
  const [flatNodes, flatFaces] = useMemo(() => {
    if (!effectiveFemMesh) return [null, null];
    return [effectiveFemMesh.nodes.flatMap((n) => n), effectiveFemMesh.boundary_faces.flatMap((f) => f)];
  }, [effectiveFemMesh]);

  const femMeshData = useMemo<FemMeshData | null>(() => {
    if (!isFemBackend || !effectiveFemMesh || !flatNodes || !flatFaces) return null;
    const nNodes = effectiveFemMesh.nodes.length;
    const nElements = femMesh?.elements.length ?? effectiveFemMesh.elements.length;
    let fieldData: FemMeshData["fieldData"] | undefined;
    if (selectedVectors && selectedVectors.length >= nNodes * 3) {
      const x = new Array<number>(nNodes), y = new Array<number>(nNodes), z = new Array<number>(nNodes);
      for (let i = 0; i < nNodes; i++) { x[i] = selectedVectors[i * 3] ?? 0; y[i] = selectedVectors[i * 3 + 1] ?? 0; z[i] = selectedVectors[i * 3 + 2] ?? 0; }
      fieldData = { x, y, z };
    }
    return { nodes: flatNodes, boundaryFaces: flatFaces, nNodes, nElements, fieldData };
  }, [isFemBackend, effectiveFemMesh, femMesh?.elements.length, flatNodes, flatFaces, selectedVectors]);

  const femHasFieldData = Boolean(femMeshData?.fieldData);
  const femMagnetization3DActive = isFemBackend && effectiveViewMode === "3D" && (renderPreview?.quantity ?? selectedQuantity) === "m" && femHasFieldData;
  const femShouldShowArrows = isFemBackend && effectiveViewMode === "3D" && femHasFieldData ? meshShowArrows : false;

  const femTopologyKey = useMemo(() => {
    if (!effectiveFemMesh) return null;
    return `${effectiveFemMesh.nodes.length}:${femMesh?.elements.length ?? effectiveFemMesh.elements.length}:${effectiveFemMesh.boundary_faces.length}`;
  }, [effectiveFemMesh, femMesh?.elements.length]);

  const femColorField = useMemo<FemColorField>(() => {
    const qId = renderPreview?.quantity ?? selectedQuantity;
    if (qId === "m" && effectiveViewMode === "3D" && femHasFieldData) return "orientation";
    if (effectiveVectorComponent === "x") return "x";
    if (effectiveVectorComponent === "y") return "y";
    if (effectiveVectorComponent === "z") return "z";
    return "magnitude";
  }, [effectiveVectorComponent, effectiveViewMode, femHasFieldData, renderPreview?.quantity, selectedQuantity]);

  useEffect(() => {
    setMeshSelection({ selectedFaceIndices: [], primaryFaceIndex: null });
  }, [femTopologyKey]);

  const isMeshWorkspaceView = effectiveViewMode === "Mesh";
  const meshFaceDetail = useMemo(
    () => computeMeshFaceDetail(effectiveFemMesh, meshSelection.primaryFaceIndex),
    [effectiveFemMesh, meshSelection.primaryFaceIndex],
  );

  const meshQualitySummary = useMemo<MeshQualitySummary | null>(() => {
    if (!effectiveFemMesh) return null;
    const nodes = effectiveFemMesh.nodes;
    const faces = effectiveFemMesh.boundary_faces;
    if (!nodes.length || !faces.length) return null;
    let min = Infinity, max = -Infinity, sum = 0, good = 0, fair = 0, poor = 0;
    for (const [ia, ib, ic] of faces) {
      const a = nodes[ia], b = nodes[ib], c = nodes[ic];
      if (!a || !b || !c) continue;
      const ab = Math.hypot(b[0]-a[0], b[1]-a[1], b[2]-a[2]);
      const bc = Math.hypot(c[0]-b[0], c[1]-b[1], c[2]-b[2]);
      const ca = Math.hypot(a[0]-c[0], a[1]-c[1], a[2]-c[2]);
      const maxE = Math.max(ab, bc, ca);
      const s2 = (ab+bc+ca)/2;
      const area = Math.sqrt(Math.max(0, s2*(s2-ab)*(s2-bc)*(s2-ca)));
      const inr = s2 > 0 ? area/s2 : 0;
      const ar = inr > 1e-18 ? maxE/(2*inr) : 1;
      min = Math.min(min, ar); max = Math.max(max, ar); sum += ar;
      if (ar < 3) good++; else if (ar < 6) fair++; else poor++;
    }
    return { min, max, mean: faces.length > 0 ? sum/faces.length : 0, good, fair, poor, count: faces.length };
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

  /* Field stats */
  const fieldStats = useMemo<FieldStats | null>(() => {
    if (!selectedVectors) return null;
    const n = isFemBackend ? (effectiveFemMesh?.nodes.length ?? 0) : Math.floor(selectedVectors.length / 3);
    if (n <= 0 || selectedVectors.length < n * 3) return null;
    let sumX = 0, sumY = 0, sumZ = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const vx = selectedVectors[i*3], vy = selectedVectors[i*3+1], vz = selectedVectors[i*3+2];
      sumX += vx; sumY += vy; sumZ += vz;
      if (vx < minX) minX = vx; if (vx > maxX) maxX = vx;
      if (vy < minY) minY = vy; if (vy > maxY) maxY = vy;
      if (vz < minZ) minZ = vz; if (vz > maxZ) maxZ = vz;
    }
    const inv = 1/n;
    return { meanX: sumX*inv, meanY: sumY*inv, meanZ: sumZ*inv, minX, minY, minZ, maxX, maxY, maxZ };
  }, [selectedVectors, isFemBackend, effectiveFemMesh]);

  /* Material */
  const material = useMemo<MaterialSummary | null>(() => {
    if (!solverPlan) return null;
    return {
      msat: solverPlan.materialMsat,
      aex: solverPlan.materialAex,
      alpha: solverPlan.materialAlpha,
      exchangeEnabled: solverPlan.exchangeEnabled,
      demagEnabled: solverPlan.demagEnabled,
      zeemanField: solverPlan.externalField ? [...solverPlan.externalField] : null,
      name: solverPlan.materialName,
    };
  }, [solverPlan]);

  /* Empty state */
  const emptyStateMessage = useMemo(() => {
    if (isFemBackend && !femMeshData) {
      if (workspaceStatus === "materializing_script")
        return { title: "Materializing FEM mesh", description: latestEngineMessage ?? "Importing geometry and preparing the FEM mesh." };
      if (workspaceStatus === "bootstrapping")
        return { title: "Bootstrapping live workspace", description: latestEngineMessage ?? "Starting the local workspace." };
      return { title: "Waiting for FEM preview data", description: latestEngineMessage ?? "The mesh topology is not available yet." };
    }
    if (workspaceStatus === "materializing_script")
      return { title: "Materializing workspace", description: latestEngineMessage ?? "Preparing problem description and first preview." };
    return { title: "No preview data yet", description: latestEngineMessage ?? "Waiting for the first live field snapshot." };
  }, [femMeshData, isFemBackend, latestEngineMessage, workspaceStatus]);

  const sessionFooter = useMemo<SessionFooterData>(() => ({
    requestedBackend: session?.requested_backend ?? null,
    scriptPath: session?.script_path ?? null,
    artifactDir: session?.artifact_dir ?? null,
  }), [session?.requested_backend, session?.script_path, session?.artifact_dir]);

  /* ── Build context value ── */
  const value = useMemo<ControlRoomContextValue>(() => ({
    connection, error,
    session, run, liveState, effectiveLiveState, preview, femMesh, scalarRows, engineLog,
    quantities, artifacts: artifactsArr, metadata,
    workspaceStatus, hasSolverTelemetry, solverNotStartedMessage, isFemBackend, runtimeEngineLabel,
    activity, sessionFooter,
    effectiveStep, effectiveTime, effectiveDt, effectiveDmDt, effectiveHEff, effectiveHDemag,
    effectiveEEx, effectiveEDemag, effectiveEExt, effectiveETotal,
    elapsed, stepsPerSec,
    viewMode, effectiveViewMode, component, plane, sliceIndex, selectedQuantity,
    consoleCollapsed, sidebarCollapsed,
    meshRenderMode, meshOpacity, meshClipEnabled, meshClipAxis, meshClipPos, meshShowArrows,
    meshSelection, meshOptions, meshQualityData, meshGenerating,
    femDockTab, solverSettings, solverSetupOpen,
    interactiveEnabled, interactiveControlsEnabled, awaitingCommand, commandBusy, commandMessage,
    runUntilInput, previewBusy, previewMessage,
    previewControlsActive, requestedPreviewQuantity, requestedPreviewComponent,
    requestedPreviewLayer, requestedPreviewAllLayers, requestedPreviewEveryN,
    requestedPreviewXChosenSize, requestedPreviewYChosenSize, requestedPreviewAutoScale,
    requestedPreviewMaxPoints, previewEveryNOptions, previewMaxPointOptions,
    previewIsStale, previewIsBootstrapStale,
    quantityOptions, previewQuantityOptions, quantityDescriptor, isVectorQuantity,
    quickPreviewTargets, selectedScalarValue,
    solverGrid, previewGrid, totalCells, activeCells, inactiveCells, activeMaskPresent, activeMask,
    maxSliceCount,
    effectiveFemMesh, femMeshData, femTopologyKey, femColorField, femMagnetization3DActive,
    femShouldShowArrows, isMeshWorkspaceView, meshFaceDetail, meshQualitySummary,
    selectedVectors, effectiveVectorComponent, fieldStats, material, solverPlan,
    dmDtSpark, dtSpark, eTotalSpark,
    meshName, meshSource, meshExtent, meshBoundsMin, meshBoundsMax, meshFeOrder, meshHmax, worldExtent,
    mesherBackend, mesherSourceKind, mesherCurrentSettings,
    selectedSidebarNodeId, emptyStateMessage,
    /* actions */
    setViewMode, setComponent, setPlane, setSliceIndex, setSelectedQuantity,
    setConsoleCollapsed, setSidebarCollapsed,
    setMeshRenderMode, setMeshOpacity, setMeshClipEnabled, setMeshClipAxis, setMeshClipPos,
    setMeshShowArrows, setMeshSelection, setMeshOptions, setFemDockTab,
    setSolverSettings, setSolverSetupOpen, setRunUntilInput, setSelectedSidebarNodeId,
    enqueueCommand, updatePreview, handleMeshGenerate, openFemMeshWorkspace,
    handleViewModeChange, handleSimulationAction, handleCapture, handleExport,
    requestPreviewQuantity,
  }), [
    connection, error, session, run, liveState, effectiveLiveState, preview, femMesh, scalarRows,
    engineLog, quantities, artifactsArr, metadata, workspaceStatus, hasSolverTelemetry,
    solverNotStartedMessage, isFemBackend, runtimeEngineLabel, activity, sessionFooter,
    effectiveStep, effectiveTime, effectiveDt, effectiveDmDt, effectiveHEff, effectiveHDemag,
    effectiveEEx, effectiveEDemag, effectiveEExt, effectiveETotal, elapsed, stepsPerSec,
    viewMode, effectiveViewMode, component, plane, sliceIndex, selectedQuantity,
    consoleCollapsed, sidebarCollapsed, meshRenderMode, meshOpacity, meshClipEnabled,
    meshClipAxis, meshClipPos, meshShowArrows, meshSelection, meshOptions, meshQualityData,
    meshGenerating, femDockTab, solverSettings, solverSetupOpen, interactiveEnabled,
    interactiveControlsEnabled, awaitingCommand, commandBusy, commandMessage, runUntilInput,
    previewBusy, previewMessage, previewControlsActive, requestedPreviewQuantity,
    requestedPreviewComponent, requestedPreviewLayer, requestedPreviewAllLayers,
    requestedPreviewEveryN, requestedPreviewXChosenSize, requestedPreviewYChosenSize,
    requestedPreviewAutoScale, requestedPreviewMaxPoints, previewEveryNOptions,
    previewMaxPointOptions, previewIsStale, previewIsBootstrapStale, quantityOptions,
    previewQuantityOptions, quantityDescriptor, isVectorQuantity, quickPreviewTargets,
    selectedScalarValue, solverGrid, previewGrid, totalCells, activeCells, inactiveCells,
    activeMaskPresent, activeMask, maxSliceCount, effectiveFemMesh, femMeshData, femTopologyKey,
    femColorField, femMagnetization3DActive, femShouldShowArrows, isMeshWorkspaceView,
    meshFaceDetail, meshQualitySummary, selectedVectors, effectiveVectorComponent, fieldStats,
    material, solverPlan, dmDtSpark, dtSpark, eTotalSpark, meshName, meshSource, meshExtent, meshBoundsMin,
    meshBoundsMax, meshFeOrder, meshHmax, mesherBackend, mesherSourceKind, mesherCurrentSettings,
    selectedSidebarNodeId, emptyStateMessage,
    enqueueCommand, updatePreview, handleMeshGenerate, openFemMeshWorkspace,
    handleViewModeChange, handleSimulationAction, handleCapture, handleExport,
    requestPreviewQuantity,
  ]);

  if (!state) return null;

  return (
    <ControlRoomContext.Provider value={value}>
      {children}
    </ControlRoomContext.Provider>
  );
}
