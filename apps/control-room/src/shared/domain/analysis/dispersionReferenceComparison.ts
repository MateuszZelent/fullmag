import type { ChartSeries } from "./chartSeries";

/** A descriptive frequency comparison, never a solver qualification or a branch match. */
export function dispersionReferenceComparisons(series: readonly ChartSeries[]) {
  const computed = series.filter((entry) => entry.quantity === "frequency");
  return series.filter((entry) => entry.quantity === "reference_frequency").flatMap((reference) => {
    const nodes = [...reference.points].sort((a, b) => (a.pathS ?? a.x) - (b.pathS ?? b.x));
    if (nodes.some((point, index) => index > 0 && (point.pathS ?? point.x) === (nodes[index - 1]!.pathS ?? nodes[index - 1]!.x))) return [];
    const rows = computed.filter((entry) => entry.unit === reference.unit).flatMap((entry) => entry.points.flatMap((point) => {
      const path = point.pathS ?? point.x;
      let low = 0, high = nodes.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if ((nodes[mid]!.pathS ?? nodes[mid]!.x) < path) low = mid + 1;
        else high = mid;
      }
      const right = nodes[low], left = nodes[low - 1];
      let frequency: number | null = null;
      if (right && (right.pathS ?? right.x) === path) frequency = right.y;
      else if (left && right && !right.breakBefore) {
        const a = left.pathS ?? left.x, b = right.pathS ?? right.x;
        frequency = left.y + (path - a) / (b - a) * (right.y - left.y);
      }
      if (frequency == null || !Number.isFinite(frequency) || frequency <= 0 || !Number.isFinite(point.y)) return [];
      return [{ seriesId: entry.id, rowIndex: point.rowIndex, sampleIndex: point.sampleIndex,
        relativeErrorPercent: 100 * (point.y / frequency - 1), referenceFrequency: frequency,
        computedFrequency: point.y, unit: entry.unit }];
    }));
    return rows.length ? [{ id: reference.id, label: reference.label, rows,
      maximumAbsoluteErrorPercent: rows.reduce((maximum, row) => Math.max(maximum, Math.abs(row.relativeErrorPercent)), 0) }] : [];
  });
}
