import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { findElement, installSimulationPreparationTestDom, TestElement } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { updateRealtimeCommunicationPolicy } from "@/kernel/realtime/communicationPolicy";
import type { KernelApi } from "@/kernel/types";
import { liveChartPreferencesStore } from "@/kernel/workspace/liveChartPreferences";
import { resetLiveChartsWorkspaceForTests } from "@/kernel/workspace/liveChartsWorkspace";

import { LiveChartSurface } from "./components/LiveChartSurface";
import { useLiveChartsController } from "./useLiveChartsController";

function MountedLiveChartSurface() {
  return <LiveChartSurface {...useLiveChartsController()} />;
}

const columns = [
  { column_id: "step", label: "step", unit: "1" },
  { column_id: "mx", label: "mx", unit: "1" },
  { column_id: "my", label: "my", unit: "1" },
  { column_id: "mz", label: "mz", unit: "1" },
];

describe("LiveChartsModule resource flow", () => {
  it("uses revision invalidation for live rows and keeps exact values locally while paused", async () => {
    const dom = installSimulationPreparationTestDom();
    updateRealtimeCommunicationPolicy({ table_rows_min_refetch_ms: 1 });
    liveChartPreferencesStore.resetForTests(null);
    resetLiveChartsWorkspaceForTests();
    const rowsBinary = vi.fn(async () => ({
      data: { columnCount: 4, cursorEnd: 1, cursorStart: 1, resyncRequired: false, revision: 1, rowCount: 1, schemaRevision: 1, totalRows: 1, values: new Float64Array([1, 0.97982, 0.10317, 4.447e-6]) },
      status: "ready" as const,
    }));
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const kernel = {
      api: {
        data: { tables: { columns: vi.fn(async () => columns), detail: vi.fn(async () => ({ revision: 1 })), list: vi.fn(async () => ({ revision: 1, tables: [{ table_id: "default" }] })), rowsBinary } },
        simulation: { solver: { energies: { history: vi.fn(async () => ({ revision: 1, rows: [], returned_rows: 0, total_rows: 0 })) } } },
      },
      bus,
      diagnosticRecorder: new DiagnosticRecorderController({ config: { enabled: false } }),
      resources,
    } as unknown as KernelApi;
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    await act(async () => { root.render(<KernelContext.Provider value={kernel}><MountedLiveChartSurface /></KernelContext.Provider>); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(rowsBinary).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Updating");
    expect(container.textContent).toContain("0.97982");
    expect(container.textContent).toContain("0.10317");
    expect(container.textContent).toContain("4.4470e-6");
    await act(async () => {
      resources.invalidatePrefix("/v2/sessions/current/data/tables/default/rows", 2);
      resources.invalidatePrefix("/v2/sessions/current/data/tables/default/rows", 3);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(rowsBinary).toHaveBeenCalledTimes(2);
    const legend = findElement(container, (element) => element.getAttribute("aria-label")?.startsWith("my,") ?? false, "my legend") as TestElement;
    const beforeToggle = rowsBinary.mock.calls.length;
    await act(async () => legend.click());
    expect(rowsBinary).toHaveBeenCalledTimes(beforeToggle);
    await act(async () => {
      liveChartPreferencesStore.updateDescriptor("magnetization", () => ({ liveMode: "paused" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => resources.invalidatePrefix("/v2/sessions/current/data/tables/default/rows", 4));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(rowsBinary).toHaveBeenCalledTimes(beforeToggle);
    expect(container.textContent).toContain("0.97982");
    await act(async () => {
      liveChartPreferencesStore.updateDescriptor("magnetization", () => ({ liveMode: "following" }));
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(rowsBinary).toHaveBeenCalledTimes(beforeToggle + 1);
    await act(async () => root.unmount());
    dom.restore();
    updateRealtimeCommunicationPolicy({ table_rows_min_refetch_ms: 1000 });
  });
});
