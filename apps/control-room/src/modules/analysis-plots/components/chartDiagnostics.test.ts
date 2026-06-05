import { afterEach, describe, expect, it, vi } from "vitest";

import { DATA_TABLE_ROWS_PATH } from "../../../kernel/api/apiPaths";
import {
  clearChartDispatchSeriesRequest,
  recordChartRangeSelectedEvent,
  recordChartDispatchSeriesRequest,
  recordChartSeriesSelectedEvent,
} from "./chartDiagnostics";

function tableRowsResourceKey(tableId: string): string {
  return DATA_TABLE_ROWS_PATH.replace("{table_id}", encodeURIComponent(tableId));
}

describe("chartDiagnostics", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears the diagnostic add-series dispatcher on module unmount", () => {
    vi.stubGlobal("window", {
      __FULLMAG_ENABLE_CHART_DIAGNOSTICS__: true,
    });
    const dispatchSeriesRequest = vi.fn();

    recordChartDispatchSeriesRequest(dispatchSeriesRequest);
    expect(window.__FULLMAG_CHART_DIAGNOSTICS__?.dispatchSeriesRequest).toBe(
      dispatchSeriesRequest,
    );

    clearChartDispatchSeriesRequest();

    expect(
      window.__FULLMAG_CHART_DIAGNOSTICS__?.dispatchSeriesRequest,
    ).toBeUndefined();
  });

  it("keeps range-selected diagnostic events bounded", () => {
    vi.stubGlobal("window", {
      __FULLMAG_ENABLE_CHART_DIAGNOSTICS__: true,
    });

    for (let index = 0; index < 10; index += 1) {
      recordChartRangeSelectedEvent({
        chartId: "default",
        range: { fromValue: index, toValue: index + 1 },
        tableId: "default",
        xAxisId: "step",
      });
    }

    const events = window.__FULLMAG_CHART_DIAGNOSTICS__?.rangeSelectedEvents;
    expect(events).toHaveLength(8);
    expect(events?.[0]?.range).toEqual({ fromValue: 2, toValue: 3 });
    expect(events?.at(-1)?.range).toEqual({ fromValue: 9, toValue: 10 });
  });

  it("keeps series-selected diagnostic events bounded", () => {
    vi.stubGlobal("window", {
      __FULLMAG_ENABLE_CHART_DIAGNOSTICS__: true,
    });

    for (let index = 0; index < 10; index += 1) {
      recordChartSeriesSelectedEvent({
        chartId: "default",
        quantity: `q${index}`,
        resourceKey: tableRowsResourceKey("default"),
        seriesId: `series-${index}`,
        tableId: "default",
      });
    }

    const events = window.__FULLMAG_CHART_DIAGNOSTICS__?.seriesSelectedEvents;
    expect(events).toHaveLength(8);
    expect(events?.[0]?.seriesId).toBe("series-2");
    expect(events?.at(-1)?.seriesId).toBe("series-9");
  });
});
