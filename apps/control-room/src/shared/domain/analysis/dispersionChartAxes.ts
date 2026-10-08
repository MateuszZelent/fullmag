import type { AnalysisChartCursorPoint } from "./chartCursorPoint";
import type { ChartSeries } from "./chartSeries";

export type DispersionAxis = "path" | "kx" | "ky" | "kz";
export const DISPERSION_AXIS_LABELS: Record<DispersionAxis, string> = {
  path: "k-path distance s", kx: "kₓ", ky: "kᵧ", kz: "k_z",
};
const COMPONENT_AXES = ["kx", "ky", "kz"] as const;

/** Never infer a sign from unsigned path distance or a missing physical vector. */
export function availableDispersionAxes(series: readonly ChartSeries[]): DispersionAxis[] {
  let count = 0;
  for (const entry of series) {
    for (const point of entry.points) {
      count += 1;
      if (!point.wavevectorRadPerM || point.wavevectorRadPerM.length !== 3 || !point.wavevectorRadPerM.every(Number.isFinite)) return ["path"];
    }
  }
  return count ? ["path", ...COMPONENT_AXES] : ["path"];
}

export function defaultDispersionAxis(series: readonly ChartSeries[]): DispersionAxis {
  if (availableDispersionAxes(series).length === 1) return "path";
  const values = COMPONENT_AXES.map(() => new Set<number>());
  for (const entry of series) for (const point of entry.points) {
    point.wavevectorRadPerM?.forEach((value, index) => values[index]?.add(value));
  }
  const varying = COMPONENT_AXES.filter((_, index) => values[index]!.size > 1);
  return varying.length === 1 ? varying[0]! : "path";
}

/** Preserve path order, gaps and raw row identity even at crossings/repeated k. */
export function projectDispersionSeries(
  series: readonly ChartSeries[], axis: DispersionAxis,
  selectedPoint: AnalysisChartCursorPoint | null = null,
): ChartSeries[] {
  if (!availableDispersionAxes(series).includes(axis)) {
    throw new RangeError("Signed wavevector projection requires every point's published k vector");
  }
  const component = COMPONENT_AXES.indexOf(axis as typeof COMPONENT_AXES[number]);
  return series.map((entry) => ({
    ...entry, xAxisLabel: DISPERSION_AXIS_LABELS[axis],
    showSymbols: entry.quantity === "frequency",
    points: entry.points.map((point) => ({
      ...point,
      x: axis === "path" ? point.x : point.wavevectorRadPerM![component]!,
      selected: selectedPoint?.seriesId === entry.id && selectedPoint.point.rowIndex === point.rowIndex,
    })),
  }));
}
