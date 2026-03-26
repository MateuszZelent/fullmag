"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { resolveApiBase } from "../../lib/apiBase";
import { useLiveStream } from "../../lib/useSessionStream";
import EngineConsole from "../panels/EngineConsole";
import MeshQualityHistogram from "../panels/MeshQualityHistogram";
import MagnetizationSlice2D from "../preview/MagnetizationSlice2D";
import MagnetizationView3D from "../preview/MagnetizationView3D";
import FemMeshView3D from "../preview/FemMeshView3D";
import FemMeshSlice2D from "../preview/FemMeshSlice2D";
import PreviewScalarField2D from "../preview/PreviewScalarField2D";
import type { FemMeshData } from "../preview/FemMeshView3D";
import ScalarPlot from "../plots/ScalarPlot";
import Sparkline from "../ui/Sparkline";
import EmptyState from "../ui/EmptyState";
import Button from "../ui/Button";
import s from "./RunControlRoom.module.css";

/* ── Types ─────────────────────────────────────────────────── */

interface RunControlRoomProps {
  sessionId?: string;
  mode?: "session" | "current";
}

type ViewportMode = "3D" | "2D" | "Mesh";
type VectorComponent = "x" | "y" | "z" | "magnitude";
type PreviewComponent = "3D" | "x" | "y" | "z";
type SlicePlane = "xy" | "xz" | "yz";

const FEM_SLICE_COUNT = 25;

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

/* ── Component ─────────────────────────────────────────────── */

export default function RunControlRoom({ sessionId, mode }: RunControlRoomProps) {
  const presentationMode = mode ?? (sessionId ? "session" : "current");
  const streamTarget = useMemo(
    () =>
      presentationMode === "current"
        ? ({ kind: "current" } as const)
        : ({ kind: "session", sessionId: sessionId ?? "" } as const),
    [presentationMode, sessionId],
  );
  const { state, connection, error } = useLiveStream(streamTarget);
  const [viewMode, setViewMode] = useState<ViewportMode>("3D");
  const [component, setComponent] = useState<VectorComponent>("magnitude");
  const [plane, setPlane] = useState<SlicePlane>("xy");
  const [sliceIndex, setSliceIndex] = useState(0);
  const [selectedQuantity, setSelectedQuantity] = useState("m");
  const [consoleCollapsed, setConsoleCollapsed] = useState(false);
  const [runUntilInput, setRunUntilInput] = useState("1e-12");
  const [relaxMaxStepsInput, setRelaxMaxStepsInput] = useState("5000");
  const [commandBusy, setCommandBusy] = useState(false);
  const [commandMessage, setCommandMessage] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewMessage, setPreviewMessage] = useState<string | null>(null);

  const session = state?.session;
  const run = state?.run;
  const liveState = state?.live_state;
  const preview = state?.preview ?? null;
  const femMesh = state?.fem_mesh ?? null;
  const scalarRows = state?.scalar_rows ?? [];

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
  const isMeshPreview = preview?.spatial_kind === "mesh";



  /* Detect FEM */
  const planSummary = session?.plan_summary as Record<string, unknown> | undefined;
  const resolvedBackend =
    (typeof planSummary?.resolved_backend === "string" ? planSummary.resolved_backend : null) ??
    (typeof session?.requested_backend === "string" ? session.requested_backend : null);
  const isFemBackend = resolvedBackend === "fem";
  const metadata = state?.metadata as Record<string, unknown> | null;
  const artifactLayout = (metadata?.artifact_layout as Record<string, unknown> | undefined) ?? undefined;
  const executionPlan = (metadata?.execution_plan as Record<string, unknown> | undefined) ?? undefined;
  const backendPlan = (executionPlan?.backend_plan as Record<string, unknown> | undefined) ?? undefined;

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
  const commandEndpoint =
    presentationMode === "current"
      ? `${resolveApiBase()}/v1/live/current/commands`
      : `${resolveApiBase()}/v1/sessions/${sessionId}/commands`;
  const previewEndpointBase =
    presentationMode === "current"
      ? `${resolveApiBase()}/v1/live/current/preview`
      : `${resolveApiBase()}/v1/sessions/${sessionId}/preview`;
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
      const response = await fetch(commandEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const detail = data?.message ?? data?.error ?? `HTTP ${response.status}`;
        throw new Error(detail);
      }
      setCommandMessage(`Queued ${String(payload.kind)}`);
    } catch (commandError) {
      setCommandMessage(
        commandError instanceof Error ? commandError.message : "Failed to queue command",
      );
    } finally {
      setCommandBusy(false);
    }
  }, [commandEndpoint]);

  const updatePreview = useCallback(async (path: string, payload: Record<string, unknown> = {}) => {
    setPreviewBusy(true);
    setPreviewMessage(null);
    try {
      const response = await fetch(`${previewEndpointBase}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const detail = data?.message ?? data?.error ?? `HTTP ${response.status}`;
        throw new Error(detail);
      }
    } catch (previewError) {
      setPreviewMessage(
        previewError instanceof Error ? previewError.message : "Failed to update preview",
      );
    } finally {
      setPreviewBusy(false);
    }
  }, [presentationMode, previewEndpointBase]);

  /* Keyboard shortcuts: 1=3D, 2=2D, 3=Mesh */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "1") setViewMode("3D");
      else if (e.key === "2") setViewMode("2D");
      else if (e.key === "3" && isFemBackend) setViewMode("Mesh");
      else if (e.key === "`" && e.ctrlKey) { e.preventDefault(); setConsoleCollapsed((v) => !v); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isFemBackend]);

  /* Sparkline data extraction — guard against undefined from backend */
  const eTotalSpark = useMemo(() => scalarRows.slice(-40).map((r) => r.e_total ?? 0), [scalarRows]);
  const dmDtSpark = useMemo(() => scalarRows.slice(-40).map((r) => Math.log10(Math.max(r.max_dm_dt ?? 1e-15, 1e-15))), [scalarRows]);
  const dtSpark = useMemo(() => scalarRows.slice(-40).map((r) => r.solver_dt ?? 0), [scalarRows]);

  /* Quantities */
  const quantityOptions = useMemo(
    () =>
      (state?.quantities ?? [])
        .filter((q) => q.available)
        .map((q) => ({ value: q.id, label: `${q.label} (${q.unit})` })),
    [state?.quantities],
  );

  const previewQuantityOptions = useMemo(
    () =>
      (state?.quantities ?? [])
        .filter((q) => q.available && q.kind === "vector_field")
        .map((q) => ({ value: q.id, label: `${q.label} (${q.unit})` })),
    [state?.quantities],
  );

  useEffect(() => {
    const options = preview ? previewQuantityOptions : quantityOptions;
    if (!options.length) return;
    if (!options.some((opt) => opt.value === selectedQuantity)) {
      setSelectedQuantity(options[0].value);
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

  const femTopologyKey = useMemo(() => {
    if (!effectiveFemMesh) return null;
    return `${effectiveFemMesh.nodes.length}:${femMesh?.elements.length ?? effectiveFemMesh.elements.length}:${effectiveFemMesh.boundary_faces.length}`;
  }, [effectiveFemMesh, femMesh?.elements.length]);

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

  /* ── Loading state ─────────────────────────────── */
  if (!state) {
    return (
      <div className={s.loadingShell}>
        {error
          ? `Connection error: ${error}`
          : presentationMode === "current"
            ? "Connecting to local live workspace…"
            : `Connecting to session ${sessionId}…`}
      </div>
    );
  }

  return (
    <div className={s.shell}>
      {/* ═══════ HEADER ═══════════════════════════════ */}
      <div className={s.header}>
        {presentationMode === "session" && (
          <a
            href="/runs"
            className={s.headerBackBtn}
            title="Back to runs list"
            aria-label="Back to runs list"
          >
            ←
          </a>
        )}
        <span className={s.headerDot} data-status={session?.status ?? "idle"} />
        <span className={s.headerTitle}>
          {session?.problem_name ?? (presentationMode === "current" ? "Local Live Workspace" : sessionId)}
        </span>
        <span className={s.headerMeta}>{session?.requested_backend?.toUpperCase() ?? ""}</span>
        <span className={s.headerMeta}>
          {presentationMode === "current" ? "local-live" : session?.execution_mode ?? ""}
        </span>

        <span className={s.headerSpacer} />

        {isFemBackend && femMesh && (
          <span className={s.headerPill}>
            {femMesh.nodes.length.toLocaleString()} nodes · {femMesh.elements.length.toLocaleString()} tets
          </span>
        )}
        {!isFemBackend && totalCells && totalCells > 0 && (
          <span className={s.headerPill}>
            {solverGrid[0]}×{solverGrid[1]}×{solverGrid[2]} = {totalCells.toLocaleString()} cells
          </span>
        )}

        {!previewDrivenMode && (
          <div className={s.headerToggle}>
            {(["3D", "2D", "Mesh"] as ViewportMode[]).map((mode, i) => (
              <button
                key={mode}
                className={s.headerToggleBtn}
                data-active={viewMode === mode}
                disabled={mode === "Mesh" && !isFemBackend}
                onClick={() => setViewMode(mode)}
                title={`${mode} view (${i + 1})`}
              >
                <span className={s.kbdHint}>{i + 1}</span>{mode}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ═══════ VIEWPORT ═════════════════════════════ */}
      <div className={s.viewport}>
        {/* Compact selector bar */}
        <div className={s.viewportBar}>
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
              : [{ value: "m", label: "Magnetization" }]).map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
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
              <span style={{ color: effectiveDmDt < 1e-5 ? "#35b779" : undefined }}>
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
            />
          ) : effectiveViewMode === "3D" && isFemBackend && femMeshData ? (
            <FemMeshView3D
              topologyKey={femTopologyKey ?? undefined}
              meshData={femMeshData}
              fieldLabel={quantityDescriptor?.label ?? selectedQuantity}
              colorField={
                effectiveVectorComponent === "x" ? "x"
                  : effectiveVectorComponent === "y" ? "y"
                  : effectiveVectorComponent === "z" ? "z"
                  : "magnitude"
              }
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
              <EmptyState title="No preview data yet" tone="info" compact />
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

      {/* ═══════ RIGHT SIDEBAR ════════════════════════ */}
      <div className={s.sidebar}>
        {/* Solver */}
        <Section title="Solver" badge={session?.status ?? "idle"}>
          <div className={s.fieldGrid2}>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>Step</span>
              <span className={s.fieldValue}>{effectiveStep.toLocaleString()}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>Time</span>
              <span className={s.fieldValue}>{fmtSI(effectiveTime, "s")}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>Δt</span>
              <span className={s.fieldValue}>{fmtSI(effectiveDt, "s")}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>max dm/dt</span>
              <span className={s.fieldValue} style={{
                color: effectiveDmDt > 0 && effectiveDmDt < 1e-5 ? "#35b779" : undefined
              }}>
                {fmtExp(effectiveDmDt)}
              </span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>max |H_eff|</span>
              <span className={s.fieldValue}>{fmtExp(effectiveHEff)}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>max |H_demag|</span>
              <span className={s.fieldValue}>{fmtExp(effectiveHDemag)}</span>
            </div>
          </div>
          {dmDtSpark.length > 1 && (
            <Sparkline data={dmDtSpark} width={140} height={20} color="#35b779" label="dm/dt" />
          )}
          {dtSpark.length > 1 && (
            <Sparkline data={dtSpark} width={140} height={20} color="hsl(210, 60%, 55%)" label="Δt" />
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
                {presentationMode === "current" ? "Close Workspace" : "Close Session"}
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
        <Section title="Energy" badge={fmtSI(effectiveETotal, "J")}>
          <div className={s.fieldGrid2}>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>E_exchange</span>
              <span className={s.fieldValue}>{fmtSI(effectiveEEx, "J")}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>E_demag</span>
              <span className={s.fieldValue}>{fmtSI(effectiveEDemag, "J")}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>E_ext</span>
              <span className={s.fieldValue}>{fmtSI(effectiveEExt, "J")}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>E_total</span>
              <span className={s.fieldValue} style={{ color: "hsl(210, 70%, 65%)" }}>
                {fmtSI(effectiveETotal, "J")}
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
              {presentationMode === "current" ? "Workspace" : "Session"}
            </span>
            <span className={s.footerValue}>
              {presentationMode === "current" ? "local" : session?.session_id?.slice(0, 12) ?? "—"}
            </span>
          </div>
        </div>
      </div>

      {/* ═══════ BOTTOM CONSOLE ═══════════════════════ */}
      <div className={s.console} data-collapsed={consoleCollapsed}>
        <button
          className={s.consoleToggle}
          onClick={() => setConsoleCollapsed((v) => !v)}
          title={consoleCollapsed ? "Expand console (Ctrl+`)" : "Collapse console (Ctrl+`)"}
        >
          {consoleCollapsed ? "▲" : "▼"}
        </button>
        {!consoleCollapsed && (
          <EngineConsole
          session={session ?? null}
          run={run ?? null}
          liveState={effectiveLiveState ?? null}
          scalarRows={scalarRows}
          artifacts={state?.artifacts ?? []}
          connection={connection}
          error={error}
          presentationMode={presentationMode}
          />
        )}
      </div>
    </div>
  );
}
