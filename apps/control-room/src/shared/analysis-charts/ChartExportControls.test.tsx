import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { findElements, installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { ChartRendererOwner, ChartRenderModel } from "./chartRenderer";
import { ChartExportControls } from "./ChartExportControls";

const model: ChartRenderModel = {
  ariaLabel: "Visible pane",
  key: "visible-pane",
  provenance: {
    dataRevision: 1,
    decimation: "none",
    query: "test",
    resourceKey: "test",
  },
  series: [{
    id: "visible",
    kind: "line",
    label: "Visible",
    points: [{ rowIndex: 0, x: 0, y: 1 }],
    unit: "1",
    yAxis: 0,
  }],
  status: "ready",
  xAxis: { label: "time", unit: "s" },
  yAxes: [{ label: "value", unit: "1" }],
};

const aggregateModel: ChartRenderModel = {
  ...model,
  ariaLabel: "All selected signals",
  key: "all-selected",
  series: [
    ...model.series,
    {
      ...model.series[0]!,
      id: "other-unit",
      label: "Other unit",
      unit: "J",
      yAxis: 1,
    },
  ],
  yAxes: [...model.yAxes, { label: "energy", unit: "J" }],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ChartExportControls", () => {
  it("uses the optional aggregate data model for CSV and TSV while retaining pane PNG", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as HTMLElement);
    const exportPng = vi.fn(() => "data:image/png;base64,chart");
    const rendererRef = { current: { exportPng } as unknown as ChartRendererOwner };
    const blobs: Blob[] = [];
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn((blob: Blob) => {
        blobs.push(blob);
        return `blob:chart-${blobs.length}`;
      }),
      revokeObjectURL: vi.fn(),
    });
    try {
      await act(async () => root.render(
        <ChartExportControls model={model} dataModel={aggregateModel} rendererRef={rendererRef} />,
      ));
      const buttons = findElements(container, (element) => element.tagName === "BUTTON");
      expect(buttons.map((button) => button.textContent)).toEqual(["CSV", "TSV", "PNG"]);
      await act(async () => buttons[0]?.click());
      await act(async () => buttons[1]?.click());
      expect(blobs).toHaveLength(4);
      expect(await blobs[0]!.text()).toContain("other-unit");
      expect(await blobs[2]!.text()).toContain("other-unit");
      await act(async () => buttons[2]?.click());
      expect(exportPng).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("reports a failed direct export instead of throwing from the click handler", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as HTMLElement);
    const failed = vi.fn();
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => {
        throw new Error("downloads unavailable");
      }),
      revokeObjectURL: vi.fn(),
    });
    try {
      await act(async () => root.render(
        <ChartExportControls model={model} onExportFailed={failed} rendererRef={{ current: null }} />,
      ));
      await act(async () => findElements(container, (element) => element.tagName === "BUTTON")[0]?.click());
      expect(failed).toHaveBeenCalledWith("csv");
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
      dom.restore();
    }
  });

  it("shows an accessible local error when a direct export has no failure callback", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as HTMLElement);
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => {
        throw new Error("downloads unavailable");
      }),
      revokeObjectURL: vi.fn(),
    });
    try {
      await act(async () => root.render(
        <ChartExportControls model={model} rendererRef={{ current: null }} />,
      ));
      await act(async () => findElements(container, (element) => element.tagName === "BUTTON")[0]?.click());
      const alerts = findElements(container, (element) => element.getAttribute("role") === "alert");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.textContent).toContain("CSV export failed");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
