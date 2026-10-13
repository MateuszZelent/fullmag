import type { ChartDataPresentationState } from "./chartPresentationState";
import type { ChartRenderModel } from "./chartRenderer";
import type { ChartSeries } from "@/shared/domain/analysis/chartSeries";

export interface InteractiveChartSurfaceIdentity {
  ariaLabel: string;
  chartId: string;
  presentationCopy: {
    empty: string;
    error: string;
    hidden?: string;
    loading: string;
  };
  provenance: NonNullable<ChartRenderModel["provenance"]>;
}

export function chartSeriesRenderModel(
  series: readonly ChartSeries[],
  allSeries: readonly ChartSeries[],
  surface: InteractiveChartSurfaceIdentity,
  xAxisLabel?: string,
  dataStatus?: string,
  presentation?: ChartDataPresentationState,
): ChartRenderModel {
  const units = [...new Set(allSeries.map((item) => item.unit))].slice(0, 2);
  const allSeriesHaveSamples = allSeries.some((item) => item.points.length > 0);
  const xUnit =
    series.find((item) => item.xUnit)?.xUnit ??
    allSeries.find((item) => item.xUnit)?.xUnit ??
    "";
  const colorIndexBySeriesId = new Map<string, number>();
  allSeries.forEach((item, index) => {
    if (!colorIndexBySeriesId.has(item.id)) colorIndexBySeriesId.set(item.id, index);
  });
  const status = renderStatusForPresentation(
    presentation,
    dataStatus,
    series.some((item) => item.points.length > 0),
  );
  return {
    ariaLabel: surface.ariaLabel,
    key: surface.chartId,
    provenance: surface.provenance,
    series: series.map((item, visibleIndex) => ({
      colorIndex: colorIndexBySeriesId.get(item.id) ?? visibleIndex,
      id: item.id,
      kind: item.kind ?? "line",
      label: item.label || item.quantity,
      points: item.points,
      unit: item.unit,
      yAxis: Math.max(0, units.indexOf(item.unit)),
    })),
    status,
    statusMessage: presentationMessage(
      presentation,
      status,
      allSeriesHaveSamples,
      dataStatus,
      surface.presentationCopy,
    ),
    xAxis: { label: xAxisLabel ?? "x", unit: xUnit },
    yAxes: (units.length > 0 ? units : [""]).map((unit) => ({
      label: quantityLabelForUnit(unit, allSeries),
      unit,
    })),
  };
}

export function chartPointFromEChartsClick(
  event: unknown,
  chartSeries: readonly ChartSeries[],
): { pointIndex: number; seriesId: string } | null {
  const record =
    event && typeof event === "object"
      ? (event as Record<string, unknown>)
      : null;
  if (!record) return null;

  let series: ChartSeries | undefined;
  if ("seriesId" in record) {
    const seriesId = record.seriesId;
    if (typeof seriesId !== "string" || seriesId.trim().length === 0) {
      return null;
    }
    series = chartSeries.find((candidate) => candidate.id === seriesId);
  } else {
    const seriesIndex = Number(record.seriesIndex);
    if (!Number.isInteger(seriesIndex) || seriesIndex < 0) return null;
    series = chartSeries[seriesIndex];
  }
  if (!series) return null;

  if ("data" in record) {
    if (!Array.isArray(record.data)) return null;
    const sourceRowIndex = record.data[2];
    if (
      typeof sourceRowIndex !== "number" ||
      !Number.isInteger(sourceRowIndex)
    ) {
      return null;
    }
    const pointIndex = series.points.findIndex(
      (point) => point.rowIndex === sourceRowIndex,
    );
    return pointIndex >= 0 ? { pointIndex, seriesId: series.id } : null;
  }

  const pointIndex = "dataIndex" in record ? Number(record.dataIndex) : NaN;
  return Number.isInteger(pointIndex) && pointIndex >= 0 && series.points[pointIndex]
    ? { pointIndex, seriesId: series.id }
    : null;
}

function renderStatusForPresentation(
  presentation: ChartDataPresentationState | undefined,
  dataStatus: string | undefined,
  hasPoints: boolean,
): ChartRenderModel["status"] {
  switch (presentation?.kind) {
    case "initial-loading":
      return "loading";
    case "empty":
      return "empty";
    case "unsupported":
      return "unsupported";
    case "error":
      return "error";
    default:
      return dataStatus === "error"
        ? "error"
        : dataStatus === "loading"
          ? "loading"
          : dataStatus === "stale"
            ? "stale"
            : hasPoints
              ? "ready"
              : "empty";
  }
}

function presentationMessage(
  presentation: ChartDataPresentationState | undefined,
  status: ChartRenderModel["status"],
  allSeriesHaveSamples: boolean,
  dataStatus: string | undefined,
  copy: InteractiveChartSurfaceIdentity["presentationCopy"],
): string | undefined {
  switch (presentation?.kind) {
    case "initial-loading":
      return copy.loading;
    case "refreshing":
      return "Updating";
    case "stale":
      return `Refresh failed: ${presentation.error.message}`;
    case "paused":
      return "Paused";
    case "unsupported":
      return presentation.reason;
    case "error":
      return presentation.error.message;
    default:
      return status === "empty"
        ? allSeriesHaveSamples
          ? copy.hidden ?? copy.empty
          : copy.empty
        : status === "error"
          ? copy.error
          : dataStatus === "loading" || dataStatus === "stale"
            ? copy.loading
            : undefined;
  }
}

function quantityLabelForUnit(
  unit: string,
  series: readonly ChartSeries[],
): string {
  const match = series.find((entry) => entry.unit === unit);
  if (!match) return "Value";
  const sameUnit = series.filter((entry) => entry.unit === unit);
  const labels = sameUnit.map((entry) => entry.quantity.toLowerCase());
  if (
    unit === "1" &&
    labels.every((label) => ["mx", "my", "mz", "m"].includes(label))
  ) {
    return "Normalized magnetization m";
  }
  if (sameUnit.length === 1) return match.label || match.quantity;
  if (labels.every((label) => label.includes("torque"))) return "Torque";
  if (labels.every((label) => label.includes("residual"))) return "Residual";
  return "Value";
}
