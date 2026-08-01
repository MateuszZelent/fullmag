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
      availableColumns={[
        ...tableWindow.columns,
        { column_id: "e_demag", label: "demag energy", unit: "J" },
        { column_id: "max_torque_T", label: "max torque", unit: "T" },
      ]}
      kernel={kernel}
      onClearRange={vi.fn()}
      onPointSelect={vi.fn()}
      onRangeChange={vi.fn()}
      onSelectXAxis={vi.fn()}
      onToggleYAxis={vi.fn()}
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
    expect(source.split("\n").length).toBeLessThan(185);
    for (const owner of ["AnalysisTableSurface", "AnalysisEnergySurface", "AnalysisFrequencySurface"]) {
      expect(source).toContain(owner);
    }
    expect(source).not.toContain("availableColumns={availableColumns}");
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
    expect(html).toContain('data-state="active"');
    expect(html).toContain('role="tab"');
  });

  it("mounts only the selected dedicated heavy surface", () => {
    const overviewHtml = render("overview");
    // ChartLegend aria-label: "mx, unit 1, latest ..."
    expect(overviewHtml).toContain("mx, unit 1");
    expect(overviewHtml).not.toContain("Available quantities");
    expect(overviewHtml).toContain("Scientific trust: Unknown");
    // Heavy energy/frequency surfaces are mounted only after selecting their tab.
    expect(overviewHtml).not.toContain("Energy history");

    const energyHtml = render("energy");
    expect(energyHtml).toContain("Energy balance");
    expect(energyHtml).toContain("Energy history");
    expect(energyHtml).toContain("Scientific trust: Unknown");
    expect(energyHtml).not.toContain('aria-label="Chart status"');

    const dynamicsHtml = render("dynamics");
    expect(dynamicsHtml).toContain("Magnetization dynamics");
    expect(dynamicsHtml).toContain("mx, unit 1");
    expect(dynamicsHtml).not.toContain("Energy history");

    const convergenceHtml = render("convergence");
    expect(convergenceHtml).toContain("Solver convergence");
    expect(convergenceHtml).toContain("max torque");
    // mx series must NOT appear on convergence surface
    expect(convergenceHtml).not.toContain("mx, unit 1");
  });

  it("gates resource families by active surface in the controller and hooks", () => {
    const controllerSource = readFileSync(new URL("./useAnalysisPlotsController.ts", import.meta.url), "utf8");
    const tableSource = readFileSync(new URL("./hooks/useAnalysisTableData.ts", import.meta.url), "utf8");
    const energySource = readFileSync(new URL("./hooks/useAnalysisEnergyData.ts", import.meta.url), "utf8");
    const freqSource = readFileSync(new URL("./hooks/useAnalysisFrequencyData.ts", import.meta.url), "utf8");

    expect(controllerSource).toContain("useAnalysisTableData");
    expect(controllerSource).toContain("useAnalysisEnergyData");
    expect(controllerSource).toContain("useAnalysisFrequencyData");
    // The basic tableautosave workbench must not request optional dynamics
    // resources while an ordinary simulation is running.
    expect(controllerSource).not.toContain("useSpinWaveGammaResource");
    expect(controllerSource).not.toContain("useDynamicStructureFactorResource");
    expect(controllerSource).toContain("analysisChartDescriptorId(activeSurface)");
    expect(controllerSource).toContain("preferences.isHydrated");
    const moduleSource = readFileSync(new URL("./AnalysisPlotsModule.tsx", import.meta.url), "utf8");
    expect(moduleSource).not.toContain("dynamicStructureFactorStatus");
    expect(tableSource).toContain("loadTableRows");
    expect(energySource).toContain("loadEnergy");
    expect(freqSource).toContain("loadFrequency");
  });

  it("uses cached primitive workspace snapshots for table axes", () => {
    const tableSource = readFileSync(new URL("./hooks/useAnalysisTableData.ts", import.meta.url), "utf8");
    expect(tableSource).toContain("useAnalysisPlotsWorkspaceSelector((state) => state.xAxisId)");
    expect(tableSource).toContain("useAnalysisPlotsWorkspaceSelector((state) => state.yAxisIds)");
    expect(tableSource).not.toContain("(state) => ({ xAxisId: state.xAxisId, yAxisIds: state.yAxisIds })");
  });
});
