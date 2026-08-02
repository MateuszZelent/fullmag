import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { DATA_TABLE_ROWS_PATH } from "@/kernel/api/apiPaths";
import { findElement, installSimulationPreparationTestDom, TestElement } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { resetSharedResourceRuntimeStoreForTests, sharedResourceRuntimeStore } from "@/kernel/resources/ResourceRuntimeStore";
import { resetRealtimeCommunicationPolicyForTests, updateRealtimeCommunicationPolicy } from "@/kernel/realtime/communicationPolicy";
import type { KernelApi } from "@/kernel/types";
import { liveChartPreferencesStore } from "@/kernel/workspace/liveChartPreferences";
import { resetLiveChartsWorkspaceForTests } from "@/kernel/workspace/liveChartsWorkspace";

import { LiveChartSurface } from "./components/LiveChartSurface";
import { useLiveTableData } from "./hooks/useLiveTableData";
import { useLiveChartsController } from "./useLiveChartsController";

function MountedLiveChartSurface() {
  return <LiveChartSurface {...useLiveChartsController()} />;
}

function LiveTableHarness({ active, paused }: { active: boolean; paused: boolean }) {
  useLiveTableData({
    active,
    paused,
    range: { mode: "follow" },
    targetPoints: 800,
    xAxisId: "step",
  });
  return null;
}

async function flushUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
    });
    if (predicate()) return;
  }
  throw new Error(message);
}

const defaultTableRowsResourcePrefix = DATA_TABLE_ROWS_PATH.replace(
  "{table_id}",
  "default",
);

const columns = [
  { column_id: "step", label: "step", unit: "1" },
  { column_id: "mx", label: "mx", unit: "1" },
  { column_id: "my", label: "my", unit: "1" },
  { column_id: "mz", label: "mz", unit: "1" },
];

describe("LiveChartsModule resource flow", () => {
  it.each([
    ["inactive", false, false],
    ["initially paused", true, true],
  ])(
    "makes zero metadata or rowsBinary facade calls when %s",
    async (_name, active, paused) => {
      let dom: ReturnType<typeof installSimulationPreparationTestDom> | null =
        null;
      let resources: ResourceInvalidationController | null = null;
      let root: ReturnType<typeof createRoot> | null = null;
      try {
        vi.useFakeTimers();
        dom = installSimulationPreparationTestDom();
        const bus = new EventBus<KernelEventMap>();
        resources = new ResourceInvalidationController(bus);
        const facade = {
          columns: vi.fn(),
          detail: vi.fn(),
          list: vi.fn(),
          rowsBinary: vi.fn(),
        };
        const kernel = {
          api: { data: { tables: facade } },
          bus,
          diagnosticRecorder: new DiagnosticRecorderController({
            config: { enabled: false },
          }),
          resources,
        } as unknown as KernelApi;
        const container = dom.document.createElement("div");
        root = createRoot(container as unknown as Element);
        await act(async () => {
          root?.render(
            <KernelContext.Provider value={kernel}>
              <LiveTableHarness active={active} paused={paused} />
            </KernelContext.Provider>,
          );
          await Promise.resolve();
        });
        expect(facade.list).not.toHaveBeenCalled();
        expect(facade.detail).not.toHaveBeenCalled();
        expect(facade.columns).not.toHaveBeenCalled();
        expect(facade.rowsBinary).not.toHaveBeenCalled();
        await act(async () => root?.unmount());
        root = null;
        expect(sharedResourceRuntimeStore.stats().entryCount).toBe(0);
      } finally {
        await act(async () => root?.unmount());
        resetSharedResourceRuntimeStoreForTests();
        liveChartPreferencesStore.resetForTests(null);
        resetLiveChartsWorkspaceForTests();
        resources?.resetForTests();
        resetRealtimeCommunicationPolicyForTests();
        vi.useRealTimers();
        dom?.restore();
      }
    },
  );

  it("uses revision invalidation for live rows and keeps exact values locally while paused", async () => {
    let dom: ReturnType<typeof installSimulationPreparationTestDom> | null = null;
    let resources: ResourceInvalidationController | null = null;
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      vi.useFakeTimers();
      dom = installSimulationPreparationTestDom();
      updateRealtimeCommunicationPolicy({ table_rows_min_refetch_ms: 1 });
      liveChartPreferencesStore.resetForTests(null);
      resetLiveChartsWorkspaceForTests();
      const rowsBinary = vi.fn(async () => ({
        data: {
          columnCount: 4,
          cursorEnd: 1,
          cursorStart: 1,
          resyncRequired: false,
          revision: 1,
          rowCount: 1,
          schemaRevision: 1,
          totalRows: 1,
          values: new Float64Array([1, 0.97982, 0.10317, 4.447e-6]),
        },
        status: "ready" as const,
      }));
      const bus = new EventBus<KernelEventMap>();
      const resourceInvalidations = new ResourceInvalidationController(bus);
      resources = resourceInvalidations;
      const kernel = {
        api: {
          data: {
            tables: {
              columns: vi.fn(async () => columns),
              detail: vi.fn(async () => ({ revision: 1 })),
              list: vi.fn(async () => ({
                revision: 1,
                tables: [{ table_id: "default" }],
              })),
              rowsBinary,
            },
          },
          simulation: {
            solver: {
              energies: {
                history: vi.fn(async () => ({
                  revision: 1,
                  rows: [],
                  returned_rows: 0,
                  total_rows: 0,
                })),
              },
            },
          },
        },
        bus,
        diagnosticRecorder: new DiagnosticRecorderController({
          config: { enabled: false },
        }),
        resources: resourceInvalidations,
      } as unknown as KernelApi;
      const container = dom.document.createElement("div");
      dom.document.body.appendChild(container);
      root = createRoot(container as unknown as Element);
      await act(async () => {
        root?.render(
          <KernelContext.Provider value={kernel}>
            <MountedLiveChartSurface />
          </KernelContext.Provider>,
        );
      });
      await flushUntil(
        () => rowsBinary.mock.calls.length === 1,
        "initial rowsBinary request was not observed exactly once",
      );
      expect(container.textContent).toContain("Updating");
      expect(container.textContent).toContain("0.97982");
      expect(container.textContent).toContain("0.10317");
      expect(container.textContent).toContain("4.4470e-6");
      await act(async () => {
        resourceInvalidations.invalidatePrefix(defaultTableRowsResourcePrefix, 2);
        resourceInvalidations.invalidatePrefix(defaultTableRowsResourcePrefix, 3);
      });
      await flushUntil(
        () => rowsBinary.mock.calls.length === 2,
        "coalesced active invalidation did not issue one rowsBinary request",
      );
      expect(rowsBinary).toHaveBeenCalledTimes(2);
      const legend = findElement(
        container,
        (element) =>
          element.getAttribute("aria-label")?.startsWith("my,") ?? false,
        "my legend",
      ) as TestElement;
      const beforeToggle = rowsBinary.mock.calls.length;
      await act(async () => legend.click());
      expect(rowsBinary).toHaveBeenCalledTimes(beforeToggle);
      await act(async () => {
        liveChartPreferencesStore.updateDescriptor("magnetization", () => ({
          liveMode: "paused",
        }));
        await Promise.resolve();
      });
      await act(async () =>
        resourceInvalidations.invalidatePrefix(defaultTableRowsResourcePrefix, 4),
      );
      expect(rowsBinary).toHaveBeenCalledTimes(beforeToggle);
      expect(container.textContent).toContain("0.97982");
      await act(async () => {
        liveChartPreferencesStore.updateDescriptor("magnetization", () => ({
          liveMode: "following",
        }));
        await Promise.resolve();
      });
      await flushUntil(
        () => rowsBinary.mock.calls.length === beforeToggle + 1,
        "resume did not issue one rowsBinary request",
      );
      await act(async () => root?.unmount());
      root = null;
      expect(sharedResourceRuntimeStore.stats().entryCount).toBe(0);
    } finally {
      await act(async () => root?.unmount());
      resetSharedResourceRuntimeStoreForTests();
      liveChartPreferencesStore.resetForTests(null);
      resetLiveChartsWorkspaceForTests();
      resources?.resetForTests();
      resetRealtimeCommunicationPolicyForTests();
      vi.useRealTimers();
      dom?.restore();
    }
  });
});
