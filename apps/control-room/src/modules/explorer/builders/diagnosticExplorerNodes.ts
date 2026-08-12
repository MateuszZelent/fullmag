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
    runtimeDetail: descriptor.detail,
  }));
  return [{
    availability: children.some((node) => node.availability === "available")
      ? children.every((node) => node.availability === "available") ? "available" : "partial"
      : "unavailable",
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

function aggregateResourceState(descriptors: readonly RuntimeDiagnosticDescriptor[]): ExplorerNode["resourceState"] {
  if (descriptors.some((descriptor) => descriptor.state.resourceState === "error")) return "error";
  if (descriptors.some((descriptor) => descriptor.state.resourceState === "stale")) return "stale";
  if (descriptors.some((descriptor) => descriptor.state.resourceState === "loading")) return "loading";
  if (descriptors.some((descriptor) => descriptor.state.resourceState === "ready")) return "ready";
  return "idle";
}

function aggregateStatus(descriptors: readonly RuntimeDiagnosticDescriptor[]): ExplorerNode["status"] {
  if (descriptors.some((descriptor) => descriptor.state.status === "failed")) return "failed";
  if (descriptors.some((descriptor) => descriptor.state.status === "stale")) return "stale";
  if (descriptors.some((descriptor) => descriptor.state.status === "ready")) return "ready";
  return "unavailable";
}
