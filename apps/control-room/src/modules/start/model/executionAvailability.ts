import { useMemo } from "react";

import type {
  ComputeNodeInventorySummary,
  ComputeProbeState,
  ComputeRuntimeLane,
} from "./types";

export const EXECUTION_BACKENDS = ["auto", "fdm", "fem", "hybrid"] as const;
export type ExecutionBackend = (typeof EXECUTION_BACKENDS)[number];

export interface ExecutionDeviceAvailability {
  readonly enabled: boolean;
  readonly reason: string;
}

export interface ExecutionBackendAvailability {
  readonly cpu: ExecutionDeviceAvailability;
  readonly gpu: ExecutionDeviceAvailability;
}

export interface ExecutionAvailability {
  readonly byBackend: Readonly<Record<ExecutionBackend, ExecutionBackendAvailability>>;
}

export interface ExecutionAvailabilityInput {
  readonly compute: ComputeProbeState;
  readonly nodeInventory: ComputeNodeInventorySummary;
  readonly refreshing: boolean;
  readonly stale: boolean;
  readonly error: string | null;
}

const UNKNOWN_GPU: ExecutionDeviceAvailability = {
  enabled: false,
  reason: "GPU availability is still being checked.",
};

const UNKNOWN_CPU: ExecutionDeviceAvailability = {
  enabled: false,
  reason: "The backend has not advertised a usable CPU runtime lane.",
};

export const unavailableExecutionAvailability: ExecutionAvailability = {
  byBackend: Object.fromEntries(
    EXECUTION_BACKENDS.map((backend) => [backend, { cpu: UNKNOWN_CPU, gpu: UNKNOWN_GPU }]),
  ) as Record<ExecutionBackend, ExecutionBackendAvailability>,
};

/**
 * Derive device choices from the already-owned compute resources. This does
 * not probe another endpoint: a GPU is selectable only when the backend has
 * both a current device snapshot and an advertised strict production lane.
 */
export function resolveExecutionAvailability(
  input: ExecutionAvailabilityInput,
): ExecutionAvailability {
  const cpuLanes = input.compute?.runtimeLanes?.filter((lane) => lane.device === "CPU") ?? [];
  const gpuLanes = input.compute?.runtimeLanes?.filter((lane) => lane.device === "GPU") ?? [];
  const cpuReason = cpuLanes.length === 0
    ? UNKNOWN_CPU.reason
    : laneReason(cpuLanes);
  const cpuAvailable = (backend: ExecutionBackend): ExecutionDeviceAvailability =>
    laneAvailability(cpuLanes, backend, cpuReason);

  const gpuProbeReason = gpuAvailabilityReason(input);
  const gpuAvailable = (backend: ExecutionBackend): ExecutionDeviceAvailability => {
    if (gpuProbeReason) return { enabled: false, reason: gpuProbeReason };
    return laneAvailability(gpuLanes, backend, laneReason(gpuLanes));
  };

  return {
    byBackend: Object.fromEntries(
      EXECUTION_BACKENDS.map((backend) => [backend, {
        cpu: cpuAvailable(backend),
        gpu: gpuAvailable(backend),
      }]),
    ) as Record<ExecutionBackend, ExecutionBackendAvailability>,
  };
}

export function useExecutionAvailability(
  input: ExecutionAvailabilityInput,
): ExecutionAvailability {
  const { compute, error, nodeInventory, refreshing, stale } = input;
  return useMemo(
    () => resolveExecutionAvailability({ compute, error, nodeInventory, refreshing, stale }),
    [compute, error, nodeInventory, refreshing, stale],
  );
}

export function executionAvailabilityFor(
  availability: ExecutionAvailability | undefined,
  backend: string | undefined,
): ExecutionBackendAvailability {
  const selected = backend && isExecutionBackend(backend) ? backend : "auto";
  return availability?.byBackend[selected] ?? unavailableExecutionAvailability.byBackend[selected];
}

function isExecutionBackend(value: string): value is ExecutionBackend {
  return (EXECUTION_BACKENDS as readonly string[]).includes(value);
}

function laneAvailability(
  lanes: readonly ComputeRuntimeLane[],
  backend: ExecutionBackend,
  unavailableReason: string,
): ExecutionDeviceAvailability {
  // The capability contract advertises concrete FDM/FEM lanes only. Having
  // both concrete lanes available does not qualify the distinct hybrid
  // planner/runtime, so keep hybrid fail-closed until it is advertised
  // explicitly by the backend.
  if (backend === "hybrid") {
    return {
      enabled: false,
      reason: "Hybrid execution has no explicitly advertised production runtime lane.",
    };
  }
  const selected = lanes.filter((lane) => backend === "auto" ||
    lane.backend.toLowerCase() === backend);
  if (selected.length > 0 && selected.some((lane) => lane.availability === "available")) {
    return { enabled: true, reason: "" };
  }
  return {
    enabled: false,
    reason: selected.length > 0 ? laneReason(selected) : unavailableReason,
  };
}

function laneReason(lanes: readonly ComputeRuntimeLane[]): string {
  const reasons = [...new Set(lanes
    .filter((lane) => lane.availability !== "available")
    .map((lane) => lane.reason?.trim())
    .filter((reason): reason is string => Boolean(reason)))];
  return reasons.join("; ") || "No advertised runtime lane is available for this backend.";
}

function gpuAvailabilityReason(input: ExecutionAvailabilityInput): string | null {
  if (input.compute === undefined) {
    return "GPU availability is still being checked.";
  }
  if (input.compute === null) return "GPU availability could not be confirmed.";
  if (input.stale || input.error || input.nodeInventory.refreshFailed) {
    return "GPU availability is not current; refresh the compute readings before choosing GPU.";
  }
  if (input.compute.gpuProbeStatus !== "ready" || input.compute.gpus.length === 0) {
    return "The backend has not reported an available GPU device.";
  }
  const hasCurrentDeviceSnapshot = input.nodeInventory.nodes.some((node) =>
    node.state === "current" &&
    node.snapshot?.sample.freshness === "current" &&
    node.snapshot.gpus.status === "available" &&
    (node.snapshot.gpus.value?.length ?? 0) > 0,
  );
  return hasCurrentDeviceSnapshot ? null : input.refreshing ||
    input.nodeInventory.resourceStatus === "loading" ||
    input.nodeInventory.resourceStatus === "stale"
    ? "GPU availability is still being checked."
    : "No current GPU device snapshot is available.";
}
