import type {
  FrequencyDomainChartBuildResult,
  FrequencyDomainChartSeries,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import { descriptorForFrequencyTable } from "@/shared/domain/analysis/analysisSurfaceDescriptor";
import { finiteFrequencySeries } from "@/shared/analysis-charts/frequencyRenderModels";

import type { ChartSeries } from "@/shared/domain/analysis/chartSeries";

/** Keep chart rendering bounded even when a JSON artifact is unusually large. */
export const MAX_FREQUENCY_DOMAIN_RENDER_POINTS = 5_000;

export function frequencyDomainChartSeriesForAnalysisPlots<TPoint>(
  model: FrequencyDomainChartBuildResult<TPoint>,
): ChartSeries[] {
  return finiteFrequencySeries(model).map((series) => ({
    ...series,
    points: boundedFrequencyPoints(series.points),
  }));
}

function boundedFrequencyPoints<TPoint extends { rowIndex: number; y: number }>(
  points: readonly TPoint[],
): readonly TPoint[] {
  if (points.length <= MAX_FREQUENCY_DOMAIN_RENDER_POINTS) return points;

  const interiorBudget = MAX_FREQUENCY_DOMAIN_RENDER_POINTS - 2;
  const interiorLength = points.length - 2;
  const bucketCount = Math.max(1, Math.floor(interiorBudget / 2));
  const selectedIndices = new Set<number>([0, points.length - 1]);

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = 1 + Math.floor((bucket * interiorLength) / bucketCount);
    const end = 1 + Math.floor(((bucket + 1) * interiorLength) / bucketCount);
    if (start >= end) continue;

    let minimumIndex = start;
    let maximumIndex = start;
    for (let index = start + 1; index < end; index += 1) {
      if (points[index]!.y < points[minimumIndex]!.y) minimumIndex = index;
      if (points[index]!.y > points[maximumIndex]!.y) maximumIndex = index;
    }
    selectedIndices.add(minimumIndex);
    selectedIndices.add(maximumIndex);
  }

  // Fill any unused budget deterministically, without disturbing the extrema
  // selected above. This keeps flat/monotonic series bounded exactly as well.
  if (selectedIndices.size < MAX_FREQUENCY_DOMAIN_RENDER_POINTS) {
    const fillStep = (points.length - 1) / (MAX_FREQUENCY_DOMAIN_RENDER_POINTS - 1);
    for (let slot = 1; slot < MAX_FREQUENCY_DOMAIN_RENDER_POINTS - 1; slot += 1) {
      if (selectedIndices.size >= MAX_FREQUENCY_DOMAIN_RENDER_POINTS) break;
      const candidate = Math.round(slot * fillStep);
      if (candidate > 0 && candidate < points.length - 1) {
        selectedIndices.add(candidate);
      }
    }
  }

  return [...selectedIndices]
    .sort((left, right) => left - right)
    .slice(0, MAX_FREQUENCY_DOMAIN_RENDER_POINTS)
    .map((index) => points[index]!);
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
