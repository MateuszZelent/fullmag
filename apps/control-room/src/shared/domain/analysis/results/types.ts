import type {
  AnalysisResultAxisResource,
  AnalysisResultAxisValueResource,
  AnalysisResultBranchPageResource,
  AnalysisResultBranchPointPageResource,
  AnalysisResultBranchPointResource,
  AnalysisResultBranchResource,
  AnalysisResultBranchSummaryResource,
  AnalysisResultCoordinateResource,
  AnalysisResultDatasetCatalogResource,
  AnalysisResultDatasetManifestResource,
  AnalysisResultFieldRef,
  AnalysisResultItemKind,
  AnalysisResultItemPageResource,
  AnalysisResultProjectionResource,
  AnalysisResultProjectionDescriptor,
  AnalysisResultProjectionSelectionEntry,
  AnalysisResultRelationPageResource,
  AnalysisResultRelationResource,
  AnalysisResultSampleIndexEntry,
  AnalysisResultSamplePageResource,
  AnalysisResultSpectralItemSummary,
  AnalysisResultStatusFacets,
} from "@/kernel/api/apiTypes";

export type {
  AnalysisResultAxisResource,
  AnalysisResultAxisValueResource,
  AnalysisResultBranchPageResource,
  AnalysisResultBranchPointPageResource,
  AnalysisResultBranchPointResource,
  AnalysisResultBranchResource,
  AnalysisResultBranchSummaryResource,
  AnalysisResultCoordinateResource,
  AnalysisResultDatasetCatalogResource,
  AnalysisResultDatasetManifestResource,
  AnalysisResultFieldRef,
  AnalysisResultItemKind,
  AnalysisResultItemPageResource,
  AnalysisResultProjectionResource,
  AnalysisResultProjectionDescriptor,
  AnalysisResultProjectionSelectionEntry,
  AnalysisResultRelationPageResource,
  AnalysisResultRelationResource,
  AnalysisResultSampleIndexEntry,
  AnalysisResultSamplePageResource,
  AnalysisResultSpectralItemSummary,
  AnalysisResultStatusFacets,
};

export type AnalysisResultSelectionFocus =
  | "dataset"
  | "slice"
  | "sample"
  | "item"
  | "branch"
  | "field"
  | "projection-point";

export interface AnalysisResultDatasetIdentity {
  runId: string;
  stageId: string;
  datasetId: string;
  datasetRevision: string;
}

export interface AnalysisResultCoordinateRef {
  axisId: string;
  token: string;
  scalarSI: number | null;
  vector3SI: readonly [number, number, number] | null;
  category: string | null;
  entityRef: string | null;
  label: string | null;
}

export interface AnalysisResultSelectionRef extends AnalysisResultDatasetIdentity {
  type: "analysis-result";
  kind: "analysis.result";
  nodeId: string;
  focus: AnalysisResultSelectionFocus;
  itemKind?: AnalysisResultItemKind;
  sampleId?: string;
  sampleIndex?: number;
  itemId?: string;
  displayIndex?: number;
  branchId?: string;
  axisId?: string;
  axisValueToken?: string;
  axisFilters?: Readonly<Record<string, string>>;
  fieldId?: string;
  fieldRevision?: string;
  fieldRef?: AnalysisResultFieldRef;
  projectionId?: string;
  projectionRevision?: string;
  projectionOrdinal?: number;
}

export interface AnalysisResultCursor extends AnalysisResultDatasetIdentity {
  sampleId: string | null;
  itemId: string | null;
  itemKind: AnalysisResultItemKind | null;
  coordinates: readonly AnalysisResultCoordinateRef[];
  branchId: string | null;
  fieldId: string | null;
  fieldRevision: string | null;
  projectionId: string | null;
  projectionRevision: string | null;
}

export interface AnalysisResultDatasetPageState {
  cursor: string | null;
  nextCursor: string | null;
  totalCount: number;
  limit: number;
  status: "idle" | "loading" | "ready" | "partial" | "error" | "missing";
}

export interface AnalysisResultProjectionPointSelection {
  projectionId: string;
  projectionRevision: string;
  ordinal: number;
  sampleId: string | null;
  itemId: string | null;
  branchId: string | null;
}
