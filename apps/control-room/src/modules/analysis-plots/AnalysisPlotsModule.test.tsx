import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  DATA_TABLE_ROWS_PATH,
  SIMULATION_SOLVER_ENERGIES_HISTORY_PATH,
} from "../../kernel/api/apiPaths";
import {
  analysisPlotsRangeSelectedEvent,
  analysisPlotsSeriesSelectedEvent,
  buildAnalysisPlotsTableQuery,
  resolveAnalysisPlotsRequestedSeriesYAxisIds,
  resolveAnalysisPlotsYAxisIds,
  shouldFetchAnalysisTableRows,
} from "./analysisPlotsModel";
import { buildScalarChartSeries } from "./chartTableModel";
import { buildSolverEnergyHistoryChartSeries } from "./energyHistoryAdapter";
import { AnalysisPlotsView } from "./AnalysisPlotsModule";
import { analysisPlotsManifest } from "./manifest";

function tableRowsResourceKey(tableId: string): string {
  return DATA_TABLE_ROWS_PATH.replace("{table_id}", encodeURIComponent(tableId));
}

const table = {
  columns: [
    {
      column_id: "step",
      component: null,
      dimension: "count",
      label: "step",
      quantity_id: "step",
      reduction: null,
      unit: "1",
      value_type: "integer",
    },
    {
      column_id: "mx",
      component: "x",
      dimension: "magnetization",
      label: "mx",
      quantity_id: "mx",
      reduction: "mean",
      unit: "1",
      value_type: "float",
    },
  ],
  cursor_end: 2,
  cursor_start: 1,
  resync_required: false,
  returned_rows: 2,
  revision: 2,
  rows: [
    [1, 0.1],
    [2, 0.2],
  ],
  schema_revision: 1,
  table_id: "default",
  total_rows: 2,
};

describe("AnalysisPlotsView", () => {
  it("renders chart and axis column controls in the analysis surface", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        onClearRange={() => undefined}
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        onSeriesSelect={() => undefined}
        range={null}
        selectedPoint={null}
        solverEnergySeries={[]}
        solverEnergyStatus="idle"
        tableRowsStatus="ready"
        visibleTable={table}
        xAxisId="step"
        yAxisIds={["mx"]}
      />,
    );

    expect(html).toContain("Table charts");
    expect(html).toContain("2 rows / 2 columns");
    expect(html).toContain('class="fm-analysis-plots__echarts"');
    expect(html).toContain('class="fm-analysis-plots__echarts"');
    expect(html).toContain("mx");
  });

  it("renders active zoom range with a clear action", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        onClearRange={() => undefined}
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        onSeriesSelect={() => undefined}
        range={{ fromValue: 10, toValue: 20 }}
        selectedPoint={null}
        solverEnergySeries={[]}
        solverEnergyStatus="idle"
        tableRowsStatus="ready"
        visibleTable={table}
        xAxisId="step"
        yAxisIds={["mx"]}
      />,
    );

    expect(html).toContain("zoom 10-20");
    expect(html).toContain("Clear zoom");
  });

  it("renders compact chart status for axes, sample counts, and zoom state", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        onClearRange={() => undefined}
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        onSeriesSelect={() => undefined}
        range={null}
        selectedPoint={null}
        solverEnergySeries={[]}
        solverEnergyStatus="idle"
        tableRowsStatus="ready"
        visibleTable={table}
        xAxisId="step"
        yAxisIds={["mx"]}
      />,
    );

    expect(html).toContain('class="fm-analysis-plots__status"');
    expect(html).toContain('aria-label="X step"');
    expect(html).toContain('aria-label="Y 1 series"');
    expect(html).toContain('aria-label="Visible 2"');
    expect(html).toContain('aria-label="Total 2"');
    expect(html).toContain('aria-label="Zoom off"');
  });

  it("renders selected chart cursor point in compact status", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        onClearRange={() => undefined}
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        onSeriesSelect={() => undefined}
        range={null}
        selectedPoint={{
          label: "mx",
          point: { rowIndex: 1, x: 2, y: 0.2 },
          quantity: "mx",
          seriesId: "data.table:default:step:mx",
          source: {
            kind: "data.table.rows",
            resourceKey: tableRowsResourceKey("default"),
            tableId: "default",
          },
          unit: "1",
          xUnit: "1",
        }}
        solverEnergySeries={[]}
        solverEnergyStatus="idle"
        tableRowsStatus="ready"
        visibleTable={table}
        xAxisId="step"
        yAxisIds={["mx"]}
      />,
    );

    expect(html).toContain('aria-label="Cursor mx 0.2"');
  });

  it("renders table loading diagnostics in the chart frame before samples exist", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        onClearRange={() => undefined}
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        onSeriesSelect={() => undefined}
        range={null}
        selectedPoint={null}
        solverEnergySeries={[]}
        solverEnergyStatus="idle"
        tableRowsStatus="loading"
        visibleTable={null}
        xAxisId="step"
        yAxisIds={["mx"]}
      />,
    );

    expect(html).toContain("Loading table samples");
    expect(html).not.toContain("No table samples");
  });

  it("renders a series legend with units and latest values from visible rows", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        onClearRange={() => undefined}
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        onSeriesSelect={() => undefined}
        range={null}
        selectedPoint={null}
        solverEnergySeries={[]}
        solverEnergyStatus="idle"
        tableRowsStatus="ready"
        visibleTable={table}
        xAxisId="step"
        yAxisIds={["mx"]}
      />,
    );

    expect(html).toContain('class="fm-analysis-plots__legend"');
    expect(html).toContain('<button');
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="Series mx unit 1 latest 0.2"');
    expect(html).toContain('class="fm-analysis-plots__legend-swatch fm-analysis-plots__legend-swatch--0"');
    expect(html).toContain('class="fm-analysis-plots__legend-latest"');
  });

  it("renders solver energy history as a separate chart source when available", () => {
    const solverEnergySeries = buildSolverEnergyHistoryChartSeries({
      returned_rows: 2,
      revision: 2,
      rows: [
        {
          anisotropy: 0,
          demag: 2,
          dmi: 0,
          exchange: 1,
          step: 1,
          time_seconds: 1e-12,
          total: 3,
          zeeman: 0,
        },
        {
          anisotropy: 0,
          demag: 3,
          dmi: 0,
          exchange: 2,
          step: 2,
          time_seconds: 2e-12,
          total: 5,
          zeeman: 0,
        },
      ],
      total_rows: 2,
    });

    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        onClearRange={() => undefined}
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        onSeriesSelect={() => undefined}
        range={null}
        selectedPoint={null}
        solverEnergySeries={solverEnergySeries}
        solverEnergyStatus="ready"
        tableRowsStatus="ready"
        visibleTable={table}
        xAxisId="step"
        yAxisIds={["mx"]}
      />,
    );

    expect(html).toContain("Energy history");
    expect(html).toContain("6 series");
    expect(html).toContain('aria-label="Energy series legend"');
    expect(html).toContain("E exchange");
    expect(html).toContain("E total");
    expect(html).toContain("time [s]");
  });

  it("builds visible-range table queries when chart zoom is active", () => {
    expect(
      buildAnalysisPlotsTableQuery({
        cursor: 1_000,
        range: { fromValue: 20, toValue: 40 },
        xAxisId: "step",
      }),
    ).toMatchObject({
      cursor: undefined,
      fromRow: 20,
      includeTail: false,
      toRow: 40,
    });
  });

  it("builds a tail table query without cursor after clearing zoom", () => {
    expect(
      buildAnalysisPlotsTableQuery({
        cursor: undefined,
        range: null,
        xAxisId: "step",
      }),
    ).toMatchObject({
      cursor: undefined,
      includeTail: true,
    });
  });

  it("fetches binary table rows only for initial load and zoom windows", () => {
    expect(
      shouldFetchAnalysisTableRows({
        hasVisibleRows: false,
        loadScalars: true,
        range: null,
      }),
    ).toBe(true);
    expect(
      shouldFetchAnalysisTableRows({
        hasVisibleRows: true,
        loadScalars: true,
        range: null,
      }),
    ).toBe(false);
    expect(
      shouldFetchAnalysisTableRows({
        hasVisibleRows: true,
        loadScalars: true,
        range: { fromValue: 10, toValue: 20 },
      }),
    ).toBe(true);
    expect(
      shouldFetchAnalysisTableRows({
        hasVisibleRows: false,
        loadScalars: false,
        range: null,
      }),
    ).toBe(false);
  });

  it("sanitizes selected Y columns to the two unit groups that ECharts renders", () => {
    expect(
      resolveAnalysisPlotsYAxisIds(
        ["t", "mx", "my", "e_total", "max_torque"],
        [
          { column_id: "t", unit: "s" },
          { column_id: "mx", unit: "1" },
          { column_id: "my", unit: "1" },
          { column_id: "e_total", unit: "J" },
          { column_id: "max_torque", unit: "A/m" },
        ],
        "step",
      ),
    ).toEqual(["t", "mx", "my"]);
  });

  it("falls back to production Y columns when persisted Y selection has no visible series", () => {
    expect(
      resolveAnalysisPlotsYAxisIds(
        ["deleted-column"],
        [
          { column_id: "step", unit: "1" },
          { column_id: "t", unit: "s" },
          { column_id: "mx", unit: "1" },
          { column_id: "my", unit: "1" },
          { column_id: "mz", unit: "1" },
          { column_id: "e_total", unit: "J" },
          { column_id: "max_torque", unit: "A/m" },
        ],
        "step",
      ),
    ).toEqual(["mx", "my", "mz", "e_total"]);
  });

  it("declares the add-series event path in the module manifest", () => {
    expect(analysisPlotsManifest.listens).toContain("charts:add-series-requested");
    expect(analysisPlotsManifest.emits).toContain("charts:range-selected");
    expect(analysisPlotsManifest.emits).toContain("charts:series-selected");
  });

  it("adds requested chart series through the same Y-axis unit policy as the UI", () => {
    const columns = [
      { column_id: "step", unit: "1" },
      { column_id: "mx", unit: "1" },
      { column_id: "my", unit: "1" },
      { column_id: "e_total", unit: "J" },
      { column_id: "max_torque", unit: "A/m" },
    ];

    expect(
      resolveAnalysisPlotsRequestedSeriesYAxisIds({
        columnId: "my",
        columns,
        xAxisId: "step",
        yAxisIds: ["mx", "e_total"],
      }),
    ).toEqual(["mx", "e_total", "my"]);
    expect(
      resolveAnalysisPlotsRequestedSeriesYAxisIds({
        columnId: "max_torque",
        columns,
        xAxisId: "step",
        yAxisIds: ["mx", "e_total"],
      }),
    ).toEqual(["mx", "e_total"]);
    expect(
      resolveAnalysisPlotsRequestedSeriesYAxisIds({
        columnId: "step",
        columns,
        xAxisId: "step",
        yAxisIds: ["mx"],
      }),
    ).toEqual(["mx"]);
    expect(
      resolveAnalysisPlotsRequestedSeriesYAxisIds({
        columnId: "missing",
        columns,
        xAxisId: "step",
        yAxisIds: ["mx"],
      }),
    ).toEqual(["mx"]);
  });

  it("builds stable chart range-selected events for cross-module notifications", () => {
    expect(
      analysisPlotsRangeSelectedEvent({
        range: { fromValue: 20, toValue: 40 },
        xAxisId: "step",
      }),
    ).toEqual({
      chartId: "default",
      range: { fromValue: 20, toValue: 40 },
      tableId: "default",
      xAxisId: "step",
    });
    expect(
      analysisPlotsRangeSelectedEvent({
        range: null,
        xAxisId: "t",
      }),
    ).toEqual({
      chartId: "default",
      range: null,
      tableId: "default",
      xAxisId: "t",
    });
  });

  it("builds stable chart series-selected events for cross-module notifications", () => {
    const [series] = buildScalarChartSeries(
      {
        columns: table.columns,
        rows: table.rows,
      },
      { xAxisId: "step", yAxisIds: ["mx"] },
    );

    expect(series).toBeDefined();
    expect(analysisPlotsSeriesSelectedEvent(series!)).toEqual({
      chartId: "default",
      quantity: "mx",
      resourceKey: tableRowsResourceKey("default"),
      seriesId: "data.table:default:step:mx",
      tableId: "default",
    });
  });

  it("builds solver energy history chart series from simulation resources", () => {
    const series = buildSolverEnergyHistoryChartSeries({
      returned_rows: 1,
      revision: 1,
      rows: [
        {
          anisotropy: 4,
          demag: 2,
          dmi: 5,
          exchange: 1,
          step: 7,
          time_seconds: 2e-12,
          total: 15,
          zeeman: 3,
        },
      ],
      total_rows: 1,
    });

    expect(series).toHaveLength(6);
    expect(series[0]).toMatchObject({
      id: "simulation.solver.energies:exchange",
      label: "E exchange",
      quantity: "exchange",
      source: {
        kind: "simulation.solver.energies.history",
        resourceKey: SIMULATION_SOLVER_ENERGIES_HISTORY_PATH,
        tableId: "solver-energies",
      },
      unit: "J",
      xUnit: "s",
    });
    expect(series[0]?.points).toEqual([{ rowIndex: 0, x: 2e-12, y: 1 }]);
    expect(series.at(-1)?.points).toEqual([{ rowIndex: 0, x: 2e-12, y: 15 }]);
  });
});
