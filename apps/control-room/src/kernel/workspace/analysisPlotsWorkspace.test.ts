import { beforeEach, describe, expect, it } from "vitest";

import { DATA_TABLE_ROWS_PATH } from "../api/apiPaths";
import {
  analysisPlotsWorkspaceStore,
  resetAnalysisPlotsWorkspaceForTests,
} from "./analysisPlotsWorkspace";

function tableRowsResourceKey(tableId: string): string {
  return DATA_TABLE_ROWS_PATH.replace("{table_id}", encodeURIComponent(tableId));
}

describe("analysisPlotsWorkspaceStore", () => {
  beforeEach(() => {
    resetAnalysisPlotsWorkspaceForTests();
  });

  it("starts with production chart axes that fit the two-unit ECharts contract", () => {
    expect(analysisPlotsWorkspaceStore.getSnapshot()).toMatchObject({
      xAxisId: "step",
      yAxisIds: ["mx", "my", "mz", "e_total"],
    });
  });

  it("updates chart axes without resetting the visible table window", () => {
    const tableState = {
      cursor: 3,
      visibleTable: {
        columns: [
          {
            column_id: "step",
            component: null,
            dimension: "count",
            label: "step",
            quantity_id: "step",
            reduction: null,
            unit: "1",
            value_type: "integer",
          },
        ],
        cursor_end: 3,
        cursor_start: 1,
        resync_required: false,
        returned_rows: 3,
        revision: 3,
        rows: [[1], [2], [3]],
        schema_revision: 1,
        table_id: "default",
        total_rows: 3,
      },
    };
    analysisPlotsWorkspaceStore.setTableState(tableState);

    analysisPlotsWorkspaceStore.setAxes("t", ["mx", "my"]);

    expect(analysisPlotsWorkspaceStore.getSnapshot()).toMatchObject({
      tableState,
      xAxisId: "t",
      yAxisIds: ["mx", "my"],
    });
  });

  it("does not notify subscribers when axes are unchanged", () => {
    let notifications = 0;
    const unsubscribe = analysisPlotsWorkspaceStore.subscribe(() => {
      notifications += 1;
    });

    analysisPlotsWorkspaceStore.setAxes("step", [
      "mx",
      "my",
      "mz",
      "e_total",
    ]);

    unsubscribe();
    expect(notifications).toBe(0);
  });

  it("does not notify subscribers when table state is unchanged", () => {
    const tableState = analysisPlotsWorkspaceStore.getSnapshot().tableState;
    let notifications = 0;
    const unsubscribe = analysisPlotsWorkspaceStore.subscribe(() => {
      notifications += 1;
    });

    analysisPlotsWorkspaceStore.setTableState(tableState);

    unsubscribe();
    expect(notifications).toBe(0);
  });

  it("stores chart ranges separately from visible table rows", () => {
    analysisPlotsWorkspaceStore.setRange({
      fromValue: 100,
      toValue: 200,
    });

    expect(analysisPlotsWorkspaceStore.getSnapshot()).toMatchObject({
      range: {
        fromValue: 100,
        toValue: 200,
      },
    });

    analysisPlotsWorkspaceStore.clearRange();

    expect(analysisPlotsWorkspaceStore.getSnapshot().range).toBe(null);
  });

  it("stores the selected chart cursor point as local chart state", () => {
    const point = {
      label: "mx",
      point: { rowIndex: 2, x: 3, y: 0.2 },
      quantity: "mx",
      seriesId: "data.table:default:step:mx",
      source: {
        kind: "data.table.rows" as const,
        resourceKey: tableRowsResourceKey("default"),
        tableId: "default",
      },
      unit: "1",
      xUnit: "1",
    };

    analysisPlotsWorkspaceStore.setSelectedPoint(point);
    analysisPlotsWorkspaceStore.setSelectedPoint({ ...point });

    expect(analysisPlotsWorkspaceStore.getSnapshot().selectedPoint).toEqual(point);
  });
});
