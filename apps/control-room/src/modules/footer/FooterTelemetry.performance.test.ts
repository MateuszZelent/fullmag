import { describe, expect, it } from "vitest";

import type { RunPerformanceResource, ScalarWindowResource } from "@/kernel/api/apiTypes";

import { buildFooterTelemetryModel } from "./FooterTelemetry.presentation";
import { resolveFooterMeanTimestep, type FooterTelemetryStatus } from "./FooterTelemetry.model";
import type { FooterLiveScalarSample } from "./FooterTelemetry.presentation";
import {
  resolveFooterPerformanceClock,
  resolveFooterPerformanceProgressFraction,
  resolveFooterPerformanceRate,
  resolveFooterPerformanceStep,
  type FooterPerformanceStageReference,
} from "./footerPerformanceProgress";

const status: FooterTelemetryStatus = {
  energies: null,
  metrics: { steps_per_second: null, total_steps: 0 },
  run: {
    calibration_id: null, requested_device: "gpu", resolved_device: "gpu",
    run_id: "current-run", selection_confidence: null,
    selection_reason: "explicit_device_request", solver_steps: 0, solver_time: 0,
  },
  sessionId: "current-session", sessionEpoch: "current-session@1",
  requestScopeEpoch: "api:1", scalarsRevision: 1,
  solver: { converged: null, dt: null, max_torque_T: null, state: "running" },
};

const performance: RunPerformanceResource = {
  state: "running", run_id: "current-run", task_id: "task-1", step_id: "relax",
  attempt_id: "attempt-1", ownership_epoch: 1,
  elapsed_monotonic_ns: 120_000_000_000, first_step_index: 0, step_index: 9423,
  sample_sequence: 10000, unique_step_callback_records: 9424,
  gpu_scope: "whole_device", points: [], rows_dropped: 0, revision: "performance-1",
};

function scalarWindow(rows: number[][], series = {
  run_id: "current-run", task_id: "task-1", step_id: "relax",
  case_id: "case-1", attempt_id: "attempt-1", ownership_epoch: 1,
}): ScalarWindowResource {
  return {
    columns: ["step", "time", "pseudo_time_s"],
    current_observation: null,
    observation_frames: rows.map(([step, time]) => ({
      observation_frame_id: `frame-${step}`,
      session_epoch: "current-session@1",
      domain_generation_id: "mesh-1",
      topology_revision: "1",
      source_step: step!,
      source_time_seconds: time!,
    })),
    returned_rows: rows.length,
    revision: rows.length,
    rows,
    series,
    total_rows: rows.length,
  };
}

function metrics(sample: RunPerformanceResource | null, observation: {
  performanceStatus?: "ready" | "stale" | "error";
  performanceRefreshFailed?: boolean;
} = {}, scalarHistory: ScalarWindowResource | null = null,
stageReference: FooterPerformanceStageReference | null = null,
liveSample: FooterLiveScalarSample | null = null) {
  return buildFooterTelemetryModel(
    status, null, null, liveSample, null, null, null, null,
    { performance: sample, scalarHistory, stageReference, ...observation },
  ).metrics;
}

describe("FooterTelemetry performance progress", () => {
  it("computes a measured mean dt across the latest samples from one attempt", () => {
    const result = resolveFooterMeanTimestep(status, scalarWindow([
      [7_194, 7.488e-9, 0],
      [8_074, 8.368e-9, 0],
    ]));

    expect(result).toMatchObject({
      attemptId: "attempt-1",
      firstStep: 7_194,
      lastStep: 8_074,
      stepCount: 880,
    });
    expect(result?.secondsPerStep).toBeCloseTo(1e-12, 22);
  });

  it("rejects a run mismatch, malformed sample identity, or a non-increasing clock", () => {
    const samples = scalarWindow([
      [7_194, 7.488e-9, 0],
      [8_074, 8.368e-9, 0],
    ]);
    expect(resolveFooterMeanTimestep(status, scalarWindow(samples.rows, {
      ...samples.series!, run_id: "previous-run",
    }))).toBeNull();
    expect(resolveFooterMeanTimestep(status, {
      ...samples,
      observation_frames: samples.observation_frames.map((frame, index) =>
        index === 1 ? { ...frame, source_step: frame.source_step - 1 } : frame,
      ),
    })).toBeNull();
    expect(resolveFooterMeanTimestep(status, scalarWindow([
      [7_194, 7.488e-9, 0],
      [8_074, 7.488e-9, 0],
    ]))).toBeNull();
  });

  it("labels a scalar-window span as mean dt and names its sample range", () => {
    const metric = metrics(null, {}, scalarWindow([
      [7_194, 7.488e-9, 0],
      [8_074, 8.368e-9, 0],
    ])).find((item) => item.id === "dt");

    expect(metric).toMatchObject({
      label: "Mean dt",
      unit: "s",
      value: "1.000000e-12",
    });
    expect(metric?.detail).toContain("Mean physical timestep");
    expect(metric?.subdetail).toContain("Steps 7,194–8,074");
    expect(metric?.subdetail).toContain("Attempt attempt-1");
  });

  it("computes rate only from a complete matching attempt and measured monotonic span", () => {
    const rate = resolveFooterPerformanceRate("current-run", performance);
    expect(rate).toMatchObject({
      attemptId: "attempt-1",
      elapsedSeconds: 120,
      firstStep: 0,
      lastStep: 9_423,
      stepCount: 9_423,
    });
    expect(rate?.stepsPerSecond).toBeCloseTo(78.525, 8);
    expect(resolveFooterPerformanceRate("current-run", performance, scalarWindow([
      [1, 1e-12, 0],
      [2, 2e-12, 0],
    ]).series)).toEqual(rate);
    expect(resolveFooterPerformanceRate("current-run", performance, {
      ...scalarWindow([[1, 1e-12, 0], [2, 2e-12, 0]]).series!,
      attempt_id: "another-attempt",
    })).toBeNull();
    expect(resolveFooterPerformanceRate("current-run", {
      ...performance,
      attempt_id: null,
    })).toBeNull();
    expect(resolveFooterPerformanceRate("current-run", {
      ...performance,
      elapsed_monotonic_ns: 0,
    })).toBeNull();
    const stageRateSample = { ...performance, stage_index: 1 } as RunPerformanceResource;
    expect(resolveFooterPerformanceRate("current-run", stageRateSample, null, {
      stageIndex: 1,
      stageId: "relax",
    })).toMatchObject({ attemptId: "attempt-1", stepCount: 9_423 });
    expect(resolveFooterPerformanceRate("current-run", stageRateSample, null, {
      stageIndex: 2,
      stageId: "another-stage",
    })).toBeNull();
  });

  it("uses a coherent current-stage solver clock and accepted stage progress", () => {
    const sample = {
      ...performance,
      stage_index: 1,
      solver_clock: { step_index: 9_423, time_s: 7.488e-9, dt_s: 0 },
      progress_fraction: 0.3744,
    } as RunPerformanceResource;

    expect(resolveFooterPerformanceClock("current-run", sample, {
      stageIndex: 1,
      stageId: "relax",
    }, scalarWindow([[9_423, 7.488e-9, 0]]).series)).toMatchObject({
      attemptId: "attempt-1",
      stepIndex: 9_423,
      timeSeconds: 7.488e-9,
      dtSeconds: 0,
    });
    expect(resolveFooterPerformanceProgressFraction("current-run", sample, {
      stageIndex: 1,
      stageId: "relax",
    }, scalarWindow([[9_423, 7.488e-9, 0]]).series)).toBe(0.3744);
    expect(resolveFooterPerformanceClock("current-run", sample, {
      stageIndex: 2,
      stageId: "another-stage",
    })).toBeNull();
    expect(resolveFooterPerformanceProgressFraction("current-run", sample, {
      stageIndex: 2,
      stageId: "another-stage",
    })).toBeNull();
  });

  it("preserves an explicit zero dt from the matched solver callback row", () => {
    const sample = {
      ...performance,
      stage_index: 1,
      solver_clock: { step_index: 9_423, time_s: 7.488e-9, dt_s: 0 },
    } as RunPerformanceResource;
    const result = metrics(sample, {}, scalarWindow([
      [7_194, 7.488e-9, 0],
      [8_074, 8.368e-9, 0],
    ]), { stageIndex: 1, stageId: "relax" });

    expect(result.find((metric) => metric.id === "dt")).toMatchObject({
      label: "dt",
      value: "0.000000e+0",
    });
    expect(result.find((metric) => metric.id === "dt")?.subdetail)
      .toContain("Solver step 9,423 · Attempt attempt-1");
  });

  it("rejects a clock whose step is not the performance identity's exact row", () => {
    const sample = {
      ...performance,
      stage_index: 1,
      solver_clock: { step_index: 9_422, time_s: 7.488e-9, dt_s: 1e-12 },
      progress_fraction: 1.2,
    } as RunPerformanceResource;
    expect(resolveFooterPerformanceClock("current-run", sample, {
      stageIndex: 1,
      stageId: "relax",
    })).toBeNull();
    expect(resolveFooterPerformanceProgressFraction("current-run", sample, {
      stageIndex: 1,
      stageId: "relax",
    })).toBeNull();
  });

  it("rejects same-run, same-stage telemetry from a superseded attempt when scalar identity is current", () => {
    const stale = {
      ...performance,
      stage_index: 1,
      solver_clock: { step_index: 9_423, time_s: 7.488e-9, dt_s: 0 },
      progress_fraction: 0.3744,
    } as RunPerformanceResource;
    const activeSeries = {
      run_id: "current-run",
      task_id: "task-1",
      step_id: "relax",
      case_id: "case-1",
      attempt_id: "attempt-2",
      ownership_epoch: 1,
    };
    const stage = { stageIndex: 1, stageId: "relax" };

    expect(resolveFooterPerformanceStep("current-run", stale, stage, activeSeries)).toBeNull();
    expect(resolveFooterPerformanceClock("current-run", stale, stage, activeSeries)).toBeNull();
    expect(resolveFooterPerformanceProgressFraction("current-run", stale, stage, activeSeries)).toBeNull();
  });

  it("shows current-run solver progress separately from the older scalar sample", () => {
    const result = metrics(performance, {}, null, { stageId: "relax" });
    expect(result.find((metric) => metric.id === "solver-progress")).toMatchObject({
      label: "Solver step", value: "9,423", unit: "steps",
    });
    expect(result.find((metric) => metric.id === "step")).toMatchObject({
      label: "Step", value: "0",
    });
    expect(result.find((metric) => metric.id === "stage-rate")).toMatchObject({
      label: "Stage rate",
      unit: "steps/s",
      value: "78.5",
    });
    const before = metrics(null).filter((metric) => !["step", "stage-rate"].includes(metric.id));
    const after = result.filter((metric) => !["step", "solver-progress", "stage-rate"].includes(metric.id));
    expect(after).toEqual(before);
  });

  it("rejects a previous run and a missing run identity", () => {
    for (const run_id of ["previous-run", null]) {
      expect(metrics({ ...performance, run_id }).some((metric) => metric.id === "solver-progress"))
        .toBe(false);
    }
  });

  it("rejects unavailable or invalid performance steps", () => {
    for (const sample of [
      { ...performance, state: "unavailable" },
      ...[null, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]
        .map((step_index) => ({ ...performance, step_index })),
    ]) {
      expect(metrics(sample).some((metric) => metric.id === "solver-progress")).toBe(false);
    }
  });

  it("keeps the last verified progress explicit after a refresh failure", () => {
    const failed = metrics(performance, {
      performanceStatus: "error", performanceRefreshFailed: true,
    }).find((metric) => metric.id === "solver-progress");
    expect(failed).toMatchObject({ value: "9,423" });
    expect(failed?.subdetail).toContain("refresh unavailable");
    const pending = metrics(performance, { performanceStatus: "stale" })
      .find((metric) => metric.id === "solver-progress");
    expect(pending?.subdetail).toContain("last observed; updating");
  });

  it("keeps the solver attempt label and avoids leaking an opaque stage hash", () => {
    const metric = metrics({ ...performance, step_id: "previous-stage" })
      .find((item) => item.id === "solver-progress");
    expect(metric?.subdetail).toContain("Attempt attempt-1");
    expect(metric?.subdetail).not.toContain("previous-stage");
    expect(metric?.detail).not.toContain("current runner stage");
  });

  it("keeps solver and scalar sample clocks separate when their steps differ", () => {
    const sample = {
      ...performance,
      stage_index: 1,
      solver_clock: { step_index: 9_423, time_s: 7.488e-9, dt_s: 1e-12 },
    } as RunPerformanceResource;
    const event: FooterLiveScalarSample = {
      revision: 22,
      row: { step: 13_308, time: 8.001e-9 },
      requestScopeEpoch: "api:1",
      runId: "current-run",
      sessionId: "current-session",
      step: 13_308,
      time: 8.001e-9,
    };
    const result = metrics(sample, {}, null, {
      stageIndex: 1,
      stageId: "relax",
    }, event);
    expect(result.find((metric) => metric.id === "time")).toMatchObject({
      value: "7.488000e-9",
      subdetail: "Solver update · step 9,423 · Attempt attempt-1",
    });
    expect(result.find((metric) => metric.id === "solver-progress")?.value).toBe("9,423");
    expect(result.find((metric) => metric.id === "step")).toMatchObject({
      label: "Sample step",
      value: "13,308",
    });
    expect(result.find((metric) => metric.id === "step")?.subdetail)
      .toContain("t=8.001000e-9 s");
    expect(result.find((metric) => metric.id === "dt")?.value).toBe("1.000000e-12");
  });

  it("uses an accepted same-attempt mean when the legacy scalar dt is an unpublished zero", () => {
    const sample = {
      ...performance,
      stage_index: 1,
    } as RunPerformanceResource;
    const result = metrics(sample, {}, scalarWindow([
      [7_194, 7.488e-9, 0],
      [8_074, 8.368e-9, 0],
    ]), { stageIndex: 1, stageId: "relax" }, {
      revision: 2,
      row: { step: 9_423, time: 7.488e-9, dt: 0 },
      requestScopeEpoch: "api:1",
      runId: "current-run",
      sessionId: "current-session",
      step: 9_423,
      time: 7.488e-9,
    });
    expect(result.find((metric) => metric.id === "time")?.value).toBe("7.488000e-9");
    expect(result.find((metric) => metric.id === "dt")).toMatchObject({
      label: "Mean dt",
      value: "1.000000e-12",
    });
    expect(result.find((metric) => metric.id === "dt")?.subdetail)
      .toContain("Attempt attempt-1");
  });

  it("retains the existing Step card when no independent performance sample is available", () => {
    expect(metrics(null).find((metric) => metric.id === "step")).toMatchObject({
      label: "Step", value: "0",
    });
  });
});
