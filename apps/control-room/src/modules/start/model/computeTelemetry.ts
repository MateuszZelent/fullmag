import type {
  CpuTelemetryResource,
  GpuTelemetryResource,
  PlatformCapabilitiesResource,
} from "@/kernel/api/apiTypes";

import type { ComputeEnvironment, ComputeRuntimeLane, GpuInfo } from "./types";

const MEBIBYTE = 1024 * 1024;
export const COMPUTE_TELEMETRY_MAX_AGE_MS = 30_000;
const positive = (value: number): boolean => Number.isFinite(value) && value > 0;
const clampPercent = (value: number): number | undefined =>
  Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : undefined;

export function isTelemetrySampleStale(
  timestamp: number | undefined,
  now: number = Date.now(),
): boolean {
  if (timestamp === undefined) return false;
  if (!Number.isFinite(timestamp) || timestamp <= 0 || !Number.isFinite(now)) return true;
  return timestamp > now || now - timestamp > COMPUTE_TELEMETRY_MAX_AGE_MS;
}

/**
 * Runtime telemetry is stamped by the server wall clock. Age a retained
 * browser resource from its monotonic receipt instead of comparing clocks.
 */
export function isTelemetrySampleStaleByAge(
  elapsedSinceReceiptMs: number | undefined,
  timestamp: number | undefined,
): boolean {
  if (timestamp !== undefined &&
    (!Number.isFinite(timestamp) || timestamp <= 0)) return true;
  if (elapsedSinceReceiptMs === undefined) return false;
  if (!Number.isFinite(elapsedSinceReceiptMs) || elapsedSinceReceiptMs < 0) return true;
  return elapsedSinceReceiptMs > COMPUTE_TELEMETRY_MAX_AGE_MS;
}

export function formatTelemetrySampleTime(timestamp: number | undefined): {
  readonly dateTime: string;
  readonly label: string;
} | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  return { dateTime: date.toISOString(), label: date.toLocaleString("en-US") };
}

/** Hardware inventory and registered solver lanes are separate observations. */
export function describeRuntimeLanes(
  capabilities: PlatformCapabilitiesResource | null,
): readonly ComputeRuntimeLane[] | undefined {
  if (!capabilities) return undefined;
  return (["FDM", "FEM"] as const).flatMap((backend) =>
    (["CPU", "GPU"] as const).map((device): ComputeRuntimeLane => {
      const strictEngines = capabilities.engines.filter(
        (engine) => engine.backend.toUpperCase() === backend &&
          engine.device.toUpperCase() === device && engine.mode === "strict",
      );
      const engines = strictEngines.filter(
        (engine) => engine.public && engine.stability === "production",
      );
      const experimentalEngines = strictEngines.filter(
        (engine) => engine.stability === "experimental",
      );
      const available = engines.filter((engine) => engine.status === "available");
      const experimentalAvailable = experimentalEngines.some(
        (engine) => engine.status === "available",
      );
      const diagnostic: ComputeRuntimeLane["diagnostic"] = experimentalEngines.length
        ? {
            kind: "experimental",
            state: experimentalAvailable ? "available" : "unavailable",
            ...(experimentalAvailable
              ? {}
              : {
                  reason: [...new Set(
                    experimentalEngines.map(
                      (engine) => engine.status_reason?.trim() ||
                        engine.status.replaceAll("_", " ") ||
                        "Experimental runtime is unavailable",
                    ),
                  )].join("; "),
                }),
          }
        : undefined;
      return {
        backend,
        device,
        availability: available.length ? "available" : engines.length ? "unavailable" : "unknown",
        precisions: [...new Set(available.map((engine) => engine.precision))].sort(),
        reason: available.length
          ? undefined
          : engines.length
            ? [...new Set(engines.map((engine) => engine.status_reason ?? engine.status.replaceAll("_", " ")))].join("; ")
            : "No runtime has been reported for this lane.",
        ...(diagnostic ? { diagnostic } : {}),
      };
    }),
  );
}

/** Adapt the existing runtime telemetry; unavailable zeroes are never measurements. */
export function computeFromTelemetry(
  cpu: CpuTelemetryResource | null,
  gpu: GpuTelemetryResource | null,
  capabilities: PlatformCapabilitiesResource | null,
): ComputeEnvironment | null {
  if (!cpu && !gpu && !capabilities) return null;
  const cpuReady = cpu?.status === "available";
  const gpuReady = gpu?.status === "available";
  const gpus: GpuInfo[] = gpuReady
    ? gpu.devices.flatMap((device) => {
        if (!device.name.trim() || !positive(device.memory_total_mb) ||
          !Number.isFinite(device.memory_used_mb)) return [];
        const total = device.memory_total_mb * MEBIBYTE;
        const used = Math.min(total, Math.max(0, device.memory_used_mb * MEBIBYTE));
        return [{
          name: device.name,
          index: device.index,
          vramTotalBytes: total,
          vramFreeBytes: total - used,
          utilizationPercent: clampPercent(device.utilization_gpu_percent),
          temperatureC: typeof device.temperature_c === "number" && Number.isFinite(device.temperature_c)
            ? device.temperature_c : undefined,
        }];
      })
    : [];
  const gpuComplete = gpuReady && gpus.length === gpu.devices.length;
  const warnings = [
    ...(!cpuReady ? ["CPU load and system memory readings are unavailable on this host."] : []),
    ...(!gpuComplete ? ["GPU telemetry is unavailable. This does not confirm that the host has no GPU."] : []),
  ];
  const memoryTotalBytes = cpuReady && positive(cpu.memory_total_mb)
    ? cpu.memory_total_mb * MEBIBYTE : undefined;
  const sampleTimes = [
    cpuReady && cpu && positive(cpu.sample_time_unix_ms) ? cpu.sample_time_unix_ms : undefined,
    gpuReady && gpu && positive(gpu.sample_time_unix_ms) ? gpu.sample_time_unix_ms : undefined,
  ].filter((timestamp): timestamp is number => timestamp !== undefined);
  const sampledAt = sampleTimes.length > 0 ? Math.max(...sampleTimes) : undefined;
  return {
    source: "runtime",
    gpus,
    cpuThreads: cpu && positive(cpu.logical_cpus) ? Math.floor(cpu.logical_cpus) : 0,
    cpuName: cpu?.model_name?.trim() || undefined,
    cpuProbeStatus: cpuReady ? "ready" : "unavailable",
    gpuProbeStatus: gpuComplete ? "ready" : "unavailable",
    cpuUtilizationPercent: cpuReady ? clampPercent(cpu.utilization_cpu_percent) : undefined,
    memoryTotalBytes,
    memoryUsedBytes: memoryTotalBytes !== undefined && cpu && Number.isFinite(cpu.memory_used_mb)
      ? Math.min(memoryTotalBytes, Math.max(0, cpu.memory_used_mb * MEBIBYTE)) : undefined,
    sampledAt,
    preferredBackend: gpus.length ? "cuda" : "cpu",
    runtimeLanes: describeRuntimeLanes(capabilities),
    warnings,
  };
}
