import type { LiveChartsViewProps } from "../liveChartsViewTypes";
import { visibleLiveChartPanes } from "../liveChartsPresentation";
import type { InteractiveChartSurfaceIdentity } from "@/shared/analysis-charts/interactiveChartModel";

const LIVE_CHART_PRESENTATION_COPY: InteractiveChartSurfaceIdentity["presentationCopy"] = {
  empty: "No live samples",
  error: "Live samples unavailable",
  hidden: "All selected series are hidden",
  loading: "Loading live samples",
};

export interface LiveChartPaneModel {
  pane: ReturnType<typeof visibleLiveChartPanes>[number];
  paneSeries: LiveChartsViewProps["series"];
  panelTitle: string;
  surface: InteractiveChartSurfaceIdentity;
  visible: LiveChartsViewProps["series"];
}

/** Pure per-pane slices and surface identity for the live chart workspace. */
export function liveChartPaneModels({
  descriptorId,
  selectedSeriesIds,
  series,
  title,
  xAxisLabel,
}: {
  descriptorId?: LiveChartsViewProps["descriptorId"];
  selectedSeriesIds: LiveChartsViewProps["selectedSeriesIds"];
  series: LiveChartsViewProps["series"];
  title: string;
  xAxisLabel?: string;
}): LiveChartPaneModel[] {
  const selected = new Set(selectedSeriesIds);
  const panes = visibleLiveChartPanes(series, selectedSeriesIds);
  return panes.map((pane) => {
    const paneSeries = series.filter((item) => pane.seriesIds.includes(item.id));
    const visible = paneSeries.filter((item) => selected.has(item.id));
    const panelTitle = panes.length > 1 ? `${title} — ${pane.label}` : title;
    return {
      pane,
      paneSeries,
      panelTitle,
      surface: {
        ariaLabel: `${panelTitle} live chart`,
        chartId: `live-charts:${descriptorId ?? title}:${pane.unit}:${xAxisLabel ?? "x"}`,
        presentationCopy: LIVE_CHART_PRESENTATION_COPY,
        provenance: {
          dataRevision: paneSeries[0]?.dataRevision ?? null,
          decimation: "minmax_lttb",
          descriptorId: `live:${title.toLowerCase()}`,
          query: title,
          resourceKey: paneSeries[0]?.source.resourceKey ?? "data.table:default",
        },
      },
      visible,
    };
  });
}
