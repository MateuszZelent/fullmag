import type {
  CurrentRunResource,
  CurrentTransportListResource,
  FrequencyDomainJsonArtifactResource,
  FrequencyDomainManifestResource,
  FrequencyDomainSweepProgressResource,
  FrequencyDomainTextArtifactResource,
  PlanarMonitorCollectionResource,
} from "@/kernel/api/apiTypes";
import type { AnalysisFieldOverlayState } from "@/kernel/visualization/AnalysisFieldOverlayController";
import type { PlanarMonitorDraft } from "@/kernel/workspace/crossSectionWorkspace";
import type { PinnedQuickChart } from "@/kernel/workspace/quickChartWorkspace";

import type { ExplorerNode, ExplorerNodeStatus } from "../explorerTypes";
export interface ExplorerTreeResources {
  activeAnalysisFieldOverlay?: AnalysisFieldOverlayState | null;
  currentRun?: CurrentRunResource | null;
  frequencyDomainBranches?: FrequencyDomainJsonArtifactResource | null;
  frequencyDomainCancelRequested?: FrequencyDomainSweepProgressResource | null;
  frequencyDomainDispersion?: FrequencyDomainTextArtifactResource | null;
  frequencyDomainManifest?: FrequencyDomainManifestResource | null;
  frequencyDomainResponseProgress?: FrequencyDomainSweepProgressResource | null;
  frequencyDomainResponseSweep?: FrequencyDomainJsonArtifactResource | null;
  frequencyDomainSpectrum?: FrequencyDomainJsonArtifactResource | null;
  pinnedQuickChart?: PinnedQuickChart | null;
}

export type ModelTreeResources = ExplorerTreeResources & {
  currentTransports?: CurrentTransportListResource | null;
  planarMonitorDraft?: PlanarMonitorDraft | null;
  planarMonitors?: PlanarMonitorCollectionResource | null;
};

export function createExplorerNode(input: ExplorerNode): ExplorerNode {
  if (input.id.trim().length === 0) {
    throw new Error("Explorer node requires a non-empty id");
  }
  return input;
}

export function compactExplorerNodes(
  nodes: Array<ExplorerNode | null | undefined>,
): ExplorerNode[] {
  return nodes.filter((node): node is ExplorerNode => Boolean(node));
}

export function meshStatusBadge(status: ExplorerNodeStatus): string {
  if (status === "primitive-only") return "primitive";
  if (status === "mesh-stale") return "mesh stale";
  if (status === "mesh-building") return "building";
  if (status === "mesh-ready") return "mesh ready";
  if (status === "mesh-failed") return "failed";
  if (status === "validation-blocked") return "blocked";
  if (status === "stale") return "out of date";
  return "default";
}

export function visualizationDebugNode({
  kind,
  parentId,
  objectId,
  regionId,
}: {
  kind:
    | "airbox.visualization.debug"
    | "object.visualization.debug"
    | "object.region.visualization.debug";
  parentId: string;
  objectId?: string;
  regionId?: string;
}): ExplorerNode {
  return createExplorerNode({
    id: `${parentId}:debug`,
    kind,
    label: "Debug",
    parentId,
    badge: "debug",
    icon: "gauge",
    ...(objectId ? { objectId } : {}),
    ...(regionId ? { regionId } : {}),
    status: "ready",
  });
}
