import { describe, expect, it } from "vitest";

import { shouldFetchAnalysisTableRows } from "../analysisPlotsModel";
import {
  shouldLoadPublishedTableRows,
  shouldPausePublishedTableRows,
  tableColumnIdsForQuery,
  tableRowsUnsupportedReasonForColumns,
  tableRowsStatusForDisplay,
} from "./useAnalysisTableData";

describe("useAnalysisTableData unit logic", () => {
  it("does not issue a rows query before the runtime publishes its table schema", () => {
    expect(tableColumnIdsForQuery(null)).toEqual([]);
    expect(tableColumnIdsForQuery([])).toEqual([]);
    expect(tableColumnIdsForQuery([
      { column_id: "step" },
      { column_id: "mx" },
      { column_id: "e_total" },
    ])).toEqual(["step", "mx", "e_total"]);

    expect(
      shouldLoadPublishedTableRows(
        {
          hasVisibleRows: false,
          loadScalars: true,
          liveMode: "following",
        },
        false,
      ),
    ).toBe(false);

    expect(
      shouldLoadPublishedTableRows(
        {
          hasVisibleRows: false,
          loadScalars: true,
          liveMode: "following",
        },
        true,
      ),
    ).toBe(true);
  });

  it("keeps the resource subscribed while paused and stops only its loader", () => {
    const pausedWithRows = {
      hasVisibleRows: true,
      loadScalars: true,
      liveMode: "paused" as const,
    };

    expect(shouldLoadPublishedTableRows(pausedWithRows, true)).toBe(true);
    expect(shouldPausePublishedTableRows(pausedWithRows, true)).toBe(true);
    expect(shouldPausePublishedTableRows(pausedWithRows, false)).toBe(false);
    expect(
      shouldPausePublishedTableRows(
        { ...pausedWithRows, liveMode: "following" },
        true,
      ),
    ).toBe(false);
  });

  it("presents a frozen visible revision as paused rather than stale or empty", () => {
    expect(tableRowsStatusForDisplay("ready", "paused", true)).toBe("paused");
    expect(tableRowsStatusForDisplay("stale", "paused", true)).toBe("paused");
    expect(tableRowsStatusForDisplay("error", "paused", true)).toBe("error");
    expect(tableRowsStatusForDisplay("stale", "following", true)).toBe("stale");
  });

  it("marks a published empty table schema as semantically unsupported", () => {
    expect(tableRowsUnsupportedReasonForColumns([], "ready")).toBe(
      "The active runtime does not publish scalar table samples.",
    );
    expect(tableRowsUnsupportedReasonForColumns(null, "ready")).toBeNull();
    expect(tableRowsUnsupportedReasonForColumns([], "loading")).toBeNull();
  });

  it("determines whether to fetch table rows based on loadScalars and liveMode", () => {
    expect(
      shouldFetchAnalysisTableRows({
        hasVisibleRows: false,
        loadScalars: true,
        liveMode: "following",
      }),
    ).toBe(true);

    expect(
      shouldFetchAnalysisTableRows({
        hasVisibleRows: true,
        loadScalars: true,
        liveMode: "following",
      }),
    ).toBe(true);

    expect(
      shouldFetchAnalysisTableRows({
        hasVisibleRows: true,
        loadScalars: true,
        liveMode: "paused",
      }),
    ).toBe(false);
  });
});
