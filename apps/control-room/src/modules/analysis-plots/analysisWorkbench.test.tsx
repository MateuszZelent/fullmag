import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { KernelApi } from "@/kernel/types";
import type { ChartTableWindow } from "@/shared/domain/analysis/chartDataPlan";
import { AnalysisPlotsView } from "./AnalysisPlotsView";
import type { ChartSeries } from "./chartTableModel";

const kernel = {} as KernelApi;
const table = {
  columns: [
    { column_id: "step", component: null, dimension: "count", label: "step", quantity_id: "step", reduction: null, unit: "1", value_type: "integer" },
    { column_id: "mx", component: "x", dimension: "magnetization", label: "mx", quantity_id: "mx", reduction: "mean", unit: "1", value_type: "float" },
    { column_id: "max_torque", component: null, dimension: "effective_field", label: "max torque", quantity_id: "max_torque", reduction: "max", unit: "A/m", value_type: "float" },
  ],
  cursor_end: 2, cursor_start: 1, resync_required: false, returned_rows: 2,
  revision: 2, rows: [[1, 0.1, 4], [2, 0.2, 3]], schema_revision: 1,
  table_id: "default", total_rows: 2,
};
const tableWindow: ChartTableWindow = {
  columnCount: table.columns.length,
  columns: table.columns as ChartTableWindow["columns"],
  cursorEnd: table.cursor_end,
  cursorStart: table.cursor_start,
  resyncRequired: table.resync_required,
  revision: table.revision,
  rowCount: table.rows.length,
  schemaRevision: table.schema_revision,
  tableId: table.table_id,
  totalRows: table.total_rows,
  values: new Float64Array(table.rows.flat()),
};
const energy: ChartSeries[] = [{
  id: "energy", label: "Total energy", points: [{ rowIndex: 0, x: 0, y: 1 }],
  quantity: "e_total", source: { kind: "simulation.solver.energies.history", resourceKey: "energy", tableId: "energy" },
  status: "ready", unit: "J", xUnit: "s",
}];

function render(surface: "overview" | "energy" | "dynamics" | "convergence" | "frequency") {
  return renderToStaticMarkup(
    <AnalysisPlotsView
      activeSurface={surface}
      kernel={kernel}
      onClearRange={vi.fn()}
      onPointSelect={vi.fn()}
      onRangeChange={vi.fn()}
      onSeriesSelect={vi.fn()}
      range={null}
      selectedPoint={null}
      solverEnergySeries={energy}
      solverEnergyStatus="ready"
      tableRowsStatus="ready"
      visibleTable={tableWindow}
      xAxisId="step"
      yAxisIds={["mx", "max_torque"]}
    />,
  );
}

describe("Analysis workbench surfaces", () => {
  it("keeps the workbench view as a thin surface registry", () => {
    const source = readFileSync(new URL("./AnalysisPlotsView.tsx", import.meta.url), "utf8");
    expect(source.split("\n").length).toBeLessThan(180);
    for (const owner of ["AnalysisTableSurface", "AnalysisEnergySurface", "AnalysisFrequencySurface"]) {
      expect(source).toContain(owner);
    }
    expect(source).not.toContain("buildFrequencyDomainWorkbenchSummary");
    expect(source).not.toContain("<EChartsSurface");
  });

  it("publishes the full surface matrix as keyboard tabs", () => {
    const html = render("overview");
    for (const label of ["Overview", "Energy", "Dynamics", "Convergence", "Frequency"]) {
      expect(html).toContain(`>${label}</button>`);
    }
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('tabindex="-1"');
  });

  it("mounts only the selected dedicated heavy surface", () => {
    const overviewHtml = render("overview");
    expect(overviewHtml).toContain("Series mx");
    expect(overviewHtml).not.toContain("Series E total unit J latest");

    const energyHtml = render("energy");
    expect(energyHtml).toContain("Energy balance");
    expect(energyHtml).toContain("Energy history");
    expect(energyHtml).not.toContain('aria-label="Chart status"');

    const dynamicsHtml = render("dynamics");
    expect(dynamicsHtml).toContain("Magnetization dynamics");
    expect(dynamicsHtml).toContain("Series mx");
    expect(dynamicsHtml).not.toContain("Energy history");

    const convergenceHtml = render("convergence");
    expect(convergenceHtml).toContain("Solver convergence");
    expect(convergenceHtml).toContain("max torque");
    expect(convergenceHtml).not.toContain("Series mx");
  });

  it("gates resource families by active surface in the controller", () => {
    const source = readFileSync(new URL("./useAnalysisPlotsController.ts", import.meta.url), "utf8");
    expect(source).toContain("const loadTableRows");
    expect(source).toContain("const loadEnergy");
    expect(source).toContain("const loadFrequency");
    expect(source).toContain("enabled: loadEnergy");
    expect(source).toContain("enabled: loadFrequency");
  });
});
