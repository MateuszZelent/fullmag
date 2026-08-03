import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import type { KernelApi } from "@/kernel/types";
import {
  installSimulationPreparationTestDom,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { AnalysisTableSurface } from "./AnalysisTableSurface";

const kernel = { bus: undefined } as unknown as KernelApi;

describe("AnalysisTableSurface presentation projection", () => {
  it("renders the empty table state for a valid zero-row table window", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    await act(async () => root.render(<AnalysisTableSurface
      chartSeries={[]}
      kernel={kernel}
      onPointSelect={() => undefined}
      onRangeChange={() => undefined}
      onSelectedSeriesIdsChange={() => undefined}
      range={null}
      selectedPoint={null}
      selectedSeriesIds={[]}
      status="ready"
      table={zeroRowTable}
      xAxisId="step"
      xAxisLabel="step"
    />));

    expect(container.textContent).toContain("No table samples");
    await act(async () => root.unmount());
    dom.restore();
  });

  it("renders the explicit unsupported reason instead of falling back to idle", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    await act(async () => root.render(<AnalysisTableSurface
      chartSeries={[]}
      kernel={kernel}
      onPointSelect={() => undefined}
      onRangeChange={() => undefined}
      onSelectedSeriesIdsChange={() => undefined}
      range={null}
      selectedPoint={null}
      selectedSeriesIds={[]}
      status="unsupported"
      table={null}
      unsupportedReason="The current runtime does not provide table samples."
      xAxisId="step"
      xAxisLabel="step"
    />));

    expect(container.textContent).toContain("The current runtime does not provide table samples.");
    await act(async () => root.unmount());
    dom.restore();
  });
});

const zeroRowTable = {
  columnCount: 2,
  columns: [
    { column_id: "step", label: "step", unit: "1" },
    { column_id: "mx", label: "mx", unit: "1" },
  ],
  cursorEnd: 0,
  cursorStart: 0,
  resyncRequired: false,
  revision: 42,
  rowCount: 0,
  schemaRevision: 1,
  tableId: "default",
  totalRows: 0,
  values: new Float64Array(),
};
