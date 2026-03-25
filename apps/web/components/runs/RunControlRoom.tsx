"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useSessionStream } from "../../lib/useSessionStream";
import EngineConsole from "../panels/EngineConsole";
import MeshQualityHistogram from "../panels/MeshQualityHistogram";
import MagnetizationSlice2D from "../preview/MagnetizationSlice2D";
import MagnetizationView3D from "../preview/MagnetizationView3D";
import FemMeshView3D from "../preview/FemMeshView3D";
import FemMeshSlice2D from "../preview/FemMeshSlice2D";
import type { FemMeshData } from "../preview/FemMeshView3D";
import ScalarPlot from "../plots/ScalarPlot";
import Sparkline from "../ui/Sparkline";
import EmptyState from "../ui/EmptyState";
import Button from "../ui/Button";
import s from "./RunControlRoom.module.css";

/* ── Types ─────────────────────────────────────────────────── */

interface RunControlRoomProps {
  sessionId: string;
}

type ViewportMode = "3D" | "2D" | "Mesh";
type VectorComponent = "x" | "y" | "z" | "magnitude";
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

export default function RunControlRoom({ sessionId }: RunControlRoomProps) {
  const { state, connection, error } = useSessionStream(sessionId);
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

  const session = state?.session;
  const run = state?.run;
  const liveState = state?.live_state;
  const femMesh = state?.fem_mesh ?? null;
  const scalarRows = state?.scalar_rows ?? [];



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
  const _rawGrid = liveState?.grid ?? state?.latest_fields.grid;
  const grid = useMemo<[number, number, number]>(
    () => [_rawGrid?.[0] ?? 0, _rawGrid?.[1] ?? 0, _rawGrid?.[2] ?? 0],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [_rawGrid?.[0], _rawGrid?.[1], _rawGrid?.[2]],
  );
  const totalCells = !isFemBackend ? grid[0] * grid[1] * grid[2] : null;
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

  const enqueueCommand = useCallback(async (payload: Record<string, unknown>) => {
    setCommandBusy(true);
    setCommandMessage(null);
    try {
      const response = await fetch(`http://127.0.0.1:8080/v1/sessions/${sessionId}/commands`, {
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
  }, [sessionId]);

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

  useEffect(() => {
    if (!quantityOptions.length) return;
    if (!quantityOptions.some((opt) => opt.value === selectedQuantity)) {
      setSelectedQuantity(quantityOptions[0].value);
    }
  }, [quantityOptions, selectedQuantity]);

  const quantityDescriptor = useMemo(
    () => state?.quantities.find((q) => q.id === selectedQuantity) ?? null,
    [selectedQuantity, state?.quantities],
  );

  /* Field data */
  const fieldMap = useMemo(
    () => ({
      m: liveState?.magnetization ?? state?.latest_fields.m ?? null,
      H_ex: state?.latest_fields.h_ex ?? null,
      H_demag: state?.latest_fields.h_demag ?? null,
      H_ext: state?.latest_fields.h_ext ?? null,
      H_eff: state?.latest_fields.h_eff ?? null,
    }),
    [liveState?.magnetization, state?.latest_fields.h_demag, state?.latest_fields.h_eff, state?.latest_fields.h_ex, state?.latest_fields.h_ext, state?.latest_fields.m],
  );

  const selectedVectors = useMemo(() => {
    const values = fieldMap[selectedQuantity as keyof typeof fieldMap] ?? null;
    return values ? new Float64Array(values) : null;
  }, [fieldMap, selectedQuantity]);

  /* FEM mesh data */
  const [flatNodes, flatFaces] = useMemo(() => {
    if (!femMesh) return [null, null];
    return [
      femMesh.nodes.flatMap((node) => node),
      femMesh.boundary_faces.flatMap((face) => face),
    ];
  }, [femMesh]);

  const femMeshData = useMemo<FemMeshData | null>(() => {
    if (!isFemBackend || !femMesh || !flatNodes || !flatFaces) return null;
    const nNodes = femMesh.nodes.length;
    const nElements = femMesh.elements.length;
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
  }, [isFemBackend, femMesh, flatNodes, flatFaces, selectedVectors]);

  const femTopologyKey = useMemo(() => {
    if (!femMesh) return null;
    return `${femMesh.nodes.length}:${femMesh.elements.length}:${femMesh.boundary_faces.length}`;
  }, [femMesh]);

  /* Slice count */
  const maxSliceCount = useMemo(() => {
    if (isFemBackend && femMeshData) return FEM_SLICE_COUNT;
    if (plane === "xy") return Math.max(1, grid[2]);
    if (plane === "xz") return Math.max(1, grid[1]);
    return Math.max(1, grid[0]);
  }, [femMeshData, grid, isFemBackend, plane]);

  useEffect(() => {
    if (sliceIndex >= maxSliceCount) setSliceIndex(Math.max(0, maxSliceCount - 1));
  }, [maxSliceCount, sliceIndex]);

  /* Derived stats for sidebar */
  const fieldStats = useMemo(() => {
    if (!selectedVectors) return null;
    const n = isFemBackend ? (femMesh?.nodes.length ?? 0) : grid[0] * grid[1] * grid[2];
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
  }, [selectedVectors, isFemBackend, femMesh, grid]);

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
        {error ? `Connection error: ${error}` : `Connecting to session ${sessionId}…`}
      </div>
    );
  }

  return (
    <div className={s.shell}>
      {/* ═══════ HEADER ═══════════════════════════════ */}
      <div className={s.header}>
        <a
          href="/runs"
          className={s.headerBackBtn}
          title="Back to runs list"
          aria-label="Back to runs list"
        >
          ←
        </a>
        <span className={s.headerDot} data-status={session?.status ?? "idle"} />
        <span className={s.headerTitle}>{session?.problem_name ?? sessionId}</span>
        <span className={s.headerMeta}>{session?.requested_backend?.toUpperCase() ?? ""}</span>
        <span className={s.headerMeta}>{session?.execution_mode ?? ""}</span>

        <span className={s.headerSpacer} />

        {isFemBackend && femMesh && (
          <span className={s.headerPill}>
            {femMesh.nodes.length.toLocaleString()} nodes · {femMesh.elements.length.toLocaleString()} tets
          </span>
        )}
        {!isFemBackend && totalCells && totalCells > 0 && (
          <span className={s.headerPill}>
            {grid[0]}×{grid[1]}×{grid[2]} = {totalCells.toLocaleString()} cells
          </span>
        )}

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
      </div>

      {/* ═══════ VIEWPORT ═════════════════════════════ */}
      <div className={s.viewport}>
        {/* Compact selector bar */}
        <div className={s.viewportBar}>
          <span className={s.viewportBarLabel}>Qty</span>
          <select
            className={s.viewportBarSelect}
            value={selectedQuantity}
            onChange={(e) => setSelectedQuantity(e.target.value)}
          >
            {(quantityOptions.length ? quantityOptions : [{ value: "m", label: "Magnetization" }]).map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>

          <span className={s.viewportBarSep} />
          <span className={s.viewportBarLabel}>Comp</span>
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

          {viewMode === "2D" && (
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

        {/* Canvas area */}
        <div className={s.viewportCanvas}>
          {/* Status overlay */}
          <div className={s.viewportOverlay}>
            <span>Step {(liveState?.step ?? run?.total_steps ?? 0).toLocaleString()}</span>
            <span>{fmtSI(liveState?.time ?? run?.final_time ?? 0, "s")}</span>
            {liveState?.max_dm_dt != null && (
              <span style={{ color: liveState.max_dm_dt < 1e-5 ? "#35b779" : undefined }}>
                dm/dt {fmtExp(liveState.max_dm_dt)}
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
          ) : !selectedVectors ? (
            <div style={{ padding: "1rem" }}>
              <EmptyState title="No preview data yet" tone="info" compact />
            </div>
          ) : viewMode === "Mesh" && isFemBackend && femMeshData ? (
            <FemMeshView3D
              topologyKey={femTopologyKey ?? undefined}
              meshData={femMeshData}
              colorField="quality"
            />
          ) : viewMode === "3D" && isFemBackend && femMeshData ? (
            <FemMeshView3D
              topologyKey={femTopologyKey ?? undefined}
              meshData={femMeshData}
              fieldLabel={quantityDescriptor?.label ?? selectedQuantity}
              colorField={
                component === "x" ? "x"
                  : component === "y" ? "y"
                  : component === "z" ? "z"
                  : "magnitude"
              }
            />
          ) : viewMode === "2D" && isFemBackend && femMeshData ? (
            <FemMeshSlice2D
              meshData={femMeshData}
              quantityLabel={quantityDescriptor?.label ?? selectedQuantity}
              quantityId={selectedQuantity}
              component={component}
              plane={plane}
              sliceIndex={sliceIndex}
              sliceCount={maxSliceCount}
            />
          ) : viewMode === "3D" ? (
            <MagnetizationView3D
              grid={grid}
              vectors={selectedVectors}
              fieldLabel={quantityDescriptor?.label ?? selectedQuantity}
            />
          ) : (
            <MagnetizationSlice2D
              grid={grid}
              vectors={selectedVectors}
              quantityLabel={quantityDescriptor?.label ?? selectedQuantity}
              quantityId={selectedQuantity}
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
              <span className={s.fieldValue}>{(liveState?.step ?? run?.total_steps ?? 0).toLocaleString()}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>Time</span>
              <span className={s.fieldValue}>{fmtSI(liveState?.time ?? run?.final_time ?? 0, "s")}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>Δt</span>
              <span className={s.fieldValue}>{fmtSI(liveState?.dt ?? 0, "s")}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>max dm/dt</span>
              <span className={s.fieldValue} style={{
                color: (liveState?.max_dm_dt ?? 1) < 1e-5 ? "#35b779" : undefined
              }}>
                {fmtExp(liveState?.max_dm_dt ?? 0)}
              </span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>max |H_eff|</span>
              <span className={s.fieldValue}>{fmtExp(liveState?.max_h_eff ?? 0)}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>max |H_demag|</span>
              <span className={s.fieldValue}>{fmtExp(liveState?.max_h_demag ?? 0)}</span>
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
                Close Session
              </Button>
            </div>
            {commandMessage && (
              <div className={s.interactiveMessage}>{commandMessage}</div>
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
        <Section title="Energy" badge={fmtSI(liveState?.e_total ?? run?.final_e_total ?? 0, "J")}>
          <div className={s.fieldGrid2}>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>E_exchange</span>
              <span className={s.fieldValue}>{fmtSI(liveState?.e_ex ?? run?.final_e_ex ?? 0, "J")}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>E_demag</span>
              <span className={s.fieldValue}>{fmtSI(liveState?.e_demag ?? run?.final_e_demag ?? 0, "J")}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>E_ext</span>
              <span className={s.fieldValue}>{fmtSI(liveState?.e_ext ?? run?.final_e_ext ?? 0, "J")}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>E_total</span>
              <span className={s.fieldValue} style={{ color: "hsl(210, 70%, 65%)" }}>
                {fmtSI(liveState?.e_total ?? run?.final_e_total ?? 0, "J")}
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
        {isFemBackend && femMeshData && viewMode === "Mesh" && (
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
                  <span className={s.fieldValue}>{grid[0]}×{grid[1]}×{grid[2]}</span>
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

        {/* Session footer */}
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
            <span className={s.fieldLabel}>Session</span>
            <span className={s.footerValue}>{session?.session_id?.slice(0, 12) ?? "—"}</span>
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
          liveState={liveState ?? null}
          scalarRows={scalarRows}
          artifacts={state?.artifacts ?? []}
          connection={connection}
          error={error}
          />
        )}
      </div>
    </div>
  );
}
