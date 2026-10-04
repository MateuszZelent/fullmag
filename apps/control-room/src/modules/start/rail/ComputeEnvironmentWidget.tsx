"use client";

import { cva } from "class-variance-authority";
import { Cpu, RefreshCw, Settings } from "lucide-react";

import { Button } from "@/shared/ui/Button";
import { cn } from "@/shared/utils/className";

import type { ComputeEnvironment, ComputeProbeState, GpuInfo } from "../model/types";

type EnvironmentTone = "busy" | "degraded" | "idle" | "observed";

const environmentVariants = cva("fm-start-env", {
  variants: {
    tone: {
      busy: "fm-start-env--busy",
      degraded: "fm-start-env--degraded",
      idle: "",
      observed: "fm-start-env--observed",
    },
  },
  defaultVariants: { tone: "idle" },
});

const GIGABYTE = 1e9;

const gigabytes = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

function gpuMemory(gpu: GpuInfo) {
  const { vramFreeBytes: freeBytes, vramTotalBytes: totalBytes } = gpu;
  if (
    !Number.isFinite(totalBytes) ||
    !Number.isFinite(freeBytes) ||
    totalBytes <= 0 ||
    freeBytes < 0 ||
    freeBytes > totalBytes
  ) {
    return null;
  }

  const usedBytes = totalBytes - freeBytes;
  return {
    freeBytes,
    totalBytes,
    usedBytes,
    usedPercent: clampPercent((usedBytes / totalBytes) * 100),
  };
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function memoryReading(totalBytes: number | undefined, usedBytes: number | undefined) {
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

function formatGigabytes(bytes: number): string {
  return `${gigabytes.format(bytes / GIGABYTE)} GB`;
}

export function resolveEnvironmentTone(
  compute: ComputeProbeState,
  error: string | null = null,
): EnvironmentTone {
  if (compute === undefined && error === null) return "idle";
  if (!compute || error || compute.gpuProbeStatus === "unavailable") return "degraded";
  if (compute.gpus.some((gpu) => gpu.busyWithRun)) return "busy";
  return compute.gpus.length > 0 ? "observed" : "degraded";
}

export interface ComputeEnvironmentWidgetProps {
  readonly className?: string;
  readonly compute: ComputeProbeState;
  readonly onConfigure: () => void;
  readonly refreshing?: boolean;
  readonly stale?: boolean;
  readonly error?: string | null;
  readonly onRefresh?: () => void;
}

/** Compact host telemetry that keeps the start screen honest about what was probed. */
export function ComputeEnvironmentWidget({
  className,
  compute,
  onConfigure,
  refreshing = false,
  stale = false,
  error = null,
  onRefresh,
}: ComputeEnvironmentWidgetProps) {
  const tone = resolveEnvironmentTone(compute, error);

  return (
    <section
      aria-busy={refreshing}
      aria-labelledby="fm-start-env-title"
      className={cn(environmentVariants({ tone }), className)}
      data-compute-environment=""
      data-tone={tone}
    >
      <div className="fm-start-env__heading">
        <h2 className="fm-start-env__title" id="fm-start-env-title">
          Compute environment
        </h2>
        {onRefresh ? (
          <Button
            aria-label={refreshing ? "Refreshing host readings" : "Refresh host readings"}
            className="fm-start-env__refresh"
            disabled={refreshing}
            onClick={onRefresh}
            size="icon"
            type="button"
            variant="ghost"
          >
            <RefreshCw aria-hidden="true" size={14} />
          </Button>
        ) : null}
      </div>

      <div className="fm-start-env__body">
        <ProbeStatus compute={compute} error={error} refreshing={refreshing} stale={stale} />
        {compute ? <ProbedEnvironment compute={compute} /> : null}
      </div>

      <Button
        className="fm-start-env__cfg"
        onClick={onConfigure}
        size="sm"
        type="button"
        variant="ghost"
      >
        <Settings aria-hidden="true" size={14} />
        Configure compute
      </Button>
    </section>
  );
}

function ProbeStatus({
  compute,
  error,
  refreshing,
  stale,
}: {
  readonly compute: ComputeProbeState;
  readonly error: string | null;
  readonly refreshing: boolean;
  readonly stale: boolean;
}) {
  if (compute === undefined) {
    return (
      <div aria-live="polite" className="fm-start-env__state">
        <span aria-hidden="true" className="fm-start-env__dot" />
        <span>{error ? "Compute probe failed" : "Reading host telemetry…"}</span>
        {error ? <p className="fm-start-env__note">Try refreshing the host readings.</p> : null}
      </div>
    );
  }

  if (compute === null) {
    return (
      <div className="fm-start-env__state">
        <span aria-hidden="true" className="fm-start-env__dot" />
        <span>{error ? "Compute probe failed" : "Probe unavailable"}</span>
        <p className="fm-start-env__note">
          {error
            ? "The host readings could not be refreshed. Try again."
            : "This host does not expose compute telemetry to the start screen."}
        </p>
      </div>
    );
  }

  const activeRun = compute.gpus.find((gpu) => gpu.busyWithRun)?.busyWithRun;
  const status =
    compute.gpuProbeStatus === "unavailable" ||
    (compute.gpuProbeStatus === undefined && compute.gpus.length === 0)
      ? "GPU telemetry unavailable"
      : compute.gpus.length === 0
        ? "No GPU detected"
        : activeRun
          ? `GPU in use by run ${activeRun}`
          : compute.gpus.length === 1
            ? "GPU telemetry available"
            : `${compute.gpus.length} GPUs detected`;

  return (
    <div className="fm-start-env__state">
      <span aria-hidden="true" className="fm-start-env__dot" />
      <span aria-live="polite">{status}</span>
      {refreshing ? <span className="fm-start-env__meta">Refreshing…</span> : null}
      {stale ? (
        <p className="fm-start-env__note" role="status">
          Showing the last successful reading.
        </p>
      ) : null}
      {error ? (
        <p className="fm-start-env__note fm-start-env__note--error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ProbedEnvironment({ compute }: { readonly compute: ComputeEnvironment }) {
  const threadsAvailable = Number.isFinite(compute.cpuThreads) && compute.cpuThreads > 0;
  const ram =
    compute.cpuProbeStatus === "unavailable"
      ? null
      : memoryReading(compute.memoryTotalBytes, compute.memoryUsedBytes);
  const ramUsedPercent = ram ? clampPercent((ram.usedBytes / ram.totalBytes) * 100) : null;

  return (
    <>
      {compute.source ? (
        <p className="fm-start-env__meta">
          {compute.source === "runtime" ? "Runtime host" : "Desktop host"}
        </p>
      ) : null}

      {compute.gpuProbeStatus === "unavailable" ||
      (compute.gpuProbeStatus === undefined && compute.gpus.length === 0) ? (
        <p className="fm-start-env__note">GPU telemetry is unavailable; this does not mean no GPU is present.</p>
      ) : compute.gpus.length === 0 ? (
        <p className="fm-start-env__note">
          {compute.cpuProbeStatus === "unavailable"
            ? "No GPU detected. CPU load and system memory readings are unavailable."
            : "No GPU was detected. The runtime lane details show which solver routes are available."}
        </p>
      ) : null}
      {compute.gpus.length > 0 ? (
        <div aria-label="Detected GPUs" className="fm-start-env__gpu-list" role="list">
          {compute.gpus.map((gpu, index) => (
            <GpuSummary gpu={gpu} key={`${gpu.index ?? "gpu"}-${index}`} position={index + 1} />
          ))}
        </div>
      ) : null}

      <div className="fm-start-env__cpu">
        <Cpu aria-hidden="true" size={14} />
        <span className="fm-start-env__cpu-name">{compute.cpuName ?? "CPU"}</span>
        <span className="fm-start-env__val">
          {threadsAvailable
            ? `${compute.cpuThreads} threads`
            : compute.cpuProbeStatus === "unavailable"
              ? "load telemetry unavailable"
              : "thread count unavailable"}
        </span>
      </div>

      {ram && ramUsedPercent !== null ? (
        <div className="fm-start-env__ram">
          <div className="fm-start-env__metric-line">
            <span className="fm-start-env__val fm-start-env__val--lead">RAM</span>
            <span className="fm-start-env__val">
              {formatGigabytes(ram.usedBytes)} / {formatGigabytes(ram.totalBytes)} used
            </span>
          </div>
          <div
            aria-label="Host RAM used"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={ramUsedPercent}
            className="fm-start-env__meter"
            role="meter"
          >
            <div className="fm-start-env__meter-fill" style={{ width: `${ramUsedPercent}%` }} />
          </div>
          <span className="fm-start-env__meta">
            {formatGigabytes(ram.freeBytes)} free
          </span>
        </div>
      ) : null}

      {compute.warnings.map((warning, index) => (
        <p className="fm-start-env__note" key={`${warning}-${index}`}>
          {warning}
        </p>
      ))}
    </>
  );
}

function GpuSummary({
  gpu,
  position,
}: {
  readonly gpu: GpuInfo;
  readonly position: number;
}) {
  const memory = gpuMemory(gpu);

  return (
    <article className="fm-start-env__gpu" role="listitem">
      <div className="fm-start-env__gpu-head">
        <span className="fm-start-env__name">
          GPU {gpu.index ?? position}: {gpu.name}
        </span>
        {gpu.cudaVersion ? <span className="fm-start-env__meta">CUDA {gpu.cudaVersion}</span> : null}
      </div>
      {memory ? (
        <>
          <div
            aria-label={`GPU ${gpu.index ?? position} VRAM used`}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={memory.usedPercent}
            aria-valuetext={`${formatGigabytes(memory.usedBytes)} used of ${formatGigabytes(memory.totalBytes)}; ${formatGigabytes(memory.freeBytes)} free`}
            className="fm-start-env__meter"
            role="meter"
          >
            <div className="fm-start-env__meter-fill" style={{ width: `${memory.usedPercent}%` }} />
          </div>
          <div className="fm-start-env__metric-line">
            <span className="fm-start-env__val fm-start-env__val--lead">VRAM</span>
            <span className="fm-start-env__val">
              {formatGigabytes(memory.usedBytes)} / {formatGigabytes(memory.totalBytes)} used
            </span>
          </div>
          <span className="fm-start-env__meta">{formatGigabytes(memory.freeBytes)} free</span>
        </>
      ) : (
        <p className="fm-start-env__note">VRAM readings unavailable or inconsistent.</p>
      )}
      {gpu.busyWithRun ? (
        <p className="fm-start-env__note">Reported active run: {gpu.busyWithRun}.</p>
      ) : null}
    </article>
  );
}
