import { describe, expect, it } from "vitest";

import {
  buildChartSeriesModel,
  buildTableRowsQuery,
  DEFAULT_TABLE_CHART_COLUMNS,
  groupSeriesByAxisUnit,
  yAxisIdsAfterXAxisSelection,
} from "./chartTableModel";

describe("chartTableModel", () => {
  it("requests only a bounded visible table window with the default production columns", () => {
    expect(DEFAULT_TABLE_CHART_COLUMNS).toEqual([
      "step",
      "t",
      "mx",
      "my",
      "mz",
      "e_total",
      "max_torque",
    ]);
    expect(
      buildTableRowsQuery({
        columns: DEFAULT_TABLE_CHART_COLUMNS,
        cursor: 1_000,
        targetPoints: 1_600,
      }),
    ).toEqual({
      columns: DEFAULT_TABLE_CHART_COLUMNS,
      cursor: 1_000,
      decimation: "minmax_lttb",
      includeTail: true,
      limit: 5_000,
      targetPoints: 1_600,
    });
  });

  it("groups same-unit series on one axis and caps mixed units at two axes", () => {
    const axes = groupSeriesByAxisUnit([
      { columnId: "mx", unit: "1" },
      { columnId: "my", unit: "1" },
      { columnId: "e_total", unit: "J" },
      { columnId: "max_torque", unit: "A/m" },
    ]);

    expect(axes).toEqual([
      { axisIndex: 0, columnIds: ["mx", "my"], unit: "1" },
      { axisIndex: 1, columnIds: ["e_total"], unit: "J" },
    ]);
  });

  it("builds an ECharts dataset model from table row resources", () => {
    const model = buildChartSeriesModel(
      {
        columns: [
          { column_id: "step", dimension: "count", label: "step", unit: "1" },
          { column_id: "t", dimension: "time", label: "t", unit: "s" },
          { column_id: "mx", dimension: "magnetization", label: "mx", unit: "1" },
          { column_id: "e", dimension: "energy", label: "Energy", unit: "J" },
        ],
        rows: [
          [0, 0, 1.0, 0.0],
          [1, 1e-12, 0.9, -1e-5],
        ],
      },
      { xAxisId: "t", yAxisIds: ["mx", "e"] },
    );

    expect(model.dataset.source).toEqual([
      ["step", "t", "mx", "e"],
      [0, 0, 1.0, 0.0],
      [1, 1e-12, 0.9, -1e-5],
    ]);
    expect(model.xAxisId).toBe("t");
    expect(model.series.map((series) => series.encode.x)).toEqual(["t", "t"]);
    expect(model.series.map((series) => series.name)).toEqual([
      "mx [1]",
      "Energy [J]",
    ]);
    expect(model.yAxis).toEqual([{ name: "1" }, { name: "J" }]);
  });

  it("defaults to step on X and every other column on Y", () => {
    const model = buildChartSeriesModel({
      columns: [
        { column_id: "step", dimension: "count", label: "step", unit: "1" },
        { column_id: "mx", dimension: "magnetization", label: "mx", unit: "1" },
      ],
      rows: [[1, 0.1]],
    });

    expect(model.series).toHaveLength(1);
    expect(model.xAxisId).toBe("step");
    expect(model.series[0]?.encode).toEqual({ x: "step", y: "mx" });
  });

  it("falls back to the first available column when step is not present", () => {
    const model = buildChartSeriesModel({
      columns: [
        { column_id: "t", dimension: "time", label: "t", unit: "s" },
        { column_id: "mx", dimension: "magnetization", label: "mx", unit: "1" },
      ],
      rows: [[1e-12, 0.1]],
    });

    expect(model.xAxisId).toBe("t");
    expect(model.series[0]?.encode).toEqual({ x: "t", y: "mx" });
  });

  it("keeps selected X columns out of the Y series set", () => {
    const model = buildChartSeriesModel(
      {
        columns: [
          { column_id: "step", dimension: "count", label: "step", unit: "1" },
          { column_id: "mx", dimension: "magnetization", label: "mx", unit: "1" },
        ],
        rows: [[1, 0.1]],
      },
      { xAxisId: "mx", yAxisIds: ["step", "mx"] },
    );

    expect(model.series.map((series) => series.encode)).toEqual([
      { x: "mx", y: "step" },
    ]);
    expect(yAxisIdsAfterXAxisSelection(["step", "mx"], "mx")).toEqual(["step"]);
  });
});
