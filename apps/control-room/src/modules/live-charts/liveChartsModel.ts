import type { ChartRangePreference } from "@/kernel/workspace/liveChartPreferences";
import type { LiveChartDescriptorPreferences } from "@/kernel/workspace/liveChartPreferences";
import {
  liveChartPreset,
  type LiveChartPresetId,
} from "@/shared/analysis-charts/liveChartPresets";

export { liveChartPreset, type LiveChartPreset, type LiveChartPresetId } from "@/shared/analysis-charts/liveChartPresets";

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

/** Current API upper bound for one bounded non-time history window. */
const LIVE_CHART_FIXED_NON_TIME_LIMIT = 50_000;
const LIVE_CHART_DEFAULT_LIMIT = 5_000;

export function isLiveChartTimeAxisId(xAxisId: string): boolean {
  return xAxisId === "t" || xAxisId === "time";
}

/**
 * The table API filters non-time ranges by row cursor, not by the value of an
 * arbitrary plotted column. A fixed range on `step` (or a future quantity)
 * therefore requests a bounded history-window decimation and stays local to
 * the renderer instead of being misread as a row number range.
 */
export function normalizeLiveChartRangeForXAxis(
  range: ChartRangePreference,
  xAxisId: string,
): ChartRangePreference {
  if (range.mode === "fixed" && !isLiveChartTimeAxisId(xAxisId)) {
    return { mode: "fullDecimated" };
  }
  return range.mode === "tailTime" && !isLiveChartTimeAxisId(xAxisId)
    ? { mode: "follow" }
    : range;
}

export interface LiveChartQuerySemantic {
  limit: number;
  mode: ChartRangePreference["mode"] | "fixedNonTimeWindow";
  range: ChartRangePreference;
  targetPoints: number;
}

export function liveChartQuerySemantic(
  range: ChartRangePreference,
  targetPoints: number,
  xAxisId: string,
): LiveChartQuerySemantic {
  const fixedNonTimeWindow = range.mode === "fixed" && !isLiveChartTimeAxisId(xAxisId);
  const requestRange = normalizeLiveChartRangeForXAxis(range, xAxisId);
  const effectiveTargetPoints = requestRange.mode === "tailRows"
    ? requestRange.rows
    : targetPoints;
  const limit = fixedNonTimeWindow
    ? LIVE_CHART_FIXED_NON_TIME_LIMIT
    : requestRange.mode === "tailRows"
      ? requestRange.rows
      : requestRange.mode === "fullDecimated"
        ? targetPoints
        : LIVE_CHART_DEFAULT_LIMIT;
  return {
    limit,
    mode: fixedNonTimeWindow ? "fixedNonTimeWindow" : requestRange.mode,
    range: requestRange,
    targetPoints: effectiveTargetPoints,
  };
}

export function liveChartInitialRange(
  range: ChartRangePreference,
): { fromValue: number; toValue: number } | null {
  if (range.mode !== "fixed") return null;
  return {
    fromValue: Math.min(range.fromSI, range.toSI),
    toValue: Math.max(range.fromSI, range.toSI),
  };
}

export function liveChartDescriptorDefaults(id: LiveChartPresetId): LiveChartDescriptorPreferences {
  const preset = liveChartPreset(id);
  return {
    displayUnits: {},
    liveMode: "following",
    range: { mode: "follow" },
    selectedSeriesIds: [...preset.defaultSeriesIds],
    targetPoints: 800,
    xAxisId: preset.xAxisId,
  };
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
  const querySemantic = liveChartQuerySemantic(range, targetPoints, xAxisId);
  const requestRange = querySemantic.range;
  const query = (patch: Partial<LiveTableRowsQuery> = {}): LiveTableRowsQuery => ({ columns, cursor, decimation: "minmax_lttb", includeTail: true, limit: LIVE_CHART_DEFAULT_LIMIT, targetPoints, ...patch });
  if (requestRange.mode === "tailRows") return query({ includeTail: true, limit: requestRange.rows, targetPoints: requestRange.rows });
  if (requestRange.mode === "tailTime" && isLiveChartTimeAxisId(xAxisId) && latestX !== null) {
    return query({ cursor: undefined, fromT: latestX - requestRange.durationS, includeTail: false, toT: latestX });
  }
  if (requestRange.mode === "fixed" && isLiveChartTimeAxisId(xAxisId)) {
    const from = Math.min(requestRange.fromSI, requestRange.toSI);
    const to = Math.max(requestRange.fromSI, requestRange.toSI);
    return query({ cursor: undefined, fromT: from, includeTail: false, toT: to });
  }
  if (requestRange.mode === "fullDecimated") {
    return query({ cursor: undefined, includeTail: false, limit: querySemantic.limit, targetPoints });
  }
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
