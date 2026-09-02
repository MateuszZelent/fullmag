import { describe, expect, it, vi } from "vitest";
import { chartExportProvenance, downloadChartBlob, safeChartExportFilename, serializeChartData } from "./chartExport";
import type { ChartRenderModel } from "./chartRenderer";

const model: ChartRenderModel = {
  ariaLabel: "Energy / total",
  key: "energy@7",
  provenance: {
    artifactPath: "analysis/energies.json",
    contentDigest: "sha256:abc",
    dataRevision: 7,
    decimation: "minmax_lttb",
    query: "limit=5000",
    qualification: "unknown",
    resourceKey: "solver/energies",
    schemaVersion: "energies.v1",
  },
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
      artifactPath: "analysis/energies.json",
      canonicalUnits: { x: "s", y: ["J"] },
      contentDigest: "sha256:abc",
      dataRevision: 7,
      decimation: "minmax_lttb",
      descriptorId: "energy@7",
      device: null,
      displayUnits: { x: "ns", "y:e,total": "pJ" },
      exportedAt: "2026-07-26T00:00:00.000Z",
      precision: null,
      provenance: null,
      qualification: "unknown",
      query: "limit=5000",
      resourceKey: "solver/energies",
      runId: null,
      schemaVersion: 1,
      sourceSchemaVersion: "energies.v1",
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

  it("fills deterministic display units around a partial caller override", () => {
    const partialOverride: ChartRenderModel = {
      ...model,
      provenance: { ...model.provenance!, displayUnits: { "y:e,total": "fJ" } },
    };

    expect(chartExportProvenance(partialOverride).displayUnits).toEqual({
      x: "ns",
      "y:e,total": "fJ",
    });
  });

  it("exports result projection identity, fixed coordinates, and point selections", () => {
    const resultModel: ChartRenderModel = {
      ...model,
      key: "result:dataset-1:response-spectrum",
      provenance: {
        ...model.provenance!,
        datasetId: "dataset-1",
        datasetRevision: "dataset-revision-1",
        fixedCoordinates: [
          {
            axisId: "bias-field",
            label: "mu0 Hx = 75 mT",
            scalarSI: 0.075,
            token: "bias:75mT",
            vector3SI: null,
          },
        ],
        projectionId: "response-spectrum",
        projectionRevision: "projection-revision-1",
        runId: "run-1",
        selectionRefs: [
          {
            branchId: "branch-1",
            itemId: "item-1",
            ordinal: 3,
            sampleId: "sample-1",
          },
        ],
        stageId: "stage-1",
      },
      series: [{
        ...model.series[0]!,
        points: [{
          ...model.series[0]!.points[0]!,
          branchId: "branch-1",
          itemId: "item-1",
          sampleId: "sample-1",
        }],
      }],
    };

    expect(chartExportProvenance(resultModel, "2026-07-26T00:00:00.000Z")).toMatchObject({
      datasetId: "dataset-1",
      datasetRevision: "dataset-revision-1",
      fixedCoordinates: [{ axisId: "bias-field", token: "bias:75mT" }],
      projectionId: "response-spectrum",
      projectionRevision: "projection-revision-1",
      runId: "run-1",
      selectionRefs: [{ branchId: "branch-1", itemId: "item-1", ordinal: 3, sampleId: "sample-1" }],
      stageId: "stage-1",
    });

    const csv = serializeChartData(resultModel, "csv");
    expect(csv).toContain(
      "series_id,row_id,x,y,x_unit,y_unit,data_revision,decimation,dataset_id,dataset_revision,projection_id,projection_revision,sample_id,item_id,branch_id,coordinate_tokens",
    );
    expect(csv).toContain(
      '"e,total",3,1e-9,-2.5e-18,s,J,7,minmax_lttb,dataset-1,dataset-revision-1,response-spectrum,projection-revision-1,sample-1,item-1,branch-1,bias-field=bias:75mT',
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
