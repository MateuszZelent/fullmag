import { describe, expect, it } from "vitest";

import {
  analysisColumnDescriptorsForQuery,
  buildChartDataPlan,
  chartTableWindowFromBinary,
  chartTableWindowValue,
  mergeChartTableWindows,
} from "./chartDataPlan";

const columns = [
  { column_id: "step", label: "Step", unit: "1" },
  { column_id: "mx", label: "mx", unit: "1" },
];

describe("ChartDataPlan", () => {
  it("preserves canonical observable identity in queried column descriptors", () => {
    const selected = analysisColumnDescriptorsForQuery([
      {
        column_id: "mx",
        component: "x",
        dimension: "magnetization",
        label: "m x",
        quantity_id: "m",
        reduction: "mean",
        scope: "magnetic_domain",
        unit: "1",
      },
    ], ["mx"]);

    expect(selected).toEqual([{
      column_id: "mx",
      component: "x",
      dimension: "magnetization",
      label: "m x",
      quantity_id: "m",
      reduction: "mean",
      scope: "magnetic_domain",
      unit: "1",
    }]);
  });

  it("builds a stable bounded semantic query identity", () => {
    const first = buildChartDataPlan({
      columns: ["step", "mx"],
      fromRow: 10,
      limit: 100_000,
      resourceKey: "data.tables.default.rows",
      resourceRevision: 7,
      targetPoints: 100_000,
      toRow: 20,
    });
    const second = buildChartDataPlan({
      columns: ["step", "mx"],
      fromRow: 10,
      limit: 100_000,
      resourceKey: "data.tables.default.rows",
      resourceRevision: 7,
      targetPoints: 100_000,
      toRow: 20,
    });

    expect(first).toEqual(second);
    expect(first.limit).toBe(5_000);
    expect(first.targetPoints).toBe(5_000);
    expect(first.key).toContain("data.tables.default.rows@7");
  });

  it("adopts a valid binary window without copying its values", () => {
    const values = new Float64Array([1, 0.1, 2, 0.2]);
    const window = chartTableWindowFromBinary({
      columns,
      decoded: {
        columnCount: 2,
        cursorEnd: 2,
        cursorStart: 1,
        resyncRequired: false,
        revision: 2,
        rowCount: 2,
        schemaRevision: 1,
        totalRows: 2,
        values,
      },
      tableId: "default",
    });

    expect(window.values).toBe(values);
    expect(chartTableWindowValue(window, 1, 1)).toBe(0.2);
  });

  it("fails closed on binary shape mismatch", () => {
    expect(() =>
      chartTableWindowFromBinary({
        columns,
        decoded: {
          columnCount: 2,
          cursorEnd: 2,
          cursorStart: 1,
          resyncRequired: false,
          revision: 2,
          rowCount: 2,
          schemaRevision: 1,
          totalRows: 2,
          values: new Float64Array([1, 0.1, 2]),
        },
        tableId: "default",
      }),
    ).toThrow("binary shape");
  });

  it("merges columnar windows with a bounded row count", () => {
    const current = chartTableWindowFromBinary({
      columns,
      decoded: {
        columnCount: 2,
        cursorEnd: 4_999,
        cursorStart: 1,
        resyncRequired: false,
        revision: 4_999,
        rowCount: 4_999,
        schemaRevision: 1,
        totalRows: 4_999,
        values: new Float64Array(4_999 * 2),
      },
      tableId: "default",
    });
    const incomingValues = new Float64Array([5_000, 0.5, 5_001, 0.6]);
    const incoming = chartTableWindowFromBinary({
      columns,
      decoded: {
        columnCount: 2,
        cursorEnd: 5_001,
        cursorStart: 5_000,
        resyncRequired: false,
        revision: 5_001,
        rowCount: 2,
        schemaRevision: 1,
        totalRows: 5_001,
        values: incomingValues,
      },
      tableId: "default",
    });

    const merged = mergeChartTableWindows(current, incoming);

    expect(merged.rowCount).toBe(5_000);
    expect(merged.cursorStart).toBe(2);
    expect(chartTableWindowValue(merged, 4_999, 0)).toBe(5_001);
  });
});
