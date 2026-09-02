import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";

const renderedFormats: Array<string | null> = [];
const renderedRequests: Array<{ chartId: string; format: string | null }> = [];
const renderedRanges: Array<{ fromValue: number; toValue: number } | null> = [];
const renderedProvenance: Array<Record<string, unknown> | undefined> = [];

vi.mock("@/shared/analysis-charts/InteractiveChartSurface", () => ({
  InteractiveChartSurface: ({ initialRange, requestedExportFormat, surface }: { initialRange: { fromValue: number; toValue: number } | null; requestedExportFormat: string | null; surface: { chartId: string; provenance?: Record<string, unknown> } }) => {
    renderedFormats.push(requestedExportFormat);
    renderedRequests.push({ chartId: surface.chartId, format: requestedExportFormat });
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
