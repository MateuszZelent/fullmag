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

/** Build once per resource update; a large k sweep must not rescan every point for every option. */
export function modalSpectrumSampleLabels(series: readonly ChartSeries[]): ReadonlyMap<number, string> {
  const labels = new Map<number, string>();
  for (const entry of series) {
    if (entry.quantity !== "frequency") continue;
    for (const point of entry.points) {
      const sample = point.sampleIndex;
      if (sample == null || !Number.isSafeInteger(sample) || sample < 0 || labels.has(sample)) continue;
      const vector = point.wavevectorKf;
      labels.set(sample, vector
        ? `Sample ${sample} · k = (${vector.map((value) => Number((value / 1e6).toPrecision(6))).join(", ")}) rad/µm`
        : `Sample ${sample}`);
    }
  }
  return labels;
}
