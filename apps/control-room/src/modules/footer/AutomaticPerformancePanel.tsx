"use client";

import { Activity } from "lucide-react";
import { useMemo, useState } from "react";

import { DIAGNOSTICS_RUN_PERFORMANCE_PATH } from "@/kernel/api/apiPaths";
import {
  isRunPerformanceObservationBusyError,
  useRunPerformanceResource,
} from "@/kernel/resources/studyRuntimeResources";
import { InteractiveChartSurface } from "@/shared/analysis-charts/InteractiveChartSurface";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";

import {
  AUTOMATIC_PERFORMANCE_CHART_SAMPLE_LIMIT,
  AUTOMATIC_PERFORMANCE_METRICS,
  buildAutomaticPerformanceChartSeries,
  buildAutomaticPerformancePanelModel,
  type AutomaticPerformanceMetricId,
} from "./automaticPerformanceModel";

export function AutomaticPerformancePanel() {
  const resource = useRunPerformanceResource();
  const [metricId, setMetricId] = useState<AutomaticPerformanceMetricId>("cpu_percent");
  const model = useMemo(
    () => buildAutomaticPerformancePanelModel(resource.data),
    [resource.data],
  );
  const metric = AUTOMATIC_PERFORMANCE_METRICS.find(({ id }) => id === metricId)!;
  const series = useMemo(
    () => buildAutomaticPerformanceChartSeries(resource.data, metricId),
    [metricId, resource.data],
  );
  const surface = useMemo(() => ({
    ariaLabel: `Automatic performance history: ${metric.label}`,
    chartId: `automatic-performance:${resource.data?.run_id ?? "unverified"}:${metricId}`,
    presentationCopy: {
      empty: `No ${metric.label.toLowerCase()} samples`,
      error: `${metric.label} history unavailable`,
      hidden: "No performance series is visible",
      loading: `Loading ${metric.label.toLowerCase()} history`,
    },
    provenance: {
      dataRevision: resource.data?.revision ?? null,
      decimation: `bounded source history (up to ${AUTOMATIC_PERFORMANCE_CHART_SAMPLE_LIMIT} samples)`,
      descriptorId: `diagnostics:run-performance:${metricId}`,
      query: metric.label,
      resourceKey: DIAGNOSTICS_RUN_PERFORMANCE_PATH,
      runId: resource.data?.run_id ?? null,
    },
  }), [metric.label, metricId, resource.data?.revision, resource.data?.run_id]);

  const summaryMetrics = [
    { label: "Elapsed", value: model.elapsed },
    { label: "Stage rate", value: model.stageRate },
    { label: "CPU/core", value: model.cpu },
    { label: "GPU/device", value: model.gpu },
  ];
  const detailMetrics = [
    { label: "Wall / step", value: model.latestStepWall },
    { label: "Line search wall", value: model.latestEvaluateWall },
    { label: "Process RSS", value: model.residentMemory },
    { label: "GPU memory", value: model.gpuMemory },
    { label: "GPU power", value: model.gpuPower },
    { label: "Rejected", value: model.latestRejectedAttempts },
    { label: "Step records", value: model.stepCallbacks },
    { label: "Resource samples", value: model.observedRows },
    { label: "Dropped rows", value: model.droppedRows },
    { label: "Overhead", value: model.collectionOverhead },
    { label: "Sequence", value: model.sampleSequence },
  ];
  const observationBusy = isRunPerformanceObservationBusyError(
    resource.error ?? resource.refreshError,
  );
  const chartResourceStatus = observationBusy
    ? resource.data ? "stale" : "loading"
    : resource.status;
  const refreshStatus = observationBusy
    ? resource.data
      ? "Updating; keeping the last verified performance snapshot visible."
      : "Updating; waiting for the first verified performance snapshot."
    : refreshNotice(
        resource.status,
        resource.error,
        resource.refreshError,
        resource.data !== null,
      );

  return (
    <section
      aria-label="Automatic performance"
      className="fm-footer-diagnostics__panel fm-auto-performance"
    >
      <div className="fm-footer-diagnostics__heading">
        <Activity size={14} aria-hidden="true" />
        <span>Automatic performance</span>
        <span className="fm-footer-diagnostics__meta">
          {resourceStatusLabel(resource.status, resource.data?.state, observationBusy)}
        </span>
      </div>
      <div className="fm-auto-performance__body">
        <div className="fm-auto-performance__identity" title={model.identity}>
          <span>{model.identity}</span>
        </div>
        <dl className="fm-auto-performance__summary" aria-label="Run stage summary">
          {summaryMetrics.map(({ label, value }) => (
            <div className="fm-auto-performance__stat" key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <dl className="fm-auto-performance__details" aria-label="Collected performance statistics">
          {detailMetrics.map(({ label, value }) => (
            <div className="fm-auto-performance__detail" key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="fm-auto-performance__chart-header">
          <span id="automatic-performance-metric-label">Recent history</span>
          <Select
            value={metricId}
            onValueChange={(value) => setMetricId(value as AutomaticPerformanceMetricId)}
          >
            <SelectTrigger
              aria-labelledby="automatic-performance-metric-label"
              className="fm-auto-performance__metric-select"
              density="compact"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUTOMATIC_PERFORMANCE_METRICS.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label} ({option.unit})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="fm-auto-performance__metric-description">
          {metric.description} X axis: elapsed runner-stage time in seconds. Chart shows the
          most recent {AUTOMATIC_PERFORMANCE_CHART_SAMPLE_LIMIT} samples at most.
        </p>
        {resource.data?.reason ? (
          <p className="fm-auto-performance__notice" role="status">
            {resource.data.reason}
          </p>
        ) : null}
        {resource.data?.gpu_unavailable_reason ? (
          <p className="fm-auto-performance__notice" role="status">
            GPU telemetry: {resource.data.gpu_unavailable_reason}
          </p>
        ) : null}
        {refreshStatus ? (
          <p className="fm-auto-performance__notice" role="status">
            {refreshStatus}
          </p>
        ) : null}
        {series.length > 0 ? (
          <div className="fm-auto-performance__chart">
            <InteractiveChartSurface
              allSeries={series}
              dataStatus={chartResourceStatus}
              series={series}
              surface={surface}
              ownerStatus={resource.data?.state}
              xAxisLabel="Elapsed stage time"
            />
          </div>
        ) : (
          <div className="fm-auto-performance__empty" role="status" aria-live="polite">
            {emptyHistoryMessage({
              metric: metric.label,
              resourceError: observationBusy ? undefined : resource.error?.message,
              resourceStatus: chartResourceStatus,
              state: resource.data?.state,
              reason: resource.data?.reason,
              gpuReason: resource.data?.gpu_unavailable_reason,
              sampleCount: model.sampleCount,
            })}
          </div>
        )}
        <div className="fm-auto-performance__scope-note">
          Stage rate uses the verified step-index span over runner-stage elapsed time. The
          interval includes stage initialization and finalization, but excludes admission
          and meshing preparation. Wall / step averages the observed callback interval over its
          step-index gap; batched steps share an average. Phase times can overlap.
        </div>
        <div className="fm-auto-performance__scope-note">
          GPU scope: {model.gpuScope}. Whole-device utilization is not kernel occupancy.
        </div>
      </div>
    </section>
  );
}

function emptyHistoryMessage({
  gpuReason,
  metric,
  reason,
  resourceError,
  resourceStatus,
  sampleCount,
  state,
}: {
  gpuReason: string | null | undefined;
  metric: string;
  reason: string | null | undefined;
  resourceError: string | undefined;
  resourceStatus: string;
  sampleCount: number;
  state: string | undefined;
}): string {
  if (resourceStatus === "loading") return "Loading automatic performance samples.";
  if (resourceStatus === "error") {
    return `Automatic performance is unavailable${resourceError ? `: ${resourceError}` : "."}`;
  }
  if (state === "unavailable") {
    return reason ?? "Automatic samples are unavailable because no verified run attempt was published.";
  }
  if (sampleCount === 0) return reason ?? "No automatic performance samples have been published for this stage.";
  if (metric.toLowerCase().startsWith("gpu") && gpuReason) return gpuReason;
  return `No ${metric.toLowerCase()} samples are available in the recent history.`;
}

function resourceStatusLabel(
  resourceStatus: string,
  runState: string | undefined,
  observationBusy: boolean,
): string {
  if (observationBusy) return "Updating";
  if (resourceStatus === "error") return "Error";
  if (resourceStatus === "stale") return "Updating";
  if (resourceStatus === "loading") return "Loading";
  if (resourceStatus === "idle") return "Idle";
  if (!runState) return "Pending";
  return runState.replaceAll("_", " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

function refreshNotice(
  resourceStatus: string,
  error: Error | null,
  refreshError: Error | null | undefined,
  hasCachedData: boolean,
): string | null {
  if (!hasCachedData) return null;
  const failure = refreshError ?? error;
  if (resourceStatus === "stale") {
    return failure
      ? `Updating with the last sample; a previous refresh failed: ${failure.message}`
      : "Updating; showing the last published sample.";
  }
  if (resourceStatus === "error") {
    return `Refresh failed; showing the last published sample${failure ? `: ${failure.message}` : "."}`;
  }
  return null;
}
