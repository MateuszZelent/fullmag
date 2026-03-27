"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import { currentLiveApiClient } from "../../lib/liveApiClient";
import { useCurrentLiveStream } from "../../lib/useSessionStream";
import type { FemLiveMesh } from "../../lib/useSessionStream";
import EngineConsole from "../panels/EngineConsole";
import MeshQualityHistogram from "../panels/MeshQualityHistogram";
import MeshSettingsPanel, { DEFAULT_MESH_OPTIONS } from "../panels/MeshSettingsPanel";
import type { MeshOptionsState, MeshQualityData } from "../panels/MeshSettingsPanel";
import ModelTree, { buildFullmagModelTree } from "../panels/ModelTree";
import MagnetizationSlice2D from "../preview/MagnetizationSlice2D";
import MagnetizationView3D from "../preview/MagnetizationView3D";
import FemMeshView3D from "../preview/FemMeshView3D";
import FemMeshSlice2D from "../preview/FemMeshSlice2D";
import PreviewScalarField2D from "../preview/PreviewScalarField2D";
import type { ClipAxis, FemColorField, FemMeshData, MeshSelectionSnapshot, RenderMode } from "../preview/FemMeshView3D";
import ScalarPlot from "../plots/ScalarPlot";
import Sparkline from "../ui/Sparkline";
import EmptyState from "../ui/EmptyState";
import Button from "../ui/Button";
import TitleBar from "../shell/TitleBar";
import MenuBar from "../shell/MenuBar";
import RibbonBar from "../shell/RibbonBar";
import StatusBar from "../shell/StatusBar";
import s from "./RunControlRoom.module.css";

/* ── Types ─────────────────────────────────────────────────── */

type ViewportMode = "3D" | "2D" | "Mesh";
type VectorComponent = "x" | "y" | "z" | "magnitude";
type PreviewComponent = "3D" | "x" | "y" | "z";
type SlicePlane = "xy" | "xz" | "yz";
type FemDockTab = "mesh" | "mesher" | "view" | "quality";

interface MeshFaceDetail {
  faceIndex: number;
  nodeIndices: [number, number, number];
  centroid: [number, number, number];
  normal: [number, number, number];
  edgeLengths: [number, number, number];
  perimeter: number;
  area: number;
  aspectRatio: number;
}

const FEM_SLICE_COUNT = 25;
const PANEL_SIZES = {
  bodyMainDefault: "78%",
  bodyMainMin: "34%",
  viewportDefault: "72%",
  viewportMin: "24%",
  consoleDefault: "28%",
  consoleMin: "10%",
  consoleMax: "72%",
  femDockDefault: "24%",
  femDockMin: "16%",
  femDockMax: "50%",
  femViewportDefault: "76%",
  femViewportMin: "26%",
  sidebarDefault: "22%",
  sidebarMin: "14%",
  sidebarMax: "50%",
} as const;

const SCALAR_FIELDS: Record<string, string> = {
  E_ex: "e_ex",
  E_demag: "e_demag",
  E_ext: "e_ext",
  E_total: "e_total",
};

/* ── Helpers ───────────────────────────────────────────────── */

function fmtSI(v: number, unit: string): string {
  if (!Number.isFinite(v) || v === 0) return `0 ${unit}`;
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${(v / 1e12).toPrecision(3)} T${unit}`;
  if (abs >= 1e9) return `${(v / 1e9).toPrecision(3)} G${unit}`;
  if (abs >= 1e6) return `${(v / 1e6).toPrecision(3)} M${unit}`;
  if (abs >= 1e3) return `${(v / 1e3).toPrecision(3)} k${unit}`;
  if (abs >= 1) return `${v.toPrecision(3)} ${unit}`;
  if (abs >= 1e-3) return `${(v * 1e3).toPrecision(3)} m${unit}`;
  if (abs >= 1e-6) return `${(v * 1e6).toPrecision(3)} µ${unit}`;
  if (abs >= 1e-9) return `${(v * 1e9).toPrecision(3)} n${unit}`;
  if (abs >= 1e-12) return `${(v * 1e12).toPrecision(3)} p${unit}`;
  return `${v.toExponential(2)} ${unit}`;
}

function fmtExp(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "0";
  return v.toExponential(3);
}

function fmtStepValue(v: number, enabled: boolean): string {
  return enabled ? v.toLocaleString() : "—";
}

function fmtSIOrDash(v: number, unit: string, enabled: boolean): string {
  return enabled ? fmtSI(v, unit) : "—";
}

function fmtExpOrDash(v: number, enabled: boolean): string {
  return enabled ? fmtExp(v) : "—";
}

function materializationProgressFromMessage(message: string | null): number {
  if (!message) return 6;
  const lower = message.toLowerCase();
  if (lower.includes("control room bootstrap verified")) return 8;
  if (lower.includes("loading python script")) return 14;
  if (lower.includes("building problemir")) return 22;
  if (lower.includes("preparing fem mesh asset")) return 32;
  if (lower.includes("generating fem mesh from geometry")) return 44;
  if (lower.includes("meshing stl surface")) return 52;
  if (lower.includes("importing stl surface")) return 60;
  if (lower.includes("classifying stl surfaces")) return 70;
  if (lower.includes("creating geometry from classified surfaces")) return 80;
  if (lower.includes("generating 3d tetrahedral mesh")) return 90;
  if (lower.includes("mesh ready") || lower.includes("fem mesh ready")) return 96;
  if (lower.includes("script materialized")) return 100;
  return 12;
}

function parseStageExecutionMessage(message: string | null): { current: number; total: number; kind: string } | null {
  if (!message) return null;
  const match = message.match(/executing stage (\d+)\/(\d+) \(([^)]+)\)/i);
  if (!match) return null;
  return {
    current: Number(match[1]),
    total: Number(match[2]),
    kind: match[3],
  };
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)} min`;
  return `${(ms / 3600000).toFixed(2)} h`;
}

function asVec3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [x, y, z] = value;
  if ([x, y, z].some((component) => typeof component !== "number")) return null;
  return [x as number, y as number, z as number];
}

function computeMeshFaceDetail(mesh: FemLiveMesh | null, faceIndex: number | null): MeshFaceDetail | null {
  if (!mesh || faceIndex == null || faceIndex < 0 || faceIndex >= mesh.boundary_faces.length) {
    return null;
  }

  const face = mesh.boundary_faces[faceIndex];
  if (!face) return null;
  const [ia, ib, ic] = face;
  const a = mesh.nodes[ia];
  const b = mesh.nodes[ib];
  const c = mesh.nodes[ic];
  if (!a || !b || !c) return null;

  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const bcx = c[0] - b[0];
  const bcy = c[1] - b[1];
  const bcz = c[2] - b[2];
  const cax = a[0] - c[0];
  const cay = a[1] - c[1];
  const caz = a[2] - c[2];

  const ab = Math.hypot(abx, aby, abz);
  const bc = Math.hypot(bcx, bcy, bcz);
  const ca = Math.hypot(cax, cay, caz);
  const perimeter = ab + bc + ca;
  const halfPerimeter = perimeter / 2;

  const acx = c[0] - a[0];
  const acy = c[1] - a[1];
  const acz = c[2] - a[2];
  const crossX = aby * acz - abz * acy;
  const crossY = abz * acx - abx * acz;
  const crossZ = abx * acy - aby * acx;
  const crossNorm = Math.hypot(crossX, crossY, crossZ);
  const area = 0.5 * crossNorm;
  const normal: [number, number, number] =
    crossNorm > 1e-30
      ? [crossX / crossNorm, crossY / crossNorm, crossZ / crossNorm]
      : [0, 0, 0];

  const maxEdge = Math.max(ab, bc, ca);
  const inradius = halfPerimeter > 0 ? area / halfPerimeter : 0;
  const aspectRatio = inradius > 1e-18 ? maxEdge / (2 * inradius) : 1;

  return {
    faceIndex,
    nodeIndices: [ia, ib, ic],
    centroid: [
      (a[0] + b[0] + c[0]) / 3,
      (a[1] + b[1] + c[1]) / 3,
      (a[2] + b[2] + c[2]) / 3,
    ],
    normal,
    edgeLengths: [ab, bc, ca],
    perimeter,
    area,
    aspectRatio,
  };
}



/* ── Collapsible Section ───────────────────────────────────── */

function Section({
  title,
  badge,
  defaultOpen = true,
  children,
}: {
  title: string;
  badge?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={s.section}>
      <div className={s.sectionHeader} onClick={() => setOpen((v) => !v)}>
        <span className={s.sectionChevron} data-open={open}>▸</span>
        <span className={s.sectionTitle}>{title}</span>
        {badge && <span className={s.sectionBadge}>{badge}</span>}
      </div>
      {open && <div className={s.sectionBody}>{children}</div>}
    </div>
  );
}

function DockTabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={s.meshDockTab}
      data-active={active}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

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
  const [relaxMaxStepsInput, setRelaxMaxStepsInput] = useState("5000");
  const [commandBusy, setCommandBusy] = useState(false);
  const [commandMessage, setCommandMessage] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewMessage, setPreviewMessage] = useState<string | null>(null);
  const [meshOptions, setMeshOptions] = useState<MeshOptionsState>(DEFAULT_MESH_OPTIONS);
  const [meshQualityData, setMeshQualityData] = useState<MeshQualityData | null>(null);
  const [meshGenerating, setMeshGenerating] = useState(false);
  const [meshSelection, setMeshSelection] = useState<MeshSelectionSnapshot>({
    selectedFaceIndices: [],
    primaryFaceIndex: null,
  });

  const session = state?.session;
  const run = state?.run;
  const liveState = state?.live_state;
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
    const options = preview ? previewQuantityOptions : quantityOptions;
    if (!options.length) return;
    if (!options.some((opt) => opt.value === selectedQuantity)) {
      const fallback = options.find((opt) => !opt.disabled) ?? options[0];
      setSelectedQuantity(fallback.value);
    }
  }, [preview, previewQuantityOptions, quantityOptions, selectedQuantity]);

  useEffect(() => {
    if (preview?.quantity) {
      setSelectedQuantity(preview.quantity);
    }
  }, [preview?.quantity]);

  const quantityDescriptor = useMemo(
    () => state?.quantities.find((q) => q.id === (preview?.quantity ?? selectedQuantity)) ?? null,
    [preview?.quantity, selectedQuantity, state?.quantities],
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

  return (
    <div className={s.shell}>
      {/* ═══════ TITLE BAR ════════════════════════════ */}
      <TitleBar
        problemName={session?.problem_name ?? "Local Live Workspace"}
        backend={session?.requested_backend ?? ""}
        runtimeEngine={runtimeEngineLabel ?? undefined}
        status={workspaceStatus}
        connection={connection}
      />

      {/* ═══════ MENU BAR ═════════════════════════════ */}
      <MenuBar
        viewMode={effectiveViewMode}
        interactiveEnabled={interactiveEnabled}
        onViewChange={handleViewModeChange}
        onSidebarToggle={() => setSidebarCollapsed((v) => !v)}
        onSimAction={(action) => {
          if (action === "run") void enqueueCommand({ kind: "run" });
          if (action === "pause") void enqueueCommand({ kind: "pause" });
          if (action === "stop") void enqueueCommand({ kind: "stop" });
        }}
      />

      {/* ═══════ RIBBON BAR ═══════════════════════════ */}
      <RibbonBar
        viewMode={effectiveViewMode}
        isFemBackend={isFemBackend}
        solverRunning={workspaceStatus === "running"}
        sidebarVisible={!sidebarCollapsed}
        onViewChange={handleViewModeChange}
        onSidebarToggle={() => setSidebarCollapsed((v) => !v)}
        onSimAction={(action) => {
          if (action === "run") void enqueueCommand({ kind: "run" });
          if (action === "pause") void enqueueCommand({ kind: "pause" });
          if (action === "stop") void enqueueCommand({ kind: "stop" });
        }}
      />

      {/* ═══════ BODY: Horizontal PanelGroup (main + sidebar) ═══════ */}
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
          <Panel
            id="workspace-fem-dock"
            defaultSize={PANEL_SIZES.femDockDefault}
            minSize={PANEL_SIZES.femDockMin}
            maxSize={PANEL_SIZES.femDockMax}
          >
            <div className={s.meshDock}>
              <div className={s.meshDockHeader}>
                <div>
                  <div className={s.meshDockEyebrow}>Mesh Workspace</div>
                  <div className={s.meshDockTitle}>FEM Setup</div>
                </div>
                <span className={s.meshDockStatus} data-status={workspaceStatus}>
                  {workspaceStatus}
                </span>
              </div>

              <div className={s.meshDockTabs}>
                <DockTabButton
                  active={femDockTab === "mesh"}
                  label="Mesh"
                  onClick={() => openFemMeshWorkspace("mesh")}
                />
                <DockTabButton
                  active={femDockTab === "mesher"}
                  label="Mesher"
                  onClick={() => setFemDockTab("mesher")}
                />
                <DockTabButton
                  active={femDockTab === "view"}
                  label="View"
                  onClick={() => setFemDockTab("view")}
                />
                <DockTabButton
                  active={femDockTab === "quality"}
                  label="Quality"
                  onClick={() => openFemMeshWorkspace("quality")}
                />
              </div>

              <div className={s.meshDockBody}>
                {femDockTab === "mesh" && (
                  <>
                    <div className={s.meshCard}>
                      <div className={s.meshCardHeader}>
                        <span className={s.meshCardTitle}>Topology</span>
                        <span className={s.meshCardBadge}>
                          {effectiveFemMesh?.elements.length
                            ? "volume mesh"
                            : "surface preview"}
                        </span>
                      </div>
                      <div className={s.meshStatGrid}>
                        <div className={s.meshStatCard}>
                          <span className={s.meshStatLabel}>Nodes</span>
                          <span className={s.meshStatValue}>
                            {effectiveFemMesh?.nodes.length.toLocaleString() ?? "0"}
                          </span>
                        </div>
                        <div className={s.meshStatCard}>
                          <span className={s.meshStatLabel}>Elements</span>
                          <span className={s.meshStatValue}>
                            {effectiveFemMesh?.elements.length.toLocaleString() ?? "0"}
                          </span>
                        </div>
                        <div className={s.meshStatCard}>
                          <span className={s.meshStatLabel}>Boundary faces</span>
                          <span className={s.meshStatValue}>
                            {effectiveFemMesh?.boundary_faces.length.toLocaleString() ?? "0"}
                          </span>
                        </div>
                        <div className={s.meshStatCard}>
                          <span className={s.meshStatLabel}>Element type</span>
                          <span className={s.meshStatValue}>
                            {effectiveFemMesh?.elements.length ? "tet4" : "surface"}
                          </span>
                        </div>
                        <div className={s.meshStatCard}>
                          <span className={s.meshStatLabel}>FE order</span>
                          <span className={s.meshStatValue}>
                            {meshFeOrder != null ? String(meshFeOrder) : "—"}
                          </span>
                        </div>
                        <div className={s.meshStatCard}>
                          <span className={s.meshStatLabel}>hmax</span>
                          <span className={s.meshStatValue}>
                            {meshHmax != null ? fmtSI(meshHmax, "m") : "—"}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className={s.meshCard}>
                      <div className={s.meshCardHeader}>
                        <span className={s.meshCardTitle}>Inspect</span>
                        <span className={s.meshCardBadge}>
                          {isMeshWorkspaceView ? "mesh viewport active" : "mesh viewport hidden"}
                        </span>
                      </div>
                      <div className={s.meshSegmented}>
                        {(["Mesh", "3D", "2D"] as ViewportMode[]).map((mode) => (
                          <button
                            key={mode}
                            className={s.meshSegmentBtn}
                            data-active={effectiveViewMode === mode}
                            onClick={() => handleViewModeChange(mode)}
                            type="button"
                          >
                            {mode}
                          </button>
                        ))}
                      </div>
                      <div className={s.meshSegmented}>
                        {([
                          ["surface+edges", "Surface+Edges"],
                          ["wireframe", "Wireframe"],
                          ["points", "Points"],
                        ] as [RenderMode, string][]).map(([mode, label]) => (
                          <button
                            key={mode}
                            className={s.meshSegmentBtn}
                            data-active={meshRenderMode === mode}
                            onClick={() => setMeshRenderMode(mode)}
                            type="button"
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <div className={s.meshHintText}>
                        Hover a boundary face to preview quality. Click to inspect it, and use
                        Shift/Ctrl-click to build a multi-selection like a real mesh workspace.
                      </div>
                    </div>

                    {meshFaceDetail && (
                      <div className={s.meshCard}>
                        <div className={s.meshCardHeader}>
                          <span className={s.meshCardTitle}>Selection</span>
                          <span className={s.meshCardBadge}>
                            {meshSelection.selectedFaceIndices.length} face{meshSelection.selectedFaceIndices.length === 1 ? "" : "s"}
                          </span>
                        </div>
                        <div className={s.meshInfoList}>
                          <div className={s.meshInfoRow}>
                            <span className={s.meshInfoKey}>Face</span>
                            <span className={s.meshInfoValue}>#{meshFaceDetail.faceIndex}</span>
                          </div>
                          <div className={s.meshInfoRow}>
                            <span className={s.meshInfoKey}>Nodes</span>
                            <span className={s.meshInfoValue}>{meshFaceDetail.nodeIndices.join(", ")}</span>
                          </div>
                          <div className={s.meshInfoRow}>
                            <span className={s.meshInfoKey}>Area</span>
                            <span className={s.meshInfoValue}>{fmtExp(meshFaceDetail.area)} m²</span>
                          </div>
                          <div className={s.meshInfoRow}>
                            <span className={s.meshInfoKey}>Perimeter</span>
                            <span className={s.meshInfoValue}>{fmtSI(meshFaceDetail.perimeter, "m")}</span>
                          </div>
                          <div className={s.meshInfoRow}>
                            <span className={s.meshInfoKey}>Aspect Ratio</span>
                            <span className={s.meshInfoValue}>{meshFaceDetail.aspectRatio.toFixed(2)}</span>
                          </div>
                          <div className={s.meshInfoRow}>
                            <span className={s.meshInfoKey}>Edges</span>
                            <span className={s.meshInfoValue}>
                              {meshFaceDetail.edgeLengths.map((value) => fmtSI(value, "m")).join(" · ")}
                            </span>
                          </div>
                          <div className={s.meshInfoRow}>
                            <span className={s.meshInfoKey}>Centroid</span>
                            <span className={s.meshInfoValue}>
                              {meshFaceDetail.centroid.map((value) => fmtExp(value)).join(", ")}
                            </span>
                          </div>
                          <div className={s.meshInfoRow}>
                            <span className={s.meshInfoKey}>Normal</span>
                            <span className={s.meshInfoValue}>
                              {meshFaceDetail.normal.map((value) => value.toFixed(3)).join(", ")}
                            </span>
                          </div>
                        </div>
                        <div className={s.meshSegmented}>
                          <button
                            className={s.meshSegmentBtn}
                            onClick={() =>
                              setMeshSelection({ selectedFaceIndices: [], primaryFaceIndex: null })
                            }
                            type="button"
                          >
                            Clear selection
                          </button>
                        </div>
                      </div>
                    )}

                    <div className={s.meshCard}>
                      <div className={s.meshCardHeader}>
                        <span className={s.meshCardTitle}>Geometry Bounds</span>
                      </div>
                      <div className={s.meshInfoList}>
                        <div className={s.meshInfoRow}>
                          <span className={s.meshInfoKey}>Mesh name</span>
                          <span className={s.meshInfoValue}>{meshName ?? "—"}</span>
                        </div>
                        <div className={s.meshInfoRow}>
                          <span className={s.meshInfoKey}>Source</span>
                          <span className={s.meshInfoValue} title={meshSource ?? undefined}>
                            {meshSource ? meshSource.split("/").pop() : "generated"}
                          </span>
                        </div>
                        <div className={s.meshInfoRow}>
                          <span className={s.meshInfoKey}>Extent X</span>
                          <span className={s.meshInfoValue}>
                            {meshExtent ? fmtSI(meshExtent[0], "m") : "—"}
                          </span>
                        </div>
                        <div className={s.meshInfoRow}>
                          <span className={s.meshInfoKey}>Extent Y</span>
                          <span className={s.meshInfoValue}>
                            {meshExtent ? fmtSI(meshExtent[1], "m") : "—"}
                          </span>
                        </div>
                        <div className={s.meshInfoRow}>
                          <span className={s.meshInfoKey}>Extent Z</span>
                          <span className={s.meshInfoValue}>
                            {meshExtent ? fmtSI(meshExtent[2], "m") : "—"}
                          </span>
                        </div>
                        <div className={s.meshInfoRow}>
                          <span className={s.meshInfoKey}>Bounds min</span>
                          <span className={s.meshInfoValue}>
                            {meshBoundsMin
                              ? `${fmtExp(meshBoundsMin[0])}, ${fmtExp(meshBoundsMin[1])}, ${fmtExp(meshBoundsMin[2])}`
                              : "—"}
                          </span>
                        </div>
                        <div className={s.meshInfoRow}>
                          <span className={s.meshInfoKey}>Bounds max</span>
                          <span className={s.meshInfoValue}>
                            {meshBoundsMax
                              ? `${fmtExp(meshBoundsMax[0])}, ${fmtExp(meshBoundsMax[1])}, ${fmtExp(meshBoundsMax[2])}`
                              : "—"}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className={s.meshHintBox}>
                      <div className={s.meshHintTitle}>Pipeline</div>
                      <div className={s.meshHintText}>
                        {effectiveFemMesh?.elements.length
                          ? "Surface import completed and tetrahedral volume mesh is active."
                          : "Surface preview is shown before full tetrahedral meshing completes."}
                      </div>
                    </div>
                  </>
                )}

                {femDockTab === "mesher" && (
                  <>
                    <div className={s.meshCard}>
                      <div className={s.meshCardHeader}>
                        <span className={s.meshCardTitle}>Mesher Runtime</span>
                        <span className={s.meshCardBadge}>{mesherBackend ?? "—"}</span>
                      </div>
                      <div className={s.meshInfoList}>
                        <div className={s.meshInfoRow}>
                          <span className={s.meshInfoKey}>Backend</span>
                          <span className={s.meshInfoValue}>{mesherBackend ?? "—"}</span>
                        </div>
                        <div className={s.meshInfoRow}>
                          <span className={s.meshInfoKey}>Source kind</span>
                          <span className={s.meshInfoValue}>{mesherSourceKind ?? "—"}</span>
                        </div>
                        <div className={s.meshInfoRow}>
                          <span className={s.meshInfoKey}>Order</span>
                          <span className={s.meshInfoValue}>
                            {typeof mesherCurrentSettings?.order === "number"
                              ? String(mesherCurrentSettings.order)
                              : "—"}
                          </span>
                        </div>
                        <div className={s.meshInfoRow}>
                          <span className={s.meshInfoKey}>hmax</span>
                          <span className={s.meshInfoValue}>
                            {typeof mesherCurrentSettings?.hmax === "number"
                              ? fmtSI(mesherCurrentSettings.hmax, "m")
                              : "—"}
                          </span>
                        </div>
                      </div>
                    </div>

                    <MeshSettingsPanel
                      options={meshOptions}
                      onChange={setMeshOptions}
                      quality={meshQualityData}
                      generating={meshGenerating}
                      onGenerate={handleMeshGenerate}
                    />
                  </>
                )}

                {femDockTab === "view" && (
                  <>
                    <div className={s.meshCard}>
                      <div className={s.meshCardHeader}>
                        <span className={s.meshCardTitle}>Display</span>
                      </div>
                      <div className={s.meshSegmented}>
                        {(["Mesh", "3D", "2D"] as ViewportMode[]).map((mode) => (
                          <button
                            key={mode}
                            className={s.meshSegmentBtn}
                            data-active={viewMode === mode}
                            onClick={() => handleViewModeChange(mode)}
                            type="button"
                          >
                            {mode}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className={s.meshCard}>
                      <div className={s.meshCardHeader}>
                        <span className={s.meshCardTitle}>Field</span>
                      </div>
                      <label className={s.meshControl}>
                        <span className={s.meshControlLabel}>Quantity</span>
                        <select
                          className={s.meshSelect}
                          value={preview?.quantity ?? selectedQuantity}
                          onChange={(e) => {
                            const next = e.target.value;
                            if (preview) void updatePreview("/quantity", { quantity: next });
                            else setSelectedQuantity(next);
                          }}
                          disabled={previewBusy}
                        >
                          {(previewQuantityOptions.length
                            ? previewQuantityOptions
                            : [{ value: "m", label: "Magnetization", disabled: false }]).map((opt) => (
                            <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className={s.meshControl}>
                        <span className={s.meshControlLabel}>Component</span>
                        {preview ? (
                          <select
                            className={s.meshSelect}
                            value={preview.component}
                            onChange={(e) => void updatePreview("/component", { component: e.target.value as PreviewComponent })}
                            disabled={previewBusy}
                          >
                            <option value="3D">3D</option>
                            <option value="x">x</option>
                            <option value="y">y</option>
                            <option value="z">z</option>
                          </select>
                        ) : (
                          <select
                            className={s.meshSelect}
                            value={component}
                            onChange={(e) => setComponent(e.target.value as VectorComponent)}
                          >
                            <option value="magnitude">Magnitude</option>
                            <option value="x">x</option>
                            <option value="y">y</option>
                            <option value="z">z</option>
                          </select>
                        )}
                      </label>
                    </div>

                    <div className={s.meshCard}>
                      <div className={s.meshCardHeader}>
                        <span className={s.meshCardTitle}>Rendering</span>
                      </div>
                      <div className={s.meshSegmented}>
                        {([
                          ["surface", "Surface"],
                          ["surface+edges", "Surface+Edges"],
                          ["wireframe", "Wireframe"],
                          ["points", "Points"],
                        ] as [RenderMode, string][]).map(([mode, label]) => (
                          <button
                            key={mode}
                            className={s.meshSegmentBtn}
                            data-active={meshRenderMode === mode}
                            onClick={() => setMeshRenderMode(mode)}
                            type="button"
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <label className={s.meshControl}>
                        <span className={s.meshControlLabel}>Opacity</span>
                        <div className={s.meshRangeRow}>
                          <input
                            className={s.meshRange}
                            type="range"
                            min={10}
                            max={100}
                            value={meshOpacity}
                            onChange={(e) => setMeshOpacity(Number(e.target.value))}
                          />
                          <span className={s.meshRangeValue}>{meshOpacity}%</span>
                        </div>
                      </label>
                      <label className={s.meshCheckbox}>
                        <input
                          type="checkbox"
                          checked={meshShowArrows}
                          onChange={(e) => setMeshShowArrows(e.target.checked)}
                        />
                        <span>Show vector arrows on the surface</span>
                      </label>
                    </div>

                    <div className={s.meshCard}>
                      <div className={s.meshCardHeader}>
                        <span className={s.meshCardTitle}>Clipping</span>
                      </div>
                      <label className={s.meshCheckbox}>
                        <input
                          type="checkbox"
                          checked={meshClipEnabled}
                          onChange={(e) => setMeshClipEnabled(e.target.checked)}
                        />
                        <span>Enable clip plane</span>
                      </label>
                      <div className={s.meshSegmented}>
                        {(["x", "y", "z"] as ClipAxis[]).map((axis) => (
                          <button
                            key={axis}
                            className={s.meshSegmentBtn}
                            data-active={meshClipAxis === axis}
                            onClick={() => setMeshClipAxis(axis)}
                            type="button"
                            disabled={!meshClipEnabled}
                          >
                            {axis.toUpperCase()}
                          </button>
                        ))}
                      </div>
                      <div className={s.meshRangeRow}>
                        <input
                          className={s.meshRange}
                          type="range"
                          min={0}
                          max={100}
                          value={meshClipPos}
                          onChange={(e) => setMeshClipPos(Number(e.target.value))}
                          disabled={!meshClipEnabled}
                        />
                        <span className={s.meshRangeValue}>{meshClipPos}%</span>
                      </div>
                    </div>
                  </>
                )}

                {femDockTab === "quality" && (
                  <>
                    <div className={s.meshCard}>
                      <div className={s.meshCardHeader}>
                        <span className={s.meshCardTitle}>Boundary Triangle Quality</span>
                        <span className={s.meshCardBadge}>
                          {meshQualitySummary
                            ? (meshQualitySummary.mean < 3
                              ? "good"
                              : meshQualitySummary.mean < 6
                                ? "fair"
                                : "poor")
                            : "pending"}
                        </span>
                      </div>
                      {meshQualitySummary ? (
                        <>
                          <div className={s.meshStatGrid}>
                            <div className={s.meshStatCard}>
                              <span className={s.meshStatLabel}>Mean AR</span>
                              <span className={s.meshStatValue}>{meshQualitySummary.mean.toFixed(2)}</span>
                            </div>
                            <div className={s.meshStatCard}>
                              <span className={s.meshStatLabel}>Min AR</span>
                              <span className={s.meshStatValue}>{meshQualitySummary.min.toFixed(2)}</span>
                            </div>
                            <div className={s.meshStatCard}>
                              <span className={s.meshStatLabel}>Max AR</span>
                              <span className={s.meshStatValue}>{meshQualitySummary.max.toFixed(2)}</span>
                            </div>
                            <div className={s.meshStatCard}>
                              <span className={s.meshStatLabel}>Faces analysed</span>
                              <span className={s.meshStatValue}>{meshQualitySummary.count.toLocaleString()}</span>
                            </div>
                          </div>
                          {([
                            ["Good", meshQualitySummary.good, "var(--status-running)"],
                            ["Fair", meshQualitySummary.fair, "var(--status-warn)"],
                            ["Poor", meshQualitySummary.poor, "var(--status-failed)"],
                          ] as [string, number, string][]).map(([label, count, color]) => {
                            const pct = meshQualitySummary.count > 0
                              ? (count / meshQualitySummary.count) * 100
                              : 0;
                            return (
                              <div key={label} className={s.meshQualityRow}>
                                <span className={s.meshQualityLabel}>{label}</span>
                                <div className={s.meshQualityTrack}>
                                  <div
                                    className={s.meshQualityFill}
                                    style={{ width: `${pct}%`, background: color }}
                                  />
                                </div>
                                <span className={s.meshQualityValue}>{pct.toFixed(1)}%</span>
                              </div>
                            );
                          })}
                        </>
                      ) : (
                        <div className={s.meshHintText}>
                          Quality statistics will appear once the FEM boundary surface is available.
                        </div>
                      )}
                    </div>

                    <div className={s.meshHintBox}>
                      <div className={s.meshHintTitle}>Interpretation</div>
                      <div className={s.meshHintText}>
                        Good meshes cluster near AR≈1-3. If the poor fraction stays high, lower
                        `hmax` or clean the imported surface before tetrahedralization.
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </Panel>

          <PanelResizeHandle className={s.meshDockResizeHandle} />

          <Panel
            id="workspace-fem-viewport"
            defaultSize={PANEL_SIZES.femViewportDefault}
            minSize={PANEL_SIZES.femViewportMin}
          >
            <div className={s.viewport}>
        {/* Compact selector bar */}
        <div className={s.viewportBar}>
          {isMeshWorkspaceView ? (
            <>
              <span className={s.viewportBarLabel}>Mesh</span>
              <span className={s.viewportBarMetric}>{meshName ?? "boundary surface"}</span>
              <span className={s.viewportBarSep} />
              <span className={s.viewportBarMetric}>{effectiveFemMesh?.nodes.length.toLocaleString() ?? "0"} nodes</span>
              <span className={s.viewportBarMetric}>{effectiveFemMesh?.elements.length.toLocaleString() ?? "0"} tets</span>
              <span className={s.viewportBarMetric}>{effectiveFemMesh?.boundary_faces.length.toLocaleString() ?? "0"} faces</span>
              <span className={s.viewportBarSep} />
              <span className={s.viewportBarLabel}>Render</span>
              <span className={s.viewportBarMetric}>
                {meshRenderMode === "surface+edges"
                  ? "surface+edges"
                  : meshRenderMode}
              </span>
              {meshSelection.primaryFaceIndex != null && (
                <>
                  <span className={s.viewportBarSep} />
                  <span className={s.viewportBarLabel}>Face</span>
                  <span className={s.viewportBarMetric}>#{meshSelection.primaryFaceIndex}</span>
                </>
              )}
            </>
          ) : (
            <>
              <span className={s.viewportBarLabel}>Qty</span>
              <select
                className={s.viewportBarSelect}
                value={preview?.quantity ?? selectedQuantity}
                onChange={(e) => {
                  const next = e.target.value;
                  if (preview) {
                    void updatePreview("/quantity", { quantity: next });
                  } else {
                    setSelectedQuantity(next);
                  }
                }}
                disabled={previewBusy}
              >
                {((preview ? previewQuantityOptions : quantityOptions).length
                  ? (preview ? previewQuantityOptions : quantityOptions)
                  : [{ value: "m", label: "Magnetization", disabled: false }]).map((opt) => (
                  <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                    {opt.label}
                  </option>
                ))}
              </select>

              <span className={s.viewportBarSep} />
              <span className={s.viewportBarLabel}>Comp</span>
              {preview ? (
                <select
                  className={s.viewportBarSelect}
                  value={preview.component}
                  onChange={(e) => void updatePreview("/component", { component: e.target.value as PreviewComponent })}
                  disabled={previewBusy}
                >
                  <option value="3D">3D</option>
                  <option value="x">x</option>
                  <option value="y">y</option>
                  <option value="z">z</option>
                </select>
              ) : (
                <select
                  className={s.viewportBarSelect}
                  value={component}
                  onChange={(e) => setComponent(e.target.value as VectorComponent)}
                >
                  <option value="magnitude">|v|</option>
                  <option value="x">x</option>
                  <option value="y">y</option>
                  <option value="z">z</option>
                </select>
              )}

              {preview ? (
                <>
                  {preview.x_possible_sizes.length > 0 && preview.y_possible_sizes.length > 0 && (
                    <>
                      <span className={s.viewportBarSep} />
                      <span className={s.viewportBarLabel}>X</span>
                      <select
                        className={s.viewportBarSelect}
                        value={preview.x_chosen_size}
                        onChange={(e) =>
                          void updatePreview("/XChosenSize", { xChosenSize: Number(e.target.value) })
                        }
                        disabled={previewBusy}
                      >
                        {preview.x_possible_sizes.map((size) => (
                          <option key={size} value={size}>{size}</option>
                        ))}
                      </select>
                      <span className={s.viewportBarLabel}>Y</span>
                      <select
                        className={s.viewportBarSelect}
                        value={preview.y_chosen_size}
                        onChange={(e) =>
                          void updatePreview("/YChosenSize", { yChosenSize: Number(e.target.value) })
                        }
                        disabled={previewBusy}
                      >
                        {preview.y_possible_sizes.map((size) => (
                          <option key={size} value={size}>{size}</option>
                        ))}
                      </select>
                    </>
                  )}
                  <label className={s.viewportToggle}>
                    <input
                      type="checkbox"
                      checked={preview.auto_scale_enabled}
                      onChange={(e) =>
                        void updatePreview("/autoScaleEnabled", {
                          autoScaleEnabled: e.target.checked,
                        })
                      }
                      disabled={previewBusy}
                    />
                    <span>Auto-scale</span>
                  </label>
                  {preview.spatial_kind === "grid" && solverGrid[2] > 1 && (
                    <>
                      <span className={s.viewportBarLabel}>Layer</span>
                      <select
                        className={s.viewportBarSelect}
                        value={preview.layer}
                        onChange={(e) => void updatePreview("/layer", { layer: Number(e.target.value) })}
                        disabled={previewBusy || preview.all_layers}
                      >
                        {Array.from({ length: solverGrid[2] }, (_, i) => (
                          <option key={i} value={i}>{i}</option>
                        ))}
                      </select>
                      <label className={s.viewportToggle}>
                        <input
                          type="checkbox"
                          checked={preview.all_layers}
                          onChange={(e) =>
                            void updatePreview("/allLayers", { allLayers: e.target.checked })
                          }
                          disabled={previewBusy}
                        />
                        <span>All layers</span>
                      </label>
                    </>
                  )}
                  {preview.spatial_kind === "mesh" && effectiveViewMode === "2D" && (
                    <>
                      <span className={s.viewportBarSep} />
                      <span className={s.viewportBarLabel}>Plane</span>
                      <select
                        className={s.viewportBarSelect}
                        value={plane}
                        onChange={(e) => setPlane(e.target.value as SlicePlane)}
                      >
                        <option value="xy">XY</option>
                        <option value="xz">XZ</option>
                        <option value="yz">YZ</option>
                      </select>
                      <span className={s.viewportBarLabel}>Slice</span>
                      <select
                        className={s.viewportBarSelect}
                        value={sliceIndex}
                        onChange={(e) => setSliceIndex(Number(e.target.value))}
                      >
                        {Array.from({ length: maxSliceCount }, (_, i) => (
                          <option key={i} value={i}>{i + 1}</option>
                        ))}
                      </select>
                    </>
                  )}
                </>
              ) : effectiveViewMode === "2D" && (
                <>
                  <span className={s.viewportBarSep} />
                  <span className={s.viewportBarLabel}>Plane</span>
                  <select
                    className={s.viewportBarSelect}
                    value={plane}
                    onChange={(e) => setPlane(e.target.value as SlicePlane)}
                  >
                    <option value="xy">XY</option>
                    <option value="xz">XZ</option>
                    <option value="yz">YZ</option>
                  </select>
                  <span className={s.viewportBarLabel}>Slice</span>
                  <select
                    className={s.viewportBarSelect}
                    value={sliceIndex}
                    onChange={(e) => setSliceIndex(Number(e.target.value))}
                  >
                    {Array.from({ length: maxSliceCount }, (_, i) => (
                      <option key={i} value={i}>{i + 1}</option>
                    ))}
                  </select>
                </>
              )}
            </>
          )}
        </div>
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
        {previewMessage && <div className={s.previewStatus}>{previewMessage}</div>}

        {/* Canvas area */}
        <div className={s.viewportCanvas}>
          {/* Status overlay */}
          <div className={s.viewportOverlay}>
            <span>Step {effectiveStep.toLocaleString()}</span>
            <span>{fmtSI(effectiveTime, "s")}</span>
            {effectiveDmDt > 0 && (
              <span style={{ color: effectiveDmDt < 1e-5 ? "var(--status-running)" : undefined }}>
                dm/dt {fmtExp(effectiveDmDt)}
              </span>
            )}
          </div>
          {!isVectorQuantity ? (
            <div style={{ padding: "1rem" }}>
              <EmptyState
                title={quantityDescriptor?.label ?? "Scalar quantity"}
                description={
                  selectedScalarValue !== null
                    ? `Latest: ${selectedScalarValue.toExponential(4)} ${quantityDescriptor?.unit ?? ""}`
                    : "Scalar — see Scalars in sidebar."
                }
                tone="info"
                compact
              />
            </div>
          ) : preview && preview.spatial_kind === "grid" && preview.type === "2D" && preview.scalar_field.length > 0 ? (
            <PreviewScalarField2D
              data={preview.scalar_field}
              grid={preview.preview_grid}
              quantityLabel={quantityDescriptor?.label ?? preview.quantity}
              quantityUnit={preview.unit}
              component={preview.component}
              min={preview.min}
              max={preview.max}
            />
          ) : effectiveViewMode === "Mesh" && isFemBackend && femMeshData ? (
            <FemMeshView3D
              topologyKey={femTopologyKey ?? undefined}
              meshData={femMeshData}
              colorField="quality"
              toolbarMode="hidden"
              renderMode={meshRenderMode}
              opacity={meshOpacity}
              clipEnabled={meshClipEnabled}
              clipAxis={meshClipAxis}
              clipPos={meshClipPos}
              showArrows={false}
              onRenderModeChange={setMeshRenderMode}
              onOpacityChange={setMeshOpacity}
              onClipEnabledChange={setMeshClipEnabled}
              onClipAxisChange={setMeshClipAxis}
              onClipPosChange={setMeshClipPos}
              onShowArrowsChange={setMeshShowArrows}
              onSelectionChange={setMeshSelection}
            />
          ) : effectiveViewMode === "3D" && isFemBackend && femMeshData ? (
            <FemMeshView3D
              topologyKey={femTopologyKey ?? undefined}
              meshData={femMeshData}
              fieldLabel={quantityDescriptor?.label ?? selectedQuantity}
              colorField={femColorField}
              showOrientationLegend={femMagnetization3DActive}
              toolbarMode="hidden"
              renderMode={meshRenderMode}
              opacity={meshOpacity}
              clipEnabled={meshClipEnabled}
              clipAxis={meshClipAxis}
              clipPos={meshClipPos}
              showArrows={femShouldShowArrows}
              onRenderModeChange={setMeshRenderMode}
              onOpacityChange={setMeshOpacity}
              onClipEnabledChange={setMeshClipEnabled}
              onClipAxisChange={setMeshClipAxis}
              onClipPosChange={setMeshClipPos}
              onShowArrowsChange={setMeshShowArrows}
              onSelectionChange={setMeshSelection}
            />
          ) : effectiveViewMode === "2D" && isFemBackend && femMeshData ? (
            <FemMeshSlice2D
              meshData={femMeshData}
              quantityLabel={quantityDescriptor?.label ?? selectedQuantity}
              quantityId={selectedQuantity}
              component={effectiveVectorComponent}
              plane={plane}
              sliceIndex={sliceIndex}
              sliceCount={maxSliceCount}
            />
          ) : !selectedVectors ? (
            <div style={{ padding: "1rem" }}>
              <EmptyState
                title={emptyStateMessage.title}
                description={emptyStateMessage.description}
                tone="info"
                compact
              />
            </div>
          ) : effectiveViewMode === "3D" ? (
            <MagnetizationView3D
              grid={previewGrid}
              vectors={selectedVectors}
              fieldLabel={quantityDescriptor?.label ?? preview?.quantity ?? selectedQuantity}
            />
          ) : (
            <MagnetizationSlice2D
              grid={previewGrid}
              vectors={selectedVectors}
              quantityLabel={quantityDescriptor?.label ?? preview?.quantity ?? selectedQuantity}
              quantityId={preview?.quantity ?? selectedQuantity}
              component={component}
              plane={plane}
              sliceIndex={sliceIndex}
            />
          )}
        </div>
      </div>
          </Panel>
        </PanelGroup>
      ) : (
      <div className={s.viewport}>
        {/* Compact selector bar */}
        <div className={s.viewportBar}>
          {isMeshWorkspaceView ? (
            <>
              <span className={s.viewportBarLabel}>Mesh</span>
              <span className={s.viewportBarMetric}>{meshName ?? "boundary surface"}</span>
              <span className={s.viewportBarSep} />
              <span className={s.viewportBarMetric}>{effectiveFemMesh?.nodes.length.toLocaleString() ?? "0"} nodes</span>
              <span className={s.viewportBarMetric}>{effectiveFemMesh?.elements.length.toLocaleString() ?? "0"} tets</span>
              <span className={s.viewportBarMetric}>{effectiveFemMesh?.boundary_faces.length.toLocaleString() ?? "0"} faces</span>
              <span className={s.viewportBarSep} />
              <span className={s.viewportBarLabel}>Render</span>
              <span className={s.viewportBarMetric}>
                {meshRenderMode === "surface+edges"
                  ? "surface+edges"
                  : meshRenderMode}
              </span>
              {meshSelection.primaryFaceIndex != null && (
                <>
                  <span className={s.viewportBarSep} />
                  <span className={s.viewportBarLabel}>Face</span>
                  <span className={s.viewportBarMetric}>#{meshSelection.primaryFaceIndex}</span>
                </>
              )}
            </>
          ) : (
            <>
              <span className={s.viewportBarLabel}>Qty</span>
              <select
                className={s.viewportBarSelect}
                value={preview?.quantity ?? selectedQuantity}
                onChange={(e) => {
                  const next = e.target.value;
                  if (preview) {
                    void updatePreview("/quantity", { quantity: next });
                  } else {
                    setSelectedQuantity(next);
                  }
                }}
                disabled={previewBusy}
              >
                {((preview ? previewQuantityOptions : quantityOptions).length
                  ? (preview ? previewQuantityOptions : quantityOptions)
                  : [{ value: "m", label: "Magnetization", disabled: false }]).map((opt) => (
                  <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                    {opt.label}
                  </option>
                ))}
              </select>

              <span className={s.viewportBarSep} />
              <span className={s.viewportBarLabel}>Comp</span>
              {preview ? (
                <select
                  className={s.viewportBarSelect}
                  value={preview.component}
                  onChange={(e) => void updatePreview("/component", { component: e.target.value as PreviewComponent })}
                  disabled={previewBusy}
                >
                  <option value="3D">3D</option>
                  <option value="x">x</option>
                  <option value="y">y</option>
                  <option value="z">z</option>
                </select>
              ) : (
                <select
                  className={s.viewportBarSelect}
                  value={component}
                  onChange={(e) => setComponent(e.target.value as VectorComponent)}
                >
                  <option value="magnitude">|v|</option>
                  <option value="x">x</option>
                  <option value="y">y</option>
                  <option value="z">z</option>
                </select>
              )}

              {preview ? (
                <>
                  {preview.x_possible_sizes.length > 0 && preview.y_possible_sizes.length > 0 && (
                    <>
                      <span className={s.viewportBarSep} />
                      <span className={s.viewportBarLabel}>X</span>
                      <select
                        className={s.viewportBarSelect}
                        value={preview.x_chosen_size}
                        onChange={(e) =>
                          void updatePreview("/XChosenSize", { xChosenSize: Number(e.target.value) })
                        }
                        disabled={previewBusy}
                      >
                        {preview.x_possible_sizes.map((size) => (
                          <option key={size} value={size}>{size}</option>
                        ))}
                      </select>
                      <span className={s.viewportBarLabel}>Y</span>
                      <select
                        className={s.viewportBarSelect}
                        value={preview.y_chosen_size}
                        onChange={(e) =>
                          void updatePreview("/YChosenSize", { yChosenSize: Number(e.target.value) })
                        }
                        disabled={previewBusy}
                      >
                        {preview.y_possible_sizes.map((size) => (
                          <option key={size} value={size}>{size}</option>
                        ))}
                      </select>
                    </>
                  )}
                  <label className={s.viewportToggle}>
                    <input
                      type="checkbox"
                      checked={preview.auto_scale_enabled}
                      onChange={(e) =>
                        void updatePreview("/autoScaleEnabled", {
                          autoScaleEnabled: e.target.checked,
                        })
                      }
                      disabled={previewBusy}
                    />
                    <span>Auto-scale</span>
                  </label>
                  {preview.spatial_kind === "grid" && solverGrid[2] > 1 && (
                    <>
                      <span className={s.viewportBarLabel}>Layer</span>
                      <select
                        className={s.viewportBarSelect}
                        value={preview.layer}
                        onChange={(e) => void updatePreview("/layer", { layer: Number(e.target.value) })}
                        disabled={previewBusy || preview.all_layers}
                      >
                        {Array.from({ length: solverGrid[2] }, (_, i) => (
                          <option key={i} value={i}>{i}</option>
                        ))}
                      </select>
                      <label className={s.viewportToggle}>
                        <input
                          type="checkbox"
                          checked={preview.all_layers}
                          onChange={(e) =>
                            void updatePreview("/allLayers", { allLayers: e.target.checked })
                          }
                          disabled={previewBusy}
                        />
                        <span>All layers</span>
                      </label>
                    </>
                  )}
                  {preview.spatial_kind === "mesh" && effectiveViewMode === "2D" && (
                    <>
                      <span className={s.viewportBarSep} />
                      <span className={s.viewportBarLabel}>Plane</span>
                      <select
                        className={s.viewportBarSelect}
                        value={plane}
                        onChange={(e) => setPlane(e.target.value as SlicePlane)}
                      >
                        <option value="xy">XY</option>
                        <option value="xz">XZ</option>
                        <option value="yz">YZ</option>
                      </select>
                      <span className={s.viewportBarLabel}>Slice</span>
                      <select
                        className={s.viewportBarSelect}
                        value={sliceIndex}
                        onChange={(e) => setSliceIndex(Number(e.target.value))}
                      >
                        {Array.from({ length: maxSliceCount }, (_, i) => (
                          <option key={i} value={i}>{i + 1}</option>
                        ))}
                      </select>
                    </>
                  )}
                </>
              ) : effectiveViewMode === "2D" && (
                <>
                  <span className={s.viewportBarSep} />
                  <span className={s.viewportBarLabel}>Plane</span>
                  <select
                    className={s.viewportBarSelect}
                    value={plane}
                    onChange={(e) => setPlane(e.target.value as SlicePlane)}
                  >
                    <option value="xy">XY</option>
                    <option value="xz">XZ</option>
                    <option value="yz">YZ</option>
                  </select>
                  <span className={s.viewportBarLabel}>Slice</span>
                  <select
                    className={s.viewportBarSelect}
                    value={sliceIndex}
                    onChange={(e) => setSliceIndex(Number(e.target.value))}
                  >
                    {Array.from({ length: maxSliceCount }, (_, i) => (
                      <option key={i} value={i}>{i + 1}</option>
                    ))}
                  </select>
                </>
              )}
            </>
          )}
        </div>
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
        {previewMessage && <div className={s.previewStatus}>{previewMessage}</div>}

        {/* Canvas area */}
        <div className={s.viewportCanvas}>
          {/* Status overlay */}
          <div className={s.viewportOverlay}>
            <span>Step {effectiveStep.toLocaleString()}</span>
            <span>{fmtSI(effectiveTime, "s")}</span>
            {effectiveDmDt > 0 && (
              <span style={{ color: effectiveDmDt < 1e-5 ? "var(--status-running)" : undefined }}>
                dm/dt {fmtExp(effectiveDmDt)}
              </span>
            )}
          </div>
          {!isVectorQuantity ? (
            <div style={{ padding: "1rem" }}>
              <EmptyState
                title={quantityDescriptor?.label ?? "Scalar quantity"}
                description={
                  selectedScalarValue !== null
                    ? `Latest: ${selectedScalarValue.toExponential(4)} ${quantityDescriptor?.unit ?? ""}`
                    : "Scalar — see Scalars in sidebar."
                }
                tone="info"
                compact
              />
            </div>
          ) : preview && preview.spatial_kind === "grid" && preview.type === "2D" && preview.scalar_field.length > 0 ? (
            <PreviewScalarField2D
              data={preview.scalar_field}
              grid={preview.preview_grid}
              quantityLabel={quantityDescriptor?.label ?? preview.quantity}
              quantityUnit={preview.unit}
              component={preview.component}
              min={preview.min}
              max={preview.max}
            />
          ) : effectiveViewMode === "Mesh" && isFemBackend && femMeshData ? (
            <FemMeshView3D
              topologyKey={femTopologyKey ?? undefined}
              meshData={femMeshData}
              colorField="quality"
              showArrows={false}
              onSelectionChange={setMeshSelection}
            />
          ) : effectiveViewMode === "3D" && isFemBackend && femMeshData ? (
            <FemMeshView3D
              topologyKey={femTopologyKey ?? undefined}
              meshData={femMeshData}
              fieldLabel={quantityDescriptor?.label ?? selectedQuantity}
              colorField={femColorField}
              showOrientationLegend={femMagnetization3DActive}
              showArrows={femShouldShowArrows}
              onSelectionChange={setMeshSelection}
            />
          ) : effectiveViewMode === "2D" && isFemBackend && femMeshData ? (
            <FemMeshSlice2D
              meshData={femMeshData}
              quantityLabel={quantityDescriptor?.label ?? selectedQuantity}
              quantityId={selectedQuantity}
              component={effectiveVectorComponent}
              plane={plane}
              sliceIndex={sliceIndex}
              sliceCount={maxSliceCount}
            />
          ) : !selectedVectors ? (
            <div style={{ padding: "1rem" }}>
              <EmptyState
                title={emptyStateMessage.title}
                description={emptyStateMessage.description}
                tone="info"
                compact
              />
            </div>
          ) : effectiveViewMode === "3D" ? (
            <MagnetizationView3D
              grid={previewGrid}
              vectors={selectedVectors}
              fieldLabel={quantityDescriptor?.label ?? preview?.quantity ?? selectedQuantity}
            />
          ) : (
            <MagnetizationSlice2D
              grid={previewGrid}
              vectors={selectedVectors}
              quantityLabel={quantityDescriptor?.label ?? preview?.quantity ?? selectedQuantity}
              quantityId={preview?.quantity ?? selectedQuantity}
              component={component}
              plane={plane}
              sliceIndex={sliceIndex}
            />
          )}
        </div>
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
      <div className={s.sidebar}>
        {/* Model Tree */}
        <ModelTree
          nodes={buildFullmagModelTree({
            backend: isFemBackend ? "FEM" : "FDM",
            geometryKind: mesherSourceKind ?? undefined,
            materialName: material?.msat != null ? `Msat=${(material.msat / 1e3).toFixed(0)} kA/m` : undefined,
            meshStatus: effectiveFemMesh ? "ready" : "pending",
            meshElements: effectiveFemMesh?.elements.length,
            solverStatus: hasSolverTelemetry ? "active" : "pending",
            onMeshClick: () => openFemMeshWorkspace("mesh"),
          })}
          activeId={femDockTab === "quality" ? "mesh-quality" : isMeshWorkspaceView ? "mesh" : null}
          onNodeClick={(id) => {
            if (id === "mesh" || id === "mesh-size" || id === "mesh-quality") {
              if (id === "mesh-quality") {
                openFemMeshWorkspace("quality");
              } else {
                openFemMeshWorkspace("mesh");
              }
            }
          }}
        />

        {/* Solver */}
        <Section title="Solver" badge={workspaceStatus}>
          <div className={s.fieldGrid2}>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>Step</span>
              <span className={s.fieldValue}>{fmtStepValue(effectiveStep, hasSolverTelemetry)}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>Time</span>
              <span className={s.fieldValue}>{fmtSIOrDash(effectiveTime, "s", hasSolverTelemetry)}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>Δt</span>
              <span className={s.fieldValue}>{fmtSIOrDash(effectiveDt, "s", hasSolverTelemetry)}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>max dm/dt</span>
              <span className={s.fieldValue} style={{
                color: hasSolverTelemetry && effectiveDmDt > 0 && effectiveDmDt < 1e-5 ? "var(--status-running)" : undefined
              }}>
                {fmtExpOrDash(effectiveDmDt, hasSolverTelemetry)}
              </span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>max |H_eff|</span>
              <span className={s.fieldValue}>{fmtExpOrDash(effectiveHEff, hasSolverTelemetry)}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>max |H_demag|</span>
              <span className={s.fieldValue}>{fmtExpOrDash(effectiveHDemag, hasSolverTelemetry)}</span>
            </div>
          </div>
          {!hasSolverTelemetry && (
            <div className={s.meshHintText} style={{ paddingTop: "0.5rem" }}>
              {solverNotStartedMessage}
            </div>
          )}
          {dmDtSpark.length > 1 && (
            <Sparkline data={dmDtSpark} width={140} height={20} color="var(--status-running)" label="dm/dt" />
          )}
          {dtSpark.length > 1 && (
            <Sparkline data={dtSpark} width={140} height={20} color="var(--ide-accent)" label="Δt" />
          )}
        </Section>

        {interactiveControlsEnabled && (
          <Section title="Interactive" badge={awaitingCommand ? "awaiting" : "running"}>
            <div className={s.interactiveBlock}>
              <label className={s.interactiveLabel}>
                Run until [s]
                <input
                  className={s.interactiveInput}
                  value={runUntilInput}
                  onChange={(e) => setRunUntilInput(e.target.value)}
                  disabled={commandBusy || !awaitingCommand}
                />
              </label>
              <Button
                size="sm"
                tone="accent"
                variant="solid"
                disabled={commandBusy || !awaitingCommand}
                onClick={() =>
                  enqueueCommand({
                    kind: "run",
                    until_seconds: Number(runUntilInput),
                  })
                }
              >
                Run
              </Button>
            </div>
            <div className={s.interactiveBlock}>
              <label className={s.interactiveLabel}>
                Relax steps
                <input
                  className={s.interactiveInput}
                  value={relaxMaxStepsInput}
                  onChange={(e) => setRelaxMaxStepsInput(e.target.value)}
                  disabled={commandBusy || !awaitingCommand}
                />
              </label>
              <Button
                size="sm"
                tone="success"
                variant="solid"
                disabled={commandBusy || !awaitingCommand}
                onClick={() =>
                  enqueueCommand({
                    kind: "relax",
                    max_steps: Number(relaxMaxStepsInput),
                    torque_tolerance: 1e-6,
                  })
                }
              >
                Relax
              </Button>
            </div>
            <div className={s.interactiveActions}>
              <Button
                size="sm"
                tone="warn"
                variant="outline"
                disabled={commandBusy}
                onClick={() => enqueueCommand({ kind: "close" })}
              >
                Close Workspace
              </Button>
            </div>
            {commandMessage && (
              <div className={s.interactiveMessage}>{commandMessage}</div>
            )}
          </Section>
        )}

        {preview && (
          <Section
            title="Preview"
            badge={
              preview.spatial_kind === "mesh"
                ? `${preview.data_points_count.toLocaleString()} nodes`
                : `${preview.applied_x_chosen_size}×${preview.applied_y_chosen_size}`
            }
          >
            {preview.spatial_kind === "mesh" ? (
              <div className={s.fieldGrid2}>
                <div className={s.fieldCell}>
                  <span className={s.fieldLabel}>Quantity</span>
                  <span className={s.fieldValue}>{preview.quantity}</span>
                </div>
                <div className={s.fieldCell}>
                  <span className={s.fieldLabel}>Mode</span>
                  <span className={s.fieldValue}>{preview.type}</span>
                </div>
                <div className={s.fieldCell}>
                  <span className={s.fieldLabel}>Preview nodes</span>
                  <span className={s.fieldValue}>{preview.data_points_count.toLocaleString()}</span>
                </div>
                <div className={s.fieldCell}>
                  <span className={s.fieldLabel}>Preview faces</span>
                  <span className={s.fieldValue}>{preview.fem_mesh?.boundary_faces.length.toLocaleString() ?? "0"}</span>
                </div>
                <div className={s.fieldCell}>
                  <span className={s.fieldLabel}>Original nodes</span>
                  <span className={s.fieldValue}>{preview.original_node_count?.toLocaleString() ?? "—"}</span>
                </div>
                <div className={s.fieldCell}>
                  <span className={s.fieldLabel}>Original faces</span>
                  <span className={s.fieldValue}>{preview.original_face_count?.toLocaleString() ?? "—"}</span>
                </div>
              </div>
            ) : (
              <div className={s.fieldGrid2}>
                <div className={s.fieldCell}>
                  <span className={s.fieldLabel}>Quantity</span>
                  <span className={s.fieldValue}>{preview.quantity}</span>
                </div>
                <div className={s.fieldCell}>
                  <span className={s.fieldLabel}>Mode</span>
                  <span className={s.fieldValue}>{preview.type}</span>
                </div>
                <div className={s.fieldCell}>
                  <span className={s.fieldLabel}>Requested XY</span>
                  <span className={s.fieldValue}>
                    {preview.x_chosen_size}×{preview.y_chosen_size}
                  </span>
                </div>
                <div className={s.fieldCell}>
                  <span className={s.fieldLabel}>Applied XY</span>
                  <span className={s.fieldValue}>
                    {preview.applied_x_chosen_size}×{preview.applied_y_chosen_size}
                  </span>
                </div>
                <div className={s.fieldCell}>
                  <span className={s.fieldLabel}>Points</span>
                  <span className={s.fieldValue}>{preview.data_points_count.toLocaleString()}</span>
                </div>
                <div className={s.fieldCell}>
                  <span className={s.fieldLabel}>Layer stride</span>
                  <span className={s.fieldValue}>{preview.applied_layer_stride}</span>
                </div>
              </div>
            )}
          </Section>
        )}

        {/* Material */}
        {material && (
          <Section title="Material">
            <div className={s.fieldGrid3}>
              <div className={s.fieldCell}>
                <span className={s.fieldLabel}>M_sat</span>
                <span className={s.fieldValue}>{material.msat != null ? fmtSI(material.msat, "A/m") : "—"}</span>
              </div>
              <div className={s.fieldCell}>
                <span className={s.fieldLabel}>A_ex</span>
                <span className={s.fieldValue}>{material.aex != null ? fmtSI(material.aex, "J/m") : "—"}</span>
              </div>
              <div className={s.fieldCell}>
                <span className={s.fieldLabel}>α</span>
                <span className={s.fieldValue}>{material.alpha?.toPrecision(3) ?? "—"}</span>
              </div>
            </div>
            <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap", marginTop: "0.3rem" }}>
              {material.exchangeEnabled && <span className={s.termPill}>Exchange</span>}
              {material.demagEnabled && <span className={s.termPill}>Demag</span>}
              {material.zeemanField?.some((v) => v !== 0) && <span className={s.termPill}>Zeeman</span>}
            </div>
          </Section>
        )}

        {/* Energy */}
        <Section title="Energy" badge={fmtSIOrDash(effectiveETotal, "J", hasSolverTelemetry)}>
          <div className={s.fieldGrid2}>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>E_exchange</span>
              <span className={s.fieldValue}>{fmtSIOrDash(effectiveEEx, "J", hasSolverTelemetry)}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>E_demag</span>
              <span className={s.fieldValue}>{fmtSIOrDash(effectiveEDemag, "J", hasSolverTelemetry)}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>E_ext</span>
              <span className={s.fieldValue}>{fmtSIOrDash(effectiveEExt, "J", hasSolverTelemetry)}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>E_total</span>
              <span className={s.fieldValue} style={{ color: "hsl(210, 70%, 65%)" }}>
                {fmtSIOrDash(effectiveETotal, "J", hasSolverTelemetry)}
              </span>
            </div>
          </div>
          {eTotalSpark.length > 1 && (
            <Sparkline data={eTotalSpark} width={140} height={22} color="hsl(210, 70%, 55%)" label="E_tot" />
          )}
        </Section>

        {/* Derived Values */}
        {fieldStats && (
          <Section title="Derived Values" defaultOpen={false}>
            <div className={s.statsTable}>
              <span className={s.statsHeader} />
              <span className={s.statsHeader}>Mean</span>
              <span className={s.statsHeader}>Min</span>
              <span className={s.statsHeader}>Max</span>
              <span className={s.statsHeader} />

              <span className={s.statsLabel}>v.x</span>
              <span className={s.statsValue}>{fmtExp(fieldStats.meanX)}</span>
              <span className={s.statsValue}>{fmtExp(fieldStats.minX)}</span>
              <span className={s.statsValue}>{fmtExp(fieldStats.maxX)}</span>
              <span />

              <span className={s.statsLabel}>v.y</span>
              <span className={s.statsValue}>{fmtExp(fieldStats.meanY)}</span>
              <span className={s.statsValue}>{fmtExp(fieldStats.minY)}</span>
              <span className={s.statsValue}>{fmtExp(fieldStats.maxY)}</span>
              <span />

              <span className={s.statsLabel}>v.z</span>
              <span className={s.statsValue}>{fmtExp(fieldStats.meanZ)}</span>
              <span className={s.statsValue}>{fmtExp(fieldStats.minZ)}</span>
              <span className={s.statsValue}>{fmtExp(fieldStats.maxZ)}</span>
              <span />
            </div>
          </Section>
        )}

        {/* Mesh Quality (FEM only) */}
        {isFemBackend && femMeshData && effectiveViewMode === "Mesh" && (
          <Section title="Mesh Quality">
            <MeshQualityHistogram femMesh={femMeshData} />
          </Section>
        )}

        {/* Scalars Chart */}
        <Section title="Scalars" badge={`${scalarRows.length} pts`} defaultOpen={scalarRows.length > 0}>
          {scalarRows.length > 0 ? (
            <div style={{ height: 120 }}>
              <ScalarPlot rows={scalarRows} />
            </div>
          ) : (
            <div style={{ fontSize: "0.75rem", color: "var(--text-3)", padding: "0.3rem 0" }}>
              No scalar data yet
            </div>
          )}
        </Section>

        {/* Mesh Info */}
        <Section title="Mesh" defaultOpen={false}>
          <div className={s.fieldGrid2}>
            {isFemBackend && femMesh ? (
              <>
                <div className={s.fieldCell}>
                  <span className={s.fieldLabel}>Nodes</span>
                  <span className={s.fieldValue}>{femMesh.nodes.length.toLocaleString()}</span>
                </div>
                <div className={s.fieldCell}>
                  <span className={s.fieldLabel}>Elements</span>
                  <span className={s.fieldValue}>{femMesh.elements.length.toLocaleString()}</span>
                </div>
                <div className={s.fieldCell}>
                  <span className={s.fieldLabel}>Faces</span>
                  <span className={s.fieldValue}>{femMesh.boundary_faces.length.toLocaleString()}</span>
                </div>
                <div className={s.fieldCell}>
                  <span className={s.fieldLabel}>Type</span>
                  <span className={s.fieldValue}>tet4</span>
                </div>
              </>
            ) : (
              <>
                <div className={s.fieldCell}>
                  <span className={s.fieldLabel}>Grid</span>
                  <span className={s.fieldValue}>{solverGrid[0]}×{solverGrid[1]}×{solverGrid[2]}</span>
                </div>
                <div className={s.fieldCell}>
                  <span className={s.fieldLabel}>Cells</span>
                  <span className={s.fieldValue}>{totalCells?.toLocaleString() ?? "—"}</span>
                </div>
                <div className={s.fieldCell}>
                  <span className={s.fieldLabel}>{activeMaskPresent ? "Active cells" : "Magnetic cells"}</span>
                  <span className={s.fieldValue}>{activeCells?.toLocaleString() ?? "—"}</span>
                </div>
                {activeMaskPresent && (
                  <div className={s.fieldCell}>
                    <span className={s.fieldLabel}>Inactive cells</span>
                    <span className={s.fieldValue}>{inactiveCells?.toLocaleString() ?? "—"}</span>
                  </div>
                )}
              </>
            )}
          </div>
        </Section>

        {/* Workspace footer */}
        <div className={s.sidebarFooter}>
          {session?.script_path && (
            <div className={s.footerRow}>
              <span className={s.fieldLabel}>Script</span>
              <span className={s.footerValue} title={session.script_path}>
                {session.script_path.split("/").pop()}
              </span>
            </div>
          )}
          {session?.artifact_dir && (
            <div className={s.footerRow}>
              <span className={s.fieldLabel}>Output</span>
              <span className={s.footerValue} title={session.artifact_dir}>
                {session.artifact_dir.split("/").pop()}
              </span>
            </div>
          )}
          <div className={s.footerRow}>
            <span className={s.fieldLabel}>
              Workspace
            </span>
            <span className={s.footerValue}>local</span>
          </div>
        </div>
      </div>
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
