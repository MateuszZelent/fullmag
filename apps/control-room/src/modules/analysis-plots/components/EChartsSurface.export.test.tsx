import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";

const renderedFormats: Array<string | null> = [];

vi.mock("@/shared/analysis-charts/InteractiveChartSurface", () => ({
  InteractiveChartSurface: ({ requestedExportFormat }: { requestedExportFormat: string | null }) => {
    renderedFormats.push(requestedExportFormat);
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
});
