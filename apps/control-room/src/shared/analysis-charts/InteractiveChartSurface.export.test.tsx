import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";

const harness = vi.hoisted(() => ({
  exportChartData: vi.fn(),
  exportChartPng: vi.fn(() => true),
  fitView: vi.fn(),
  onRendererReady: null as (() => void) | null,
  onRendererError: null as (() => void) | null,
  pngReady: null as boolean | null,
}));

vi.mock("./ChartExportControls", () => ({
  ChartExportControls: ({ pngReady }: { pngReady?: boolean }) => {
    harness.pngReady = pngReady ?? null;
    return null;
  },
}));

vi.mock("./chartExport", () => ({
  exportChartData: harness.exportChartData,
  exportChartPng: harness.exportChartPng,
}));

vi.mock("./EChartsCanvasSurface", () => ({
  EChartsCanvasSurface: ({ exportRef, onRendererReady, onRendererError }: { exportRef?: { current: unknown }; onRendererReady?: () => void; onRendererError?: () => void }) => {
    harness.onRendererReady = () => {
      if (exportRef) exportRef.current = { fitView: harness.fitView };
      onRendererReady?.();
    };
    harness.onRendererError = onRendererError ?? null;
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
  harness.onRendererError = null;
  harness.pngReady = null;
});

describe("InteractiveChartSurface export lifecycle", () => {
  it("waits for the renderer before exporting PNG and handles one request once", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as HTMLElement);
    const handled = vi.fn();
    const failed = vi.fn();
    harness.exportChartPng.mockReturnValueOnce(false);

    try {
      await act(async () => {
        root.render(
          <InteractiveChartSurface
            fitRequest={1}
            onRequestedExportHandled={handled}
            onRequestedExportFailed={failed}
            requestedExportRequest={{ format: "png", requestId: "png-1" }}
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
      expect(failed).toHaveBeenCalledOnce();
      expect(harness.pngReady).toBe(true);
      expect(harness.fitView).toHaveBeenCalledOnce();

      await act(async () => {
        root.render(
          <InteractiveChartSurface
            fitRequest={1}
            onRequestedExportHandled={handled}
            requestedExportRequest={{ format: "png", requestId: "png-1" }}
            series={series}
            surface={{ ...surface }}
          />,
        );
      });
      expect(harness.exportChartPng).toHaveBeenCalledOnce();
      expect(failed).toHaveBeenCalledOnce();
      expect(handled).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("uses the request id to process consecutive same-format data exports", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as HTMLElement);
    const handled = vi.fn();
    harness.exportChartData.mockReturnValue(true);
    try {
      await act(async () => root.render(
        <InteractiveChartSurface
          onRequestedExportHandled={handled}
          requestedExportRequest={{ format: "csv", requestId: "csv-1" }}
          series={series}
          surface={surface}
        />,
      ));
      await act(async () => root.render(
        <InteractiveChartSurface
          onRequestedExportHandled={handled}
          requestedExportRequest={{ format: "csv", requestId: "csv-2" }}
          series={series}
          surface={surface}
        />,
      ));
      expect(harness.exportChartData).toHaveBeenCalledTimes(2);
      expect(handled).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("sends a failure acknowledgement when data export throws", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as HTMLElement);
    const handled = vi.fn();
    const failed = vi.fn();
    harness.exportChartData.mockImplementation(() => {
      throw new Error("serialization failed");
    });
    try {
      await act(async () => root.render(
        <InteractiveChartSurface
          onRequestedExportFailed={failed}
          onRequestedExportHandled={handled}
          requestedExportRequest={{ format: "tsv", requestId: "tsv-failure-1" }}
          series={series}
          surface={surface}
        />,
      ));
      expect(handled).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalledOnce();
      await act(async () => root.render(
        <InteractiveChartSurface
          onRequestedExportFailed={failed}
          onRequestedExportHandled={handled}
          requestedExportRequest={{ format: "tsv", requestId: "tsv-failure-1" }}
          series={series}
          surface={surface}
        />,
      ));
      expect(failed).toHaveBeenCalledOnce();
    } finally {
      harness.exportChartData.mockReset();
      harness.exportChartData.mockReturnValue(undefined);
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("releases a failed export through the handled callback when no failure channel is supplied", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as HTMLElement);
    const handled = vi.fn();
    harness.exportChartData.mockReturnValue(false);
    try {
      await act(async () => root.render(
        <InteractiveChartSurface
          onRequestedExportHandled={handled}
          requestedExportRequest={{ format: "csv", requestId: "csv-fallback-1" }}
          series={series}
          surface={surface}
        />,
      ));
      expect(handled).toHaveBeenCalledOnce();
    } finally {
      harness.exportChartData.mockReset();
      harness.exportChartData.mockReturnValue(undefined);
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("fails a pending PNG request once when the renderer reports an error", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as HTMLElement);
    const handled = vi.fn();
    const failed = vi.fn();
    try {
      await act(async () => root.render(
        <InteractiveChartSurface
          onRequestedExportFailed={failed}
          onRequestedExportHandled={handled}
          requestedExportRequest={{ format: "png", requestId: "png-renderer-failure-1" }}
          series={series}
          surface={surface}
        />,
      ));
      await act(async () => harness.onRendererError?.());
      await act(async () => harness.onRendererError?.());
      expect(failed).toHaveBeenCalledOnce();
      expect(handled).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("fails a later PNG request after an import error occurred before the request", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as HTMLElement);
    const handled = vi.fn();
    const failed = vi.fn();
    try {
      await act(async () => root.render(
        <InteractiveChartSurface
          onRequestedExportFailed={failed}
          onRequestedExportHandled={handled}
          series={series}
          surface={surface}
        />,
      ));
      await act(async () => harness.onRendererError?.());
      await act(async () => root.render(
        <InteractiveChartSurface
          onRequestedExportFailed={failed}
          onRequestedExportHandled={handled}
          requestedExportRequest={{ format: "png", requestId: "png-after-import-error-1" }}
          series={series}
          surface={surface}
        />,
      ));
      expect(failed).toHaveBeenCalledOnce();
      expect(handled).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
