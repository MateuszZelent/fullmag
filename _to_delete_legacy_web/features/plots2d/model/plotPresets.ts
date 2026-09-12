/**
 * @module features/plots2d/model/plotPresets
 *
 * Preset configurations for the 2D Plots Workbench.
 *
 * Presets define default series selections for common analysis tasks.
 * They are applied through the toolbar or ribbon and stored in
 * `usePlot2DStore.ui.activePresetId`.
 */

import type { PlotPreset } from "./plot2dTypes";

export const PLOT_PRESETS: Record<string, PlotPreset> = {
  energy: {
    id: "energy",
    label: "Energy",
    icon: "⚡",
    mode: "time-series",
    series: ["e_ex", "e_demag", "e_ext", "e_ani", "e_dmi", "e_total"],
    description: "All energy contributions vs time",
  },
  magnetization: {
    id: "magnetization",
    label: "M avg",
    icon: "🧲",
    mode: "time-series",
    series: ["mx", "my", "mz"],
    description: "Average magnetization components vs time",
  },
  convergence: {
    id: "convergence",
    label: "Convergence",
    icon: "📉",
    mode: "time-series",
    series: ["max_dm_dt", "max_h_eff", "max_h_demag", "max_torque_T"],
    yScale: "log",
    description: "Convergence diagnostics (log scale)",
  },
  timestep: {
    id: "timestep",
    label: "Δt",
    icon: "⏱",
    mode: "time-series",
    series: ["solver_dt"],
    yScale: "log",
    description: "Solver timestep vs simulation time",
  },
  fields: {
    id: "fields",
    label: "Fields",
    icon: "🔬",
    mode: "time-series",
    series: ["max_h_eff", "max_h_demag"],
    description: "Effective and demagnetizing field maxima",
  },
  all: {
    id: "all",
    label: "All",
    icon: "📊",
    mode: "time-series",
    series: [
      "e_total", "max_dm_dt", "solver_dt", "max_h_eff",
      "mx", "my", "mz",
    ],
    description: "Overview of all key scalar outputs",
  },
};

export const PRESET_ORDER: string[] = [
  "energy",
  "magnetization",
  "convergence",
  "timestep",
  "fields",
  "all",
];

/**
 * Resolve a preset by id. Returns null for unknown ids.
 */
export function getPreset(id: string): PlotPreset | null {
  return PLOT_PRESETS[id] ?? null;
}

/**
 * Get all available presets in display order.
 */
export function getPresetsInOrder(): PlotPreset[] {
  return PRESET_ORDER
    .map((id) => PLOT_PRESETS[id])
    .filter((p): p is PlotPreset => p != null);
}

/**
 * Find which preset matches the current series selection, if any.
 *
 * A preset matches if the active series keys are exactly its series
 * (order-independent).
 */
export function matchPreset(activeSeriesKeys: readonly string[]): string | null {
  const activeSet = new Set(activeSeriesKeys);
  for (const [id, preset] of Object.entries(PLOT_PRESETS)) {
    if (preset.series.length !== activeSet.size) continue;
    if (preset.series.every((key) => activeSet.has(key))) {
      return id;
    }
  }
  return null;
}
