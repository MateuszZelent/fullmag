import type { RunPerformanceResource } from "@/kernel/api/apiTypes";
import { DIAGNOSTICS_RUN_PERFORMANCE_PATH } from "@/kernel/api/apiPaths";
import type { ChartPoint, ChartSeries } from "@/shared/domain/analysis/chartSeries";

export const AUTOMATIC_PERFORMANCE_CHART_SAMPLE_LIMIT = 120;

export type AutomaticPerformanceMetricId =
  | "cpu_percent"
  | "rss_bytes"
  | "gpu_percent"
  | "gpu_memory_bytes"
  | "gpu_power_watts";

type PerformancePoint = RunPerformanceResource["points"][number];

export interface AutomaticPerformanceMetric {
  description: string;
  id: AutomaticPerformanceMetricId;
  label: string;
  unit: string;
}

export const AUTOMATIC_PERFORMANCE_METRICS: readonly AutomaticPerformanceMetric[] = [
  {
    description: "CPU use is expressed per core and can exceed 100%.",
    id: "cpu_percent",
    label: "CPU per core",
    unit: "%",
  },
  {
    description: "Resident memory of the Fullmag process.",
    id: "rss_bytes",
    label: "Process memory",
    unit: "MiB",
  },
  {
    description: "Whole-device utilization; this is not kernel occupancy.",
    id: "gpu_percent",
    label: "GPU whole device",
    unit: "%",
  },
  {
    description: "Memory used on the whole device.",
    id: "gpu_memory_bytes",
    label: "GPU memory",
    unit: "MiB",
  },
  {
    description: "Power reported for the whole device.",
    id: "gpu_power_watts",
    label: "GPU power",
    unit: "W",
  },
];

export interface AutomaticPerformancePanelModel {
  collectionOverhead: string;
  cpu: string;
  droppedRows: string;
  elapsed: string;
  stageRate: string;
  gpu: string;
  gpuMemory: string;
  gpuPower: string;
  gpuScope: string;
  gpuUnavailableReason: string | null;
  identity: string;
  latestEvaluateWall: string;
  latestRejectedAttempts: string;
  latestStepWall: string;
  observedRows: string;
  reason: string | null;
  residentMemory: string;
  sampleCount: number;
  sampleSequence: string;
  stepCallbacks: string;
}

export function buildAutomaticPerformancePanelModel(
  resource: RunPerformanceResource | null,
): AutomaticPerformancePanelModel {
  if (!resource) {
    return {
      collectionOverhead: "N/A",
      cpu: "N/A",
      droppedRows: "N/A",
      elapsed: "N/A",
      stageRate: "N/A",
      gpu: "N/A",
      gpuMemory: "N/A",
      gpuPower: "N/A",
      gpuScope: "whole_device",
      gpuUnavailableReason: null,
      identity: "Run N/A · Task N/A · Step N/A · Attempt N/A · Epoch N/A",
      latestEvaluateWall: "N/A",
      latestRejectedAttempts: "N/A",
      latestStepWall: "N/A",
      observedRows: "N/A",
      reason: null,
      residentMemory: "N/A",
      sampleCount: 0,
      sampleSequence: "N/A",
      stepCallbacks: "N/A",
    };
  }
  const latestPoint = resource.points.at(-1);
  const stepRate = exactRunStepRate(resource);
  const hasVerifiedSnapshot = resource.state !== "unavailable";

  return {
    collectionOverhead: hasVerifiedSnapshot
      ? formatNanoseconds(resource.collection_overhead_ns)
      : "N/A",
    cpu: formatPercent(readPointValue(latestPoint, "cpu_percent")),
    droppedRows: hasVerifiedSnapshot ? formatCount(resource.rows_dropped) : "N/A",
    elapsed: hasVerifiedSnapshot
      ? formatNanoseconds(resource.elapsed_monotonic_ns)
      : "N/A",
    stageRate: stepRate === null ? "N/A" : `${formatDecimal(stepRate)} steps/s`,
    gpu: formatPercent(readPointValue(latestPoint, "gpu_percent")),
    gpuMemory: formatBytes(readPointValue(latestPoint, "gpu_memory_bytes")),
    gpuPower: formatWatts(readPointValue(latestPoint, "gpu_power_watts")),
    gpuScope: resource.gpu_scope,
    gpuUnavailableReason: nonEmptyText(resource.gpu_unavailable_reason),
    identity: formatRunIdentity(resource),
    latestEvaluateWall: formatNanoseconds(resource.latest_evaluate_host_wall_ns),
    latestRejectedAttempts: formatCount(resource.latest_rejected_attempts),
    latestStepWall: formatNanoseconds(resource.latest_step_wall_ns),
    observedRows: hasVerifiedSnapshot ? formatCount(resource.points.length) : "N/A",
    reason: nonEmptyText(resource.reason),
    residentMemory: formatBytes(readPointValue(latestPoint, "rss_bytes")),
    sampleCount: resource.points.length,
    sampleSequence: hasVerifiedSnapshot ? formatCount(resource.sample_sequence) : "N/A",
    stepCallbacks: hasVerifiedSnapshot
      ? formatCount(resource.unique_step_callback_records)
      : "N/A",
  };
}

export function buildAutomaticPerformanceChartSeries(
  resource: RunPerformanceResource | null,
  metricId: AutomaticPerformanceMetricId,
): ChartSeries[] {
  if (!resource) return [];
  const metric = AUTOMATIC_PERFORMANCE_METRICS.find(({ id }) => id === metricId);
  if (!metric) return [];

  const boundedPoints = resource.points.slice(-AUTOMATIC_PERFORMANCE_CHART_SAMPLE_LIMIT);
  const points: ChartPoint[] = [];
  let gapBeforeNextValue = false;
  boundedPoints.forEach((sample, rowIndex) => {
    const x = finiteNumber(sample.elapsed_monotonic_ns);
    const rawValue = readPointValue(sample, metricId);
    if (x === null || x < 0 || rawValue === null) {
      gapBeforeNextValue = points.length > 0;
      return;
    }

    points.push({
      ...(gapBeforeNextValue ? { breakBefore: true } : {}),
      label: sample.step_index == null ? undefined : `Step ${sample.step_index}`,
      rowIndex,
      x: x / 1_000_000_000,
      y: chartValue(rawValue, metricId),
    });
    gapBeforeNextValue = false;
  });

  if (points.length === 0) return [];
  const quantity = chartQuantity(metricId);

  return [{
    dataRevision: resource.revision,
    id: `diagnostics.run-performance:${metricId}`,
    label: quantity,
    points,
    quantity,
    selectable: false,
    source: {
      kind: "diagnostics.run_performance",
      resourceKey: DIAGNOSTICS_RUN_PERFORMANCE_PATH,
      tableId: "automatic-performance",
    },
    status: "ready",
    unit: metric.unit,
    xUnit: "s",
  }];
}

export function formatNanoseconds(value: number | null | undefined): string {
  const ns = finiteNumber(value);
  if (ns === null || ns < 0) return "N/A";
  if (ns >= 1_000_000_000) return `${formatDecimal(ns / 1_000_000_000)} s`;
  if (ns >= 1_000_000) return `${formatDecimal(ns / 1_000_000)} ms`;
  return `${Math.round(ns).toLocaleString()} ns`;
}

function exactRunStepRate(resource: RunPerformanceResource): number | null {
  const identityIsComplete =
    hasText(resource.run_id) &&
    hasText(resource.task_id) &&
    hasText(resource.step_id) &&
    hasText(resource.attempt_id) &&
    resource.ownership_epoch !== null &&
    resource.ownership_epoch !== undefined;
  if (!identityIsComplete) return null;

  const firstStep = safeInteger(resource.first_step_index);
  const latestStep = safeInteger(resource.step_index);
  const elapsedNs = safeInteger(resource.elapsed_monotonic_ns);
  if (firstStep === null || latestStep === null || elapsedNs === null || elapsedNs <= 0) {
    return null;
  }

  const stepDelta = latestStep - firstStep;
  return stepDelta < 0 ? null : stepDelta / (elapsedNs / 1_000_000_000);
}

function formatRunIdentity(resource: RunPerformanceResource): string {
  const epoch = resource.ownership_epoch;
  return [
    `Run ${resource.run_id ?? "N/A"}`,
    `Task ${resource.task_id ?? "N/A"}`,
    `Step ${resource.step_id ?? "N/A"}`,
    `Attempt ${resource.attempt_id ?? "N/A"}`,
    `Epoch ${epoch == null ? "N/A" : String(epoch)}`,
  ].join(" · ");
}

function readPointValue(
  point: PerformancePoint | undefined,
  key: AutomaticPerformanceMetricId,
): number | null {
  if (!point) return null;
  return finiteNumber(point[key]);
}

function chartValue(value: number, metricId: AutomaticPerformanceMetricId): number {
  return metricId === "rss_bytes" || metricId === "gpu_memory_bytes"
    ? value / (1024 * 1024)
    : value;
}

function chartQuantity(metricId: AutomaticPerformanceMetricId): string {
  return AUTOMATIC_PERFORMANCE_METRICS.find(({ id }) => id === metricId)?.label ?? metricId;
}

function formatPercent(value: number | null): string {
  return value === null ? "N/A" : `${formatDecimal(value)}%`;
}

function formatBytes(value: number | null): string {
  if (value === null || value < 0) return "N/A";
  const mebibytes = value / (1024 * 1024);
  return mebibytes >= 1024
    ? `${formatDecimal(mebibytes / 1024)} GiB`
    : `${formatDecimal(mebibytes)} MiB`;
}

function formatWatts(value: number | null): string {
  return value === null || value < 0 ? "N/A" : `${formatDecimal(value)} W`;
}

function formatCount(value: number | null | undefined): string {
  const count = finiteNumber(value);
  return count === null || count < 0 ? "N/A" : Math.round(count).toLocaleString();
}

function formatDecimal(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function hasText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function nonEmptyText(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
