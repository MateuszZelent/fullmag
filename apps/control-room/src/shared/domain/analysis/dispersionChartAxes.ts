import type { ChartSeries } from "./chartSeries";

export type DispersionAxis = "path" | "kx" | "ky" | "kz";

export const DISPERSION_AXIS_LABELS: Readonly<Record<DispersionAxis, string>> = {
  path: "k-path distance s",
  kx: "kₓ",
  ky: "kᵧ",
  kz: "k_z",
};

const COMPONENT_AXES = ["kx", "ky", "kz"] as const;

/** Signed components are available only when every chart point carries its published k vector. */
export function availableDispersionAxes(
  series: readonly ChartSeries[],
): DispersionAxis[] {
  let pointCount = 0;
  for (const entry of series) {
    if (entry.hasCompleteWavevectorKf === false) return ["path"];
    for (const point of entry.points) {
      pointCount += 1;
      if (!isFiniteWavevector(point.wavevectorKf)) return ["path"];
    }
  }
  return pointCount > 0 ? ["path", ...COMPONENT_AXES] : ["path"];
}

/** Select the only varying component automatically; keep multi-axis paths on path distance. */
export function defaultDispersionAxis(
  series: readonly ChartSeries[],
): DispersionAxis {
  if (availableDispersionAxes(series).length === 1) return "path";
  const values = COMPONENT_AXES.map(() => new Set<number>());
  for (const entry of series) {
    for (const point of entry.points) {
      point.wavevectorKf!.forEach((value, index) => values[index]?.add(value));
    }
  }
  const varying = COMPONENT_AXES.filter((_, index) => values[index]!.size > 1);
  return varying.length === 1 ? varying[0]! : "path";
}

/** Project x without sorting, filtering, or changing the source row identity. */
export function projectDispersionSeries(
  series: readonly ChartSeries[],
  axis: DispersionAxis,
): ChartSeries[] {
  if (!availableDispersionAxes(series).includes(axis)) {
    throw new RangeError("Signed wavevector projection requires each point's published k vector");
  }
  const component = COMPONENT_AXES.indexOf(axis as typeof COMPONENT_AXES[number]);
  return series.map((entry) => ({
    ...entry,
    points: entry.points.map((point) => ({
      ...point,
      x: axis === "path" ? point.pathS ?? point.x : point.wavevectorKf![component]!,
    })),
  }));
}

function isFiniteWavevector(
  wavevector: readonly [number, number, number] | null | undefined,
): wavevector is readonly [number, number, number] {
  return wavevector != null && wavevector.length === 3 && wavevector.every(Number.isFinite);
}
