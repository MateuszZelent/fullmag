import type { ChartRenderModel } from "./chartRenderer";

export type ChartExportFormat = "csv" | "tsv";

export interface ChartExportProvenance {
  dataRevision: string | number | null;
  decimation: string;
  descriptorId: string;
  exportedAt: string;
  query: string;
  resourceKey: string;
  schemaVersion: 1;
  status: ChartRenderModel["status"];
}

export function chartExportProvenance(
  model: ChartRenderModel,
  exportedAt = new Date().toISOString(),
): ChartExportProvenance {
  return {
    dataRevision: model.provenance?.dataRevision ?? null,
    decimation: model.provenance?.decimation ?? "unknown",
    descriptorId: model.key,
    exportedAt,
    query: model.provenance?.query ?? model.key,
    resourceKey: model.provenance?.resourceKey ?? "unknown",
    schemaVersion: 1,
    status: model.status,
  };
}

export function serializeChartData(
  model: ChartRenderModel,
  format: ChartExportFormat,
): string {
  const delimiter = format === "csv" ? "," : "\t";
  const rows = [["series_id", "row_id", "x", "y", "x_unit", "y_unit"]];
  for (const series of model.series) {
    for (const point of series.points) {
      rows.push([
        series.id,
        String(point.rowIndex),
        roundTripNumber(point.x),
        roundTripNumber(point.y),
        model.xAxis.unit,
        series.unit,
      ]);
    }
  }
  return rows
    .map((row) => row.map((value) => quoteCell(value, delimiter)).join(delimiter))
    .join("\n");
}

export function safeChartExportFilename(
  model: ChartRenderModel,
  extension: string,
): string {
  const stem = model.ariaLabel
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
  queueMicrotask(() => URL.revokeObjectURL(url));
}

function roundTripNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  return String(value);
}

function quoteCell(value: string, delimiter: string): string {
  if (!value.includes(delimiter) && !/[\n\r"]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}
