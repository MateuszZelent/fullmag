import type { PostprocessingDefinition } from "@/kernel/api/apiTypes";
import { importedReferencePoints } from "@/kernel/analysis-modules/postprocessingDefinitions";
import type { ChartSeries } from "@/shared/domain/analysis/chartSeries";

const FREQUENCY_DIVISORS: Readonly<Record<string, number>> = {
  GHz: 1e9,
  Hz: 1,
  MHz: 1e6,
  THz: 1e12,
  kHz: 1e3,
};

/**
 * Overlay series for imported references saved as postprocessing definitions
 * (ADR 0054, spec 32 §9). They share the computed series' frequency unit and
 * path axis, and carry `reference_frequency`, so their points never select a
 * computed mode. Only references of the shown run, stage and published revision are drawn.
 */
/** Explicit published dataset fence; CSV content digests are separate identities. */
export function publishedReferenceDatasetRevision(
  payload: Record<string, unknown> | null | undefined,
): string | null {
  const revision = payload?.revision;
  return typeof revision === "string" && revision.trim().length > 0 ? revision : null;
}

export function referenceOverlaySeries(
  computed: readonly ChartSeries[],
  definitions: readonly PostprocessingDefinition[],
  identity: { artifactRevision: number | string | null; runId: string | null; stageId: string | null },
): ChartSeries[] {
  const template = computed[0];
  const divisor = template ? FREQUENCY_DIVISORS[template.unit] : undefined;
  if (!template || !divisor || !identity.runId || !identity.stageId || identity.artifactRevision === null) return [];
  const wavevectorAtPath = publishedWavevectorInterpolator(computed);
  return definitions.flatMap((definition): ChartSeries[] => {
    if (
      definition.module_id !== "analysis.dispersion" ||
      definition.data_ref.run_id !== identity.runId ||
      definition.data_ref.dataset_id !== identity.stageId ||
      definition.data_ref.dataset_revision !== String(identity.artifactRevision)
    ) {
      return [];
    }
    const points = importedReferencePoints(definition);
    if (!points) return [];
    return [
      {
        id: `analysis.reference:${definition.definition_id}`,
        kind: "line",
        label: `${definition.label} (reference)`,
        points: points.map(([path, frequency], rowIndex) => ({
          rowIndex,
          pathS: path,
          wavevectorKf: wavevectorAtPath(path),
          x: path,
          y: frequency / divisor,
        })),
        quantity: "reference_frequency",
        source: template.source,
        status: "ready",
        unit: template.unit,
        xUnit: "rad/m",
      },
    ];
  });
}

/** Interpolate only a uniquely published straight segment; no extrapolation across bends or gaps. */
export function publishedWavevectorInterpolator(series: readonly ChartSeries[]) {
  type Vector = readonly [number, number, number];
  const samples = new Map<number, Vector>();
  const segmentStarts = new Set<number>();
  let invalid = false;
  for (const entry of series) {
    if (entry.hasCompleteWavevectorKf === false) invalid = true;
    for (const point of entry.points) {
      const path = point.pathS;
      const vector = point.wavevectorKf;
      if (path == null || !Number.isFinite(path) || !vector || !vector.every(Number.isFinite)) {
        invalid = true;
        continue;
      }
      const previous = samples.get(path);
      if (previous && previous.some((value, index) => value !== vector[index])) invalid = true;
      samples.set(path, vector);
      if (point.breakBefore) segmentStarts.add(path);
    }
  }
  const nodes = [...samples].sort(([a], [b]) => a - b);
  return (path: number): Vector | null => {
    if (invalid || !Number.isFinite(path)) return null;
    const exact = samples.get(path);
    if (exact) return exact;
    // Binary search preserves bounded work for dense imported reference curves.
    let low = 0, high = nodes.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (nodes[mid]![0] < path) low = mid + 1;
      else high = mid;
    }
    const left = nodes[low - 1], right = nodes[low];
    if (!left || !right || segmentStarts.has(right[0])) return null;
    const distance = right[0] - left[0];
    const chord = Math.hypot(...right[1].map((value, index) => value - left[1][index]!));
    if (Math.abs(distance - chord) > 1e-9 * Math.max(distance, chord, 1)) return null;
    const t = (path - left[0]) / distance;
    return [0, 1, 2].map((index) => left[1][index]! + t * (right[1][index]! - left[1][index]!)) as [number, number, number];
  };
}
