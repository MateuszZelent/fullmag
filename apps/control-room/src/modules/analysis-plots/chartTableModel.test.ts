import { describe, expect, it } from "vitest";

import { DATA_TABLE_ROWS_PATH } from "../../kernel/api/apiPaths";
import {
  buildChartSeriesModel,
  buildScalarChartSeries,
  buildTableRowsQuery,
  chartCursorPointFromEChartsClick,
  DEFAULT_TABLE_CHART_COLUMNS,
  groupSeriesByAxisUnit,
  chartRangeFromDataZoomEvent,
  tableRowsVisibleRangeQuery,
  yAxisIdsAfterXAxisSelection,
} from "./chartTableModel";

function tableRowsResourceKey(tableId: string): string {
  return DATA_TABLE_ROWS_PATH.replace("{table_id}", encodeURIComponent(tableId));
}

describe("chartTableModel", () => {
  it("requests only a bounded visible table window with the default production columns", () => {
    expect(DEFAULT_TABLE_CHART_COLUMNS).toEqual([
      "step",
      "t",
      "mx",
      "my",
      "mz",
      "e_total",
      "max_torque_Apm",
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

  it("switches zoomed row ranges to bounded visible-range fetches", () => {
    expect(
      buildTableRowsQuery({
        columns: DEFAULT_TABLE_CHART_COLUMNS,
        cursor: 1_000,
        range: tableRowsVisibleRangeQuery({
          fromValue: 120.2,
          toValue: 240.8,
          xAxisId: "step",
        }),
        targetPoints: 800,
      }),
    ).toEqual({
      columns: DEFAULT_TABLE_CHART_COLUMNS,
      decimation: "minmax_lttb",
      fromRow: 120,
      includeTail: false,
      limit: 5_000,
      targetPoints: 800,
      toRow: 241,
    });
  });

  it("switches zoomed time ranges to bounded visible-range fetches", () => {
    expect(
      tableRowsVisibleRangeQuery({
        fromValue: 1e-12,
        toValue: 5e-12,
        xAxisId: "t",
      }),
    ).toEqual({
      fromT: 1e-12,
      toT: 5e-12,
    });
  });

  it("keeps an arbitrary-quantity zoom local instead of mislabelling it as a row range", () => {
    expect(
      tableRowsVisibleRangeQuery({
        fromValue: -0.5,
        toValue: 0.5,
        xAxisId: "mx",
      }),
    ).toBeNull();
  });

  it("extracts a finite ECharts dataZoom value range", () => {
    expect(
      chartRangeFromDataZoomEvent({
        batch: [{ startValue: 10.2, endValue: 20.8 }],
      }),
    ).toEqual({ fromValue: 10.2, toValue: 20.8 });
    expect(chartRangeFromDataZoomEvent({ startValue: 30, endValue: 10 })).toEqual(
      { fromValue: 10, toValue: 30 },
    );
    expect(chartRangeFromDataZoomEvent({ start: 10, end: 90 })).toBe(null);
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

  it("maps scalar table rows into chart series with units and resource status", () => {
    const series = buildScalarChartSeries(
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
      {
        status: "stale",
        tableId: "default",
        xAxisId: "t",
        yAxisIds: ["mx", "e"],
      },
    );

    expect(series).toEqual([
      {
        id: "data.table:default:t:mx",
        label: "mx",
        points: [
          { rowIndex: 0, x: 0, y: 1 },
          { rowIndex: 1, x: 1e-12, y: 0.9 },
        ],
        quantity: "mx",
        source: {
          kind: "data.table.rows",
          resourceKey: tableRowsResourceKey("default"),
          tableId: "default",
        },
        status: "stale",
        unit: "1",
        xUnit: "s",
      },
      {
        id: "data.table:default:t:e",
        label: "Energy",
        points: [
          { rowIndex: 0, x: 0, y: 0 },
          { rowIndex: 1, x: 1e-12, y: -1e-5 },
        ],
        quantity: "e",
        source: {
          kind: "data.table.rows",
          resourceKey: tableRowsResourceKey("default"),
          tableId: "default",
        },
        status: "stale",
        unit: "J",
        xUnit: "s",
      },
    ]);
  });

  it("keeps chart series identity scoped to the source table", () => {
    const table = {
      columns: [
        { column_id: "step", dimension: "count", label: "step", unit: "1" },
        { column_id: "mx", dimension: "magnetization", label: "mx", unit: "1" },
      ],
      rows: [[1, 0.1]],
    };

    const first = buildScalarChartSeries(table, { tableId: "stage:1" });
    const second = buildScalarChartSeries(table, { tableId: "stage:2" });

    expect(first[0]?.id).toBe("data.table:stage:1:step:mx");
    expect(first[0]?.source.resourceKey).toBe(
      tableRowsResourceKey("stage:1"),
    );
    expect(second[0]?.id).toBe("data.table:stage:2:step:mx");
    expect(second[0]?.source.resourceKey).toBe(
      tableRowsResourceKey("stage:2"),
    );
  });

  it("drops non-finite chart points while preserving finite extrema", () => {
    const series = buildScalarChartSeries(
      {
        columns: [
          { column_id: "step", dimension: "count", label: "step", unit: "1" },
          { column_id: "mx", dimension: "magnetization", label: "mx", unit: "1" },
        ],
        rows: [
          [0, -1],
          [1, Number.NaN],
          [2, Number.POSITIVE_INFINITY],
          [3, 0.5],
          [4, 1],
        ],
      },
      { yAxisIds: ["mx"] },
    );

    expect(series[0]?.points).toEqual([
      { rowIndex: 0, x: 0, y: -1 },
      { rowIndex: 3, x: 3, y: 0.5 },
      { rowIndex: 4, x: 4, y: 1 },
    ]);
  });

  it("maps an ECharts click event to a typed chart cursor point", () => {
    const series = buildScalarChartSeries(
      {
        columns: [
          { column_id: "step", dimension: "count", label: "step", unit: "1" },
          { column_id: "mx", dimension: "magnetization", label: "mx", unit: "1" },
        ],
        rows: [
          [1, 0.1],
          [2, 0.2],
        ],
      },
      { tableId: "default", xAxisId: "step", yAxisIds: ["mx"] },
    );

    expect(
      chartCursorPointFromEChartsClick(
        { dataIndex: 1, seriesIndex: 0 },
        series,
      ),
    ).toEqual({
      label: "mx",
      point: { rowIndex: 1, x: 2, y: 0.2 },
      quantity: "mx",
      seriesId: "data.table:default:step:mx",
      source: {
        kind: "data.table.rows",
        resourceKey: tableRowsResourceKey("default"),
        tableId: "default",
      },
      unit: "1",
      xUnit: "1",
    });
    expect(
      chartCursorPointFromEChartsClick(
        { dataIndex: 99, seriesIndex: 0 },
        series,
      ),
    ).toBe(null);
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
