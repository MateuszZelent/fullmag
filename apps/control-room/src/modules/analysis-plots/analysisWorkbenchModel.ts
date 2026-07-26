import type { ResourceStatus } from "@/kernel/resources/resourceTypes";
import type { AnalysisWorkbenchSurface } from "@/kernel/workspace/analysisPlotsWorkspace";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";
import { chartTableWindowValue, type ChartTableWindow } from "@/shared/domain/analysis/chartDataPlan";
import { formatFrequencyHz } from "@/shared/domain/analysis/frequencyUnits";

import type { ChartSeries, ChartValueRange, TableRowsLike } from "./chartTableModel";

export function surfaceTitle(surface: AnalysisWorkbenchSurface): string {
  switch (surface) {
    case "energy": return "Energy balance";
    case "dynamics": return "Magnetization dynamics";
    case "convergence": return "Solver convergence";
    case "frequency": return "Frequency-domain analysis";
    default: return "Analysis overview";
  }
}

export function filterSeriesForSurface(series: readonly ChartSeries[], surface: AnalysisWorkbenchSurface): ChartSeries[] {
  if (surface === "overview") return series.filter((item) => !item.quantity.startsWith("e_"));
  if (surface === "dynamics") return series.filter((item) => ["mx", "my", "mz", "m"].includes(item.quantity));
  if (surface === "convergence") {
    return series.filter((item) => item.quantity.includes("torque") || item.quantity.includes("residual") || item.quantity.includes("energy_delta"));
  }
  return [...series];
}

export function tableRowsLike(table: ChartTableWindow | null): TableRowsLike | null {
  if (!table) return null;
  return {
    columns: table.columns,
    rowCount: table.rowCount,
    valueAt: (rowIndex, columnIndex) => chartTableWindowValue(table, rowIndex, columnIndex),
  };
}

export function tableWindowRowCount(table: ChartTableWindow | null): number { return table?.rowCount ?? 0; }
export function tableWindowTotalRows(table: ChartTableWindow): number { return table.totalRows; }
export function tableWindowCursorEnd(table: ChartTableWindow): number { return table.cursorEnd; }
export function tableWindowTableId(table: ChartTableWindow | null): string { return table?.tableId ?? "default"; }

export function formatTableSummary(table: ChartTableWindow | null, status: string): string {
  return table ? `${table.totalRows} rows / ${table.columns.length} columns` : status;
}

export function formatRange(range: ChartValueRange): string {
  return `${formatRangeValue(range.fromValue)}-${formatRangeValue(range.toValue)}`;
}

export function formatRangeValue(value: number): string {
  if (Math.abs(value) >= 1e4 || (value !== 0 && Math.abs(value) < 1e-3)) return value.toExponential(3);
  return Number.isInteger(value) ? String(value) : value.toPrecision(4);
}

export function formatSeriesCount(count: number): string { return `${count} series`; }
export function formatCursorPoint(point: AnalysisChartCursorPoint): string { return `${point.label} ${formatLatestValue(point.point.y)}`; }

export function buildSeriesLegend(chartSeries: readonly ChartSeries[]) {
  return chartSeries.map((series) => ({
    columnId: series.id,
    label: series.label || series.quantity,
    latest: formatLatestValue(series.points.at(-1)?.y),
    series,
    source: series.source.resourceKey,
    unit: series.unit || "1",
  }));
}

export function formatXAxisLabel(chartSeries: readonly ChartSeries[], xAxisId: string): string {
  const unit = chartSeries.find((series) => series.xUnit)?.xUnit;
  return unit ? `${xAxisId} [${unit}]` : xAxisId;
}

export function formatFrequencyDomainEmptyState(status: string): string {
  if (status === "loading") return "Loading frequency-domain artifacts";
  if (status === "error") return "Frequency-domain artifacts failed to load";
  if (status === "stale") return "Frequency-domain artifacts are missing or stale";
  return "No frequency-domain series available";
}

export function buildFrequencyDomainWorkflowSummary(chartTitle: string) {
  const normalizedTitle = chartTitle.toLowerCase();
  if (normalizedTitle.startsWith("fmr modal")) return { artifacts: "Mode fields", inspector: "mode inspector", next: "select mode to 3D overlay", workflow: "FMR modal" };
  if (normalizedTitle.startsWith("fmr response")) return { artifacts: "Response fields", inspector: "response point inspector", next: "select frequency to response overlay", workflow: "FMR driven" };
  return null;
}

export function buildFrequencyDomainWorkbenchSummary(series: readonly ChartSeries[], chartTitle: string, status: string) {
  const first = series.find((entry) => entry.points.length > 0) ?? series[0];
  const tableId = first?.source.tableId ?? "frequency-domain";
  const points = series.flatMap((entry) => entry.points);
  const finiteX = points.flatMap((point) => Number.isFinite(point.x) ? [point.x] : []);
  const finiteY = points.flatMap((point) => Number.isFinite(point.y) ? [point.y] : []);
  const frequencyValues = tableId === "frequency-domain:response-sweep" ? finiteX : tableId === "frequency-domain:eigen-spectrum" || tableId === "frequency-domain:eigen-dispersion" ? finiteY : [];
  return {
    chartKind: frequencyDomainChartKind(tableId, chartTitle),
    fieldHandoff: frequencyDomainFieldHandoff(tableId, chartTitle),
    frequencyRange: formatFrequencyDomainWorkbenchRange(frequencyValues, first),
    pointCount: `${points.length} point${points.length === 1 ? "" : "s"}`,
    status,
  };
}

export function buildFrequencyDomainCursorSummary(point: AnalysisChartCursorPoint | null, chartTitle: string) {
  if (!point || point.source.kind !== "analysis.frequency_domain") return null;
  const xValue = formatPointValue(point.point.x, point.xUnit);
  const yValue = formatPointValue(point.point.y, point.unit);
  if (point.source.tableId === "frequency-domain:eigen-spectrum") return { inspectorTarget: chartTitle.toLowerCase().startsWith("fmr") ? "FMR mode inspector and 3D overlay controls" : "Mode inspector and 3D mode controls", title: chartTitle.toLowerCase().startsWith("fmr") ? "FMR mode" : "eigen mode", xLabel: "mode", xValue, yLabel: point.quantity || "frequency", yValue };
  if (point.source.tableId === "frequency-domain:eigen-dispersion") return { inspectorTarget: "Dispersion inspector", linewidthValue: point.point.linewidthHz != null ? formatFrequencyHz(point.point.linewidthHz) : null, title: "dispersion point", xLabel: point.point.label ? "k-label" : "path_s", xValue: point.point.label ?? xValue, yLabel: point.quantity || "frequency", yValue };
  if (point.source.tableId === "frequency-domain:response-sweep") return { inspectorTarget: chartTitle.toLowerCase().startsWith("fmr") ? "FMR response point inspector and 3D response overlay" : "Response point inspector and 3D response controls", title: chartTitle.toLowerCase().startsWith("fmr") ? "FMR response point" : "response point", xLabel: "frequency", xValue, yLabel: point.quantity || "response", yValue };
  return { inspectorTarget: "Frequency-domain inspector", title: "frequency-domain point", xLabel: "x", xValue, yLabel: point.quantity || "value", yValue };
}

export function resourceStatusFromString(status: string): ResourceStatus {
  return ["idle", "loading", "ready", "stale", "error"].includes(status) ? status as ResourceStatus : "idle";
}

function frequencyDomainChartKind(tableId: string, chartTitle: string): string {
  if (tableId === "frequency-domain:eigen-spectrum") return chartTitle.toLowerCase().startsWith("fmr") ? "FMR modal spectrum" : "modal spectrum";
  if (tableId === "frequency-domain:eigen-dispersion") return "dispersion";
  if (tableId === "frequency-domain:response-sweep") return chartTitle.toLowerCase().startsWith("fmr") ? "FMR driven sweep" : "response sweep";
  return "frequency-domain";
}

function frequencyDomainFieldHandoff(tableId: string, chartTitle: string): string {
  if (tableId === "frequency-domain:eigen-spectrum") return chartTitle.toLowerCase().startsWith("fmr") ? "select mode -> FMR 3D overlay" : "select mode -> 3D overlay";
  if (tableId === "frequency-domain:eigen-dispersion") return "select branch point -> mode overlay";
  if (tableId === "frequency-domain:response-sweep") return chartTitle.toLowerCase().startsWith("fmr") ? "select frequency -> FMR response overlay" : "select frequency -> response overlay";
  return "select point -> inspector";
}

function formatFrequencyDomainWorkbenchRange(values: readonly number[], firstSeries: ChartSeries | undefined): string {
  if (!values.length) return "not available";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const unit = firstSeries?.source.tableId === "frequency-domain:response-sweep" ? firstSeries.xUnit : firstSeries?.unit;
  return min === max ? formatPointValue(min, unit) : `${formatPointValue(min, unit)}-${formatPointValue(max, unit)}`;
}

function formatPointValue(value: number, unit: string | undefined): string {
  const formatted = formatLatestValue(value);
  return unit ? `${formatted} ${unit}` : formatted;
}

function formatLatestValue(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 1e4 || (value !== 0 && Math.abs(value) < 1e-3)) return value.toExponential(3);
  const precise = value.toPrecision(5);
  return precise.includes("e") ? precise : String(Number(precise));
}
