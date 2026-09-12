import { describe, expect, it } from "vitest";
import type { ChartSeries } from "@/shared/domain/analysis/chartSeries";
import { liveChartReadings, liveChartXAxisOptions, visibleLiveChartPanes } from "./liveChartsPresentation";

const series: ChartSeries[] = [
  { id: "mx", label: "mx", quantity: "mx", unit: "1", xUnit: "s", points: [{ rowIndex: 0, x: 1e-9, y: 0.98 }], source: { kind: "data.table.rows", resourceKey: "table", tableId: "default" }, status: "ready" },
  { id: "energy", label: "Total energy", quantity: "energy", unit: "J", xUnit: "s", points: [{ rowIndex: 0, x: 1e-9, y: 1e-18 }], source: { kind: "data.table.rows", resourceKey: "table", tableId: "default" }, status: "ready" },
];

describe("Live Charts presentation", () => {
  it("offers only published time/step axes", () => {
    const columns = [
      { column_id: "step", label: "Iteration", unit: "1" },
      { column_id: "t", label: "t", unit: "s" },
      { column_id: "mx", label: "mx", unit: "1" },
    ];
    expect(liveChartXAxisOptions(columns)).toEqual([{ id: "step", label: "Step" }, { id: "t", label: "Time (s)" }]);
    expect(liveChartXAxisOptions(columns.slice(0, 1))).toEqual([{ id: "step", label: "Step" }]);
    expect(liveChartXAxisOptions(columns)).toEqual([{ id: "step", label: "Step" }, { id: "t", label: "Time (s)" }]);
  });
  it("only allocates chart space for selected quantities and preserves separate units", () => {
    expect(visibleLiveChartPanes(series, ["mx"]).map((pane) => pane.unit)).toEqual(["1"]);
    expect(visibleLiveChartPanes(series, ["mx", "energy"]).map((pane) => pane.unit)).toEqual(["1", "J"]);
    expect(visibleLiveChartPanes(series, [])).toEqual([]);
  });

  it("formats readings with their matching display units without changing source data", () => {
    const readings = liveChartReadings(series);
    expect(readings[0]).toMatchObject({ id: "mx", latestValue: "0.98", unit: "1" });
    expect(readings[1]).toMatchObject({ id: "energy", latestValue: "1.0000e-6", unit: "pJ" });
    expect(series[1].points[0].y).toBe(1e-18);
  });

  it("preserves a missing latest sample instead of presenting an old value as current", () => {
    const missing = { ...series[0], points: [{ rowIndex: 1, x: 2e-9, y: Number.NaN }] };
    expect(liveChartReadings([missing])[0].latestValue).toBe("—");
  });
});
