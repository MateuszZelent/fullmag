import {
  analysisResultCoordinateKey,
  analysisResultUiStatus,
  analysisResultStatusLabel,
} from "@/shared/domain/analysis/results";
import type {
  AnalysisResultAxisResource,
  AnalysisResultBranchPageResource,
  AnalysisResultDatasetCatalogResource,
  AnalysisResultDatasetManifestResource,
  AnalysisResultItemPageResource,
  AnalysisResultSamplePageResource,
} from "@/kernel/api/apiTypes";

export interface ResultDatasetBrowserDatasetRow {
  runId: string;
  stageId: string;
  datasetId: string;
  datasetRevision: string;
  label: string;
  productKind: string;
  status: ReturnType<typeof analysisResultUiStatus>;
  statusLabel: string;
  sampleCount: number;
  itemCount: number;
}

export interface ResultDatasetBrowserAxisRow {
  axisId: string;
  label: string;
  role: string;
  valueKind: string;
  cardinality: number;
  unit: string | null;
}

export interface ResultDatasetBrowserSampleRow {
  sampleId: string;
  label: string;
  status: ReturnType<typeof analysisResultUiStatus>;
  statusLabel: string;
  itemCount: number;
  coordinates: readonly string[];
}

export interface ResultDatasetBrowserBranchRow {
  branchId: string;
  label: string;
  pointCount: number;
  status: ReturnType<typeof analysisResultUiStatus>;
  statusLabel: string;
}

export interface ResultDatasetBrowserItemRow {
  itemId: string;
  sampleId: string;
  label: string;
  itemKind: string;
  itemKindCode: AnalysisResultItemPageResource["items"][number]["item_kind"];
  status: ReturnType<typeof analysisResultUiStatus>;
  statusLabel: string;
  frequencyHz: number | null;
  branchId: string | null;
  fieldAvailable: boolean;
  fieldId: string | null;
}

export interface ResultDatasetBrowserModel {
  selectedDatasetId: string | null;
  datasets: readonly ResultDatasetBrowserDatasetRow[];
  axes: readonly ResultDatasetBrowserAxisRow[];
  branches: readonly ResultDatasetBrowserBranchRow[];
  samples: readonly ResultDatasetBrowserSampleRow[];
  items: readonly ResultDatasetBrowserItemRow[];
  manifestStatus: ReturnType<typeof analysisResultUiStatus>;
}

function productKindLabel(productKind: string): string {
  switch (productKind) {
    case "modal_eigen":
      return "Modal eigen";
    case "driven_response":
      return "Driven response";
    case "time_domain_spectrum":
      return "Temporal spectrum";
    case "dynamic_structure_factor":
      return "S(k,f)";
    default:
      return productKind;
  }
}

function itemKindLabel(itemKind: string): string {
  switch (itemKind) {
    case "eigen_mode":
      return "Eigenmode";
    case "driven_frequency_point":
      return "Response point";
    case "spectral_feature":
      return "Spectral feature";
    case "dsf_point":
      return "DSF point";
    default:
      return itemKind;
  }
}

function coordinateLabel(
  coordinate: ResultDatasetBrowserSampleRow["coordinates"][number],
): string {
  return coordinate;
}

function axisRows(
  axes: readonly AnalysisResultAxisResource[] | undefined,
): readonly ResultDatasetBrowserAxisRow[] {
  return (axes ?? []).map((axis) => ({
    axisId: axis.axis_id,
    cardinality: axis.cardinality,
    label: axis.label,
    role: axis.role,
    unit: axis.unit_si ?? null,
    valueKind: axis.value_kind,
  }));
}

export function buildResultDatasetBrowserModel({
  catalog,
  branches,
  items,
  manifest,
  samples,
  selectedDatasetId,
}: {
  catalog: AnalysisResultDatasetCatalogResource | null;
  branches: AnalysisResultBranchPageResource | null;
  items: AnalysisResultItemPageResource | null;
  manifest: AnalysisResultDatasetManifestResource | null;
  samples: AnalysisResultSamplePageResource | null;
  selectedDatasetId: string | null;
}): ResultDatasetBrowserModel {
  const datasets = (catalog?.items ?? []).map((dataset) => ({
    datasetId: dataset.dataset_id,
    datasetRevision: dataset.dataset_revision,
    itemCount: dataset.item_count,
    label: dataset.title,
    productKind: productKindLabel(dataset.product_kind),
    sampleCount: dataset.sample_count,
    runId: dataset.run_id,
    stageId: dataset.stage_id,
    status: analysisResultUiStatus(dataset.status),
    statusLabel: analysisResultStatusLabel(dataset.status),
  }));
  const sampleRows = (samples?.items ?? []).map((sample) => ({
    coordinates: sample.coordinates.map((coordinate) =>
      coordinateLabel(
        `${coordinate.axis_id}=${coordinate.label ?? coordinate.token}`,
      ),
    ),
    itemCount: sample.item_count,
    label: sample.sample_id,
    sampleId: sample.sample_id,
    status: analysisResultUiStatus(sample.status),
    statusLabel: analysisResultStatusLabel(sample.status),
  }));
  const branchRows = (branches?.items ?? []).map((branch) => ({
    branchId: branch.branch_id,
    label: branch.label,
    pointCount: branch.point_count,
    status: analysisResultUiStatus(branch.status),
    statusLabel: analysisResultStatusLabel(branch.status),
  }));
  const itemRows = (items?.items ?? []).map((item) => ({
    branchId: item.branch_id ?? null,
    fieldAvailable: item.field_ref?.status === "ready",
    fieldId: item.field_ref?.field_id ?? null,
    frequencyHz: item.frequency_hz ?? null,
    itemId: item.item_id,
    itemKind: itemKindLabel(item.item_kind),
    itemKindCode: item.item_kind,
    label: item.item_id,
    sampleId: item.sample_id,
    status: analysisResultUiStatus(item.status),
    statusLabel: analysisResultStatusLabel(item.status),
  }));
  return {
    axes: axisRows(manifest?.axes),
    branches: branchRows,
    datasets,
    items: itemRows,
    manifestStatus: analysisResultUiStatus(manifest?.status),
    samples: sampleRows,
    selectedDatasetId:
      selectedDatasetId && datasets.some((dataset) => dataset.datasetId === selectedDatasetId)
        ? selectedDatasetId
        : datasets[0]?.datasetId ?? null,
  };
}

export function resultDatasetCoordinateKey(axisId: string, token: string): string {
  return analysisResultCoordinateKey({ axisId, token });
}

export function formatResultFrequency(frequencyHz: number | null): string {
  if (frequencyHz == null || !Number.isFinite(frequencyHz)) return "—";
  if (Math.abs(frequencyHz) >= 1e9) return `${(frequencyHz / 1e9).toFixed(4)} GHz`;
  if (Math.abs(frequencyHz) >= 1e6) return `${(frequencyHz / 1e6).toFixed(4)} MHz`;
  return `${frequencyHz.toFixed(3)} Hz`;
}
