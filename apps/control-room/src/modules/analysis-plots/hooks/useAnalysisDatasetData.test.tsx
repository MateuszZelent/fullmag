import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import { DATA_TABLE_ROWS_PATH } from "@/kernel/api/apiPaths";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { resetSharedResourceRuntimeStoreForTests } from "@/kernel/resources/ResourceRuntimeStore";
import { resetRealtimeCommunicationPolicyForTests, updateRealtimeCommunicationPolicy } from "@/kernel/realtime/communicationPolicy";
import type { KernelApi } from "@/kernel/types";

import { resolveAnalysisDatasetTableId, shouldLoadAnalysisDatasetRows, useAnalysisDatasetData } from "./useAnalysisDatasetData";

async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(1); await Promise.resolve(); });
    if (predicate()) return;
  }
  throw new Error("resource request was not observed");
}

function DatasetHarness({ datasetRef, onRevision }: { datasetRef: string | null; onRevision: (revision: string | number | null) => void }) {
  const result = useAnalysisDatasetData({ datasetRef, enabled: true });
  onRevision(result.visibleRevision);
  return null;
}

describe("useAnalysisDatasetData", () => {
  it("does not load table rows without a selected dataset", () => {
    expect(shouldLoadAnalysisDatasetRows({ datasetRef: null, enabled: true, hasSchema: true })).toBe(false);
  });

  it("resolves only an explicit identity published by the table list", () => {
    expect(resolveAnalysisDatasetTableId("table-4", ["table-4"])).toBe("table-4");
    expect(resolveAnalysisDatasetTableId("table:run-7:stage-2:table-4", ["table-4"])).toBeNull();
    expect(resolveAnalysisDatasetTableId("artifact:run-7:result", ["table-4"])).toBeNull();
    expect(shouldLoadAnalysisDatasetRows({ datasetRef: "table:run-7:stage-2:table-4", enabled: true, hasSchema: true })).toBe(true);
  });

  it("pins one mounted dataset snapshot across active invalidations and fetches once for a new dataset", async () => {
    vi.useFakeTimers();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const rowsBinary = vi.fn(async (tableId: string) => ({
      data: { columnCount: 2, cursorEnd: 1, cursorStart: 1, resyncRequired: false, revision: tableId === "table-4" ? 7 : 9, rowCount: 1, schemaRevision: 1, totalRows: 1, values: new Float64Array([0, tableId === "table-4" ? 2 : 3]) },
      status: "ready" as const,
    }));
    const kernel = {
      api: { data: { tables: {
        columns: vi.fn(async () => [{ column_id: "step", label: "step", unit: "1" }, { column_id: "mx", label: "mx", unit: "1" }]),
        detail: vi.fn(async () => ({ revision: 1 })),
        list: vi.fn(async () => ({ revision: 1, tables: [{ table_id: "table-4" }, { table_id: "table-5" }] })),
        rowsBinary,
      } } }, bus, diagnosticRecorder: new DiagnosticRecorderController({ config: { enabled: false } }), resources,
    } as unknown as KernelApi;
    const root = createRoot(container as unknown as Element);
    const revisions: Array<string | number | null> = [];
    try {
      updateRealtimeCommunicationPolicy({ table_rows_min_refetch_ms: 1 });
      await act(async () => root.render(<KernelContext.Provider value={kernel}><DatasetHarness datasetRef="table-4" onRevision={(revision) => revisions.push(revision)} /></KernelContext.Provider>));
      await flushUntil(() => rowsBinary.mock.calls.length === 1 && revisions.includes(7));
      await act(async () => resources.invalidatePrefix(DATA_TABLE_ROWS_PATH.replace("{table_id}", "table-4"), 8));
      await act(async () => { await vi.advanceTimersByTimeAsync(20); });
      expect(rowsBinary).toHaveBeenCalledTimes(1);
      expect(revisions.at(-1)).toBe(7);
      await act(async () => root.render(<KernelContext.Provider value={kernel}><DatasetHarness datasetRef="table-5" onRevision={(revision) => revisions.push(revision)} /></KernelContext.Provider>));
      await flushUntil(() => rowsBinary.mock.calls.length === 2 && revisions.includes(9));
      expect(rowsBinary.mock.calls.map(([tableId]) => tableId)).toEqual(["table-4", "table-5"]);
    } finally {
      await act(async () => root.unmount());
      resources.resetForTests(); resetSharedResourceRuntimeStoreForTests(); resetRealtimeCommunicationPolicyForTests(); vi.useRealTimers(); dom.restore();
    }
  });
});
