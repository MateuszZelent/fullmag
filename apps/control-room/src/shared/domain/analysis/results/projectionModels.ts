import type {
  AnalysisResultProjectionResource,
  AnalysisResultProjectionSelectionEntry,
  AnalysisResultProductKind,
} from "./types";
import type { ChartSeries } from "../chartSeries";

const MAX_RESULT_PROJECTION_POINTS = 5_000;

export interface AnalysisResultProjectionChartModel {
  series: readonly ChartSeries[];
  selectionBySeriesId: Readonly<Record<string, readonly AnalysisResultProjectionSelectionEntry[]>>;
}

export function buildAnalysisResultProjectionChartModel(
  resource: AnalysisResultProjectionResource | null | undefined,
  productKind: AnalysisResultProductKind | null = null,
): AnalysisResultProjectionChartModel {
  if (!resource) return { series: [], selectionBySeriesId: {} };

  const selectionByOrdinal = new Map(
    resource.selection_index.map((entry) => [entry.ordinal, entry]),
  );
  const selectionBySeriesId: Record<
    string,
    readonly AnalysisResultProjectionSelectionEntry[]
  > = {};
  const sourceKind =
    productKind === "time_domain_spectrum" ||
    productKind === "dynamic_structure_factor"
      ? "analysis.spin_wave"
      : "analysis.frequency_domain";
  const series = resource.series.map((sourceSeries) => {
    const seriesId = `${resource.projection_id}:${sourceSeries.series_id}`;
    const visiblePoints = boundedProjectionPoints(sourceSeries.points);
    selectionBySeriesId[seriesId] = visiblePoints.flatMap((point) => {
      const selection = selectionByOrdinal.get(point.ordinal);
      return selection ? [selection] : [];
    });
    return {
      dataRevision: resource.projection_revision,
      id: seriesId,
      label: sourceSeries.label,
      points: visiblePoints.map((point) => ({
        label: point.item_id ?? point.sample_id ?? `point ${point.ordinal}`,
        rowIndex: point.ordinal,
        x: point.x ?? Number.NaN,
        y: point.y ?? point.value ?? Number.NaN,
      })),
      quantity: resource.axis_labels.y ?? resource.axis_mapping.y ?? "result",
      source: {
        kind: sourceKind,
        resourceKey: `analysis:results:${resource.run_id}:${resource.dataset_id}:${resource.projection_id}`,
        tableId: seriesId,
      },
      sourceIdentity: {
        artifactPath: null,
        backend: null,
        contentDigest: resource.projection_revision,
        device: null,
        precision: null,
        provenance: `analysis-result-projection:${productKind ?? "frequency_domain"}`,
        qualification: resource.status.qualification,
        runId: resource.run_id,
        schemaVersion: resource.schema_version,
        stageId: null,
      },
      status: projectionStatus(resource),
      unit: resource.axis_units.y ?? "unknown",
      xUnit: resource.axis_units.x ?? "unknown",
    } satisfies ChartSeries;
  });

  return { selectionBySeriesId, series };
}

function boundedProjectionPoints(
  points: readonly AnalysisResultProjectionResource["series"][number]["points"][number][],
) {
  if (points.length <= MAX_RESULT_PROJECTION_POINTS) return points;
  const stride = (points.length - 1) / (MAX_RESULT_PROJECTION_POINTS - 1);
  return Array.from({ length: MAX_RESULT_PROJECTION_POINTS }, (_, index) =>
    points[Math.round(index * stride)]!,
  );
}

function projectionStatus(
  resource: AnalysisResultProjectionResource,
): "idle" | "loading" | "ready" | "stale" | "error" {
  if (resource.unsupported_reason) return "stale";
  switch (resource.status.completeness) {
    case "ready":
    case "complete":
      return "ready";
    case "stale":
      return "stale";
    case "error":
    case "corrupt":
      return "error";
    default:
      return "stale";
  }
}
