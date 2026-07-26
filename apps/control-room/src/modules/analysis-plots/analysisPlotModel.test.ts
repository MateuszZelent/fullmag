import { describe, expect, it } from "vitest";

import {
  chartTableWindowFromBinary,
  chartTableWindowValue,
  mergeChartTableWindows,
  type ChartTableWindow,
} from "@/shared/domain/analysis/chartDataPlan";
import type { AxisColumnDescriptor } from "@/shared/domain/analysis/TableColumnList";
import { __analysisTableRowsAdapterTestUtils as utils } from "./tableRowsAdapter";

const step: AxisColumnDescriptor = { column_id: "step", label: "step", unit: "1" };

function windowOf(cursorStart: number, cursorEnd: number, rows: number[][], options: {
  resyncRequired?: boolean;
  revision?: number;
  totalRows?: number;
} = {}): ChartTableWindow {
  return chartTableWindowFromBinary({
    columns: [step],
    decoded: {
      columnCount: 1,
      cursorEnd,
      cursorStart,
      resyncRequired: options.resyncRequired ?? false,
      revision: options.revision ?? cursorEnd,
      rowCount: rows.length,
      schemaRevision: 1,
      totalRows: options.totalRows ?? cursorEnd,
      values: Float64Array.from(rows.flat()),
    },
    tableId: "default",
  });
}

function rowsOf(window: ChartTableWindow | null): number[][] | null {
  return window
    ? Array.from({ length: window.rowCount }, (_, row) =>
        Array.from({ length: window.columnCount }, (_, column) =>
          chartTableWindowValue(window, row, column) as number,
        ),
      )
    : null;
}

describe("analysis plot scalar selection", () => {
  it("uses one stable scalar column query", () => {
    expect(utils.analysisScalarColumns).toEqual([
      "step", "t", "mx", "my", "mz", "e_total", "max_torque_Apm",
      "pseudo_time_s", "active_runtime_s",
    ]);
    expect(Object.isFrozen(utils.analysisScalarColumns)).toBe(true);
  });

  it("merges and deduplicates cursor deltas in the columnar window", () => {
    expect(rowsOf(mergeChartTableWindows(windowOf(1, 1, [[1]]), windowOf(2, 2, [[2]])))).toEqual([[1], [2]]);
    const current = windowOf(1, 2, [[1], [2]]);
    expect(mergeChartTableWindows(current, windowOf(2, 2, [[2]]))).toBe(current);
  });

  it("adapts a live scalar sample into a columnar window", () => {
    const resource = utils.tableRowsResourceFromScalarSample({
      columns: [
        { column_id: "step", component: null, dimension: "count", label: "step", quantity_id: "step", reduction: null, unit: "1", value_type: "integer" },
        { column_id: "t", component: null, dimension: "time", label: "t", quantity_id: "t", reduction: null, unit: "s", value_type: "float" },
        { column_id: "max_torque", component: null, dimension: "effective_field", label: "max torque", quantity_id: "max_torque_Apm", reduction: "max", unit: "A/m", value_type: "float" },
      ],
      queryColumns: ["step", "t", "max_torque"],
      sample: { revision: 9, row: { max_torque_Apm: 0.4, step: 7, time: 0.2 } },
      tableId: "default",
    });
    expect(resource?.cursorEnd).toBe(9);
    expect(rowsOf(resource)).toEqual([[7, 0.2, 0.4]]);
  });

  it("adopts decoded binary values without row-major expansion", () => {
    const values = new Float64Array([1, 0.1, 2, 0.2]);
    const resource = utils.tableRowsResourceFromBinary({
      columns: [
        { column_id: "step", component: null, dimension: "count", label: "step", quantity_id: "step", reduction: null, unit: "1", value_type: "integer" },
        { column_id: "mx", component: "x", dimension: "magnetization", label: "mx", quantity_id: "mx", reduction: "mean", unit: "1", value_type: "float" },
      ],
      decoded: { columnCount: 2, cursorEnd: 2, cursorStart: 1, resyncRequired: false, revision: 2, rowCount: 2, schemaRevision: 1, totalRows: 2, values },
      queryColumns: ["step", "mx"],
      tableId: "default",
    });
    expect(resource?.values).toBe(values);
    expect(rowsOf(resource)).toEqual([[1, 0.1], [2, 0.2]]);
  });

  it("describes runtime timing columns returned before catalog publication", () => {
    const values = new Float64Array([1, 0.2, 0.1]);
    const resource = utils.tableRowsResourceFromBinary({
      columns: [
        { column_id: "step", component: null, dimension: "count", label: "step", quantity_id: "step", reduction: null, unit: "1", value_type: "integer" },
      ],
      decoded: { columnCount: 3, cursorEnd: 1, cursorStart: 1, resyncRequired: false, revision: 1, rowCount: 1, schemaRevision: 1, totalRows: 1, values },
      queryColumns: ["step", "pseudo_time_s", "active_runtime_s"],
      tableId: "default",
    });
    expect(resource?.columns).toEqual([
      expect.objectContaining({ column_id: "step", unit: "1" }),
      { column_id: "pseudo_time_s", label: "pseudo time", unit: "s" },
      { column_id: "active_runtime_s", label: "active runtime", unit: "s" },
    ]);
    expect(resource?.values).toBe(values);
  });

  it("keeps the fetch cursor stable while appending a live sample", () => {
    const next = utils.tableResourceReducer(
      { cursor: 10, visibleTable: windowOf(10, 10, [[10]]) },
      { advanceCursor: false, resource: windowOf(11, 11, [[11]]), type: "append" },
    );
    expect(next.cursor).toBe(10);
    expect(next.visibleTable?.cursorEnd).toBe(11);
    expect(rowsOf(next.visibleTable)).toEqual([[10], [11]]);
  });

  it("replaces the window for range fetches without advancing the tail cursor", () => {
    const next = utils.tableResourceReducer(
      { cursor: 1_000, visibleTable: windowOf(996, 1_000, [[996], [997], [998], [999], [1_000]]) },
      { advanceCursor: false, mode: "replace", resource: windowOf(200, 250, [[200], [250]], { revision: 1_000, totalRows: 1_000 }), type: "append" },
    );
    expect(next.cursor).toBe(1_000);
    expect(rowsOf(next.visibleTable)).toEqual([[200], [250]]);
  });

  it("preserves visible rows for empty resync and empty range responses", () => {
    const visibleTable = windowOf(469, 473, [[469], [470], [471], [472], [473]]);
    const current = { cursor: 473, visibleTable };
    expect(utils.tableResourceReducer(current, {
      resource: windowOf(474, 473, [], { resyncRequired: true }),
      type: "append",
    })).toBe(current);
    expect(utils.tableResourceReducer(current, {
      advanceCursor: false,
      mode: "replace",
      resource: windowOf(0, 473, []),
      type: "append",
    })).toBe(current);
  });
});
