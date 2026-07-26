import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { chartTableWindowFromBinary } from "@/shared/domain/analysis/chartDataPlan";
import { buildQuickChartRenderModel, quickChartDescriptorFromSelection } from "./quickChart";
import {
  QuickChartView,
  quickChartKeyboardPoints,
  quickChartSelectionFromEvent,
  quickChartSelectionFromKeyboard,
} from "./QuickChartView";

const descriptor = { chartId: "default", resourceKey: "data.table:default", tableId: "default", xAxisId: "step", yAxisIds: ["mx"] };

describe("Inspector Quick Chart", () => {
  it("maps chart selections to a payload-free descriptor", () => {
    expect(quickChartDescriptorFromSelection({
      selection: { kind: "analysis.chart", label: "Chart", moduleSource: "analysis-plots", nodeId: "chart", objectId: null, ref: { chartId: "default", kind: "analysis.chart", nodeId: "chart", tableId: "default", type: "analysis-chart" } },
      xAxisId: "step",
      yAxisIds: ["mx"],
    })).toEqual(descriptor);
  });

  it("builds a neutral model from the shared bounded columnar window", () => {
    const window = chartTableWindowFromBinary({
      columns: [{ column_id: "step", label: "Step", unit: "1" }, { column_id: "mx", label: "mx", unit: "1" }],
      decoded: { columnCount: 2, cursorEnd: 2, cursorStart: 1, resyncRequired: false, revision: 4, rowCount: 2, schemaRevision: 1, totalRows: 2, values: new Float64Array([1, 0.1, 2, 0.2]) },
      tableId: "default",
    });
    const model = buildQuickChartRenderModel({ descriptor, status: "ready", window });
    expect(model.key).toContain("data.table:default@4");
    expect(model.series[0]?.points).toEqual([{ rowIndex: 0, x: 1, y: 0.1 }, { rowIndex: 1, x: 2, y: 0.2 }]);
    expect(renderToStaticMarkup(<QuickChartView model={model} />)).toContain("Inspector Quick Chart");
    expect(quickChartSelectionFromEvent({ data: [2, 0.2, 1], seriesIndex: 0 }, model)).toEqual({ rowIndex: 1, seriesId: "mx", x: 2, y: 0.2 });
    const points = quickChartKeyboardPoints(model);
    expect(quickChartSelectionFromKeyboard("ArrowRight", 0, points)).toEqual({
      cursor: 1,
      selection: { rowIndex: 1, seriesId: "mx", x: 2, y: 0.2 },
    });
    expect(quickChartSelectionFromKeyboard("Home", 1, points)?.cursor).toBe(0);
    expect(quickChartSelectionFromKeyboard("End", 0, points)?.cursor).toBe(1);
    expect(quickChartSelectionFromKeyboard("Escape", 0, points)).toBeNull();
  });
});
