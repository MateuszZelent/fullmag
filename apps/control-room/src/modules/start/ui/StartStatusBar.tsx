import type { ComputeProbeState, RecentIndexState } from "../model/types";
import type { StartPreferencesController } from "../model/useStartPreferences";

import { TelemetrySwitch, UpdateNoticeItem } from "./TelemetrySwitch";

const GIGABYTE = 1e9;

/** One short line about the machine, from what the probe actually reported. */
export function describeCompute(compute: ComputeProbeState): string | null {
  if (!compute) return null;
  const gpu = compute.gpus[0];
  if (!gpu) {
    const label = compute.gpuProbeStatus === "unavailable" ? "GPU telemetry unavailable" : "CPU only";
    return compute.cpuThreads > 0 ? `${label} · ${compute.cpuThreads} threads` : label;
  }
  const used = Math.max(0, gpu.vramTotalBytes - gpu.vramFreeBytes) / GIGABYTE;
  const total = gpu.vramTotalBytes / GIGABYTE;
  return [gpu.cudaVersion ? `CUDA ${gpu.cudaVersion}` : null, gpu.name, `${used.toFixed(1)}/${total.toFixed(1)} GB`]
    .filter(Boolean)
    .join(" · ");
}

export function describeIndexCount(index: RecentIndexState): string | null {
  if (index.kind !== "ready") return null;
  const count = index.index.entries.length;
  return `${count} ${count === 1 ? "project" : "projects"} indexed`;
}

export interface StartStatusBarProps {
  readonly compute: ComputeProbeState;
  readonly index: RecentIndexState;
  readonly sessionLabel?: string;
  /** Stored preferences; omitted, the strip shows neither the switch nor an update notice. */
  readonly preferences?: StartPreferencesController;
}

/**
 * The bottom strip of the mockup. Every item is something this page knows.
 * The telemetry switch records a preference and says plainly that this build
 * sends nothing; the update notice appears only when an updater stored one.
 * The mockup's build number stays out until the host exposes it.
 */
export function StartStatusBar({ compute, index, preferences, sessionLabel = "No active session" }: StartStatusBarProps) {
  const items = [
    sessionLabel,
    describeCompute(compute),
    describeIndexCount(index),
  ].filter((item): item is string => item !== null);
  return (
    <footer aria-label="Status" className="fm-start-status" role="contentinfo">
      {items.map((item) => (
        <span className="fm-start-status__item" key={item}>
          {item}
        </span>
      ))}
      {preferences?.state.kind === "ready" ? <UpdateNoticeItem notice={preferences.state.update} /> : null}
      {preferences ? (
        <TelemetrySwitch onChange={preferences.setTelemetry} saving={preferences.saving} state={preferences.state} />
      ) : null}
    </footer>
  );
}
