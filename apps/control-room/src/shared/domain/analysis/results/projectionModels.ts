import type { components } from "@/kernel/api/generated/openapi-v2-types";
import type { ChartSeries } from "../chartSeries";
import type {
  AnalysisResultDatasetManifestResource,
  AnalysisResultProjectionResource,
  AnalysisResultProjectionSelectionEntry,
  AnalysisResultProductKind,
} from "./types";

const MAX_RESULT_PROJECTION_POINTS = 5_000;

export type AnalysisResultSpectrumOutputScope =
  components["schemas"]["AnalysisResultSpectrumOutputScope"];

export interface AnalysisResultProjectionScopeView {
  kind: "unknown" | "none" | "global" | "per_sample";
  sampleId: string | null;
}

export interface AnalysisResultProjectionChartOptions {
  requestedSpectrumOutputScopes?: readonly AnalysisResultSpectrumOutputScope[] | null;
  selectedSampleId?: string | null;
  selectedSpectrumOutputScope?: AnalysisResultSpectrumOutputScope | null;
}

export interface AnalysisResultProjectionChartModel {
  exportSeries?: readonly ChartSeries[];
  requestedSpectrumOutputScopes?: readonly AnalysisResultSpectrumOutputScope[] | null;
  series: readonly ChartSeries[];
  selectionBySeriesId: Readonly<Record<string, readonly AnalysisResultProjectionSelectionEntry[]>>;
  scopeView?: AnalysisResultProjectionScopeView;
}

/** Missing or malformed scope metadata stays unknown; an explicit empty array stays empty. */
export function analysisResultSpectrumOutputScopes(
  manifest: AnalysisResultDatasetManifestResource | null | undefined,
): readonly AnalysisResultSpectrumOutputScope[] | null {
  const candidate = manifest?.spectrum_output_scopes;
  if (
    !Array.isArray(candidate) ||
    !candidate.every((scope) => scope === "per_sample" || scope === "global")
  ) {
    return null;
  }
  return candidate;
}

export function buildAnalysisResultProjectionChartModel(
  resource: AnalysisResultProjectionResource | null | undefined,
  productKind: AnalysisResultProductKind | null = null,
  options: AnalysisResultProjectionChartOptions = {},
): AnalysisResultProjectionChartModel {
  const requestedSpectrumOutputScopes =
    productKind === "modal_eigen"
      ? options.requestedSpectrumOutputScopes ?? null
      : null;
  const scopeView = projectionScopeView(
    requestedSpectrumOutputScopes,
    options.selectedSampleId ?? null,
    options.selectedSpectrumOutputScope ?? null,
  );
  if (!resource) {
    return {
      exportSeries: [],
      requestedSpectrumOutputScopes,
      series: [],
      selectionBySeriesId: {},
      scopeView,
    };
  }

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
  const scopedSeries = resource.series.map((sourceSeries) => {
    const seriesId = `${resource.projection_id}:${sourceSeries.series_id}`;
    const completePoints = projectionPointsForScope(
      sourceSeries.points,
      selectionByOrdinal,
      scopeView,
    );
    const visiblePoints = boundedProjectionPoints(completePoints);
    selectionBySeriesId[seriesId] = visiblePoints.flatMap((point) => {
      const selection = selectionByOrdinal.get(point.ordinal);
      return selection ? [selection] : [];
    });
    const createSeries = (points: readonly AnalysisResultProjectionResource["series"][number]["points"][number][]): ChartSeries => ({
      dataRevision: resource.projection_revision,
      id: seriesId,
      label: sourceSeries.label,
      points: points.map((point) => {
        const selection = selectionByOrdinal.get(point.ordinal);
        const itemId = selection?.item_id ?? point.item_id ?? null;
        const sampleId = selection?.sample_id ?? point.sample_id ?? null;
        return {
          branchId: projectionPointIsGap(point)
            ? selection?.branch_id ?? null
            : selection?.branch_id ?? point.branch_id ?? null,
          itemId,
          label: itemId ?? sampleId ?? `point ${point.ordinal}`,
          rowIndex: point.ordinal,
          sampleId,
          x: point.x ?? Number.NaN,
          y: point.y ?? point.value ?? Number.NaN,
        };
      }),
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
    });
    return {
      export: createSeries(completePoints),
      visible: createSeries(visiblePoints),
    };
  });

  return {
    exportSeries: scopedSeries.map((entry) => entry.export),
    requestedSpectrumOutputScopes,
    series: scopedSeries.map((entry) => entry.visible),
    selectionBySeriesId,
    scopeView,
  };
}

function projectionScopeView(
  requestedScopes: readonly AnalysisResultSpectrumOutputScope[] | null,
  selectedSampleId: string | null,
  selectedSpectrumOutputScope: AnalysisResultSpectrumOutputScope | null,
): AnalysisResultProjectionScopeView {
  if (requestedScopes === null) return { kind: "unknown", sampleId: null };
  if (requestedScopes.length === 0) return { kind: "none", sampleId: null };
  if (selectedSpectrumOutputScope && requestedScopes.includes(selectedSpectrumOutputScope)) {
    return selectedSpectrumOutputScope === "per_sample"
      ? { kind: "per_sample", sampleId: selectedSampleId }
      : { kind: "global", sampleId: null };
  }
  if (selectedSampleId && requestedScopes.includes("per_sample")) {
    return { kind: "per_sample", sampleId: selectedSampleId };
  }
  if (requestedScopes.includes("global")) return { kind: "global", sampleId: null };
  if (requestedScopes.includes("per_sample")) {
    return { kind: "per_sample", sampleId: null };
  }
  return { kind: "unknown", sampleId: null };
}

function projectionPointsForScope(
  points: AnalysisResultProjectionResource["series"][number]["points"],
  selectionByOrdinal: ReadonlyMap<number, AnalysisResultProjectionSelectionEntry>,
  scopeView: AnalysisResultProjectionScopeView,
) {
  if (scopeView.kind === "none") return [];
  if (scopeView.kind === "per_sample") {
    if (!scopeView.sampleId) return [];
    return points.filter((point) => {
      const sampleId =
        selectionByOrdinal.get(point.ordinal)?.sample_id ?? point.sample_id ?? null;
      return sampleId === scopeView.sampleId;
    });
  }
  return points;
}

function boundedProjectionPoints(
  points: readonly AnalysisResultProjectionResource["series"][number]["points"][number][],
) {
  if (points.length <= MAX_RESULT_PROJECTION_POINTS) return points;

  const gapIndices = points.reduce<number[]>((indices, point, index) => {
    if (projectionPointIsGap(point)) indices.push(index);
    return indices;
  }, []);
  if (gapIndices.length >= MAX_RESULT_PROJECTION_POINTS) {
    return gapIndices
      .slice(0, MAX_RESULT_PROJECTION_POINTS)
      .map((index) => points[index]!);
  }

  const selectedIndices = new Set(gapIndices);
  const validPointCount = points.length - gapIndices.length;
  const remainingPointCount = MAX_RESULT_PROJECTION_POINTS - gapIndices.length;
  if (validPointCount <= remainingPointCount) {
    return points;
  }

  const stride =
    remainingPointCount === 1
      ? 0
      : (validPointCount - 1) / (remainingPointCount - 1);
  const selectedRanks = new Set(
    Array.from({ length: remainingPointCount }, (_, rank) =>
      Math.round(rank * stride),
    ),
  );
  let validRank = 0;
  points.forEach((point, index) => {
    if (projectionPointIsGap(point)) return;
    if (selectedRanks.has(validRank)) selectedIndices.add(index);
    validRank += 1;
  });

  return points.filter((_, index) => selectedIndices.has(index));
}

function projectionPointIsGap(
  point: AnalysisResultProjectionResource["series"][number]["points"][number],
): boolean {
  const x = point.x;
  const y = point.y ?? point.value;
  return (
    point.status === "gap" ||
    x == null ||
    y == null ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
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
