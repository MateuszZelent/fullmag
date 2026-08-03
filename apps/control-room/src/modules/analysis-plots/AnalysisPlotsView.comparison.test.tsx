import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { KernelApi } from "@/kernel/types";

const chartStatuses: string[] = [];
vi.mock("./components/EChartsSurface", () => ({ EChartsSurface: ({ dataStatus }: { dataStatus?: string }) => { chartStatuses.push(dataStatus ?? "idle"); return <div data-testid="chart" />; } }));
vi.mock("@/shared/ui/Select", () => ({
  Select: ({ children, onValueChange }: { children: React.ReactNode; onValueChange: (value: string) => void }) => <div onClick={() => onValueChange("table-c")}>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} type="button">{children}</button>,
  SelectValue: () => null,
}));
vi.mock("@/shared/ui/Button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));

import { AnalysisPlotsView, comparisonSeriesKey } from "./AnalysisPlotsView";

function table(tableId: string, revision: number) {
  return {
    columnCount: 3,
    columns: [
      { column_id: "step", label: "step", unit: "1" },
      { column_id: "mx", label: "mx", unit: "1" },
      { column_id: "energy", label: "energy", unit: "J" },
    ],
    cursorEnd: 1,
    cursorStart: 0,
    resyncRequired: false,
    revision,
    rowCount: 2,
    schemaRevision: 1,
    tableId,
    totalRows: 2,
    values: new Float64Array([0, 1, 2, 1, 3, 4]),
  };
}

const kernel = { bus: { emit: vi.fn(), on: () => () => {} } } as unknown as KernelApi;

function nodesWithAttribute(root: { childNodes: readonly unknown[]; getAttribute?: (name: string) => string | null }, name: string, prefix: string): Array<{ click: () => void }> {
  const matches: Array<{ click: () => void }> = [];
  const visit = (node: typeof root) => {
    if (node.getAttribute?.(name)?.startsWith(prefix)) matches.push(node as unknown as { click: () => void });
    for (const child of node.childNodes as typeof root[]) visit(child);
  };
  visit(root);
  return matches;
}

describe("Analysis comparison selection", () => {
  it("keeps dataset B replaceable and clearable while toggling either pane updates both pane-specific IDs", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const onComparisonSelectedSeriesKeysChange = vi.fn();
    const onComparisonDatasetRefChange = vi.fn();
    const commonKey = comparisonSeriesKey({ quantity: "mx", unit: "1" });
    try {
      await act(async () => root.render(<AnalysisPlotsView activeSurface="comparison" comparisonDatasetRef="table-b" comparisonTable={table("table-b", 2)} comparisonTableStatus="ready" datasetRefs={["table-a", "table-b", "table-c"]} kernel={kernel} onComparisonDatasetRefChange={onComparisonDatasetRefChange} onComparisonSelectedSeriesKeysChange={onComparisonSelectedSeriesKeysChange} selectedDatasetRef="table-a" table={table("table-a", 1)} tableStatus="ready" />));
      expect(nodesWithAttribute(container, "data-testid", "chart")).toHaveLength(2);
      await act(async () => nodesWithAttribute(container, "aria-label", "Comparison dataset").at(-1)!.click());
      expect(onComparisonDatasetRefChange).toHaveBeenLastCalledWith("table-c");
      await act(async () => nodesWithAttribute(container, "aria-label", "Clear comparison dataset")[0]!.click());
      expect(onComparisonDatasetRefChange).toHaveBeenLastCalledWith(null);
      const firstPaneToggle = nodesWithAttribute(container, "aria-label", "mx, unit dimensionless")[0]!;
      await act(async () => firstPaneToggle.click());
      expect(onComparisonSelectedSeriesKeysChange).toHaveBeenLastCalledWith([comparisonSeriesKey({ quantity: "energy", unit: "J" })]);

      await act(async () => root.render(<AnalysisPlotsView activeSurface="comparison" comparisonDatasetRef="table-b" comparisonSelectedSeriesKeys={[]} comparisonTable={table("table-b", 2)} comparisonTableStatus="ready" datasetRefs={["table-a", "table-b"]} hasComparisonSelection kernel={kernel} onComparisonSelectedSeriesKeysChange={onComparisonSelectedSeriesKeysChange} selectedDatasetRef="table-a" table={table("table-a", 1)} tableStatus="ready" />));
      expect(nodesWithAttribute(container, "data-testid", "chart")).toHaveLength(0);
      const secondPaneToggle = nodesWithAttribute(container, "aria-label", "mx, unit dimensionless")[1]!;
      await act(async () => secondPaneToggle.click());
      expect(onComparisonSelectedSeriesKeysChange).toHaveBeenLastCalledWith([commonKey]);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("renders the secondary dataset's loading state instead of claiming incompatible ready data", async () => {
    chartStatuses.length = 0;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<AnalysisPlotsView activeSurface="comparison" comparisonDatasetRef="table-b" comparisonTable={null} comparisonTableStatus="loading" datasetRefs={["table-a", "table-b"]} kernel={kernel} selectedDatasetRef="table-a" table={table("table-a", 1)} tableStatus="ready" />));
      expect(chartStatuses).toEqual(["loading"]);
      expect(container.textContent).not.toContain("No compatible quantity");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
