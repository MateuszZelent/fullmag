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
