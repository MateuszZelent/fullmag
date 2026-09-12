import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { exportChartData } from "@/shared/analysis-charts/ChartExportControls";
import { LiveChartSurface } from "./components/LiveChartSurface";

const rendererCompletions = vi.hoisted(() => new Map<string, () => void>());
vi.mock("@/shared/analysis-charts/ChartExportControls", () => ({ exportChartData: vi.fn() }));
vi.mock("@/shared/analysis-charts/InteractiveChartSurface", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/shared/analysis-charts/InteractiveChartSurface")>(),
  InteractiveChartSurface: (props: import("@/shared/analysis-charts/InteractiveChartSurface").InteractiveChartSurfaceProps) => {
    if (props.onRequestedExportHandled) rendererCompletions.set(props.surface.chartId, props.onRequestedExportHandled);
    return null;
  },
}));

describe("Live Charts export ownership", () => {
  it("waits for all unit panes before acknowledging the PNG command", async () => {
    const dom = installSimulationPreparationTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as HTMLElement);
    const handled = vi.fn();
    rendererCompletions.clear();
    const series = ["1", "J"].map((unit, index) => ({
      id: `signal-${index}`, label: `Signal ${index}`, quantity: `q${index}`, unit, xUnit: "s",
      points: [{ x: 1e-9, y: index + 1, rowIndex: 0 }],
      source: { kind: "data.table.rows" as const, resourceKey: "table", tableId: "default" }, status: "ready" as const,
    }));
    try {
      await act(async () => root.render(<LiveChartSurface
        fitRequest={0} onChartSelected={() => undefined} onExport={() => undefined}
        onPointSelected={() => undefined} onRangeSelected={() => undefined} onSeriesChange={() => undefined}
        onRequestedExportHandled={handled} presentation={{ kind: "ready", revision: 1 }}
        requestedExportFormat="png" series={series} selectedSeriesIds={series.map((item) => item.id)}
        title="Custom" xAxisLabel="Time"
      />));
      const callbacks = [...rendererCompletions.values()];
      expect(callbacks).toHaveLength(2);
      expect(handled).not.toHaveBeenCalled();
      callbacks[1]();
      expect(handled).not.toHaveBeenCalled();
      callbacks[0]();
      expect(handled).toHaveBeenCalledTimes(1);
      callbacks[0]();
      expect(handled).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
  it.each([false, true])("acknowledges a CSV command exactly once (empty selection: %s)", async (empty) => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as HTMLElement);
    const handled = vi.fn();
    vi.mocked(exportChartData).mockClear();
    const series = ["1", "J", "A/m"].map((unit, index) => ({
      id: `signal-${index}`, label: `Signal ${index}`, quantity: `q${index}`, unit, xUnit: "s",
      points: [{ x: 1e-9, y: index + 1, rowIndex: 0 }],
      source: { kind: "data.table.rows" as const, resourceKey: "table", tableId: "default" }, status: "ready" as const,
    }));
    try {
      await act(async () => root.render(<LiveChartSurface
        fitRequest={0} onChartSelected={() => undefined} onExport={() => undefined}
        onPointSelected={() => undefined} onRangeSelected={() => undefined} onSeriesChange={() => undefined}
        onRequestedExportHandled={handled} presentation={{ kind: "ready", revision: 1 }}
        requestedExportFormat="csv" series={series} selectedSeriesIds={empty ? [] : series.map((item) => item.id)}
        title="Custom" xAxisLabel="Time"
      />));
      expect(handled).toHaveBeenCalledTimes(1);
      expect(exportChartData).toHaveBeenCalledTimes(empty ? 0 : 1);
      if (!empty) {
        const model = vi.mocked(exportChartData).mock.calls[0][0];
        expect(model.series.map((item) => item.unit)).toEqual(["1", "J", "A/m"]);
        expect(model.yAxes.map((axis) => axis.unit)).toEqual(["1", "J", "A/m"]);
        expect(model.series.map((item) => item.points[0].y)).toEqual([1, 2, 3]);
        await act(async () => root.render(<LiveChartSurface
          fitRequest={0} onChartSelected={() => undefined} onExport={() => undefined}
          onPointSelected={() => undefined} onRangeSelected={() => undefined} onSeriesChange={() => undefined}
          onRequestedExportHandled={handled} presentation={{ kind: "ready", revision: 2 }}
          requestedExportFormat="csv" series={series.map((item) => ({ ...item, points: [{ ...item.points[0]!, y: item.points[0]!.y + 1 }] }))} selectedSeriesIds={series.map((item) => item.id)}
          title="Custom" xAxisLabel="Time"
        />));
        expect(exportChartData).toHaveBeenCalledTimes(1);
        expect(handled).toHaveBeenCalledTimes(1);
      }
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
