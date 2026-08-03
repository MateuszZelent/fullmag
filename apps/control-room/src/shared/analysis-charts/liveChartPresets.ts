export type LiveChartPresetId = "magnetization" | "energy" | "convergence" | "custom";

export interface LiveChartPreset {
  id: LiveChartPresetId;
  title: string;
  defaultSeriesIds: readonly string[];
  xAxisId: string;
}

export const LIVE_CHART_PRESETS: Record<LiveChartPresetId, LiveChartPreset> = {
  magnetization: {
    id: "magnetization",
    title: "Magnetization",
    defaultSeriesIds: ["mx", "my", "mz"],
    xAxisId: "step",
  },
  energy: {
    id: "energy",
    title: "Energy",
    defaultSeriesIds: [
      "simulation.solver.energies:exchange",
      "simulation.solver.energies:demag",
      "simulation.solver.energies:zeeman",
      "simulation.solver.energies:anisotropy",
      "simulation.solver.energies:dmi",
      "simulation.solver.energies:total",
    ],
    xAxisId: "t",
  },
  convergence: {
    id: "convergence",
    title: "Convergence",
    defaultSeriesIds: ["max_torque_Apm"],
    xAxisId: "step",
  },
  custom: {
    id: "custom",
    title: "Custom",
    defaultSeriesIds: [],
    xAxisId: "step",
  },
};

export function isLiveChartPresetId(value: string): value is LiveChartPresetId {
  return value in LIVE_CHART_PRESETS;
}

export function liveChartPreset(id: LiveChartPresetId): LiveChartPreset {
  return LIVE_CHART_PRESETS[id];
}
