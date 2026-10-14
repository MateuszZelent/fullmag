import { afterEach, describe, expect, it, vi } from "vitest";

import { DATA_TABLE_ROWS_PATH } from "../../../kernel/api/apiPaths";
import {
  clearChartDispatchSeriesRequest,
  recordChartRangeSelectedEvent,
  recordChartDispatchSeriesRequest,
  recordChartModelBuilt,
  recordChartSeriesSelectedEvent,
  registerRenderedChartDiagnostics,
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

  it("measures model builds and point counts only when diagnostics are enabled", () => {
    vi.stubGlobal("window", {
      __FULLMAG_ENABLE_CHART_DIAGNOSTICS__: true,
    });

    recordChartModelBuilt([
      { points: [[0, 1], [1, 2]] },
      { points: [[0, 3]] },
    ]);
    recordChartModelBuilt([{ points: [[0, 4]] }]);

    expect(window.__FULLMAG_CHART_DIAGNOSTICS__).toMatchObject({
      modelBuilds: 2,
      plannedPoints: 4,
      renderedPoints: 1,
    });
  });

  it("does not allocate diagnostics when model measurement is disabled", () => {
    vi.stubGlobal("window", {
      __FULLMAG_ENABLE_CHART_DIAGNOSTICS__: false,
    });

    recordChartModelBuilt([{ points: [[0, 1]] }]);

    expect(window.__FULLMAG_CHART_DIAGNOSTICS__).toBeUndefined();
  });

  it("reads the applied option on demand and captures the actual click tuple", () => {
    vi.stubGlobal("window", {
      __FULLMAG_ENABLE_CHART_DIAGNOSTICS__: true,
    });
    const handlers = new Map<string, (event: unknown) => void>();
    const option = { series: [{ data: [[1, 2, 3], [2, null, null], [2, 4, 5]] }] };
    const chart = {
      convertToPixel: vi.fn(() => [40, 50]),
      getDom: () => ({ getBoundingClientRect: () => ({ left: 10, top: 20 }) }),
      getOption: vi.fn(() => option),
      off: vi.fn((name: string, handler: (event: unknown) => void) => {
        handlers.delete(name);
        void handler;
      }),
      on: vi.fn((name: string, handler: (event: unknown) => void) => {
        handlers.set(name, handler);
      }),
    };

    const cleanup = registerRenderedChartDiagnostics(chart as never);
    const registeredClick = handlers.get("click");
    expect(window.__FULLMAG_CHART_DIAGNOSTICS__?.readRenderedOption?.()).toBe(option);
    expect(window.__FULLMAG_CHART_DIAGNOSTICS__?.resolveRenderedDataPoint?.(0, 2)).toEqual({
      data: [2, 4, 5],
      dataIndex: 2,
      seriesIndex: 0,
      x: 50,
      y: 70,
    });
    expect(chart.convertToPixel).toHaveBeenCalledWith({ seriesIndex: 0 }, [2, 4, 5]);
    registeredClick?.({
      data: [2, 4, 5],
      dataIndex: 2,
      seriesIndex: 0,
    });
    expect(window.__FULLMAG_CHART_DIAGNOSTICS__?.lastRenderedClick).toEqual({
      data: [2, 4, 5],
      dataIndex: 2,
      seriesIndex: 0,
      sourceRowIndex: 5,
    });

    cleanup();

    expect(chart.off).toHaveBeenCalledWith("click", registeredClick);
    expect(window.__FULLMAG_CHART_DIAGNOSTICS__?.readRenderedOption).toBeUndefined();
    expect(window.__FULLMAG_CHART_DIAGNOSTICS__?.resolveRenderedDataPoint).toBeUndefined();
    expect(window.__FULLMAG_CHART_DIAGNOSTICS__?.lastRenderedClick).toBeUndefined();
  });

  it("does not register option readers or listeners when diagnostics are disabled", () => {
    vi.stubGlobal("window", {
      __FULLMAG_ENABLE_CHART_DIAGNOSTICS__: false,
    });
    const chart = {
      convertToPixel: vi.fn(),
      getDom: vi.fn(),
      getOption: vi.fn(() => ({})),
      off: vi.fn(),
      on: vi.fn(),
    };

    registerRenderedChartDiagnostics(chart as never)();

    expect(chart.getOption).not.toHaveBeenCalled();
    expect(chart.convertToPixel).not.toHaveBeenCalled();
    expect(chart.getDom).not.toHaveBeenCalled();
    expect(chart.on).not.toHaveBeenCalled();
    expect(chart.off).not.toHaveBeenCalled();
    expect(window.__FULLMAG_CHART_DIAGNOSTICS__).toBeUndefined();
  });

  it("does not let an older chart cleanup clear the newer chart reader or click", () => {
    vi.stubGlobal("window", {
      __FULLMAG_ENABLE_CHART_DIAGNOSTICS__: true,
    });
    const handlers = new Map<string, Array<(event: unknown) => void>>();
    const createChart = (option: unknown) => ({
      convertToPixel: vi.fn(() => [10, 20]),
      getDom: () => ({ getBoundingClientRect: () => ({ left: 1, top: 2 }) }),
      getOption: vi.fn(() => option),
      off: vi.fn((name: string, handler: (event: unknown) => void) => {
        handlers.set(name, (handlers.get(name) ?? []).filter((entry) => entry !== handler));
      }),
      on: vi.fn((name: string, handler: (event: unknown) => void) => {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      }),
    });
    const firstChart = createChart({ series: [{ id: "first", data: [[5, 6, 7]] }] });
    const secondChart = createChart({ series: [{ id: "second", data: [[8, 9, 10]] }] });
    const cleanupFirst = registerRenderedChartDiagnostics(firstChart as never);
    const cleanupSecond = registerRenderedChartDiagnostics(secondChart as never);

    handlers.get("click")?.at(-1)?.({
      data: [5, 6, 7],
      dataIndex: 2,
      seriesIndex: 0,
    });
    cleanupFirst();

    expect(window.__FULLMAG_CHART_DIAGNOSTICS__?.readRenderedOption?.()).toEqual({
      series: [{ id: "second", data: [[8, 9, 10]] }],
    });
    expect(window.__FULLMAG_CHART_DIAGNOSTICS__?.resolveRenderedDataPoint?.(0, 0)).toMatchObject({
      data: [8, 9, 10],
      x: 11,
      y: 22,
    });
    expect(window.__FULLMAG_CHART_DIAGNOSTICS__?.lastRenderedClick).toMatchObject({
      dataIndex: 2,
      seriesIndex: 0,
      sourceRowIndex: 7,
    });
    cleanupSecond();
    expect(window.__FULLMAG_CHART_DIAGNOSTICS__?.resolveRenderedDataPoint).toBeUndefined();
  });
});
