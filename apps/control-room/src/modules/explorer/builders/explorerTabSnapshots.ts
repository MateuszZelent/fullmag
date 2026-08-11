import type {
  FrequencyDomainJsonArtifactResource,
  FrequencyDomainManifestResource,
  FrequencyDomainSweepProgressResource,
  FrequencyDomainTextArtifactResource,
} from "@/kernel/api/apiTypes";
import type { AnalysisFieldOverlayState } from "@/kernel/visualization/AnalysisFieldOverlayController";
import type { PinnedQuickChart } from "@/kernel/workspace/quickChartWorkspace";

import type { ModelTreeSnapshot } from "../explorerTypes";

export interface ExplorerResultOwnerIdentity {
  artifactRevision: number | string | null;
  equilibriumId: string | null;
  runId: string;
  stageId: string;
  studyProduct: "driven_response" | "modal_eigen" | string;
}

export interface ExplorerFrequencyDomainSnapshot {
  branches: FrequencyDomainJsonArtifactResource | null;
  cancelRequested: FrequencyDomainSweepProgressResource | null;
  dispersion: FrequencyDomainTextArtifactResource | null;
  manifest: FrequencyDomainManifestResource | null;
  responseProgress: FrequencyDomainSweepProgressResource | null;
  responseSweep: FrequencyDomainJsonArtifactResource | null;
  spectrum: FrequencyDomainJsonArtifactResource | null;
}

export interface ExplorerModelTabSnapshot {
  model: ModelTreeSnapshot | null;
  tabId: "model";
}

export interface ExplorerResultsTabSnapshot {
  activeOverlay: AnalysisFieldOverlayState | null;
  frequencyDomain: ExplorerFrequencyDomainSnapshot;
  owner: ExplorerResultOwnerIdentity | null;
  pinnedQuickChart: PinnedQuickChart | null;
  tabId: "results";
}

export interface ExplorerResourcesTabSnapshot {
  frequencyDomain: ExplorerFrequencyDomainSnapshot;
  tabId: "resources";
}

export interface ExplorerJobsTabSnapshot {
  frequencyDomain: ExplorerFrequencyDomainSnapshot;
  owner: ExplorerResultOwnerIdentity | null;
  tabId: "jobs";
}

export interface ExplorerDiagnosticsTabSnapshot {
  frequencyDomain: ExplorerFrequencyDomainSnapshot;
  owner: ExplorerResultOwnerIdentity | null;
  tabId: "diagnostics";
}

export type ExplorerTabSnapshot =
  | ExplorerDiagnosticsTabSnapshot
  | ExplorerJobsTabSnapshot
  | ExplorerModelTabSnapshot
  | ExplorerResourcesTabSnapshot
  | ExplorerResultsTabSnapshot;
