import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";

const renderedFormats: Array<string | null> = [];
const renderedRequests: Array<{ chartId: string; format: string | null }> = [];
const renderedRequestIds: Array<string | null> = [];
const renderedHandledCallbacks = new Map<string, () => void>();
const renderedRanges: Array<{ fromValue: number; toValue: number } | null> = [];
const renderedProvenance: Array<Record<string, unknown> | undefined> = [];

vi.mock("@/shared/analysis-charts/InteractiveChartSurface", () => ({
  InteractiveChartSurface: ({ initialRange, onRequestedExportHandled, requestedExportRequest, surface }: { initialRange: { fromValue: number; toValue: number } | null; onRequestedExportHandled?: () => void; requestedExportRequest?: { format: string; requestId: string } | null; surface: { chartId: string; provenance?: Record<string, unknown> } }) => {
    const format = requestedExportRequest?.format ?? null;
    renderedFormats.push(format);
    renderedRequests.push({ chartId: surface.chartId, format });
    renderedRequestIds.push(requestedExportRequest?.requestId ?? null);
    if (requestedExportRequest?.requestId && onRequestedExportHandled) {
      renderedHandledCallbacks.set(requestedExportRequest.requestId, onRequestedExportHandled);
    }
    renderedRanges.push(initialRange);
    renderedProvenance.push(surface.provenance);
    return <div />;
  },
  chartSeriesRenderModel: vi.fn(),
}));

import { EChartsSurface } from "./EChartsSurface";

const series = [{
  id: "data.table:table-a:step:mx",
  label: "mx",
  points: [{ rowIndex: 0, x: 0, y: 1 }],
  quantity: "mx",
  source: { kind: "data.table.rows" as const, resourceKey: "table-a", tableId: "table-a" },
  status: "ready" as const,
  unit: "1",
  xUnit: "1",
}];

describe("Analysis chart export routing", () => {
  it("delivers a CSV request exactly once to the mounted chart with the current Analysis chart identity", async () => {
    renderedFormats.length = 0;
    renderedRequests.length = 0;
    const dom = installSimulationPreparationTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    const bus = new EventBus<KernelEventMap>();
    try {
      await act(async () => root.render(<EChartsSurface bus={bus} chartId="dynamics:table-a" series={series} xAxisLabel="step" />));
      await act(async () => bus.emit("analysis-plots:export-requested", { chartId: "dynamics:table-a", format: "csv", source: "analysis-plots" }));
      await act(async () => bus.emit("analysis-plots:export-requested", { chartId: "comparison:table-a", format: "png", source: "analysis-plots" }));
      expect(renderedFormats.filter((format) => format === "csv")).toHaveLength(1);
      expect(renderedFormats).not.toContain("png");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("retains distinct identities for consecutive same-format bus requests", async () => {
    renderedFormats.length = 0;
    renderedRequests.length = 0;
    renderedRequestIds.length = 0;
    renderedHandledCallbacks.clear();
    const dom = installSimulationPreparationTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    const bus = new EventBus<KernelEventMap>();
    try {
      await act(async () => root.render(<EChartsSurface bus={bus} chartId="dynamics:table-a" series={series} xAxisLabel="step" />));
      await act(async () => bus.emit("analysis-plots:export-requested", { chartId: "dynamics:table-a", format: "csv", source: "analysis-plots" }));
      const firstRequestId = renderedRequestIds.find((requestId): requestId is string => requestId !== null);
      await act(async () => firstRequestId && renderedHandledCallbacks.get(firstRequestId)?.());
      await act(async () => bus.emit("analysis-plots:export-requested", { chartId: "dynamics:table-a", format: "csv", source: "analysis-plots" }));
      expect(renderedFormats.filter((format) => format === "csv")).toHaveLength(2);
      const csvRequestIds = renderedRequestIds.filter((requestId): requestId is string => requestId !== null);
      expect(csvRequestIds).toHaveLength(2);
      expect(csvRequestIds[0]).not.toBe(csvRequestIds[1]);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("queues batched bus requests and drains the next request after acknowledgement", async () => {
    renderedFormats.length = 0;
    renderedRequests.length = 0;
    renderedRequestIds.length = 0;
    renderedHandledCallbacks.clear();
    const dom = installSimulationPreparationTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    const bus = new EventBus<KernelEventMap>();
    try {
      await act(async () => root.render(<EChartsSurface bus={bus} chartId="dynamics:table-a" series={series} xAxisLabel="step" />));
      await act(async () => {
        bus.emit("analysis-plots:export-requested", { chartId: "dynamics:table-a", format: "csv", requestId: "batched-1", source: "analysis-plots" });
        bus.emit("analysis-plots:export-requested", { chartId: "dynamics:table-a", format: "csv", requestId: "batched-2", source: "analysis-plots" });
      });
      expect(renderedRequestIds).toContain("batched-1");
      expect(renderedRequestIds).not.toContain("batched-2");
      await act(async () => renderedHandledCallbacks.get("batched-1")?.());
      expect(renderedRequestIds).toContain("batched-2");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("cancels pending requests when the mounted chart identity changes", async () => {
    renderedFormats.length = 0;
    renderedRequestIds.length = 0;
    renderedHandledCallbacks.clear();
    const dom = installSimulationPreparationTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    const bus = new EventBus<KernelEventMap>();
    try {
      await act(async () => root.render(<EChartsSurface bus={bus} chartId="table-a" series={series} />));
      await act(async () => bus.emit("analysis-plots:export-requested", { chartId: "table-a", format: "csv", requestId: "table-a-pending", source: "analysis-plots" }));
      const staleAck = renderedHandledCallbacks.get("table-a-pending");
      expect(renderedRequestIds).toContain("table-a-pending");

      await act(async () => root.render(<EChartsSurface bus={bus} chartId="table-b" series={series} />));
      expect(renderedRequestIds.at(-1)).toBeNull();
      await act(async () => staleAck?.());
      expect(renderedRequestIds.at(-1)).toBeNull();

      await act(async () => bus.emit("analysis-plots:export-requested", { chartId: "table-b", format: "csv", requestId: "table-b-current", source: "analysis-plots" }));
      expect(renderedRequestIds.at(-1)).toBe("table-b-current");
      expect(renderedRequestIds.filter((requestId) => requestId === "table-a-pending")).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("routes a right comparison-pane export only to its secondary chart identity", async () => {
    renderedRequests.length = 0;
    const dom = installSimulationPreparationTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    const bus = new EventBus<KernelEventMap>();
    try {
      await act(async () => root.render(<><EChartsSurface bus={bus} chartId="comparison:table-a" series={series} /><EChartsSurface bus={bus} chartId="comparison:table-b" series={series} /></>));
      await act(async () => bus.emit("analysis-plots:export-requested", { chartId: "comparison:table-b", format: "png", source: "analysis-plots" }));
      expect(renderedRequests.filter((request) => request.format === "png")).toEqual([{ chartId: "comparison:table-b", format: "png" }]);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("passes a restored persisted range to the shared chart surface on mount", async () => {
    renderedRanges.length = 0;
    const dom = installSimulationPreparationTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    try {
      await act(async () => root.render(<EChartsSurface initialRange={{ fromValue: 1e-9, toValue: 2e-9 }} series={series} />));
      expect(renderedRanges).toContainEqual({ fromValue: 1e-9, toValue: 2e-9 });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("carries result projection export provenance into the shared chart surface", async () => {
    renderedProvenance.length = 0;
    const dom = installSimulationPreparationTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    try {
      await act(async () => root.render(
        <EChartsSurface
          exportProvenance={{
            datasetId: "dataset-1",
            datasetRevision: "dataset-revision-1",
            fixedCoordinates: [],
            projectionId: "response-spectrum",
            projectionRevision: "projection-revision-1",
            runId: "run-1",
            selectionRefs: [],
            stageId: "stage-1",
          }}
          series={series}
        />,
      ));

      expect(renderedProvenance[0]).toMatchObject({
        datasetId: "dataset-1",
        datasetRevision: "dataset-revision-1",
        projectionId: "response-spectrum",
        projectionRevision: "projection-revision-1",
        runId: "run-1",
        stageId: "stage-1",
      });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
