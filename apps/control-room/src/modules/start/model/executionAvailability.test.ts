import { describe, expect, it } from "vitest";

import type {
  ComputeEnvironment,
  ComputeNodeInventorySummary,
  ComputeNodeSnapshotSummary,
} from "./types";
import { resolveExecutionAvailability } from "./executionAvailability";

const lane = (
  backend: "FDM" | "FEM",
  device: "CPU" | "GPU",
  availability: "available" | "unavailable" | "unknown",
) => ({
  backend,
  device,
  availability,
  precisions: ["double"],
  reason: availability === "available" ? undefined : `${backend} ${device} is ${availability}`,
});

const compute = (runtimeLanes = [
  lane("FDM", "CPU", "available"),
  lane("FDM", "GPU", "available"),
  lane("FEM", "CPU", "available"),
  lane("FEM", "GPU", "unknown"),
]): ComputeEnvironment => ({
  gpus: [{ name: "NVIDIA", vramTotalBytes: 1, vramFreeBytes: 1 }],
  cpuThreads: 8,
  preferredBackend: "cuda",
  warnings: [],
  gpuProbeStatus: "ready",
  cpuProbeStatus: "ready",
  runtimeLanes,
});

const inventory = (
  overrides: Partial<{
    resourceStatus: ComputeNodeInventorySummary["resourceStatus"];
    refreshFailed: boolean;
    state: ComputeNodeInventorySummary["state"];
    sampleFreshness: string | null;
    gpuStatus: "available" | "last_known" | "unavailable";
    gpuCount: number;
  }> = {},
): ComputeNodeInventorySummary => {
  const snapshot = {
    sample: { source: "runtime", collectedAt: "2026-10-17T12:00:00Z", freshness: overrides.sampleFreshness ?? "current" },
    gpus: {
      status: overrides.gpuStatus ?? "available",
      value: Array.from({ length: overrides.gpuCount ?? 1 }, (_, index) => ({ uuid: `GPU-${index}` })),
    },
  } as unknown as ComputeNodeSnapshotSummary;
  const state = overrides.state ?? "current";
  return {
    hasSnapshot: true,
    nodeCount: 1,
    nodes: [{ nodeId: "desktop-host", state, snapshot, nodePolicy: null }],
    refreshFailed: overrides.refreshFailed ?? false,
    resourceStatus: overrides.resourceStatus ?? "ready",
    staleAfterSeconds: 30,
    state,
  };
};

const input = (overrides: Partial<Parameters<typeof resolveExecutionAvailability>[0]> = {}) => ({
  compute: compute(),
  nodeInventory: inventory(),
  refreshing: false,
  stale: false,
  error: null,
  ...overrides,
});

describe("execution availability", () => {
  it("requires a current GPU device snapshot and a production lane", () => {
    const availability = resolveExecutionAvailability(input());

    expect(availability.byBackend.auto.gpu.enabled).toBe(true);
    expect(availability.byBackend.fdm.gpu.enabled).toBe(true);
    expect(availability.byBackend.fem.gpu.enabled).toBe(false);
    expect(availability.byBackend.hybrid.gpu.enabled).toBe(false);
    expect(availability.byBackend.auto.cpu.enabled).toBe(true);
  });

  it("does not infer a hybrid production lane from two concrete lanes", () => {
    const availability = resolveExecutionAvailability(input({
      compute: compute([
        lane("FDM", "GPU", "available"),
        lane("FEM", "GPU", "available"),
      ]),
    }));

    expect(availability.byBackend.hybrid.gpu.enabled).toBe(false);
    expect(availability.byBackend.hybrid.gpu.reason).toContain("explicitly advertised");
  });

  it.each([
    ["loading", { compute: undefined }],
    ["loading with no current proof", { nodeInventory: inventory({ resourceStatus: "loading", state: "unavailable" }) }],
    ["stale", { stale: true }],
    ["failed", { error: "telemetry failed" }],
    ["last-known device", { nodeInventory: inventory({ gpuStatus: "last_known" }) }],
    ["empty device list", { nodeInventory: inventory({ gpuCount: 0 }) }],
  ])("disables GPU for %s even when retained data has a GPU", (_label, overrides) => {
    const availability = resolveExecutionAvailability(input(overrides));

    expect(availability.byBackend.auto.gpu.enabled).toBe(false);
    expect(availability.byBackend.auto.gpu.reason).toBeTruthy();
  });

  it("keeps a confirmed current snapshot through a normal background refresh", () => {
    const availability = resolveExecutionAvailability(input({
      refreshing: true,
      nodeInventory: inventory({ resourceStatus: "stale" }),
    }));

    expect(availability.byBackend.auto.gpu.enabled).toBe(true);
  });

  it("does not enable CPU when the backend has no advertised CPU lane", () => {
    const availability = resolveExecutionAvailability(input({
      compute: compute([lane("FDM", "GPU", "available")]),
    }));

    expect(availability.byBackend.auto.cpu.enabled).toBe(false);
    expect(availability.byBackend.auto.gpu.enabled).toBe(true);
  });

  it("keeps CPU available when GPU detection has no current device", () => {
    const availability = resolveExecutionAvailability(input({
      nodeInventory: inventory({ gpuCount: 0 }),
    }));

    expect(availability.byBackend.auto.cpu.enabled).toBe(true);
    expect(availability.byBackend.auto.gpu.enabled).toBe(false);
  });
});
