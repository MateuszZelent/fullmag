import { describe, expect, it } from "vitest";

import type { StudyResultSeriesIdentity } from "@/kernel/api/apiTypes";
import type { ChartTableWindow } from "@/shared/domain/analysis/chartDataPlan";

import {
  liveTableForCurrentSeries,
  liveTableReducer,
  liveTableSeriesIdentityFromResource,
  liveTableSeriesResourceScope,
  liveTableUnsupportedReason,
  shouldLoadLiveTableRows,
  shouldReplaceLiveTableSnapshot,
  type LiveTableStateWithIdentity,
} from "./useLiveTableData";

describe("useLiveTableData", () => {
  it("does no heavy row work while inactive or paused", () => {
    expect(shouldLoadLiveTableRows({ active: false, hasSchema: true, paused: false })).toBe(false);
    expect(shouldLoadLiveTableRows({ active: true, hasSchema: true, paused: true })).toBe(false);
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
    expect(liveTableReducer(initial, { queryKey: "fixed:0:3", seriesIdentity: null, table: next })).toMatchObject({
      cursor: 3,
      queryKey: "fixed:0:3",
      table: next,
    });
  });

  it("resets the cursor across A1 → B1 → B2 and keeps each replacement's first live row", () => {
    const columns = [{ column_id: "step", label: "Step", unit: "1" }];
    const identity = (stepId: string, attemptId: string): StudyResultSeriesIdentity => ({
      run_id: "run-1",
      task_id: "task-1",
      step_id: stepId,
      case_id: "default",
      attempt_id: attemptId,
      ownership_epoch: 1,
    });
    const row = (value: number): ChartTableWindow => ({
      columnCount: 1,
      columns,
      cursorEnd: 1,
      cursorStart: 1,
      resyncRequired: false,
      revision: 1,
      rowCount: 1,
      schemaRevision: 1,
      tableId: "default",
      totalRows: 1,
      values: new Float64Array([value]),
    });
    const a1 = identity("A1", "attempt-a1");
    const b1 = identity("B1", "attempt-b1");
    const b2 = identity("B2", "attempt-b2");
    expect(liveTableSeriesResourceScope(a1)).not.toBe(liveTableSeriesResourceScope(b1));
    expect(liveTableSeriesResourceScope(b1)).not.toBe(liveTableSeriesResourceScope(b2));
    let state: LiveTableStateWithIdentity = {
      cursor: 1,
      queryKey: "follow:A1",
      seriesIdentity: a1,
      table: row(101),
    };
    expect(liveTableForCurrentSeries(state, b1)).toBeNull();
    expect(liveTableForCurrentSeries({ ...state, seriesIdentity: undefined }, b1)).toBeNull();

    state = liveTableReducer(state, {
      expectedSeriesIdentity: b1,
      queryKey: "follow:B1",
      requestCursor: 1,
      seriesIdentity: b1,
      table: row(201),
    });
    expect(state).toMatchObject({ cursor: undefined, queryKey: "follow:B1", seriesIdentity: b1, table: null });
    expect(liveTableForCurrentSeries({ ...state, table: row(101), seriesIdentity: a1 }, b1)).toBeNull();

    state = liveTableReducer(state, {
      expectedSeriesIdentity: b1,
      queryKey: "follow:B1",
      requestCursor: undefined,
      seriesIdentity: a1,
      table: row(199),
    });
    expect(state).toMatchObject({ cursor: undefined, queryKey: "follow:B1", seriesIdentity: b1, table: null });

    state = liveTableReducer(state, {
      expectedSeriesIdentity: b1,
      queryKey: "follow:B1",
      requestCursor: undefined,
      seriesIdentity: b1,
      table: row(201),
    });
    expect(state.table?.values).toEqual(new Float64Array([201]));
    const acceptedB1 = state;
    for (const staleRows of [a1, null]) {
      state = liveTableReducer(state, {
        expectedSeriesIdentity: b1,
        queryKey: "follow:B1",
        seriesIdentity: staleRows,
        table: row(199),
      });
      expect(state).toBe(acceptedB1);
    }

    state = liveTableReducer(state, {
      expectedSeriesIdentity: b2,
      queryKey: "follow:B2",
      requestCursor: 1,
      seriesIdentity: b2,
      table: row(301),
    });
    expect(state).toMatchObject({ cursor: undefined, queryKey: "follow:B2", seriesIdentity: b2, table: null });

    state = liveTableReducer(state, {
      expectedSeriesIdentity: b2,
      queryKey: "follow:B2",
      requestCursor: undefined,
      seriesIdentity: b2,
      table: row(301),
    });
    expect(state.table?.values).toEqual(new Float64Array([301]));
    expect(state.table?.schemaRevision).toBe(1);
  });

  it("restarts legacy rows at a full window and waits for an exact header before appending again", () => {
    const identity: StudyResultSeriesIdentity = {
      run_id: "run", task_id: "task-b", step_id: "B", case_id: "default",
      attempt_id: "attempt-b", ownership_epoch: 3,
    };
    const table: ChartTableWindow = {
      columnCount: 1, columns: [{ column_id: "step", label: "Step", unit: "1" }],
      cursorEnd: 10, cursorStart: 1, resyncRequired: false, revision: 10,
      rowCount: 1, schemaRevision: 1, tableId: "default", totalRows: 10, values: new Float64Array([42]),
    };
    const request = { expectedSeriesIdentity: identity, queryKey: "series-b", table };
    const pinned = liveTableReducer({ cursor: undefined, queryKey: null, table: null }, {
      ...request, seriesIdentity: identity,
    });
    const rejected = liveTableReducer(pinned, { ...request, requestCursor: 10 });
    expect(rejected.cursor).toBeUndefined();
    expect(rejected.table).toBeNull();
    const legacy = liveTableReducer(rejected, request);
    expect(legacy.table).toBe(table);
    expect(legacy.cursor).toBeUndefined();
    expect(legacy.seriesIdentity).toBeUndefined();
    expect(liveTableForCurrentSeries(legacy, identity, "series-b")).toBe(table);
    expect(liveTableForCurrentSeries(legacy, identity, "series-c")).toBeNull();

    const replacement = { ...table, values: new Float64Array([55]) };
    const moreLegacy = liveTableReducer(legacy, { ...request, table: replacement });
    expect(moreLegacy.table).toBe(replacement);
    expect(moreLegacy.cursor).toBeUndefined();

    const foreign = liveTableReducer(moreLegacy, { ...request, seriesIdentity: null });
    expect(foreign).toBe(moreLegacy);
    const exact = liveTableReducer(moreLegacy, { ...request, seriesIdentity: identity });
    expect(exact.cursor).toBe(10);
    expect(exact.seriesIdentity).toEqual(identity);
    expect(exact.table?.values).toEqual(table.values);
  });

  it("keeps the last accepted series pin while scalar metadata is stale", () => {
    const a1: StudyResultSeriesIdentity = {
      run_id: "run-1",
      task_id: "task-a1",
      step_id: "A1",
      case_id: "default",
      attempt_id: "attempt-a1",
      ownership_epoch: 4,
    };
    const retainedIdentity = liveTableSeriesIdentityFromResource({
      data: { series: a1 },
      status: "stale",
    });
    expect(retainedIdentity).toEqual(a1);
    expect(liveTableSeriesResourceScope(retainedIdentity)).toBe(liveTableSeriesResourceScope(a1));
  });

  it("advances the follow cursor for the empty raw [1,2] delta and retains row one", () => {
    const columns = [{ column_id: "step", label: "Step", unit: "1" }];
    const currentValues = new Float64Array([4]);
    const currentTable: ChartTableWindow = {
      columnCount: 1,
      columns,
      cursorEnd: 1,
      cursorStart: 1,
      resyncRequired: false,
      revision: 1,
      rowCount: 1,
      schemaRevision: 1,
      tableId: "default",
      totalRows: 1,
      values: currentValues,
    };
    const emptyDelta: ChartTableWindow = {
      ...currentTable,
      cursorEnd: 2,
      cursorStart: 1,
      revision: 2,
      rowCount: 0,
      totalRows: 2,
      values: new Float64Array(0),
    };
    const initial = {
      cursor: 1,
      queryKey: "follow",
      table: currentTable,
    };

    const advanced = liveTableReducer(initial, {
      queryKey: "follow",
      seriesIdentity: null,
      table: emptyDelta,
    });

    expect(advanced.cursor).toBe(2);
    expect(advanced.table).toMatchObject({
      cursorEnd: 2,
      rowCount: 1,
      totalRows: 2,
    });
    expect(advanced.table?.values).toBe(currentValues);

    const resync: ChartTableWindow = {
      ...emptyDelta,
      cursorEnd: 1,
      cursorStart: 1,
      resyncRequired: true,
      revision: 1,
      totalRows: 1,
    };
    const reset = liveTableReducer(advanced, {
      queryKey: "follow",
      seriesIdentity: null,
      table: resync,
    });

    expect(reset.cursor).toBe(1);
    expect(reset.table).toBe(resync);
    expect(reset.table?.rowCount).toBe(0);
  });

  it("discards the invalidated cursor when a shorter stage returns an empty resync", () => {
    const row = (count: number): ChartTableWindow => ({
      columnCount: 1,
      columns: [{ column_id: "step", label: "Step", unit: "1" }],
      cursorEnd: 50,
      cursorStart: 50,
      resyncRequired: count === 0,
      revision: count === 0 ? 1 : 50,
      rowCount: count,
      schemaRevision: 1,
      tableId: "default",
      totalRows: count === 0 ? 1 : 50,
      values: new Float64Array(count),
    });
    const oldStage = { cursor: 50, queryKey: "follow", table: row(50) };
    const answerFromNewStage = { requestCursor: 50, queryKey: "follow", table: row(0) };
    const restarted = liveTableReducer(oldStage, answerFromNewStage);
    expect(restarted.cursor).toBeUndefined();
    expect(restarted.table).toBeNull();
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
      seriesIdentity: null,
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
      seriesIdentity: null,
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
