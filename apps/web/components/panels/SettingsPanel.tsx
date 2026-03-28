"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ScalarRow } from "../../lib/useSessionStream";
import { cn } from "@/lib/utils";
import { useControlRoom, type SolverPlanSummary } from "../runs/control-room/ControlRoomContext";
import Button from "../ui/Button";
import Sparkline from "../ui/Sparkline";
import {
  type PreviewComponent,
  fmtExp,
  fmtExpOrDash,
  fmtPreviewEveryN,
  fmtPreviewMaxPoints,
  fmtSI,
  fmtSIOrDash,
  fmtStepValue,
} from "../runs/control-room/shared";
import s from "../runs/RunControlRoom.module.css";

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
  sparkData: number[];
  sparkColor: string;
  title?: string;
  valueTone?: "success";
}

function MetricField({ label, value, sparkData, sparkColor, title, valueTone }: MetricFieldProps) {
  return (
    <div className={s.fieldCell}>
      <span className={s.fieldLabel} title={title}>{label}</span>
      <span className={cn(s.fieldValue, valueTone === "success" ? s.fieldValueSuccess : undefined)}>
        {value}
      </span>
      <div className={s.metricSparkline}>
        <Sparkline
          data={sparkData}
          height={20}
          color={sparkColor}
          fill={false}
          responsive
        />
      </div>
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
    <section className={s.section}>
      <button
        type="button"
        className={s.sectionHeaderButton}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <span className={s.sectionChevron} data-open={open}>▸</span>
        <span className={s.sectionTitle}>{title}</span>
        {badge ? <span className={s.sectionBadge}>{badge}</span> : null}
      </button>
      {open ? <div className={s.sectionBody}>{children}</div> : null}
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
    <div className={s.fieldGrid2}>
      <div className={s.fieldCell}>
        <span className={s.fieldLabel}>Geometry</span>
        <span className={s.fieldValue}>{ctx.meshName ?? ctx.mesherSourceKind ?? "—"}</span>
      </div>
      <div className={s.fieldCell}>
        <span className={s.fieldLabel}>Source</span>
        <span className={s.fieldValue}>{ctx.meshSource ?? ctx.mesherSourceKind ?? "—"}</span>
      </div>
      <div className={s.fieldCell}>
        <span className={s.fieldLabel}>Extent</span>
        <span className={s.fieldValue}>
          {ctx.meshExtent
            ? `${fmtSI(ctx.meshExtent[0], "m")} · ${fmtSI(ctx.meshExtent[1], "m")} · ${fmtSI(ctx.meshExtent[2], "m")}`
            : "—"}
        </span>
      </div>
      <div className={s.fieldCell}>
        <span className={s.fieldLabel}>Bounds</span>
        <span className={s.fieldValue}>
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
  if (!ctx.material) return <div className={s.fieldValue}>Material metadata not available yet.</div>;
  return (
    <>
      <div className={s.fieldGrid3}>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>M_sat</span>
          <span className={s.fieldValue}>{ctx.material.msat != null ? fmtSI(ctx.material.msat, "A/m") : "—"}</span>
        </div>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>A_ex</span>
          <span className={s.fieldValue}>{ctx.material.aex != null ? fmtSI(ctx.material.aex, "J/m") : "—"}</span>
        </div>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>α</span>
          <span className={s.fieldValue}>{ctx.material.alpha?.toPrecision(3) ?? "—"}</span>
        </div>
      </div>
      <div className={s.pillRow}>
        {ctx.material.exchangeEnabled && <span className={s.termPill}>Exchange</span>}
        {ctx.material.demagEnabled && <span className={s.termPill}>Demag</span>}
        {ctx.material.zeemanField?.some((v) => v !== 0) && <span className={s.termPill}>Zeeman</span>}
      </div>
    </>
  );
}

/* ── Mesh Section ── */
function MeshPanel() {
  const ctx = useControlRoom();
  return (
    <>
      <div className={s.fieldGrid2}>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>Backend</span>
          <span className={s.fieldValue}>{ctx.mesherBackend ?? "—"}</span>
        </div>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>Source</span>
          <span className={s.fieldValue}>{ctx.mesherSourceKind ?? ctx.meshSource ?? "—"}</span>
        </div>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>Order</span>
          <span className={s.fieldValue}>{ctx.meshFeOrder != null ? String(ctx.meshFeOrder) : "—"}</span>
        </div>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>hmax</span>
          <span className={s.fieldValue}>{ctx.meshHmax != null ? fmtSI(ctx.meshHmax, "m") : "—"}</span>
        </div>
      </div>
      <div className={cn(s.interactiveActions, s.interactiveActionsWrapStart)}>
        <Button size="sm" variant="outline" onClick={() => ctx.openFemMeshWorkspace("mesh")} disabled={!ctx.isFemBackend}>
          Mesh
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => { ctx.setViewMode("Mesh"); ctx.setFemDockTab("mesher"); }}
          disabled={!ctx.isFemBackend}
        >
          Mesher
        </Button>
        <Button size="sm" variant="outline" onClick={() => ctx.openFemMeshWorkspace("quality")} disabled={!ctx.isFemBackend}>
          Quality
        </Button>
        <Button
          size="sm" tone="accent" variant="solid"
          onClick={() => void ctx.handleMeshGenerate()}
          disabled={!ctx.isFemBackend || ctx.meshGenerating || !ctx.awaitingCommand}
        >
          {ctx.meshGenerating ? "Meshing..." : "Generate"}
        </Button>
      </div>
    </>
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
      <div className={s.inspectorBlock}>
        <div className={s.inspectorBlockTitle}>Active Backend Configuration</div>
        <div className={s.fieldGrid3}>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel}>State</span>
            <span className={s.fieldValue}>{ctx.workspaceStatus}</span>
          </div>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel}>Study</span>
            <span className={s.fieldValue}>{studyKindForPlan(solverPlan)}</span>
          </div>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel}>Engine</span>
            <span className={s.fieldValue}>{ctx.runtimeEngineLabel ?? ctx.sessionFooter.requestedBackend ?? "—"}</span>
          </div>
        </div>

        <div className={cn(s.fieldGrid3, s.fieldGridTopSpace)}>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel}>Backend</span>
            <span className={s.fieldValue}>{humanizeToken(solverPlan?.resolvedBackend ?? solverPlan?.backendKind ?? ctx.sessionFooter.requestedBackend)}</span>
          </div>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel}>Mode</span>
            <span className={s.fieldValue}>{humanizeToken(solverPlan?.executionMode ?? ctx.session?.execution_mode)}</span>
          </div>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel}>Precision</span>
            <span className={s.fieldValue}>{humanizeToken(solverPlan?.precision ?? ctx.session?.precision)}</span>
          </div>
        </div>

        <div className={cn(s.fieldGrid3, s.fieldGridTopSpace)}>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel}>Integrator</span>
            <span className={s.fieldValue}>{integratorProfile?.label ?? humanizeToken(solverPlan?.integrator)}</span>
          </div>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel}>Δt control</span>
            <span className={s.fieldValue}>{timestepModeForPlan(solverPlan)}</span>
          </div>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel}>Precession</span>
            <span className={s.fieldValue}>{precessionModeForPlan(solverPlan)}</span>
          </div>
        </div>

        <div className={cn(s.fieldGrid3, s.fieldGridTopSpace)}>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel}>γ</span>
            <span className={s.fieldValue}>{solverPlan?.gyromagneticRatio != null ? `${fmtExp(solverPlan.gyromagneticRatio)} m/(A·s)` : "—"}</span>
          </div>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel}>Exchange BC</span>
            <span className={s.fieldValue}>{humanizeToken(solverPlan?.exchangeBoundary)}</span>
          </div>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel}>Workload</span>
            <span className={s.fieldValue}>{workloadLabel}</span>
          </div>
        </div>

        <div className={cn(s.fieldGrid2, s.fieldGridTopSpace)}>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel}>Discretization</span>
            <span className={s.fieldValue}>
              {!solverPlan
                ? "—"
                : solverPlan.backendKind === "fem"
                ? `P${solverPlan.feOrder ?? "?"} · hmax ${solverPlan.hmax != null ? fmtSI(solverPlan.hmax, "m") : "—"}`
                : `${formatGrid(solverPlan?.gridCells ?? null)} cells · ${formatVector(solverPlan?.cellSize ?? null, "m")}`}
            </span>
          </div>
          <div className={s.fieldCell}>
            <span className={s.fieldLabel}>External field</span>
            <span className={s.fieldValue}>{formatVector(solverPlan?.externalField ?? null, "T")}</span>
          </div>
        </div>

        {(solverPlan?.fixedTimestep != null || solverPlan?.adaptive) && (
          <div className={cn(s.fieldGrid2, s.fieldGridTopSpace)}>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>Fixed Δt</span>
              <span className={s.fieldValue}>{solverPlan?.fixedTimestep != null ? fmtSI(solverPlan.fixedTimestep, "s") : "—"}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>Adaptive atol</span>
              <span className={s.fieldValue}>{solverPlan?.adaptive?.atol != null ? fmtExp(solverPlan.adaptive.atol) : "—"}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>Adaptive dt₀</span>
              <span className={s.fieldValue}>{solverPlan?.adaptive?.dtInitial != null ? fmtSI(solverPlan.adaptive.dtInitial, "s") : "—"}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>Adaptive range</span>
              <span className={s.fieldValue}>
                {solverPlan?.adaptive
                  ? `${solverPlan.adaptive.dtMin != null ? fmtSI(solverPlan.adaptive.dtMin, "s") : "—"} → ${solverPlan.adaptive.dtMax != null ? fmtSI(solverPlan.adaptive.dtMax, "s") : "—"}`
                  : "—"}
              </span>
            </div>
          </div>
        )}

        {solverPlan?.relaxation && (
          <div className={cn(s.fieldGrid2, s.fieldGridTopSpace)}>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>Relax algorithm</span>
              <span className={s.fieldValue}>{relaxationProfile?.label ?? humanizeToken(solverPlan.relaxation.algorithm)}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>Max steps</span>
              <span className={s.fieldValue}>{solverPlan.relaxation.maxSteps != null ? solverPlan.relaxation.maxSteps.toLocaleString() : "—"}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>Torque tol.</span>
              <span className={s.fieldValue}>{solverPlan.relaxation.torqueTolerance != null ? fmtExp(solverPlan.relaxation.torqueTolerance) : "—"}</span>
            </div>
            <div className={s.fieldCell}>
              <span className={s.fieldLabel}>Energy tol.</span>
              <span className={s.fieldValue}>{solverPlan.relaxation.energyTolerance != null ? fmtExp(solverPlan.relaxation.energyTolerance) : "disabled"}</span>
            </div>
          </div>
        )}

        <div className={s.inspectorPills}>
          {solverPlan?.exchangeEnabled && <span className={s.termPill}>Exchange</span>}
          {solverPlan?.demagEnabled && <span className={s.termPill}>Demag</span>}
          {solverPlan?.externalField?.some((value) => value !== 0) && <span className={s.termPill}>Zeeman</span>}
          {solverPlan?.adaptive && <span className={s.termPill}>Adaptive Δt</span>}
          {solverPlan?.relaxation && <span className={s.termPill}>Relaxation stage</span>}
        </div>

        {solverPlan?.notes.length ? (
          <div className={s.inspectorNoteList}>
            {solverPlan.notes.map((note) => (
              <div key={note} className={s.inspectorNoteItem}>{note}</div>
            ))}
          </div>
        ) : null}
      </div>

      <div className={s.inspectorBlock}>
        <div className={s.inspectorBlockTitle}>Performance And Physics</div>
        <div className={s.inspectorCardGrid}>
          {insightCards.map((card) => (
            <div key={card.title} className={s.inspectorCard}>
              <div className={s.inspectorCardTitle}>{card.title}</div>
              <div className={s.inspectorCardSubtitle}>{card.subtitle}</div>
              <div className={s.inspectorCardBody}>{card.body}</div>
            </div>
          ))}
        </div>
      </div>

      <div className={s.inspectorBlock}>
        <div className={s.inspectorBlockTitle}>Next Interactive Command</div>
        <div className={s.interactiveBlock}>
          <label className={s.interactiveLabel}>
            Run until [s]
            <input
              className={s.interactiveInput}
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
        <div className={cn(s.fieldGrid2, s.fieldGridTopSpaceSm)}>
          <label className={s.interactiveLabel}>
            Relax steps
            <input className={s.interactiveInput} value={ctx.solverSettings.maxRelaxSteps}
              onChange={(e) => ctx.setSolverSettings((c) => ({ ...c, maxRelaxSteps: e.target.value }))}
              disabled={ctx.commandBusy || !ctx.awaitingCommand} />
          </label>
          <label className={s.interactiveLabel}>
            Torque tol.
            <input className={s.interactiveInput} value={ctx.solverSettings.torqueTolerance}
              onChange={(e) => ctx.setSolverSettings((c) => ({ ...c, torqueTolerance: e.target.value }))}
              disabled={ctx.commandBusy || !ctx.awaitingCommand} />
          </label>
          <label className={cn(s.interactiveLabel, s.fullWidthLabel)}>
            Energy tol.
            <input className={s.interactiveInput} value={ctx.solverSettings.energyTolerance}
              onChange={(e) => ctx.setSolverSettings((c) => ({ ...c, energyTolerance: e.target.value }))}
              placeholder="disabled" disabled={ctx.commandBusy || !ctx.awaitingCommand} />
          </label>
        </div>
        <div className={cn(s.interactiveActions, s.interactiveActionsSpread)}>
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
      <div className={s.fieldGrid2}>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>Quantity</span>
          <span className={s.fieldValue}>{ctx.requestedPreviewQuantity}</span>
        </div>
        <div className={s.fieldCell}>
          <span className={s.fieldLabel}>Component</span>
          <span className={s.fieldValue}>{ctx.requestedPreviewComponent}</span>
        </div>
      </div>
      <div className={cn(s.interactiveActions, s.interactiveActionsWrapStartCompact)}>
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
        <div className={cn(s.fieldGrid2, s.fieldGridTopSpaceLg)}>
          <label className={s.interactiveLabel}>
            Quantity
            <select className={s.interactiveInput} value={ctx.requestedPreviewQuantity}
              onChange={(e) => void ctx.updatePreview("/quantity", { quantity: e.target.value })}
              disabled={ctx.previewBusy}
            >
              {ctx.previewQuantityOptions.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
            </select>
          </label>
          <label className={s.interactiveLabel}>
            Component
            <select className={s.interactiveInput} value={ctx.requestedPreviewComponent}
              onChange={(e) => void ctx.updatePreview("/component", { component: e.target.value as PreviewComponent })}
              disabled={ctx.previewBusy}
            >
              <option value="3D">3D</option>
              <option value="x">x</option>
              <option value="y">y</option>
              <option value="z">z</option>
            </select>
          </label>
          <label className={s.interactiveLabel}>
            Refresh
            <select className={s.interactiveInput} value={ctx.requestedPreviewEveryN}
              onChange={(e) => void ctx.updatePreview("/everyN", { everyN: Number(e.target.value) })}
              disabled={ctx.previewBusy}
            >
              {ctx.previewEveryNOptions.map((v) => <option key={v} value={v}>{fmtPreviewEveryN(v)}</option>)}
            </select>
          </label>
          <label className={s.interactiveLabel}>
            Points
            <select className={s.interactiveInput} value={ctx.requestedPreviewMaxPoints}
              onChange={(e) => void ctx.updatePreview("/maxPoints", { maxPoints: Number(e.target.value) })}
              disabled={ctx.previewBusy}
            >
              {ctx.previewMaxPointOptions.map((v) => <option key={v} value={v}>{fmtPreviewMaxPoints(v)}</option>)}
            </select>
          </label>
          <label className={cn(s.interactiveLabel, s.interactiveLabelEnd)}>
            <span className={s.checkboxInlineRow}>
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
      <div className={s.fieldGrid2}>
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
          sparkData={sparkSeries.time}
          sparkColor="var(--ide-text-2)"
        />
        <MetricField
          label="Δt"
          title="Current time-step size"
          value={fmtSIOrDash(ctx.effectiveDt, "s", ctx.hasSolverTelemetry)}
          sparkData={sparkSeries.dt}
          sparkColor="var(--ide-accent)"
        />
        <MetricField
          label="max dm/dt"
          title="Maximum magnetisation rate of change"
          value={fmtExpOrDash(ctx.effectiveDmDt, ctx.hasSolverTelemetry)}
          sparkData={sparkSeries.dmDt}
          sparkColor="var(--status-running)"
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
          sparkColor="var(--ide-accent-text)"
        />
        <MetricField
          label="max |H_demag|"
          title="Maximum demagnetising field magnitude"
          value={fmtExpOrDash(ctx.effectiveHDemag, ctx.hasSolverTelemetry)}
          sparkData={sparkSeries.hDemag}
          sparkColor="var(--status-warn)"
        />
      </div>
      {!ctx.hasSolverTelemetry && (
        <div className={cn(s.meshHintText, s.hintTopSpace)}>{ctx.solverNotStartedMessage}</div>
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
      <div className={s.fieldGrid2}>
        <MetricField
          label="E_exchange"
          value={fmtExpOrDash(ctx.effectiveEEx, ctx.hasSolverTelemetry)}
          sparkData={sparkSeries.eEx}
          sparkColor="var(--ide-accent)"
        />
        <MetricField
          label="E_demag"
          value={fmtExpOrDash(ctx.effectiveEDemag, ctx.hasSolverTelemetry)}
          sparkData={sparkSeries.eDemag}
          sparkColor="var(--status-warn)"
        />
        <MetricField
          label="E_ext"
          value={fmtExpOrDash(ctx.effectiveEExt, ctx.hasSolverTelemetry)}
          sparkData={sparkSeries.eExt}
          sparkColor="var(--status-running)"
        />
        <MetricField
          label="E_total"
          value={fmtExpOrDash(ctx.effectiveETotal, ctx.hasSolverTelemetry)}
          sparkData={sparkSeries.eTotal}
          sparkColor="var(--ide-accent-text)"
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
    if (nodeId === "mesh" || nodeId.startsWith("mesh-")) return <MeshPanel />;
    if (nodeId === "results" || nodeId.startsWith("res-") || nodeId === "physics" || nodeId.startsWith("phys-")) return <ResultsPanel />;
    if (nodeId === "materials" || nodeId.startsWith("mat-")) return <MaterialPanel />;
    return <GeometryPanel />;
  };

  return (
    <div className={s.sidebarPanelContentStack}>
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
        <div className={s.fieldGrid}>
          <div className={s.footerRow}>
            <span className={s.fieldLabel}>Backend</span>
            <span className={s.footerValue}>{ctx.sessionFooter.requestedBackend ?? "—"}</span>
          </div>
          <div className={s.footerRow}>
            <span className={s.fieldLabel}>Runtime</span>
            <span className={s.footerValue}>{ctx.runtimeEngineLabel ?? "—"}</span>
          </div>
          {ctx.sessionFooter.scriptPath && (
            <div className={s.footerRow}>
              <span className={s.fieldLabel}>Script</span>
              <span className={s.footerValue} title={ctx.sessionFooter.scriptPath}>
                {ctx.sessionFooter.scriptPath.split("/").pop()}
              </span>
            </div>
          )}
        </div>
      </SidebarSection>
    </div>
  );
}
