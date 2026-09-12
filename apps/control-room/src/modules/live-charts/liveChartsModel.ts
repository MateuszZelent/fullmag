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

/** The table API can select ranges by row cursor or simulation time only. */
export const LIVE_CHART_TABLE_ROW_LIMIT = 5_000;
const LIVE_CHART_SERVER_X_AXIS_IDS = ["step", "t", "time"] as const;

export function isLiveChartTimeXAxisId(xAxisId: string): boolean {
  return xAxisId === "t" || xAxisId === "time";
}

export function isLiveChartServerXAxisId(xAxisId: string): boolean {
  return (LIVE_CHART_SERVER_X_AXIS_IDS as readonly string[]).includes(xAxisId);
}

/**
 * Resolve a persisted axis against the columns published by the table.
 * Observable columns such as `mx` are valid Y series, but are not valid
 * server range coordinates because the rows API has no value-range filter.
 */
export function resolveLiveChartXAxisId(
  columnIds: readonly string[],
  requestedXAxisId: string,
): string {
  if (isLiveChartServerXAxisId(requestedXAxisId) && columnIds.includes(requestedXAxisId)) {
    return requestedXAxisId;
  }
  for (const axisId of LIVE_CHART_SERVER_X_AXIS_IDS) {
    if (columnIds.includes(axisId)) return axisId;
  }
  return columnIds[0] ?? "step";
}

/**
 * A fixed range is meaningful only when it can be represented by the rows API.
 * `step` is an accepted-step label and may be sparse, so it must not be
 * mistaken for the one-based row cursor used by `from_row`/`to_row`.
 */
export function normalizeLiveChartRangeForXAxis(
  range: ChartRangePreference,
  xAxisId: string,
): ChartRangePreference {
  if (
    (range.mode === "tailTime" || range.mode === "fixed") &&
    !isLiveChartTimeXAxisId(xAxisId)
  ) {
    return { mode: "follow" };
  }
  return range;
}

export function liveChartRangesEqual(
  left: ChartRangePreference,
  right: ChartRangePreference,
): boolean {
  if (left.mode !== right.mode) return false;
  switch (left.mode) {
    case "follow":
    case "fullDecimated":
      return true;
    case "tailRows":
      return right.mode === "tailRows" && left.rows === right.rows;
    case "tailTime":
      return right.mode === "tailTime" && left.durationS === right.durationS;
    case "fixed":
      return right.mode === "fixed" && left.fromSI === right.fromSI && left.toSI === right.toSI;
  }
}

export function resolveLiveChartAxisAndRange(
  columnIds: readonly string[],
  requestedXAxisId: string,
  range: ChartRangePreference,
): { axisChanged: boolean; range: ChartRangePreference; xAxisId: string } {
  const xAxisId = columnIds.length > 0
    ? resolveLiveChartXAxisId(columnIds, requestedXAxisId)
    : requestedXAxisId;
  return {
    axisChanged: xAxisId !== requestedXAxisId,
    range: xAxisId !== requestedXAxisId
      ? { mode: "follow" }
      : normalizeLiveChartRangeForXAxis(range, xAxisId),
    xAxisId,
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
  const normalizedRange = normalizeLiveChartRangeForXAxis(range, xAxisId);
  const query = (patch: Partial<LiveTableRowsQuery> = {}): LiveTableRowsQuery => ({ columns, cursor, decimation: "minmax_lttb", includeTail: true, limit: LIVE_CHART_TABLE_ROW_LIMIT, targetPoints, ...patch });
  if (normalizedRange.mode === "tailRows") {
    // Tail rows is a bounded snapshot. A cursor would turn the requested
    // window into an append-only stream and let it grow past the user's N.
    return query({ cursor: undefined, includeTail: true, limit: normalizedRange.rows, targetPoints: normalizedRange.rows });
  }
  if (normalizedRange.mode === "tailTime" && isLiveChartTimeXAxisId(xAxisId) && latestX !== null) {
    // Keep the lower bound stable while new samples arrive. The previous
    // latestX is stale by the time an invalidation refetch runs, so carrying
    // it as toT would exclude the appended rows.
    return query({ cursor: undefined, fromT: latestX - normalizedRange.durationS, includeTail: false, limit: LIVE_CHART_TABLE_ROW_LIMIT });
  }
  if (normalizedRange.mode === "fixed") {
    const from = Math.min(normalizedRange.fromSI, normalizedRange.toSI);
    const to = Math.max(normalizedRange.fromSI, normalizedRange.toSI);
    return isLiveChartTimeXAxisId(xAxisId)
      ? query({ cursor: undefined, fromT: from, includeTail: false, toT: to })
      : query();
  }
  if (normalizedRange.mode === "fullDecimated") return query({ cursor: undefined, includeTail: false, limit: LIVE_CHART_TABLE_ROW_LIMIT });
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
