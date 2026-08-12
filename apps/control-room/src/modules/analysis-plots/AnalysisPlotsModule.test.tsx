import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  ANALYSIS_HYSTERESIS_POINTS_PATH,
  DATA_FIELD_VECTOR_PATH,
  DATA_TABLE_ROWS_PATH,
  SIMULATION_SOLVER_ENERGIES_HISTORY_PATH,
} from "../../kernel/api/apiPaths";
import {
  analysisPlotsRangeSelectedEvent,
  analysisPlotsSeriesSelectedEvent,
  buildAnalysisPlotsTableQuery,
  resolveAnalysisPlotsRequestedSeriesYAxisIds,
  resolveAnalysisPlotsYAxisIds,
} from "./analysisPlotsModel";
import {
  frequencyDomainChartRouteOverrideFromSelection,
  frequencyDomainChartTitle,
  frequencyDomainSelectionFromPoint,
  selectedHysteresisStageIdFromSelection,
} from "./useAnalysisPlotsController";
import { buildScalarChartSeries } from "./chartTableModel";
import { buildSolverEnergyHistoryChartSeries } from "./energyHistoryAdapter";
import { AnalysisPlotsView } from "./AnalysisPlotsModule";
import { analysisPlotsManifest } from "./manifest";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { SelectionController } from "@/kernel/selection/SelectionController";
import type { KernelApi } from "@/kernel/types";
import type { ChartTableWindow } from "@/shared/domain/analysis/chartDataPlan";
import { VisualizationDebugController } from "@/kernel/visualization/VisualizationDebugController";
import {
  adjacentHysteresisPointIndex,
  buildHysteresisAdaptivePointMarkerModel,
  buildHysteresisAngularFamilyLineSeriesModel,
  buildHysteresisChartLineSeriesModel,
  buildHysteresisMetricMarkerModel,
  buildHysteresisChartPointSelection,
  buildHysteresisLoadPointIn3DInput,
  buildHysteresisSelectPointCommandInput,
  clearHysteresisPointSelectionForLive,
  formatHysteresisChartTooltip,
  getProgressYValue,
  HYSTERESIS_CHART_VALUE_AXIS_SCALE,
  hysteresisChartReplayActionPresentation,
  hysteresisTargetMetadataFromOrientation,
  hysteresisPointsProvenanceLabel,
  nextHysteresisPlaybackIndex,
  resolveHysteresisKeyboardNavigationIndex,
  resolveHysteresisScrubberPointIndex,
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

function snapshotVectorResourceKey(snapshotId: string): string {
  return `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?component=full&scope_kind=full&snapshot_id=${snapshotId}`;
}

function analysisFieldVectorResourceKey(fieldId: string): string {
  return `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", fieldId)}?view=phase_rotated_real&phase_rad=0`;
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
  visualizationDebug: new VisualizationDebugController(),
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

function chartWindow(value: {
  columns: readonly unknown[];
  cursor_end: number;
  cursor_start: number;
  resync_required: boolean;
  revision: number;
  rows: readonly (readonly number[])[];
  schema_revision: number;
  table_id: string;
  total_rows: number;
}): ChartTableWindow {
  return {
    columnCount: value.columns.length,
    columns: value.columns as ChartTableWindow["columns"],
    cursorEnd: value.cursor_end,
    cursorStart: value.cursor_start,
    resyncRequired: value.resync_required,
    revision: value.revision,
    rowCount: value.rows.length,
    schemaRevision: value.schema_revision,
    tableId: value.table_id,
    totalRows: value.total_rows,
    values: new Float64Array(value.rows.flat()),
  };
}

describe("AnalysisPlotsView", () => {
  it("reports the actual hysteresis points revision or an honest unavailable state", () => {
    expect(hysteresisPointsProvenanceLabel(42)).toBe("Hysteresis points · revision 42");
    expect(hysteresisPointsProvenanceLabel(null)).toBe("Hysteresis points · revision unavailable");
  });

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

  it("builds dedicated adaptive refinement point markers for visible hysteresis points", () => {
    const points = [
      {
        adaptive_inserted: false,
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
        adaptive_inserted: true,
        field_value_mT: 0,
        m_avg: [0.0, 0.0, 0.01],
        m_ip: 0,
        m_oop: 0.01,
        m_parallel: 0.01,
        point_id: 7,
        refinement_reason: ["zero_crossing"],
        snapshot_id: "hysteresis_adaptive_001",
        status: "Completed",
      },
    ];

    const markers = buildHysteresisAdaptivePointMarkerModel(
      points,
      [],
      [],
      "full",
      "m_parallel",
    );

    expect(markers).toEqual([[0, 0.01, 7]]);
  });

  it("builds adaptive refinement markers from branch resources when points are not loaded", () => {
    const branches = [
      {
        branch_id: "descending",
        branch_index: 0,
        branch_role: "return",
        direction: -1,
        end_field_mT: 0,
        end_point_id: 2,
        minor_loop_id: null,
        parent_branch_id: null,
        point_count: 2,
        points: [
          {
            adaptive_inserted: true,
            field_value_mT: -5,
            m_avg: [0.1, 0.0, 0.0],
            m_ip: 0.1,
            m_oop: 0,
            m_parallel: 0.1,
            point_id: 3,
            status: "Completed",
          },
        ],
        start_field_mT: 20,
        start_point_id: 1,
      },
    ];

    const markers = buildHysteresisAdaptivePointMarkerModel(
      [],
      branches,
      [],
      "return",
      "m_parallel",
    );

    expect(markers).toEqual([[-5, 0.1, 3]]);
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

  it("keeps RGB overlay series scoped by hysteresis branch when branches are loaded", () => {
    const branches = [
      {
        branch_id: "ascending",
        branch_index: 0,
        branch_role: "major",
        direction: 1,
        end_field_mT: 20,
        end_point_id: 0,
        point_count: 1,
        points: [{
          field_value_mT: 20,
          m_avg: [0.1, 0.2, 0.3],
          m_ip: 0.224,
          m_oop: 0.3,
          m_parallel: 0.2,
          point_id: 0,
          snapshot_id: null,
          status: "Completed",
        }],
        start_field_mT: 20,
        start_point_id: 0,
      },
      {
        branch_id: "descending",
        branch_index: 1,
        branch_role: "major",
        direction: -1,
        end_field_mT: -20,
        end_point_id: 1,
        point_count: 1,
        points: [{
          field_value_mT: -20,
          m_avg: [-0.4, 0.5, -0.6],
          m_ip: 0.64,
          m_oop: -0.6,
          m_parallel: 0.5,
          point_id: 1,
          snapshot_id: null,
          status: "Completed",
        }],
        start_field_mT: -20,
        start_point_id: 1,
      },
    ];

    const series = buildHysteresisChartLineSeriesModel(
      [],
      branches,
      [],
      "rgb-overlay",
      "m_parallel",
    );

    expect(series.map((entry) => [entry.branchId, entry.name])).toEqual([
      ["mx-overlay:ascending", "M_x Ascending (Forward)"],
      ["my-overlay:ascending", "M_y Ascending (Forward)"],
      ["mz-overlay:ascending", "M_z Ascending (Forward)"],
      ["mx-overlay:descending", "M_x Descending (Return)"],
      ["my-overlay:descending", "M_y Descending (Return)"],
      ["mz-overlay:descending", "M_z Descending (Return)"],
    ]);
    expect(series[0].data).toEqual([[20, 0.1, 0]]);
    expect(series[3].data).toEqual([[-20, -0.4, 1]]);
  });

  it("formats branch-aware hysteresis overlay tooltips from ECharts series ids", () => {
    const tooltip = formatHysteresisChartTooltip(
      {
        data: [20, 0.1, 0],
        seriesId: "mx-overlay:ascending",
        seriesName: "M_x Ascending (Forward)",
      },
      {
        branchMode: "major_loop",
        points: [{
          field_value_mT: 20,
          m_avg: [0.1, 0.2, 0.3],
          m_ip: 0.224,
          m_oop: 0.3,
          m_parallel: 0.2,
          point_id: 0,
          snapshot_id: "hysteresis_point_001",
          status: "Completed",
        }],
        xAxisUnit: "mT",
      },
    );

    expect(tooltip).toContain("Branch: ascending");
    expect(tooltip).toContain("Series: M_x Ascending (Forward)");
    expect(tooltip).toContain("Snapshot available");
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

  it("builds source-linked hysteresis metric markers for chart tooltips", () => {
    const points = [
      {
        adaptive_inserted: true,
        field_value_mT: 12,
        has_non_converged_steps: false,
        is_reversal_field: false,
        m_avg: [0.1, 0.2, 0.3],
        m_ip: 0.224,
        m_oop: 0.3,
        m_parallel: 0.4,
        point_id: 1,
        snapshot_id: null,
        status: "Completed",
      },
      {
        adaptive_inserted: false,
        field_value_mT: -18,
        has_non_converged_steps: true,
        is_reversal_field: true,
        m_avg: [0.1, 0.2, -0.3],
        m_ip: 0.224,
        m_oop: -0.3,
        m_parallel: -0.4,
        point_id: 2,
        snapshot_id: null,
        status: "Warning",
      },
    ];

    expect(
      buildHysteresisMetricMarkerModel({
        formatXValue: (fieldValueMt) => fieldValueMt / 1000,
        metrics: {
          H_c: null,
          H_c_minus: -21,
          H_c_plus: 19,
          H_eb: null,
          M_r_minus: -0.72,
          M_r_plus: 0.68,
          loop_area: 0.1,
          saturation_preparation_field_mT: 250,
          saturation_status: "saturated",
          switching_field_candidates: [
            {
              branch_id: "descending",
              field_value_mT: -18,
              point_id_after: 2,
              point_id_before: 1,
              susceptibility_per_mT: 0.8,
            },
          ],
          warnings: ["minor loop is not closed"],
        },
        points,
        yAxisKey: "m_parallel",
      }),
    ).toEqual([
      {
        fieldValueMt: 19,
        kind: "coercivity",
        label: "Hc+",
        pointId: null,
        value: 0,
        x: 0.019,
      },
      {
        fieldValueMt: -21,
        kind: "coercivity",
        label: "Hc-",
        pointId: null,
        value: 0,
        x: -0.021,
      },
      {
        fieldValueMt: 0,
        kind: "remanence",
        label: "Mr+",
        pointId: null,
        value: 0.68,
        x: 0,
      },
      {
        fieldValueMt: 0,
        kind: "remanence",
        label: "Mr-",
        pointId: null,
        value: -0.72,
        x: 0,
      },
      {
        fieldValueMt: 250,
        kind: "saturation",
        label: "Hsat",
        pointId: null,
        value: null,
        x: 0.25,
      },
      {
        fieldValueMt: -18,
        kind: "switching-candidate",
        label: "Switch candidate",
        pointId: 2,
        value: -0.4,
        x: -0.018,
      },
      {
        fieldValueMt: -18,
        kind: "reversal",
        label: "Reversal",
        pointId: 2,
        value: -0.4,
        x: -0.018,
      },
      {
        fieldValueMt: 12,
        kind: "adaptive",
        label: "Adaptive",
        pointId: 1,
        value: 0.4,
        x: 0.012,
      },
      {
        fieldValueMt: -18,
        kind: "warning",
        label: "Warning",
        pointId: 2,
        value: -0.4,
        x: -0.018,
      },
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
        field_orientation: { kind: "preset", preset_name: "in_plane_x" },
        measurement_axis: { kind: "custom", vector: [1, 0, 0] },
        snapshot_id: "hysteresis_point_005",
        snapshot_storage_reason: "snapshot found in hysteresis.zarr",
        snapshot_storage_status: "available",
        snapshot_vector_resource_ref: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_005&stage_id=hysteresis-1`,
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
        resourceRef: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_005&stage_id=hysteresis-1`,
        snapshotId: "hysteresis_point_005",
        stageId: "hysteresis-1",
        tableId: "hysteresis:hysteresis-1",
        targetId: "hysteresis-step:hysteresis-1:4",
        targetKind: "hysteresis-step",
        type: "analysis-chart-point",
        fieldOrientation: "{\"kind\":\"preset\",\"preset_name\":\"in_plane_x\"}",
        fieldRevision: 12,
        measurementAxis: "{\"kind\":\"custom\",\"vector\":[1,0,0]}",
        x: 25,
        y: 0.8,
      },
    });
  });

  it("builds 3D replay command input from point-level hysteresis metadata", () => {
    const input = buildHysteresisLoadPointIn3DInput({
      point: {
        field_value_mT: 25,
        m_avg: [0.1, 0.2, 0.3],
        m_ip: 0.224,
        m_oop: 0.3,
        m_parallel: 0.8,
        point_id: 4,
        field_orientation: { kind: "preset", preset_name: "in_plane_x" },
        measurement_axis: { kind: "custom", vector: [1, 0, 0] },
        snapshot_id: "hysteresis_point_005",
        snapshot_storage_reason: "snapshot found in hysteresis.zarr",
        snapshot_storage_status: "available",
        snapshot_vector_resource_ref: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_005&stage_id=hysteresis-1`,
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

    expect(input).toMatchObject({
      fieldOrientation: "{\"kind\":\"preset\",\"preset_name\":\"in_plane_x\"}",
      fieldRevision: 12,
      fieldVal: 25,
      mVal: 0.8,
      measurementAxis: "{\"kind\":\"custom\",\"vector\":[1,0,0]}",
      pointId: 4,
      snapshotId: "hysteresis_point_005",
      snapshotResourceRef: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_005&stage_id=hysteresis-1`,
      snapshotStorageReason: "snapshot found in hysteresis.zarr",
      snapshotStorageStatus: "available",
      stageId: "hysteresis-1",
    });
  });

  it("disables the hysteresis chart 3D replay action when the snapshot payload is missing", () => {
    expect(hysteresisChartReplayActionPresentation(
      "hysteresis_point_005",
      "missing",
      "snapshot payload not found in hysteresis.zarr or JSON fallback",
    )).toEqual({
      disabled: true,
      title:
        "Snapshot payload is missing for this point: snapshot payload not found in hysteresis.zarr or JSON fallback",
    });
  });

  it("navigates hysteresis history from the live runtime point before a point is selected", () => {
    expect(resolveHysteresisNavigationIndex(-1, 4, 10)).toBe(4);
    expect(adjacentHysteresisPointIndex(-1, 4, 10, 1)).toBe(5);
    expect(adjacentHysteresisPointIndex(-1, 4, 10, -1)).toBe(3);
    expect(nextHysteresisPlaybackIndex(-1, 4, 10)).toBe(5);
    expect(nextHysteresisPlaybackIndex(9, 4, 10)).toBe(0);
  });

  it("resolves hysteresis keyboard navigation only for local arrow keys", () => {
    expect(resolveHysteresisKeyboardNavigationIndex("ArrowRight", -1, 4, 10)).toBe(5);
    expect(resolveHysteresisKeyboardNavigationIndex("ArrowLeft", -1, 4, 10)).toBe(3);
    expect(resolveHysteresisKeyboardNavigationIndex("ArrowRight", 9, 4, 10)).toBe(9);
    expect(resolveHysteresisKeyboardNavigationIndex("ArrowLeft", 0, 4, 10)).toBe(0);
    expect(resolveHysteresisKeyboardNavigationIndex("Enter", 4, 4, 10)).toBeNull();
    expect(resolveHysteresisKeyboardNavigationIndex("ArrowRight", -1, null, 0)).toBeNull();
  });

  it("resolves scrubber input values to safe hysteresis point indices", () => {
    expect(resolveHysteresisScrubberPointIndex("2", 5)).toBe(2);
    expect(resolveHysteresisScrubberPointIndex("2.8", 5)).toBe(3);
    expect(resolveHysteresisScrubberPointIndex("-4", 5)).toBe(0);
    expect(resolveHysteresisScrubberPointIndex("99", 5)).toBe(4);
    expect(resolveHysteresisScrubberPointIndex("not-a-number", 5)).toBeNull();
    expect(resolveHysteresisScrubberPointIndex("0", 0)).toBeNull();
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

  it("keeps the hysteresis plot active for root, child, and snapshot selections", () => {
    expect(selectedHysteresisStageIdFromSelection({
      kind: "study.stage.hysteresis",
      label: "Hysteresis 1",
      moduleSource: "explorer",
      nodeId: "model:study:stages:stage:hysteresis-1",
      objectId: null,
      ref: {
        kind: "study.stage.hysteresis",
        nodeId: "model:study:stages:stage:hysteresis-1",
        stageId: "hysteresis-1",
        stageIndex: 0,
        type: "study-stage",
      },
    })).toBe("hysteresis-1");

    expect(selectedHysteresisStageIdFromSelection({
      kind: "study.stage.action",
      label: "Live Run",
      moduleSource: "explorer",
      nodeId: "model:study:stages:stage:hysteresis-1:live-run",
      objectId: null,
      ref: {
        kind: "study.stage.action",
        nodeId: "model:study:stages:stage:hysteresis-1:live-run",
        stageId: "hysteresis-1",
        stageIndex: 0,
        type: "study-stage",
      },
    })).toBe("hysteresis-1");

    for (const nodeSuffix of [
      "orientation",
      "adaptive-refinement",
      "angular-family",
      "settle-pipeline",
      "points",
      "snapshots",
      "field-current",
    ]) {
      expect(selectedHysteresisStageIdFromSelection({
        kind: "study.stage.action",
        label: nodeSuffix,
        moduleSource: "explorer",
        nodeId: `model:study:stages:stage:hysteresis-1:${nodeSuffix}`,
        objectId: null,
        ref: {
          kind: "study.stage.action",
          nodeId: `model:study:stages:stage:hysteresis-1:${nodeSuffix}`,
          stageId: "hysteresis-1",
          stageIndex: 0,
          type: "study-stage",
        },
      })).toBe("hysteresis-1");
    }

    expect(selectedHysteresisStageIdFromSelection({
      kind: "study.stage.action",
      label: "Snapshot hysteresis_point_005",
      moduleSource: "explorer",
      nodeId: "model:study:stages:stage:hysteresis-1:field-point:4:snapshot:hysteresis_point_005",
      objectId: null,
      ref: {
        kind: "study.stage.action",
        nodeId: "model:study:stages:stage:hysteresis-1:field-point:4:snapshot:hysteresis_point_005",
        pointId: 4,
        quantityId: "m",
        snapshotId: "hysteresis_point_005",
        stageId: "hysteresis-1",
        stageIndex: 0,
        targetId: "hysteresis-step:hysteresis-1:4",
        type: "hysteresis-snapshot",
      },
    })).toBe("hysteresis-1");

    expect(selectedHysteresisStageIdFromSelection({
      kind: "analysis.chart-point",
      label: "Point 4",
      moduleSource: "analysis-plots",
      nodeId: "analysis:hysteresis:hysteresis-1:point:4",
      objectId: null,
      ref: {
        chartId: "hysteresis:hysteresis-1",
        kind: "analysis.chart-point",
        nodeId: "analysis:hysteresis:hysteresis-1:point:4",
        pointId: 4,
        quantity: "m",
        rowIndex: 4,
        seriesId: "hysteresis:hysteresis-1:m_parallel",
        stageId: "hysteresis-1",
        tableId: "hysteresis:hysteresis-1",
        type: "analysis-chart-point",
        x: 10,
        y: 0.25,
      },
    })).toBe("hysteresis-1");

    expect(selectedHysteresisStageIdFromSelection({
      kind: "study.stage.relax",
      label: "Relax",
      moduleSource: "explorer",
      nodeId: "model:study:stages:stage:relax-1",
      objectId: null,
      ref: {
        kind: "study.stage.relax",
        nodeId: "model:study:stages:stage:relax-1",
        stageId: "relax-1",
        stageIndex: 1,
        type: "study-stage",
      },
    })).toBeNull();
  });

  it("builds the load-in-3D command input when selecting a hysteresis chart point", () => {
    const point = {
      field_value_mT: -15,
      m_avg: [0.1, 0.2, 0.3],
      m_ip: 0.224,
      m_oop: 0.3,
      m_parallel: 0.8,
      point_id: 7,
      snapshot_id: "hysteresis_point_008",
      snapshot_resource_ref: "data/fields/m?snapshot_id=hysteresis_point_008",
      status: "Completed",
    };

    expect(buildHysteresisSelectPointCommandInput({
      point,
      stageId: "hysteresis-1",
      targetMetadata: {
        fieldOrientation: "oop_positive",
        fieldRevision: 42,
        measurementAxis: "parallel_to_field",
        meshIdentity: "mesh:shared:1",
      },
      yAxisKey: "m_parallel",
    })).toEqual(buildHysteresisLoadPointIn3DInput({
      point,
      stageId: "hysteresis-1",
      targetMetadata: {
        fieldOrientation: "oop_positive",
        fieldRevision: 42,
        measurementAxis: "parallel_to_field",
        meshIdentity: "mesh:shared:1",
      },
      yAxisKey: "m_parallel",
    }));
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

  it("clears a hysteresis snapshot explorer selection for the active stage when returning to live", () => {
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    const kernel = { selection } as Pick<KernelApi, "selection">;

    selection.set({
      kind: "study.stage.action",
      label: "Snapshot hysteresis_point_005",
      nodeId: "study:stage:0:field-point:4:snapshot:hysteresis_point_005",
      objectId: null,
      ref: {
        kind: "study.stage.action",
        nodeId: "study:stage:0:field-point:4:snapshot:hysteresis_point_005",
        pointId: 4,
        quantityId: "m",
        resourceRef: snapshotVectorResourceKey("hysteresis_point_005"),
        snapshotId: "hysteresis_point_005",
        stageId: "hysteresis-1",
        stageIndex: 0,
        targetId: "hysteresis-step:hysteresis-1:4",
        type: "hysteresis-snapshot",
      },
    }, "explorer");

    expect(clearHysteresisPointSelectionForLive(
      kernel,
      "hysteresis-2",
      "analysis-plots",
    )).toBe(false);
    expect(selection.get().ref).toMatchObject({
      snapshotId: "hysteresis_point_005",
      stageId: "hysteresis-1",
      type: "hysteresis-snapshot",
    });

    expect(clearHysteresisPointSelectionForLive(
      kernel,
      "hysteresis-1",
      "analysis-plots",
    )).toBe(true);
    expect(selection.get()).toEqual({
      kind: null,
      label: null,
      moduleSource: "analysis-plots",
      nodeId: null,
      objectId: null,
      ref: null,
    });
  });

  it("renders chart and axis column controls in the analysis surface", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        activeSurface="dynamics"
        datasetRefs={["default"]}
        kernel={mockKernel}
        onDatasetRefChange={() => undefined}
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        range={null}
        selectedPoint={null}
        selectedDatasetRef="default"
        table={chartWindow(table)}
        tableStatus="ready"
        selectedSeriesIds={["data.table:default:step:mx"]}
      />,
    );

    expect(html).toContain("Magnetization dynamics");
    expect(html).toContain("2 rows");
    expect(html).toContain('class="fm-analysis-plots__echarts"');
    expect(html).toContain('class="fm-analysis-plots__echarts"');
    expect(html).toContain("mx");
  });

  it("prefers semantic table unsupported status over a ready raw refresh", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        activeSurface="dynamics"
        datasetRefs={["default"]}
        kernel={mockKernel}
        onDatasetRefChange={() => undefined}
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        range={null}
        selectedPoint={null}
        selectedDatasetRef="default"
        table={chartWindow(table)}
        tableStatus="unsupported"
        tableUnsupportedReason="The selected dataset does not publish scalar table samples."
        selectedSeriesIds={["data.table:default:step:mx"]}
      />,
    );

    expect(html).toContain("The selected dataset does not publish scalar table samples.");
  });

  it("renders frequency-domain series as a dedicated analysis subchart", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        activeSurface="resonance-fmr"
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
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        range={null}
        selectedPoint={null}
        sourceChartId="frequency-response:artifact://response-sweep"
        tableStatus="idle"
        table={null}
        xAxisId="step"
        selectedSeriesIds={["analysis.frequency-domain:response:amplitude"]}
      />,
    );

    expect(html).toContain("Frequency-domain response sweep");
    expect(html).toContain("Frequency-domain series");
    expect(html).toContain("Amplitude");
    expect(html).toContain(ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH);
    expect(html).toContain("frequency-response:artifact://response-sweep");
  });

  it("keeps an explicit empty artifact selection empty instead of falling back to table selection", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        activeSurface="resonance-fmr"
        kernel={mockKernel}
        frequencyDomainSeries={[{
          id: "analysis.frequency-domain:response:amplitude",
          label: "Amplitude",
          points: [{ rowIndex: 0, x: 9.5, y: 2 }],
          quantity: "amplitude",
          source: { kind: "analysis.frequency_domain", resourceKey: "artifact://response-sweep", tableId: "frequency-domain:response-sweep" },
          status: "ready",
          unit: "a.u.",
          xUnit: "GHz",
        }]}
        frequencyDomainStatus="ready"
        frequencyDomainTitle="Frequency-domain response sweep"
        selectedSeriesIds={[]}
        sourceChartId="frequency-response:artifact://response-sweep"
      />,
    );

    expect(html).toContain("Select at least one signal");
    expect(html).not.toContain('data-chart-model-key="frequency-response:artifact://response-sweep"');
  });

  it("renders FMR workflow context for modal spectrum charts", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        activeSurface="resonance-fmr"
        kernel={mockKernel}
        frequencyDomainSeries={[
          {
            id: "analysis.frequency-domain:eigen:spectrum:frequency",
            label: "Eigen frequency",
            points: [{ rowIndex: 0, x: 1, y: 9.5 }],
            quantity: "frequency",
            source: {
              kind: "analysis.frequency_domain",
              resourceKey: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
              tableId: "frequency-domain:eigen-spectrum",
            },
            status: "ready",
            unit: "GHz",
            xUnit: "mode index",
          },
        ]}
        frequencyDomainCalculationMode="fmr_modal"
        frequencyDomainStatus="ready"
        frequencyDomainTitle="FMR modal spectrum"
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        range={null}
        selectedPoint={null}
        tableStatus="idle"
        table={null}
        xAxisId="step"
        selectedSeriesIds={["data.table:default:step:mx"]}
      />,
    );

    expect(html).toContain("Frequency-domain workflow");
    expect(html).toContain("Workflow");
    expect(html).toContain("FMR modal");
    expect(html).toContain("Next");
    expect(html).toContain("select mode to 3D overlay");
    expect(html).toContain("Mode fields");
    expect(html).toContain("mode inspector");
    expect(html).toContain("Frequency-domain workbench");
    expect(html).toContain("FMR modal spectrum");
    expect(html).toContain("1 point");
    expect(html).toContain("9.5 GHz");
    expect(html).toContain("select mode -&gt; FMR 3D overlay");
  });

  it("renders FMR workflow context for driven response charts", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        activeSurface="resonance-fmr"
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
        frequencyDomainCalculationMode="fmr_response"
        frequencyDomainStatus="ready"
        frequencyDomainTitle="FMR response sweep"
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        range={null}
        selectedPoint={null}
        tableStatus="idle"
        table={null}
        xAxisId="step"
        selectedSeriesIds={["data.table:default:step:mx"]}
      />,
    );

    expect(html).toContain("Frequency-domain workflow");
    expect(html).toContain("FMR driven");
    expect(html).toContain("select frequency to response overlay");
    expect(html).toContain("Response fields");
    expect(html).toContain("response point inspector");
    expect(html).toContain("Frequency-domain workbench");
    expect(html).toContain("FMR driven sweep");
    expect(html).toContain("1 point");
    expect(html).toContain("9.5 GHz");
    expect(html).toContain("select frequency -&gt; FMR response overlay");
  });

  it("renders selected frequency-domain point context for inspector follow-up", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        activeSurface="resonance-fmr"
        kernel={mockKernel}
        frequencyDomainSeries={[
          {
            id: "analysis.frequency-domain:eigen:spectrum:frequency",
            label: "Eigen frequency",
            points: [{ rowIndex: 0, x: 1, y: 9.5 }],
            quantity: "frequency",
            source: {
              kind: "analysis.frequency_domain",
              resourceKey: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
              tableId: "frequency-domain:eigen-spectrum",
            },
            status: "ready",
            unit: "GHz",
            xUnit: "mode index",
          },
        ]}
        frequencyDomainStatus="ready"
        frequencyDomainTitle="Frequency-domain modal spectrum"
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        range={null}
        selectedPoint={{
          label: "Eigen frequency",
          point: { rowIndex: 0, x: 1, y: 9.5 },
          quantity: "frequency",
          seriesId: "analysis.frequency-domain:eigen:spectrum:frequency",
          source: {
            kind: "analysis.frequency_domain",
            resourceKey: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
            tableId: "frequency-domain:eigen-spectrum",
          },
          unit: "GHz",
          xUnit: "mode index",
        }}
        tableStatus="idle"
        table={null}
        xAxisId="step"
        selectedSeriesIds={["data.table:default:step:mx"]}
      />,
    );

    expect(html).toContain("Selected frequency-domain point");
    expect(html).toContain("Selected");
    expect(html).toContain("eigen mode");
    expect(html).toContain("mode");
    expect(html).toContain("1 mode index");
    expect(html).toContain("frequency");
    expect(html).toContain("9.5 GHz");
    expect(html).toContain("Mode inspector and 3D mode controls");
  });

  it("renders selected FMR modal point context as a 3D overlay workflow", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        activeSurface="resonance-fmr"
        kernel={mockKernel}
        frequencyDomainSeries={[
          {
            id: "analysis.frequency-domain:eigen:spectrum:frequency",
            label: "Eigen frequency",
            points: [{ rowIndex: 0, x: 1, y: 9.5 }],
            quantity: "frequency",
            source: {
              kind: "analysis.frequency_domain",
              resourceKey: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
              tableId: "frequency-domain:eigen-spectrum",
            },
            status: "ready",
            unit: "GHz",
            xUnit: "mode index",
          },
        ]}
        frequencyDomainCalculationMode="fmr_modal"
        frequencyDomainStatus="ready"
        frequencyDomainTitle="FMR modal spectrum"
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        range={null}
        selectedPoint={{
          label: "Eigen frequency",
          point: { rowIndex: 0, x: 1, y: 9.5 },
          quantity: "frequency",
          seriesId: "analysis.frequency-domain:eigen:spectrum:frequency",
          source: {
            kind: "analysis.frequency_domain",
            resourceKey: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
            tableId: "frequency-domain:eigen-spectrum",
          },
          unit: "GHz",
          xUnit: "mode index",
        }}
        tableStatus="idle"
        table={null}
        xAxisId="step"
        selectedSeriesIds={["data.table:default:step:mx"]}
      />,
    );

    expect(html).toContain("FMR mode");
    expect(html).toContain("FMR mode inspector and 3D overlay controls");
  });

  it("renders the DSF dispersion surface instead of modal-point labels", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        activeSurface="dispersion"
        kernel={mockKernel}
        frequencyDomainSeries={[]}
        frequencyDomainStatus="ready"
        frequencyDomainTitle="Frequency-domain dispersion"
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        range={null}
        selectedPoint={{
          label: "Branch acoustic",
          point: {
            label: "G",
            linewidthHz: 2.8e6,
            rowIndex: 0,
            x: 0,
            y: 9.5,
          },
          quantity: "frequency",
          seriesId: "analysis.frequency-domain:eigen:dispersion:acoustic",
          source: {
            kind: "analysis.frequency_domain",
            resourceKey: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
            tableId: "frequency-domain:eigen-dispersion",
          },
          unit: "GHz",
          xUnit: "rad/m",
        }}
        tableStatus="idle"
        table={null}
        xAxisId="step"
        selectedSeriesIds={["data.table:default:step:mx"]}
      />,
    );

    expect(html).toContain("Dynamic structure factor S(k,f)");
    expect(html).toContain("bounded heatmap");
  });

  it("renders selected FMR response point context as a response-field overlay workflow", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        activeSurface="resonance-fmr"
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
        frequencyDomainCalculationMode="fmr_response"
        frequencyDomainStatus="ready"
        frequencyDomainTitle="FMR response sweep"
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        range={null}
        selectedPoint={{
          label: "Amplitude",
          point: { rowIndex: 0, x: 9.5, y: 2 },
          quantity: "amplitude",
          seriesId: "analysis.frequency-domain:response:amplitude",
          source: {
            kind: "analysis.frequency_domain",
            resourceKey: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
            tableId: "frequency-domain:response-sweep",
          },
          unit: "a.u.",
          xUnit: "GHz",
        }}
        tableStatus="idle"
        table={null}
        xAxisId="step"
        selectedSeriesIds={["data.table:default:step:mx"]}
      />,
    );

    expect(html).toContain("FMR response point");
    expect(html).toContain(
      "FMR response point inspector and 3D response overlay",
    );
  });

  it("shows the explicit unavailable artifact state for an uncomputed frequency response", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        activeSurface="resonance-fmr"
        kernel={mockKernel}
        frequencyDomainSeries={[]}
        frequencyDomainStatus="stale"
        frequencyDomainTitle="Frequency-domain modal spectrum"
        frequencyDomainUnavailableReason="spectrum artifact is missing"
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        range={null}
        selectedPoint={null}
        tableStatus="idle"
        table={null}
        xAxisId="step"
        selectedSeriesIds={["data.table:default:step:mx"]}
      />,
    );

    expect(html).toContain("Frequency-domain modal spectrum");
    expect(html).toContain("spectrum artifact is missing");
    expect(html).not.toContain("Frequency-domain series legend");
  });

  it("renders frequency-domain loading state while artifact resources resolve", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        activeSurface="resonance-fmr"
        kernel={mockKernel}
        frequencyDomainSeries={[]}
        frequencyDomainStatus="loading"
        frequencyDomainTitle="Frequency-domain dispersion"
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        range={null}
        selectedPoint={null}
        tableStatus="idle"
        table={null}
        xAxisId="step"
        selectedSeriesIds={["data.table:default:step:mx"]}
      />,
    );

    expect(html).toContain("Frequency-domain dispersion");
    expect(html).toContain("Loading frequency-domain artifacts");
  });

  it("renders explicit response-map unavailable state when the mode is selected", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        activeSurface="resonance-fmr"
        kernel={mockKernel}
        frequencyDomainSeries={[]}
        frequencyDomainStatus="error"
        frequencyDomainTitle="Frequency-domain response map"
        frequencyDomainUnavailableReason="response-map chart adapter is not available yet"
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        range={null}
        selectedPoint={null}
        tableStatus="idle"
        table={null}
        xAxisId="step"
        selectedSeriesIds={["data.table:default:step:mx"]}
      />,
    );

    expect(html).toContain("Frequency-domain response map");
    expect(html).toContain("response-map chart adapter is not available yet");
    expect(html).not.toContain("Frequency-domain series legend");
  });

  it("routes response-map explorer selections to the response-map chart surface", () => {
    expect(
      frequencyDomainChartRouteOverrideFromSelection({
        kind: "results.frequency_domain.response_map",
        label: "Response map",
        moduleSource: "explorer",
        nodeId: "results:frequency-domain:response-map",
        objectId: null,
        ref: {
          kind: "results.frequency_domain.response_map",
          nodeId: "results:frequency-domain:response-map",
          type: "frequency-domain",
        },
      }),
    ).toEqual({ mode: "response_map", primaryChart: "response-map" });
    expect(
      frequencyDomainChartRouteOverrideFromSelection({
        kind: "study.stage.frequency_response.k_grid",
        label: "k-Grid",
        moduleSource: "explorer",
        nodeId: "model:study:stages:stage:freq-1:k-grid",
        objectId: null,
        ref: {
          kind: "study.stage.frequency_response.k_grid",
          nodeId: "model:study:stages:stage:freq-1:k-grid",
          type: "frequency-domain",
        },
      }),
    ).toEqual({ mode: "response_map", primaryChart: "response-map" });
  });

  it("maps frequency-domain chart clicks to frequency-domain selections", () => {
    const responseModel = buildFrequencyResponseChartModel(
      {
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
      },
      {
        resources: {
          response_field_resources: [
            {
              field_resource_id: "analysis:frequency-response:frequency-0042",
              frequency_index: 7,
              payload_path:
                "response/field_payloads/frequency_0007/vector_xyz.bin",
            },
          ],
        },
        schema_version: "frequency_domain_manifest.v1",
      },
    );

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
        fieldId: "analysis:frequency-response:frequency-0042",
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

  it("maps modal spectrum ECharts clicks to eigen mode selections", () => {
    const spectrumModel = buildEigenSpectrumChartModel({
      artifact_path: "eigen/spectrum.v2.json",
      payload: {
        modes: [
          {
            frequency_hz: 9.5e9,
            mode_field_id: "analysis:eigen:sample-0000:mode-0001",
            mode_field_resource_key: analysisFieldVectorResourceKey(
              "analysis:eigen:sample-0000:mode-0001",
            ),
            raw_mode_index: 1,
            sample_index: 0,
          },
        ],
      },
      status: "ready",
    });

    const selection = frequencyDomainSelectionFromPoint({
      dispersionModel: buildEigenDispersionChartModel({ status: "idle" }),
      point: {
        label: "Eigen frequency",
        point: { rowIndex: 0, x: 1, y: 9.5 },
        quantity: "frequency",
        seriesId: "analysis.frequency-domain:eigen:spectrum:frequency",
        source: {
          kind: "analysis.frequency_domain",
          resourceKey: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
          tableId: "frequency-domain:eigen-spectrum",
        },
        unit: "GHz",
        xUnit: "mode index",
      },
      responseModel: buildFrequencyResponseChartModel({ status: "idle" }),
      routeMode: "free_modes",
      spectrumModel,
    });

    expect(selection).toEqual({
      kind: "results.eigen.mode",
      label: "Eigen frequency 9.5 GHz",
      nodeId:
        "analysis:charts:frequency-domain:eigen-spectrum:point:analysis.frequency-domain:eigen:spectrum:frequency:0",
      objectId: null,
      ref: {
        artifactPath: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
        calculationMode: "free_modes",
        fieldId: "analysis:eigen:sample-0000:mode-0001",
        kind: "results.eigen.mode",
        modeIndex: 1,
        nodeId:
          "analysis:charts:frequency-domain:eigen-spectrum:point:analysis.frequency-domain:eigen:spectrum:frequency:0",
        resourceRef: analysisFieldVectorResourceKey("analysis:eigen:sample-0000:mode-0001"),
        sampleIndex: 0,
        type: "frequency-domain",
      },
    });
  });

  it("maps dispersion ECharts clicks to dispersion point selections", () => {
    const dispersionModel = buildEigenDispersionChartModel({
      status: "ready",
      text: [
        "sample_index,raw_mode_index,branch_id,path_s_rad_per_m,frequency_hz,mode_field_id,mode_field_resource_key",
        `4,5,acoustic,78539816.33974482,12.5e9,analysis:eigen:sample-0004:mode-0005,${analysisFieldVectorResourceKey("analysis:eigen:sample-0004:mode-0005")}`,
      ].join("\n"),
    });

    const selection = frequencyDomainSelectionFromPoint({
      dispersionModel,
      point: {
        label: "Branch acoustic",
        point: { rowIndex: 0, x: 78539816.33974482, y: 12.5 },
        quantity: "frequency",
        seriesId: "analysis.frequency-domain:eigen:dispersion:acoustic",
        source: {
          kind: "analysis.frequency_domain",
          resourceKey: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
          tableId: "frequency-domain:eigen-dispersion",
        },
        unit: "GHz",
        xUnit: "rad/m",
      },
      responseModel: buildFrequencyResponseChartModel({ status: "idle" }),
      routeMode: "dispersion_modal",
      spectrumModel: buildEigenSpectrumChartModel({ status: "idle" }),
    });

    expect(selection).toEqual({
      kind: "results.eigen.mode",
      label: "Branch acoustic 12.5 GHz",
      nodeId:
        "analysis:charts:frequency-domain:eigen-dispersion:point:analysis.frequency-domain:eigen:dispersion:acoustic:0",
      objectId: null,
      ref: {
        artifactPath: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
        branchId: "acoustic",
        calculationMode: "dispersion_modal",
        fieldId: "analysis:eigen:sample-0004:mode-0005",
        kind: "results.eigen.mode",
        modeIndex: 5,
        nodeId:
          "analysis:charts:frequency-domain:eigen-dispersion:point:analysis.frequency-domain:eigen:dispersion:acoustic:0",
        resourceRef: analysisFieldVectorResourceKey(
          "analysis:eigen:sample-0004:mode-0005",
        ),
        sampleIndex: 4,
        type: "frequency-domain",
      },
    });
  });

  it("routes frequency-domain explorer selections to matching chart surfaces", () => {
    expect(
      frequencyDomainChartRouteOverrideFromSelection({
        kind: "results.frequency_domain.fmr_modal_spectrum",
        label: "FMR Modal Spectrum",
        moduleSource: "explorer",
        nodeId: "results:frequency-domain:fmr:modal-spectrum",
        objectId: null,
        ref: {
          kind: "results.frequency_domain.fmr_modal_spectrum",
          nodeId: "results:frequency-domain:fmr:modal-spectrum",
          type: "frequency-domain",
        },
      }),
    ).toEqual({ mode: "fmr_modal", primaryChart: "modal-spectrum" });
    expect(
      frequencyDomainChartRouteOverrideFromSelection({
        kind: "results.eigen.spectrum",
        label: "Spectrum",
        moduleSource: "explorer",
        nodeId: "results:eigen:spectrum",
        objectId: null,
        ref: {
          kind: "results.eigen.spectrum",
          nodeId: "results:eigen:spectrum",
          type: "frequency-domain",
        },
      }),
    ).toEqual({ mode: "free_modes", primaryChart: "modal-spectrum" });
    expect(
      frequencyDomainChartRouteOverrideFromSelection({
        kind: "results.eigen.dispersion",
        label: "Dispersion",
        moduleSource: "explorer",
        nodeId: "results:eigen:dispersion",
        objectId: null,
        ref: {
          kind: "results.eigen.dispersion",
          nodeId: "results:eigen:dispersion",
          type: "frequency-domain",
        },
      }),
    ).toEqual({ mode: "dispersion_modal", primaryChart: "dispersion" });
    expect(
      frequencyDomainChartRouteOverrideFromSelection({
        kind: "results.frequency_response.sweep",
        label: "Response sweep",
        moduleSource: "explorer",
        nodeId: "results:frequency-response:sweep",
        objectId: null,
        ref: {
          kind: "results.frequency_response.sweep",
          nodeId: "results:frequency-response:sweep",
          type: "frequency-domain",
        },
      }),
    ).toEqual({ mode: "fmr_response", primaryChart: "response-sweep" });
  });

  it("labels frequency-domain chart surfaces by calculation mode", () => {
    expect(frequencyDomainChartTitle("modal-spectrum", "fmr_modal")).toBe(
      "FMR modal spectrum",
    );
    expect(frequencyDomainChartTitle("modal-spectrum", "free_modes")).toBe(
      "Frequency-domain modal spectrum",
    );
    expect(frequencyDomainChartTitle("response-sweep", "fmr_response")).toBe(
      "FMR response sweep",
    );
    expect(frequencyDomainChartTitle("dispersion", "dispersion_modal")).toBe(
      "Frequency-domain dispersion",
    );
  });

  it("renders active zoom range with a clear action", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        activeSurface="dynamics"
        datasetRefs={["default"]}
        kernel={mockKernel}
        onDatasetRefChange={() => undefined}
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        range={{ fromValue: 10, toValue: 20 }}
        selectedPoint={null}
        selectedDatasetRef="default"
        tableStatus="ready"
        table={chartWindow(table)}
        xAxisId="step"
        selectedSeriesIds={["data.table:default:step:mx"]}
      />,
    );

    expect(html).toContain("zoom 10-20");
    expect(html).not.toContain("Clear zoom");
  });

  it("renders compact chart status for axes, sample counts, and zoom state", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        activeSurface="dynamics"
        datasetRefs={["default"]}
        kernel={mockKernel}
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        range={null}
        selectedPoint={null}
        selectedDatasetRef="default"
        tableStatus="ready"
        table={chartWindow(table)}
        xAxisId="step"
        selectedSeriesIds={["data.table:default:step:mx"]}
      />,
    );

    // ChartSection header now carries compact status via fm-chart-section__header-meta
    expect(html).toContain('class="fm-chart-section__header"');
    // ChartControlBar or ChartSection status shows live state
    expect(html).toContain('class="fm-chart-section__body"');
    // The chart data-attr encodes axis and sample counts
    expect(html).toContain('data-chart-model-key=');
  });

  it("renders selected chart cursor point in compact status", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        activeSurface="dynamics"
        datasetRefs={["default"]}
        kernel={mockKernel}
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
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
        selectedDatasetRef="default"
        tableStatus="ready"
        table={chartWindow(table)}
        xAxisId="step"
        selectedSeriesIds={["data.table:default:step:mx"]}
      />,
    );

    // ChartSection footer row contains the cursor value
    expect(html).toContain('class="fm-chart-section__footer"');
    // The range-cursor span shows the selected point label and value
    expect(html).toContain('class="fm-analysis-plots__range-cursor"');
  });

  it("renders table loading diagnostics in the chart frame before samples exist", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        activeSurface="dynamics"
        datasetRefs={["default"]}
        kernel={mockKernel}
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        range={null}
        selectedPoint={null}
        selectedDatasetRef="default"
        table={null}
        tableStatus="loading"
        selectedSeriesIds={["data.table:default:step:mx"]}
      />,
    );

    expect(html).toContain("Loading table samples");
    expect(html).not.toContain("No table samples");
  });

  it("renders a series legend with units and latest values from visible rows", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        activeSurface="dynamics"
        datasetRefs={["default"]}
        kernel={mockKernel}
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        range={null}
        selectedPoint={null}
        selectedDatasetRef="default"
        tableStatus="ready"
        table={chartWindow(table)}
        xAxisId="step"
        selectedSeriesIds={["data.table:default:step:mx"]}
      />,
    );

    // New ChartLegend uses fm-chart-legend* classes (not fm-analysis-plots__legend*)
    expect(html).toContain('class="fm-chart-legend__item"');
    expect(html).toContain('<button');
    expect(html).toContain('type="button"');
    // ChartLegend aria-label format: "label, unit UNIT, latest VALUE. Visible/Hidden..."
    expect(html).toContain('aria-label="mx, unit dimensionless, latest 0.2');
    expect(html).toContain('class="fm-chart-legend__swatch');
    expect(html).toContain('class="fm-chart-legend__latest"');
  });

  it("renders an empty selected-series state without restoring chart data", () => {
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        activeSurface="dynamics"
        datasetRefs={["default"]}
        kernel={mockKernel}
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        range={null}
        selectedPoint={null}
        selectedDatasetRef="default"
        tableStatus="ready"
        table={chartWindow(table)}
        xAxisId="step"
        selectedSeriesIds={[]}
      />,
    );

    expect(html).toContain("Select at least one signal");
    expect(html).not.toContain("Loading chart renderer");
  });

  it("keeps normalized legend readings dimensionless", () => {
    const normalizedTable = {
      ...table,
      rows: [[1, 4.447e-6]],
    };
    const html = renderToStaticMarkup(
      <AnalysisPlotsView
        activeSurface="dynamics"
        datasetRefs={["default"]}
        kernel={mockKernel}
        onPointSelect={() => undefined}
        onRangeChange={() => undefined}
        range={null}
        selectedPoint={{
          label: "mx",
          point: { rowIndex: 0, x: 1, y: 4.447e-6 },
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
        selectedDatasetRef="default"
        tableStatus="ready"
        table={chartWindow(normalizedTable)}
        xAxisId="step"
        selectedSeriesIds={["data.table:default:step:mx"]}
      />,
    );

    expect(html).toContain(
      'aria-label="mx, unit dimensionless, latest 4.4470e-6',
    );
    expect(html).toContain("cursor mx: 4.4470e-6");
    expect(html).not.toContain("m1");
  });

  it("keeps solver energy adaptation independent of the Analysis dataset view", () => {
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

    expect(solverEnergySeries).toHaveLength(6);
    expect(solverEnergySeries.map((series) => series.label)).toEqual(
      expect.arrayContaining(["E exchange", "E total"]),
    );
    expect(solverEnergySeries[0]?.xUnit).toBe("s");
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

  it("keeps persisted empty selection empty when no selected series is available", () => {
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
    ).toEqual([]);
  });

  it("declares the add-series event path in the module manifest", () => {
    expect(analysisPlotsManifest.listens).toContain("analysis-plots:add-series-requested");
    expect(analysisPlotsManifest.emits).toContain("analysis-plots:range-selected");
    expect(analysisPlotsManifest.emits).toContain("analysis-plots:series-selected");
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
