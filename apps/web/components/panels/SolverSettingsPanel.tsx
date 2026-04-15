"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Input } from "../ui/input";

/* ── Types ─────────────────────────────────────────────────── */

export interface SolverSettingsState {
  /** Time integrator algorithm for LLG stepping. */
  integrator: string;
  /** Fixed timestep in seconds (empty string = auto/adaptive). */
  fixedTimestep: string;
  /** Relaxation algorithm selection. */
  relaxAlgorithm: string;
  /** Torque convergence tolerance for relaxation (T). */
  torqueTolerance: string;
  /** Energy convergence tolerance for relaxation (J). Empty = disabled. */
  energyTolerance: string;
  /** Maximum relaxation steps. */
  maxRelaxSteps: string;
  /** Gilbert damping parameter α for relaxation (overrides material α). */
  relaxAlpha: string;
  /** Adaptive timestep error tolerance (atol) for RK23/RK45 relax. Empty = default (1e-6). */
  maxError: string;
}

export const DEFAULT_SOLVER_SETTINGS: SolverSettingsState = {
  integrator: "rk45",
  fixedTimestep: "",
  relaxAlgorithm: "llg_overdamped",
  torqueTolerance: "1e-6",
  energyTolerance: "",
  maxRelaxSteps: "5000",
  relaxAlpha: "1.0",
  maxError: "1e-6",
};

/** Canonical numeric fallback for convergence comparisons across the UI. */
export const DEFAULT_CONVERGENCE_THRESHOLD =
  Number(DEFAULT_SOLVER_SETTINGS.torqueTolerance) || 1e-6;

export interface IntegratorSettingsPanelProps {
  settings: SolverSettingsState;
  onChange: (next: SolverSettingsState) => void;
  solverRunning?: boolean;
}

export interface RelaxationSettingsPanelProps {
  settings: SolverSettingsState;
  onChange: (next: SolverSettingsState) => void;
  solverRunning?: boolean;
}

/* ── Algorithm options ─────────────────────────────────────── */

const INTEGRATOR_OPTIONS = [
  { value: "heun", label: "Heun (RK2)", desc: "2nd-order explicit, fixed step. Fast, basic accuracy." },
  { value: "rk4", label: "RK4", desc: "Classic 4th-order Runge–Kutta. Good balance of speed and accuracy." },
  { value: "rk23", label: "RK2(3) Adaptive", desc: "Embedded 2nd/3rd-order pair with automatic timestep control." },
  { value: "rk45", label: "RK4(5) Adaptive", desc: "Dormand–Prince embedded pair. High accuracy, adaptive Δt." },
  { value: "abm3", label: "ABM3", desc: "Adams–Bashforth–Moulton 3rd-order multistep. Efficient for smooth dynamics." },
];

const RELAX_ALGORITHM_OPTIONS = [
  { value: "llg_overdamped", label: "LLG Overdamped", desc: "Standard time-stepping with high damping (α≈1). Safe, always converges. Works on FDM and FEM." },
  { value: "projected_gradient_bb", label: "Projected Gradient (BB)", desc: "Barzilai–Borwein steepest descent on the sphere manifold with Armijo backtracking. Fast convergence, FDM only." },
  { value: "nonlinear_cg", label: "Nonlinear CG", desc: "Polak–Ribière+ conjugate gradient with tangent-space transport. OOMMF-quality, FDM only." },
  { value: "tangent_plane_implicit", label: "Tangent Plane Implicit", desc: "Linearly implicit tangent-plane scheme. FEM only, not yet available." },
];

/* ── Tooltip ─────────────────────────────────────────────────  */

function HelpTip({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center justify-center w-3 h-3 rounded-full bg-muted text-muted-foreground text-[8px] cursor-help" title={text}>
      ?
    </span>
  );
}

/* ── Components ────────────────────────────────────────────── */

export function IntegratorSettingsPanel({ settings, onChange, solverRunning = false }: IntegratorSettingsPanelProps) {
  const update = (patch: Partial<SolverSettingsState>) => onChange({ ...settings, ...patch });
  const selectedIntegrator = INTEGRATOR_OPTIONS.find((o) => o.value === settings.integrator);

  return (
    <div className="flex flex-col gap-4 py-4">
      {/* Documentation Block */}
      <div className="bg-blue-500/10 border border-blue-500/20 rounded-md p-3 text-xs text-blue-100 leading-relaxed shadow-sm">
        <strong className="text-blue-400 block mb-1 uppercase tracking-widest text-[0.65rem]">Time Integration</strong>
        Select the numerical method used to advance the Landau-Lifshitz-Gilbert (LLG) equation in time.
        Adaptive solvers (RK45, RK23) will automatically scale the timestep to maintain requested tolerance, whereas
        explicit methods (Heun, RK4) require a carefully chosen fixed timestep to ensure stability.
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">Method</span>
          <div className="flex-1 max-w-[150px]">
            <Select
              value={settings.integrator}
              onValueChange={(val) => update({ integrator: val })}
              disabled={solverRunning}
            >
              <SelectTrigger className="h-8 w-full border-border/50 bg-card text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INTEGRATOR_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {selectedIntegrator && (
          <div className="text-[0.7rem] leading-relaxed text-muted-foreground p-2 bg-black/10 rounded-md border border-border/20 border-l-2 border-l-blue-500/50">
            {selectedIntegrator.desc}
          </div>
        )}

        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
            Fixed Step (Δt)
            <HelpTip text="Leave empty to enable automatic adaptive timestep control. Provide a value in seconds (e.g., 1e-13) to enforce a fixed step." />
          </span>
          <div className="flex-1 max-w-[150px]">
            <Input
              className="h-8 w-full border-border/50 bg-card px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
              type="text"
              value={settings.fixedTimestep}
              onChange={(e) => update({ fixedTimestep: e.target.value })}
              placeholder="auto"
              disabled={solverRunning}
            />
          </div>
        </div>
      </div>

      {solverRunning && (
        <div className="mt-2 text-[0.65rem] text-amber-500 text-center uppercase tracking-widest font-bold p-2 bg-amber-500/10 rounded-md border border-amber-500/20">
          Simulation running. Stop the engine to edit solver parameters.
        </div>
      )}
    </div>
  );
}

export function RelaxationSettingsPanel({ settings, onChange, solverRunning = false }: RelaxationSettingsPanelProps) {
  const update = (patch: Partial<SolverSettingsState>) => onChange({ ...settings, ...patch });
  const selectedRelax = RELAX_ALGORITHM_OPTIONS.find((o) => o.value === settings.relaxAlgorithm);

  return (
    <div className="flex flex-col gap-4 py-4">
      {/* Documentation Block */}
      <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-md p-3 text-xs text-emerald-100 leading-relaxed shadow-sm">
        <strong className="text-emerald-400 block mb-1 uppercase tracking-widest text-[0.65rem]">Energy Relaxation</strong>
        Configure the steepest descent or conjugate gradient method used to find the magnetic ground state.
        The algorithm iterates until the maximum effective torque acting on the system falls below the specified
        tolerance threshold, ensuring a stable equilibrium state.
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">Algorithm</span>
          <div className="flex-1 max-w-[150px]">
            <Select
              value={settings.relaxAlgorithm}
              onValueChange={(val) => update({ relaxAlgorithm: val })}
              disabled={solverRunning}
            >
              <SelectTrigger className="h-8 w-full border-border/50 bg-card text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RELAX_ALGORITHM_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {selectedRelax && (
          <div className="text-[0.7rem] leading-relaxed text-muted-foreground p-2 bg-black/10 rounded-md border border-border/20 border-l-2 border-l-emerald-500/50">
            {selectedRelax.desc}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 title-trigger">
          <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
            Torque Tolerance
            <HelpTip text="Target threshold for max|m × H_eff|. Default: 1e-6 T. Tighter tolerances (e.g. 1e-7) increase accuracy but require more steps." />
          </span>
          <div className="flex-1 max-w-[150px]">
            <Input
              className="h-8 w-full border-border/50 bg-card px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
              type="text"
              value={settings.torqueTolerance}
              onChange={(e) => update({ torqueTolerance: e.target.value })}
              placeholder="1e-6"
              disabled={solverRunning}
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
            Energy Tolerance
            <HelpTip text="Optional early-stopping threshold based on |ΔE_total| between solver steps. Leave empty to use purely torque-based convergence." />
          </span>
          <div className="flex-1 max-w-[150px]">
            <Input
              className="h-8 w-full border-border/50 bg-card px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
              type="text"
              value={settings.energyTolerance}
              onChange={(e) => update({ energyTolerance: e.target.value })}
              placeholder="disabled"
              disabled={solverRunning}
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
            Max Error
            <HelpTip text="Adaptive timestep absolute error tolerance (atol) for RK23/RK45 integrators. Controls accuracy vs. speed tradeoff. Ignored for fixed-timestep methods." />
          </span>
          <div className="flex-1 max-w-[150px]">
            <Input
              className="h-8 w-full border-border/50 bg-card px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
              type="text"
              value={settings.maxError}
              onChange={(e) => update({ maxError: e.target.value })}
              placeholder="1e-6"
              disabled={solverRunning}
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
            Max Steps
            <HelpTip text="A hard cap on iteration count to prevent infinite loops if the tolerance is unreachable." />
          </span>
          <div className="flex-1 max-w-[150px]">
            <Input
              className="h-8 w-full border-border/50 bg-card px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
              type="text"
              value={settings.maxRelaxSteps}
              onChange={(e) => update({ maxRelaxSteps: e.target.value })}
              placeholder="5000"
              disabled={solverRunning}
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
            Damping α
            <HelpTip text="Artificial damping used exclusively during relaxation. Setting this to 1.0 (overdamped) vastly accelerates convergence towards the local minimum." />
          </span>
          <div className="flex-1 max-w-[150px]">
            <Input
              className="h-8 w-full border-border/50 bg-card px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
              type="text"
              value={settings.relaxAlpha}
              onChange={(e) => update({ relaxAlpha: e.target.value })}
              placeholder="use material α"
              disabled={solverRunning}
            />
          </div>
        </div>
      </div>

      {solverRunning && (
        <div className="mt-2 text-[0.65rem] text-amber-500 text-center uppercase tracking-widest font-bold p-2 bg-amber-500/10 rounded-md border border-amber-500/20">
          Simulation running. Stop the engine to edit solver parameters.
        </div>
      )}
    </div>
  );
}
