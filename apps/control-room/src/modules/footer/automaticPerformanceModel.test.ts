import { describe, expect, it } from "vitest";

import type { RunPerformanceResource } from "@/kernel/api/apiTypes";

import {
  AUTOMATIC_PERFORMANCE_CHART_SAMPLE_LIMIT,
  buildAutomaticPerformanceChartSeries,
  buildAutomaticPerformancePanelModel,
  formatNanoseconds,
} from "./automaticPerformanceModel";

const performanceResource: RunPerformanceResource = {
  attempt_id: "attempt-7",
  collection_overhead_ns: 125_000,
  elapsed_monotonic_ns: 4_000_000_000,
  first_step_index: 10,
  gpu_scope: "whole_device",
  gpu_unavailable_reason: null,
  latest_evaluate_host_wall_ns: 300_000,
  latest_rejected_attempts: 2,
  latest_step_wall_ns: 1_250_000,
  ownership_epoch: 3,
  points: [
    {
      cpu_percent: 175,
      elapsed_monotonic_ns: 1_000_000_000,
      gpu_memory_bytes: 2 * 1024 * 1024,
      gpu_percent: 61,
      gpu_power_watts: 72.5,
      rss_bytes: 512 * 1024 * 1024,
      step_index: 12,
    },
    {
      cpu_percent: null,
      elapsed_monotonic_ns: 2_000_000_000,
      gpu_memory_bytes: null,
      gpu_percent: null,
      gpu_power_watts: null,
      rss_bytes: null,
      step_index: 14,
    },
  ],
  reason: null,
  revision: "performance:8",
  rows_dropped: 4,
  run_id: "run-19",
  sample_sequence: 8,
  state: "running",
  step_id: "stage-2",
  step_index: 18,
  task_id: "task-19",
  unique_step_callback_records: 12,
};

describe("automatic performance panel model", () => {
  it("derives stage rate only from a complete attempt identity and measured stage wall time", () => {
    expect(buildAutomaticPerformancePanelModel(performanceResource).stageRate).toBe(
      "2 steps/s",
    );
    expect(
      buildAutomaticPerformancePanelModel({
        ...performanceResource,
        attempt_id: null,
      }).stageRate,
    ).toBe("N/A");
  });

  it("keeps missing telemetry as N/A and does not clamp per-core CPU above 100 percent", () => {
    const model = buildAutomaticPerformancePanelModel(performanceResource);

    expect(model.cpu).toBe("N/A");
    expect(model.gpu).toBe("N/A");
    expect(model.observedRows).toBe("2");
    expect(model.droppedRows).toBe("4");
    expect(model.latestRejectedAttempts).toBe("2");
    expect(model.latestStepWall).toBe("1.25 ms");

    const populatedModel = buildAutomaticPerformancePanelModel({
      ...performanceResource,
      points: [performanceResource.points[0]!],
    });
    expect(populatedModel.cpu).toBe("175%");
    expect(populatedModel.gpu).toBe("61%");

    const chart = buildAutomaticPerformanceChartSeries(
      performanceResource,
      "cpu_percent",
    );
    expect(chart[0]?.selectable).toBe(false);
    expect(chart[0]?.points).toEqual([
      { label: "Step 12", rowIndex: 0, x: 1, y: 175 },
    ]);

    const points = performanceResource.points;
    const gapped = buildAutomaticPerformanceChartSeries(
      {
        ...performanceResource,
        points: [
          points[0]!,
          points[1]!,
          { ...points[0]!, cpu_percent: 190, elapsed_monotonic_ns: 3_000_000_000 },
        ],
      },
      "cpu_percent",
    );
    expect(gapped[0]?.points[1]).toEqual({
      breakBefore: true,
      label: "Step 12",
      rowIndex: 2,
      x: 3,
      y: 190,
    });
  });

  it("keeps only the latest 120 chart samples and uses elapsed seconds on x", () => {
    const points = Array.from({ length: AUTOMATIC_PERFORMANCE_CHART_SAMPLE_LIMIT + 4 }, (_, index) => ({
      cpu_percent: index + 1,
      elapsed_monotonic_ns: (index + 1) * 1_000_000_000,
      gpu_memory_bytes: null,
      gpu_percent: null,
      gpu_power_watts: null,
      rss_bytes: null,
      step_index: index,
    }));
    const series = buildAutomaticPerformanceChartSeries(
      { ...performanceResource, points },
      "cpu_percent",
    );

    expect(series[0]?.points).toHaveLength(AUTOMATIC_PERFORMANCE_CHART_SAMPLE_LIMIT);
    expect(series[0]?.points[0]).toEqual({
      label: "Step 4",
      rowIndex: 0,
      x: 5,
      y: 5,
    });
    expect(series[0]?.points.at(-1)?.x).toBe(124);
  });

  it("does not present unavailable snapshot sentinel counters as measured zeroes", () => {
    const model = buildAutomaticPerformancePanelModel({
      ...performanceResource,
      attempt_id: null,
      elapsed_monotonic_ns: 0,
      points: [],
      rows_dropped: 0,
      sample_sequence: 0,
      state: "unavailable",
      task_id: null,
      step_id: null,
      unique_step_callback_records: 0,
    });

    expect(model.elapsed).toBe("N/A");
    expect(model.observedRows).toBe("N/A");
    expect(model.droppedRows).toBe("N/A");
    expect(model.sampleSequence).toBe("N/A");
    expect(model.stepCallbacks).toBe("N/A");
  });

  it("formats nanosecond counters with ns, ms, or s units", () => {
    expect(formatNanoseconds(120)).toBe("120 ns");
    expect(formatNanoseconds(1_000_000)).toBe("1 ms");
    expect(formatNanoseconds(2_000_000_000)).toBe("2 s");
    expect(formatNanoseconds(null)).toBe("N/A");
  });
});
