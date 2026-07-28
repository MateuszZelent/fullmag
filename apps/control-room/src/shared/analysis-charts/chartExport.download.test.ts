import { describe, expect, it } from "vitest";

import {
  chartExportProvenance,
  safeChartExportFilename,
  serializeChartData,
  type ChartExportProvenance,
} from "./chartExport";
import type { ChartRenderModel } from "./chartRenderer";

describe("chartExport", () => {
  const dummyModel: ChartRenderModel = {
    ariaLabel: "Magnetization vs Time",
    key: "mag-chart",
    provenance: {
      dataRevision: 10,
      decimation: "minmax_lttb",
      query: "all",
      resourceKey: "data.table:default",
    },
    series: [
      {
        id: "mx",
        kind: "line",
        label: "Magnetization mx",
        points: [
          { rowIndex: 0, x: 0, y: 0.1 },
          { rowIndex: 1, x: 1e-9, y: 0.2 },
        ],
        unit: "dimensionless",
        yAxis: 0,
      },
    ],
    status: "ready",
    xAxis: { label: "t", unit: "s" },
    yAxes: [{ label: "m", unit: "dimensionless" }],
  };

  it("chartExportProvenance creates provenance sidecar object", () => {
    const prov: ChartExportProvenance = chartExportProvenance(dummyModel, "2026-07-27T12:00:00Z");
    expect(prov.dataRevision).toBe(10);
    expect(prov.decimation).toBe("minmax_lttb");
    expect(prov.exportedAt).toBe("2026-07-27T12:00:00Z");
    expect(prov.scientificTrust).toBe("unknown");
    expect(prov.status).toBe("ready");
  });

  it("serializeChartData formats CSV output with header and rows", () => {
    const csv = serializeChartData(dummyModel, "csv");
    expect(csv).toContain("series_id,row_id,x,y,x_unit,y_unit,data_revision,decimation");
    expect(csv).toContain("mx,0,0,0.1,s,dimensionless,10,minmax_lttb");
  });

  it("serializeChartData adds warning header for stale data", () => {
    const staleModel: ChartRenderModel = { ...dummyModel, status: "stale" };
    const csv = serializeChartData(staleModel, "csv");
    expect(csv).toContain("# WARNING: data status is stale");
  });

  it("safeChartExportFilename generates safe slugified filenames", () => {
    expect(safeChartExportFilename(dummyModel, "csv")).toBe("magnetization-vs-time.csv");
    expect(safeChartExportFilename(dummyModel, "provenance.json")).toBe("magnetization-vs-time.provenance.json");
  });
});
