"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Input } from "../ui/input";
import { InspectorSection, InspectorField } from "./settings/primitives";

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
    <InspectorSection
      title="Time Integration"
      eyebrow="Dynamics"
    >
      <div className="bg-primary/10 border border-primary/20 rounded-md p-3 text-xs text-foreground/80 leading-relaxed shadow-sm mb-2">
        Select the numerical method used to advance the Landau-Lifshitz-Gilbert (LLG) equation in time.
        Adaptive solvers (RK45, RK23) will automatically scale the timestep to maintain requested tolerance, whereas
        explicit methods (Heun, RK4) require a carefully chosen fixed timestep to ensure stability.
      </div>

      <InspectorField
        label="Method"
        hint={selectedIntegrator?.desc}
        control={(
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
        )}
      />

      <InspectorField
        label="Fixed Step (Δt)"
        hint="Leave empty to enable automatic adaptive timestep control. Provide a value in seconds (e.g., 1e-13) to enforce a fixed step."
        control={(
          <Input
            className="h-8 w-full border-border/50 bg-card px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
            type="text"
            value={settings.fixedTimestep}
            onChange={(e) => update({ fixedTimestep: e.target.value })}
            placeholder="auto"
            disabled={solverRunning}
          />
        )}
      />

      {solverRunning && (
        <div className="mt-2 text-[0.65rem] text-warning text-center uppercase tracking-widest font-bold p-2 bg-warning/10 rounded-md border border-warning/20">
          Simulation running. Stop the engine to edit solver parameters.
        </div>
      )}
    </InspectorSection>
  );
}

export function RelaxationSettingsPanel({ settings, onChange, solverRunning = false }: RelaxationSettingsPanelProps) {
  const update = (patch: Partial<SolverSettingsState>) => onChange({ ...settings, ...patch });
  const selectedRelax = RELAX_ALGORITHM_OPTIONS.find((o) => o.value === settings.relaxAlgorithm);

  return (
    <InspectorSection
      title="Energy Relaxation"
      eyebrow="Statics"
    >
      <div className="bg-primary/10 border border-primary/20 rounded-md p-3 text-xs text-foreground/80 leading-relaxed shadow-sm mb-2">
        Configure the steepest descent or conjugate gradient method used to find the magnetic ground state.
        The algorithm iterates until the maximum effective torque acting on the system falls below the specified
        tolerance threshold, ensuring a stable equilibrium state.
      </div>

      <InspectorField
        label="Algorithm"
        hint={selectedRelax?.desc}
        control={(
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
        )}
      />

      <InspectorField
        label="Torque Tolerance"
        hint="Target threshold for max|m × H_eff|. Default: 1e-6 T. Tighter tolerances increase accuracy but require more steps."
        control={(
          <Input
            className="h-8 w-full border-border/50 bg-card px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
            type="text"
            value={settings.torqueTolerance}
            onChange={(e) => update({ torqueTolerance: e.target.value })}
            placeholder="1e-6"
            disabled={solverRunning}
          />
        )}
      />

      <InspectorField
        label="Energy Tolerance"
        hint="Optional early-stopping threshold based on |ΔE_total| between solver steps. Leave empty to use purely torque-based convergence."
        control={(
          <Input
            className="h-8 w-full border-border/50 bg-card px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
            type="text"
            value={settings.energyTolerance}
            onChange={(e) => update({ energyTolerance: e.target.value })}
            placeholder="disabled"
            disabled={solverRunning}
          />
        )}
      />

      <InspectorField
        label="Max Error"
        hint="Adaptive timestep absolute error tolerance (atol) for RK23/RK45 integrators."
        control={(
          <Input
            className="h-8 w-full border-border/50 bg-card px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
            type="text"
            value={settings.maxError}
            onChange={(e) => update({ maxError: e.target.value })}
            placeholder="1e-6"
            disabled={solverRunning}
          />
        )}
      />

      <InspectorField
        label="Max Steps"
        hint="A hard cap on iteration count to prevent infinite loops."
        control={(
          <Input
            className="h-8 w-full border-border/50 bg-card px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
            type="text"
            value={settings.maxRelaxSteps}
            onChange={(e) => update({ maxRelaxSteps: e.target.value })}
            placeholder="5000"
            disabled={solverRunning}
          />
        )}
      />

      <InspectorField
        label="Damping α"
        hint="Artificial damping used exclusively during relaxation. 1.0 (overdamped) vastly accelerates convergence."
        control={(
          <Input
            className="h-8 w-full border-border/50 bg-card px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
            type="text"
            value={settings.relaxAlpha}
            onChange={(e) => update({ relaxAlpha: e.target.value })}
            placeholder="use material α"
            disabled={solverRunning}
          />
        )}
      />

      {solverRunning && (
        <div className="mt-2 text-[0.65rem] text-warning text-center uppercase tracking-widest font-bold p-2 bg-warning/10 rounded-md border border-warning/20">
          Simulation running. Stop the engine to edit solver parameters.
        </div>
      )}
    </InspectorSection>
  );
}
