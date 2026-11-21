import type { ComputeProbeState } from "../model/types";

type EnvironmentTone = "busy" | "degraded" | "idle" | "observed";

export function resolveEnvironmentTone(
  compute: ComputeProbeState,
  error: string | null = null,
): EnvironmentTone {
  if (compute === undefined && error === null) return "idle";
  if (!compute || error || compute.gpuProbeStatus === "unavailable") return "degraded";
  if (compute.gpus.some((gpu) => gpu.busyWithRun)) return "busy";
  return compute.gpus.length > 0 ? "observed" : "degraded";
}
