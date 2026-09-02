import type {
  ChartRenderModel,
  ChartRenderResultCoordinate,
  ChartRenderResultSelectionRef,
} from "./chartRenderer";
import type { ChartScientificTrust } from "./chartScientificTrust";
import {
  chartValueExtrema,
  createChartDisplayTransform,
  createChartYAxisDisplayTransforms,
} from "./chartScalePolicy";

export type ChartExportFormat = "csv" | "tsv";

export interface ChartExportProvenance {
  artifactPath: string | null;
  backend: string | null;
  canonicalUnits: { x: string; y: string[] };
  contentDigest: string | null;
  dataRevision: string | number | null;
  decimation: string;
  datasetId?: string | null;
  datasetRevision?: string | null;
  descriptorId: string;
  device: string | null;
  displayUnits: Record<string, string>;
  exportedAt: string;
  fixedCoordinates?: readonly ChartRenderResultCoordinate[];
  precision: string | null;
  projectionId?: string | null;
  projectionRevision?: string | null;
  provenance: string | null;
  qualification: string;
  query: string;
  resourceKey: string;
  runId: string | null;
  schemaVersion: 1;
  selectionRefs?: readonly ChartRenderResultSelectionRef[];
  sourceSchemaVersion: string | null;
  sessionId: string | null;
  status: ChartRenderModel["status"];
  stageId: string | null;
  scientificTrust: ChartScientificTrust;
}

export function chartExportProvenance(
  model: ChartRenderModel,
  exportedAt = new Date().toISOString(),
): ChartExportProvenance {
  const resultContext = model.provenance?.datasetId != null ||
    model.provenance?.projectionId != null
    ? {
        ...(model.provenance?.datasetId != null
          ? { datasetId: model.provenance.datasetId }
          : {}),
        ...(model.provenance?.datasetRevision != null
          ? { datasetRevision: model.provenance.datasetRevision }
          : {}),
        ...(model.provenance?.fixedCoordinates
          ? { fixedCoordinates: model.provenance.fixedCoordinates }
          : {}),
        ...(model.provenance?.projectionId != null
          ? { projectionId: model.provenance.projectionId }
          : {}),
        ...(model.provenance?.projectionRevision != null
          ? { projectionRevision: model.provenance.projectionRevision }
          : {}),
        ...(model.provenance?.selectionRefs
          ? { selectionRefs: model.provenance.selectionRefs }
          : {}),
      }
    : {};
  return {
    artifactPath: model.provenance?.artifactPath ?? null,
    dataRevision: model.provenance?.dataRevision ?? null,
    decimation: model.provenance?.decimation ?? "unknown",
    descriptorId: model.provenance?.descriptorId ?? model.key,
    backend: model.provenance?.backend ?? null,
    canonicalUnits: {
      x: model.xAxis.unit,
      y: model.series.map((series) => series.unit),
    },
    contentDigest: model.provenance?.contentDigest ?? null,
    device: model.provenance?.device ?? null,
    displayUnits: resolvedDisplayUnits(model),
    exportedAt,
    ...resultContext,
    precision: model.provenance?.precision ?? null,
    provenance: model.provenance?.provenance ?? null,
    qualification: model.provenance?.qualification ?? "unknown",
    query: model.provenance?.query ?? model.key,
    resourceKey: model.provenance?.resourceKey ?? "unknown",
    runId: model.provenance?.runId ?? null,
    schemaVersion: 1,
    sourceSchemaVersion: model.provenance?.schemaVersion ?? null,
    sessionId: model.provenance?.sessionId ?? null,
    status: model.status,
    scientificTrust: model.provenance?.scientificTrust ?? "unknown",
    stageId: model.provenance?.stageId ?? null,
  };
}

function resolvedDisplayUnits(model: ChartRenderModel): Record<string, string> {
  const supplied = model.provenance?.displayUnits;
  const yTransforms = createChartYAxisDisplayTransforms(model.yAxes, model.series);
  return {
    x: createChartDisplayTransform(
      model.xAxis.unit,
      chartValueExtrema(iterateXValues(model)),
    ).displayUnit,
    ...Object.fromEntries(model.series.map((series) => [
      `y:${series.id}`,
      (yTransforms[series.yAxis] ??
        createChartDisplayTransform(series.unit, null)).displayUnit,
    ])),
    ...supplied,
  };
}

function* iterateXValues(model: ChartRenderModel): Iterable<number> {
  for (const series of model.series) {
    for (const point of series.points) yield point.x;
  }
}

export function serializeChartData(
  model: ChartRenderModel,
  format: ChartExportFormat,
): string {
  const delimiter = format === "csv" ? "," : "\t";
  const rows: string[][] = [];
  const hasResultContext = model.provenance?.datasetId != null ||
    model.provenance?.projectionId != null;

  // Warning header for stale/degraded data — alerts user in the file itself
  if (model.status === "stale" || model.status === "degraded") {
    rows.push([
      `# WARNING: data status is ${model.status} — values may not reflect the latest revision`,
    ]);
  }

  rows.push([
    "series_id",
    "row_id",
    "x",
    "y",
    "x_unit",
    "y_unit",
    "data_revision",
    "decimation",
    ...(hasResultContext
      ? [
          "dataset_id",
          "dataset_revision",
          "projection_id",
          "projection_revision",
          "sample_id",
          "item_id",
          "branch_id",
          "coordinate_tokens",
        ]
      : []),
  ]);

  const rev = String(model.provenance?.dataRevision ?? "");
  const decimation = model.provenance?.decimation ?? "unknown";

  for (const series of model.series) {
    for (const point of series.points) {
      rows.push([
        quoteStringCell(series.id, delimiter),
        String(point.rowIndex),
        roundTripNumber(point.x),
        roundTripNumber(point.y),
        quoteStringCell(model.xAxis.unit, delimiter),
        quoteStringCell(series.unit, delimiter),
        quoteStringCell(rev, delimiter),
        quoteStringCell(decimation, delimiter),
        ...(hasResultContext
          ? [
              quoteStringCell(model.provenance?.datasetId ?? "", delimiter),
              quoteStringCell(model.provenance?.datasetRevision ?? "", delimiter),
              quoteStringCell(model.provenance?.projectionId ?? "", delimiter),
              quoteStringCell(model.provenance?.projectionRevision ?? "", delimiter),
              quoteStringCell(point.sampleId ?? "", delimiter),
              quoteStringCell(point.itemId ?? "", delimiter),
              quoteStringCell(point.branchId ?? "", delimiter),
              quoteStringCell(
                fixedCoordinateTokens(model.provenance?.fixedCoordinates),
                delimiter,
              ),
            ]
          : []),
      ]);
    }
  }

  return rows
    .map((row) => row.join(delimiter))
    .join("\n");
}

function fixedCoordinateTokens(
  coordinates: readonly ChartRenderResultCoordinate[] | undefined,
): string {
  return (coordinates ?? [])
    .map((coordinate) => `${coordinate.axisId}=${coordinate.token}`)
    .join("|");
}

export function safeChartExportFilename(
  model: ChartRenderModel,
  extension: string,
): string {
  const stem =
    model.ariaLabel
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "analysis-chart";
  return `${stem}.${extension.replace(/^\./, "")}`;
}

export function downloadChartBlob({
  content,
  filename,
  mimeType,
}: {
  content: BlobPart;
  filename: string;
  mimeType: string;
}): void {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.download = filename;
  anchor.href = url;
  anchor.click();
  // Revoke after current event loop to ensure download started
  queueMicrotask(() => URL.revokeObjectURL(url));
}

function roundTripNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  return String(value);
}

/**
 * Quote a string cell for CSV/TSV output, with CSV injection protection.
 *
 * Security: strips leading formula-trigger characters (=, +, -, @, |, %)
 * that cause formula injection in spreadsheet applications when untrusted
 * string content (series IDs, labels, units) is included.
 *
 * Only use for string-typed cells. Never apply to numeric output.
 */
function quoteStringCell(value: string, delimiter: string): string {
  let safe = value;
  // Neutralize formula injection triggers by prepending a single-quote.
  // This is the recommended spreadsheet-safe mitigation for OWASP CSV injection.
  if (/^[=+\-@|%]/.test(safe)) {
    safe = `'${safe}`;
  }
  if (!safe.includes(delimiter) && !/[\n\r"]/.test(safe)) return safe;
  return `"${safe.replaceAll('"', '""')}"`;
}
