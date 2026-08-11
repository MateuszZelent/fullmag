import type { ExplorerNode } from "../explorerTypes";
import {
  buildFrequencyDomainResourceNodes,
  type ExplorerTreeResources,
} from "./frequencyDomainExplorerNodes";

export function buildRuntimeResourceTree(resources: ExplorerTreeResources): ExplorerNode[] {
  const children = resources.frequencyDomainManifest
    ? buildFrequencyDomainResourceNodes(
        resources.frequencyDomainManifest,
        resources.activeAnalysisFieldOverlay,
      )
    : [];
  return [{
    availability: children.length > 0 ? "available" : "unavailable",
    children,
    executionState: "not_started",
    icon: "folder",
    id: "resources:root",
    kind: "resources.root",
    label: "Session Resources",
    parentId: null,
    resourceState: children.length > 0 ? "ready" : "idle",
    status: children.length > 0 ? "ready" : "unavailable",
  }];
}
