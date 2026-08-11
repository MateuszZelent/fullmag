import type { ExplorerNode } from "../explorerTypes";
import {
  buildFrequencyDomainJobsNode,
  type ExplorerTreeResources,
} from "./frequencyDomainExplorerNodes";

export function buildRuntimeJobTree(resources: ExplorerTreeResources): ExplorerNode[] {
  const hasRun = Boolean(resources.currentRun);
  const children = hasRun ? [buildFrequencyDomainJobsNode(resources)] : [];
  return [{
    availability: hasRun ? "available" : "unavailable",
    children,
    executionState: hasRun ? "completed" : "not_started",
    icon: "folder",
    id: "jobs:root",
    kind: "jobs.root",
    label: "Jobs",
    parentId: null,
    resourceState: hasRun ? "ready" : "idle",
    status: hasRun ? "ready" : "unavailable",
  }];
}
