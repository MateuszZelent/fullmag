"use client";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DIAGNOSTICS_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
} from "@/kernel/api/apiPaths";
import {
  useFrequencyDomainEigenBranchesResource,
  useFrequencyDomainEigenDiagnosticsResource,
  useFrequencyDomainEigenDispersionResource,
  useFrequencyDomainEigenSpectrumResource,
  useFrequencyDomainManifestResource,
  useFrequencyDomainResponseCancelRequestedResource,
  useFrequencyDomainResponseDiagnosticsResource,
  useFrequencyDomainResponseFieldMetaResource,
  useFrequencyDomainResponseFrequencyPointResource,
  useFrequencyDomainResponseProgressResource,
  useFrequencyDomainResponseSweepResource,
  useMeshPeriodicPairsResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  buildEigenBranchesModel,
  buildEigenDispersionChartModel,
  buildEigenSpectrumChartModel,
  buildFrequencyResponseChartModel,
  buildFmrPeakTableModel,
  eigenModeFieldAvailable,
  frequencyDomainManifestPayload,
  frequencyResponseSeriesUnit,
  responseFieldResourcesFromManifest,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import type { FrequencyResponsePoint } from "@/shared/domain/analysis/frequencyDomainChartModels";
import { analysisFieldViewLabel, normalizeAnalysisFieldView } from "../FrequencyDomainModeDisplayControls";
import { periodicStatusView } from "../frequencyDomainInspectorModel";
import {
  canPlotSelectedFieldIn3D,
  modeFieldComponentOptions,
  selectedField3DPlotStatus,
} from "./FrequencyDomainHelpers";
import {
  capabilityStatus,
  useFrequencyDomainRunSummary,
  frequencyDomainRuntimeCapabilities,
  useFrequencyDomainExportsSummary,
} from "./frequencyDomainEigenFmrSummaries";
import {
  frequencyDomainVisualizationReadiness,
  frequencyResponseSweepStatusSummary,
  record,
  finiteNumber,
  nonnegativeFiniteNumber,
  stringValue,
  eigenDiagnosticTransportSummary,
  responseExecutionLaneFromManifest,
  formatNumber,
  formatNumberOrUnavailable,
  formatQuantity,
  meanFinite,
  maxFinite,
  formatFrequencyRange,
  formatNumberRange,
  formatFrequency,
  normalizedAnalysisFieldViewOptions,
} from "./frequencyDomainResultFormatting";

export interface FrequencyResponsePointResidualSummary {
  absoluteL2: number | null;
  relativeL2: number | null;
  reported: number | null;
}

export function countResidualEvidencePoints(
  points: readonly {
    residualAbsoluteL2?: number | null;
    residualNorm: number | null;
    residualRelativeL2?: number | null;
  }[],
): number {
  return points.filter((point) =>
    (typeof point.residualNorm === "number" && Number.isFinite(point.residualNorm)) ||
    nonnegativeFiniteNumber(point.residualAbsoluteL2) != null ||
    nonnegativeFiniteNumber(point.residualRelativeL2) != null,
  ).length;
}

export function buildFrequencyResponsePointResidualSummary(
  payload: unknown,
  point: Pick<
    FrequencyResponsePoint,
    "residualAbsoluteL2" | "residualNorm" | "residualRelativeL2"
  > | null,
): FrequencyResponsePointResidualSummary {
  const resource = record(payload);
  return {
    absoluteL2:
      nonnegativeFiniteNumber(resource?.residual_l2_norm) ??
      nonnegativeFiniteNumber(point?.residualAbsoluteL2),
    relativeL2:
      nonnegativeFiniteNumber(resource?.relative_residual_l2_norm) ??
      nonnegativeFiniteNumber(point?.residualRelativeL2),
    reported:
      finiteNumber(resource?.residual_norm ?? resource?.relative_residual_norm) ??
      finiteNumber(point?.residualNorm),
  };
}

export function FrequencyResponsePointResidualFields({
  residuals,
}: {
  residuals: FrequencyResponsePointResidualSummary;
}) {
  return (
    <>
      <FieldRow
        label="Absolute residual (L2)"
        value={formatNumberOrUnavailable(residuals.absoluteL2)}
      />
      <FieldRow
        label="Relative residual (L2)"
        value={formatNumberOrUnavailable(residuals.relativeL2)}
      />
      <FieldRow
        label="Response residual (type unspecified)"
        value={formatNumberOrUnavailable(residuals.reported)}
      />
    </>
  );
}

export function useFrequencyResponsePointSummary({ selection }: InspectorPanelProps) {
  const ref = selection.ref?.type === "frequency-domain" ? selection.ref : null;
  const frequencyIndex = ref?.frequencyIndex ?? null;
  const manifest = useFrequencyDomainManifestResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const frequencyPoint =
    useFrequencyDomainResponseFrequencyPointResource(frequencyIndex);
  const fieldMeta = useFrequencyDomainResponseFieldMetaResource(frequencyIndex);
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    frequencyDomainManifestPayload(manifest.data),
  );
  const amplitudeUnit = frequencyResponseSeriesUnit(responseModel, "amplitude");
  const absorbedPowerDensityUnit = frequencyResponseSeriesUnit(
    responseModel,
    "absorbed-power-density",
  );
  const matchingPoints = responseModel.points.filter(
    (point) => point.frequencyIndex === frequencyIndex,
  );
  const firstPoint = matchingPoints[0] ?? null;
  const payload = record(frequencyPoint.data?.payload);
  const frequencyHz =
    finiteNumber(payload?.frequency_hz) ?? firstPoint?.frequencyHz ?? null;
  const amplitude =
    finiteNumber(payload?.response_amplitude) ??
    finiteNumber(payload?.amplitude) ??
    firstPoint?.amplitude ??
    null;
  const phase =
    finiteNumber(payload?.response_phase) ??
    finiteNumber(payload?.phase_rad) ??
    firstPoint?.phaseRad ??
    null;
  const absorbedPowerDensity =
    finiteNumber(payload?.absorbed_power_density) ??
    firstPoint?.absorbedPowerDensity ??
    null;
  const residuals = buildFrequencyResponsePointResidualSummary(payload, firstPoint);
  const fieldId =
    ref?.fieldId ?? fieldMeta.data?.field_id ?? firstPoint?.fieldId ?? null;
  const fieldResource = ref?.resourceRef ?? fieldMeta.data?.resource_key ?? null;
  const availableViews = fieldMeta.data?.available_views ?? [];
  const defaultView = fieldMeta.data?.default_view ?? availableViews[0] ?? null;
  const defaultPhaseRad =
    finiteNumber(fieldMeta.data?.default_phase_rad) ?? firstPoint?.phaseRad ?? 0;
  const absorptionProvenance = record(payload?.absorbed_power_density_provenance);
  const susceptibilityProvenance = record(payload?.susceptibility_tensor_provenance);
  const provenance = [
    stringValue(absorptionProvenance?.kind),
    stringValue(susceptibilityProvenance?.kind),
  ]
    .filter((item): item is string => item != null)
    .join("; ");

  const field3DReady =
    fieldMeta.status === "ready" && canPlotSelectedFieldIn3D(fieldMeta.data);
  const field3DStatus =
    fieldMeta.status === "ready"
      ? selectedField3DPlotStatus(fieldMeta.data)
      : fieldMeta.status === "loading"
        ? "response field metadata loading"
        : fieldMeta.status === "error"
          ? "response field metadata unavailable"
          : "response field metadata not available";

  return {
    actionBadge: field3DReady ? "3D field ready" : "3D unavailable",
    absorbedPowerDensity:
      absorbedPowerDensity == null
        ? "not available"
        : formatQuantity(absorbedPowerDensity, absorbedPowerDensityUnit),
    amplitude: formatQuantity(amplitude, amplitudeUnit),
    amplitudeUnit,
    artifactPath: frequencyPoint.data?.artifact_path ?? "not available",
    availableViews: availableViews.length ? availableViews.join(", ") : "not available",
    availableViewValues: normalizedAnalysisFieldViewOptions(
      availableViews,
      defaultView,
    ),
    badge:
      frequencyIndex == null
        ? "unselected"
        : frequencyPoint.status === "ready"
          ? `frequency ${frequencyIndex}`
          : frequencyPoint.status,
    componentBasis: fieldMeta.data?.component_basis ?? null,
    componentCount: finiteNumber(fieldMeta.data?.component_count),
    componentOptions:
      fieldMeta.status === "ready"
        ? modeFieldComponentOptions(fieldMeta.data)
        : [],
    defaultPhaseLabel: `${formatNumber(defaultPhaseRad)} rad`,
    defaultPhaseRad,
    defaultView: normalizeAnalysisFieldView(defaultView),
    defaultViewLabel: defaultView ? analysisFieldViewLabel(defaultView) : "not available",
    fieldId,
    fieldIdLabel: fieldId ?? "not available",
    fieldResource: fieldResource ?? "not available",
    field3DReady,
    fieldStatus: fieldId
      ? `${fieldId}; ${field3DStatus}`
      : "field artifact missing",
    field3DStatus,
    frequencyDisplay: formatFrequency(frequencyHz),
    frequencyIndex,
    absorbedPowerDensityUnit,
    observableRows: `${matchingPoints.length} sweep row(s)`,
    phase: phase == null ? "not available" : `${formatNumber(phase)} rad`,
    provenance: provenance || "not available",
    residuals,
    resourceKey:
      frequencyIndex == null
        ? "not available"
        : ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH.replace(
            "{frequency_index}",
            String(frequencyIndex),
          ),
    valueKind: fieldMeta.data?.value_kind ?? null,
  };
}

export function useFrequencyResponseFrequencyPointsSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const progress = useFrequencyDomainResponseProgressResource();
  const cancelRequested = useFrequencyDomainResponseCancelRequestedResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
  );
  const amplitudeUnit = frequencyResponseSeriesUnit(responseModel, "amplitude");
  const absorbedPowerDensityUnit = frequencyResponseSeriesUnit(
    responseModel,
    "absorbed-power-density",
  );
  const frequencies = responseModel.points.map((point) => point.frequencyHz);
  const amplitudes = responseModel.points.flatMap((point) =>
    point.amplitude == null ? [] : [point.amplitude],
  );
  const residuals = countResidualEvidencePoints(responseModel.points);
  const manifestFieldCount = responseFieldResourcesFromManifest(manifestPayload)
    .length;
  const sweepFieldCount = responseModel.points.filter((point) => point.fieldId)
    .length;

  return {
    amplitudeRange: formatNumberRange(amplitudes, ` ${amplitudeUnit}`),
    amplitudeUnit,
    absorbedPowerDensityUnit,
    badge:
      responseSweep.status === "ready"
        ? `${responseModel.points.length} point(s)`
        : responseSweep.status,
    cancellationState: cancelRequested.data
      ? `${cancelRequested.data.status}; ${cancelRequested.data.completed_frequency_points}/${cancelRequested.data.total_frequency_points}`
      : "not requested",
    fieldOverlays: `${manifestFieldCount} manifest field(s), ${sweepFieldCount} sweep field(s)`,
    frequencyRange: formatFrequencyRange(frequencies),
    progressState: progress.data
      ? `${progress.data.status}; ${progress.data.completed_frequency_points}/${progress.data.total_frequency_points}`
      : "not available",
    residualCoverage: `${residuals}/${responseModel.points.length} point(s)`,
    resourceKey:
      responseSweep.data?.resource_key ??
      ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    responseModel,
    solvedFrequencies: `${responseModel.points.length} point(s), ${responseModel.series.length} observable series`,
    workflow: "select frequency point -> inspect response field payload in 3D",
  };
}

export function useFrequencyResponseProgressSummary() {
  const progress = useFrequencyDomainResponseProgressResource();
  const data = progress.data;

  return frequencyResponseSweepStatusSummary({
    data,
    resourceKey: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
    status: progress.status,
  });
}

export function useFrequencyResponseCancelRequestedSummary() {
  const cancelRequested = useFrequencyDomainResponseCancelRequestedResource();
  const data = cancelRequested.data;

  return frequencyResponseSweepStatusSummary({
    data,
    resourceKey: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
    status: cancelRequested.status,
  });
}

export function useFrequencyResponseObservableSummary({ selection }: InspectorPanelProps) {
  const ref = selection.ref?.type === "frequency-domain" ? selection.ref : null;
  const manifest = useFrequencyDomainManifestResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    frequencyDomainManifestPayload(manifest.data),
  );
  const amplitudeUnit = frequencyResponseSeriesUnit(responseModel, "amplitude");
  const absorbedPowerDensityUnit = frequencyResponseSeriesUnit(
    responseModel,
    "absorbed-power-density",
  );
  const observableId = ref?.observableId ?? selection.label ?? null;
  const points = responseModel.points.filter(
    (point) => point.observableId === observableId,
  );
  const frequencies = points.map((point) => point.frequencyHz);
  const amplitudes = points.flatMap((point) =>
    point.amplitude == null ? [] : [point.amplitude],
  );
  const phases = points.flatMap((point) =>
    point.phaseRad == null ? [] : [point.phaseRad],
  );
  const absorbedPowers = points.flatMap((point) =>
    point.absorbedPowerDensity == null ? [] : [point.absorbedPowerDensity],
  );
  const fieldOverlayCount = points.filter((point) => point.fieldId).length;
  const chartSeries = responseModel.series.filter(
    (series) => series.quantity === observableId || series.id.includes(String(observableId)),
  );

  return {
    badge:
      observableId == null
        ? "unselected"
        : responseSweep.status === "ready"
          ? `${points.length} point(s)`
          : responseSweep.status,
    chartSeriesStatus: chartSeries.length
      ? `${chartSeries.length} series, ${chartSeries.map((series) => series.label).join(", ")}`
      : "not available",
    fieldOverlayStatus: `${fieldOverlayCount}/${points.length} point(s) field-ready`,
    frequencyRange: formatFrequencyRange(frequencies),
    maxAbsorbedPowerDensity: maxFinite(absorbedPowers) == null
      ? "not available"
      : formatQuantity(maxFinite(absorbedPowers)!, absorbedPowerDensityUnit),
    meanAmplitude: meanFinite(amplitudes) == null
      ? "not available"
      : formatQuantity(meanFinite(amplitudes)!, amplitudeUnit),
    observableId: observableId ?? "not selected",
    peakAmplitude: maxFinite(amplitudes) == null
      ? "not available"
      : formatQuantity(maxFinite(amplitudes)!, amplitudeUnit),
    phaseRange: formatNumberRange(phases, " rad"),
    pointCount: String(points.length),
    resourceKey:
      ref?.resourceRef ?? ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  };
}

export function useFrequencyResponseSweepSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const progress = useFrequencyDomainResponseProgressResource();
  const cancelRequested = useFrequencyDomainResponseCancelRequestedResource();
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    frequencyDomainManifestPayload(manifest.data),
  );
  const amplitudeUnit = frequencyResponseSeriesUnit(responseModel, "amplitude");
  const absorbedPowerDensityUnit = frequencyResponseSeriesUnit(
    responseModel,
    "absorbed-power-density",
  );
  const susceptibilityUnit = frequencyResponseSeriesUnit(
    responseModel,
    "susceptibility-max-abs",
  );
  const fmrPeakModel = buildFmrPeakTableModel({
    manifestPayload: frequencyDomainManifestPayload(manifest.data),
    responseSweep: responseSweep.data,
    spectrum: null,
  });
  const frequencies = responseModel.points.map((point) => point.frequencyHz);
  const phases = responseModel.points.flatMap((point) =>
    point.phaseRad == null ? [] : [point.phaseRad],
  );
  const absorbedPowers = responseModel.points.flatMap((point) =>
    point.absorbedPowerDensity == null ? [] : [point.absorbedPowerDensity],
  );
  const fieldOverlayCount = responseModel.points.filter((point) => point.fieldId).length;
  const peak = fmrPeakModel.peaks.find((item) => item.source === "driven_response");

  return {
    badge:
      responseSweep.status === "ready"
        ? `${responseModel.points.length} point(s)`
        : responseSweep.status,
    cancellationState: cancelRequested.data
      ? `${cancelRequested.data.status}; ${cancelRequested.data.completed_frequency_points}/${cancelRequested.data.total_frequency_points}`
      : "not requested",
    fieldOverlayStatus: `${fieldOverlayCount}/${responseModel.points.length} point(s) field-ready`,
    frequencyRange: formatFrequencyRange(frequencies),
    maxAbsorbedPowerDensity: maxFinite(absorbedPowers) == null
      ? "not available"
      : formatQuantity(maxFinite(absorbedPowers)!, absorbedPowerDensityUnit),
    peakResponse: peak
      ? `${formatFrequency(peak.frequencyHz)}; amplitude ${formatQuantity(peak.amplitude, amplitudeUnit)}`
      : "not available",
    pointCount: String(responseModel.points.length),
    progressState: progress.data
      ? `${progress.data.status}; ${progress.data.completed_frequency_points}/${progress.data.total_frequency_points}`
      : "not available",
    phaseCoverage: `${phases.length}/${responseModel.points.length} point(s)`,
    responseSeriesControls:
      "Amplitude, Phase, Absorbed power density, Max |susceptibility|",
    resourceKey: responseSweep.data?.resource_key ??
      ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    responseModel,
    amplitudeUnit,
    absorbedPowerDensityUnit,
    seriesStatus: responseModel.series.length
      ? `${responseModel.series.length} series: ${responseModel.series.map((series) => series.label).join(", ")}`
      : "not available",
    absorbedPowerCoverage: `${absorbedPowers.length}/${responseModel.points.length} point(s)`,
    susceptibilityComponent: `max |χ| from response tensor [${susceptibilityUnit}]`,
    susceptibilityUnit,
  };
}

export function useFrequencyResponseDiagnosticsSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const progress = useFrequencyDomainResponseProgressResource();
  const cancelRequested = useFrequencyDomainResponseCancelRequestedResource();
  const diagnostics = useFrequencyDomainResponseDiagnosticsResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const diagnosticsPayload = record(diagnostics.data?.payload);
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
  );
  const response = manifest.data?.response;
  const studyKind = response?.study_kind ?? "frequency_response";
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const responseCapabilities = record(capabilities?.response);
  const manifestFieldCount = responseFieldResourcesFromManifest(manifestPayload)
    .length;
  const sweepFieldCount = responseModel.points.filter((point) => point.fieldId)
    .length;
  const residualCount = countResidualEvidencePoints(responseModel.points);
  const krylovPreconditionerKind = stringValue(
    diagnosticsPayload?.krylov_preconditioner_kind,
  );
  const krylovPreconditionerVariant = stringValue(
    diagnosticsPayload?.krylov_preconditioner_variant,
  );

  return {
    badge:
      responseSweep.status === "ready"
        ? `${responseModel.points.length} point(s)`
        : responseSweep.status,
    cancelState: cancelRequested.data
      ? `${cancelRequested.data.status}; ${cancelRequested.data.completed_frequency_points}/${cancelRequested.data.total_frequency_points}`
      : "not requested",
    capabilitySummary: `frequency_sweep: ${capabilityStatus(responseCapabilities?.frequency_sweep)}; magnetic_cpu: ${capabilityStatus(responseCapabilities?.magnetic_cpu)}`,
    drivenAvailability: `${studyKind}: ${response?.status ?? "missing"}; driven=${String(
      response?.driven_response_available ?? false,
    )}; static_periodic=${String(
      response?.static_periodic_response_available ?? false,
    )}; gpu=${String(response?.gpu_available ?? false)}`,
    krylovPreconditioner: krylovPreconditionerVariant
      ? `${krylovPreconditionerVariant}${krylovPreconditionerKind ? ` (${krylovPreconditionerKind})` : ""}`
      : (krylovPreconditionerKind ?? "not reported"),
    residualCoverage: `${residualCount}/${responseModel.points.length} point(s)`,
    responseArtifact: responseSweep.data?.artifact_path ?? "not available",
    responseFields: `${manifestFieldCount} manifest field(s), ${sweepFieldCount} sweep field(s)`,
    sweepProgress: progress.data
      ? `${progress.data.status}; ${progress.data.completed_frequency_points}/${progress.data.total_frequency_points}`
      : "not available",
  };
}

export function useFrequencyDomainJobsSummary() {
  const runSummary = useFrequencyDomainRunSummary();
  const eigenSummary = useEigenSampleJobSummary();
  const responseSummary = useFrequencyResponseFrequencyJobSummary();
  const progress = useFrequencyDomainResponseProgressResource();
  const cancelRequested = useFrequencyDomainResponseCancelRequestedResource();
  const exportsSummary = useFrequencyDomainExportsSummary();
  const progressSummary = frequencyResponseSweepStatusSummary({
    data: progress.data,
    resourceKey: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
    status: progress.status,
  });
  const cancelSummary = frequencyResponseSweepStatusSummary({
    data: cancelRequested.data,
    resourceKey: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
    status: cancelRequested.status,
  });

  return {
    artifactExport: exportsSummary.badge,
    badge: progressSummary.runtimeState,
    cancelCheckpoint: cancelRequested.data
      ? `${cancelSummary.runtimeState}; ${cancelSummary.progress}; partial artifacts ${cancelSummary.partialArtifacts}; range ${cancelSummary.frequencyRange}; ${cancelSummary.solverProgress}`
      : "not requested",
    eigenSamples: eigenSummary.kPathSamples,
    responseFrequencies: responseSummary.frequencyWorkUnits,
    responseProgress: `${progressSummary.runtimeState}; ${progressSummary.progress}; written ${progressSummary.writtenArtifacts}; range ${progressSummary.frequencyRange}; ${progressSummary.solverProgress}`,
    stageRun: `${runSummary.stageKind}; ${runSummary.calculationMode}`,
  };
}

export function useEigenSampleJobSummary() {
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
  const eigenmodes = manifest.data?.eigenmodes;
  const modeFieldCount = spectrumModel.points.filter((point) => eigenModeFieldAvailable(point))
    .length;
  const trackedPointCount = branchesModel.branches.reduce(
    (count, branch) => count + branch.points.length,
    0,
  );

  return {
    badge:
      dispersion.status === "ready"
        ? `${dispersionModel.points.length} sample(s)`
        : dispersion.status,
    branchTracking: `${branchesModel.branches.length} branch(es), ${trackedPointCount} tracked point(s)`,
    kPathSamples: `${dispersionModel.points.length} point(s)`,
    modeFields: `${modeFieldCount} field-ready`,
    outputResources: `${ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH}; ${ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH}`,
    solverLane: `${eigenmodes?.study_kind ?? "eigenmodes"}: ${eigenmodes?.status ?? "missing"}`,
  };
}

export function useFrequencyResponseFrequencyJobSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const progress = useFrequencyDomainResponseProgressResource();
  const cancelRequested = useFrequencyDomainResponseCancelRequestedResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
  );
  const response = manifest.data?.response;
  const manifestFieldCount = responseFieldResourcesFromManifest(manifestPayload)
    .length;
  const sweepFieldCount = responseModel.points.filter((point) => point.fieldId)
    .length;
  const residualCount = countResidualEvidencePoints(responseModel.points);
  const progressSummary = frequencyResponseSweepStatusSummary({
    data: progress.data,
    resourceKey: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
    status: progress.status,
  });
  const cancelSummary = frequencyResponseSweepStatusSummary({
    data: cancelRequested.data,
    resourceKey: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
    status: cancelRequested.status,
  });

  return {
    badge:
      responseSweep.status === "ready"
        ? `${responseModel.points.length} frequency point(s)`
        : responseSweep.status,
    cancelCheckpoint: cancelRequested.data
      ? `${cancelSummary.runtimeState}; ${cancelSummary.progress}; range ${cancelSummary.frequencyRange}; ${cancelSummary.solverProgress}`
      : "not requested",
    fieldArtifacts: `${manifestFieldCount} manifest field(s), ${sweepFieldCount} sweep field(s)`,
    frequencyWorkUnits: `${responseModel.points.length} point(s), ${responseModel.series.length} observable series`,
    residualCoverage: `${residualCount}/${responseModel.points.length} point(s)`,
    solverLane: `${response?.study_kind ?? "frequency_response"}: ${response?.status ?? "missing"}`,
    sweepProgress: `${progressSummary.runtimeState}; ${progressSummary.progress}; range ${progressSummary.frequencyRange}; ${progressSummary.solverProgress}`,
    sweepResource:
      responseSweep.data?.resource_key ??
      ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  };
}

export function useFrequencyDomainDiagnosticsSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const solver = useFrequencyDomainSolverDiagnosticSummary();
  const artifacts = useFrequencyDomainExportsSummary();
  const api = useFrequencyDomainApiResourceDiagnosticSummary();
  const visualization = useFrequencyDomainVisualizationDiagnosticSummary();
  const boundaryCapabilities = record(record(manifest.data?.capabilities)?.boundary);

  return {
    apiResources: `${api.manifestEndpoint}; ${api.responseEndpoint}`,
    artifacts: artifacts.bundle,
    badge: "diagnostics",
    capabilityGates: `modal ${capabilityStatus(
      boundaryCapabilities?.floquet_modal,
    )}; response ${capabilityStatus(
      boundaryCapabilities?.floquet_response,
    )}`,
    solverState: solver.executionLane,
    visualization: `${visualization.modeOverlays}; ${visualization.responseOverlays}`,
  };
}

export function useFrequencyDomainCapabilitiesDiagnosticSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const modalCapabilities = record(capabilities?.modal);
  const responseCapabilities = record(capabilities?.response);
  const boundaryCapabilities = record(capabilities?.boundary);
  const demagCapabilities = record(capabilities?.demag);
  const visualizationCapabilities = record(capabilities?.visualization);

  return {
    badge: manifest.data?.schema_version ?? manifest.status,
    boundaryGates: `floquet_modal: ${capabilityStatus(boundaryCapabilities?.floquet_modal)}; floquet_response: ${capabilityStatus(boundaryCapabilities?.floquet_response)}`,
    demagGates: `static_periodic_pbc: ${capabilityStatus(demagCapabilities?.static_periodic_pbc)}; dynamic_demag_k: ${capabilityStatus(demagCapabilities?.floquet_dynamic_k)}`,
    drivenLane: `frequency_sweep: ${capabilityStatus(responseCapabilities?.frequency_sweep)}; magnetic_cpu: ${capabilityStatus(responseCapabilities?.magnetic_cpu)}`,
    modalLane: `reference_cpu: ${capabilityStatus(modalCapabilities?.reference_cpu)}; mode_field_payload: ${capabilityStatus(modalCapabilities?.mode_field_payload)}`,
    visualizationGates: `mode_3d_overlay: ${capabilityStatus(visualizationCapabilities?.mode_3d_overlay)}; response_field_3d_overlay: ${capabilityStatus(visualizationCapabilities?.response_field_3d_overlay)}`,
  };
}

export function useFrequencyDomainEquilibriumDiagnosticSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const response = manifest.data?.response;
  const eigenmodes = manifest.data?.eigenmodes;

  return {
    badge: stringValue(manifestPayload?.stage_kind) ?? "not available",
    modalReadiness: `${eigenmodes?.study_kind ?? "eigenmodes"}: ${eigenmodes?.status ?? "missing"}`,
    responseReadiness: `${response?.study_kind ?? "frequency_response"}: ${response?.status ?? "missing"}; static_periodic=${String(response?.static_periodic_response_available ?? false)}`,
    source: "stage://equilibrium/m0",
    stageKind: stringValue(manifestPayload?.stage_kind) ?? "not available",
    tangentContract: "m0-normalized tangent-space linearization",
  };
}

export function useFrequencyDomainOperatorDiagnosticSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const physics = record(manifestPayload?.physics);
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const boundaryCapabilities = record(capabilities?.boundary);
  const demagCapabilities = record(capabilities?.demag);

  return {
    badge: "operator",
    boundaryPolicy: `floquet_modal: ${capabilityStatus(boundaryCapabilities?.floquet_modal)}; static_periodic: ${capabilityStatus(boundaryCapabilities?.static_periodic)}`,
    demagKGate: `dynamic_demag_k: ${capabilityStatus(demagCapabilities?.floquet_dynamic_k)}`,
    normalization: stringValue(physics?.normalization) ?? "not available",
    operatorFamily: "linearized LLG tangent operator",
    phaseConvention: stringValue(physics?.phase_convention) ?? "not available",
  };
}

export function useFrequencyDomainSolverDiagnosticSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const eigenDiagnostics = useFrequencyDomainEigenDiagnosticsResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const progress = useFrequencyDomainResponseProgressResource();
  const cancelRequested = useFrequencyDomainResponseCancelRequestedResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
  );
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const responseResidualCount = countResidualEvidencePoints(responseModel.points);
  const modalResidualCount = countResidualEvidencePoints(spectrumModel.points);
  const modalDiagnostics = eigenDiagnosticTransportSummary(eigenDiagnostics.data);

  return {
    badge: responseSweep.status,
    cancelState: cancelRequested.data
      ? `${cancelRequested.data.status}; ${cancelRequested.data.completed_frequency_points}/${cancelRequested.data.total_frequency_points}`
      : "not requested",
    executionLane: responseExecutionLaneFromManifest(manifest.data?.response),
    modalTransport: `${modalDiagnostics.solverModel}; ${modalDiagnostics.transport}`,
    modalResiduals: `${modalResidualCount}/${spectrumModel.points.length} mode(s)`,
    productionCpuGate: modalDiagnostics.productionCpuGate,
    progress: progress.data
      ? `${progress.data.status}; ${progress.data.completed_frequency_points}/${progress.data.total_frequency_points}`
      : "not available",
    responseResiduals: `${responseResidualCount}/${responseModel.points.length} point(s)`,
  };
}

export function useFrequencyDomainApiResourceDiagnosticSummary() {
  return {
    badge: "resource-first",
    eigenDiagnosticsEndpoint: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DIAGNOSTICS_V2_PATH,
    fieldEndpoint: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH,
    manifestEndpoint: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    progressEndpoint: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
    responseEndpoint: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    spectrumEndpoint: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  };
}

export function useFrequencyDomainVisualizationDiagnosticSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
  );
  const responseFieldCount =
    responseFieldResourcesFromManifest(manifestPayload).length ||
    responseModel.points.filter((point) => point.fieldId).length;
  const modeFieldCount = spectrumModel.points.filter((point) => eigenModeFieldAvailable(point))
    .length;

  return {
    animation: "phase-rotated real, real, imag, abs, phase animation",
    badge: frequencyDomainVisualizationReadiness({
      modeFieldCount,
      responseFieldCount,
    }),
    chartReadiness: `${spectrumModel.series.length} modal series, ${responseModel.series.length} response series`,
    modeOverlays: `${modeFieldCount} mode field payload(s)`,
    responseOverlays: `${responseFieldCount} response field artifact(s)`,
    viewportHandoff: "selection -> command registry -> unified viewport field",
  };
}

export function useFrequencyDomainPeriodicPairsSummary() {
  const periodicPairs = useMeshPeriodicPairsResource();
  const pairs = periodicPairs.data?.pairs ?? [];
  const representativePair = pairs[0] ?? null;
  const invalidCount = pairs.filter((pair) => pair.status !== "ready").length;
  const maxResidual = pairs.reduce<number | null>((current, pair) => {
    const residual = finiteNumber(pair.max_residual_m);
    if (residual == null) return current;
    return current == null ? residual : Math.max(current, residual);
  }, null);

  return {
    badge: periodicPairs.data
      ? periodicStatusView(periodicPairs.data.status).label
      : periodicPairs.status,
    invalidPairs: String(invalidCount),
    maxResidual:
      maxResidual == null ? "not available" : `${formatNumber(maxResidual)} m`,
    pairCount: `${pairs.length} pair(s)`,
    representativePair: representativePair
      ? `${representativePair.pair_id}; markers ${representativePair.marker_a}/${representativePair.marker_b}`
      : "not available",
  };
}

export function useFrequencyDomainPeriodicFloquetSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const periodicPairs = useFrequencyDomainPeriodicPairsSummary();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const spinWaveBc = record(manifestPayload?.spin_wave_bc);
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const boundaryCapabilities = record(capabilities?.boundary);
  const demagCapabilities = record(capabilities?.demag);

  return {
    badge: manifest.data?.floquet_nonzero_k_demag_supported
      ? "demag-k supported"
      : "demag-k rejected",
    dynamicDemagK: capabilityStatus(demagCapabilities?.floquet_dynamic_k),
    floquetGate: `modal ${capabilityStatus(boundaryCapabilities?.floquet_modal)}; response ${capabilityStatus(boundaryCapabilities?.floquet_response)}`,
    meshResidual: periodicPairs.maxResidual,
    periodicPairs: periodicPairs.pairCount,
    phaseConvention:
      stringValue(spinWaveBc?.phase_convention) ?? "exp(-i k dot delta_r)",
  };
}
