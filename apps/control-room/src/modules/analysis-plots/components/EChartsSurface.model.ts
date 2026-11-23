import type { ChartSeries } from "@/shared/domain/analysis/chartSeries";
import type { ChartDataPresentationState } from "@/shared/analysis-charts/chartPresentationState";
import { chartSeriesRenderModel, type InteractiveChartSurfaceIdentity } from "@/shared/analysis-charts/interactiveChartModel";
import type { ChartResultExportContext } from "@/shared/analysis-charts/chartRenderer";

export function analysisChartSurfaceIdentity(
  series: readonly ChartSeries[],
  xAxisLabel: string | undefined,
  dataStatus: string | undefined,
  presentation: ChartDataPresentationState | undefined,
  chartId?: string,
  displayUnits?: Readonly<Record<string, string>>,
  descriptorId?: string,
  exportProvenance?: ChartResultExportContext,
): InteractiveChartSurfaceIdentity {
  return {
    ariaLabel: "Analysis chart",
    chartId: chartId ?? JSON.stringify([
      xAxisLabel ?? "x",
      presentation?.kind ?? dataStatus ?? "ready",
      ...series.map((item) => [item.id, item.points.length, item.points.at(-1)?.rowIndex]),
    ]),
    presentationCopy: {
      empty: "No table samples",
      error: "Table samples unavailable",
      hidden: "All selected series are hidden",
      loading: "Loading table samples",
    },
    provenance: {
      ...series[0]?.sourceIdentity,
      ...exportProvenance,
      dataRevision: series[0]?.dataRevision ?? null,
      decimation: exportProvenance?.decimation ?? "minmax_lttb",
      descriptorId: descriptorId ?? `analysis:data-table:${series[0]?.source.tableId ?? "default"}`,
      displayUnits: {
        ...Object.fromEntries(series.flatMap((item) => {
          const unit = displayUnits?.[item.quantity];
          return unit ? [[`y:${item.id}`, unit]] : [];
        })),
        ...(displayUnits?.x ? { x: displayUnits.x } : {}),
      },
      query: JSON.stringify({ xAxisLabel, series: series.map((item) => item.id) }),
      resourceKey: series[0]?.source.resourceKey ?? "data.table:default",
    },
  };
}

export function tableSeriesRenderModel(
  series: readonly ChartSeries[],
  allSeries: readonly ChartSeries[],
  xAxisLabel?: string,
  dataStatus?: string,
  presentation?: ChartDataPresentationState,
) {
  return chartSeriesRenderModel(
    series,
    allSeries,
    analysisChartSurfaceIdentity(series, xAxisLabel, dataStatus, presentation),
    xAxisLabel,
    dataStatus,
    presentation,
  );
}
