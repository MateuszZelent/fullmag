import type { KernelApi } from "@/kernel/types";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";
import { ChartLegend, chartColorNameForIndex } from "@/shared/analysis-charts/ChartLegend";
import { ChartSection } from "@/shared/analysis-charts/ChartSection";
import {
  createChartDisplayTransform,
  createChartYAxisDisplayTransforms,
  formatChartDisplayValue,
} from "@/shared/analysis-charts/chartScalePolicy";

import type { ChartSeries } from "../chartTableModel";
import { formatSeriesCount } from "../analysisWorkbenchModel";
import { EChartsSurface } from "./EChartsSurface";

export function AnalysisEnergySurface({
  hiddenSeriesIds = [],
  kernel,
  onPointSelect,
  onSolo,
  onToggleVisibility,
  series,
  showLegend = true,
  status,
}: {
  hiddenSeriesIds?: readonly string[];
  kernel: KernelApi;
  onPointSelect: (point: AnalysisChartCursorPoint) => void;
  onSolo?: (seriesId: string | null, allSeriesIds?: readonly string[]) => void;
  onToggleVisibility?: (seriesId: string) => void;
  series: readonly ChartSeries[];
  showLegend?: boolean;
  status: string;
}) {
  if (series.length === 0) {
    return <div className="fm-analysis-plots__empty" role="status">No energy history available</div>;
  }

  const allIds = series.map((s) => s.id);
  const hidden = hiddenSeriesIds.filter((id) => allIds.includes(id));
  const soloedId =
    hidden.length > 0 && hidden.length === allIds.length - 1
      ? allIds.find((id) => !hidden.includes(id)) ?? null
      : null;

  const yUnits = [...new Set(series.map((entry) => entry.unit))];
  const yTransforms = createChartYAxisDisplayTransforms(
    yUnits.map((unit) => ({ unit })),
    series.map((entry) => ({
      points: entry.points,
      yAxis: yUnits.indexOf(entry.unit),
    })),
  );
  const legendItems = series.map((entry, index) => {
    const transform = yTransforms[yUnits.indexOf(entry.unit)] ??
      createChartDisplayTransform(entry.unit, null);
    return {
      id: entry.id,
      label: entry.label || entry.quantity,
      unit: transform.displayUnit,
      latestValue: formatChartDisplayValue(
        entry.points.at(-1)?.y ?? Number.NaN,
        transform,
      ),
      colorName: chartColorNameForIndex(index),
      colorIndex: index,
      hidden: hidden.includes(entry.id),
      soloed: soloedId !== null && soloedId === entry.id,
    };
  });

  const visibleSeries = hidden.length === 0
    ? series
    : series.filter((s) => !hidden.includes(s.id));

  const legend = showLegend ? (
    <ChartLegend
      ariaLabel="Energy series"
      items={legendItems}
      onToggleVisibility={onToggleVisibility ?? (() => {})}
      onSolo={(id) => onSolo?.(id, allIds)}
    />
  ) : null;

  return (
    <ChartSection
      className="fm-analysis-plots__subchart--energy"
      legend={legend}
      status={{
        primary: status === "ready" ? "Ready" : status === "stale" ? "Stale" : status,
        revision: series[0]?.dataRevision ?? null,
        // Resource readiness is transport state, not scientific qualification.
        trust: "unknown",
        pointSummary: formatSeriesCount(series.length),
      }}
      title="Energy history"
      subtitle="time [s]"
    >
      <EChartsSurface
        allSeries={series}
        bus={kernel.bus}
        dataStatus={status}
        onPointSelect={onPointSelect}
        series={visibleSeries}
        xAxisLabel="time [s]"
      />
    </ChartSection>
  );
}
