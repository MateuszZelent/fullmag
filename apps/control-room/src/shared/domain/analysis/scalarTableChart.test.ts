import { describe, expect, it } from "vitest";

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
        resourceKey: "/v2/sessions/current/data/tables/stage%3A1/rows",
        tableId: "stage:1",
      },
      status: "ready",
      unit: "1",
      xUnit: "1",
    }]);
  });
});
