import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";

const harness = vi.hoisted(() => ({
  exportChartData: vi.fn(),
  exportChartPng: vi.fn(() => true),
  fitView: vi.fn(),
  onRendererReady: null as (() => void) | null,
  pngReady: null as boolean | null,
}));

vi.mock("./ChartExportControls", () => ({
  ChartExportControls: ({ pngReady }: { pngReady?: boolean }) => {
    harness.pngReady = pngReady ?? null;
    return null;
  },
  exportChartData: harness.exportChartData,
  exportChartPng: harness.exportChartPng,
}));

vi.mock("./EChartsCanvasSurface", () => ({
  EChartsCanvasSurface: ({ exportRef, onRendererReady }: { exportRef?: { current: unknown }; onRendererReady?: () => void }) => {
    harness.onRendererReady = () => {
      if (exportRef) exportRef.current = { fitView: harness.fitView };
      onRendererReady?.();
    };
    return null;
  },
}));

import { InteractiveChartSurface } from "./InteractiveChartSurface";

const series = [{
  id: "analysis:mx",
  label: "m_x",
  points: [{ rowIndex: 0, x: 0, y: 1 }],
  quantity: "mx",
  source: { kind: "data.table.rows" as const, resourceKey: "data", tableId: "default" },
  status: "ready" as const,
  unit: "1",
  xUnit: "s",
}];

const surface = {
  ariaLabel: "Live magnetization",
  chartId: "live:magnetization",
  presentationCopy: { empty: "No samples", error: "Unavailable", loading: "Loading" },
  provenance: { dataRevision: 7, decimation: "tail", descriptorId: "live:magnetization", query: "tail=100", resourceKey: "live/magnetization" },
};

afterEach(() => {
  harness.exportChartData.mockClear();
  harness.exportChartPng.mockClear();
  harness.fitView.mockClear();
  harness.onRendererReady = null;
  harness.pngReady = null;
});

describe("InteractiveChartSurface export lifecycle", () => {
  it("waits for the renderer before exporting PNG and handles one request once", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as HTMLElement);
    const handled = vi.fn();
    harness.exportChartPng.mockReturnValueOnce(false);

    try {
      await act(async () => {
        root.render(
          <InteractiveChartSurface
            fitRequest={1}
            onRequestedExportHandled={handled}
            requestedExportFormat="png"
            series={series}
            surface={surface}
          />,
        );
      });
      expect(harness.exportChartPng).not.toHaveBeenCalled();
      expect(handled).not.toHaveBeenCalled();
      expect(harness.pngReady).toBe(false);
      expect(harness.fitView).not.toHaveBeenCalled();

      await act(async () => {
        harness.onRendererReady?.();
      });

      expect(harness.exportChartPng).toHaveBeenCalledOnce();
      expect(handled).not.toHaveBeenCalled();
      expect(harness.pngReady).toBe(true);
      expect(harness.fitView).toHaveBeenCalledOnce();

      await act(async () => {
        root.render(
          <InteractiveChartSurface
            fitRequest={1}
            onRequestedExportHandled={handled}
            requestedExportFormat="png"
            series={series}
            surface={{ ...surface }}
          />,
        );
      });
      expect(harness.exportChartPng).toHaveBeenCalledTimes(2);
      expect(handled).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
