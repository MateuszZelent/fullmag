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

  it("starts with production chart selection and no server payload", () => {
    const snapshot = analysisPlotsWorkspaceStore.getSnapshot();

    expect(snapshot).toMatchObject({
      activeSurface: "overview",
      availableColumns: [],
      xAxisId: "step",
      selectedSeriesIds: [
        "data.table:default:step:mx",
        "data.table:default:step:my",
        "data.table:default:step:mz",
        "data.table:default:step:e_total",
      ],
    });
    expect("tableState" in snapshot).toBe(false);
    expect("visibleTable" in snapshot).toBe(false);
    expect("setTableState" in analysisPlotsWorkspaceStore).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain("\"rows\"");
  });

  it("stores the active surface as a compact preference", () => {
    analysisPlotsWorkspaceStore.setActiveSurface("energy");
    expect(analysisPlotsWorkspaceStore.getSnapshot().activeSurface).toBe("energy");
  });

  it("stores only compact column descriptors for cross-surface controls", () => {
    analysisPlotsWorkspaceStore.setAvailableColumns([
      { column_id: "step", label: "Step", unit: "1" },
      { column_id: "mx", label: "mx", unit: "1" },
    ]);

    expect(analysisPlotsWorkspaceStore.getSnapshot().availableColumns).toEqual([
      { column_id: "step", label: "Step", unit: "1" },
      { column_id: "mx", label: "mx", unit: "1" },
    ]);
  });

  it("does not notify subscribers when column descriptors are unchanged", () => {
    const columns = [{ column_id: "step", label: "Step", unit: "1" }];
    analysisPlotsWorkspaceStore.setAvailableColumns(columns);
    let notifications = 0;
    const unsubscribe = analysisPlotsWorkspaceStore.subscribe(() => {
      notifications += 1;
    });

    analysisPlotsWorkspaceStore.setAvailableColumns([{ ...columns[0] }]);

    unsubscribe();
    expect(notifications).toBe(0);
  });

  it("does not notify subscribers when selected series are unchanged", () => {
    let notifications = 0;
    const unsubscribe = analysisPlotsWorkspaceStore.subscribe(() => {
      notifications += 1;
    });

    analysisPlotsWorkspaceStore.setSelectedSeriesIds([
      "data.table:default:step:mx",
      "data.table:default:step:my",
      "data.table:default:step:mz",
      "data.table:default:step:e_total",
    ]);

    unsubscribe();
    expect(notifications).toBe(0);
  });

  it("stores chart ranges independently from resource data", () => {
    analysisPlotsWorkspaceStore.setRange({
      fromValue: 100,
      toValue: 200,
    });

    expect(analysisPlotsWorkspaceStore.getSnapshot().range).toEqual({
      fromValue: 100,
      toValue: 200,
    });

    analysisPlotsWorkspaceStore.clearRange();

    expect(analysisPlotsWorkspaceStore.getSnapshot().range).toBe(null);
  });

  it("publishes a new local fit request without storing chart data", () => {
    const initial = analysisPlotsWorkspaceStore.getSnapshot().fitRequest;

    analysisPlotsWorkspaceStore.requestFitView();

    const next = analysisPlotsWorkspaceStore.getSnapshot();
    expect(next.fitRequest).toBe(initial + 1);
    expect(JSON.stringify(next)).not.toContain("points");
  });

  it("stores the selected chart cursor point as bounded semantic state", () => {
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
