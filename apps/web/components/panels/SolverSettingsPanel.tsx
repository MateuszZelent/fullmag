"use client";

import { useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Input } from "../ui/input";
import { Button } from "../ui/button";

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
}

export const DEFAULT_SOLVER_SETTINGS: SolverSettingsState = {
  integrator: "rk45",
  fixedTimestep: "",
  relaxAlgorithm: "llg_overdamped",
  torqueTolerance: "1e-6",
  energyTolerance: "",
  maxRelaxSteps: "5000",
  relaxAlpha: "",
};

interface SolverSettingsPanelProps {
  settings: SolverSettingsState;
  onChange: (next: SolverSettingsState) => void;
  /** Whether solver is currently running — disables mutation. */
  solverRunning?: boolean;
  /** Workspace is in interactive mode and awaiting a command. */
  awaitingCommand?: boolean;
  /** Callback: apply solver settings to the next run/relax command. */
  onApply?: () => void;
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

/* ── Component ─────────────────────────────────────────────── */

export default function SolverSettingsPanel({
  settings,
  onChange,
  solverRunning = false,
  awaitingCommand = false,
  onApply,
}: SolverSettingsPanelProps) {
  const disabled = solverRunning;
  const canApply = awaitingCommand && !solverRunning;

  const update = (patch: Partial<SolverSettingsState>) =>
    onChange({ ...settings, ...patch });

  const selectedIntegrator = INTEGRATOR_OPTIONS.find((o) => o.value === settings.integrator);
  const selectedRelax = RELAX_ALGORITHM_OPTIONS.find((o) => o.value === settings.relaxAlgorithm);

  return (
    <div className="flex flex-col gap-2 p-3">
      {/* ── Time Integration ── */}
      <div className="flex flex-col gap-2 p-3 rounded-lg border border-border/40 bg-card/20 shadow-sm">
        <div className="flex items-center justify-between gap-2 border-b border-border/20 pb-2 mb-1">
          <span className="text-xs font-bold uppercase tracking-widest text-foreground">Time Integration</span>
          <HelpTip text="Controls how the LLG equation is stepped forward in time. Adaptive integrators adjust Δt automatically for accuracy." />
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">Integrator</span>
            <div className="flex-1 max-w-[140px]">
              <Select
                value={settings.integrator}
                onValueChange={(val) => update({ integrator: val })}
                disabled={disabled}
              >
                <SelectTrigger className="h-7 w-full border-border/50 bg-card text-xs">
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
            <div className="text-[0.65rem] leading-relaxed text-muted-foreground mt-[-4px] mb-2 p-1.5 bg-black/10 rounded-md border border-border/20 border-l-2 border-l-primary/50">{selectedIntegrator.desc}</div>
          )}

          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              Fixed Δt
              <HelpTip text="Leave empty for adaptive timestep (recommended for RK2(3)/RK4(5)). Set to e.g. 1e-13 for fixed-step integrators." />
            </span>
            <div className="flex-1 max-w-[140px]">
              <Input
                className="h-7 w-full border-border/50 bg-card px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50 focus-visible:ring-1"
                type="text"
                value={settings.fixedTimestep}
                onChange={(e) => update({ fixedTimestep: e.target.value })}
                placeholder="auto"
                disabled={disabled}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── Relaxation ── */}
      <div className="flex flex-col gap-2 p-3 rounded-lg border border-border/40 bg-card/20 shadow-sm">
        <div className="flex items-center justify-between gap-2 border-b border-border/20 pb-2 mb-1">
          <span className="text-xs font-bold uppercase tracking-widest text-foreground">Relaxation</span>
          <HelpTip text="Energy minimization to find the ground state. The solver iterates until torque drops below the tolerance or the max step count is reached." />
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">Algorithm</span>
            <div className="flex-1 max-w-[140px]">
              <Select
                value={settings.relaxAlgorithm}
                onValueChange={(val) => update({ relaxAlgorithm: val })}
                disabled={disabled}
              >
                <SelectTrigger className="h-7 w-full border-border/50 bg-card text-xs">
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
            <div className="text-[0.65rem] leading-relaxed text-muted-foreground mt-[-4px] mb-2 p-1.5 bg-black/10 rounded-md border border-border/20 border-l-2 border-l-primary/50">{selectedRelax.desc}</div>
          )}

          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              Torque tol.
              <HelpTip text="Convergence criterion: max|m × H_eff| < tolerance. Typical: 1e-5 (fast) to 1e-7 (precise). Unit: T." />
            </span>
            <div className="flex-1 max-w-[140px]">
              <Input
                className="h-7 w-full border-border/50 bg-card px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50 focus-visible:ring-1"
                type="text"
                value={settings.torqueTolerance}
                onChange={(e) => update({ torqueTolerance: e.target.value })}
                placeholder="1e-6"
                disabled={disabled}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              Energy tol.
              <HelpTip text="Optional secondary criterion: |ΔE_total| < tolerance between steps. Leave empty to use torque-only convergence." />
            </span>
            <div className="flex-1 max-w-[140px]">
              <Input
                className="h-7 w-full border-border/50 bg-card px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50 focus-visible:ring-1"
                type="text"
                value={settings.energyTolerance}
                onChange={(e) => update({ energyTolerance: e.target.value })}
                placeholder="disabled"
                disabled={disabled}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              Max steps
              <HelpTip text="Maximum number of iterations before giving up. Increase for complex geometries or tight tolerances." />
            </span>
            <div className="flex-1 max-w-[140px]">
              <Input
                className="h-7 w-full border-border/50 bg-card px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50 focus-visible:ring-1"
                type="text"
                value={settings.maxRelaxSteps}
                onChange={(e) => update({ maxRelaxSteps: e.target.value })}
                placeholder="5000"
                disabled={disabled}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              Damping α
              <HelpTip text="Override the material damping for relaxation. Leave empty to use the material value. Higher α (e.g. 0.5–1.0) speeds convergence." />
            </span>
            <div className="flex-1 max-w-[140px]">
              <Input
                className="h-7 w-full border-border/50 bg-card px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50 focus-visible:ring-1"
                type="text"
                value={settings.relaxAlpha}
                onChange={(e) => update({ relaxAlpha: e.target.value })}
                placeholder="material default"
                disabled={disabled}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── Apply button ── */}
      {canApply && onApply && (
        <Button
          className="mt-2 w-full h-8 text-xs font-bold uppercase tracking-widest"
          variant="default"
          onClick={onApply}
          type="button"
        >
          Apply settings to next command
        </Button>
      )}

      {solverRunning && (
        <div className="mt-2 text-[0.65rem] text-amber-500 text-center uppercase tracking-widest font-bold p-2 bg-amber-500/10 rounded-md border border-amber-500/20">
          Solver is running. Stop the simulation to modify settings.
        </div>
      )}
    </div>
  );
}
