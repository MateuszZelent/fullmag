import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import {
  findElements,
  installSimulationPreparationTestDom,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { KernelApi } from "@/kernel/types";

vi.mock("./components/EChartsSurface", () => ({ EChartsSurface: () => <div data-testid="chart" /> }));
vi.mock("@/shared/ui/Select", () => ({
  Select: ({ children, onValueChange }: { children: React.ReactNode; onValueChange: (value: string) => void }) => <div onClick={() => onValueChange("table-c")}>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} type="button">{children}</button>,
  SelectValue: () => null,
}));
import {
  analysisComparisonVerdict,
  comparisonSeriesKey,
  type AnalysisComparisonIdentity,
} from "./analysisComparison";
import { AnalysisPlotsView } from "./AnalysisPlotsView";

function table(tableId: string, revision: number, quantityId = "m") {
  return {
    columnCount: 3,
    columns: [
      { column_id: "step", component: null, dimension: "count", label: "step", quantity_id: "step", reduction: null, scope: "global", unit: "1" },
      { column_id: "mx", component: "x", dimension: "magnetization", label: "mx", quantity_id: quantityId, reduction: "mean", scope: "magnetic_domain", unit: "1" },
      { column_id: "energy", component: null, dimension: "energy", label: "energy", quantity_id: "e_total", reduction: "sum", scope: "magnetic_domain", unit: "J" },
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

const compatibleIdentity: AnalysisComparisonIdentity = {
  boundaryContext: "finite_open",
  equilibriumId: "eq-1",
  geometryId: "geometry-1",
  kContext: "finite_open",
  meshId: "mesh-1",
  observableId: "magnetization",
  runId: "run-1",
  stageId: "stage-1",
};

describe("Analysis comparison selection", () => {
  it("keeps Comparison explicitly unavailable in the production view", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<AnalysisPlotsView activeSurface="comparison" datasetRefs={["table-a", "table-b"]} kernel={kernel} selectedDatasetRef="table-a" table={table("table-a", 1)} tableStatus="ready" />));
      expect(container.textContent).toContain("Comparison unavailable");
      expect(container.textContent).toContain("typed owner identities");
      expect(findElements(container, (element) => element.getAttribute("data-testid") === "chart")).toHaveLength(0);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("uses full canonical observable identity instead of column id and unit", () => {
    const left = table("table-a", 1, "m");
    const right = table("table-b", 2, "m_normalized");
    const leftSeries = left.columns[1]!;
    const rightSeries = right.columns[1]!;

    expect(comparisonSeriesKey({
      columnId: leftSeries.column_id,
      component: leftSeries.component,
      dimension: leftSeries.dimension,
      quantity: leftSeries.quantity_id,
      reduction: leftSeries.reduction,
      scope: leftSeries.scope,
      unit: leftSeries.unit,
    })).not.toBe(comparisonSeriesKey({
      columnId: rightSeries.column_id,
      component: rightSeries.component,
      dimension: rightSeries.dimension,
      quantity: rightSeries.quantity_id,
      reduction: rightSeries.reduction,
      scope: rightSeries.scope,
      unit: rightSeries.unit,
    }));
    expect(comparisonSeriesKey({ quantity: "mx", unit: "1" })).toBeNull();
  });

  it.each([
    "runId",
    "stageId",
    "equilibriumId",
    "geometryId",
    "meshId",
    "boundaryContext",
    "kContext",
    "observableId",
  ] as const)("fails closed when %s is missing or differs", (field) => {
    expect(analysisComparisonVerdict(
      { ...compatibleIdentity, [field]: null },
      compatibleIdentity,
    )).toMatchObject({ status: "cannot-compare" });
    expect(analysisComparisonVerdict(
      compatibleIdentity,
      { ...compatibleIdentity, [field]: `${compatibleIdentity[field]}-other` },
    )).toMatchObject({ status: "cannot-compare" });
  });
});
