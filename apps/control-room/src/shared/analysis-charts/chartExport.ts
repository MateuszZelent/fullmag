import type { ChartRenderModel } from "./chartRenderer";
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
  descriptorId: string;
  device: string | null;
  displayUnits: Record<string, string>;
  exportedAt: string;
  precision: string | null;
  provenance: string | null;
  qualification: string;
  query: string;
  resourceKey: string;
  runId: string | null;
  schemaVersion: 1;
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
      ]);
    }
  }

  return rows
    .map((row) => row.join(delimiter))
    .join("\n");
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
