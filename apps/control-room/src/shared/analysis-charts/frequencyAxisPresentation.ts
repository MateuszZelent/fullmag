import { resolveChartUnit } from "@/shared/domain/analysis/chartUnits";

export interface FrequencyValueSeries {
  points: readonly { y: number }[];
  quantity: string;
  unit: string;
}

export type FrequencyAxisDataRange = readonly [min: number, max: number];

export const FREQUENCY_CHART_POINT_SYMBOL_SIZE = 7;

export function isFrequencyValueSeries(series: Pick<FrequencyValueSeries, "quantity" | "unit">): boolean {
  return (series.quantity === "frequency" || series.quantity === "analytic_frequency") &&
    resolveChartUnit(series.unit)?.dimension === "frequency";
}

/** Finite plotted frequency extent with a small relative margin on both sides. */
export function frequencyAxisDataRange(
  series: readonly FrequencyValueSeries[],
): FrequencyAxisDataRange | null {
  const first = series[0];
  if (
    !first ||
    !isFrequencyValueSeries(first) ||
    !series.every((entry) =>
      isFrequencyValueSeries(entry) && entry.unit === first.unit
    )
  ) {
    return null;
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const entry of series) {
    for (const point of entry.points) {
      if (!Number.isFinite(point.y)) continue;
      min = Math.min(min, point.y);
      max = Math.max(max, point.y);
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;

  const span = max - min;
  const magnitude = Math.max(Math.abs(min), Math.abs(max));
  let padding = Number.isFinite(span) && span > 0
    ? span * 0.05
    : magnitude * 0.05;
  if (!Number.isFinite(padding) || padding <= 0) {
    padding = magnitude > 0 ? magnitude * 0.05 : Number.EPSILON;
  }
  if (!Number.isFinite(padding) || padding <= 0) padding = Number.MIN_VALUE;

  const paddedMin = min - padding;
  const paddedMax = max + padding;
  return [
    Number.isFinite(paddedMin) ? paddedMin : min,
    Number.isFinite(paddedMax) ? paddedMax : max,
  ];
}