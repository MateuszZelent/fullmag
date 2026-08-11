import type {
  FrequencyDomainChartBuildResult,
  FrequencyDomainChartSeries,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import { descriptorForFrequencyTable } from "@/shared/domain/analysis/analysisSurfaceDescriptor";
import { finiteFrequencySeries } from "@/shared/analysis-charts/frequencyRenderModels";

import type { ChartSeries } from "@/shared/domain/analysis/chartSeries";

export function frequencyDomainChartSeriesForAnalysisPlots<TPoint>(
  model: FrequencyDomainChartBuildResult<TPoint>,
): ChartSeries[] {
  return finiteFrequencySeries(model);
}

export function frequencyDomainPrimarySeries(
  series: readonly FrequencyDomainChartSeries[],
): FrequencyDomainChartSeries | null {
  return series.find((entry) => entry.points.length > 0) ?? null;
}

export function frequencyDomainXAxisLabel(
  series: readonly ChartSeries[],
): string {
  const first = series.find((entry) => entry.points.length > 0) ?? series[0];
  if (!first) return "x";
  const descriptor = descriptorForFrequencyTable(first.source.tableId);
  if (descriptor.xAxis.unit === "1" || descriptor.xAxis.unit === "series-defined") {
    return descriptor.xAxis.label;
  }
  return first.xUnit ? `${descriptor.xAxis.label} [${first.xUnit}]` : descriptor.xAxis.label;
}
