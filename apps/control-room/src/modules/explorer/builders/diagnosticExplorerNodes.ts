import type { ExplorerNode } from "../explorerTypes";

import type { RuntimeDiagnosticDescriptor } from "./runtimeExplorerSnapshot";

const DIAGNOSTIC_KIND: Record<RuntimeDiagnosticDescriptor["kind"], ExplorerNode["kind"]> = {
  capability: "diagnostics.capability",
  "frequency-domain": "diagnostics.frequency-domain",
  health: "diagnostics.health",
  mesh: "diagnostics.mesh",
  performance: "diagnostics.performance",
  problem: "diagnostics.problem",
  solver: "diagnostics.solver",
};

export function buildRuntimeDiagnosticTree(
  descriptors: readonly RuntimeDiagnosticDescriptor[] = [],
): ExplorerNode[] {
  const children = descriptors.map((descriptor) => ({
    ...descriptor.state,
    icon: "gauge" as const,
    id: descriptor.id,
    kind: DIAGNOSTIC_KIND[descriptor.kind],
    label: descriptor.label,
    parentId: "diagnostics:root",
    resourceRef: descriptor.detail.key,
    runtimeDescriptorId: descriptor.id,
    runtimeResourceKey: descriptor.detail.key,
  }));
  return [{
    availability: aggregateAvailability(descriptors),
    children,
    executionState: "not_started",
    icon: "folder",
    id: "diagnostics:root",
    kind: "diagnostics.root",
    label: "Diagnostics",
    parentId: null,
    resourceState: aggregateResourceState(descriptors),
    selectable: false,
    status: aggregateStatus(descriptors),
}];
}

function aggregateAvailability(
  descriptors: readonly RuntimeDiagnosticDescriptor[],
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

function aggregateResourceState(descriptors: readonly RuntimeDiagnosticDescriptor[]): ExplorerNode["resourceState"] {
  if (descriptors.some((descriptor) => descriptor.state.resourceState === "error")) return "error";
  if (descriptors.some((descriptor) => descriptor.state.resourceState === "stale")) return "stale";
  if (descriptors.some((descriptor) => descriptor.state.resourceState === "loading")) return "loading";
  if (descriptors.some((descriptor) => descriptor.state.resourceState === "ready")) return "ready";
  return "idle";
}

function aggregateStatus(descriptors: readonly RuntimeDiagnosticDescriptor[]): ExplorerNode["status"] {
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
