import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { Accordion } from "@/shared/ui/Accordion";
import { KernelContext } from "@/kernel/KernelContext";
import {
  ANALYSIS_HYSTERESIS_POINTS_PATH,
  ANALYSIS_HYSTERESIS_METRICS_PATH,
  ANALYSIS_HYSTERESIS_REVERSAL_FIELDS_PATH,
  ANALYSIS_HYSTERESIS_SETTLE_TRACE_PATH,
  DATA_FIELD_VECTOR_PATH,
  SIMULATION_STAGE_HYSTERESIS_PLAN_PATH,
  SIMULATION_STAGE_HYSTERESIS_PROGRESS_PATH,
  SIMULATION_STAGE_HYSTERESIS_PROTOCOL_PATH,
  SIMULATION_STAGE_HYSTERESIS_SETTLE_PIPELINE_PATH,
} from "@/kernel/api/apiPaths";
import type {
  HysteresisMetricsSchema,
  HysteresisPointSchema,
  HysteresisProgressSchema,
  HysteresisProtocolSchema,
  HysteresisSettleTraceEntrySchema,
  HysteresisSettlePipelineSchema,
  HysteresisStagePlanSchema,
} from "@/kernel/api/apiTypes";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { sharedResourceRuntimeStore } from "@/kernel/resources/ResourceRuntimeStore";
import { SelectionController } from "@/kernel/selection/SelectionController";
import type { KernelApi } from "@/kernel/types";

const selection = new SelectionController(new EventBus<KernelEventMap>());

const mockKernel = {
  commands: {
    execute: () => Promise.resolve(),
    register: () => () => {},
  },
  bus: {
    emit: () => {},
    on: () => () => {},
  },
  api: {
    analysis: {
      hysteresis: {
        points: () => Promise.resolve([]),
        metrics: () => Promise.resolve(null),
      },
    },
  },
  resources: {
    getRevision: () => 0,
    subscribe: () => () => {},
    read: () => null,
  },
  selection,
} as unknown as KernelApi;

import { createDefaultStudyStageDraft } from "../StudyStageAuthoringModel";
import { resolveStudyStageInspectorKind } from "../StudyStageInspectorRouter";
import type { StudyStageModel } from "../StudyInspectorPanelModel";
import { EigenmodesStageInspector } from "./EigenmodesStageInspector";
import { FrequencyResponseStageInspector } from "./FrequencyResponseStageInspector";
import {
  HysteresisStageInspector,
  hysteresisInitialStateActionPresentation,
} from "./HysteresisStageInspector";
import { resolveHysteresisInspectorView } from "./hysteresis/HysteresisInspectorUtils";
import { RelaxStageInspector } from "./RelaxStageInspector";
import { RunStageInspector } from "./RunStageInspector";
import { SaveStateStageInspector } from "./SaveStateStageInspector";
import type { StageInspectorFrameProps } from "./StageInspectorFrame";

function stage(kind: string): StudyStageModel {
  return {
    algorithm: null,
    artifactRefs: [],
    checkpointRef: null,
    commandId: null,
    completedAtIso: null,
    completedAtUnixMs: null,
    energyTolerance: null,
    index: 0,
    kind,
    label: kind,
    maxSteps: null,
    progressPercent: 0,
    runtimeMetric: null,
    stageId: `${kind}-1`,
    status: "queued",
    stopReason: null,
    torqueTolerance: null,
    torqueToleranceFormatted: null,
    torqueToleranceShortFormatted: null,
    untilSeconds: null,
  };
}

function props(kind: Parameters<typeof createDefaultStudyStageDraft>[0]): StageInspectorFrameProps {
  return {
    authoringBusy: false,
    authoringFeedback: null,
    draft: createDefaultStudyStageDraft(kind, 0),
    draftIndex: 0,
    expectedKind: kind,
    kindLabel: kind,
    onCommit: () => undefined,
    onUpdateDraft: () => undefined,
    stage: stage(kind),
    stageExecutionRevision: 7,
    validation: [],
  };
}

function render(
  children: ReactNode,
  defaultValue = ["identity", "authoring", "telemetry"],
): string {
  return renderToStaticMarkup(
    <KernelContext.Provider value={mockKernel}>
      <Accordion type="multiple" defaultValue={defaultValue}>
        {children}
      </Accordion>
    </KernelContext.Provider>,
  );
}

describe("Study stage inspectors", () => {
  it("renders a dedicated inspector for every supported study stage kind", () => {
    expect(render(<RelaxStageInspector {...props("relax")} />)).toContain(
      "Stop Criteria",
    );
    expect(render(<RelaxStageInspector {...props("relax")} />)).toContain(
      "Numerics",
    );
    expect(render(<RunStageInspector {...props("run")} />)).toContain(
      "Time Integration",
    );
    expect(render(<RunStageInspector {...props("run")} />)).toContain(
      "Drive &amp; Dynamics",
    );
    expect(
      render(<HysteresisStageInspector {...props("hysteresis")} />),
    ).toContain("Measurement Plan");
    expect(
      render(<HysteresisStageInspector {...props("hysteresis")} />),
    ).toContain("Settle Pipeline");
    expect(
      render(<HysteresisStageInspector {...props("hysteresis")} />),
    ).toContain("Live Progress");
    expect(
      render(<HysteresisStageInspector {...props("hysteresis")} />),
    ).toContain("Live");
    expect(
      render(<EigenmodesStageInspector {...props("eigenmodes")} />),
    ).toContain("Eigenproblem");
    expect(
      render(<EigenmodesStageInspector {...props("eigenmodes")} />),
    ).toContain("Linearization State");
    expect(
      render(
        <FrequencyResponseStageInspector
          {...props("frequency_response")}
        />,
      ),
    ).toContain("Frequency Sweep");
    expect(
      render(
        <FrequencyResponseStageInspector
          {...props("frequency_response")}
        />,
      ),
    ).toContain("Spin-Wave Sampling");
    expect(render(<SaveStateStageInspector {...props("save_state")} />)).toContain(
      "Output Target",
    );
    expect(render(<SaveStateStageInspector {...props("save_state")} />)).toContain(
      "Captured State",
    );
  });

  it("enables hysteresis initial-state action when a point snapshot exists", () => {
    expect(hysteresisInitialStateActionPresentation("hysteresis_point_005")).toEqual({
      disabled: false,
      title: "Use point magnetization as the initial state for the selected or only object",
    });
    expect(hysteresisInitialStateActionPresentation(null)).toEqual({
      disabled: true,
      title: "Snapshot not saved for this point",
    });
  });

  it("routes hysteresis explorer child actions to the hysteresis inspector", () => {
    expect(resolveStudyStageInspectorKind("study.stage.action", "hysteresis")).toBe(
      "hysteresis",
    );
    expect(resolveStudyStageInspectorKind("study.stage.hysteresis", null)).toBe(
      "hysteresis",
    );
  });

  it("resolves dedicated hysteresis inspector views from explorer child nodes", () => {
    expect(resolveHysteresisInspectorView("study:stage:0:plan")).toBe("plan");
    expect(resolveHysteresisInspectorView("study:stage:0:saturation")).toBe(
      "saturation",
    );
    expect(resolveHysteresisInspectorView("study:stage:0:live-run")).toBe(
      "live-run",
    );
    expect(resolveHysteresisInspectorView("study:stage:0:points:completed")).toBe(
      "points",
    );
    expect(resolveHysteresisInspectorView("study:stage:0:field-point:4")).toBe(
      "current-field",
    );
  });

  it("renders only the selected dedicated hysteresis child inspector view", () => {
    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="saturation" />,
      ["hysteresis-saturation"],
    );

    expect(markup).toContain("Auto-Saturation");
    expect(markup).not.toContain("Measurement Plan");
    expect(markup).not.toContain("Loop Metrics");
    expect(markup.indexOf("Auto-Saturation")).toBeLessThan(
      markup.indexOf("Identity"),
    );
  });

  it("renders live hysteresis field and active algorithm from the progress resource", () => {
    const progressKey = SIMULATION_STAGE_HYSTERESIS_PROGRESS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const progress: HysteresisProgressSchema = {
      active: true,
      active_point_index: 4,
      completed_points: 4,
      current_field_mT: 87.5,
      current_point_index: 4,
      current_settle_step_index: 1,
      current_settle_step_kind: "minimize",
      current_settle_step_method: "projected_gradient_bb",
      queued_points: 76,
      revision: 0,
      stage_id: "hysteresis-1",
      stage_index: 0,
      stage_kind: "hysteresis",
      status: "running",
      total_points: 81,
    };

    sharedResourceRuntimeStore.updateData(progressKey, progress, 0);

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} />,
      ["hysteresis-live-progress"],
    );

    expect(markup).toContain("87.50 mT");
    expect(markup).toContain("87.500");
    expect(markup).toContain("5 / 81");
    expect(markup).toContain("minimize projected_gradient_bb");
  });

  it("warns when saturation status only reflects an unverified preparation field", () => {
    const metricsKey = ANALYSIS_HYSTERESIS_METRICS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const metrics: HysteresisMetricsSchema = {
      H_c: 12.5,
      H_c_minus: -13,
      H_c_plus: 12,
      H_eb: -0.5,
      M_r_minus: -0.4,
      M_r_plus: 0.42,
      loop_area: 8.75,
      magnetization_average_weighting: "uniform_sample_average",
      saturation_preparation_field_mT: 300,
      saturation_status: "preparation_applied_unverified",
    };
    sharedResourceRuntimeStore.updateData(metricsKey, metrics, 0);

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="saturation" />,
      ["hysteresis-saturation"],
    );

    expect(markup).toContain("Preparation field only");
    expect(markup).toContain("H_sat is not confirmed");
    expect(markup).toContain("coercivity and remanence metrics have limited interpretation");
  });

  it("shows active first-point calculation before any hysteresis point is completed", () => {
    const progressKey = SIMULATION_STAGE_HYSTERESIS_PROGRESS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const progress: HysteresisProgressSchema = {
      active: true,
      active_point_index: 0,
      completed_points: 0,
      current_field_mT: 200,
      current_point_index: 0,
      current_settle_step_index: 0,
      current_settle_step_kind: "minimize",
      current_settle_step_method: "projected_gradient_bb",
      queued_points: 80,
      revision: 0,
      stage_id: "hysteresis-1",
      stage_index: 0,
      stage_kind: "hysteresis",
      status: "running",
      total_points: 81,
    };
    sharedResourceRuntimeStore.updateData(progressKey, progress, 0);

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="points" />,
      ["hysteresis-points"],
    );

    expect(markup).toContain("0 / 81 done");
    expect(markup).toContain("Calculating point 1 / 81 at 200.000 mT.");
    expect(markup).not.toContain("No calculated points available.");
  });

  it("renders hysteresis point settle quality warnings", () => {
    const pointsKey = ANALYSIS_HYSTERESIS_POINTS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const points: HysteresisPointSchema[] = [
      {
        branch_id: "descending",
        branch_ids: ["descending"],
        branch_index: 0,
        field_value_mT: -50,
        has_non_converged_steps: true,
        m_avg: [0.0, 0.0, -0.42],
        m_ip: 0,
        m_oop: -0.42,
        m_parallel: -0.42,
        minor_loop_id: null,
        parent_branch_id: null,
        point_id: 2,
        protocol_role: "return",
        recoil_start_point_id: null,
        reversal_index: null,
        run_status: "Completed",
        settle_status: "non_converged",
        snapshot_id: "hysteresis_point_003",
        snapshot_resource_ref: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_003`,
        status: "Completed",
        terminal_settle_reason: "converged",
        warning_count: 1,
      },
    ];
    sharedResourceRuntimeStore.updateData(pointsKey, points, 0);

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="points" />,
      ["hysteresis-points"],
    );

    expect(markup).toContain("Settle");
    expect(markup).toContain("non_converged");
    expect(markup).toContain("1 warning");
  });

  it("warns when progress reports completed hysteresis points but history is empty", () => {
    const pointsKey = ANALYSIS_HYSTERESIS_POINTS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const progressKey = SIMULATION_STAGE_HYSTERESIS_PROGRESS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const progress: HysteresisProgressSchema = {
      active: true,
      active_point_index: 1,
      completed_points: 1,
      current_field_mT: 95,
      current_point_index: 1,
      current_settle_step_index: 0,
      current_settle_step_kind: "minimize",
      current_settle_step_method: "projected_gradient_bb",
      queued_points: 79,
      revision: 0,
      stage_id: "hysteresis-1",
      stage_index: 0,
      stage_kind: "hysteresis",
      status: "running",
      total_points: 81,
    };
    sharedResourceRuntimeStore.updateData(pointsKey, [], 0);
    sharedResourceRuntimeStore.updateData(progressKey, progress, 0);

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="points" />,
      ["hysteresis-points"],
    );

    expect(markup).toContain("Hysteresis progress reports 1 completed point, but no point history is available.");
  });

  it("renders an active hysteresis snapshot with a return-to-live action", () => {
    selection.set(
      {
        kind: "analysis.chart-point",
        label: "Point 4 (25 mT)",
        nodeId: "analysis:hysteresis:hysteresis-1:point:4",
        objectId: null,
        ref: {
          chartId: "hysteresis:hysteresis-1",
          kind: "analysis.chart-point",
          nodeId: "analysis:hysteresis:hysteresis-1:point:4",
          pointId: 4,
          quantity: "m",
          rowIndex: 4,
          seriesId: "hysteresis:hysteresis-1:m",
          snapshotId: "hysteresis_point_005",
          stageId: "hysteresis-1",
          tableId: "hysteresis:hysteresis-1",
          type: "analysis-chart-point",
          x: 25,
          y: 0.8,
        },
      },
      "analysis-plots",
    );

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} />,
      ["hysteresis-live-progress"],
    );

    expect(markup).toContain("Snapshot hysteresis_point_005");
    expect(markup).toContain("4 at 25.000 mT");
    expect(markup).toContain("Return to live");

    selection.clear("analysis-plots");
  });

  it("renders settle trace for the selected hysteresis point", () => {
    selection.set(
      {
        kind: "analysis.chart-point",
        label: "Point 4 (25 mT)",
        nodeId: "analysis:hysteresis:hysteresis-1:point:4",
        objectId: null,
        ref: {
          chartId: "hysteresis:hysteresis-1",
          kind: "analysis.chart-point",
          nodeId: "analysis:hysteresis:hysteresis-1:point:4",
          pointId: 4,
          quantity: "m",
          rowIndex: 4,
          seriesId: "hysteresis:hysteresis-1:m",
          snapshotId: "hysteresis_point_005",
          stageId: "hysteresis-1",
          tableId: "hysteresis:hysteresis-1",
          type: "analysis-chart-point",
          x: 25,
          y: 0.8,
        },
      },
      "analysis-plots",
    );

    const settleTraceKey = ANALYSIS_HYSTERESIS_SETTLE_TRACE_PATH
      .replace("{stage_id}", "hysteresis-1")
      .replace("{point_id}", "4");
    const settleTrace: HysteresisSettleTraceEntrySchema[] = [
      {
        algorithm_id: "minimize",
        energy: -5.93e-16,
        fallback_reason: null,
        field_value_mT: 25,
        method: "projected_gradient_bb",
        point_id: 4,
        resolved_timestep_s: 1e-13,
        retry_attempt: 0,
        status: "converged",
        step_index: 0,
        torque: 2.6e-2,
      },
      {
        algorithm_id: "relax",
        energy: -5.94e-16,
        fallback_reason: "previous_step_non_converged",
        field_value_mT: 25,
        method: "llg_overdamped",
        point_id: 4,
        resolved_timestep_s: 5e-14,
        retry_attempt: 1,
        status: "non_converged",
        step_index: 1,
        torque: 5.1e-2,
      },
    ];
    sharedResourceRuntimeStore.updateData(settleTraceKey, settleTrace, 0);

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} />,
      ["hysteresis-settle-trace"],
    );

    expect(markup).toContain("Settle Trace");
    expect(markup).toContain("projected_gradient_bb");
    expect(markup).toContain("llg_overdamped");
    expect(markup).toContain("previous_step_non_converged");
    expect(markup).toContain("retry 1");

    selection.clear("analysis-plots");
  });

  it("renders detected hysteresis reversal fields in loop metrics", () => {
    const metricsKey = ANALYSIS_HYSTERESIS_METRICS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const reversalFieldsKey = ANALYSIS_HYSTERESIS_REVERSAL_FIELDS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const metrics: HysteresisMetricsSchema = {
      H_c: 12.5,
      H_c_minus: -13,
      H_c_plus: 12,
      H_eb: -0.5,
      M_r_minus: -0.4,
      M_r_plus: 0.42,
      loop_area: 8.75,
      magnetization_average_weighting: "uniform_sample_average",
      saturation_preparation_field_mT: 300,
      saturation_status: "saturated",
    };
    const reversalFields: HysteresisPointSchema[] = [
      {
        branch_id: "descending",
        branch_ids: ["descending", "ascending"],
        branch_index: 0,
        field_value_mT: -37.5,
        is_reversal_field: true,
        m_avg: [0.1, 0.0, -0.42],
        m_ip: 0.1,
        m_oop: -0.42,
        m_parallel: -0.42,
        minor_loop_id: null,
        parent_branch_id: null,
        point_id: 12,
        protocol_role: "return",
        recoil_start_point_id: 12,
        reversal_index: 0,
        snapshot_id: "hysteresis_point_013",
        snapshot_resource_ref: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_013`,
        status: "Completed",
      },
    ];
    sharedResourceRuntimeStore.updateData(metricsKey, metrics, 0);
    sharedResourceRuntimeStore.updateData(reversalFieldsKey, reversalFields, 0);

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="metrics" />,
      ["hysteresis-metrics"],
    );

    expect(markup).toContain("Reversal Fields");
    expect(markup).toContain("-37.500 mT (point 12)");
  });

  it("renders hysteresis plan from the runtime resource before falling back to the draft", () => {
    const planKey = SIMULATION_STAGE_HYSTERESIS_PLAN_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const plan: HysteresisStagePlanSchema = {
      branch_mode: "minor_loop",
      field_max_mT: 120,
      field_min_mT: -80,
      field_schedule: {
        segments: [
          {
            segment_id: "dense-remanence",
            start: 10,
            stop: -10,
            step: 1,
          },
        ],
      },
      field_step_mT: 5,
      field_values_mT: null,
      minor_loops: [],
      revision: 22,
      schedule_refinements: null,
      stage_id: "hysteresis-1",
      stage_index: 0,
    };
    sharedResourceRuntimeStore.updateData(planKey, plan, 22);

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="plan" />,
      ["hysteresis-plan"],
    );

    expect(markup).toContain("minor_loop");
    expect(markup).toContain("piecewise");
    expect(markup).toContain("1 segment(s) defined");
  });

  it("renders hysteresis protocol and settle pipeline from runtime resources", () => {
    const protocolKey = SIMULATION_STAGE_HYSTERESIS_PROTOCOL_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const settlePipelineKey = SIMULATION_STAGE_HYSTERESIS_SETTLE_PIPELINE_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const protocol: HysteresisProtocolSchema = {
      branch_mode: "major_with_minor",
      initial_protocol: "positive_saturation",
      revision: 23,
      saturation: { mode: "auto" },
      stage_id: "hysteresis-1",
      stage_index: 0,
      storage: { magnetization: "selected" },
    };
    const settlePipeline: HysteresisSettlePipelineSchema = {
      revision: 23,
      settle_pipeline: {
        kind: "sequence",
        steps: [
          {
            alpha: 0.9,
            kind: "minimize",
            max_steps: 2000,
            method: "projected_gradient_bb",
            torque_tolerance: 250,
          },
        ],
      },
      stage_id: "hysteresis-1",
      stage_index: 0,
    };
    sharedResourceRuntimeStore.updateData(protocolKey, protocol, 23);
    sharedResourceRuntimeStore.updateData(settlePipelineKey, settlePipeline, 23);

    const protocolMarkup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="protocol" />,
      ["hysteresis-protocol"],
    );
    const settleMarkup = render(
      <HysteresisStageInspector {...props("hysteresis")} />,
      ["hysteresis-settle"],
    );

    expect(protocolMarkup).toContain("positive_saturation");
    expect(protocolMarkup).toContain("major_with_minor");
    expect(protocolMarkup).toContain("selected");
    expect(settleMarkup).toContain("projected_gradient_bb");
    expect(settleMarkup).toContain("Max steps: 2000");
  });
});
