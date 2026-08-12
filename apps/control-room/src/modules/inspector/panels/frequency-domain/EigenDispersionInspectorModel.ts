"use client";

import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
} from "@/kernel/api/apiPaths";
import {
  useFrequencyDomainEigenBranchesResource,
  useFrequencyDomainEigenDispersionResource,
  useFrequencyDomainEigenSpectrumResource,
  useFrequencyDomainManifestResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  buildEigenBranchesModel,
  buildEigenDispersionChartModel,
  buildEigenSpectrumChartModel,
  frequencyDomainManifestPayload,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import type { EigenDispersionPoint } from "@/shared/domain/analysis/frequencyDomainChartModels";
import { formatFrequencyHz, formatFrequencyRangeHz } from "@/shared/domain/analysis/frequencyUnits";

export interface EigenDispersionPointViewModel {
  branchId: string;
  fieldAvailable: boolean;
  frequencyHz: number;
  kLabel: string | null;
  linewidthHz: number | null;
  pathCoordinate: number;
  pathUnit: "rad/m";
  pointId: string;
}

export function buildEigenDispersionPointViewModel(
  point: EigenDispersionPoint,
): EigenDispersionPointViewModel {
  return {
    branchId: point.branchId ?? "unassigned",
    fieldAvailable: Boolean(point.modeFieldId ?? point.modeFieldResourceKey),
    frequencyHz: point.frequencyHz,
    kLabel: point.sampleLabel ?? null,
    linewidthHz: point.linewidthHz,
    pathCoordinate: point.pathS,
    pathUnit: "rad/m",
    pointId: `results:eigen:dispersion:sample:${point.sampleIndex}:mode:${point.rawModeIndex}`,
  };
}

export function useEigenDispersionInspectorSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const branches = useFrequencyDomainEigenBranchesResource();
  const dispersion = useFrequencyDomainEigenDispersionResource();
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const branchesModel = buildEigenBranchesModel(branches.data);
  const dispersionModel = buildEigenDispersionChartModel(
    dispersion.data,
    branchesModel,
  );
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const dispersionCapabilities = record(capabilities?.dispersion);
  const boundaryCapabilities = record(capabilities?.boundary);
  const frequencies = dispersionModel.points.map((point) => point.frequencyHz);
  const pathValues = dispersionModel.points.map((point) => point.pathS);
  const primaryBranch = branchesModel.branches[0] ?? null;
  const trackedPointCount = branchesModel.branches.reduce(
    (count, branch) => count + branch.points.length,
    0,
  );
  const pathMetadata = dispersionPathMetadataSummary(
    dispersion.data?.path_metadata,
  );

  return {
    analyticReference: dispersionAnalyticReferenceSummary(dispersionModel.points),
    badge:
      dispersion.status === "ready"
        ? `${dispersionModel.points.length} point(s)`
        : dispersion.status,
    branchCount: branchesModel.branches.length,
    branchesModel,
    capabilitySummary: dispersionCapabilitySummary(dispersionCapabilities),
    dispersionModel,
    dispersionPointCount: dispersionModel.points.length,
    dispersionResource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
    dispersionSeriesCount: dispersionModel.series.length,
    floquetGate: `modal ${capabilityStatus(boundaryCapabilities?.floquet_modal)}; response ${capabilityStatus(boundaryCapabilities?.floquet_response)}`,
    frequencyRange: formatFrequencyRange(frequencies),
    kPathSpan: `${formatNumberRange(pathValues)} rad/m`,
    modalOverlays: `${spectrumModel.points.filter((point) => point.modeFieldId).length} mode field(s) available from modal spectrum`,
    pathLabels: pathMetadata.labels,
    pathMetadataArtifact: pathMetadata.artifact,
    pathSampling: pathMetadata.sampling,
    primaryBranch: primaryBranch
      ? `${primaryBranch.label ?? primaryBranch.branchId}; ${formatFrequencyRange(
          primaryBranch.points.map((point) => point.frequencyRealHz),
        )}`
      : "not available",
    trackedPointCount,
    validationIntent: dispersionValidationIntentSummary(manifestPayload),
  };
}

function dispersionAnalyticReferenceSummary(
  points: readonly EigenDispersionPoint[],
): string {
  const analyticPoints = points.filter(
    (point) => point.analyticFrequencyHz != null,
  );
  if (analyticPoints.length === 0) return "not available";
  const geometries = [
    ...new Set(
      analyticPoints.flatMap((point) =>
        point.validationGeometry == null ? [] : [point.validationGeometry],
      ),
    ),
  ].sort();
  const relativeErrors = analyticPoints.flatMap((point) =>
    point.relativeError == null ? [] : [point.relativeError],
  );
  const maxRelativeError = maxFinite(relativeErrors);
  const geometrySummary = geometries.length > 0 ? geometries.join(", ") : "unlabelled";
  const errorSummary =
    maxRelativeError == null
      ? "max error not available"
      : `max rel. error ${formatNumber(maxRelativeError)}`;
  return `${analyticPoints.length} point(s); ${geometrySummary}; ${errorSummary}`;
}

function dispersionValidationIntentSummary(
  manifestPayload: Record<string, unknown> | null,
): string {
  const validation = record(manifestPayload?.validation);
  const dispersionValidation = record(validation?.dispersion_validation);
  if (!dispersionValidation) return "not available";
  const kind = stringValue(dispersionValidation.kind) ?? "unknown";
  const analyticModel =
    stringValue(dispersionValidation.analytic_model) ?? "unknown";
  const maxK = finiteNumber(dispersionValidation.max_k_rad_per_m);
  const frequencyWindow = record(dispersionValidation.frequency_window_hz);
  const frequencyMin = finiteNumber(frequencyWindow?.min);
  const frequencyMax = finiteNumber(frequencyWindow?.max);
  const scenarios = Array.isArray(dispersionValidation.scenarios)
    ? dispersionValidation.scenarios
    : [];
  const scenarioSummary = scenarios
    .flatMap((scenario) => {
      const scenarioRecord = record(scenario);
      if (!scenarioRecord) return [];
      const geometry = stringValue(scenarioRecord.geometry) ?? "unknown";
      const branchId = stringValue(scenarioRecord.branch_id) ?? "unlabelled";
      const sampleIndices = Array.isArray(scenarioRecord.sample_indices)
        ? scenarioRecord.sample_indices.length
        : 0;
      return [`${geometry}: ${branchId} [${sampleIndices} sample(s)]`];
    })
    .sort()
    .join(", ");
  const maxKSummary =
    maxK == null
      ? "k<=not available"
      : `k<=${formatWaveVectorLimit(maxK)} rad/m`;
  const frequencySummary =
    frequencyMin == null || frequencyMax == null
      ? "frequency window not available"
      : formatValidationFrequencyWindow(frequencyMin, frequencyMax);
  return [
    kind,
    analyticModel,
    maxKSummary,
    frequencySummary,
    scenarioSummary || "scenarios not available",
  ].join("; ");
}

function formatWaveVectorLimit(value: number): string {
  return value >= 1.0e5 ? value.toExponential(3) : formatNumber(value);
}

function formatValidationFrequencyWindow(minHz: number, maxHz: number): string {
  if (minHz === 0) return `0-${formatFrequency(maxHz)}`;
  return `${formatFrequency(minHz)}-${formatFrequency(maxHz)}`;
}

function dispersionPathMetadataSummary(pathMetadata: unknown): {
  artifact: string;
  labels: string;
  sampling: string;
} {
  const metadata = record(pathMetadata);
  const sampling = record(metadata?.sampling);
  if (!sampling) {
    return {
      artifact: "not available",
      labels: "not available",
      sampling: "not available",
    };
  }

  const points = Array.isArray(sampling.points) ? sampling.points : [];
  const labels = points
    .map((point) => stringValue(record(point)?.label))
    .filter((label): label is string => Boolean(label));
  const samplesPerSegment = Array.isArray(sampling.samples_per_segment)
    ? sampling.samples_per_segment
        .map((sample) => finiteNumber(sample))
        .filter((sample): sample is number => sample != null)
    : [];
  const segmentCount =
    samplesPerSegment.length > 0
      ? samplesPerSegment.length
      : Math.max(0, points.length - 1);
  const sampleCount =
    samplesPerSegment.length > 0
      ? samplesPerSegment.reduce((sum, sample) => sum + sample, 1)
      : null;
  const kind = stringValue(sampling.kind) ?? "path";
  const closure = sampling.closed === true ? "closed" : "open";

  return {
    artifact: "eigen/dispersion/path.json",
    labels: labels.length > 0 ? labels.join(" -> ") : "not available",
    sampling: `${kind}; ${segmentCount} segment(s), ${formatNullableNumber(sampleCount)} sample(s), ${closure}`,
  };
}

function dispersionCapabilitySummary(
  capabilities: Record<string, unknown> | null,
): string {
  return [
    `reference_cpu: ${capabilityStatus(capabilities?.reference_cpu)}`,
    `production_cpu: ${capabilityStatus(capabilities?.production_cpu)}`,
    `production_cpu_gamma_k_path: ${capabilityStatus(capabilities?.production_cpu_gamma_k_path)}`,
    `production_gpu: ${capabilityStatus(capabilities?.production_gpu)}`,
    `k_path: ${capabilityStatus(capabilities?.k_path)}`,
    `branch_tracking: ${capabilityStatus(capabilities?.branch_tracking)}`,
  ].join("; ");
}

function frequencyDomainRuntimeCapabilities(
  manifest: unknown,
): Record<string, unknown> | null {
  const manifestRecord = record(manifest);
  const resultManifest = record(manifestRecord?.result_manifest);
  const payload = record(resultManifest?.payload);
  const manifestCapabilities = record(manifestRecord?.capabilities);
  const runtimeCapabilities = record(payload?.capabilities);

  if (manifestCapabilities && runtimeCapabilities) {
    return { ...manifestCapabilities, ...runtimeCapabilities };
  }

  return runtimeCapabilities ?? manifestCapabilities;
}

function capabilityStatus(value: unknown): string {
  const status = record(value)?.status;
  return typeof status === "string" && status.trim()
    ? status
    : "not available";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function formatNullableNumber(value: number | null): string {
  return value == null ? "not available" : formatNumber(value);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toPrecision(4);
}

function formatFrequencyRange(valuesHz: readonly number[]): string {
  return formatFrequencyRangeHz(valuesHz);
}

function formatFrequency(valueHz: number | null | undefined): string {
  return formatFrequencyHz(valueHz);
}

function formatNumberRange(values: readonly number[], unit = ""): string {
  if (!values.length) return "not available";
  return `${formatNumber(Math.min(...values))}-${formatNumber(Math.max(...values))}${unit}`;
}

function maxFinite(values: readonly number[]): number | null {
  if (!values.length) return null;
  return Math.max(...values);
}
