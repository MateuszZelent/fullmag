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
    expect(csv).toContain('"e,total",3,1e-9,-2.5e-18,s,J');
    const tsv = serializeChartData(model, "tsv");
    expect(Number(tsv.split("\n")[1]!.split("\t")[3])).toBe(-2.5e-18);
  });

  it("embeds identity, revision, query, decimation, status and timestamp", () => {
    expect(chartExportProvenance(model, "2026-07-26T00:00:00.000Z")).toEqual({
      dataRevision: 7,
      decimation: "minmax_lttb",
      descriptorId: "energy@7",
      exportedAt: "2026-07-26T00:00:00.000Z",
      query: "limit=5000",
      resourceKey: "solver/energies",
      schemaVersion: 1,
      status: "degraded",
    });
    expect(safeChartExportFilename(model, "csv")).toBe("energy-total.csv");
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
