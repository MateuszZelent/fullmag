import type {
  FrequencyDomainChartBuildResult,
  FrequencyDomainChartPoint,
  FrequencyDomainChartSeries,
} from "@/shared/domain/analysis/frequencyDomainChartModels";

import type { ChartSeries } from "./chartTableModel";

export function frequencyDomainChartSeriesForAnalysisPlots<TPoint>(
  model: FrequencyDomainChartBuildResult<TPoint>,
): ChartSeries[] {
  return model.series.flatMap((series) => {
    const points = finiteFrequencyDomainChartPoints(series.points);
    if (points.length === 0) return [];
    return [
      {
        id: series.id,
        label: series.label,
        points,
        quantity: series.quantity,
        source: series.source,
        status: series.status,
        unit: series.unit,
        xUnit: series.xUnit,
      },
    ];
  });
}

function finiteFrequencyDomainChartPoints(
  points: readonly FrequencyDomainChartPoint[],
): FrequencyDomainChartPoint[] {
  return points.filter(
    (point) =>
      Number.isInteger(point.rowIndex) &&
      point.rowIndex >= 0 &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y),
  );
}

export function frequencyDomainPrimarySeries(
  series: readonly FrequencyDomainChartSeries[],
): FrequencyDomainChartSeries | null {
  return series.find((entry) => entry.points.length > 0) ?? null;
}
