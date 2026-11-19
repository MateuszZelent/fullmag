import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { KernelContext, useKernel } from "@/kernel/KernelContext";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { SelectionController } from "@/kernel/selection/SelectionController";
import { resolveInspectorPanel } from "@/modules/inspector/inspectorRegistry";
import { DATA_SCALARS_PATH, DATA_TABLE_ROWS_PATH, SIMULATION_STAGES_EXECUTION_PATH } from "@/kernel/api/apiPaths";
import type { StudyResultSeriesIdentity } from "@/kernel/api/apiTypes";
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
  const kernel = useKernel();
  return <LiveChartSurface {...useLiveChartsController(kernel.selection)} />;
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

const sessionStatus = {
  capabilities: { binary_fields: true },
  domain: { discretization: "fdm" },
  resources: { scene_revision: 1 },
  run: null,
  session: {
    request_scope_epoch: "api-instance:test",
    session_epoch: "test-session@1",
    session_id: "test-session",
  },
};
// Session identity is confirmed against the session collection before any
// session-scoped resource loads.
const sessionsApi = {
  current: { status: async () => sessionStatus },
  list: async () => ({
    schema_version: "2.0.0",
    sessions: [{ current: true, name: "test", session_id: "test-session", status: "running" }],
  }),
};

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
      const scalarWindow = vi.fn(async () => ({ revision: 1, rows: [], returned_rows: 0, total_rows: 0 }));
      const stageExecution = vi.fn(async () => null);
      const bus = new EventBus<KernelEventMap>();
      const resourceInvalidations = new ResourceInvalidationController(bus);
      resources = resourceInvalidations;
      const kernel = {
        api: {
          data: {
            scalars: { window: scalarWindow },
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
          sessions: sessionsApi,
          simulation: {
            stages: { execution: stageExecution },
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
        selection: new SelectionController(bus),
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
      expect(container.textContent).not.toContain("Updating");
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
      expect(kernel.selection.get().ref).toMatchObject({
        descriptorId: "magnetization",
        kind: "live.chart",
        type: "live-chart",
      });
      expect(resolveInspectorPanel(kernel.selection.get())?.id).toBe("live-chart");
      await act(async () => {
        liveChartPreferencesStore.updateDescriptor("magnetization", () => ({
          liveMode: "paused",
        }));
        await Promise.resolve();
      });
      const scalarCalls = scalarWindow.mock.calls.length;
      const stageCalls = stageExecution.mock.calls.length;
      await act(async () => {
        resourceInvalidations.invalidatePrefix(defaultTableRowsResourcePrefix, 4);
        resourceInvalidations.invalidatePrefix(DATA_SCALARS_PATH, 4);
        resourceInvalidations.invalidatePrefix(SIMULATION_STAGES_EXECUTION_PATH, 4);
        await vi.advanceTimersByTimeAsync(5);
      });
      expect(rowsBinary).toHaveBeenCalledTimes(beforeToggle);
      expect(scalarWindow).toHaveBeenCalledTimes(scalarCalls);
      expect(stageExecution).toHaveBeenCalledTimes(stageCalls);
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

  it("ignores rows arriving after Pause and resumes with a cursorless legacy window for the current stage", async () => {
    vi.useFakeTimers();
    const dom = installSimulationPreparationTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    updateRealtimeCommunicationPolicy({ table_rows_min_refetch_ms: 1 });
    const identity = (step_id: string): StudyResultSeriesIdentity => ({
      run_id: "test-run", task_id: step_id, step_id, case_id: "default",
      attempt_id: step_id, ownership_epoch: 1,
    });
    const a = identity("A");
    const b = identity("B");
    let currentSeries = a;
    const scalarWindow = vi.fn(async () => ({
      revision: currentSeries === a ? 1 : 2, series: currentSeries, rows: [],
    }));
    function binary(value: number, responseMetadata?: StudyResultSeriesIdentity) {
      return {
        status: "ready" as const, responseMetadata,
        data: {
          columnCount: 4, cursorStart: 1, cursorEnd: 1, rowCount: 1, totalRows: 1,
          resyncRequired: false, revision: 1, schemaRevision: 1,
          values: new Float64Array([1, value, 0, 0]),
        },
      };
    }
    const requests: Array<{
      cursor?: number;
      signal: AbortSignal;
      settled: boolean;
      resolve: (value: ReturnType<typeof binary>) => void;
    }> = [];
    const rowsBinary = (
      _tableId: string, { cursor }: { cursor?: number }, { signal }: { signal: AbortSignal },
    ) => new Promise<ReturnType<typeof binary>>((resolve) => {
      const pending = {
        cursor, signal, settled: false,
        resolve: (value: ReturnType<typeof binary>) => {
          pending.settled = true;
          resolve(value);
        },
      };
      requests.push(pending);
    });
    const kernel = {
      api: { sessions: sessionsApi, data: {
        scalars: { window: scalarWindow },
        tables: {
          columns: async () => columns, detail: async () => ({ revision: 1 }),
          list: async () => ({ revision: 1, tables: [{ table_id: "default" }] }), rowsBinary,
        },
      } },
      bus, resources,
      diagnosticRecorder: new DiagnosticRecorderController({ config: { enabled: false } }),
    } as unknown as KernelApi;
    const followRange = { mode: "follow" } as const;
    let view: ReturnType<typeof useLiveTableData> | null = null;
    function Probe({ paused }: { paused: boolean }) {
      view = useLiveTableData({
        active: true, paused, range: followRange, targetPoints: 800, xAxisId: "step",
      });
      return null;
    }
    const read = () => view!;
    const render = (paused: boolean) => act(async () => {
      root.render(<KernelContext.Provider value={kernel}><Probe paused={paused} /></KernelContext.Provider>);
    });
    const lastPending = () => requests.findLast((request) => !request.settled && !request.signal.aborted);
    try {
      await render(false);
      await flushUntil(() => read().currentSeriesIdentity?.step_id === "A" && Boolean(lastPending()), "initial A request");
      await act(async () => lastPending()!.resolve(binary(0.25, a)));
      await flushUntil(() => read().table?.values[1] === 0.25 && lastPending()?.cursor === 1, "A cursor request");
      const delayedA = lastPending()!;

      await render(true);
      expect(delayedA.signal.aborted).toBe(true);
      const callsAtPause = requests.length;
      const scalarCallsAtPause = scalarWindow.mock.calls.length;
      currentSeries = b;
      await act(async () => {
        delayedA.resolve(binary(99, a));
        resources.invalidatePrefix(DATA_SCALARS_PATH, 2);
        resources.invalidatePrefix(defaultTableRowsResourcePrefix, 2);
        await vi.advanceTimersByTimeAsync(5);
      });
      expect(read().table).toBeNull();
      expect(requests).toHaveLength(callsAtPause);
      expect(scalarWindow).toHaveBeenCalledTimes(scalarCallsAtPause);

      await render(false);
      await flushUntil(() => read().currentSeriesIdentity?.step_id === "B" && Boolean(lastPending()), "current B request");
      expect(lastPending()?.cursor).toBeUndefined();
      await act(async () => lastPending()!.resolve(binary(0.75)));
      expect(read().table?.values[1]).toBe(0.75);
      expect(read().table?.seriesRevision).toBeUndefined();

      const beforeExact = requests.length;
      await act(async () => resources.invalidatePrefix(defaultTableRowsResourcePrefix, 3));
      await flushUntil(() => requests.length > beforeExact, "new cursorless B request");
      expect(lastPending()?.cursor).toBeUndefined();
      await act(async () => lastPending()!.resolve(binary(0.5, b)));
      await flushUntil(() => read().table?.values[1] === 0.5 && lastPending()?.cursor === 1, "strict B cursor request");
    } finally {
      await act(async () => root.unmount());
      resetSharedResourceRuntimeStoreForTests();
      resources.resetForTests();
      resetRealtimeCommunicationPolicyForTests();
      vi.useRealTimers();
      dom.restore();
    }
  });

  it("renders an explicit empty-series state without replacing it with a blank chart", async () => {
    const series = [
      {
        id: "data.table:default:step:mx",
        label: "mx",
        points: [{ rowIndex: 0, x: 0, y: 0.97982 }],
        quantity: "mx",
        source: { kind: "data.table.rows" as const, resourceKey: "resource", tableId: "default" },
        status: "ready" as const,
        unit: "1",
        xUnit: "1",
      },
    ];
    const html = renderToStaticMarkup(
      <LiveChartSurface
        descriptorId="magnetization"
        fitRequest={0}
        onChartSelected={() => undefined}
        onExport={() => undefined}
        onPointSelected={() => undefined}
        onRangeSelected={() => undefined}
        onRequestedExportHandled={() => undefined}
        onSeriesChange={() => undefined}
        presentation={{ kind: "ready", revision: 1 }}
        selectedSeriesIds={[]}
        series={series}
        title="Magnetization"
        xAxisLabel="step"
      />,
    );

    expect(html).toContain("Select at least one signal");
    expect(html).not.toContain("fm-analysis-chart-surface");
  });
});
