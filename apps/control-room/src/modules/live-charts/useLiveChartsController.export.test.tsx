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
  liveChartPreferencesStore: { updateDescriptor: vi.fn() },
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
  mocks.workspace.clearRange.mockClear();
  mocks.workspace.setRange.mockClear();
  mocks.workspace.setSelectedDescriptorId.mockClear();
  mocks.preferences.setDescriptorLiveMode.mockClear();
  mocks.preferences.setDescriptorRange.mockClear();
  mocks.preferences.setDescriptorSelectedSeriesIds.mockClear();
  mocks.preferences.setDescriptorTargetPoints.mockClear();
  mocks.preferences.setDescriptorXAxisId.mockClear();
});

describe("useLiveChartsController export ownership", () => {
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
