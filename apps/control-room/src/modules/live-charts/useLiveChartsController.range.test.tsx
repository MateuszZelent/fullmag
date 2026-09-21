import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LiveChartControls } from "./components/LiveChartControls";
import { useLiveChartsController } from "./useLiveChartsController";
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
  return {
    descriptor,
    preferences: {
      descriptor,
      isHydrated: true,
      setDescriptorLiveMode: vi.fn(),
      setDescriptorRange: vi.fn(),
      setDescriptorSelectedSeriesIds: vi.fn(),
    },
    workspace: {
      clearRange: vi.fn(),
      setRange: vi.fn(),
      setSelectedDescriptorId: vi.fn(),
    },
  };
});

vi.mock("@/kernel/workspace/useLiveChartsWorkspace", () => ({
  useLiveChartsWorkspaceSelector: () => "magnetization",
}));

vi.mock("@/kernel/workspace/liveChartsWorkspace", () => ({
  liveChartsWorkspaceStore: mocks.workspace,
}));

vi.mock("@/kernel/workspace/useLiveChartPreferencesHydration", () => ({
  useLiveChartPreferencesHydration: () => mocks.preferences,
}));

vi.mock("@/kernel/workspace/liveChartPreferences", () => ({
  liveChartPreferencesStore: { updateDescriptor: vi.fn() },
}));

vi.mock("./components/LiveChartControls", () => ({
  LiveChartControls: () => <div aria-label="Sample window" />,
}));

vi.mock("./hooks/useLiveTableData", () => ({
  useLiveTableData: () => ({
    columns: {
      data: [
        { column_id: "mx", label: "mx", unit: "1" },
        { column_id: "my", label: "my", unit: "1" },
      ],
      status: "ready",
    },
    range: { mode: "follow" },
    rows: { data: null, error: null, revision: 1, status: "ready" },
    table: null,
    tableList: { data: null, error: null, revision: null, status: "idle" },
    tableResource: { data: null, error: null, revision: null, status: "idle" },
    unsupportedReason: null,
    xAxisId: "mx",
  }),
}));

vi.mock("./hooks/useLiveEnergyData", () => ({
  useLiveEnergyData: () => ({
    resource: { data: null, error: null, revision: 1, status: "ready" },
    series: [],
  }),
}));

vi.mock("@/shared/analysis-charts/chartPresentationState", () => ({
  deriveChartPresentationState: () => ({ kind: "ready", revision: 1 }),
}));

let latestController: ReturnType<typeof useLiveChartsController> | null = null;

function ControllerControls() {
  const controller = useLiveChartsController({} as never);
  useEffect(() => {
    latestController = controller;
  }, [controller]);
  return <LiveChartControls {...controller} />;
}

afterEach(() => {
  latestController = null;
  mocks.workspace.clearRange.mockClear();
  mocks.workspace.setRange.mockClear();
  mocks.workspace.setSelectedDescriptorId.mockClear();
  mocks.preferences.setDescriptorLiveMode.mockClear();
  mocks.preferences.setDescriptorRange.mockClear();
  mocks.preferences.setDescriptorSelectedSeriesIds.mockClear();
});

describe("useLiveChartsController range controls", () => {
  it("keeps Window available for tables whose columns are only observable quantities", () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as HTMLElement);

    try {
      act(() => root.render(<ControllerControls />));
      const html = container.innerHTML;

      expect(latestController?.xAxisId).toBe("mx");
      expect(latestController?.xAxisOptions).toEqual([]);
      expect(html).toContain('aria-label="Sample window"');
      expect(latestController?.onRangeChange).toEqual(expect.any(Function));

      latestController?.onRangeChange?.({ mode: "fullDecimated" });
      expect(mocks.preferences.setDescriptorRange).toHaveBeenLastCalledWith(
        "magnetization",
        { mode: "fullDecimated" },
      );

      latestController?.onRangeChange?.({ mode: "fixed", fromSI: 1, toSI: 2 });
      expect(mocks.preferences.setDescriptorRange).toHaveBeenLastCalledWith(
        "magnetization",
        { mode: "follow" },
      );

      latestController?.onRangeChange?.({ mode: "tailTime", durationS: 1 });
      expect(mocks.preferences.setDescriptorRange).toHaveBeenLastCalledWith(
        "magnetization",
        { mode: "follow" },
      );
    } finally {
      act(() => root.unmount());
      dom.restore();
    }
  });
});
