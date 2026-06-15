import type { AnalysisChartResourceRef } from "./chartCursorPoint";
import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  DATA_FIELD_VECTOR_PATH,
} from "@/kernel/api/apiPaths";
import type { SelectionRef } from "@/kernel/selection/selectionTypes";

type ResourceStatus = "idle" | "loading" | "ready" | "stale" | "error";
type FrequencyDomainCalculationMode =
  | "dispersion_modal"
  | "fmr_modal"
  | "fmr_response"
  | "free_modes"
  | "response_map";

export interface FrequencyDomainChartRoute {
  mode: FrequencyDomainCalculationMode;
  primaryChart:
    | "dispersion"
    | "modal-spectrum"
    | "response-map"
    | "response-sweep";
  supportingCharts: string[];
  status: "available" | "unavailable";
  unavailableReason: string | null;
}

export interface FrequencyDomainJsonArtifactLike {
  artifact_path?: string | null;
  payload?: unknown;
  status: string;
}

export interface FrequencyDomainTextArtifactLike {
  status: string;
  text?: string | null;
}

const FREQUENCY_DOMAIN_EIGEN_SPECTRUM_RESOURCE_KEY =
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH;
const FREQUENCY_DOMAIN_EIGEN_DISPERSION_RESOURCE_KEY =
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH;
const FREQUENCY_DOMAIN_RESPONSE_SWEEP_RESOURCE_KEY =
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH;

export interface FrequencyDomainChartBuildResult<TPoint> {
  dataSourceVersion: "unknown" | "response.v1" | "response.v2";
  diagnostics: string[];
  droppedPointCount: number;
  points: TPoint[];
  series: FrequencyDomainChartSeries[];
}

export interface FrequencyDomainChartPoint {
  rowIndex: number;
  x: number;
  y: number;
}

export interface FrequencyDomainChartSeries {
  id: string;
  label: string;
  points: readonly FrequencyDomainChartPoint[];
  quantity: string;
  source: AnalysisChartResourceRef;
  status: ResourceStatus;
  unit: string;
  xUnit: string;
}

export interface EigenSpectrumPoint {
  branchId: string | null;
  dampingRateHz: number | null;
  frequencyHz: number;
  imaginaryFrequencyHz: number | null;
  modeFieldId: string | null;
  modeFieldResourceKey: string | null;
  rawModeIndex: number;
  residualNorm: number | null;
  sampleIndex: number;
  tangentLeakageMax: number | null;
}

export interface EigenDispersionPoint {
  branchId: string | null;
  frequencyHz: number;
  overlap: number | null;
  pathS: number;
  rawModeIndex: number;
  residualNorm: number | null;
  sampleIndex: number;
}

export interface EigenBranchPoint {
  frequencyImagHz: number | null;
  frequencyRealHz: number;
  modeFieldId: string | null;
  modeFieldResourceKey: string | null;
  overlapPrev: number | null;
  rawModeIndex: number;
  residualNorm: number | null;
  sampleIndex: number;
  trackingConfidence: number | null;
}

export interface EigenBranch {
  branchId: string;
  frequencyMaxHz: number | null;
  frequencyMinHz: number | null;
  label: string | null;
  overlapPrevMean?: number | null;
  overlapPrevMin: number | null;
  points: EigenBranchPoint[];
  sampleGapCount?: number;
  sampleGapMax?: number | null;
  sampleMax: number | null;
  sampleMin: number | null;
  trackingConfidenceMin: number | null;
  warnings?: string[];
}

interface EigenBranchDetailChartPoint {
  label: string;
  sampleIndex: number;
}

interface EigenBranchFrequencyChartPoint
  extends EigenBranchDetailChartPoint {
  valueHz: number;
}

interface EigenBranchOverlapChartPoint
  extends EigenBranchDetailChartPoint {
  value: number;
}

export interface EigenBranchDetailChartModel {
  frequencyRangeHz: { max: number | null; min: number | null };
  frequencySeries: EigenBranchFrequencyChartPoint[];
  overlapSeries: EigenBranchOverlapChartPoint[];
  sampleRange: { max: number | null; min: number | null };
}

export interface FrequencyResponsePoint {
  absorbedPowerDensity: number | null;
  amplitude: number | null;
  fieldId: string | null;
  frequencyIndex: number | null;
  frequencyHz: number;
  observableId: string;
  phaseRad: number | null;
  residualNorm: number | null;
  susceptibility: readonly number[] | null;
}

export interface FmrPeakPoint {
  amplitude: number | null;
  absorbedPowerDensity: number | null;
  fieldId: string | null;
  fieldResourceKey?: string | null;
  frequencyHz: number;
  frequencyPointIndex: number | null;
  linewidthHz: number | null;
  modeRef: { rawModeIndex: number; sampleIndex: number } | null;
  phaseRad: number | null;
  source: "driven_response" | "modal";
  validationStatus: "fail" | "pass" | "unavailable" | "warn";
}

export interface FmrModalDrivenComparisonPoint {
  detuningHz: number;
  drivenPeak: FmrPeakPoint;
  modalPeak: FmrPeakPoint;
}

export interface FmrModalDrivenComparisonModel {
  diagnostics: string[];
  nearestComparison: FmrModalDrivenComparisonPoint | null;
  pairs: FmrModalDrivenComparisonPoint[];
  readiness:
    | "driven-only"
    | "missing-peaks"
    | "modal-and-driven"
    | "modal-only";
}

export interface FrequencyDomainSelectionContext {
  analysisRunId?: string | null;
  analysisStageId?: string | null;
  artifactPath?: string | null;
  calculationMode?: FrequencyDomainCalculationMode | null;
  nodeId?: string | null;
  resourceRef?: string | null;
}

export interface FrequencyDomainResponseFieldResource {
  fieldResourceId: string;
  frequencyIndex: number;
  payloadPath?: string;
}

type JsonRecord = Record<string, unknown>;
type FrequencyChartUnit = "GHz" | "MHz" | "Hz";

interface FrequencyChartScale {
  divisor: number;
  unit: FrequencyChartUnit;
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteNumberList(value: unknown): number[] {
  return array(value).flatMap((item) => {
    const parsed = finiteNumber(item);
    return parsed == null ? [] : [parsed];
  });
}

function frequencyChartScale(valuesHz: readonly number[]): FrequencyChartScale {
  let maxAbs = 0;
  for (const value of valuesHz) {
    if (!Number.isFinite(value)) continue;
    maxAbs = Math.max(maxAbs, Math.abs(value));
  }
  if (maxAbs >= 1e9) return { divisor: 1e9, unit: "GHz" };
  if (maxAbs >= 1e6) return { divisor: 1e6, unit: "MHz" };
  return { divisor: 1, unit: "Hz" };
}

function fieldVectorResourceKey(fieldId: string): string {
  return `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", fieldId)}?view=phase_rotated_real&phase_rad=0`;
}

function susceptibilityValues(value: unknown): number[] {
  const direct = finiteNumberList(value);
  if (direct.length > 0) return direct;
  const values: number[] = [];
  for (const pair of array(value)) {
    const pairValues = finiteNumberList(pair);
    if (pairValues.length >= 2) {
      values.push(Math.hypot(pairValues[0] ?? 0, pairValues[1] ?? 0));
    } else {
      values.push(...pairValues);
    }
  }
  return values;
}

function finiteInteger(value: unknown, fallback = 0): number {
  const parsed = finiteNumber(value);
  return parsed == null ? fallback : Math.trunc(parsed);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function routeFrequencyDomainCalculationMode(
  manifestPayload: unknown,
): FrequencyDomainChartRoute {
  const manifest = record(manifestPayload);
  const requested = record(manifest?.requested_execution);
  const physics = record(manifest?.physics);
  const artifacts = record(manifest?.artifacts);
  const rawMode =
    stringValue(requested?.calculation_mode) ??
    calculationModeFromStageKind(stringValue(manifest?.stage_kind));
  const mode = normalizeCalculationMode(rawMode);

  if (mode === "dispersion_modal") {
    return {
      mode,
      primaryChart: "dispersion",
      supportingCharts: ["branch-table", "selected-mode-overlay"],
      status: stringValue(artifacts?.dispersion_csv_path) ? "available" : "unavailable",
      unavailableReason: stringValue(artifacts?.dispersion_csv_path)
        ? null
        : "dispersion artifact is missing",
    };
  }
  if (mode === "fmr_response" || mode === "response_map") {
    const hasSweep =
      stringValue(artifacts?.response_sweep_v2_path) != null ||
      stringValue(artifacts?.response_sweep_v1_path) != null;
    const hasResponseMap =
      stringValue(artifacts?.response_map_v1_path) != null ||
      stringValue(artifacts?.response_map_v2_path) != null;
    return {
      mode,
      primaryChart: mode === "response_map" && hasResponseMap
        ? "response-map"
        : "response-sweep",
      supportingCharts: ["peak-table", "phase-chart", "response-field-overlay"],
      status: hasResponseMap || hasSweep ? "available" : "unavailable",
      unavailableReason:
        hasResponseMap || hasSweep ? null : "response sweep artifact is missing",
    };
  }
  return {
    mode,
    primaryChart: "modal-spectrum",
    supportingCharts:
      mode === "fmr_modal"
        ? ["mode-table", "fmr-validation", "selected-mode-overlay"]
        : ["mode-table", "selected-mode-overlay"],
    status: stringValue(artifacts?.spectrum_v2_path) ? "available" : "unavailable",
    unavailableReason: stringValue(artifacts?.spectrum_v2_path)
      ? null
      : `${physics?.analysis_family === "magnetic_frequency_domain" ? "modal" : "spectrum"} artifact is missing`,
  };
}

export function responseFieldResourcesFromManifest(
  manifestPayload: unknown,
): FrequencyDomainResponseFieldResource[] {
  const manifest = record(manifestPayload);
  const resources = record(manifest?.resources);
  const entries = resources?.response_field_resources;
  if (!Array.isArray(entries)) return [];

  return entries.flatMap((entry): FrequencyDomainResponseFieldResource[] => {
    const item = record(entry);
    const frequencyIndex = finiteNumber(item?.frequency_index);
    const fieldResourceId = stringValue(item?.field_resource_id);
    const payloadPath = stringValue(item?.payload_path);
    if (frequencyIndex == null || !Number.isInteger(frequencyIndex)) return [];
    if (!fieldResourceId) return [];
    return [
      {
        fieldResourceId,
        frequencyIndex,
        ...(payloadPath ? { payloadPath } : {}),
      },
    ];
  });
}

function artifactStatus(
  resource: Pick<FrequencyDomainJsonArtifactLike, "status"> | null | undefined,
): ResourceStatus {
  return resource?.status === "ready" ? "ready" : "stale";
}

function calculationModeFromStageKind(stageKind: string | null): string | null {
  if (stageKind === "frequency_response") return "fmr_response";
  if (stageKind === "eigenmodes") return "free_modes";
  return null;
}

function normalizeCalculationMode(rawMode: string | null): FrequencyDomainCalculationMode {
  switch (rawMode) {
    case "dispersion":
    case "dispersion_modal":
      return "dispersion_modal";
    case "fmr":
    case "fmr_modal":
      return "fmr_modal";
    case "frequency_response":
    case "fmr_response":
      return "fmr_response";
    case "response_map":
      return "response_map";
    case "free_modes":
    default:
      return "free_modes";
  }
}

export function buildEigenSpectrumChartModel(
  resource: FrequencyDomainJsonArtifactLike | null | undefined,
): FrequencyDomainChartBuildResult<EigenSpectrumPoint> {
  const rows = spectrumRows(resource?.payload);
  const points: EigenSpectrumPoint[] = [];
  let droppedPointCount = 0;

  rows.forEach((row, rowIndex) => {
    const item = record(row);
    const frequencyHz = finiteNumber(
      item?.frequency_hz ??
        item?.frequency_real_hz ??
        item?.frequencyHz ??
        item?.frequencyRealHz ??
        item?.f_hz,
    );
    if (frequencyHz == null) {
      droppedPointCount += 1;
      return;
    }
    const rawModeIndex = finiteInteger(
      item?.raw_mode_index ?? item?.mode_index ?? item?.modeIndex,
      rowIndex,
    );
    const sampleIndex = finiteInteger(item?.sample_index ?? item?.sampleIndex);
    const modeFieldId = stringValue(item?.mode_field_id ?? item?.modeFieldId);
    const modeFieldResourceKey =
      stringValue(item?.mode_field_resource_key ?? item?.modeFieldResourceKey) ??
      (modeFieldId ? fieldVectorResourceKey(modeFieldId) : null);
    points.push({
      branchId: stringValue(item?.branch_id ?? item?.branchId),
      dampingRateHz: finiteNumber(item?.damping_rate_hz ?? item?.dampingRateHz),
      frequencyHz,
      imaginaryFrequencyHz: finiteNumber(
        item?.frequency_imag_hz ??
          item?.frequencyImagHz ??
          item?.imag_frequency_hz ??
          item?.imaginary_frequency_hz,
      ),
      modeFieldId,
      modeFieldResourceKey,
      rawModeIndex,
      residualNorm: finiteNumber(item?.residual_norm ?? item?.relative_residual_norm),
      sampleIndex,
      tangentLeakageMax: finiteNumber(
        item?.tangent_leakage_max ?? item?.tangentLeakageMax,
      ),
    });
  });

  const frequencyScale = frequencyChartScale(
    points.map((point) => point.frequencyHz),
  );

  return {
    dataSourceVersion: "unknown",
    diagnostics: [],
    droppedPointCount,
    points,
    series: [
      {
        id: "analysis.frequency-domain:eigen:spectrum:frequency",
        label: "Eigen frequency",
        points: points.map((point, rowIndex) => ({
          rowIndex,
          x: point.rawModeIndex,
          y: point.frequencyHz / frequencyScale.divisor,
        })),
        quantity: "frequency",
        source: {
          kind: "analysis.frequency_domain",
          resourceKey: FREQUENCY_DOMAIN_EIGEN_SPECTRUM_RESOURCE_KEY,
          tableId: "frequency-domain:eigen-spectrum",
        },
        status: artifactStatus(resource),
        unit: frequencyScale.unit,
        xUnit: "mode index",
      },
    ],
  };
}

export function buildEigenModeSelectionRef(
  point: EigenSpectrumPoint,
  context: FrequencyDomainSelectionContext = {},
): SelectionRef {
  return cleanFrequencyDomainSelectionRef({
    analysisRunId: context.analysisRunId ?? undefined,
    analysisStageId: context.analysisStageId ?? undefined,
    artifactPath: context.artifactPath ?? undefined,
    branchId: point.branchId ?? undefined,
    calculationMode: context.calculationMode ?? "free_modes",
    fieldId: point.modeFieldId ?? undefined,
    kind: "results.eigen.mode",
    modeIndex: point.rawModeIndex,
    nodeId: context.nodeId ?? frequencyDomainModeNodeId(point),
    resourceRef: context.resourceRef ?? point.modeFieldResourceKey ?? undefined,
    sampleIndex: point.sampleIndex,
    type: "frequency-domain",
  });
}

export function buildEigenDispersionChartModel(
  resource: FrequencyDomainTextArtifactLike | null | undefined,
): FrequencyDomainChartBuildResult<EigenDispersionPoint> {
  const parsed = parseDispersionCsv(resource?.text ?? "");
  const branchIds = new Set(parsed.points.map((point) => point.branchId ?? "raw"));
  const frequencyScale = frequencyChartScale(
    parsed.points.map((point) => point.frequencyHz),
  );
  const series = [...branchIds].map((branchId) => ({
    id: `analysis.frequency-domain:eigen:dispersion:${branchId}`,
    label: branchId === "raw" ? "Raw modes" : `Branch ${branchId}`,
    points: parsed.points.flatMap((point, rowIndex) =>
      (point.branchId ?? "raw") === branchId
        ? [{
        rowIndex,
        x: point.pathS,
        y: point.frequencyHz / frequencyScale.divisor,
          }]
        : [],
    ),
    quantity: "frequency",
    source: {
      kind: "analysis.frequency_domain" as const,
      resourceKey: FREQUENCY_DOMAIN_EIGEN_DISPERSION_RESOURCE_KEY,
      tableId: "frequency-domain:eigen-dispersion",
    },
    status: resource?.status === "ready" ? "ready" as const : "stale" as const,
    unit: frequencyScale.unit,
    xUnit: "rad/m",
  }));
  return {
    dataSourceVersion: "unknown",
    diagnostics: [],
    droppedPointCount: parsed.droppedPointCount,
    points: parsed.points,
    series,
  };
}

export function buildEigenDispersionPointSelectionRef(
  point: EigenDispersionPoint,
  context: FrequencyDomainSelectionContext = {},
): SelectionRef {
  return cleanFrequencyDomainSelectionRef({
    analysisRunId: context.analysisRunId ?? undefined,
    analysisStageId: context.analysisStageId ?? undefined,
    artifactPath: context.artifactPath ?? undefined,
    branchId: point.branchId ?? undefined,
    calculationMode: context.calculationMode ?? "dispersion_modal",
    kind: "results.eigen.dispersion",
    modeIndex: point.rawModeIndex,
    nodeId: context.nodeId ?? frequencyDomainDispersionPointNodeId(point),
    resourceRef: context.resourceRef ?? FREQUENCY_DOMAIN_EIGEN_DISPERSION_RESOURCE_KEY,
    sampleIndex: point.sampleIndex,
    type: "frequency-domain",
  });
}

export function buildEigenBranchSelectionRef(
  branch: EigenBranch,
  context: FrequencyDomainSelectionContext = {},
): SelectionRef {
  return cleanFrequencyDomainSelectionRef({
    analysisRunId: context.analysisRunId ?? undefined,
    analysisStageId: context.analysisStageId ?? undefined,
    artifactPath: context.artifactPath ?? undefined,
    branchId: branch.branchId,
    calculationMode: context.calculationMode ?? "dispersion_modal",
    kind: "results.eigen.branch",
    nodeId: context.nodeId ?? frequencyDomainBranchNodeId(branch),
    resourceRef:
      context.resourceRef ?? ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
    type: "frequency-domain",
  });
}

export function buildEigenBranchPointModeSelectionRef(
  branchId: string,
  point: EigenBranchPoint,
  context: FrequencyDomainSelectionContext = {},
): SelectionRef {
  return cleanFrequencyDomainSelectionRef({
    analysisRunId: context.analysisRunId ?? undefined,
    analysisStageId: context.analysisStageId ?? undefined,
    artifactPath: context.artifactPath ?? undefined,
    branchId,
    calculationMode: context.calculationMode ?? "dispersion_modal",
    fieldId: point.modeFieldId ?? undefined,
    kind: "results.eigen.mode",
    modeIndex: point.rawModeIndex,
    nodeId: context.nodeId ?? frequencyDomainBranchPointModeNodeId(point),
    resourceRef:
      context.resourceRef ??
      point.modeFieldResourceKey ??
      (point.modeFieldId ? fieldVectorResourceKey(point.modeFieldId) : undefined),
    sampleIndex: point.sampleIndex,
    type: "frequency-domain",
  });
}

export function buildEigenBranchDetailChartModel(
  branch: EigenBranch | null | undefined,
): EigenBranchDetailChartModel {
  const points = (branch?.points ?? []).toSorted(
    (left, right) =>
      left.sampleIndex - right.sampleIndex ||
      left.rawModeIndex - right.rawModeIndex,
  );
  const frequencySeries = points.map((point) => ({
    label: `sample ${point.sampleIndex} mode ${point.rawModeIndex}`,
    sampleIndex: point.sampleIndex,
    valueHz: point.frequencyRealHz,
  }));
  const overlapSeries = points.flatMap((point) =>
    point.overlapPrev != null
      ? [{
      label: `sample ${point.sampleIndex} mode ${point.rawModeIndex}`,
      sampleIndex: point.sampleIndex,
      value: point.overlapPrev!,
        }]
      : [],
  );

  return {
    frequencyRangeHz: minMax(frequencySeries.map((point) => point.valueHz)),
    frequencySeries,
    overlapSeries,
    sampleRange: minMax(points.map((point) => point.sampleIndex)),
  };
}

export function buildEigenBranchesModel(
  resource: FrequencyDomainJsonArtifactLike | null | undefined,
): {
  branches: EigenBranch[];
  diagnostics: string[];
  droppedBranchCount: number;
  droppedPointCount: number;
} {
  const root = record(resource?.payload);
  const branches: EigenBranch[] = [];
  const diagnostics: string[] = [];
  let droppedBranchCount = 0;
  let droppedPointCount = 0;

  array(root?.branches ?? record(root?.payload)?.branches).forEach((entry) => {
    const branch = record(entry);
    const branchIdValue = branch?.branch_id ?? branch?.branchId;
    const branchId =
      typeof branchIdValue === "number"
        ? String(branchIdValue)
        : stringValue(branchIdValue);
    if (!branchId) {
      droppedBranchCount += 1;
      return;
    }
    const points: EigenBranchPoint[] = [];
    array(branch?.points).forEach((pointEntry) => {
      const point = record(pointEntry);
      const frequencyRealHz = finiteNumber(
        point?.frequency_real_hz ?? point?.frequencyRealHz ?? point?.frequency_hz,
      );
      if (frequencyRealHz == null) {
        droppedPointCount += 1;
        return;
      }
      points.push({
        frequencyImagHz: finiteNumber(
          point?.frequency_imag_hz ?? point?.frequencyImagHz,
        ),
        frequencyRealHz,
        modeFieldId: stringValue(point?.mode_field_id ?? point?.modeFieldId),
        modeFieldResourceKey: stringValue(
          point?.mode_field_resource_key ?? point?.modeFieldResourceKey,
        ),
        overlapPrev: finiteNumber(point?.overlap_prev ?? point?.overlapPrev),
        rawModeIndex: finiteInteger(
          point?.raw_mode_index ?? point?.rawModeIndex ?? point?.mode_index,
        ),
        residualNorm: finiteNumber(point?.residual_norm ?? point?.residualNorm),
        sampleIndex: finiteInteger(point?.sample_index ?? point?.sampleIndex),
        trackingConfidence: finiteNumber(
          point?.tracking_confidence ?? point?.trackingConfidence,
        ),
      });
    });

    const overlapValues = points.flatMap((point) =>
      point.overlapPrev == null ? [] : [point.overlapPrev],
    );
    const gapSummary = branchSampleGapSummary(points);

    branches.push({
      branchId,
      frequencyMaxHz: minMax(points.map((point) => point.frequencyRealHz)).max,
      frequencyMinHz: minMax(points.map((point) => point.frequencyRealHz)).min,
      label: stringValue(branch?.label),
      overlapPrevMean:
        overlapValues.length > 0
          ? overlapValues.reduce((sum, value) => sum + value, 0) /
            overlapValues.length
          : null,
      overlapPrevMin: minMax(overlapValues).min,
      points,
      sampleGapCount: gapSummary.count,
      sampleGapMax: gapSummary.max,
      sampleMax: minMax(points.map((point) => point.sampleIndex)).max,
      sampleMin: minMax(points.map((point) => point.sampleIndex)).min,
      trackingConfidenceMin: minMax(
        points.flatMap((point) =>
          point.trackingConfidence == null ? [] : [point.trackingConfidence],
        ),
      ).min,
      warnings: gapSummary.warnings,
    });
  });

  if (resource?.status === "ready" && !root) {
    diagnostics.push("branches.v2 artifact is ready but has no JSON payload");
  }

  return { branches, diagnostics, droppedBranchCount, droppedPointCount };
}

export function buildFrequencyResponseChartModel(
  resource: FrequencyDomainJsonArtifactLike | null | undefined,
  manifestPayload?: unknown,
): FrequencyDomainChartBuildResult<FrequencyResponsePoint> {
  const dataSourceVersion = responseDataSourceVersion(resource);
  const diagnostics: string[] = [];
  const responseFieldResources = new Map(
    responseFieldResourcesFromManifest(manifestPayload).map((entry) => [
      entry.frequencyIndex,
      entry.fieldResourceId,
    ]),
  );
  const rows = responseRows(resource?.payload);
  const points: FrequencyResponsePoint[] = [];
  let droppedPointCount = 0;

  if (dataSourceVersion === "response.v2" && resource?.payload && rows.length === 0) {
    diagnostics.push("response.v2 artifact is present but contains no readable points");
  }

  rows.forEach((row, rowIndex) => {
    const item = record(row);
    const frequencyHz = finiteNumber(item?.frequency_hz ?? item?.frequencyHz);
    if (frequencyHz == null) {
      droppedPointCount += 1;
      return;
    }
    const frequencyIndex =
      finiteNumber(item?.frequency_index ?? item?.frequencyIndex) ??
      (dataSourceVersion === "response.v2" ? rowIndex : null);
    const susceptibility = susceptibilityValues(
      item?.susceptibility ?? item?.susceptibility_tensor ?? item?.susceptibilityTensor,
    );
    points.push({
      absorbedPowerDensity: finiteNumber(
        item?.absorbed_power_density ?? item?.absorbedPowerDensity,
      ),
      amplitude: finiteNumber(
        item?.amplitude ?? item?.response_amplitude ?? item?.max_response_amplitude,
      ),
      fieldId:
        (frequencyIndex == null
          ? null
          : responseFieldResources.get(frequencyIndex)) ??
        stringValue(item?.field_id ?? item?.fieldId),
      frequencyIndex,
      frequencyHz,
      observableId: stringValue(item?.observable_id ?? item?.observableId) ?? "response",
      phaseRad: finiteNumber(item?.phase_rad ?? item?.phaseRad ?? item?.response_phase),
      residualNorm: finiteNumber(item?.residual_norm ?? item?.relative_residual_norm),
      susceptibility: susceptibility.length ? susceptibility : null,
    });
  });

  const frequencyScale = frequencyChartScale(
    points.map((point) => point.frequencyHz),
  );

  return {
    dataSourceVersion,
    diagnostics,
    droppedPointCount,
    points,
    series: [
      responseSeries(
        points,
        resource,
        frequencyScale,
        "amplitude",
        "Amplitude",
        "a.u.",
        (point) => point.amplitude,
      ),
      responseSeries(
        points,
        resource,
        frequencyScale,
        "phase",
        "Phase",
        "rad",
        (point) => point.phaseRad,
      ),
      responseSeries(
        points,
        resource,
        frequencyScale,
        "absorbed-power-density",
        "Absorbed power density",
        "W/m^3",
        (point) => point.absorbedPowerDensity,
      ),
      responseSeries(
        points,
        resource,
        frequencyScale,
        "susceptibility-max-abs",
        "Max |susceptibility|",
        "a.u.",
        (point) => maxAbsSusceptibility(point.susceptibility),
      ),
    ].filter((series) => series.points.length > 0),
  };
}

export function buildFrequencyResponsePointSelectionRef(
  point: FrequencyResponsePoint,
  context: FrequencyDomainSelectionContext = {},
): SelectionRef {
  return cleanFrequencyDomainSelectionRef({
    analysisRunId: context.analysisRunId ?? undefined,
    analysisStageId: context.analysisStageId ?? undefined,
    artifactPath: context.artifactPath ?? undefined,
    calculationMode: context.calculationMode ?? "fmr_response",
    fieldId: point.fieldId ?? undefined,
    frequencyIndex: point.frequencyIndex ?? undefined,
    kind: "results.frequency_response.frequency_point",
    nodeId: context.nodeId ?? frequencyDomainResponsePointNodeId(point),
    observableId: point.observableId,
    resourceRef: context.resourceRef ?? FREQUENCY_DOMAIN_RESPONSE_SWEEP_RESOURCE_KEY,
    type: "frequency-domain",
  });
}

export function buildFmrPeakTableModel({
  responseSweep,
  spectrum,
}: {
  responseSweep?: FrequencyDomainJsonArtifactLike | null;
  spectrum?: FrequencyDomainJsonArtifactLike | null;
}): {
  diagnostics: string[];
  peaks: FmrPeakPoint[];
} {
  const diagnostics: string[] = [];
  const modal = buildEigenSpectrumChartModel(spectrum);
  const response = buildFrequencyResponseChartModel(responseSweep);
  const peaks: FmrPeakPoint[] = [
    ...modal.points.map((point) => ({
      absorbedPowerDensity: null,
      amplitude: null,
      fieldId: point.modeFieldId,
      fieldResourceKey: point.modeFieldResourceKey,
      frequencyHz: point.frequencyHz,
      frequencyPointIndex: null,
      linewidthHz: null,
      modeRef: {
        rawModeIndex: point.rawModeIndex,
        sampleIndex: point.sampleIndex,
      },
      phaseRad: null,
      source: "modal" as const,
      validationStatus: "unavailable" as const,
    })),
    ...localResponsePeaks(response.points).map((point) => ({
      absorbedPowerDensity: point.absorbedPowerDensity,
      amplitude: point.amplitude,
      fieldId: point.fieldId,
      fieldResourceKey: point.fieldId ? fieldVectorResourceKey(point.fieldId) : null,
      frequencyHz: point.frequencyHz,
      frequencyPointIndex: point.frequencyIndex,
      linewidthHz: null,
      modeRef: null,
      phaseRad: point.phaseRad,
      source: "driven_response" as const,
      validationStatus: "unavailable" as const,
    })),
  ].sort((left, right) => left.frequencyHz - right.frequencyHz);

  if (modal.droppedPointCount > 0) {
    diagnostics.push(`${modal.droppedPointCount} modal point(s) dropped`);
  }
  if (response.droppedPointCount > 0) {
    diagnostics.push(`${response.droppedPointCount} response point(s) dropped`);
  }
  diagnostics.push(...modal.diagnostics, ...response.diagnostics);

  return { diagnostics, peaks };
}

export function buildFmrModalDrivenComparisonModel({
  responseSweep,
  spectrum,
}: {
  responseSweep?: FrequencyDomainJsonArtifactLike | null;
  spectrum?: FrequencyDomainJsonArtifactLike | null;
}): FmrModalDrivenComparisonModel {
  const peakModel = buildFmrPeakTableModel({ responseSweep, spectrum });
  const modalPeaks = peakModel.peaks.filter((peak) => peak.source === "modal");
  const drivenPeaks = peakModel.peaks.filter(
    (peak) => peak.source === "driven_response",
  );

  if (modalPeaks.length === 0 || drivenPeaks.length === 0) {
    return {
      diagnostics: peakModel.diagnostics,
      nearestComparison: null,
      pairs: [],
      readiness:
        modalPeaks.length > 0
          ? "modal-only"
          : drivenPeaks.length > 0
            ? "driven-only"
            : "missing-peaks",
    };
  }

  const pairs = drivenPeaks
    .map((drivenPeak): FmrModalDrivenComparisonPoint => {
      const modalPeak = nearestPeakByFrequency(drivenPeak, modalPeaks);
      return {
        detuningHz: drivenPeak.frequencyHz - modalPeak.frequencyHz,
        drivenPeak,
        modalPeak,
      };
    })
    .sort((left, right) => Math.abs(left.detuningHz) - Math.abs(right.detuningHz));

  return {
    diagnostics: peakModel.diagnostics,
    nearestComparison: pairs[0] ?? null,
    pairs,
    readiness: "modal-and-driven",
  };
}

function cleanFrequencyDomainSelectionRef(
  ref: Extract<SelectionRef, { type: "frequency-domain" }>,
): SelectionRef {
  return Object.fromEntries(
    Object.entries(ref).filter(([, value]) => value !== undefined),
  ) as SelectionRef;
}

function localResponsePeaks(
  points: readonly FrequencyResponsePoint[],
): FrequencyResponsePoint[] {
  const byObservable = new Map<string, FrequencyResponsePoint[]>();
  for (const point of points) {
    if (point.amplitude == null && point.absorbedPowerDensity == null) continue;
    const existing = byObservable.get(point.observableId) ?? [];
    existing.push(point);
    byObservable.set(point.observableId, existing);
  }

  const peaks: FrequencyResponsePoint[] = [];
  for (const observablePoints of byObservable.values()) {
    const sorted = observablePoints.toSorted(
      (left, right) => left.frequencyHz - right.frequencyHz,
    );
    if (sorted.length === 1) {
      peaks.push(sorted[0]!);
      continue;
    }
    sorted.forEach((point, index) => {
      const value = peakMetric(point);
      const previous = sorted[index - 1] ? peakMetric(sorted[index - 1]!) : -Infinity;
      const next = sorted[index + 1] ? peakMetric(sorted[index + 1]!) : -Infinity;
      if (value >= previous && value >= next) {
        peaks.push(point);
      }
    });
  }
  return peaks;
}

function peakMetric(point: FrequencyResponsePoint): number {
  return point.amplitude ?? point.absorbedPowerDensity ?? -Infinity;
}

function nearestPeakByFrequency(
  drivenPeak: FmrPeakPoint,
  modalPeaks: readonly FmrPeakPoint[],
): FmrPeakPoint {
  return modalPeaks.reduce((best, candidate) =>
    Math.abs(candidate.frequencyHz - drivenPeak.frequencyHz) <
    Math.abs(best.frequencyHz - drivenPeak.frequencyHz)
      ? candidate
      : best,
  );
}

function frequencyDomainModeNodeId(point: EigenSpectrumPoint): string {
  return `results:eigen:sample:${point.sampleIndex}:mode:${point.rawModeIndex}`;
}

function frequencyDomainDispersionPointNodeId(point: EigenDispersionPoint): string {
  return `results:eigen:dispersion:sample:${point.sampleIndex}:mode:${point.rawModeIndex}`;
}

function frequencyDomainBranchNodeId(branch: EigenBranch): string {
  return `results:eigen:branches:branch:${branch.branchId}`;
}

function frequencyDomainBranchPointModeNodeId(point: EigenBranchPoint): string {
  return `results:eigen:sample:${point.sampleIndex}:mode:${point.rawModeIndex}`;
}

function frequencyDomainResponsePointNodeId(point: FrequencyResponsePoint): string {
  const index = point.frequencyIndex ?? Math.round(point.frequencyHz);
  return `results:frequency-response:frequency:${index}`;
}

function branchSampleGapSummary(points: readonly EigenBranchPoint[]): {
  count: number;
  max: number | null;
  warnings: string[];
} {
  const sampleIndices = Array.from(
    new Set(points.map((point) => point.sampleIndex)),
  ).sort((left, right) => left - right);
  let count = 0;
  let max: number | null = null;
  const warnings: string[] = [];

  for (let index = 1; index < sampleIndices.length; index += 1) {
    const previous = sampleIndices[index - 1]!;
    const current = sampleIndices[index]!;
    const missingSamples = current - previous - 1;
    if (missingSamples <= 0) continue;
    count += 1;
    max = max == null ? missingSamples : Math.max(max, missingSamples);
    warnings.push(`sample gap ${missingSamples} between ${previous} and ${current}`);
  }

  return { count, max, warnings };
}

function minMax(values: readonly number[]): { max: number | null; min: number | null } {
  if (values.length === 0) return { max: null, min: null };
  return {
    max: Math.max(...values),
    min: Math.min(...values),
  };
}

function spectrumRows(payload: unknown): unknown[] {
  const root = record(payload);
  const directRows = array(
    root?.modes ??
      root?.spectrum ??
      root?.rows ??
      record(root?.payload)?.modes,
  );
  if (directRows.length > 0) return directRows;
  return sampleModeRows(root?.samples ?? record(root?.payload)?.samples);
}

function sampleModeRows(samplesValue: unknown): unknown[] {
  return array(samplesValue).flatMap((sample, sampleOrdinal) => {
    const sampleRecord = record(sample);
    if (!sampleRecord) return [];
    const sampleIndex = finiteInteger(
      sampleRecord.sample_index ?? sampleRecord.sampleIndex,
      sampleOrdinal,
    );
    return array(sampleRecord.modes).flatMap((mode) => {
      const modeRecord = record(mode);
      if (!modeRecord) return [];
      return [
        {
          ...modeRecord,
          sample_index:
            modeRecord.sample_index ?? modeRecord.sampleIndex ?? sampleIndex,
        },
      ];
    });
  });
}

function responseRows(payload: unknown): unknown[] {
  const root = record(payload);
  return array(
    root?.points ??
      root?.frequencies ??
      root?.frequency_points ??
      root?.rows ??
      record(root?.payload)?.points,
  );
}

function responseDataSourceVersion(
  resource: FrequencyDomainJsonArtifactLike | null | undefined,
): "unknown" | "response.v1" | "response.v2" {
  const root = record(resource?.payload);
  const schema = stringValue(root?.schema_version);
  const artifactPath = resource?.artifact_path ?? "";
  if (schema === "magnetic_response_sweep.v2" || artifactPath.endsWith(".v2.json")) {
    return "response.v2";
  }
  if (schema === "magnetic_response_sweep.v1" || artifactPath.endsWith(".v1.json")) {
    return "response.v1";
  }
  return "unknown";
}

function parseDispersionCsv(csv: string): {
  droppedPointCount: number;
  points: EigenDispersionPoint[];
} {
  const lines: string[] = [];
  for (const line of csv.split(/\r?\n/)) {
    if (line.trim().length > 0) lines.push(line);
  }
  if (lines.length === 0) return { droppedPointCount: 0, points: [] };
  const headers = lines[0]?.split(",").map((item) => item.trim()) ?? [];
  const points: EigenDispersionPoint[] = [];
  let droppedPointCount = 0;

  for (const line of lines.slice(1)) {
    const columns = line.split(",").map((item) => item.trim());
    const row = Object.fromEntries(headers.map((header, index) => [header, columns[index]]));
    const frequencyHz = finiteNumber(row.frequency_hz ?? row.frequencyHz);
    const pathS = finiteNumber(
      row.path_s_rad_per_m ?? row.path_s ?? row.pathS ?? row.k_path_s,
    );
    if (frequencyHz == null || pathS == null) {
      droppedPointCount += 1;
      continue;
    }
    points.push({
      branchId: stringValue(row.branch_id ?? row.branchId),
      frequencyHz,
      overlap: finiteNumber(row.overlap),
      pathS,
      rawModeIndex: finiteInteger(row.raw_mode_index ?? row.mode_index),
      residualNorm: finiteNumber(row.residual_norm),
      sampleIndex: finiteInteger(row.sample_index),
    });
  }

  return { droppedPointCount, points };
}

function responseSeries(
  points: readonly FrequencyResponsePoint[],
  resource: FrequencyDomainJsonArtifactLike | null | undefined,
  frequencyScale: FrequencyChartScale,
  quantity: string,
  label: string,
  unit: string,
  selector: (point: FrequencyResponsePoint) => number | null,
): FrequencyDomainChartSeries {
  return {
    id: `analysis.frequency-domain:response:${quantity}`,
    label,
    points: points.flatMap((point, rowIndex) => {
      const y = selector(point);
      return y == null
        ? []
        : [{ rowIndex, x: point.frequencyHz / frequencyScale.divisor, y }];
    }),
    quantity,
    source: {
      kind: "analysis.frequency_domain",
      resourceKey: FREQUENCY_DOMAIN_RESPONSE_SWEEP_RESOURCE_KEY,
      tableId: "frequency-domain:response-sweep",
    },
    status: artifactStatus(resource),
    unit,
    xUnit: frequencyScale.unit,
  };
}

function maxAbsSusceptibility(values: readonly number[] | null): number | null {
  if (!values || values.length === 0) return null;
  let maxValue: number | null = null;
  for (const value of values) {
    const absValue = Math.abs(value);
    if (!Number.isFinite(absValue)) continue;
    maxValue = maxValue == null ? absValue : Math.max(maxValue, absValue);
  }
  return maxValue;
}
