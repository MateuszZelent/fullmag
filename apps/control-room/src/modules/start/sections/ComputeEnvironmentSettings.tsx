"use client";

import { Activity, Cpu, HardDrive, RefreshCw } from "lucide-react";

import { Button } from "@/shared/ui/Button";

import type {
  ComputeEnvironment,
  ComputeProbeState,
  GpuInfo,
  SolverKind,
} from "../model/types";

const GIGABYTE = 1e9;

const numberFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

const LANE_ORDER: readonly { readonly backend: SolverKind; readonly device: "CPU" | "GPU" }[] = [
  { backend: "FDM", device: "CPU" },
  { backend: "FDM", device: "GPU" },
  { backend: "FEM", device: "CPU" },
  { backend: "FEM", device: "GPU" },
];

export interface ComputeEnvironmentSettingsProps {
  readonly compute: ComputeProbeState;
  readonly refreshing?: boolean;
  readonly stale?: boolean;
  readonly error?: string | null;
  readonly onRefresh?: () => void;
}

export function ComputeEnvironmentSettings({
  compute,
  refreshing = false,
  stale = false,
  error = null,
  onRefresh,
}: ComputeEnvironmentSettingsProps) {
  return (
    <section
      aria-labelledby="fm-start-compute-settings-title"
      className="fm-start-section fm-start-compute-settings"
      data-compute-settings=""
    >
      <div className="fm-start-compute-settings__head">
        <div>
          <h2 className="fm-start-section__title" id="fm-start-compute-settings-title">
            Compute environment
          </h2>
          <p className="fm-start-compute-settings__intro">
            Devices, memory, and available solver runtimes on the compute host.
          </p>
        </div>
        {onRefresh ? (
          <Button
            aria-label={refreshing ? "Refreshing compute environment" : "Refresh compute environment"}
            disabled={refreshing}
            onClick={onRefresh}
            size="sm"
            type="button"
            variant="secondary"
          >
            <RefreshCw aria-hidden="true" size={14} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        ) : null}
      </div>

      {compute === undefined ? (
        <p aria-live="polite" className="fm-start-compute-settings__notice">
          {error ? "The compute probe failed. Try refreshing the environment." : "Reading compute environment…"}
        </p>
      ) : compute === null ? (
        <p className="fm-start-compute-settings__notice" role={error ? "alert" : undefined}>
          {error ? "The compute probe could not return a reading. Try refreshing the environment." : "No compute probe is available on this host."}
        </p>
      ) : (
        <>
          {stale ? (
            <p className="fm-start-compute-settings__notice" role="status">
              Showing the last successful reading. Values may have changed since it was sampled.
            </p>
          ) : null}
          <ComputeDetails compute={compute} />
        </>
      )}

      {error ? (
        <p className="fm-start-compute-settings__error" role="alert">
          {error}
        </p>
      ) : null}

      <p className="fm-start-compute-settings__policy">
        Choose backend, device, and precision in each study&apos;s execution settings.
      </p>
    </section>
  );
}

function ComputeDetails({ compute }: { readonly compute: ComputeEnvironment }) {
  const threadsReported = Number.isFinite(compute.cpuThreads) && compute.cpuThreads > 0;
  const cpuStatus =
    threadsReported && compute.cpuProbeStatus === "unavailable"
      ? "Inventory available · load telemetry unavailable"
      : threadsReported
        ? "CPU telemetry available"
        : compute.cpuProbeStatus === "unavailable"
          ? "CPU telemetry unavailable"
          : "CPU thread count unavailable";

  return (
    <div className="fm-start-compute-settings__details">
      <section aria-labelledby="fm-start-compute-cpu-title" className="fm-start-compute-settings__panel">
        <div className="fm-start-compute-settings__panel-head">
          <Cpu aria-hidden="true" size={16} />
          <h3 id="fm-start-compute-cpu-title">CPU host</h3>
          <span
            className="fm-start-compute-settings__status"
            data-state={threadsReported ? "ready" : compute.cpuProbeStatus ?? "unknown"}
          >
            {cpuStatus}
          </span>
        </div>
        <dl className="fm-start-compute-settings__metrics">
          <Metric
            label="Reported host"
            value={compute.source === "runtime" ? "Runtime host" : compute.source === "desktop" ? "Desktop host" : "Not reported"}
          />
          <Metric label="Model" value={compute.cpuName ?? "Not reported"} />
          <Metric
            label="Threads"
            value={
              threadsReported ? `${compute.cpuThreads}` : "Not reported"
            }
          />
          <Metric
            label="Host CPU load"
            value={
              compute.cpuProbeStatus === "unavailable"
                ? "Telemetry unavailable"
                : isValidPercent(compute.cpuUtilizationPercent)
                  ? `${numberFormat.format(compute.cpuUtilizationPercent)}%`
                  : "Not reported"
            }
          />
          <MemoryMetric
            label="System RAM"
            totalBytes={compute.cpuProbeStatus === "unavailable" ? undefined : compute.memoryTotalBytes}
            usedBytes={compute.cpuProbeStatus === "unavailable" ? undefined : compute.memoryUsedBytes}
          />
        </dl>
        {compute.cpuProbeStatus !== "unavailable" && isValidPercent(compute.cpuUtilizationPercent) ? (
          <div className="fm-start-compute-settings__telemetry">
            <PercentMeter label="Host CPU load" value={compute.cpuUtilizationPercent} />
            <p>Overall host utilization; it is not attributed to a specific Fullmag run.</p>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="fm-start-compute-gpu-title" className="fm-start-compute-settings__panel">
        <div className="fm-start-compute-settings__panel-head">
          <Activity aria-hidden="true" size={16} />
          <h3 id="fm-start-compute-gpu-title">GPU devices</h3>
          <span
            className="fm-start-compute-settings__status"
            data-state={
              compute.gpuProbeStatus === "unavailable" ||
              (compute.gpuProbeStatus === undefined && compute.gpus.length === 0)
                ? "unknown"
                : compute.gpus.length > 0
                  ? "ready"
                  : "unknown"
            }
          >
            {compute.gpuProbeStatus === "unavailable" ||
            (compute.gpuProbeStatus === undefined && compute.gpus.length === 0)
              ? "Telemetry unavailable"
              : compute.gpus.length > 0
                ? `${compute.gpus.length} detected`
                : "No GPU detected"}
          </span>
        </div>
        {compute.gpuProbeStatus === "unavailable" ||
        (compute.gpuProbeStatus === undefined && compute.gpus.length === 0) ? (
          <p className="fm-start-compute-settings__notice">
            GPU telemetry is unavailable; the probe cannot determine whether a GPU is present.
          </p>
        ) : null}
        {compute.gpus.length > 0 ? (
          <div aria-label="GPU device readings" className="fm-start-compute-settings__gpu-list" role="list">
            {compute.gpus.map((gpu, index) => (
              <GpuCard gpu={gpu} key={`${gpu.index ?? "gpu"}-${index}`} position={index + 1} />
            ))}
          </div>
        ) : compute.gpuProbeStatus === "ready" ? (
          <p className="fm-start-compute-settings__notice">
            No GPU was reported by the probe. Runtime availability is listed below.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="fm-start-compute-lanes-title" className="fm-start-compute-settings__panel fm-start-compute-settings__panel--runtimes">
        <div className="fm-start-compute-settings__panel-head">
          <HardDrive aria-hidden="true" size={16} />
          <h3 id="fm-start-compute-lanes-title">Solver runtime lanes</h3>
        </div>
        <p className="fm-start-compute-settings__lane-note">
          Availability and precision reported by the runtime for each backend and device.
        </p>
        <div className="fm-start-compute-settings__lanes">
          {LANE_ORDER.map((lane) => (
            <RuntimeLaneCard
              compute={compute}
              key={`${lane.backend}-${lane.device}`}
              laneKey={lane}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function GpuCard({ gpu, position }: { readonly gpu: GpuInfo; readonly position: number }) {
  const memory = getGpuMemory(gpu);
  const utilization = isValidPercent(gpu.utilizationPercent) ? gpu.utilizationPercent : null;
  const temperature =
    typeof gpu.temperatureC === "number" && Number.isFinite(gpu.temperatureC)
      ? gpu.temperatureC
      : null;

  return (
    <article className="fm-start-compute-settings__gpu-card" role="listitem">
      <div className="fm-start-compute-settings__gpu-head">
        <div>
          <h4>{gpu.name}</h4>
          <p>GPU {gpu.index ?? position}</p>
        </div>
        {gpu.cudaVersion ? <span className="fm-start-compute-settings__version">CUDA {gpu.cudaVersion}</span> : null}
      </div>

      <dl className="fm-start-compute-settings__metrics fm-start-compute-settings__metrics--gpu">
        {memory ? (
          <>
            <Metric label="VRAM used" value={formatGigabytes(memory.usedBytes)} />
            <Metric label="VRAM free" value={formatGigabytes(memory.freeBytes)} />
            <Metric label="VRAM total" value={formatGigabytes(memory.totalBytes)} />
          </>
        ) : (
          <Metric label="VRAM" value="Readings unavailable or inconsistent" />
        )}
        <Metric
          label="GPU temperature"
          value={temperature === null ? "Not reported" : `${numberFormat.format(temperature)} °C`}
        />
      </dl>

      {memory ? (
        <PercentMeter
          label={`GPU ${gpu.index ?? position} VRAM used`}
          value={(memory.usedBytes / memory.totalBytes) * 100}
        />
      ) : null}
      {utilization !== null ? (
        <div className="fm-start-compute-settings__telemetry">
          <PercentMeter label={`GPU ${gpu.index ?? position} system utilization`} value={utilization} />
          <p>Overall device utilization; it is not attributed to a specific Fullmag run.</p>
        </div>
      ) : null}
      {gpu.busyWithRun ? (
        <p className="fm-start-compute-settings__run">Reported active run: {gpu.busyWithRun}</p>
      ) : null}
    </article>
  );
}

function RuntimeLaneCard({
  compute,
  laneKey,
}: {
  readonly compute: ComputeEnvironment;
  readonly laneKey: { readonly backend: SolverKind; readonly device: "CPU" | "GPU" };
}) {
  const lane = compute.runtimeLanes?.find(
    (candidate) => candidate.backend === laneKey.backend && candidate.device === laneKey.device,
  );
  const availability = lane?.availability ?? "unknown";
  const status =
    availability === "available"
      ? "Available"
      : availability === "unavailable"
        ? "Unavailable"
        : "Not reported";
  const laneReason =
    lane?.reason ??
    (lane === undefined
      ? "Runtime did not report this lane."
      : availability === "unknown"
        ? "Runtime did not determine availability."
        : "No additional runtime reason was reported.");

  return (
    <article className="fm-start-compute-settings__lane" data-availability={availability}>
      <div className="fm-start-compute-settings__lane-head">
        <h4>
          {laneKey.backend} · {laneKey.device}
        </h4>
        <span className="fm-start-compute-settings__status" data-state={availability}>
          {status}
        </span>
      </div>
      <p className="fm-start-compute-settings__precision">
        Precision: {lane?.precisions.length ? lane.precisions.join(" · ") : "Not reported"}
      </p>
      {laneReason ? <p className="fm-start-compute-settings__reason">{laneReason}</p> : null}
    </article>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="fm-start-compute-settings__metric">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function MemoryMetric({
  label,
  totalBytes,
  usedBytes,
}: {
  readonly label: string;
  readonly totalBytes: number | undefined;
  readonly usedBytes: number | undefined;
}) {
  const reading = getMemoryReading(totalBytes, usedBytes);
  return (
    <div className="fm-start-compute-settings__metric">
      <dt>{label}</dt>
      <dd>
        {reading
          ? `${formatGigabytes(reading.usedBytes)} used · ${formatGigabytes(reading.freeBytes)} free · ${formatGigabytes(reading.totalBytes)} total`
          : "Not reported"}
      </dd>
    </div>
  );
}

function PercentMeter({ label, value }: { readonly label: string; readonly value: number }) {
  const percent = clampPercent(value);
  return (
    <div className="fm-start-compute-settings__meter-wrap">
      <div
        aria-label={label}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={percent}
        className="fm-start-compute-settings__meter"
        role="meter"
      >
        <div className="fm-start-compute-settings__meter-fill" style={{ width: `${percent}%` }} />
      </div>
      <span>{numberFormat.format(value)}%</span>
    </div>
  );
}

function getGpuMemory(gpu: GpuInfo) {
  if (
    !Number.isFinite(gpu.vramTotalBytes) ||
    !Number.isFinite(gpu.vramFreeBytes) ||
    gpu.vramTotalBytes <= 0 ||
    gpu.vramFreeBytes < 0 ||
    gpu.vramFreeBytes > gpu.vramTotalBytes
  ) {
    return null;
  }
  return {
    freeBytes: gpu.vramFreeBytes,
    totalBytes: gpu.vramTotalBytes,
    usedBytes: gpu.vramTotalBytes - gpu.vramFreeBytes,
  };
}

function getMemoryReading(totalBytes: number | undefined, usedBytes: number | undefined) {
  if (
    totalBytes === undefined ||
    usedBytes === undefined ||
    !Number.isFinite(totalBytes) ||
    !Number.isFinite(usedBytes) ||
    totalBytes <= 0 ||
    usedBytes < 0 ||
    usedBytes > totalBytes
  ) {
    return null;
  }
  return { freeBytes: totalBytes - usedBytes, totalBytes, usedBytes };
}

function isValidPercent(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 100;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function formatGigabytes(bytes: number): string {
  return `${numberFormat.format(bytes / GIGABYTE)} GB`;
}
