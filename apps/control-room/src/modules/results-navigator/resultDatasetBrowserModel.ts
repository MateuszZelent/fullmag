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
  AnalysisResultFieldRef,
  AnalysisResultItemPageResource,
  AnalysisResultPageQuery,
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
  sampleIndex: number | null;
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
  displayIndex: number | null;
  itemId: string;
  sampleId: string;
  sampleIndex: number | null;
  label: string;
  itemKind: string;
  itemKindCode: AnalysisResultItemPageResource["items"][number]["item_kind"];
  status: ReturnType<typeof analysisResultUiStatus>;
  statusLabel: string;
  frequencyHz: number | null;
  branchId: string | null;
  residualRelativeL2: number | null;
  fieldAvailable: boolean;
  fieldId: string | null;
  fieldRef: AnalysisResultFieldRef | null;
  selectable: boolean;
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

export type ResultDatasetItemStatusFilter =
  | "all"
  | "ready"
  | "partial"
  | "interrupted"
  | "corrupt"
  | "legacy"
  | "unsupported";

function finiteFilterValue(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function resultDatasetFilterErrorMessage(
  frequencyMin: string,
  frequencyMax: string,
  residualMax: string,
): string | null {
  const values = [
    ["Frequency minimum", frequencyMin],
    ["Frequency maximum", frequencyMax],
    ["Residual maximum", residualMax],
  ] as const;
  for (const [label, value] of values) {
    if (value.trim() && finiteFilterValue(value) === undefined) {
      return `${label} must be a finite number.`;
    }
  }
  const parsedMin = finiteFilterValue(frequencyMin);
  const parsedMax = finiteFilterValue(frequencyMax);
  if (parsedMin !== undefined && parsedMax !== undefined && parsedMin > parsedMax) {
    return "Frequency minimum must not exceed frequency maximum.";
  }
  const parsedResidual = finiteFilterValue(residualMax);
  if (parsedResidual !== undefined && parsedResidual < 0) {
    return "Residual maximum must not be negative.";
  }
  return null;
}

export interface ResultDatasetItemPageQueryOptions {
  axisFilters: Readonly<Record<string, string>>;
  branchId: string | null;
  cursor: string | null;
  frequencyMax: string;
  frequencyMin: string;
  itemFieldFilter: "all" | "true" | "false";
  itemStatusFilter: ResultDatasetItemStatusFilter;
  itemSort: string;
  residualMax: string;
  sampleId: string | null;
  serverFiltering: boolean;
  serverSorting: boolean;
}

export function buildResultDatasetItemPageQuery(
  options: ResultDatasetItemPageQueryOptions,
): AnalysisResultPageQuery {
  const filterError = resultDatasetFilterErrorMessage(
    options.frequencyMin,
    options.frequencyMax,
    options.residualMax,
  );
  const coordinateFilters = options.serverFiltering
    ? Object.fromEntries(
        Object.entries(options.axisFilters).map(([axisId, token]) => [
          `coordinate.${axisId}`,
          token,
        ]),
      )
    : {};
  return {
    limit: 50,
    ...coordinateFilters,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    // sample_id is the canonical item scope for the selected sample, not an
    // optional presentation filter controlled by server_filtering.
    ...(options.sampleId ? { sample_id: options.sampleId } : {}),
    ...(options.serverFiltering && options.itemFieldFilter !== "all"
      ? { has_field: options.itemFieldFilter === "true" }
      : {}),
    ...(options.serverFiltering && options.itemStatusFilter !== "all"
      ? { status: options.itemStatusFilter }
      : {}),
    ...(options.serverFiltering && options.branchId
      ? { branch_id: options.branchId }
      : {}),
    ...(options.serverFiltering && !filterError && finiteFilterValue(options.frequencyMin) !== undefined
      ? { frequency_min_hz: finiteFilterValue(options.frequencyMin) }
      : {}),
    ...(options.serverFiltering && !filterError && finiteFilterValue(options.frequencyMax) !== undefined
      ? { frequency_max_hz: finiteFilterValue(options.frequencyMax) }
      : {}),
    ...(options.serverFiltering && !filterError && finiteFilterValue(options.residualMax) !== undefined
      ? { residual_max: finiteFilterValue(options.residualMax) }
      : {}),
    ...(options.serverSorting ? { sort: options.itemSort } : {}),
  };
}

interface ResultDatasetPageIdentity {
  dataset_id: string;
  dataset_revision: string;
  run_id: string;
}

export function resultPageForDataset<TPage extends ResultDatasetPageIdentity>(
  page: TPage | null | undefined,
  manifest: Pick<ResultDatasetPageIdentity, "dataset_id" | "dataset_revision" | "run_id"> | null | undefined,
): TPage | null {
  if (
    !page ||
    !manifest ||
    page.run_id !== manifest.run_id ||
    page.dataset_id !== manifest.dataset_id ||
    page.dataset_revision !== manifest.dataset_revision
  ) {
    return null;
  }
  return page;
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

function sampleLabel(
  sample: AnalysisResultSamplePageResource["items"][number],
): string {
  const labels = sample.coordinates.flatMap((coordinate) => {
    const label = coordinate.label ?? coordinate.token;
    return label.trim().length > 0 ? [label] : [];
  });
  return labels.join(" · ") || sample.sample_id;
}

function itemLabel(
  item: AnalysisResultItemPageResource["items"][number],
): string {
  if (item.item_kind === "driven_frequency_point" && item.frequency_hz != null) {
    return `Response @ ${formatResultFrequency(item.frequency_hz)}`;
  }
  if (item.item_kind === "eigen_mode" && item.display_index != null) {
    return `Mode ${item.display_index + 1}`;
  }
  if (item.item_kind === "spectral_feature" && item.display_index != null) {
    return `Spectral feature ${item.display_index + 1}`;
  }
  if (item.item_kind === "dsf_point" && item.display_index != null) {
    const wavevector = item.wavevector_kf?.[0];
    if (item.frequency_hz != null && wavevector != null) {
      return `DSF @ k=${formatResultWavevector(wavevector)}, f=${formatResultFrequency(item.frequency_hz)}`;
    }
    return `DSF point ${item.display_index + 1}`;
  }
  return item.item_id;
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
    label: sampleLabel(sample),
    sampleIndex: sample.sample_index ?? null,
    sampleId: sample.sample_id,
    status: analysisResultUiStatus(sample.status),
    statusLabel: analysisResultStatusLabel(sample.status),
  }));
  const sampleIndexById = new Map(
    sampleRows.map((sample) => [sample.sampleId, sample.sampleIndex]),
  );
  const branchRows = (branches?.items ?? []).map((branch) => ({
    branchId: branch.branch_id,
    label: branch.label,
    pointCount: branch.point_count,
    status: analysisResultUiStatus(branch.status),
    statusLabel: analysisResultStatusLabel(branch.status),
  }));
  const itemRows = (items?.items ?? []).map((item) => {
    const status = analysisResultUiStatus(item.status);
    return {
      branchId: item.branch_id ?? null,
      fieldAvailable: item.field_ref?.status === "ready",
      fieldId: item.field_ref?.field_id ?? null,
      fieldRef: item.field_ref ?? null,
      displayIndex: item.display_index ?? null,
      frequencyHz: item.frequency_hz ?? null,
      itemId: item.item_id,
      itemKind: itemKindLabel(item.item_kind),
      itemKindCode: item.item_kind,
      label: itemLabel(item),
      sampleId: item.sample_id,
      sampleIndex: sampleIndexById.get(item.sample_id) ?? null,
      residualRelativeL2: item.quality.residual_relative_l2 ?? null,
      selectable: status !== "unsupported" && status !== "error" && status !== "missing",
      status,
      statusLabel: analysisResultStatusLabel(item.status),
    };
  });
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

export function formatResultWavevector(wavevectorRadPerM: number | null): string {
  if (wavevectorRadPerM == null || !Number.isFinite(wavevectorRadPerM)) return "—";
  return `${wavevectorRadPerM.toExponential(3)} rad/m`;
}

export function formatResultResidual(residual: number | null): string {
  if (residual == null || !Number.isFinite(residual)) return "—";
  return residual.toExponential(2);
}
