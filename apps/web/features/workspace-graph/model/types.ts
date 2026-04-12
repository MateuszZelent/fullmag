import type { QuantityDescriptor, ScalarRow } from "@/lib/useSessionStream";
import type { ResultsWorkspaceState } from "@/features/analyze/model/resultsWorkspace";
import type { StudyPipelineDocument } from "@/lib/study-builder/types";
import type { WorkspaceMode, WorkspaceTab } from "@/lib/workspace/workspace-store";

export interface WorkspaceGraphProject {
  id: string;
  label: string;
}

export interface StudyNodeRef {
  id: string;
  label: string;
  stageKind: string;
  enabled: boolean;
  source: "ui_authored" | "script_imported" | "macro_generated" | "unknown";
  childIds: string[];
}

export interface SolutionNode {
  id: string;
  label: string;
  sourceStudyId: string | null;
  revision: number | null;
  kind: "live" | "time_dependent" | "frequency_domain" | "eigenfrequency" | "artifact";
  status: "available" | "pending" | "stale";
}

export interface DatasetNodeRef {
  id: string;
  label: string;
  sourceStudyId: string | null;
  sourceSolutionId: string | null;
  quantityIds: string[];
  scalarCount: number;
  sampleCount: number;
  kind: "live" | "artifact" | "analysis";
}

export interface DerivedValueNodeRef {
  id: string;
  label: string;
  quantityId: string;
  sourceDatasetId: string | null;
  latestValue: number | null;
  unit: string | null;
}

export interface QuantityFrameViewModel {
  quantityId: string;
  label: string;
  unit: string | null;
  shape: string | null;
  location: string | null;
  domain: string | null;
  nComp: number | null;
  interactivePreview: boolean;
  available: boolean;
}

export interface ViewportDocumentState {
  id: string;
  workspaceMode: WorkspaceMode;
  tabId: string | null;
  viewMode: "3D" | "2D" | "Mesh" | "Analyze";
  quantityId: string | null;
  component: string | null;
  plane: string | null;
  sliceIndex: number | null;
  selectedDatasetId: string | null;
  selectedResultNodeId: string | null;
  renderMode: string | null;
  overlayToggles: {
    telemetryHudVisible: boolean;
    previewNoticesVisible: boolean;
  };
}

export interface WorkspaceGraphSelectionState {
  activeNodeId: string | null;
  activeResultNodeId: string | null;
  activeViewportDocumentId: string | null;
}

export interface WorkspaceGraphState {
  version: "workspace_graph.v2";
  project: WorkspaceGraphProject;
  studyPipeline: StudyPipelineDocument | null;
  studyNodes: StudyNodeRef[];
  solutions: SolutionNode[];
  datasets: DatasetNodeRef[];
  derivedValues: DerivedValueNodeRef[];
  resultsWorkspace: ResultsWorkspaceState;
  quantityFrames: QuantityFrameViewModel[];
  viewportDocuments: Record<string, ViewportDocumentState>;
  workspaceTabs: Record<WorkspaceMode, WorkspaceTab[]>;
  activeWorkspaceTabByStage: Record<WorkspaceMode, string | null>;
  selection: WorkspaceGraphSelectionState;
  scalarRows: ScalarRow[];
  updatedAt: number | null;
}

export interface WorkspaceGraphPatch {
  project?: WorkspaceGraphProject;
  studyPipeline?: StudyPipelineDocument | null;
  studyNodes?: StudyNodeRef[];
  solutions?: SolutionNode[];
  datasets?: DatasetNodeRef[];
  derivedValues?: DerivedValueNodeRef[];
  resultsWorkspace?: ResultsWorkspaceState;
  quantityFrames?: QuantityFrameViewModel[];
  viewportDocuments?: Record<string, ViewportDocumentState>;
  workspaceTabs?: Record<WorkspaceMode, WorkspaceTab[]>;
  activeWorkspaceTabByStage?: Record<WorkspaceMode, string | null>;
  selection?: Partial<WorkspaceGraphSelectionState>;
  scalarRows?: ScalarRow[];
  updatedAt?: number | null;
}

export interface WorkspaceGraphBridgeInput {
  projectLabel: string;
  workspaceMode: WorkspaceMode;
  workspaceTabs: Record<WorkspaceMode, WorkspaceTab[]>;
  activeWorkspaceTabByStage: Record<WorkspaceMode, string | null>;
  selectedNodeId: string | null;
  studyPipeline: StudyPipelineDocument | null;
  resultsWorkspace: ResultsWorkspaceState;
  quantities: QuantityDescriptor[];
  scalarRows: ScalarRow[];
  requestedPreviewQuantity: string | null;
  requestedPreviewComponent: string | null;
  plane: string | null;
  sliceIndex: number | null;
  viewMode: "3D" | "2D" | "Mesh" | "Analyze";
  renderMode: string | null;
}

