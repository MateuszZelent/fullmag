import type { ChartPreset, ChartPresetConfig } from "../EngineConsole";

export const CHART_PRESETS: Record<ChartPreset, ChartPresetConfig> = {
  energy:       { label: "Energy",       yColumns: ["e_ex", "e_demag", "e_ext", "e_ani", "e_dmi", "e_total"] },
  magnetization:{ label: "M avg",        yColumns: ["mx", "my", "mz"] },
  convergence:  { label: "Convergence",  yColumns: ["max_dm_dt", "max_h_eff", "max_torque_T"] },
  timestep:     { label: "Δt",           yColumns: ["solver_dt"] },
  all:          { label: "All",          yColumns: ["e_total", "max_dm_dt", "solver_dt", "max_h_eff", "max_torque_T"] },
};
