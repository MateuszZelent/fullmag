import type { ComputeProbeState, RecentIndexState } from "../model/types";

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
}

/**
 * The bottom strip of the mockup. Every item is something this page knows; the
 * mockup's build number, update notice and telemetry switch are left out until
 * the host exposes them, so nothing here is decoration.
 */
export function StartStatusBar({ compute, index, sessionLabel = "No active session" }: StartStatusBarProps) {
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
    </footer>
  );
}
