import { describe, expect, it } from "vitest";
import type { ChartTableWindow } from "@/shared/domain/analysis/chartDataPlan";

import {
  shouldLoadLiveTableRows,
  shouldPauseLiveTableRows,
  liveTableUnsupportedReason,
  liveTableReducer,
  shouldReplaceLiveTableSnapshot,
} from "./useLiveTableData";

describe("useLiveTableData", () => {
  it("does no heavy work while inactive or paused with retained rows", () => {
    expect(shouldLoadLiveTableRows({ active: false, hasSchema: true, paused: false })).toBe(false);
    expect(shouldLoadLiveTableRows({ active: true, hasSchema: true, paused: true })).toBe(false);
    expect(shouldPauseLiveTableRows({ active: true, hasRows: true, paused: true })).toBe(true);
    expect(shouldPauseLiveTableRows({ active: true, hasRows: true, paused: false })).toBe(false);
  });

  it("calls a resumed active surface eligible for exactly the latest resource fetch", () => {
    expect(shouldLoadLiveTableRows({ active: true, hasSchema: true, paused: false })).toBe(true);
  });

  it("reports an empty published schema as unsupported", () => {
    expect(liveTableUnsupportedReason([], "ready")).toBe("The active runtime does not publish scalar table samples.");
  });

  it("replaces the follow window when the query identity changes", () => {
    const initial = { cursor: 8, queryKey: "follow", table: { cursorEnd: 8, resyncRequired: false, rowCount: 2 } } as never;
    const next = { cursorEnd: 3, resyncRequired: false, rowCount: 1 } as never;
    expect(liveTableReducer(initial, { queryKey: "fixed:0:3", table: next })).toMatchObject({
      cursor: 3,
      queryKey: "fixed:0:3",
      table: next,
    });
  });

  it("replaces sparse-cursor snapshot windows instead of merging their decimated rows", () => {
    const makeSnapshot = (cursorStart: number, cursorEnd: number): ChartTableWindow => ({
      columnCount: 1,
      columns: [{ column_id: "step", label: "step", unit: "1" }],
      cursorEnd,
      cursorStart,
      resyncRequired: false,
      revision: cursorEnd,
      rowCount: 800,
      schemaRevision: 1,
      tableId: "default",
      totalRows: cursorEnd,
      values: new Float64Array(800),
    });
    const initialTable = makeSnapshot(5_001, 10_000);
    const nextTable = makeSnapshot(5_002, 10_001);
    const initial = { cursor: 10_000, queryKey: "fullDecimated", table: initialTable };

    expect(liveTableReducer(initial, {
      queryKey: "fullDecimated",
      replace: true,
      table: nextTable,
    })).toMatchObject({
      cursor: 10_001,
      queryKey: "fullDecimated",
      table: nextTable,
    });
  });

  it("keeps a tail-row snapshot at its requested N-row bound", () => {
    const requestedRows = 120;
    const makeSnapshot = (cursorStart: number, cursorEnd: number): ChartTableWindow => ({
      columnCount: 1,
      columns: [{ column_id: "step", label: "step", unit: "1" }],
      cursorEnd,
      cursorStart,
      resyncRequired: false,
      revision: cursorEnd,
      rowCount: requestedRows,
      schemaRevision: 1,
      tableId: "default",
      totalRows: cursorEnd,
      values: new Float64Array(requestedRows),
    });
    const initialTable = makeSnapshot(8_881, 9_000);
    const nextTable = makeSnapshot(8_882, 9_001);
    const initial = { cursor: 9_000, queryKey: "tailRows", table: initialTable };

    const result = liveTableReducer(initial, {
      queryKey: "tailRows",
      replace: shouldReplaceLiveTableSnapshot({ mode: "tailRows", rows: requestedRows }),
      table: nextTable,
    });

    expect(result.table).toBe(nextTable);
    expect(result.table?.rowCount).toBe(requestedRows);
    expect(result.table?.rowCount).toBeLessThanOrEqual(requestedRows);
  });

  it.each([
    [{ mode: "fullDecimated" }, true],
    [{ mode: "fixed", fromSI: 1, toSI: 2 }, true],
    [{ mode: "tailTime", durationS: 1 }, true],
    [{ mode: "tailRows", rows: 100 }, true],
    [{ mode: "follow" }, false],
  ] as const)("classifies %o as a %s snapshot update", (range, replace) => {
    expect(shouldReplaceLiveTableSnapshot(range)).toBe(replace);
  });
});
