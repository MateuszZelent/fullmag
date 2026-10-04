import type {
  CpuTelemetryResource,
  GpuTelemetryResource,
  PlatformCapabilitiesResource,
} from "@/kernel/api/apiTypes";

import type { ComputeEnvironment, ComputeRuntimeLane, GpuInfo } from "./types";

const MEBIBYTE = 1024 * 1024;
const positive = (value: number): boolean => Number.isFinite(value) && value > 0;
const clampPercent = (value: number): number | undefined =>
  Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : undefined;

/** Hardware inventory and registered solver lanes are separate observations. */
export function describeRuntimeLanes(
  capabilities: PlatformCapabilitiesResource | null,
): readonly ComputeRuntimeLane[] | undefined {
  if (!capabilities) return undefined;
  return (["FDM", "FEM"] as const).flatMap((backend) =>
    (["CPU", "GPU"] as const).map((device): ComputeRuntimeLane => {
      const engines = capabilities.engines.filter(
        (engine) => engine.backend.toUpperCase() === backend &&
          engine.device.toUpperCase() === device && engine.public &&
          engine.mode === "strict" && engine.stability === "production",
      );
      const available = engines.filter((engine) => engine.status === "available");
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
  if (!cpu && !gpu) return null;
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
  const sampledAt = gpuReady ? gpu.sample_time_unix_ms : cpu?.sample_time_unix_ms;
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
    sampledAt: sampledAt !== undefined && positive(sampledAt) ? sampledAt : undefined,
    preferredBackend: gpus.length ? "cuda" : "cpu",
    runtimeLanes: describeRuntimeLanes(capabilities),
    warnings,
  };
}
