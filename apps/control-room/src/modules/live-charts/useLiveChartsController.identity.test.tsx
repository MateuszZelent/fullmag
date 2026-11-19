import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { useLiveChartsController } from "./useLiveChartsController";
import type { ChartTableWindow } from "@/shared/domain/analysis/chartDataPlan";
import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";

const mocks = vi.hoisted(() => {
  const descriptor = {
    displayUnits: {},
    liveMode: "following" as const,
    range: { mode: "follow" as const },
    selectedSeriesIds: ["my"],
    targetPoints: 800 as const,
    xAxisId: "mx",
  };
  const columns = {
    data: [
      { column_id: "mx", label: "mx", unit: "1" },
      { column_id: "my", label: "my", unit: "1" },
    ],
    status: "ready",
  };
  const range = { mode: "follow" as const };
  const idle = { data: null, error: null, revision: null, status: "idle" };
  return {
    archivedTable: null as ChartTableWindow | null,
    preferences: {
      descriptor,
      isHydrated: true,
      setDescriptorLiveMode: vi.fn(),
      setDescriptorRange: vi.fn(),
      setDescriptorSelectedSeriesIds: vi.fn(),
    },
    // Mutable per-test rows status; every hook call returns fresh wrapper objects,
    // like the real resource hooks do on unrelated renders.
    rowsStatus: "ready" as "ready" | "loading",
    tableData: () => ({
      columns,
      range,
      rows: { data: null, error: null, revision: 7, status: mocks.rowsStatus },
      table: null,
      tableList: idle,
      tableResource: idle,
      unsupportedReason: null,
      xAxisId: "mx",
    }),
  };
});

vi.mock("@/kernel/workspace/useLiveChartsWorkspace", () => ({
  useLiveChartsWorkspaceSelector: () => "magnetization",
}));

vi.mock("@/kernel/workspace/liveChartsWorkspace", () => ({
  liveChartsWorkspaceStore: { clearRange: vi.fn(), setRange: vi.fn(), setSelectedDescriptorId: vi.fn() },
}));

vi.mock("@/kernel/workspace/useLiveChartPreferencesHydration", () => ({
  useLiveChartPreferencesHydration: () => mocks.preferences,
}));

vi.mock("@/kernel/workspace/liveChartPreferences", () => ({
  liveChartPreferencesStore: { updateDescriptor: vi.fn() },
}));

vi.mock("./hooks/useLiveTableData", () => ({
  useLiveTableData: () => mocks.tableData(),
}));

vi.mock("./hooks/useLiveChartArchivedTable", () => ({
  useLiveChartArchivedTable: () => mocks.archivedTable,
}));

vi.mock("./hooks/useLiveEnergyData", () => ({
  useLiveEnergyData: () => ({
    resource: { data: null, error: null, revision: 1, status: "ready" },
    series: [],
  }),
}));

type Controller = ReturnType<typeof useLiveChartsController>;

function Probe({ onRender }: { onRender: (controller: Controller) => void; tick: number }) {
  onRender(useLiveChartsController({} as never));
  return null;
}

describe("useLiveChartsController chart input identity", () => {
  it("shows the exact terminal archive in Follow when the live buffer disappears", () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as HTMLElement);
    const renders: Controller[] = [];
    mocks.archivedTable = {
      tableId: "default",
      schemaRevision: 1,
      revision: 2,
      seriesRevision: "terminal-archive-revision",
      columnCount: 2,
      columns: mocks.tableData().columns.data,
      cursorStart: 1,
      cursorEnd: 2,
      totalRows: 2,
      rowCount: 2,
      resyncRequired: false,
      values: new Float64Array([0.1, 0.2, 0.3, 0.4]),
    };

    try {
      act(() => root.render(<Probe onRender={(controller) => renders.push(controller)} tick={0} />));
      expect(renders.at(-1)?.series[0]?.dataRevision).toBe("terminal-archive-revision");
      expect(renders.at(-1)?.series[0]?.points).toHaveLength(2);
    } finally {
      act(() => root.unmount());
      mocks.archivedTable = null;
      dom.restore();
    }
  });

  it("keeps presentation, series and selection identity across unrelated renders", () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as HTMLElement);
    const renders: Controller[] = [];
    mocks.rowsStatus = "ready";

    try {
      act(() => root.render(<Probe onRender={(c) => renders.push(c)} tick={0} />));
      act(() => root.render(<Probe onRender={(c) => renders.push(c)} tick={1} />));
      const first = renders[0];
      const last = renders[renders.length - 1];

      expect(renders.length).toBeGreaterThan(1);
      expect(last.presentation).toBe(first.presentation);
      expect(last.series).toBe(first.series);
      expect(last.selectedSeriesIds).toBe(first.selectedSeriesIds);
    } finally {
      act(() => root.unmount());
      dom.restore();
    }
  });

  it("does not rebuild series when a background refresh only toggles rows status", () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as HTMLElement);
    const renders: Controller[] = [];
    mocks.rowsStatus = "ready";

    try {
      act(() => root.render(<Probe onRender={(c) => renders.push(c)} tick={0} />));
      const before = renders[renders.length - 1];
      mocks.rowsStatus = "loading";
      act(() => root.render(<Probe onRender={(c) => renders.push(c)} tick={1} />));
      const after = renders[renders.length - 1];

      expect(after.series).toBe(before.series);
      expect(after.selectedSeriesIds).toBe(before.selectedSeriesIds);
    } finally {
      act(() => root.unmount());
      dom.restore();
    }
  });
});
