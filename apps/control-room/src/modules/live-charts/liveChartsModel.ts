import type { ChartRangePreference } from "@/kernel/workspace/liveChartPreferences";

export interface LiveTableRowsQuery {
  columns: readonly string[];
  cursor?: number;
  decimation: "minmax_lttb";
  fromRow?: number;
  fromT?: number;
  includeTail: boolean;
  limit: number;
  targetPoints: number;
  toRow?: number;
  toT?: number;
}

export type LiveChartPresetId = "magnetization" | "energy" | "convergence" | "custom";

export interface LiveChartPreset {
  id: LiveChartPresetId;
  title: string;
  defaultSeriesIds: readonly string[];
  xAxisId: string;
}

const PRESETS: Record<LiveChartPresetId, LiveChartPreset> = {
  magnetization: { id: "magnetization", title: "Magnetization", defaultSeriesIds: ["mx", "my", "mz"], xAxisId: "step" },
  energy: { id: "energy", title: "Energy", defaultSeriesIds: ["simulation.solver.energies:total"], xAxisId: "t" },
  convergence: { id: "convergence", title: "Convergence", defaultSeriesIds: ["max_torque_Apm"], xAxisId: "step" },
  custom: { id: "custom", title: "Custom", defaultSeriesIds: [], xAxisId: "step" },
};

export function liveChartPreset(id: LiveChartPresetId): LiveChartPreset {
  return PRESETS[id];
}

export function buildLiveChartsTableQuery({
  columns,
  cursor,
  latestX,
  range,
  targetPoints,
  xAxisId,
}: {
  columns: readonly string[];
  cursor: number | undefined;
  latestX: number | null;
  range: ChartRangePreference;
  targetPoints: number;
  xAxisId: string;
}): LiveTableRowsQuery {
  const query = (patch: Partial<LiveTableRowsQuery> = {}): LiveTableRowsQuery => ({ columns, cursor, decimation: "minmax_lttb", includeTail: true, limit: 5_000, targetPoints, ...patch });
  if (range.mode === "tailRows") return query({ includeTail: true, limit: range.rows, targetPoints: range.rows });
  if (range.mode === "tailTime" && (xAxisId === "t" || xAxisId === "time") && latestX !== null) {
    return query({ cursor: undefined, fromT: latestX - range.durationS, includeTail: false, toT: latestX });
  }
  if (range.mode === "fixed") {
    const from = Math.min(range.fromSI, range.toSI);
    const to = Math.max(range.fromSI, range.toSI);
    return xAxisId === "t" || xAxisId === "time"
      ? query({ cursor: undefined, fromT: from, includeTail: false, toT: to })
      : query({ cursor: undefined, fromRow: Math.max(0, Math.floor(from)), includeTail: false, toRow: Math.max(0, Math.ceil(to)) });
  }
  if (range.mode === "fullDecimated") return query({ cursor: undefined, includeTail: false, limit: targetPoints });
  return query();
}

export function compatibleLiveChartPanes(series: readonly { id: string; label: string; unit: string }[]) {
  const grouped = new Map<string, string[]>();
  for (const item of series) grouped.set(item.unit, [...(grouped.get(item.unit) ?? []), item.id]);
  return [...grouped.entries()].map(([unit, seriesIds]) => ({
    label: unit === "1" ? "Dimensionless" : unit,
    seriesIds,
    unit,
  }));
}
