"use client";

import { cva } from "class-variance-authority";
import { Cpu, Settings } from "lucide-react";

import { cn } from "@/shared/utils/className";

import type { ComputeEnvironment, ComputeProbeState } from "../model/types";

type EnvironmentTone = "busy" | "degraded" | "idle" | "ready";

const environmentVariants = cva("fm-start-env", {
  variants: {
    tone: {
      busy: "fm-start-env--busy",
      degraded: "fm-start-env--degraded",
      idle: "",
      ready: "fm-start-env--ready",
    },
  },
  defaultVariants: { tone: "idle" },
});

const TONE_LABEL: Readonly<Record<EnvironmentTone, string>> = {
  busy: "busy",
  degraded: "degraded",
  idle: "unknown",
  ready: "ready",
};

const GIGABYTE = 1e9;

const gigabytes = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

export function resolveEnvironmentTone(compute: ComputeProbeState): EnvironmentTone {
  if (!compute) return "idle";
  const gpu = compute.gpus[0];
  if (!gpu) return "degraded";
  return gpu.busyWithRun ? "busy" : "ready";
}

export interface ComputeEnvironmentWidgetProps {
  readonly className?: string;
  readonly compute: ComputeProbeState;
  readonly onConfigure: () => void;
}

/**
 * Answers "can this machine run what I am about to open?" before anything is
 * opened, so it reports an unprobed host plainly instead of guessing.
 */
export function ComputeEnvironmentWidget({
  className,
  compute,
  onConfigure,
}: ComputeEnvironmentWidgetProps) {
  const tone = resolveEnvironmentTone(compute);

  return (
    <section
      aria-labelledby="fm-start-env-title"
      className={cn(environmentVariants({ tone }), className)}
      data-tone={tone}
    >
      <h2 className="fm-start-env__title" id="fm-start-env-title">
        Compute environment
      </h2>
      {compute ? (
        <ProbedEnvironment compute={compute} tone={tone} />
      ) : (
        <UnprobedEnvironment probing={compute === undefined} />
      )}
      <button className="fm-start-env__cfg" onClick={onConfigure} type="button">
        <Settings aria-hidden="true" size={14} />
        Configure compute
      </button>
    </section>
  );
}

function UnprobedEnvironment({ probing }: { readonly probing: boolean }) {
  return (
    <>
      <div className="fm-start-env__row">
        <span aria-hidden="true" className="fm-start-env__dot" />
        <span className="fm-start-env__name">{probing ? "Detecting…" : "Not probed"}</span>
      </div>
      {probing ? null : (
        <p className="fm-start-env__note">
          The compute probe arrives with the desktop host. The device is resolved when a run
          starts.
        </p>
      )}
    </>
  );
}

function ProbedEnvironment({
  compute,
  tone,
}: {
  readonly compute: ComputeEnvironment;
  readonly tone: EnvironmentTone;
}) {
  const gpu = compute.gpus[0];
  const usedBytes = gpu ? Math.max(0, gpu.vramTotalBytes - gpu.vramFreeBytes) : 0;
  const usedPercent =
    gpu && gpu.vramTotalBytes > 0 ? Math.round((usedBytes / gpu.vramTotalBytes) * 100) : 0;

  return (
    <>
      <div className="fm-start-env__row">
        <span aria-hidden="true" className="fm-start-env__dot" />
        <span className="fm-start-env__name">{gpu?.name ?? "No GPU detected"}</span>
        {gpu?.cudaVersion ? <span className="fm-start-env__val">CUDA {gpu.cudaVersion}</span> : null}
        <span className="sr-only">, {TONE_LABEL[tone]}</span>
      </div>
      {gpu ? (
        <>
          <div
            aria-label="VRAM in use"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={usedPercent}
            className="fm-start-env__meter"
            role="meter"
          >
            <div className="fm-start-env__meter-fill" style={{ width: `${usedPercent}%` }} />
          </div>
          <div className="fm-start-env__row">
            <span className="fm-start-env__val fm-start-env__val--lead">VRAM</span>
            <span className="fm-start-env__val">
              {gigabytes.format(usedBytes / GIGABYTE)} / {gigabytes.format(gpu.vramTotalBytes / GIGABYTE)} GB
            </span>
          </div>
          {gpu.busyWithRun ? (
            <p className="fm-start-env__note">In use by {gpu.busyWithRun}.</p>
          ) : null}
        </>
      ) : (
        <p className="fm-start-env__note">CPU fallback — roughly 40× slower than the GPU backend.</p>
      )}
      <div className="fm-start-env__row">
        <Cpu aria-hidden="true" size={14} />
        <span>CPU</span>
        <span className="fm-start-env__val">{compute.cpuThreads} threads</span>
      </div>
      {compute.warnings.map((warning) => (
        <p className="fm-start-env__note" key={warning}>
          {warning}
        </p>
      ))}
    </>
  );
}
