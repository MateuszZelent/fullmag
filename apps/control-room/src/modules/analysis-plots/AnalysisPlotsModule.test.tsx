import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  ANALYSIS_HYSTERESIS_POINTS_PATH,
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
import { frequencyDomainSelectionFromPoint } from "./useAnalysisPlotsController";
import { buildScalarChartSeries } from "./chartTableModel";
import { buildSolverEnergyHistoryChartSeries } from "./energyHistoryAdapter";
import { AnalysisPlotsView } from "./AnalysisPlotsModule";
import { analysisPlotsManifest } from "./manifest";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { SelectionController } from "@/kernel/selection/SelectionController";
import type { KernelApi } from "@/kernel/types";
import {
  adjacentHysteresisPointIndex,
  buildHysteresisAngularFamilyLineSeriesModel,
  buildHysteresisChartLineSeriesModel,
  buildHysteresisChartPointSelection,
  clearHysteresisPointSelectionForLive,
  getProgressYValue,
  HYSTERESIS_CHART_VALUE_AXIS_SCALE,
  hysteresisTargetMetadataFromOrientation,
  nextHysteresisPlaybackIndex,
  resolveHysteresisNavigationIndex,
  selectedHysteresisPointId,
} from "@/shared/domain/study/HysteresisChart";
import {
  buildEigenDispersionChartModel,
  buildEigenSpectrumChartModel,
  buildFrequencyResponseChartModel,
} from "@/shared/domain/analysis/frequencyDomainChartModels";

function tableRowsResourceKey(tableId: string): string {
  return DATA_TABLE_ROWS_PATH.replace("{table_id}", encodeURIComponent(tableId));
}

const mockKernel = {
  commands: {
    execute: () => Promise.resolve(),
    register: () => () => {},
  },
  bus: {
    emit: () => {},
    on: () => () => {},
  },
  api: {},
  resources: {},
} as unknown as KernelApi;

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
  it("fits hysteresis chart axes to collected points during live sweeps", () => {
    expect(HYSTERESIS_CHART_VALUE_AXIS_SCALE).toBe(true);
  });

  it("builds a non-empty hysteresis chart series from completed points before branch resources arrive", () => {
    const points = Array.from({ length: 8 }, (_, index) => ({
      field_value_mT: 100 - index * 5,
      m_avg: [0, 0.99 - index * 0.001, 0],
      m_ip: 0.99 - index * 0.001,
      m_oop: 0,
      m_parallel: 0.99 - index * 0.001,
      point_id: index,
      snapshot_id: index === 0 ? "hysteresis_point_001" : null,
      status: "Completed",
    }));

    const series = buildHysteresisChartLineSeriesModel(
      points,
      [],
      [],
      "full",
      "m_parallel",
    );

    expect(series).toHaveLength(1);
    expect(series[0].name).toBe("All points");
    expect(series[0].data).toHaveLength(8);
    expect(series[0].data[0]).toEqual([100, 0.99, 0]);
    expect(series[0].data[7]).toEqual([65, 0.983, 7]);
  });

  it("builds dedicated hysteresis chart series for minor loops", () => {
    const minorLoops = [{
      closure_error_m_parallel: 0.2,
      closure_status: "returned",
      loop_id: "minor_loop_001",
      minor_loop_area: 0,
      parent_branch_id: "descending",
      points: [
        {
          field_value_mT: -50,
          m_avg: [0, -0.4, 0],
          m_ip: 0.4,
          m_oop: 0,
          m_parallel: -0.4,
          minor_loop_id: "minor_loop_001",
          point_id: 2,
          snapshot_id: "hysteresis_point_003",
          status: "Completed",
        },
        {
          field_value_mT: 0,
          m_avg: [0, -0.2, 0],
          m_ip: 0.2,
          m_oop: 0,
          m_parallel: -0.2,
          minor_loop_id: "minor_loop_001",
          point_id: 3,
          snapshot_id: "hysteresis_point_004",
          status: "Completed",
        },
      ],
      policy: "branch_only",
      recoil_susceptibility: 0.004,
      return_field_mT: 0,
      return_point_id: 3,
      reversal_field_mT: -50,
      reversal_point_id: 2,
      settle_trace: [],
    }];

    const series = buildHysteresisChartLineSeriesModel(
      [],
      [],
      minorLoops,
      "minor",
      "m_parallel",
    );

    expect(series).toHaveLength(1);
    expect(series[0].branchId).toBe("minor_loop_001");
    expect(series[0].data).toEqual([
      [-50, -0.4, 2],
      [0, -0.2, 3],
    ]);
  });

  it("builds OOP and in-plane overlay series from the same hysteresis points", () => {
    const points = [
      {
        field_value_mT: 10,
        m_avg: [0.3, 0.4, 0.5],
        m_ip: 0.5,
        m_oop: 0.5,
        m_parallel: 0.7,
        point_id: 0,
        snapshot_id: null,
        status: "Completed",
      },
      {
        field_value_mT: -10,
        m_avg: [0.6, 0.8, -0.2],
        m_ip: 1.0,
        m_oop: -0.2,
        m_parallel: -0.1,
        point_id: 1,
        snapshot_id: null,
        status: "Completed",
      },
    ];

    const series = buildHysteresisChartLineSeriesModel(
      points,
      [],
      [],
      "oop-ip-overlay",
      "m_parallel",
    );

    expect(series.map((entry) => entry.name)).toEqual(["M_oop", "M_ip"]);
    expect(series[0].data).toEqual([
      [10, 0.5, 0],
      [-10, -0.2, 1],
    ]);
    expect(series[1].data).toEqual([
      [10, 0.5, 0],
      [-10, 1.0, 1],
    ]);
  });

  it("builds RGB component overlay series from averaged magnetization vectors", () => {
    const points = [
      {
        field_value_mT: 20,
        m_avg: [0.1, 0.2, 0.3],
        m_ip: 0.224,
        m_oop: 0.3,
        m_parallel: 0.2,
        point_id: 0,
        snapshot_id: null,
        status: "Completed",
      },
      {
        field_value_mT: -20,
        m_avg: [-0.4, 0.5, -0.6],
        m_ip: 0.64,
        m_oop: -0.6,
        m_parallel: 0.5,
        point_id: 1,
        snapshot_id: null,
        status: "Completed",
      },
    ];

    const series = buildHysteresisChartLineSeriesModel(
      points,
      [],
      [],
      "rgb-overlay",
      "m_parallel",
    );

    expect(series.map((entry) => entry.name)).toEqual(["M_x", "M_y", "M_z"]);
    expect(series[0].data).toEqual([
      [20, 0.1, 0],
      [-20, -0.4, 1],
    ]);
    expect(series[1].data).toEqual([
      [20, 0.2, 0],
      [-20, 0.5, 1],
    ]);
    expect(series[2].data).toEqual([
      [20, 0.3, 0],
      [-20, -0.6, 1],
    ]);
  });

  it("builds angular-family series only for computed variants", () => {
    const family = {
      active_variant_id: "theta_000",
      family_id: "oop_ip_sweep",
      revision: 7,
      series: [
        {
          data_status: "computed_active_stage",
          label: "OOP",
          orientation: { kind: "spherical", theta_deg: 0, phi_deg: 0 },
          point_count: 2,
          points: [
            {
              field_value_mT: 50,
              m_avg: [0.8, 0, 0],
              m_ip: 0.8,
              m_oop: 0,
              m_parallel: 0.8,
              point_id: 0,
              snapshot_id: null,
              status: "Completed",
            },
            {
              field_value_mT: 0,
              m_avg: [0.2, 0, 0],
              m_ip: 0.2,
              m_oop: 0,
              m_parallel: 0.2,
              point_id: 1,
              snapshot_id: null,
              status: "Completed",
            },
          ],
          points_resource_ref: ANALYSIS_HYSTERESIS_POINTS_PATH.replace("{stage_id}", "stage_0"),
          variant_id: "theta_000",
        },
        {
          data_status: "pending_run",
          label: "In-plane",
          orientation: { kind: "spherical", theta_deg: 90, phi_deg: 0 },
          point_count: 0,
          points: [],
          points_resource_ref: ANALYSIS_HYSTERESIS_POINTS_PATH.replace("{stage_id}", "stage_0"),
          variant_id: "theta_090",
        },
      ],
      stage_id: "stage_0",
      stage_index: 0,
    };

    const series = buildHysteresisAngularFamilyLineSeriesModel(
      family,
      "m_parallel",
    );

    expect(series).toHaveLength(1);
    expect(series[0].branchId).toBe("angular-family:theta_000");
    expect(series[0].name).toBe("OOP (theta_000)");
    expect(series[0].data).toEqual([
      [50, 0.8, 0],
      [0, 0.2, 1],
    ]);
  });

  it("builds the virgin segment from a virgin-then-major hysteresis schedule", () => {
    const points = [
      {
        field_value_mT: 0,
        m_avg: [0, 0, 0.1],
        m_ip: 0,
        m_oop: 0.1,
        m_parallel: 0.1,
        point_id: 0,
        snapshot_id: null,
        status: "Completed",
      },
      {
        field_value_mT: 50,
        m_avg: [0, 0, 0.6],
        m_ip: 0,
        m_oop: 0.6,
        m_parallel: 0.6,
        point_id: 1,
        snapshot_id: null,
        status: "Completed",
      },
      {
        field_value_mT: 100,
        m_avg: [0, 0, 0.9],
        m_ip: 0,
        m_oop: 0.9,
        m_parallel: 0.9,
        point_id: 2,
        snapshot_id: null,
        status: "Completed",
      },
      {
        field_value_mT: 50,
        m_avg: [0, 0, 0.8],
        m_ip: 0,
        m_oop: 0.8,
        m_parallel: 0.8,
        point_id: 3,
        snapshot_id: null,
        status: "Completed",
      },
    ];

    const series = buildHysteresisChartLineSeriesModel(
      points,
      [],
      [],
      "virgin",
      "m_parallel",
      undefined,
      "virgin_then_major_loop",
    );

    expect(series).toHaveLength(1);
    expect(series[0].name).toBe("Virgin");
    expect(series[0].data).toEqual([
      [0, 0.1, 0],
      [50, 0.6, 1],
      [100, 0.9, 2],
    ]);
  });

  it("builds hysteresis point selection with a snapshot target for 3D replay", () => {
    const selection = buildHysteresisChartPointSelection({
      point: {
        field_value_mT: 25,
        m_avg: [0.1, 0.2, 0.3],
        m_ip: 0.224,
        m_oop: 0.3,
        m_parallel: 0.8,
        point_id: 4,
        snapshot_id: "hysteresis_point_005",
        status: "Completed",
      },
      stageId: "hysteresis-1",
      targetMetadata: hysteresisTargetMetadataFromOrientation({
        direction: null,
        measurement_axis: "field_axis",
        orientation: { kind: "preset", preset_name: "in_plane_y" },
        revision: 12,
        stage_id: "hysteresis-1",
        stage_index: 0,
      }),
      yAxisKey: "m_parallel",
    });

    expect(selection).toMatchObject({
      kind: "analysis.chart-point",
      label: "Hysteresis point 4 (25 mT)",
      nodeId: "analysis:hysteresis:hysteresis-1:point:4",
      objectId: null,
      ref: {
        chartId: "hysteresis:hysteresis-1",
        pointId: 4,
        quantity: "m_parallel",
        quantityId: "m",
        snapshotId: "hysteresis_point_005",
        stageId: "hysteresis-1",
        tableId: "hysteresis:hysteresis-1",
        targetId: "hysteresis-step:hysteresis-1:4",
        targetKind: "hysteresis-step",
        type: "analysis-chart-point",
        fieldOrientation: "{\"kind\":\"preset\",\"preset_name\":\"in_plane_y\"}",
        fieldRevision: 12,
        measurementAxis: "field_axis",
        x: 25,
        y: 0.8,
      },
    });
  });

  it("navigates hysteresis history from the live runtime point before a point is selected", () => {
    expect(resolveHysteresisNavigationIndex(-1, 4, 10)).toBe(4);
    expect(adjacentHysteresisPointIndex(-1, 4, 10, 1)).toBe(5);
    expect(adjacentHysteresisPointIndex(-1, 4, 10, -1)).toBe(3);
    expect(nextHysteresisPlaybackIndex(-1, 4, 10)).toBe(5);
    expect(nextHysteresisPlaybackIndex(9, 4, 10)).toBe(0);
  });

  it("uses live hysteresis progress magnetization for the active in-flight point", () => {
    const progress = {
      active: true,
      current_field_mT: 200,
      current_m_avg: [0.1, 0.7, 0.2],
      current_m_parallel: 0.7,
      revision: 4,
      stage_id: "stage-000",
      stage_index: 0,
      status: "running",
    };

    expect(getProgressYValue(progress, "m_parallel")).toBe(0.7);
    expect(getProgressYValue(progress, "m_avg_y")).toBe(0.7);
    expect(getProgressYValue(progress, "m_oop")).toBe(0.2);
    expect(getProgressYValue(progress, "m_ip")).toBeCloseTo(Math.sqrt(0.5), 12);
  });

  it("treats clearing hysteresis chart-point selection as return to live", () => {
    const selection = buildHysteresisChartPointSelection({
      point: {
        field_value_mT: 25,
        m_avg: [0.1, 0.2, 0.3],
        m_ip: 0.224,
        m_oop: 0.3,
        m_parallel: 0.8,
        point_id: 4,
        snapshot_id: "hysteresis_point_005",
        status: "Completed",
      },
      stageId: "hysteresis-1",
      yAxisKey: "m_parallel",
    });

    expect(selectedHysteresisPointId({
      kind: selection.kind ?? null,
      label: selection.label ?? null,
      moduleSource: "analysis-plots",
      nodeId: selection.nodeId ?? null,
      objectId: selection.objectId ?? null,
      ref: selection.ref ?? null,
    }, "hysteresis-1")).toBe(4);
    expect(selectedHysteresisPointId({
      kind: null,
      label: null,
      moduleSource: "analysis-plots",
      nodeId: null,
      objectId: null,
      ref: null,
    }, "hysteresis-1")).toBeNull();
  });

  it("clears only the selected hysteresis point for the active stage when returning to live", () => {
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    const kernel = { selection } as Pick<KernelApi, "selection">;
    const chartSelection = buildHysteresisChartPointSelection({
      point: {
        field_value_mT: 25,
        m_avg: [0.1, 0.2, 0.3],
        m_ip: 0.224,
        m_oop: 0.3,
        m_parallel: 0.8,
        point_id: 4,
        snapshot_id: "hysteresis_point_005",
        status: "Completed",
      },
      stageId: "hysteresis-1",
      yAxisKey: "m_parallel",
    });

    selection.set(chartSelection, "analysis-plots");
    expect(clearHysteresisPointSelectionForLive(
      kernel,
      "hysteresis-2",
      "analysis-plots",
    )).toBe(false);
    expect(selectedHysteresisPointId(selection.get(), "hysteresis-1")).toBe(4);

    expect(clearHysteresisPointSelectionForLive(
      kernel,
      "hysteresis-1",
      "analysis-plots",
    )).toBe(true);
    expect(selectedHysteresisPointId(selection.get(), "hysteresis-1")).toBeNull();
  });

  it("renders chart and axis column controls in the analysis surface", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        kernel={mockKernel}
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

  it("renders frequency-domain series as a dedicated analysis subchart", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        kernel={mockKernel}
        frequencyDomainSeries={[
          {
            id: "analysis.frequency-domain:response:amplitude",
            label: "Amplitude",
            points: [{ rowIndex: 0, x: 9.5, y: 2 }],
            quantity: "amplitude",
            source: {
              kind: "analysis.frequency_domain",
              resourceKey: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
              tableId: "frequency-domain:response-sweep",
            },
            status: "ready",
            unit: "a.u.",
            xUnit: "GHz",
          },
        ]}
        frequencyDomainStatus="ready"
        frequencyDomainTitle="Frequency-domain response sweep"
        onClearRange={() => undefined}
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        onSeriesSelect={() => undefined}
        range={null}
        selectedPoint={null}
        solverEnergySeries={[]}
        solverEnergyStatus="idle"
        tableRowsStatus="idle"
        visibleTable={null}
        xAxisId="step"
        yAxisIds={["mx"]}
      />,
    );

    expect(html).toContain("Frequency-domain response sweep");
    expect(html).toContain("Frequency-domain series legend");
    expect(html).toContain("Amplitude");
    expect(html).toContain(ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH);
  });

  it("renders frequency-domain missing artifact state instead of hiding the analysis subchart", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        kernel={mockKernel}
        frequencyDomainSeries={[]}
        frequencyDomainStatus="stale"
        frequencyDomainTitle="Frequency-domain modal spectrum"
        frequencyDomainUnavailableReason="spectrum artifact is missing"
        onClearRange={() => undefined}
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        onSeriesSelect={() => undefined}
        range={null}
        selectedPoint={null}
        solverEnergySeries={[]}
        solverEnergyStatus="idle"
        tableRowsStatus="idle"
        visibleTable={null}
        xAxisId="step"
        yAxisIds={["mx"]}
      />,
    );

    expect(html).toContain("Frequency-domain modal spectrum");
    expect(html).toContain("stale");
    expect(html).toContain("spectrum artifact is missing");
    expect(html).not.toContain("Frequency-domain series legend");
  });

  it("renders frequency-domain loading state while artifact resources resolve", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        kernel={mockKernel}
        frequencyDomainSeries={[]}
        frequencyDomainStatus="loading"
        frequencyDomainTitle="Frequency-domain dispersion"
        onClearRange={() => undefined}
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        onSeriesSelect={() => undefined}
        range={null}
        selectedPoint={null}
        solverEnergySeries={[]}
        solverEnergyStatus="idle"
        tableRowsStatus="idle"
        visibleTable={null}
        xAxisId="step"
        yAxisIds={["mx"]}
      />,
    );

    expect(html).toContain("Frequency-domain dispersion");
    expect(html).toContain("Loading frequency-domain artifacts");
  });

  it("maps frequency-domain chart clicks to frequency-domain selections", () => {
    const responseModel = buildFrequencyResponseChartModel({
      artifact_path: "response/magnetic_response_sweep.v2.json",
      payload: {
        points: [
          {
            field_id: "response-field-7",
            frequency_hz: 12.5e9,
            frequency_index: 7,
            max_response_amplitude: 0.75,
            observable_id: "mx",
          },
        ],
        schema_version: "magnetic_response_sweep.v2",
      },
      status: "ready",
    });

    const selection = frequencyDomainSelectionFromPoint({
      dispersionModel: buildEigenDispersionChartModel({ status: "idle" }),
      point: {
        label: "Amplitude",
        point: { rowIndex: 0, x: 12.5, y: 0.75 },
        quantity: "amplitude",
        seriesId: "analysis.frequency-domain:response:amplitude",
        source: {
          kind: "analysis.frequency_domain",
          resourceKey: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
          tableId: "frequency-domain:response-sweep",
        },
        unit: "a.u.",
        xUnit: "GHz",
      },
      responseModel,
      routeMode: "fmr_response",
      spectrumModel: buildEigenSpectrumChartModel({ status: "idle" }),
    });

    expect(selection).toEqual({
      kind: "results.frequency_response.frequency_point",
      label: "Amplitude 0.75 a.u.",
      nodeId:
        "analysis:charts:frequency-domain:response-sweep:point:analysis.frequency-domain:response:amplitude:0",
      objectId: null,
      ref: {
        calculationMode: "fmr_response",
        fieldId: "response-field-7",
        frequencyIndex: 7,
        kind: "results.frequency_response.frequency_point",
        nodeId:
          "analysis:charts:frequency-domain:response-sweep:point:analysis.frequency-domain:response:amplitude:0",
        observableId: "mx",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
        type: "frequency-domain",
      },
    });
  });

  it("renders active zoom range with a clear action", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        kernel={mockKernel}
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
        kernel={mockKernel}
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
        kernel={mockKernel}
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
        kernel={mockKernel}
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
        kernel={mockKernel}
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
        kernel={mockKernel}
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
