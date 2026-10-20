import { describe, expect, it } from "vitest";

import type {
  CpuTelemetryResource,
  GpuTelemetryResource,
  PlatformCapabilitiesResource,
} from "@/kernel/api/apiTypes";

import {
  computeFromTelemetry,
  describeRuntimeLanes,
  isTelemetrySampleStale,
  isTelemetrySampleStaleByAge,
} from "./computeTelemetry";

const cpuTelemetry = (sampledAt: number): CpuTelemetryResource => ({
  logical_cpus: 8,
  memory_total_mb: 16_384,
  memory_used_mb: 2_048,
  process_cpu_percent: 0,
  process_rss_mb: 32,
  process_threads: 1,
  sample_time_unix_ms: sampledAt,
  status: "available",
  utilization_cpu_percent: 10,
});

const gpuTelemetry = (sampledAt: number): GpuTelemetryResource => ({
  devices: [],
  sample_time_unix_ms: sampledAt,
  status: "available",
});

type HostEngine = PlatformCapabilitiesResource["engines"][number];

const hostEngine = (overrides: Partial<HostEngine> = {}): HostEngine => ({
  backend: "FEM",
  device: "CPU",
  mode: "strict",
  precision: "double",
  public: false,
  runtime_family: "test",
  runtime_version: "test",
  stability: "experimental",
  status: "available",
  status_reason: null,
  worker: "test",
  ...overrides,
});

describe("compute telemetry sample time", () => {
  it("uses the GPU timestamp when it is newer", () => {
    const compute = computeFromTelemetry(cpuTelemetry(1_000), gpuTelemetry(3_000), null);

    expect(compute?.sampledAt).toBe(3_000);
  });

  it("uses the CPU timestamp when it is newer", () => {
    const compute = computeFromTelemetry(cpuTelemetry(5_000), gpuTelemetry(3_000), null);

    expect(compute?.sampledAt).toBe(5_000);
  });
});

describe("runtime lanes without hardware telemetry", () => {
  it("keeps reported solver capabilities visible without inventing hardware readings", () => {
    const capabilities: PlatformCapabilitiesResource = {
      engines: [{
        backend: "FDM",
        device: "CPU",
        mode: "strict",
        precision: "double",
        public: true,
        runtime_family: "test-runtime",
        runtime_version: "1",
        stability: "production",
        status: "available",
        worker: "test-worker",
      }],
      profile_version: "1",
    };

    const compute = computeFromTelemetry(null, null, capabilities);

    expect(compute?.cpuProbeStatus).toBe("unavailable");
    expect(compute?.gpuProbeStatus).toBe("unavailable");
    expect(compute?.runtimeLanes?.find((lane) => lane.backend === "FDM" && lane.device === "CPU")?.availability)
      .toBe("available");
    expect(compute?.runtimeLanes?.find((lane) => lane.backend === "FDM" && lane.device === "GPU")?.availability)
      .toBe("unknown");
  });
});

describe("compute telemetry freshness", () => {
  it("keeps a sample current through 30 seconds and marks older samples stale", () => {
    const now = 60_000;

    expect(isTelemetrySampleStale(now - 30_000, now)).toBe(false);
    expect(isTelemetrySampleStale(now - 30_001, now)).toBe(true);
  });

  it("does not treat a future-dated sample as current", () => {
    expect(isTelemetrySampleStale(60_001, 60_000)).toBe(true);
  });

  it("ages retained runtime telemetry from receipt regardless of server clock direction", () => {
    const browserWallClockMs = 1_000_000;
    const serverSampleTimes = [
      browserWallClockMs + 5 * 60_000,
      browserWallClockMs - 5 * 60_000,
    ];

    for (const serverSampleTime of serverSampleTimes) {
      expect(
        isTelemetrySampleStaleByAge(5_000, serverSampleTime),
        `server sample ${serverSampleTime}`,
      ).toBe(false);
      expect(
        isTelemetrySampleStaleByAge(30_001, serverSampleTime),
        `server sample ${serverSampleTime}`,
      ).toBe(true);
    }

    expect(isTelemetrySampleStaleByAge(5_000, 0)).toBe(true);
  });
});

describe("runtime lane diagnostics", () => {
  it("keeps experimental availability display-only and preserves production precision", () => {
    const lanes = describeRuntimeLanes({
      profile_version: "test",
      engines: [
        hostEngine({
          backend: "FDM",
          device: "GPU",
          precision: "single",
          public: false,
          stability: "experimental",
        }),
        hostEngine({
          backend: "FDM",
          device: "GPU",
          precision: "double",
          public: true,
          stability: "production",
        }),
        hostEngine({ backend: "FEM", device: "CPU" }),
      ],
    });

    const fdmGpu = lanes?.find((lane) => lane.backend === "FDM" && lane.device === "GPU");
    const femCpu = lanes?.find((lane) => lane.backend === "FEM" && lane.device === "CPU");
    expect(fdmGpu).toMatchObject({
      availability: "available",
      precisions: ["double"],
      diagnostic: { kind: "experimental", state: "available" },
    });
    expect(femCpu).toMatchObject({
      availability: "unknown",
      precisions: [],
      diagnostic: { kind: "experimental", state: "available" },
    });
  });

  it("reports an unavailable strict experimental runtime with its status reason", () => {
    const lanes = describeRuntimeLanes({
      profile_version: "test",
      engines: [
        hostEngine({
          device: "GPU",
          status: "missing_driver",
          status_reason: "Native FEM GPU driver is unavailable",
        }),
        hostEngine({ mode: "probe", status: "available" }),
      ],
    });

    const femGpu = lanes?.find((lane) => lane.backend === "FEM" && lane.device === "GPU");
    expect(femGpu).toMatchObject({
      availability: "unknown",
      precisions: [],
      diagnostic: {
        kind: "experimental",
        state: "unavailable",
        reason: "Native FEM GPU driver is unavailable",
      },
    });
  });
});
