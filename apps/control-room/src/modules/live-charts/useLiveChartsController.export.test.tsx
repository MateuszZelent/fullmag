import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { liveChartsCommandRequests } from "./liveChartsCommandRequests";
import { useLiveChartsController } from "./useLiveChartsController";

const mocks = vi.hoisted(() => {
  const descriptor = {
    displayUnits: {},
    liveMode: "following" as const,
    range: { mode: "follow" as const },
    selectedSeriesIds: [],
    targetPoints: 800 as const,
    xAxisId: "step",
  };
  return {
    descriptor,
    energyXAxisId: "t" as "step" | "t",
    energyResourceData: null as { rows: readonly Record<string, unknown>[] } | null,
    selectedDescriptorId: "magnetization" as "magnetization" | "energy",
    preferences: {
      descriptor,
      isHydrated: true,
      prefs: { descriptors: {}, schemaVersion: 1 as const },
      setDescriptorLiveMode: vi.fn(),
      setDescriptorRange: vi.fn(),
      setDescriptorSelectedSeriesIds: vi.fn(),
      setDescriptorTargetPoints: vi.fn(),
      setDescriptorXAxisId: vi.fn(),
    },
    preferenceStore: { updateDescriptor: vi.fn<(id: string, update: () => unknown) => void>() },
    workspace: {
      clearRange: vi.fn(),
      setRange: vi.fn(),
      setSelectedDescriptorId: vi.fn(),
    },
  };
});

vi.mock("@/kernel/workspace/useLiveChartsWorkspace", () => ({
  useLiveChartsWorkspaceSelector: () => mocks.selectedDescriptorId,
}));

vi.mock("@/kernel/workspace/liveChartsWorkspace", () => ({
  liveChartsWorkspaceStore: mocks.workspace,
}));

vi.mock("@/kernel/workspace/useLiveChartPreferencesHydration", () => ({
  useLiveChartPreferencesHydration: () => mocks.preferences,
}));

vi.mock("@/kernel/workspace/liveChartPreferences", () => ({
  liveChartPreferencesStore: mocks.preferenceStore,
}));

vi.mock("./hooks/useLiveTableData", () => ({
  useLiveTableData: () => ({
    columns: { data: [], status: "ready" },
    range: { mode: "follow" },
    rows: { data: null, error: null, revision: 1, status: "ready" },
    table: null,
    unsupportedReason: null,
    xAxisId: "step",
  }),
}));

vi.mock("./hooks/useLiveChartArchivedTable", () => ({
  useLiveChartArchivedTable: () => null,
}));

vi.mock("./hooks/useLiveEnergyData", () => ({
  useLiveEnergyData: () => ({
    resource: { data: mocks.energyResourceData, error: null, revision: 1, status: "ready" },
    series: [],
    xAxisId: mocks.energyXAxisId,
  }),
}));

vi.mock("@/shared/analysis-charts/chartPresentationState", () => ({
  deriveChartPresentationState: () => ({ kind: "ready", revision: 1 }),
}));

let latestController: ReturnType<typeof useLiveChartsController> | null = null;

function ControllerHarness() {
  const controller = useLiveChartsController({} as never);
  useEffect(() => {
    latestController = controller;
  }, [controller]);
  return null;
}

afterEach(() => {
  latestController = null;
  mocks.selectedDescriptorId = "magnetization";
  mocks.energyXAxisId = "t";
  mocks.energyResourceData = null;
  Object.assign(mocks.descriptor, { range: { mode: "follow" }, xAxisId: "step" });
  mocks.workspace.clearRange.mockClear();
  mocks.workspace.setRange.mockClear();
  mocks.workspace.setSelectedDescriptorId.mockClear();
  mocks.preferenceStore.updateDescriptor.mockClear();
  mocks.preferences.setDescriptorLiveMode.mockClear();
  mocks.preferences.setDescriptorRange.mockClear();
  mocks.preferences.setDescriptorSelectedSeriesIds.mockClear();
  mocks.preferences.setDescriptorTargetPoints.mockClear();
  mocks.preferences.setDescriptorXAxisId.mockClear();
});

describe("useLiveChartsController export ownership", () => {
  it("uses the energy-history axis and clears a fixed range when its coordinate changes", async () => {
    const dom = installSimulationPreparationTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as HTMLElement);
    mocks.selectedDescriptorId = "energy";
    mocks.energyXAxisId = "step";
    mocks.energyResourceData = { rows: [{ step: 4, time_seconds: 0 }, { step: 9, time_seconds: 0 }] };
    Object.assign(mocks.descriptor, {
      range: { mode: "fixed", fromSI: 2e-9, toSI: 3e-9 },
      xAxisId: "t",
    });

    try {
      await act(async () => root.render(<ControllerHarness />));

      expect(latestController).toMatchObject({
        initialRange: null,
        range: { mode: "follow" },
        xAxisId: "step",
        xAxisLabel: "Step",
        xAxisOptions: [{ id: "step", label: "Step" }],
      });
      const axisSync = mocks.preferenceStore.updateDescriptor.mock.calls.at(-1);
      expect(axisSync?.[0]).toBe("energy");
      expect(axisSync?.[1]()).toEqual({ range: { mode: "follow" }, xAxisId: "step" });

      await act(async () => latestController?.onRangeSelected(4, 9));
      const selectedRange = mocks.preferenceStore.updateDescriptor.mock.calls.at(-1);
      expect(selectedRange?.[1]()).toEqual({
        range: { mode: "fixed", fromSI: 4, toSI: 9 },
        xAxisId: "step",
      });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps Time metadata for advancing energy history and clears a step-range zoom", async () => {
    const dom = installSimulationPreparationTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as HTMLElement);
    mocks.selectedDescriptorId = "energy";
    mocks.energyXAxisId = "t";
    mocks.energyResourceData = {
      rows: [{ step: 4, time_seconds: 2e-9 }, { step: 5, time_seconds: 3e-9 }],
    };
    Object.assign(mocks.descriptor, {
      range: { mode: "fixed", fromSI: 4, toSI: 9 },
      xAxisId: "step",
    });

    try {
      await act(async () => root.render(<ControllerHarness />));

      expect(latestController).toMatchObject({
        initialRange: null,
        range: { mode: "follow" },
        xAxisId: "t",
        xAxisLabel: "Time",
        xAxisOptions: [{ id: "t", label: "Time (s)" }],
      });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps a local export pending when an overlapping command export completes", async () => {
    const dom = installSimulationPreparationTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as HTMLElement);
    let command: Promise<"completed" | "failed"> | undefined;
    try {
      await act(async () => root.render(<ControllerHarness />));
      await act(async () => latestController?.onExport("png"));
      expect(latestController?.requestedExportRequest).toMatchObject({ format: "png" });

      await act(async () => {
        command = liveChartsCommandRequests.request({ kind: "export", format: "csv" });
        await Promise.resolve();
      });
      expect(latestController?.requestedExportRequest).toMatchObject({ format: "csv" });

      await act(async () => latestController?.onRequestedExportHandled());
      await expect(command).resolves.toBe("completed");
      expect(latestController?.requestedExportRequest).toMatchObject({ format: "png" });
    } finally {
      liveChartsCommandRequests.fail();
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("does not let a stale local ACK clear a newer export request", async () => {
    const dom = installSimulationPreparationTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as HTMLElement);
    try {
      await act(async () => root.render(<ControllerHarness />));
      await act(async () => latestController?.onExport("png"));
      const firstRequestId = latestController?.requestedExportRequest?.requestId;
      const staleHandled = latestController?.onRequestedExportHandled;

      await act(async () => latestController?.onExport("png"));
      const secondRequestId = latestController?.requestedExportRequest?.requestId;
      expect(secondRequestId).not.toBe(firstRequestId);
      await act(async () => staleHandled?.());
      expect(latestController?.requestedExportRequest?.requestId).toBe(secondRequestId);

      const staleFailed = latestController?.onRequestedExportFailed;
      await act(async () => latestController?.onExport("png"));
      const thirdRequestId = latestController?.requestedExportRequest?.requestId;
      await act(async () => staleFailed?.());
      expect(latestController?.requestedExportRequest?.requestId).toBe(thirdRequestId);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("retains an accessible error after a local export fails", async () => {
    const dom = installSimulationPreparationTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as HTMLElement);
    try {
      await act(async () => root.render(<ControllerHarness />));
      await act(async () => latestController?.onExport("csv"));
      expect(latestController?.requestedExportRequest).toMatchObject({ format: "csv" });
      await act(async () => latestController?.onRequestedExportFailed?.());
      expect(latestController?.requestedExportRequest).toBeNull();
      expect(latestController?.exportErrorFormat).toBe("csv");
      await act(async () => latestController?.onExport("csv"));
      expect(latestController?.exportErrorFormat).toBeNull();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("clears a previous local export error when a command export succeeds", async () => {
    const dom = installSimulationPreparationTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as HTMLElement);
    let command: Promise<"completed" | "failed"> | undefined;
    try {
      await act(async () => root.render(<ControllerHarness />));
      await act(async () => latestController?.onExport("csv"));
      await act(async () => latestController?.onRequestedExportFailed?.());
      expect(latestController?.exportErrorFormat).toBe("csv");

      await act(async () => {
        command = liveChartsCommandRequests.request({ kind: "export", format: "png" });
        await Promise.resolve();
      });
      expect(latestController?.exportErrorFormat).toBeNull();

      await act(async () => latestController?.onRequestedExportHandled());
      await expect(command).resolves.toBe("completed");
      expect(latestController?.exportErrorFormat).toBeNull();
    } finally {
      liveChartsCommandRequests.fail();
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("ignores a stale failure callback after a newer export request", async () => {
    const dom = installSimulationPreparationTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as HTMLElement);
    try {
      await act(async () => root.render(<ControllerHarness />));
      await act(async () => latestController?.onExport("csv"));
      const staleFailed = latestController?.onRequestedExportFailed;
      await act(async () => latestController?.onExport("tsv"));
      const currentRequestId = latestController?.requestedExportRequest?.requestId;
      await act(async () => staleFailed?.());
      expect(latestController?.requestedExportRequest?.requestId).toBe(currentRequestId);
      expect(latestController?.exportErrorFormat).toBeNull();

      await act(async () => latestController?.onRequestedExportFailed?.());
      expect(latestController?.requestedExportRequest).toBeNull();
      expect(latestController?.exportErrorFormat).toBe("tsv");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("clears a previous export error when the chart preset changes", async () => {
    const dom = installSimulationPreparationTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as HTMLElement);
    try {
      await act(async () => root.render(<ControllerHarness />));
      await act(async () => latestController?.onExport("csv"));
      await act(async () => latestController?.onRequestedExportFailed?.());
      expect(latestController?.exportErrorFormat).toBe("csv");

      mocks.selectedDescriptorId = "energy";
      await act(async () => root.render(<ControllerHarness />));
      expect(latestController?.descriptorId).toBe("energy");
      expect(latestController?.exportErrorFormat).toBeNull();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
