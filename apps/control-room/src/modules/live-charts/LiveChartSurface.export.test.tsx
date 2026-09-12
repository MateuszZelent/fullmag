import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { findElements, installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { exportChartData } from "@/shared/analysis-charts/chartExport";
import { LiveChartSurface } from "./components/LiveChartSurface";

const rendererCompletions = vi.hoisted(() => new Map<string, () => void>());
const rendererDataModels = vi.hoisted(() => new Map<string, import("@/shared/analysis-charts/chartRenderer").ChartRenderModel>());
vi.mock("@/shared/analysis-charts/chartExport", () => ({ exportChartData: vi.fn(() => true) }));
vi.mock("@/shared/analysis-charts/InteractiveChartSurface", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/shared/analysis-charts/InteractiveChartSurface")>(),
  InteractiveChartSurface: (props: import("@/shared/analysis-charts/InteractiveChartSurface").InteractiveChartSurfaceProps) => {
    if (props.onRequestedExportHandled) rendererCompletions.set(props.surface.chartId, props.onRequestedExportHandled);
    if (props.dataExportModel) rendererDataModels.set(props.surface.chartId, props.dataExportModel);
    return null;
  },
}));

describe("Live Charts export ownership", () => {
  it("waits for all unit panes before acknowledging the PNG command", async () => {
    const dom = installSimulationPreparationTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as HTMLElement);
    const handled = vi.fn();
    rendererCompletions.clear();
    rendererDataModels.clear();
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
        requestedExportRequest={{ format: "png", requestId: "png-1" }} series={series} selectedSeriesIds={series.map((item) => item.id)}
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
    const failed = vi.fn();
    vi.mocked(exportChartData).mockClear();
    vi.mocked(exportChartData).mockReturnValue(true);
    rendererDataModels.clear();
    const series = ["1", "J", "A/m"].map((unit, index) => ({
      id: `signal-${index}`, label: `Signal ${index}`, quantity: `q${index}`, unit, xUnit: "s",
      points: [{ x: 1e-9, y: index + 1, rowIndex: 0 }],
      source: { kind: "data.table.rows" as const, resourceKey: "table", tableId: "default" }, status: "ready" as const,
    }));
    try {
      await act(async () => root.render(<LiveChartSurface
        fitRequest={0} onChartSelected={() => undefined} onExport={() => undefined}
        onPointSelected={() => undefined} onRangeSelected={() => undefined} onSeriesChange={() => undefined}
        onRequestedExportFailed={failed} onRequestedExportHandled={handled} presentation={{ kind: "ready", revision: 1 }}
        requestedExportRequest={{ format: "csv", requestId: "csv-1" }} series={series} selectedSeriesIds={empty ? [] : series.map((item) => item.id)}
        title="Custom" xAxisLabel="Time"
      />));
      expect(handled).toHaveBeenCalledTimes(1);
      expect(exportChartData).toHaveBeenCalledTimes(empty ? 0 : 1);
      expect(failed).not.toHaveBeenCalled();
      if (!empty) {
        const model = vi.mocked(exportChartData).mock.calls[0][0];
        expect(model.series.map((item) => item.unit)).toEqual(["1", "J", "A/m"]);
        expect(model.yAxes.map((axis) => axis.unit)).toEqual(["1", "J", "A/m"]);
        expect(model.series.map((item) => item.points[0].y)).toEqual([1, 2, 3]);
        await act(async () => root.render(<LiveChartSurface
          fitRequest={0} onChartSelected={() => undefined} onExport={() => undefined}
          onPointSelected={() => undefined} onRangeSelected={() => undefined} onSeriesChange={() => undefined}
          onRequestedExportHandled={handled} presentation={{ kind: "ready", revision: 2 }}
          requestedExportRequest={{ format: "csv", requestId: "csv-1" }} series={series.map((item) => ({ ...item, points: [{ ...item.points[0]!, y: item.points[0]!.y + 1 }] }))} selectedSeriesIds={series.map((item) => item.id)}
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

  it("exports all selected unit families from every pane data toolbar", async () => {
    const dom = installSimulationPreparationTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as HTMLElement);
    const series = ["1", "J"].map((unit, index) => ({
      id: `signal-${index}`, label: `Signal ${index}`, quantity: `q${index}`, unit, xUnit: "s",
      points: [{ x: 1e-9, y: index + 1, rowIndex: 0 }],
      source: { kind: "data.table.rows" as const, resourceKey: "table", tableId: "default" }, status: "ready" as const,
    }));
    rendererDataModels.clear();
    try {
      await act(async () => root.render(<LiveChartSurface
        fitRequest={0} onChartSelected={() => undefined} onExport={() => undefined}
        onPointSelected={() => undefined} onRangeSelected={() => undefined} onSeriesChange={() => undefined}
        onRequestedExportHandled={() => undefined} presentation={{ kind: "ready", revision: 1 }}
        series={series} selectedSeriesIds={series.map((item) => item.id)}
        title="Custom" xAxisLabel="Time"
      />));
      expect(rendererDataModels.size).toBe(2);
      expect([...rendererDataModels.values()].every((model) => model.series.map((item) => item.id).sort().join(",") === "signal-0,signal-1")).toBe(true);
      expect([...rendererDataModels.values()].every((model) => model.yAxes.map((axis) => axis.unit).join(",") === "1,J")).toBe(true);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("fails a data export command when serialization or download reports failure", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as HTMLElement);
    const handled = vi.fn();
    const failed = vi.fn();
    const series = [{
      id: "signal-0", label: "Signal", quantity: "q", unit: "1", xUnit: "s",
      points: [{ x: 1e-9, y: 1, rowIndex: 0 }],
      source: { kind: "data.table.rows" as const, resourceKey: "table", tableId: "default" }, status: "ready" as const,
    }];
    vi.mocked(exportChartData).mockReturnValue(false);
    try {
      await act(async () => root.render(<LiveChartSurface
        fitRequest={0} onChartSelected={() => undefined} onExport={() => undefined}
        onPointSelected={() => undefined} onRangeSelected={() => undefined} onSeriesChange={() => undefined}
        onRequestedExportFailed={failed} onRequestedExportHandled={handled} presentation={{ kind: "ready", revision: 1 }}
        requestedExportRequest={{ format: "csv", requestId: "csv-failure-1" }}
        exportErrorFormat="csv" series={series} selectedSeriesIds={series.map((item) => item.id)} title="Custom" xAxisLabel="Time"
      />));
      expect(handled).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalledOnce();
      const alerts = findElements(container, (element) => element.getAttribute("role") === "alert");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.textContent).toContain("CSV export failed");
    } finally {
      vi.mocked(exportChartData).mockReturnValue(true);
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("treats consecutive same-format requests as separate commands", async () => {
    const dom = installSimulationPreparationTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as HTMLElement);
    const handled = vi.fn();
    const series = [{
      id: "signal-0", label: "Signal", quantity: "q", unit: "1", xUnit: "s",
      points: [{ x: 1e-9, y: 1, rowIndex: 0 }],
      source: { kind: "data.table.rows" as const, resourceKey: "table", tableId: "default" }, status: "ready" as const,
    }];
    vi.mocked(exportChartData).mockClear();
    vi.mocked(exportChartData).mockReturnValue(true);
    try {
      await act(async () => root.render(<LiveChartSurface
        fitRequest={0} onChartSelected={() => undefined} onExport={() => undefined}
        onPointSelected={() => undefined} onRangeSelected={() => undefined} onSeriesChange={() => undefined}
        onRequestedExportHandled={handled} presentation={{ kind: "ready", revision: 1 }}
        requestedExportRequest={{ format: "csv", requestId: "csv-repeat-1" }}
        series={series} selectedSeriesIds={series.map((item) => item.id)} title="Custom" xAxisLabel="Time"
      />));
      await act(async () => root.render(<LiveChartSurface
        fitRequest={0} onChartSelected={() => undefined} onExport={() => undefined}
        onPointSelected={() => undefined} onRangeSelected={() => undefined} onSeriesChange={() => undefined}
        onRequestedExportHandled={handled} presentation={{ kind: "ready", revision: 1 }}
        requestedExportRequest={{ format: "csv", requestId: "csv-repeat-2" }}
        series={series} selectedSeriesIds={series.map((item) => item.id)} title="Custom" xAxisLabel="Time"
      />));
      expect(exportChartData).toHaveBeenCalledTimes(2);
      expect(handled).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
