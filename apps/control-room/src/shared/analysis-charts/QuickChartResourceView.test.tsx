import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import {
  quickChartWorkspaceStore,
  resetQuickChartWorkspaceForTests,
} from "@/kernel/workspace/quickChartWorkspace";
import type { KernelApi } from "@/kernel/types";

import { QuickChartResourceView } from "./QuickChartResourceView";

const resources = vi.hoisted(() => ({
  columns: vi.fn(() => ({
    data: [
      { column_id: "step", label: "Step", unit: "1" },
      { column_id: "mx", label: "mx", unit: "1" },
    ],
    status: "ready",
  })),
  rows: vi.fn((_tableId: string, options: { enabled?: boolean }) => options.enabled ? ({
    data: {
      data: {
        columnCount: 2,
        cursorEnd: 1,
        cursorStart: 1,
        resyncRequired: false,
        revision: 4,
        rowCount: 1,
        schemaRevision: 1,
        totalRows: 1,
        values: new Float64Array([1, 0.10317]),
      },
      status: "ready",
    },
    status: "ready",
  }) : ({ data: null, status: "idle" })),
}));

vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  useTableColumnsResource: resources.columns,
  useTableRowsBinaryResource: resources.rows,
}));

vi.mock("./EChartsCanvasSurface", () => ({
  EChartsCanvasSurface: ({ initialRange, model }: { initialRange?: { fromValue: number; toValue: number } | null; model: { series: readonly { id: string }[]; statusMessage?: string } }) => (
    <div data-range={initialRange ? `${initialRange.fromValue}:${initialRange.toValue}` : ""} data-series={model.series.map((series) => series.id).join(",")}>
      {model.statusMessage}
      {model.series.map((series) => series.id).join(",")}
      {initialRange ? `${initialRange.fromValue}:${initialRange.toValue}` : ""}
    </div>
  ),
}));

afterEach(() => {
  resetQuickChartWorkspaceForTests();
  resources.columns.mockClear();
  resources.rows.mockClear();
});

describe("QuickChartResourceView", () => {
  it("has a module-neutral source boundary", () => {
    const source = readFileSync(new URL("./QuickChartResourceView.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/from ["'][^"']*(?:analysis-plots|live-charts)/);
    for (const forbidden of [
      "useAnalysisPlotsWorkspace",
      "useAnalysisWorkspace",
      "useLiveChartsWorkspace",
      "useField",
      "useMeshTopology",
    ]) expect(source).not.toContain(forbidden);
    expect(source).toContain("useQuickChartWorkspace");
  });

  it("shows unpinned and explicit-empty states without requesting rows", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const kernel = { selection: { set: vi.fn() } } as unknown as KernelApi;
    try {
      await act(async () => {
        root.render(<KernelContext.Provider value={kernel}><QuickChartResourceView /></KernelContext.Provider>);
      });
      expect(container.textContent).toContain("Pin a chart from Analysis");
      expect(resources.columns).toHaveBeenLastCalledWith("default", { enabled: false });
      expect(resources.rows).toHaveBeenLastCalledWith("default", expect.objectContaining({ enabled: false }));

      await act(async () => quickChartWorkspaceStore.pin({
        chartId: "dynamics:default",
        displayUnits: {},
        range: null,
        selectedSeriesIds: [],
        tableId: "default",
        xAxisId: "step",
      }));
      expect(container.textContent).toContain("Select at least one signal");
      expect(container.textContent).not.toContain("Loading Quick Chart");
      expect(resources.rows).toHaveBeenLastCalledWith("default", expect.objectContaining({ enabled: false }));
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("loads only the pinned table columns and rows and retains full series identities", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const set = vi.fn();
    const kernel = { selection: { set } } as unknown as KernelApi;
    try {
      quickChartWorkspaceStore.pin({
        chartId: "dynamics:default",
        displayUnits: { mx: "1" },
        range: { fromSI: 2, toSI: 8 },
        selectedSeriesIds: ["data.table:default:step:mx"],
        tableId: "default",
        xAxisId: "step",
      });
      await act(async () => {
        root.render(<KernelContext.Provider value={kernel}><QuickChartResourceView /></KernelContext.Provider>);
      });
      expect(resources.columns).toHaveBeenLastCalledWith("default", { enabled: true });
      expect(resources.rows).toHaveBeenLastCalledWith("default", expect.objectContaining({
        columns: ["step", "mx"],
        enabled: true,
      }));
      expect(container.textContent).toContain("data.table:default:step:mx");
      expect(container.textContent).toContain("2:8");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
