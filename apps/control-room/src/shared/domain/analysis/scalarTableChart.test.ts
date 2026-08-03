import { describe, expect, it } from "vitest";

import { DATA_TABLE_ROWS_PATH } from "@/kernel/api/apiPaths";

import { buildScalarTableSeries } from "./scalarTableChart";

describe("buildScalarTableSeries", () => {
  it("preserves scalar-table identity, finite points, units, and provenance", () => {
    expect(buildScalarTableSeries({
      table: {
        columns: [
          { column_id: "step", label: "Step", unit: "1" },
          { column_id: "mx", label: "mx", unit: "1" },
        ],
        rows: [[0, 1], [1, Number.NaN], [2, 0.5]],
      },
      tableId: "stage:1",
      xAxisId: "step",
      yAxisIds: ["mx"],
    })).toEqual([{
      id: "data.table:stage:1:step:mx",
      label: "mx",
      points: [
        { rowIndex: 0, x: 0, y: 1 },
        { rowIndex: 2, x: 2, y: 0.5 },
      ],
      quantity: "mx",
      source: {
        kind: "data.table.rows",
        resourceKey: DATA_TABLE_ROWS_PATH.replace("{table_id}", encodeURIComponent("stage:1")),
        tableId: "stage:1",
      },
      status: "ready",
      unit: "1",
      xUnit: "1",
    }]);
  });
});
