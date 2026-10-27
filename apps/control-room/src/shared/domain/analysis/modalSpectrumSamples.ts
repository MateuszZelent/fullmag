import type { ChartSeries } from "./chartSeries";

/** Sample is a physical dataset coordinate. Never merge equal ranks across k. */
export function modalSpectrumSampleIndices(series: readonly ChartSeries[]): number[] {
  return [...new Set(series.flatMap((entry) => entry.points.flatMap((point) =>
    Number.isSafeInteger(point.sampleIndex) && point.sampleIndex! >= 0 ? [point.sampleIndex!] : [],
  )))].sort((a, b) => a - b);
}

export function modalSpectrumSeriesAtSample<T extends Pick<ChartSeries, "points">>(
  series: readonly T[], sampleIndex: number,
): T[] {
  return series.map((entry) => ({
    ...entry,
    points: entry.points.filter((point) => point.sampleIndex === sampleIndex),
  }));
}
