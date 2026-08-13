import type { ExplorerNode } from "../explorerTypes";

import type { RuntimeResourceDescriptor } from "./runtimeExplorerSnapshot";

const FAMILY_LABELS: Record<RuntimeResourceDescriptor["family"], string> = {
  analysis: "Analysis",
  data: "Data",
  diagnostics: "Diagnostics",
  meshing: "Meshing",
  platform: "Platform",
  session: "Session",
  simulation: "Simulation",
};

const FAMILY_ORDER: readonly RuntimeResourceDescriptor["family"][] = [
  "platform",
  "session",
  "simulation",
  "data",
  "meshing",
  "analysis",
  "diagnostics",
];

export function buildRuntimeResourceTree(
  descriptors: readonly RuntimeResourceDescriptor[] = [],
): ExplorerNode[] {
  const children = FAMILY_ORDER.flatMap((family) => {
    const resources = descriptors.filter((descriptor) => descriptor.family === family);
    if (resources.length === 0) return [];
    const parentId = `resources:${family}`;
    return [{
      availability: aggregateAvailability(resources),
      children: resources.map((descriptor) => ({
        ...descriptor.state,
        icon: "database" as const,
        id: descriptor.id,
        kind: "resources.runtime" as const,
        label: descriptor.label,
        parentId,
        resourceRef: descriptor.detail.key,
        runtimeDescriptorId: descriptor.id,
        runtimeResourceKey: descriptor.detail.key,
      })),
      executionState: "not_started" as const,
      icon: "folder" as const,
      id: parentId,
      kind: "resources.root" as const,
      label: FAMILY_LABELS[family],
      parentId: "resources:root",
      resourceState: aggregateResourceState(resources),
      selectable: false,
      status: aggregateStatus(resources),
    }];
  });
  return [{
    availability: aggregateAvailability(descriptors),
    children,
    executionState: "not_started",
    icon: "folder",
    id: "resources:root",
    kind: "resources.root",
    label: "Session Resources",
    parentId: null,
    resourceState: aggregateResourceState(descriptors),
    selectable: false,
    status: aggregateStatus(descriptors),
  }];
}

function aggregateAvailability(
  descriptors: readonly RuntimeResourceDescriptor[],
): ExplorerNode["availability"] {
  if (descriptors.length === 0) return "unavailable";
  if (descriptors.every((descriptor) => descriptor.state.availability === "unsupported")) {
    return "unsupported";
  }
  if (descriptors.some((descriptor) => descriptor.state.availability === "available")) {
    return descriptors.every((descriptor) => descriptor.state.availability === "available")
      ? "available"
      : "partial";
  }
  if (descriptors.some((descriptor) => descriptor.state.availability === "partial")) {
    return "partial";
  }
  return "unavailable";
}

function aggregateResourceState(
  descriptors: readonly RuntimeResourceDescriptor[],
): ExplorerNode["resourceState"] {
  if (descriptors.some((descriptor) => descriptor.state.resourceState === "error")) return "error";
  if (descriptors.some((descriptor) => descriptor.state.resourceState === "stale")) return "stale";
  if (descriptors.some((descriptor) => descriptor.state.resourceState === "loading")) return "loading";
  if (descriptors.some((descriptor) => descriptor.state.resourceState === "ready")) return "ready";
  return "idle";
}

function aggregateStatus(
  descriptors: readonly RuntimeResourceDescriptor[],
): ExplorerNode["status"] {
  if (descriptors.some((descriptor) => descriptor.state.status === "failed")) return "failed";
  if (descriptors.some((descriptor) => descriptor.state.status === "unsupported")) return "unsupported";
  if (descriptors.some((descriptor) => descriptor.state.status === "degraded")) return "degraded";
  if (descriptors.some((descriptor) => descriptor.state.status === "warning")) return "warning";
  if (descriptors.some((descriptor) => descriptor.state.status === "stale")) return "stale";
  if (descriptors.some((descriptor) => descriptor.state.status === "ready")) {
    return descriptors.every((descriptor) => descriptor.state.status === "ready")
      ? "ready"
      : "warning";
  }
  return "unavailable";
}
