import type { ExplorerNode } from "../explorerTypes";
import {
  buildFrequencyDomainDiagnosticsNode,
  type ExplorerTreeResources,
} from "./frequencyDomainExplorerNodes";

export function buildRuntimeDiagnosticTree(resources: ExplorerTreeResources): ExplorerNode[] {
  const manifestPublished = Boolean(resources.frequencyDomainManifest);
  const children = manifestPublished
    ? [buildFrequencyDomainDiagnosticsNode(resources.frequencyDomainManifest)]
    : [];
  return [{
    availability: manifestPublished ? "available" : "unavailable",
    children,
    executionState: resources.currentRun ? "completed" : "not_started",
    icon: "folder",
    id: "diagnostics:root",
    kind: "diagnostics.root",
    label: "Diagnostics",
    parentId: null,
    resourceState: manifestPublished ? "ready" : "idle",
    status: manifestPublished ? "ready" : "unavailable",
  }];
}
