"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ScalarRow } from "../../lib/useSessionStream";
import { cn } from "@/lib/utils";
import { useControlRoom, type SolverPlanSummary } from "../runs/control-room/ControlRoomContext";
import { Button } from "../ui/button";
import Sparkline from "../ui/Sparkline";
import type { RenderMode } from "../preview/FemMeshView3D";
import MeshSettingsPanel from "./MeshSettingsPanel";
import {
  type PreviewComponent,
  type ViewportMode,
  fmtExp,
  fmtExpOrDash,
  fmtPreviewEveryN,
  fmtPreviewMaxPoints,
  fmtSI,
  fmtSIOrDash,
  fmtStepValue,
} from "../runs/control-room/shared";

const SPARK_HISTORY_LIMIT = 40;

function buildSparkSeries(
  rows: ScalarRow[],
  select: (row: ScalarRow) => number,
  currentValue?: number | null,
  transform: (value: number) => number = (value) => value,
): number[] {
  const samples = rows
    .slice(-SPARK_HISTORY_LIMIT)
    .map((row) => transform(select(row)))
    .filter((value) => Number.isFinite(value));

  if (currentValue == null || !Number.isFinite(currentValue)) return samples;
  const currentSample = transform(currentValue);
  if (!Number.isFinite(currentSample)) return samples;
  if (samples.length === 0) return [currentSample, currentSample];

  const last = samples[samples.length - 1];
  if (last !== currentSample) {
    return [...samples.slice(-(SPARK_HISTORY_LIMIT - 1)), currentSample];
  }
  return samples;
}

interface MetricFieldProps {
  label: string;
  value: string;
  sparkData?: number[];
  sparkColor?: string;
  title?: string;
  valueTone?: "success";
}

function MetricField({ label, value, sparkData, sparkColor, title, valueTone }: MetricFieldProps) {
  return (
    <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
      <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground" title={title}>{label}</span>
      <span className={cn("font-mono text-xs text-foreground", valueTone === "success" ? "text-emerald-500" : undefined)}>
        {value}
      </span>
      {sparkData && sparkColor && (
        <div className="h-6 w-full mt-1.5 opacity-80" style={{position: "relative"}}>
          <Sparkline
            data={sparkData}
            height={20}
            color={sparkColor}
            fill={false}
            responsive
          />
        </div>
      )}
    </div>
  );
}

interface SidebarSectionProps {
  title: string;
  badge?: string | null;
  defaultOpen?: boolean;
  autoOpenKey?: string | null;
  children: ReactNode;
}

function SidebarSection({
  title,
  badge,
  defaultOpen = true,
  autoOpenKey,
  children,
}: SidebarSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (autoOpenKey) setOpen(true);
  }, [autoOpenKey]);

  return (
    <section className="flex flex-col border-b border-border/40 last:border-0">
      <button
        type="button"
        className="flex items-center w-full px-3 py-2.5 text-left transition-colors hover:bg-muted/50 group"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <span className={cn("text-muted-foreground transition-transform duration-150 mr-2 flex items-center justify-center w-4 h-4 text-[10px] font-black", open && "rotate-90")}>▸</span>
        <span className="text-xs font-bold uppercase tracking-[0.15em] text-foreground">{title}</span>
        {badge ? <span className="ml-auto text-[0.65rem] font-mono tracking-tight text-muted-foreground/80 bg-muted/60 px-1.5 py-0.5 rounded-sm border border-border/40">{badge}</span> : null}
      </button>
      {open ? <div className="px-3 pb-4 pt-1 mb-1 flex flex-col gap-5">{children}</div> : null}
    </section>
  );
}

const BACKEND_PROFILES: Record<string, { label: string; performance: string; physics: string }> = {
  fdm: {
    label: "FDM regular grid",
    performance: "Best throughput on large rectilinear domains; especially efficient on CUDA with FFT-based demag.",
    physics: "Cell-centered micromagnetics on a Cartesian mesh. Great for block-like or voxelized geometries.",
  },
  fem: {
    label: "FEM tetra mesh",
    performance: "Higher geometric fidelity, but more expensive per degree of freedom than regular-grid FDM.",
    physics: "Finite elements follow curved boundaries and imported CAD/STL shapes more faithfully.",
  },
  fdm_multilayer: {
    label: "FDM multilayer",
    performance: "Optimized for stacked-film workflows, where layer coupling matters more than arbitrary 3D geometry.",
    physics: "Regular-grid micromagnetics with explicit multilayer structure and inter-layer bookkeeping.",
  },
};

const INTEGRATOR_PROFILES: Record<string, { label: string; performance: string; physics: string }> = {
  heun: {
    label: "Heun (RK2)",
    performance: "Low overhead per step and easy to debug; good when you already know a safe fixed timestep.",
    physics: "Second-order explicit integration of the LLG equation with predictor-corrector structure.",
  },
  rk4: {
    label: "RK4",
    performance: "More work per step than Heun, but usually better accuracy at the same fixed timestep.",
    physics: "Classic fourth-order Runge-Kutta for smooth precessional dynamics when timestep is controlled manually.",
  },
  rk23: {
    label: "RK2(3) adaptive",
    performance: "Good default when you want adaptive stepping without the heavier RK45 cost profile.",
    physics: "Embedded pair estimates local truncation error and adjusts dt to keep LLG integration within tolerance.",
  },
  rk45: {
    label: "RK4(5) adaptive",
    performance: "Accuracy-oriented adaptive integrator; often robust, but heavier per accepted step.",
    physics: "Dormand-Prince style embedded stepping tracks fast transients while expanding dt in quieter regions.",
  },
  abm3: {
    label: "ABM3",
    performance: "Efficient on smooth trajectories after startup, because it reuses history instead of recomputing as many stages.",
    physics: "Multistep predictor-corrector integration; best when the magnetization evolves smoothly over time.",
  },
  auto: {
    label: "Backend default",
    performance: "Lets the runtime choose the default solver path for the current backend.",
    physics: "Useful for scripted flows where the backend decides the safest or most mature integrator.",
  },
};

const RELAXATION_PROFILES: Record<string, { label: string; performance: string; physics: string }> = {
  llg_overdamped: {
    label: "LLG overdamped",
    performance: "Most robust relaxation path and the easiest to reason about across FDM and FEM.",
    physics: "Uses the normal effective field but removes the precessional term, so magnetization follows a damping-driven descent toward equilibrium.",
  },
  projected_gradient_bb: {
    label: "Projected gradient (BB)",
    performance: "Often converges faster than overdamped LLG on FDM when the landscape is reasonably well behaved.",
    physics: "Direct energy minimization on the unit-sphere constraint rather than explicit physical time stepping.",
  },
  nonlinear_cg: {
    label: "Nonlinear conjugate gradient",
    performance: "Can reduce iteration count substantially on harder minimization problems, at the cost of more algorithmic complexity.",
    physics: "Direct manifold optimization with conjugate directions, so it targets equilibrium states rather than transient dynamics.",
  },
  tangent_plane_implicit: {
    label: "Tangent-plane implicit",
    performance: "Designed for stiff FEM relaxation, but availability depends on backend support.",
    physics: "Implicit tangent-plane stepping respects the unit-magnetization constraint while improving stiffness handling.",
  },
};

const PRECISION_PROFILES: Record<string, { label: string; performance: string; physics: string }> = {
  single: {
    label: "Single precision",
    performance: "Lower memory traffic and usually higher GPU throughput; useful for exploratory sweeps and fast previews.",
    physics: "Round-off noise is larger, so very tight convergence criteria or tiny energy differences are less trustworthy.",
  },
  double: {
    label: "Double precision",
    performance: "More expensive, but safer for long runs, tight tolerances, and numerically delicate geometries.",
    physics: "Higher mantissa precision reduces accumulated error in torque, energy, and demag-heavy workloads.",
  },
};

function humanizeToken(value: string | null | undefined): string {
  if (!value) return "—";
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatVector(value: [number, number, number] | null, unit: string): string {
  if (!value) return "—";
  return value.map((component) => fmtSI(component, unit)).join(" · ");
}

function formatGrid(value: [number, number, number] | null): string {
  if (!value) return "—";
  return value.map((component) => Math.round(component).toLocaleString()).join(" × ");
}

function studyKindForPlan(plan: SolverPlanSummary | null): string {
  if (!plan) return "—";
  return plan.relaxation ? "Relaxation" : "Time evolution";
}

function timestepModeForPlan(plan: SolverPlanSummary | null): string {
  if (!plan) return "—";
  if (plan.adaptive) return "Adaptive";
  if (plan.fixedTimestep != null) return "Fixed";
  return "Backend default";
}

function precessionModeForPlan(plan: SolverPlanSummary | null): string {
  if (!plan) return "—";
  const algorithm = plan?.relaxation?.algorithm;
  if (!algorithm) return "Enabled";
  if (algorithm === "llg_overdamped") return "Disabled";
  if (algorithm === "projected_gradient_bb" || algorithm === "nonlinear_cg") return "N/A";
  return "Algorithm-dependent";
}

/* ── Geometry Section ── */
function GeometryPanel() {
  const ctx = useControlRoom();
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
        <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Geometry</span>
        <span className="font-mono text-xs text-foreground">{ctx.meshName ?? ctx.mesherSourceKind ?? "—"}</span>
      </div>
      <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
        <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Source</span>
        <span className="font-mono text-xs text-foreground">{ctx.meshSource ?? ctx.mesherSourceKind ?? "—"}</span>
      </div>
      <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
        <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Extent</span>
        <span className="font-mono text-xs text-foreground">
          {ctx.meshExtent
            ? `${fmtSI(ctx.meshExtent[0], "m")} · ${fmtSI(ctx.meshExtent[1], "m")} · ${fmtSI(ctx.meshExtent[2], "m")}`
            : "—"}
        </span>
      </div>
      <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
        <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Bounds</span>
        <span className="font-mono text-xs text-foreground">
          {ctx.meshBoundsMin && ctx.meshBoundsMax
            ? `${fmtSI(ctx.meshBoundsMin[0], "m")} → ${fmtSI(ctx.meshBoundsMax[0], "m")}`
            : "—"}
        </span>
      </div>
    </div>
  );
}

/* ── Material Section ── */
function MaterialPanel() {
  const ctx = useControlRoom();
  if (!ctx.material) return <div className="font-mono text-xs text-foreground">Material metadata not available yet.</div>;
  return (
    <>
      <div className="grid grid-cols-3 gap-3">
        <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
          <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">M_sat</span>
          <span className="font-mono text-xs text-foreground">{ctx.material.msat != null ? fmtSI(ctx.material.msat, "A/m") : "—"}</span>
        </div>
        <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
          <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">A_ex</span>
          <span className="font-mono text-xs text-foreground">{ctx.material.aex != null ? fmtSI(ctx.material.aex, "J/m") : "—"}</span>
        </div>
        <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
          <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">α</span>
          <span className="font-mono text-xs text-foreground">{ctx.material.alpha?.toPrecision(3) ?? "—"}</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 mt-3">
        {ctx.material.exchangeEnabled && <span className="text-[0.6rem] font-bold uppercase tracking-widest border border-border/50 bg-muted/30 text-muted-foreground px-1.5 py-0.5 rounded-md inline-flex shadow-sm w-fit">Exchange</span>}
        {ctx.material.demagEnabled && <span className="text-[0.6rem] font-bold uppercase tracking-widest border border-border/50 bg-muted/30 text-muted-foreground px-1.5 py-0.5 rounded-md inline-flex shadow-sm w-fit">Demag</span>}
        {ctx.material.zeemanField?.some((v) => v !== 0) && <span className="text-[0.6rem] font-bold uppercase tracking-widest border border-border/50 bg-muted/30 text-muted-foreground px-1.5 py-0.5 rounded-md inline-flex shadow-sm w-fit">Zeeman</span>}
      </div>
    </>
  );
}

/* ── Mesh Section ── */
function MeshPanel() {
  const ctx = useControlRoom();
  const {
    effectiveFemMesh, meshFeOrder, meshHmax, isMeshWorkspaceView,
    effectiveViewMode, handleViewModeChange, meshRenderMode, setMeshRenderMode,
    meshFaceDetail, meshSelection, setMeshSelection
  } = ctx;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
          <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Backend</span>
          <span className="font-mono text-xs text-foreground">{ctx.mesherBackend ?? "—"}</span>
        </div>
        <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
          <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Source</span>
          <span className="font-mono text-xs text-foreground">{ctx.mesherSourceKind ?? ctx.meshSource ?? "—"}</span>
        </div>
      </div>

      <div className="grid gap-2.5 p-3 rounded-md bg-card/40 border border-border/40 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Topology</span>
          <span className="text-[0.65rem] font-mono text-muted-foreground/70">
            {effectiveFemMesh?.elements.length ? "volume mesh" : "surface preview"}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="grid gap-1 px-2.5 py-2 rounded-lg bg-background/50 border border-border/30">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Nodes</span>
            <span className="font-mono text-xs text-foreground">{effectiveFemMesh?.nodes.length.toLocaleString() ?? "0"}</span>
          </div>
          <div className="grid gap-1 px-2.5 py-2 rounded-lg bg-background/50 border border-border/30">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Elements</span>
            <span className="font-mono text-xs text-foreground">{effectiveFemMesh?.elements.length.toLocaleString() ?? "0"}</span>
          </div>
          <div className="grid gap-1 px-2.5 py-2 rounded-lg bg-background/50 border border-border/30">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Faces</span>
            <span className="font-mono text-xs text-foreground">{effectiveFemMesh?.boundary_faces.length.toLocaleString() ?? "0"}</span>
          </div>
          <div className="grid gap-1 px-2.5 py-2 rounded-lg bg-background/50 border border-border/30">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">FE order</span>
            <span className="font-mono text-xs text-foreground">{meshFeOrder != null ? String(meshFeOrder) : "—"}</span>
          </div>
          <div className="grid gap-1 px-2.5 py-2 rounded-lg bg-background/50 border border-border/30">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">hmax</span>
            <span className="font-mono text-xs text-foreground">{meshHmax != null ? fmtSI(meshHmax, "m") : "—"}</span>
          </div>
        </div>
      </div>

      <div className="grid gap-2.5 p-3 rounded-md bg-card/40 border border-border/40 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Inspect</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {(["Mesh", "3D", "2D"] as ViewportMode[]).map((mode) => (
            <button
              key={mode}
              className="appearance-none border border-border/40 bg-background/50 text-muted-foreground text-[0.65rem] font-bold uppercase tracking-widest rounded-md py-1.5 px-2 cursor-pointer transition-colors hover:bg-muted/50 data-[active=true]:bg-primary/20 data-[active=true]:border-primary/50 data-[active=true]:text-primary disabled:opacity-50 disabled:cursor-not-allowed"
              data-active={effectiveViewMode === mode}
              onClick={() => handleViewModeChange(mode)}
              type="button"
            >
              {mode}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {([
            ["surface", "Surface"],
            ["surface+edges", "Surface+Edges"],
            ["wireframe", "Wireframe"],
            ["points", "Points"],
          ] as [RenderMode, string][]).map(([mode, label]) => (
            <button
              key={mode}
              className="appearance-none border border-border/40 bg-background/50 text-muted-foreground text-[0.65rem] font-bold uppercase tracking-widest rounded-md py-1.5 px-2 cursor-pointer transition-colors hover:bg-muted/50 data-[active=true]:bg-primary/20 data-[active=true]:border-primary/50 data-[active=true]:text-primary disabled:opacity-50 disabled:cursor-not-allowed"
              data-active={meshRenderMode === mode}
              onClick={() => setMeshRenderMode(mode)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {meshFaceDetail && (
        <div className="grid gap-2.5 p-3 rounded-md bg-card/40 border border-border/40 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Selection</span>
            <span className="text-[0.65rem] font-mono text-muted-foreground/70">
              {meshSelection.selectedFaceIndices.length} face{meshSelection.selectedFaceIndices.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="grid gap-1.5 text-xs text-foreground bg-background/50 p-2 rounded border border-border/30">
            <div className="grid grid-cols-[92px_1fr] gap-2"><span className="text-[0.65rem] font-bold uppercase text-muted-foreground">Face</span><span className="font-mono">#{meshFaceDetail.faceIndex}</span></div>
            <div className="grid grid-cols-[92px_1fr] gap-2"><span className="text-[0.65rem] font-bold uppercase text-muted-foreground">Nodes</span><span className="font-mono truncate" title={meshFaceDetail.nodeIndices.join(", ")}>{meshFaceDetail.nodeIndices.join(", ")}</span></div>
            <div className="grid grid-cols-[92px_1fr] gap-2"><span className="text-[0.65rem] font-bold uppercase text-muted-foreground">Area</span><span className="font-mono">{fmtExp(meshFaceDetail.area)} m²</span></div>
            <div className="grid grid-cols-[92px_1fr] gap-2"><span className="text-[0.65rem] font-bold uppercase text-muted-foreground">Perimeter</span><span className="font-mono">{fmtSI(meshFaceDetail.perimeter, "m")}</span></div>
            <div className="grid grid-cols-[92px_1fr] gap-2"><span className="text-[0.65rem] font-bold uppercase text-muted-foreground">Aspect Ratio</span><span className="font-mono">{meshFaceDetail.aspectRatio.toFixed(2)}</span></div>
            <div className="grid grid-cols-[92px_1fr] gap-2"><span className="text-[0.65rem] font-bold uppercase text-muted-foreground">Centroid</span><span className="font-mono truncate" title={meshFaceDetail.centroid.map((v) => fmtExp(v)).join(", ")}>{meshFaceDetail.centroid.map((v) => fmtExp(v)).join(", ")}</span></div>
          </div>
          <Button size="sm" variant="outline" onClick={() => setMeshSelection({ selectedFaceIndices: [], primaryFaceIndex: null })}>
            Clear selection
          </Button>
        </div>
      )}
    </div>
  );
}

/* ── Study / Solver Section ── */
function StudyPanel() {
  const ctx = useControlRoom();
  const solverPlan = ctx.solverPlan;
  const backendProfile = solverPlan?.backendKind ? BACKEND_PROFILES[solverPlan.backendKind] : null;
  const integratorProfile = solverPlan?.integrator ? INTEGRATOR_PROFILES[solverPlan.integrator] : null;
  const precisionProfile = solverPlan?.precision ? PRECISION_PROFILES[solverPlan.precision] : null;
  const relaxationProfile = solverPlan?.relaxation?.algorithm
    ? RELAXATION_PROFILES[solverPlan.relaxation.algorithm]
    : null;
  const workloadLabel = ctx.isFemBackend && ctx.femMesh
    ? `${ctx.femMesh.nodes.length.toLocaleString()} nodes · ${ctx.femMesh.elements.length.toLocaleString()} tets`
    : ctx.totalCells && ctx.totalCells > 0
      ? `${ctx.totalCells.toLocaleString()} cells`
      : "—";

  const insightCards = [
    {
      title: "Backend Profile",
      subtitle: backendProfile?.label ?? humanizeToken(solverPlan?.backendKind),
      body: backendProfile
        ? `${backendProfile.performance} ${backendProfile.physics}`
        : "Backend metadata will appear here as soon as the live workspace publishes the execution plan.",
    },
    {
      title: "Integrator Behavior",
      subtitle: integratorProfile?.label ?? humanizeToken(solverPlan?.integrator),
      body: integratorProfile
        ? `${integratorProfile.performance} ${integratorProfile.physics}`
        : "Integrator details are not available yet for this workspace.",
    },
    {
      title: "Precision And Stability",
      subtitle: precisionProfile?.label ?? humanizeToken(solverPlan?.precision ?? ctx.session?.precision),
      body: precisionProfile
        ? `${precisionProfile.performance} ${precisionProfile.physics}`
        : "Precision metadata is not available yet.",
    },
    {
      title: solverPlan?.relaxation ? "Relaxation Physics" : "Live Performance Snapshot",
      subtitle: solverPlan?.relaxation
        ? (relaxationProfile?.label ?? humanizeToken(solverPlan.relaxation.algorithm))
        : ctx.activity.label,
      body: solverPlan?.relaxation
        ? (relaxationProfile
          ? `${relaxationProfile.performance} ${relaxationProfile.physics}`
          : "Relaxation is active, but a richer algorithm profile is not available yet.")
        : `Current throughput: ${ctx.stepsPerSec > 0 ? `${ctx.stepsPerSec.toFixed(1)} st/s` : "—"}. Current dt: ${fmtSIOrDash(ctx.effectiveDt, "s", ctx.hasSolverTelemetry)}. Active workload: ${workloadLabel}.`,
    },
  ];

  return (
    <>
      <div className="flex flex-col py-4 border-b border-border/40 last:border-0">
        <div className="text-[0.6rem] font-black uppercase tracking-[0.2em] text-muted-foreground mb-4">Active Backend Configuration</div>
        <div className="grid grid-cols-3 gap-3">
          <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">State</span>
            <span className="font-mono text-xs text-foreground">{ctx.workspaceStatus}</span>
          </div>
          <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Study</span>
            <span className="font-mono text-xs text-foreground">{studyKindForPlan(solverPlan)}</span>
          </div>
          <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Engine</span>
            <span className="font-mono text-xs text-foreground">{ctx.runtimeEngineLabel ?? ctx.sessionFooter.requestedBackend ?? "—"}</span>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3 mt-4">
          <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Backend</span>
            <span className="font-mono text-xs text-foreground">{humanizeToken(solverPlan?.resolvedBackend ?? solverPlan?.backendKind ?? ctx.sessionFooter.requestedBackend)}</span>
          </div>
          <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Mode</span>
            <span className="font-mono text-xs text-foreground">{humanizeToken(solverPlan?.executionMode ?? ctx.session?.execution_mode)}</span>
          </div>
          <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Precision</span>
            <span className="font-mono text-xs text-foreground">{humanizeToken(solverPlan?.precision ?? ctx.session?.precision)}</span>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3 mt-4">
          <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Integrator</span>
            <span className="font-mono text-xs text-foreground">{integratorProfile?.label ?? humanizeToken(solverPlan?.integrator)}</span>
          </div>
          <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Δt control</span>
            <span className="font-mono text-xs text-foreground">{timestepModeForPlan(solverPlan)}</span>
          </div>
          <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Precession</span>
            <span className="font-mono text-xs text-foreground">{precessionModeForPlan(solverPlan)}</span>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3 mt-4">
          <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">γ</span>
            <span className="font-mono text-xs text-foreground">{solverPlan?.gyromagneticRatio != null ? `${fmtExp(solverPlan.gyromagneticRatio)} m/(A·s)` : "—"}</span>
          </div>
          <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Exchange BC</span>
            <span className="font-mono text-xs text-foreground">{humanizeToken(solverPlan?.exchangeBoundary)}</span>
          </div>
          <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Workload</span>
            <span className="font-mono text-xs text-foreground">{workloadLabel}</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mt-4">
          <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Discretization</span>
            <span className="font-mono text-xs text-foreground">
              {!solverPlan
                ? "—"
                : solverPlan.backendKind === "fem"
                ? `P${solverPlan.feOrder ?? "?"} · hmax ${solverPlan.hmax != null ? fmtSI(solverPlan.hmax, "m") : "—"}`
                : `${formatGrid(solverPlan?.gridCells ?? null)} cells · ${formatVector(solverPlan?.cellSize ?? null, "m")}`}
            </span>
          </div>
          <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">External field</span>
            <span className="font-mono text-xs text-foreground">{formatVector(solverPlan?.externalField ?? null, "T")}</span>
          </div>
        </div>

        {(solverPlan?.fixedTimestep != null || solverPlan?.adaptive) && (
          <div className="grid grid-cols-2 gap-3 mt-4">
            <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Fixed Δt</span>
              <span className="font-mono text-xs text-foreground">{solverPlan?.fixedTimestep != null ? fmtSI(solverPlan.fixedTimestep, "s") : "—"}</span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Adaptive atol</span>
              <span className="font-mono text-xs text-foreground">{solverPlan?.adaptive?.atol != null ? fmtExp(solverPlan.adaptive.atol) : "—"}</span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Adaptive dt₀</span>
              <span className="font-mono text-xs text-foreground">{solverPlan?.adaptive?.dtInitial != null ? fmtSI(solverPlan.adaptive.dtInitial, "s") : "—"}</span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Adaptive range</span>
              <span className="font-mono text-xs text-foreground">
                {solverPlan?.adaptive
                  ? `${solverPlan.adaptive.dtMin != null ? fmtSI(solverPlan.adaptive.dtMin, "s") : "—"} → ${solverPlan.adaptive.dtMax != null ? fmtSI(solverPlan.adaptive.dtMax, "s") : "—"}`
                  : "—"}
              </span>
            </div>
          </div>
        )}

        {solverPlan?.relaxation && (
          <div className="grid grid-cols-2 gap-3 mt-4">
            <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Relax algorithm</span>
              <span className="font-mono text-xs text-foreground">{relaxationProfile?.label ?? humanizeToken(solverPlan.relaxation.algorithm)}</span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Max steps</span>
              <span className="font-mono text-xs text-foreground">{solverPlan.relaxation.maxSteps != null ? solverPlan.relaxation.maxSteps.toLocaleString() : "—"}</span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Torque tol.</span>
              <span className="font-mono text-xs text-foreground">{solverPlan.relaxation.torqueTolerance != null ? fmtExp(solverPlan.relaxation.torqueTolerance) : "—"}</span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Energy tol.</span>
              <span className="font-mono text-xs text-foreground">{solverPlan.relaxation.energyTolerance != null ? fmtExp(solverPlan.relaxation.energyTolerance) : "disabled"}</span>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-1.5 mt-5">
          {solverPlan?.exchangeEnabled && <span className="text-[0.6rem] font-bold uppercase tracking-widest border border-border/50 bg-muted/30 text-muted-foreground px-1.5 py-0.5 rounded-md inline-flex shadow-sm w-fit">Exchange</span>}
          {solverPlan?.demagEnabled && <span className="text-[0.6rem] font-bold uppercase tracking-widest border border-border/50 bg-muted/30 text-muted-foreground px-1.5 py-0.5 rounded-md inline-flex shadow-sm w-fit">Demag</span>}
          {solverPlan?.externalField?.some((value) => value !== 0) && <span className="text-[0.6rem] font-bold uppercase tracking-widest border border-border/50 bg-muted/30 text-muted-foreground px-1.5 py-0.5 rounded-md inline-flex shadow-sm w-fit">Zeeman</span>}
          {solverPlan?.adaptive && <span className="text-[0.6rem] font-bold uppercase tracking-widest border border-border/50 bg-muted/30 text-muted-foreground px-1.5 py-0.5 rounded-md inline-flex shadow-sm w-fit">Adaptive Δt</span>}
          {solverPlan?.relaxation && <span className="text-[0.6rem] font-bold uppercase tracking-widest border border-border/50 bg-muted/30 text-muted-foreground px-1.5 py-0.5 rounded-md inline-flex shadow-sm w-fit">Relaxation stage</span>}
        </div>

        {solverPlan?.notes.length ? (
          <div className="mt-5 flex flex-col gap-2 p-3 bg-amber-500/10 border border-amber-500/20 rounded-md shadow-sm">
            {solverPlan.notes.map((note) => (
              <div key={note} className="text-xs text-amber-600/90 font-medium leading-relaxed">{note}</div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex flex-col py-4 border-b border-border/40 last:border-0">
        <div className="text-[0.6rem] font-black uppercase tracking-[0.2em] text-muted-foreground mb-4">Performance And Physics</div>
        <div className="grid gap-3">
          {insightCards.map((card) => (
            <div key={card.title} className="bg-card/50 border border-border/50 shadow-sm rounded-lg p-3.5 flex flex-col gap-1 inline-flex">
              <div className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground/70">{card.title}</div>
              <div className="font-bold text-[0.8rem] text-foreground mt-0.5 tracking-tight">{card.subtitle}</div>
              <div className="text-xs text-muted-foreground leading-relaxed mt-1.5">{card.body}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col py-4 border-b border-border/40 last:border-0">
        <div className="text-[0.6rem] font-black uppercase tracking-[0.2em] text-muted-foreground mb-4">Next Interactive Command</div>
        <div className="flex flex-col gap-3 p-3 bg-muted/30 border border-border/50 rounded-lg shadow-inner">
          <label className="flex flex-col gap-1.5 text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">
            Run until [s]
            <input
              className="flex h-7 w-full rounded-md border border-border/60 bg-background/50 px-2.5 py-1 text-xs text-foreground font-mono focus:border-primary focus:outline-none transition-colors shadow-sm disabled:opacity-50"
              value={ctx.runUntilInput}
              onChange={(e) => ctx.setRunUntilInput(e.target.value)}
              disabled={ctx.commandBusy || !ctx.awaitingCommand}
            />
          </label>
          <Button
            size="sm"
            tone="accent"
            variant="solid"
            disabled={ctx.commandBusy || !ctx.awaitingCommand}
            onClick={() => ctx.handleSimulationAction("run")}
          >
            Run
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3 mt-3">
          <label className="flex flex-col gap-1.5 text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">
            Relax steps
            <input className="flex h-7 w-full rounded-md border border-border/60 bg-background/50 px-2.5 py-1 text-xs text-foreground font-mono focus:border-primary focus:outline-none transition-colors shadow-sm disabled:opacity-50" value={ctx.solverSettings.maxRelaxSteps}
              onChange={(e) => ctx.setSolverSettings((c) => ({ ...c, maxRelaxSteps: e.target.value }))}
              disabled={ctx.commandBusy || !ctx.awaitingCommand} />
          </label>
          <label className="flex flex-col gap-1.5 text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">
            Torque tol.
            <input className="flex h-7 w-full rounded-md border border-border/60 bg-background/50 px-2.5 py-1 text-xs text-foreground font-mono focus:border-primary focus:outline-none transition-colors shadow-sm disabled:opacity-50" value={ctx.solverSettings.torqueTolerance}
              onChange={(e) => ctx.setSolverSettings((c) => ({ ...c, torqueTolerance: e.target.value }))}
              disabled={ctx.commandBusy || !ctx.awaitingCommand} />
          </label>
          <label className="flex flex-col gap-1.5 text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground col-span-2">
            Energy tol.
            <input className="flex h-7 w-full rounded-md border border-border/60 bg-background/50 px-2.5 py-1 text-xs text-foreground font-mono focus:border-primary focus:outline-none transition-colors shadow-sm disabled:opacity-50" value={ctx.solverSettings.energyTolerance}
              onChange={(e) => ctx.setSolverSettings((c) => ({ ...c, energyTolerance: e.target.value }))}
              placeholder="disabled" disabled={ctx.commandBusy || !ctx.awaitingCommand} />
          </label>
        </div>
        <div className="flex flex-wrap gap-2 items-center justify-between mt-4">
          <Button
            size="sm"
            tone="success"
            variant="solid"
            disabled={ctx.commandBusy || !ctx.awaitingCommand}
            onClick={() => ctx.handleSimulationAction("relax")}
          >
            Relax
          </Button>
          <Button size="sm" tone="warn" variant="outline"
            disabled={ctx.commandBusy}
            onClick={() => ctx.enqueueCommand({ kind: "close" })}
          >
            Close
          </Button>
        </div>
      </div>
    </>
  );
}

/* ── Results / Preview Section ── */
function ResultsPanel() {
  const ctx = useControlRoom();
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
          <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Quantity</span>
          <span className="font-mono text-xs text-foreground">{ctx.selectedQuantity}</span>
        </div>
        <div className="flex flex-col gap-1 p-2.5 bg-card/40 border border-border/40 shadow-sm rounded-md">
          <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Component</span>
          <span className="font-mono text-xs text-foreground">{ctx.requestedPreviewComponent}</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 items-center justify-start mt-3">
        {ctx.quickPreviewTargets.map((target) => (
          <Button key={target.id} size="sm"
            variant={ctx.requestedPreviewQuantity === target.id ? "solid" : "outline"}
            tone={ctx.requestedPreviewQuantity === target.id ? "accent" : "default"}
            disabled={!target.available || ctx.previewBusy}
            onClick={() => ctx.requestPreviewQuantity(target.id)}
          >
            {target.shortLabel}
          </Button>
        ))}
      </div>
      {ctx.previewControlsActive && (
        <div className="grid grid-cols-2 gap-3 mt-5 p-3 rounded-lg border border-border/30 bg-muted/10">
          <label className="flex flex-col gap-1.5 text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">
            Quantity
            <select className="flex h-7 w-full rounded-md border border-border/60 bg-background/50 px-2.5 py-1 text-xs text-foreground font-mono focus:border-primary focus:outline-none transition-colors shadow-sm disabled:opacity-50" value={ctx.selectedQuantity}
              onChange={(e) => ctx.requestPreviewQuantity(e.target.value)}
              disabled={ctx.previewBusy}
            >
              {ctx.quantityOptions.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">
            Component
            <select className="flex h-7 w-full rounded-md border border-border/60 bg-background/50 px-2.5 py-1 text-xs text-foreground font-mono focus:border-primary focus:outline-none transition-colors shadow-sm disabled:opacity-50" value={ctx.requestedPreviewComponent}
              onChange={(e) => void ctx.updatePreview("/component", { component: e.target.value as PreviewComponent })}
              disabled={ctx.previewBusy}
            >
              <option value="3D">3D</option>
              <option value="x">x</option>
              <option value="y">y</option>
              <option value="z">z</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">
            Refresh
            <select className="flex h-7 w-full rounded-md border border-border/60 bg-background/50 px-2.5 py-1 text-xs text-foreground font-mono focus:border-primary focus:outline-none transition-colors shadow-sm disabled:opacity-50" value={ctx.requestedPreviewEveryN}
              onChange={(e) => void ctx.updatePreview("/everyN", { everyN: Number(e.target.value) })}
              disabled={ctx.previewBusy}
            >
              {ctx.previewEveryNOptions.map((v) => <option key={v} value={v}>{fmtPreviewEveryN(v)}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">
            Points
            <select className="flex h-7 w-full rounded-md border border-border/60 bg-background/50 px-2.5 py-1 text-xs text-foreground font-mono focus:border-primary focus:outline-none transition-colors shadow-sm disabled:opacity-50" value={ctx.requestedPreviewMaxPoints}
              onChange={(e) => void ctx.updatePreview("/maxPoints", { maxPoints: Number(e.target.value) })}
              disabled={ctx.previewBusy}
            >
              {ctx.previewMaxPointOptions.map((v) => <option key={v} value={v}>{fmtPreviewMaxPoints(v)}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground items-end justify-center">
            <span className="flex items-center gap-2 mt-1 text-xs text-foreground font-medium select-none">
              <input type="checkbox" checked={ctx.requestedPreviewAutoScale}
                onChange={(e) => void ctx.updatePreview("/autoScaleEnabled", { autoScaleEnabled: e.target.checked })}
                disabled={ctx.previewBusy} />
              Auto-fit
            </span>
          </label>
        </div>
      )}
    </>
  );
}

/* ── Solver Telemetry Section ── */
function SolverTelemetryPanel() {
  const ctx = useControlRoom();
  const sparkSeries = useMemo(() => ({
    step: buildSparkSeries(
      ctx.scalarRows,
      (row) => row.step,
      ctx.hasSolverTelemetry ? ctx.effectiveStep : null,
    ),
    time: buildSparkSeries(
      ctx.scalarRows,
      (row) => row.time,
      ctx.hasSolverTelemetry ? ctx.effectiveTime : null,
    ),
    dt: buildSparkSeries(
      ctx.scalarRows,
      (row) => row.solver_dt,
      ctx.hasSolverTelemetry ? ctx.effectiveDt : null,
    ),
    dmDt: buildSparkSeries(
      ctx.scalarRows,
      (row) => row.max_dm_dt,
      ctx.hasSolverTelemetry ? ctx.effectiveDmDt : null,
      (value) => Math.log10(Math.max(value, 1e-15)),
    ),
    hEff: buildSparkSeries(
      ctx.scalarRows,
      (row) => row.max_h_eff,
      ctx.hasSolverTelemetry ? ctx.effectiveHEff : null,
    ),
    hDemag: buildSparkSeries(
      ctx.scalarRows,
      (row) => row.max_h_demag,
      ctx.hasSolverTelemetry ? ctx.effectiveHDemag : null,
    ),
  }), [
    ctx.scalarRows,
    ctx.hasSolverTelemetry,
    ctx.effectiveStep,
    ctx.effectiveTime,
    ctx.effectiveDt,
    ctx.effectiveDmDt,
    ctx.effectiveHEff,
    ctx.effectiveHDemag,
  ]);

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <MetricField
          label="Step"
          title="Current integration step number"
          value={fmtStepValue(ctx.effectiveStep, ctx.hasSolverTelemetry)}
          sparkData={sparkSeries.step}
          sparkColor="var(--ide-text-2)"
        />
        <MetricField
          label="Time"
          title="Simulated physical time"
          value={fmtSIOrDash(ctx.effectiveTime, "s", ctx.hasSolverTelemetry)}
        />
        <MetricField
          label="Δt"
          title="Current time-step size"
          value={fmtSIOrDash(ctx.effectiveDt, "s", ctx.hasSolverTelemetry)}
          sparkData={sparkSeries.dt}
          sparkColor="#8b5cf6"
        />
        <MetricField
          label="max dm/dt"
          title="Maximum magnetisation rate of change"
          value={fmtExpOrDash(ctx.effectiveDmDt, ctx.hasSolverTelemetry)}
          sparkData={sparkSeries.dmDt}
          sparkColor="#10b981"
          valueTone={
            ctx.hasSolverTelemetry && ctx.effectiveDmDt > 0 && ctx.effectiveDmDt < 1e-5
              ? "success"
              : undefined
          }
        />
        <MetricField
          label="max |H_eff|"
          title="Maximum effective field magnitude"
          value={fmtExpOrDash(ctx.effectiveHEff, ctx.hasSolverTelemetry)}
          sparkData={sparkSeries.hEff}
          sparkColor="#3b82f6"
        />
        <MetricField
          label="max |H_demag|"
          title="Maximum demagnetising field magnitude"
          value={fmtExpOrDash(ctx.effectiveHDemag, ctx.hasSolverTelemetry)}
          sparkData={sparkSeries.hDemag}
          sparkColor="#f59e0b"
        />
      </div>
      {!ctx.hasSolverTelemetry && (
        <div className="text-xs text-muted-foreground leading-relaxed mt-4 p-3 rounded-md bg-muted/30 border border-border/40">{ctx.solverNotStartedMessage}</div>
      )}
    </>
  );
}

/* ── Energy Section ── */
function EnergyPanel() {
  const ctx = useControlRoom();
  const sparkSeries = useMemo(() => ({
    eEx: buildSparkSeries(
      ctx.scalarRows,
      (row) => row.e_ex,
      ctx.hasSolverTelemetry ? ctx.effectiveEEx : null,
    ),
    eDemag: buildSparkSeries(
      ctx.scalarRows,
      (row) => row.e_demag,
      ctx.hasSolverTelemetry ? ctx.effectiveEDemag : null,
    ),
    eExt: buildSparkSeries(
      ctx.scalarRows,
      (row) => row.e_ext,
      ctx.hasSolverTelemetry ? ctx.effectiveEExt : null,
    ),
    eTotal: buildSparkSeries(
      ctx.scalarRows,
      (row) => row.e_total,
      ctx.hasSolverTelemetry ? ctx.effectiveETotal : null,
    ),
  }), [
    ctx.scalarRows,
    ctx.hasSolverTelemetry,
    ctx.effectiveEEx,
    ctx.effectiveEDemag,
    ctx.effectiveEExt,
    ctx.effectiveETotal,
  ]);

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <MetricField
          label="E_exchange"
          value={fmtExpOrDash(ctx.effectiveEEx, ctx.hasSolverTelemetry)}
          sparkData={sparkSeries.eEx}
          sparkColor="#0ea5e9"
        />
        <MetricField
          label="E_demag"
          value={fmtExpOrDash(ctx.effectiveEDemag, ctx.hasSolverTelemetry)}
          sparkData={sparkSeries.eDemag}
          sparkColor="#f59e0b"
        />
        <MetricField
          label="E_ext"
          value={fmtExpOrDash(ctx.effectiveEExt, ctx.hasSolverTelemetry)}
          sparkData={sparkSeries.eExt}
          sparkColor="#10b981"
        />
        <MetricField
          label="E_total"
          value={fmtExpOrDash(ctx.effectiveETotal, ctx.hasSolverTelemetry)}
          sparkData={sparkSeries.eTotal}
          sparkColor="#8b5cf6"
        />
      </div>
    </>
  );
}

/* ── Main SettingsPanel ── */
interface SettingsPanelProps {
  nodeId: string;
  nodeLabel: string | null;
}

export default function SettingsPanel({ nodeId, nodeLabel }: SettingsPanelProps) {
  const ctx = useControlRoom();
  const showTelemetrySections = ctx.effectiveViewMode !== "Mesh";

  const renderNodeContent = () => {
    if (nodeId === "study" || nodeId.startsWith("study-")) return <StudyPanel />;
    if (nodeId === "mesh-size" || nodeId === "mesh-algorithm" || nodeId === "mesh-quality") {
      return (
        <MeshSettingsPanel
          options={ctx.meshOptions}
          onChange={ctx.setMeshOptions}
          quality={ctx.meshQualityData}
          generating={ctx.meshGenerating}
          onGenerate={ctx.handleMeshGenerate}
          nodeCount={ctx.effectiveFemMesh?.nodes.length}
          disabled={ctx.meshGenerating || !ctx.awaitingCommand}
          waitMode={ctx.isWaitingForCompute}
        />
      );
    }
    if (nodeId === "mesh" || nodeId.startsWith("mesh-")) return <MeshPanel />;
    if (nodeId === "results" || nodeId.startsWith("res-") || nodeId === "physics" || nodeId.startsWith("phys-")) return <ResultsPanel />;
    if (nodeId === "materials" || nodeId.startsWith("mat-")) return <MaterialPanel />;
    return <GeometryPanel />;
  };

  return (
    <div className="flex flex-col pb-6">
      <SidebarSection
        title="Selection"
        badge={nodeLabel ?? "Workspace"}
        autoOpenKey={nodeId}
      >
        {renderNodeContent()}
      </SidebarSection>

      {showTelemetrySections && (
        <SidebarSection title="Solver Telemetry" badge={ctx.workspaceStatus}>
          <SolverTelemetryPanel />
        </SidebarSection>
      )}

      {showTelemetrySections && (
        <SidebarSection title="Energy">
          <EnergyPanel />
        </SidebarSection>
      )}

      <SidebarSection
        title="Session"
        badge={ctx.sessionFooter.requestedBackend ?? null}
        defaultOpen={false}
      >
        <div className="grid gap-2">
          <div className="flex items-center justify-between py-1">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Backend</span>
            <span className="font-mono text-xs text-muted-foreground truncate ml-4 text-right">{ctx.sessionFooter.requestedBackend ?? "—"}</span>
          </div>
          <div className="flex items-center justify-between py-1">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Runtime</span>
            <span className="font-mono text-xs text-muted-foreground truncate ml-4 text-right">{ctx.runtimeEngineLabel ?? "—"}</span>
          </div>
          {ctx.sessionFooter.scriptPath && (
            <div className="flex items-center justify-between py-1">
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Script</span>
              <span className="font-mono text-xs text-muted-foreground truncate ml-4 text-right" title={ctx.sessionFooter.scriptPath}>
                {ctx.sessionFooter.scriptPath.split("/").pop()}
              </span>
            </div>
          )}
        </div>
      </SidebarSection>
    </div>
  );
}
