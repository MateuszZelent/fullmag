import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { useTableRowsBinaryResource } from "@/kernel/resources/studyRuntimeResources";
import type { KernelApi } from "@/kernel/types";
import {
  findElement,
  installSimulationPreparationTestDom,
  TestElement,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { AnalysisTableSurface } from "@/modules/analysis-plots/components/AnalysisTableSurface";

describe("chart legend local selection", () => {
  it("does not refetch rowsBinary when a mounted legend click changes the rendered subset", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const rowsBinary = vi.fn(async () => ({ data: null, revision: null, status: "ready" }));
    const bus = new EventBus<KernelEventMap>();
    const kernel = {
      api: { data: { tables: { rowsBinary } } },
      bus,
      diagnosticRecorder: new DiagnosticRecorderController({ config: { enabled: false } }),
      resources: new ResourceInvalidationController(bus),
    } as unknown as KernelApi;
    const root = createRoot(container as unknown as Element);

    function Harness() {
      useTableRowsBinaryResource("default", { columns: ["step", "mx", "my"] });
      const [selected, setSelected] = useState(["data.table:default:step:mx", "data.table:default:step:my"]);
      return <AnalysisTableSurface chartSeries={series} kernel={kernel} onPointSelect={() => undefined} onRangeChange={() => undefined} onSelectedSeriesIdsChange={setSelected} range={null} selectedPoint={null} selectedSeriesIds={selected} status="ready" table={null} xAxisId="step" xAxisLabel="step" />;
    }

    await act(async () => root.render(<KernelContext.Provider value={kernel}><Harness /></KernelContext.Provider>));
    await act(async () => { await Promise.resolve(); });
    const initialCalls = rowsBinary.mock.calls.length;
    expect(initialCalls).toBeGreaterThan(0);
    expect(container.textContent).toContain("mx");
    expect(container.textContent).toContain("my");
    const mx = findElement(container, (element) => element.getAttribute("aria-label")?.startsWith("mx,") ?? false, "mx legend") as TestElement;
    await act(async () => mx.click());
    expect(rowsBinary).toHaveBeenCalledTimes(initialCalls);
    expect(container.textContent).toContain("my");
    await act(async () => root.unmount());
    dom.restore();
  });
});

const series = [
  { id: "data.table:default:step:mx", label: "mx", points: [{ rowIndex: 0, x: 0, y: 1 }], quantity: "mx", source: { kind: "data.table.rows" as const, resourceKey: "data", tableId: "default" }, status: "ready" as const, unit: "1", xUnit: "1" },
  { id: "data.table:default:step:my", label: "my", points: [{ rowIndex: 0, x: 0, y: 2 }], quantity: "my", source: { kind: "data.table.rows" as const, resourceKey: "data", tableId: "default" }, status: "ready" as const, unit: "1", xUnit: "1" },
];
