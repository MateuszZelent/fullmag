import { describe, expect, it, vi } from "vitest";
import { chartExportProvenance, downloadChartBlob, safeChartExportFilename, serializeChartData } from "./chartExport";
import type { ChartRenderModel } from "./chartRenderer";

const model: ChartRenderModel = {
  ariaLabel: "Energy / total",
  key: "energy@7",
  provenance: { dataRevision: 7, decimation: "minmax_lttb", query: "limit=5000", resourceKey: "solver/energies" },
  series: [{ id: "e,total", kind: "line", label: "Total", points: [{ rowIndex: 3, x: 1e-9, y: -2.5e-18 }], unit: "J", yAxis: 0 }],
  status: "degraded",
  xAxis: { label: "time [s]", unit: "s" },
  yAxes: [{ label: "energy [J]", unit: "J" }],
};

describe("chart export", () => {
  it("round-trips numeric data and escapes CSV cells", () => {
    const csv = serializeChartData(model, "csv");
    // Warning header row is present for degraded status
    expect(csv).toContain("# WARNING: data status is degraded");
    // Data row: series ID "e,total" is quoted because it contains the comma delimiter
    // Negative numeric values are NOT injection-protected (they are numeric, safe)
    expect(csv).toContain('"e,total",3,1e-9,-2.5e-18,s,J,7,minmax_lttb');
    const tsv = serializeChartData(model, "tsv");
    // For TSV: series ID does NOT need quoting (no tab in "e,total")
    // Data row is at index 2 (warning + header before it)
    const tsvDataRow = tsv.split("\n").find((line) => line.startsWith("e,total"));
    expect(Number(tsvDataRow!.split("\t")[3])).toBe(-2.5e-18);
  });

  it("embeds identity, revision, query, decimation, status and timestamp", () => {
    expect(chartExportProvenance(model, "2026-07-26T00:00:00.000Z")).toEqual({
      backend: null,
      canonicalUnits: { x: "s", y: ["J"] },
      dataRevision: 7,
      decimation: "minmax_lttb",
      descriptorId: "energy@7",
      device: null,
      displayUnits: { x: "ns", "y:e,total": "pJ" },
      exportedAt: "2026-07-26T00:00:00.000Z",
      precision: null,
      query: "limit=5000",
      resourceKey: "solver/energies",
      runId: null,
      schemaVersion: 1,
      sessionId: null,
      status: "degraded",
      stageId: null,
      scientificTrust: "unknown",
    });
    expect(safeChartExportFilename(model, "csv")).toBe("energy-total.csv");
  });

  it("records resolved display units while retaining canonical CSV values", () => {
    const normalizedModel: ChartRenderModel = {
      ...model,
      series: [{
        id: "my",
        kind: "line",
        label: "my",
        points: [{ rowIndex: 3, x: 1e-9, y: 0.10317 }],
        unit: "1",
        yAxis: 0,
      }],
      yAxes: [{ label: "Normalized magnetization m", unit: "1" }],
    };

    expect(chartExportProvenance(normalizedModel, "2026-07-26T00:00:00.000Z").displayUnits).toEqual({
      x: "ns",
      "y:my": "",
    });
    expect(serializeChartData(normalizedModel, "csv")).toContain(
      "my,3,1e-9,0.10317,s,1,7,minmax_lttb",
    );
  });

  it("revokes object URLs after initiating a download", async () => {
    const click = vi.fn();
    vi.stubGlobal("document", { createElement: () => ({ click, download: "", href: "" }) });
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:chart"), revokeObjectURL: vi.fn() });
    downloadChartBlob({ content: "x", filename: "x.csv", mimeType: "text/csv" });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(click).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:chart");
    vi.unstubAllGlobals();
  });
});
