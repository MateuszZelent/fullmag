import { tauriInvoke } from "@/kernel/persistence/ProjectDocumentController";

import type { ComputeEnvironment, ComputeProbeState, GpuInfo } from "./types";

type Raw = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Raw =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function toGpu(value: unknown): GpuInfo | null {
  if (!isRecord(value) || typeof value.name !== "string") return null;
  const total = finiteNumber(value.vram_total);
  const free = finiteNumber(value.vram_free);
  // A GPU with no memory figures cannot be reported on honestly.
  if (total === null || free === null || total <= 0) return null;
  return {
    name: value.name,
    cudaVersion: typeof value.cuda_version === "string" ? value.cuda_version : undefined,
    vramTotalBytes: total,
    vramFreeBytes: Math.min(Math.max(free, 0), total),
    busyWithRun: typeof value.busy_with_run === "string" ? value.busy_with_run : undefined,
  };
}

/** Normalise the host's probe; anything unrecognisable reads as "no probe". */
export function parseComputeProbe(raw: unknown): ComputeEnvironment | null {
  if (!isRecord(raw)) return null;
  const threads = finiteNumber(raw.cpu_threads);
  if (threads === null || threads < 1) return null;
  const gpus = Array.isArray(raw.gpus)
    ? raw.gpus.flatMap((gpu) => {
        const parsed = toGpu(gpu);
        return parsed ? [parsed] : [];
      })
    : [];
  return {
    gpus,
    cpuThreads: Math.round(threads),
    preferredBackend: gpus.length > 0 && raw.preferred_backend !== "cpu" ? "cuda" : "cpu",
    warnings: Array.isArray(raw.warnings)
      ? raw.warnings.filter((w): w is string => typeof w === "string")
      : [],
  };
}

/**
 * Ask the desktop host. `null` means this host cannot probe at all (the
 * browser build, or a host without the command), which stops the refresh loop.
 */
export async function probeCompute(): Promise<ComputeProbeState> {
  const invoke = tauriInvoke();
  if (!invoke) return null;
  try {
    return parseComputeProbe(await invoke<unknown>("compute_probe"));
  } catch {
    return null;
  }
}
