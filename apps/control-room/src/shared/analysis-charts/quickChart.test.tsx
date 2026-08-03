import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { chartTableWindowFromBinary } from "@/shared/domain/analysis/chartDataPlan";

import {
  buildQuickChartRenderModel,
  quickChartColumnIdsForQuery,
} from "./quickChart";
import { chartRenderModelToEChartsOption } from "./chartRenderer";
import {
  QuickChartView,
  quickChartKeyboardPoints,
  quickChartSelectionFromEvent,
  quickChartSelectionFromKeyboard,
} from "./QuickChartView";

const seriesId = "data.table:default:step:mx";
const descriptor = {
  chartId: "default",
  displayUnits: { mx: "1" },
  range: null,
  resourceKey: "data.table:default",
  selectedSeriesIds: [seriesId],
  tableId: "default",
  xAxisId: "step",
};

describe("Quick Chart", () => {
  it("queries only schema-published columns required by full series identities", () => {
    expect(quickChartColumnIdsForQuery(
      [
        { column_id: "step" },
        { column_id: "mx" },
        { column_id: "e_total" },
      ],
      {
        ...descriptor,
        selectedSeriesIds: [
          seriesId,
          "data.table:default:step:my",
          seriesId,
          "data.table:default:step:e_total",
        ],
      },
    )).toEqual(["step", "mx", "e_total"]);

    expect(quickChartColumnIdsForQuery([{ column_id: "mx" }], descriptor)).toEqual([]);
  });

  it("reports an unsupported selection instead of pretending absent quantities are empty data", () => {
    const model = buildQuickChartRenderModel({
      descriptor,
      status: "unsupported",
      window: null,
    });

    expect(model.status).toBe("unsupported");
    expect(model.statusMessage).toContain("not available");
  });

  it("keeps an explicit zero-series selection as a stable local empty state", () => {
    const model = buildQuickChartRenderModel({
      descriptor: { ...descriptor, selectedSeriesIds: [] },
      status: "ready",
      window: null,
    });

    expect(model.status).toBe("empty");
    expect(model.statusMessage).toBe("Select at least one signal");
    expect(model.series).toEqual([]);
  });

  it("builds a neutral model from the shared bounded columnar window", () => {
    const window = chartTableWindowFromBinary({
      columns: [
        { column_id: "step", label: "Step", unit: "1" },
        { column_id: "mx", label: "mx", unit: "1" },
      ],
      decoded: {
        columnCount: 2,
        cursorEnd: 2,
        cursorStart: 1,
        resyncRequired: false,
        revision: 4,
        rowCount: 2,
        schemaRevision: 1,
        totalRows: 2,
        values: new Float64Array([1, 0.1, 2, 0.2]),
      },
      tableId: "default",
    });
    const model = buildQuickChartRenderModel({ descriptor, status: "ready", window });
    expect(model.key).toContain("data.table:default@4");
    expect(model.provenance?.displayUnits).toEqual({ [`y:${seriesId}`]: "1" });
    expect(model.series[0]?.id).toBe(seriesId);
    expect(model.series[0]?.points).toEqual([
      { rowIndex: 0, x: 1, y: 0.1 },
      { rowIndex: 1, x: 2, y: 0.2 },
    ]);
    expect(buildQuickChartRenderModel({
      descriptor: { ...descriptor, selectedSeriesIds: [seriesId, seriesId] },
      status: "ready",
      window,
    }).series).toHaveLength(1);
    expect(renderToStaticMarkup(<QuickChartView model={model} />)).toContain("Quick Chart");
    expect(quickChartSelectionFromEvent({ data: [2, 0.2, 1], seriesIndex: 0 }, model)).toEqual({ rowIndex: 1, seriesId, x: 2, y: 0.2 });
    const points = quickChartKeyboardPoints(model);
    expect(quickChartSelectionFromKeyboard("ArrowRight", 0, points)).toEqual({
      cursor: 1,
      selection: { rowIndex: 1, seriesId, x: 2, y: 0.2 },
    });
    expect(quickChartSelectionFromKeyboard("Home", 1, points)?.cursor).toBe(0);
    expect(quickChartSelectionFromKeyboard("End", 0, points)?.cursor).toBe(1);
    expect(quickChartSelectionFromKeyboard("Escape", 0, points)).toBeNull();
  });

  it("maps quantity display preferences to full series IDs used by the real renderer", () => {
    const fieldSeriesId = "data.table:field:step:H";
    const window = chartTableWindowFromBinary({
      columns: [
        { column_id: "step", label: "Step", unit: "1" },
        { column_id: "H", label: "Field", unit: "T" },
      ],
      decoded: {
        columnCount: 2,
        cursorEnd: 1,
        cursorStart: 1,
        resyncRequired: false,
        revision: 5,
        rowCount: 1,
        schemaRevision: 1,
        totalRows: 1,
        values: new Float64Array([1, 0.10317]),
      },
      tableId: "field",
    });
    const model = buildQuickChartRenderModel({
      descriptor: {
        chartId: "field",
        displayUnits: { H: "mT" },
        range: null,
        resourceKey: "data.table:field",
        selectedSeriesIds: [fieldSeriesId],
        tableId: "field",
        xAxisId: "step",
      },
      status: "ready",
      window,
    });
    const option = chartRenderModelToEChartsOption(model);

    expect(model.provenance?.displayUnits).toEqual({ [`y:${fieldSeriesId}`]: "mT" });
    expect(option.yAxis).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Field [mT]" })]));
    const axisFormatter = (option.yAxis as Array<{ axisLabel?: { formatter?: (value: number) => string } }>)[0]?.axisLabel?.formatter;
    expect(axisFormatter?.(0.10317)).toBe("103.2");
    expect(option.series).toEqual(expect.arrayContaining([
      expect.objectContaining({ data: [[1, 0.10317, 0]] }),
    ]));
  });
});
