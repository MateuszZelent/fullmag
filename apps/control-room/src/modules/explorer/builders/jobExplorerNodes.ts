import type { ExplorerNode } from "../explorerTypes";

import type { RuntimeJobDescriptor } from "./runtimeExplorerSnapshot";

const JOB_KIND: Record<RuntimeJobDescriptor["kind"], ExplorerNode["kind"]> = {
  command: "jobs.command",
  run: "jobs.run",
  stage: "jobs.stage",
};

export function buildRuntimeJobTree(
  descriptors: readonly RuntimeJobDescriptor[] = [],
): ExplorerNode[] {
  const children = descriptors.map((descriptor) => ({
    ...descriptor.state,
    icon: descriptor.kind === "run" ? "play" as const : "activity" as const,
    id: descriptor.id,
    kind: JOB_KIND[descriptor.kind],
    label: descriptor.label,
    parentId: "jobs:root",
    resourceRef: descriptor.detail.key,
    runtimeDescriptorId: descriptor.id,
    runtimeResourceKey: descriptor.detail.key,
    selectable: descriptor.selectable,
  }));
  const executionState = aggregateExecution(descriptors);
  const resourceState = aggregateResourceState(descriptors);
  return [{
    availability: aggregateAvailability(descriptors),
    children,
    executionState,
    icon: "folder",
    id: "jobs:root",
    kind: "jobs.root",
    label: "Jobs",
    parentId: null,
    resourceState,
    selectable: false,
    status: resourceState === "error"
      ? "failed"
      : resourceState === "stale"
        ? "stale"
        : executionState === "not_started"
          ? "unavailable"
          : executionState,
  }];
}

function aggregateAvailability(
  descriptors: readonly RuntimeJobDescriptor[],
): ExplorerNode["availability"] {
  if (descriptors.some((descriptor) => descriptor.state.availability === "available")) {
    return descriptors.every((descriptor) => descriptor.state.availability === "available")
      ? "available"
      : "partial";
  }
  return "unavailable";
}

function aggregateExecution(descriptors: readonly RuntimeJobDescriptor[]): ExplorerNode["executionState"] {
  const states = descriptors.map((descriptor) => descriptor.state.executionState);
  if (states.includes("failed")) return "failed";
  if (states.includes("running")) return "running";
  if (states.includes("paused")) return "paused";
  if (states.includes("queued")) return "queued";
  if (states.includes("cancelled")) return "cancelled";
  if (states.length > 0 && states.every((state) => state === "completed")) return "completed";
  return "not_started";
}

function aggregateResourceState(descriptors: readonly RuntimeJobDescriptor[]): ExplorerNode["resourceState"] {
  if (descriptors.some((descriptor) => descriptor.state.resourceState === "error")) return "error";
  if (descriptors.some((descriptor) => descriptor.state.resourceState === "stale")) return "stale";
  if (descriptors.some((descriptor) => descriptor.state.resourceState === "loading")) return "loading";
  if (descriptors.some((descriptor) => descriptor.state.resourceState === "ready")) return "ready";
  return "idle";
}
