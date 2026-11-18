import { describe, expect, it } from "vitest";

import type { RunPerformanceResource } from "@/kernel/api/apiTypes";

import { buildFooterTelemetryModel, type FooterTelemetryStatus } from "./FooterTelemetry";

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

function metrics(sample: RunPerformanceResource | null, observation: {
  performanceStatus?: "ready" | "stale" | "error";
  performanceRefreshFailed?: boolean;
} = {}) {
  return buildFooterTelemetryModel(
    status, null, null, null, null, null, null, null, { performance: sample, ...observation },
  ).metrics;
}

describe("FooterTelemetry performance progress", () => {
  it("shows current-run solver progress separately from the older scalar sample", () => {
    const result = metrics(performance);
    expect(result.find((metric) => metric.id === "solver-progress")).toMatchObject({
      label: "Solver step", value: "9,423", unit: "steps",
    });
    expect(result.find((metric) => metric.id === "step")).toMatchObject({
      label: "Sample step", value: "0",
    });
    const before = metrics(null).filter((metric) => metric.id !== "step");
    const after = result.filter((metric) => metric.id !== "step" && metric.id !== "solver-progress");
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

  it("identifies the recorded stage without claiming it is the active stage", () => {
    const metric = metrics({ ...performance, step_id: "previous-stage" })
      .find((item) => item.id === "solver-progress");
    expect(metric?.subdetail).toContain("Stage previous-stage");
    expect(metric?.detail).not.toContain("current runner stage");
  });

  it("retains the existing Step card when no independent performance sample is available", () => {
    expect(metrics(null).find((metric) => metric.id === "step")).toMatchObject({
      label: "Step", value: "0",
    });
  });
});
