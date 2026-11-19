"use client";

import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
} from "@/kernel/api/apiPaths";
import {
  useFrequencyDomainEigenBranchesResource,
  useFrequencyDomainEigenDiagnosticsResource,
  useFrequencyDomainEigenDispersionResource,
  useFrequencyDomainEigenSpectrumResource,
  useFrequencyDomainManifestResource,
  useFrequencyDomainResponseCancelRequestedResource,
  useFrequencyDomainResponseProgressResource,
  useFrequencyDomainResponseSweepResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  buildEigenBranchesModel,
  buildEigenDispersionChartModel,
  buildEigenSpectrumChartModel,
  buildFrequencyResponseChartModel,
  buildFmrModalDrivenComparisonModel,
  buildFmrPeakTableModel,
  eigenModeFieldAvailable,
  frequencyDomainManifestPayload,
  frequencyResponseSeriesUnit,
  responseFieldResourcesFromManifest,
  routeFrequencyDomainCalculationMode,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import type { EigenDispersionPoint } from "@/shared/domain/analysis/frequencyDomainChartModels";
import { buildFrequencyDomainCalculationModeRows } from "../frequencyDomainInspectorModel";
import {
  missingValueSummary,
  record,
  finiteNumber,
  stringValue,
  eigenDiagnosticTransportSummary,
  formatNullableNumber,
  responseExecutionLaneFromManifest,
  requestedMagnetostaticBc,
  formatSpinWaveBc,
  formatNumber,
  formatNumberOrUnavailable,
  formatQuantity,
  formatCompactNumberOrUnavailable,
  maxFinite,
  formatFrequencyRange,
  formatNumberRange,
  formatFrequency,
} from "./frequencyDomainResultFormatting";

export function useFmrResultSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
  );
  const amplitudeUnit = frequencyResponseSeriesUnit(responseModel, "amplitude");
  const absorbedPowerDensityUnit = frequencyResponseSeriesUnit(
    responseModel,
    "absorbed-power-density",
  );
  const peakModel = buildFmrPeakTableModel({
    manifestPayload,
    responseSweep: responseSweep.data,
    spectrum: spectrum.data,
  });
  const comparisonModel = buildFmrModalDrivenComparisonModel({
    manifestPayload,
    responseSweep: responseSweep.data,
    spectrum: spectrum.data,
  });
  const chartRoute = routeFrequencyDomainCalculationMode(manifestPayload);
  const responseFieldCount =
    responseFieldResourcesFromManifest(manifestPayload).length ||
    responseModel.points.filter((point) => point.fieldId).length;
  const modalFieldCount = spectrumModel.points.filter(
    (point) => eigenModeFieldAvailable(point),
  ).length;
  const modalResidualCount = spectrumModel.points.filter(
    (point) => point.residualNorm != null,
  ).length;
  const modalDampingCount = spectrumModel.points.filter(
    (point) => point.dampingRateHz != null || point.imaginaryFrequencyHz != null,
  ).length;
  const firstModalPoint = spectrumModel.points[0] ?? null;
  const modalPeakCount = peakModel.peaks.filter(
    (peak) => peak.source === "modal",
  ).length;
  const drivenPeakCount = peakModel.peaks.filter(
    (peak) => peak.source === "driven_response",
  ).length;
  const peakFieldCount = peakModel.peaks.filter((peak) => peak.fieldId).length;
  const qualityFactorCount = peakModel.peaks.filter(
    (peak) =>
      peak.linewidthHz != null &&
      peak.linewidthHz > 0 &&
      Number.isFinite(peak.linewidthHz),
  ).length;
  const firstPeak = peakModel.peaks[0] ?? null;
  const nearestComparison = comparisonModel.nearestComparison;
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const modalCapabilities = record(capabilities?.modal);
  const responseCapabilities = record(capabilities?.response);
  const modalReferenceCpu = capabilityStatus(modalCapabilities?.reference_cpu);
  const responseMagneticCpu = capabilityStatus(responseCapabilities?.magnetic_cpu);
  const spectrumResource = ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH;
  const responseResource = ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH;

  return {
    activeChartRoute: `${chartRoute.mode} -> ${chartRoute.primaryChart}`,
    amplitudeUnit,
    absorbedPowerDensityUnit,
    capabilitySummary: `reference_cpu: ${modalReferenceCpu}; magnetic_cpu: ${responseMagneticCpu}`,
    comparisonPairs: comparisonModel.pairs,
    comparisonState:
      modalPeakCount > 0 && drivenPeakCount > 0
        ? "modal and driven peaks available"
        : modalPeakCount > 0
          ? "modal-only FMR"
          : drivenPeakCount > 0
            ? "driven-only FMR"
            : "no peaks available",
    detuningSummary: nearestComparison
      ? `${formatFrequency(nearestComparison.detuningHz)} driven-modal; modal ${formatFrequency(nearestComparison.modalPeak.frequencyHz)}, driven ${formatFrequency(nearestComparison.drivenPeak.frequencyHz)}`
      : comparisonModel.readiness === "modal-only"
        ? "driven response missing"
        : comparisonModel.readiness === "driven-only"
          ? "modal spectrum missing"
          : "not available",
    drivenPeakCount,
    firstPeakLabel: firstPeak
      ? `${firstPeak.source}, ${formatFrequency(firstPeak.frequencyHz)}`
      : "not available",
    modalBadge:
      spectrum.status === "ready"
        ? `${spectrumModel.points.length} mode(s)`
        : spectrum.status,
    modalDampingCoverage: `${modalDampingCount}/${spectrumModel.points.length} mode(s)`,
    modalFieldCount,
    modalFrequencyRange: formatFrequencyRange(
      spectrumModel.points.map((point) => point.frequencyHz),
    ),
    modalModeCount: spectrumModel.points.length,
    modalPeakCount,
    modalChartRoute: "fmr_modal -> eigen-spectrum",
    modalResidualCoverage: `${modalResidualCount}/${spectrumModel.points.length} mode(s)`,
    peakBadge: `${peakModel.peaks.length} peak(s)`,
    peakCount: peakModel.peaks.length,
    peakFieldCount,
    peaks: peakModel.peaks,
    linkedFieldHandoff: `${peakFieldCount}/${peakModel.peaks.length} peak(s) have 3D field payloads`,
    primaryModalResonance: firstModalPoint
      ? `mode ${firstModalPoint.rawModeIndex} at ${formatFrequency(firstModalPoint.frequencyHz)}`
      : "not available",
    qualityFactorCoverage: `${qualityFactorCount}/${peakModel.peaks.length} peak(s)`,
    responseBadge:
      responseSweep.status === "ready"
        ? `${responseModel.points.length} point(s)`
        : responseSweep.status,
    responseFieldCount,
    responseLinkedPointCount: responseModel.points.filter((point) => point.fieldId)
      .length,
    responseModel,
    responsePointCount: responseModel.points.length,
    responseResource,
    responseSeriesCount: responseModel.series.length,
    resources: `${spectrumResource}; ${responseResource}`,
    spectrumResource,
    spectrumModel,
    workflowMode: chartRoute.mode,
  };
}

export function useFrequencyDomainOverviewSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
  );
  const peakModel = buildFmrPeakTableModel({
    manifestPayload,
    responseSweep: responseSweep.data,
    spectrum: spectrum.data,
  });
  const chartRoute = routeFrequencyDomainCalculationMode(manifestPayload);
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const modalCapabilities = record(capabilities?.modal);
  const responseCapabilities = record(capabilities?.response);
  const responseFieldCount =
    responseFieldResourcesFromManifest(manifestPayload).length ||
    responseModel.points.filter((point) => point.fieldId).length;
  const modalFieldCount = spectrumModel.points.filter(
    (point) => eigenModeFieldAvailable(point),
  ).length;
  const frequencyValues = [
    ...spectrumModel.points.map((point) => point.frequencyHz),
    ...responseModel.points.map((point) => point.frequencyHz),
  ];

  return {
    badge: chartRoute.mode,
    capabilitySummary: `reference_cpu: ${capabilityStatus(modalCapabilities?.reference_cpu)}; magnetic_cpu: ${capabilityStatus(responseCapabilities?.magnetic_cpu)}`,
    drivenVisualization: `${responseFieldCount} response field artifact(s)`,
    fmrReadiness: `${spectrumModel.points.length} modal mode(s), ${responseModel.points.length} driven point(s), ${peakModel.peaks.length} peak(s)`,
    frequencyCoverage: formatFrequencyRange(frequencyValues),
    modalVisualization: `${modalFieldCount} mode field payload(s)`,
    nextAction:
      peakModel.peaks.length > 0 || spectrumModel.points.length > 0
        ? "open FMR peaks or mode browser"
        : "run eigenmodes or frequency response stage",
    primaryWorkflow: `${chartRoute.mode} -> ${chartRoute.primaryChart}`,
    resources: `${ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH}; ${ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH}`,
  };
}

export function useFrequencyDomainResourceFamilySummary() {
  const exportsSummary = useFrequencyDomainExportsSummary();

  return {
    availableResources:
      "modal spectrum, branches, dispersion, response sweep, progress, fields",
    drivenArtifacts: exportsSummary.drivenSweep,
    fieldPayloads: exportsSummary.fieldPayloads,
    manifestResource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    modalArtifacts: `${exportsSummary.modalSpectrum}; ${exportsSummary.modalBranches}`,
  };
}

export function useFrequencyDomainManifestResourceSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const physics = record(manifestPayload?.physics);

  return {
    artifact: manifest.data?.result_manifest?.artifact_path ?? "not available",
    physicsContract: [
      stringValue(physics?.normalization) ?? "not available",
      stringValue(physics?.phase_convention) ?? "not available",
      stringValue(physics?.frequency_units) ?? "not available",
    ].join("; "),
    resourceEndpoint: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    schema: manifest.data?.schema_version ?? "not available",
    stageKind: stringValue(manifestPayload?.stage_kind) ?? "not available",
  };
}

export function useEigenOverviewSummary() {
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
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const dispersionCapabilities = record(capabilities?.dispersion);
  const modalFieldCount = spectrumModel.points.filter(
    (point) => eigenModeFieldAvailable(point),
  ).length;
  const trackedPointCount = branchesModel.branches.reduce(
    (count, branch) => count + branch.points.length,
    0,
  );

  return {
    badge:
      spectrum.status === "ready"
        ? `${spectrumModel.points.length} mode(s)`
        : spectrum.status,
    branches: `${branchesModel.branches.length} branch(es), ${trackedPointCount} tracked point(s)`,
    capabilitySummary: dispersionCapabilitySummary(dispersionCapabilities),
    dispersion: `${dispersionModel.points.length} k-path point(s), ${branchesModel.branches.length} branch(es)`,
    frequencyCoverage: formatFrequencyRange(
      spectrumModel.points.map((point) => point.frequencyHz),
    ),
    handoff: "select mode or branch point -> plot mode field",
    spectrum: `${spectrumModel.points.length} mode(s), ${modalFieldCount} field payload(s)`,
  };
}

export function useEigenStudySummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const branches = useFrequencyDomainEigenBranchesResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const physics = record(manifestPayload?.physics);
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const boundaryCapabilities = record(capabilities?.boundary);
  const eigenmodes = manifest.data?.eigenmodes;
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const modeFieldCount = spectrumModel.points.filter((point) => eigenModeFieldAvailable(point))
    .length;

  return {
    artifacts: [
      spectrum.data?.artifact_path,
      branches.data?.artifact_path,
    ]
      .filter((item): item is string => Boolean(item))
      .join("; ") || "not available",
    badge: eigenmodes?.status ?? "missing",
    boundarySupport: `floquet_modal: ${capabilityStatus(boundaryCapabilities?.floquet_modal)}; static_periodic: ${capabilityStatus(boundaryCapabilities?.static_periodic)}`,
    modeFields: `${modeFieldCount} mode field artifact(s)`,
    operatorLane: "linearized LLG modal operator",
    physicsContract: [
      stringValue(physics?.normalization) ?? "not available",
      stringValue(physics?.phase_convention) ?? "not available",
      stringValue(physics?.frequency_units) ?? "not available",
    ].join("; "),
    studyKind: `${eigenmodes?.study_kind ?? "eigenmodes"}: ${eigenmodes?.status ?? "missing"}`,
  };
}

export function useFrequencyResponseOverviewSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const progress = useFrequencyDomainResponseProgressResource();
  const cancelRequested = useFrequencyDomainResponseCancelRequestedResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
  );
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const responseCapabilities = record(capabilities?.response);
  const responseFieldCount =
    responseFieldResourcesFromManifest(manifestPayload).length ||
    responseModel.points.filter((point) => point.fieldId).length;

  return {
    badge:
      responseSweep.status === "ready"
        ? `${responseModel.points.length} point(s)`
        : responseSweep.status,
    cancellation: cancelRequested.data
      ? `${cancelRequested.data.status}; ${cancelRequested.data.completed_frequency_points}/${cancelRequested.data.total_frequency_points}`
      : "not requested",
    capabilitySummary: `frequency_sweep: ${capabilityStatus(responseCapabilities?.frequency_sweep)}; magnetic_cpu: ${capabilityStatus(responseCapabilities?.magnetic_cpu)}`,
    frequencyCoverage: formatFrequencyRange(
      responseModel.points.map((point) => point.frequencyHz),
    ),
    handoff: "select frequency point -> plot response field",
    progress: progress.data
      ? `${progress.data.status}; ${progress.data.completed_frequency_points}/${progress.data.total_frequency_points}`
      : "not available",
    responseFields: `${responseFieldCount} response field artifact(s)`,
    sweep: `${responseModel.points.length} point(s), ${responseModel.series.length} observable series`,
  };
}

export function useFrequencyResponseStudySummary() {
  const manifest = useFrequencyDomainManifestResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const physics = record(manifestPayload?.physics);
  const response = manifest.data?.response;
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
  );

  return {
    artifacts: responseSweep.data?.artifact_path ?? "not available",
    badge: response?.status ?? "missing",
    boundarySupport: `static_periodic=${String(
      response?.static_periodic_response_available ?? false,
    )}; floquet_response=${String(response?.floquet_response_available ?? false)}`,
    executionLane: responseExecutionLaneFromManifest(response),
    magnetostaticBc: requestedMagnetostaticBc(manifestPayload),
    physicsContract: [
      stringValue(physics?.normalization) ?? "not available",
      stringValue(physics?.phase_convention) ?? "not available",
      stringValue(physics?.frequency_units) ?? "not available",
    ].join("; "),
    spinWaveBc: formatSpinWaveBc(manifestPayload),
    studyKind: `${response?.study_kind ?? "frequency_response"}: ${response?.status ?? "missing"}`,
    sweepContract: `${responseModel.points.length} solved point(s), ${responseModel.series.length} observable series`,
  };
}

export function capabilityStatus(value: unknown): string {
  const status = record(value)?.status;
  return typeof status === "string" && status.trim()
    ? status
    : "not available";
}

export function useFrequencyDomainRunSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const requestedExecution = record(manifestPayload?.requested_execution);
  const physics = record(manifestPayload?.physics);
  const response = manifest.data?.response;
  const eigenmodes = manifest.data?.eigenmodes;
  const responseStudyKind = response?.study_kind ?? "frequency_response";
  const eigenStudyKind = eigenmodes?.study_kind ?? "eigenmodes";

  return {
    badge:
      manifest.status === "ready"
        ? (manifest.data?.schema_version ?? "ready")
        : manifest.status,
    calculationMode:
      stringValue(requestedExecution?.calculation_mode) ?? "not available",
    eigenLane: `${eigenStudyKind}: ${eigenmodes?.status ?? "missing"}; modal=${String(
      eigenmodes?.modal_solver_available ?? false,
    )}; gpu=${String(eigenmodes?.gpu_available ?? false)}`,
    eigenNamespace: manifest.data?.eigen_namespace ?? "not available",
    familyNamespace: manifest.data?.family_namespace ?? "not available",
    manifestArtifact:
      manifest.data?.result_manifest?.artifact_path ?? "not available",
    manifestResource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    namespaceCompatibility: `existing frequency_response namespace preserved=${String(
      manifest.data?.existing_frequency_response_namespace_preserved ?? false,
    )}`,
    physicsContract: [
      stringValue(physics?.normalization) ?? "not available",
      stringValue(physics?.phase_convention) ?? "not available",
      stringValue(physics?.frequency_units) ?? "not available",
      stringValue(physics?.field_units) ?? "not available",
    ].join("; "),
    responseLane: `${responseStudyKind}: ${response?.status ?? "missing"}; driven=${String(
      response?.driven_response_available ?? false,
    )}; static_periodic=${String(
      response?.static_periodic_response_available ?? false,
    )}; gpu=${String(response?.gpu_available ?? false)}`,
    stageKind: stringValue(manifestPayload?.stage_kind) ?? "not available",
  };
}

export function useFmrComparisonSummary() {
  const summary = useFmrResultSummary();
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const comparisonModel = buildFmrModalDrivenComparisonModel({
    manifestPayload: frequencyDomainManifestPayload(manifest.data),
    responseSweep: responseSweep.data,
    spectrum: spectrum.data,
  });
  const nearestComparison = comparisonModel.nearestComparison;
  const modalPeak = nearestComparison?.modalPeak ?? null;
  const drivenPeak = nearestComparison?.drivenPeak ?? null;
  const frequencyOffset = nearestComparison?.detuningHz ?? null;
  const amplitudeRatio =
    modalPeak?.amplitude != null &&
    drivenPeak?.amplitude != null &&
    modalPeak.amplitude !== 0
      ? drivenPeak.amplitude / modalPeak.amplitude
      : null;

  return {
    actionBadge:
      modalPeak?.fieldId && drivenPeak?.fieldId
        ? "both fields ready"
        : modalPeak?.fieldId
          ? "modal field ready"
          : drivenPeak?.fieldId
            ? "driven field ready"
            : "fields missing",
    amplitudeRatio:
      amplitudeRatio == null
        ? "not available"
        : `${formatNumber(amplitudeRatio)} driven/modal`,
    badge:
      modalPeak && drivenPeak
        ? "ready"
        : modalPeak
          ? "modal-only"
          : drivenPeak
            ? "driven-only"
            : "missing peaks",
    drivenOverlay: drivenPeak?.fieldId
      ? `${drivenPeak.fieldId}; response field ready`
      : drivenPeak
        ? "driven peak field missing"
        : "no driven peak selected",
    drivenActionTarget: drivenPeak
      ? `driven response ${formatFrequency(drivenPeak.frequencyHz)}`
      : "not available",
    drivenPeakPoint: drivenPeak,
    drivenPeak: drivenPeak
      ? `${formatFrequency(drivenPeak.frequencyHz)}; amplitude ${formatNumberOrUnavailable(drivenPeak.amplitude)}`
      : "not available",
    frequencyOffset:
      frequencyOffset == null
        ? "not available"
        : `${formatNumber(frequencyOffset)} Hz (${formatFrequency(frequencyOffset)})`,
    modalOverlay: modalPeak?.fieldId
      ? `${modalPeak.fieldId}; mode field ready`
      : `${summary.modalFieldCount} mode field artifact(s)`,
    modalActionTarget: modalPeak
      ? `modal mode ${modalPeak.modeRef?.rawModeIndex ?? "?"} ${formatFrequency(modalPeak.frequencyHz)}`
      : "not available",
    modalPeakPoint: modalPeak,
    modalResonance: modalPeak
      ? `${formatFrequency(modalPeak.frequencyHz)}; mode ${
          modalPeak.modeRef?.rawModeIndex ?? "?"
        }`
      : "not available",
    pairs: comparisonModel.pairs,
    readiness: summary.comparisonState,
    resources: `${summary.spectrumResource}; ${summary.responseResource}`,
    validationState: modalPeak && drivenPeak
      ? `${modalPeak.validationStatus} modal, ${drivenPeak.validationStatus} driven`
      : "requires both modal and driven peaks",
    spatialOverlap: nearestComparison?.drivenPeak?.overlap != null
      ? formatNumber(nearestComparison.drivenPeak.overlap)
      : (!modalPeak?.fieldId || !drivenPeak?.fieldId
          ? "degraded (field payload missing; request link)"
          : "degraded (field payload missing; request link)"),
  };
}

export function useFrequencyDomainProvenanceSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const branches = useFrequencyDomainEigenBranchesResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const cancelRequested = useFrequencyDomainResponseCancelRequestedResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const requestedExecution = record(manifestPayload?.requested_execution);
  const physics = record(manifestPayload?.physics);
  const response = manifest.data?.response;
  const eigenmodes = manifest.data?.eigenmodes;
  const responseStudyKind = response?.study_kind ?? "frequency_response";
  const eigenStudyKind = eigenmodes?.study_kind ?? "eigenmodes";
  const responseFieldCount = responseFieldResourcesFromManifest(manifestPayload)
    .length;
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const modeFieldCount = spectrumModel.points.filter((point) => eigenModeFieldAvailable(point))
    .length;

  return {
    branchArtifact: branches.data?.artifact_path ?? "not available",
    calculationMode:
      stringValue(requestedExecution?.calculation_mode) ?? "not available",
    cancelArtifact:
      cancelRequested.data?.latest_artifact_manifest_path ?? "not available",
    eigenLane: `${eigenStudyKind}: ${eigenmodes?.status ?? "missing"}; modal=${String(
      eigenmodes?.modal_solver_available ?? false,
    )}; gpu=${String(eigenmodes?.gpu_available ?? false)}`,
    manifestArtifact:
      manifest.data?.result_manifest?.artifact_path ?? "not available",
    manifestResource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    magnetostaticBc: requestedMagnetostaticBc(manifestPayload),
    modalSpectrumArtifact: spectrum.data?.artifact_path ?? "not available",
    modeFieldArtifacts: `${modeFieldCount} mode field artifact(s)`,
    physicsContract: [
      stringValue(physics?.normalization) ?? "not available",
      stringValue(physics?.phase_convention) ?? "not available",
      stringValue(physics?.frequency_units) ?? "not available",
      stringValue(physics?.field_units) ?? "not available",
    ].join("; "),
    responseFieldArtifacts: `${responseFieldCount} field artifact(s)`,
    responseLane: `${responseStudyKind}: ${response?.status ?? "missing"}; driven=${String(
      response?.driven_response_available ?? false,
    )}; static_periodic=${String(
      response?.static_periodic_response_available ?? false,
    )}; gpu=${String(response?.gpu_available ?? false)}`,
    responseSweepArtifact: responseSweep.data?.artifact_path ?? "not available",
    spinWaveBc: formatSpinWaveBc(manifestPayload),
    stageKind: stringValue(manifestPayload?.stage_kind) ?? "not available",
  };
}

export function useFrequencyDomainDispersionSummary() {
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
  const analyticReference = dispersionAnalyticReferenceSummary(
    dispersionModel.points,
  );
  const validationIntent =
    dispersionValidationIntentSummary(manifestPayload);
  const primaryBranch = branchesModel.branches[0] ?? null;
  const trackedPointCount = branchesModel.branches.reduce(
    (count, branch) => count + branch.points.length,
    0,
  );
  const pathMetadata = dispersionPathMetadataSummary(
    dispersion.data?.path_metadata,
  );

  return {
    badge:
      dispersion.status === "ready"
        ? `${dispersionModel.points.length} point(s)`
        : dispersion.status,
    branchCount: branchesModel.branches.length,
    analyticReference,
    capabilitySummary: dispersionCapabilitySummary(dispersionCapabilities),
    branchesModel,
    dispersionPointCount: dispersionModel.points.length,
    dispersionModel,
    dispersionResource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
    dispersionSeriesCount: dispersionModel.series.length,
    floquetGate: `modal ${capabilityStatus(boundaryCapabilities?.floquet_modal)}; response ${capabilityStatus(boundaryCapabilities?.floquet_response)}`,
    frequencyRange: formatFrequencyRange(frequencies),
    kPathSpan: `${formatNumberRange(pathValues)} rad/m`,
    modalOverlays: `${spectrumModel.points.filter((point) => eigenModeFieldAvailable(point)).length} mode field(s) available from modal spectrum`,
    pathLabels: pathMetadata.labels,
    pathMetadataArtifact: pathMetadata.artifact,
    pathSampling: pathMetadata.sampling,
    primaryBranch: primaryBranch
      ? `${primaryBranch.label ?? primaryBranch.branchId}; ${formatFrequencyRange(
          primaryBranch.points.map((point) => point.frequencyRealHz),
        )}`
      : "not available",
    trackedPointCount,
    validationIntent,
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

export function useEigenDiagnosticsSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const branches = useFrequencyDomainEigenBranchesResource();
  const eigenDiagnostics = useFrequencyDomainEigenDiagnosticsResource();
  const dispersion = useFrequencyDomainEigenDispersionResource();
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const branchesModel = buildEigenBranchesModel(branches.data);
  const dispersionModel = buildEigenDispersionChartModel(
    dispersion.data,
    branchesModel,
  );
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const dispersionCapabilities = record(capabilities?.dispersion);
  const boundaryCapabilities = record(capabilities?.boundary);
  const eigenmodes = manifest.data?.eigenmodes;
  const studyKind = eigenmodes?.study_kind ?? "eigenmodes";
  const trackedPointCount = branchesModel.branches.reduce(
    (count, branch) => count + branch.points.length,
    0,
  );
  const residualCount = spectrumModel.points.filter(
    (point) => point.residualNorm != null,
  ).length;
  const fieldOverlayCount = spectrumModel.points.filter(
    (point) => eigenModeFieldAvailable(point),
  ).length;
  const modalDiagnostics = eigenDiagnosticTransportSummary(eigenDiagnostics.data);

  return {
    badge:
      spectrum.status === "ready"
        ? `${spectrumModel.points.length} mode(s)`
        : spectrum.status,
    branchDiagnostics: `${branchesModel.branches.length} branch(es), ${trackedPointCount} tracked point(s)`,
    capabilitySummary: dispersionCapabilitySummary(dispersionCapabilities),
    demagKGate: `modal ${capabilityStatus(boundaryCapabilities?.floquet_modal)}; response ${capabilityStatus(boundaryCapabilities?.floquet_response)}`,
    dispersionSamples: `${dispersionModel.points.length} point(s), ${dispersion.status}`,
    floquetTransport: modalDiagnostics.transport,
    modalAvailability: `${studyKind}: ${eigenmodes?.status ?? "missing"}; modal=${String(
      eigenmodes?.modal_solver_available ?? false,
    )}; gpu=${String(eigenmodes?.gpu_available ?? false)}`,
    modalSpectrum: `${spectrumModel.points.length} mode(s), ${fieldOverlayCount} field payload(s)`,
    residualCoverage: `${residualCount}/${spectrumModel.points.length} mode(s)`,
    solverModel: modalDiagnostics.solverModel,
  };
}

function dispersionCapabilitySummary(
  dispersionCapabilities: Record<string, unknown> | null,
): string {
  return [
    `reference_cpu: ${capabilityStatus(dispersionCapabilities?.reference_cpu)}`,
    `production_cpu: ${capabilityStatus(dispersionCapabilities?.production_cpu)}`,
    `production_cpu_gamma_k_path: ${capabilityStatus(dispersionCapabilities?.production_cpu_gamma_k_path)}`,
    `production_gpu: ${capabilityStatus(dispersionCapabilities?.production_gpu)}`,
    `k_path: ${capabilityStatus(dispersionCapabilities?.k_path)}`,
    `branch_tracking: ${capabilityStatus(dispersionCapabilities?.branch_tracking)}`,
  ].join("; ");
}

export function frequencyDomainRuntimeCapabilities(
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

export function useEigenBranchesSummary() {
  const branches = useFrequencyDomainEigenBranchesResource();
  const branchesModel = buildEigenBranchesModel(branches.data);
  const trackedPointCount = branchesModel.branches.reduce(
    (count, branch) => count + branch.points.length,
    0,
  );
  const primaryBranch = branchesModel.branches[0] ?? null;
  const allFrequencies = branchesModel.branches.flatMap((branch) =>
    branch.points.map((point) => point.frequencyRealHz),
  );
  const sampleValues = branchesModel.branches.flatMap((branch) =>
    branch.points.map((point) => point.sampleIndex),
  );
  const representativePoint = primaryBranch?.points[0] ?? null;

  return {
    badge:
      branches.status === "ready"
        ? `${branchesModel.branches.length} branch(es)`
        : branches.status,
    branchCount: `${branchesModel.branches.length} branch(es), ${trackedPointCount} tracked point(s)`,
    branchGaps: primaryBranch
      ? `${primaryBranch.sampleGapCount ?? 0} gap(s); max gap ${primaryBranch.sampleGapMax ?? 0}`
      : "not available",
    branchResource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
    branchWarnings:
      primaryBranch?.warnings && primaryBranch.warnings.length > 0
        ? primaryBranch.warnings.join("; ")
        : "none",
    frequencyCoverage: formatFrequencyRange(allFrequencies),
    overlapQuality: primaryBranch
      ? `mean overlap ${formatCompactNumberOrUnavailable(primaryBranch.overlapPrevMean)}; lowest overlap ${formatCompactNumberOrUnavailable(primaryBranch.overlapPrevMin)}; min confidence ${formatCompactNumberOrUnavailable(primaryBranch.trackingConfidenceMin)}`
      : "not available",
    primaryBranch: primaryBranch
      ? `${primaryBranch.label ?? primaryBranch.branchId}; ${formatFrequencyRange(
          primaryBranch.points.map((point) => point.frequencyRealHz),
        )}`
      : "not available",
    representativeMode: representativePoint
      ? `sample ${representativePoint.sampleIndex}, mode ${representativePoint.rawModeIndex}, ${formatFrequency(representativePoint.frequencyRealHz)}`
      : "not available",
    sampleCoverage: sampleValues.length
      ? `sample ${Math.min(...sampleValues)}-${Math.max(...sampleValues)}`
      : "not available",
  };
}

export function useEigenSpectrumSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const modalCapabilities = record(capabilities?.modal);
  const frequencies = spectrumModel.points.map((point) => point.frequencyHz);
  const dampingCount = spectrumModel.points.filter(
    (point) => point.dampingRateHz != null || point.imaginaryFrequencyHz != null,
  ).length;
  const residualCount = spectrumModel.points.filter(
    (point) => point.residualNorm != null,
  ).length;
  const fieldOverlayCount = spectrumModel.points.filter(
    (point) => eigenModeFieldAvailable(point),
  ).length;
  const primaryMode = spectrumModel.points[0] ?? null;
  const payload = record(spectrum.data?.payload);
  const candidate = record(payload?.candidate_identity);
  const solveSucceeded =
    typeof payload?.solve_succeeded === "boolean"
      ? payload.solve_succeeded
      : null;
  const fieldsAvailable =
    typeof payload?.fields_available === "boolean"
      ? payload.fields_available
      : null;
  const windowComplete =
    typeof payload?.window_complete === "boolean"
      ? payload.window_complete
      : null;
  const identityParts = [
    spectrum.data?.run_id ? `run=${spectrum.data.run_id}` : null,
    spectrum.data?.stage_id ? `stage=${spectrum.data.stage_id}` : null,
    spectrum.data?.revision ? `artifact=${spectrum.data.revision}` : null,
    spectrum.data?.mesh_generation_id
      ? `mesh=${spectrum.data.mesh_generation_id}`
      : stringValue(candidate?.mesh_generation_id)
        ? `mesh=${stringValue(candidate?.mesh_generation_id)}`
        : null,
    stringValue(candidate?.device)
      ? `device=${stringValue(candidate?.device)}`
      : null,
  ].filter((value): value is string => value != null);

  return {
    badge:
      spectrum.status === "ready"
        ? `${spectrumModel.points.length} mode(s)`
        : spectrum.status,
    capabilitySummary: `reference_cpu: ${capabilityStatus(modalCapabilities?.reference_cpu)}; mode_field_payload: ${capabilityStatus(modalCapabilities?.mode_field_payload)}`,
    dampingCoverage: `${dampingCount}/${spectrumModel.points.length} mode(s)`,
    candidateIdentity:
      identityParts.length > 0 ? identityParts.join("; ") : "not published",
    fieldAvailability:
      fieldsAvailable == null
        ? "unknown"
        : fieldsAvailable
          ? "available"
          : "unavailable",
    fieldOverlayCount,
    frequencyRange: formatFrequencyRange(frequencies),
    modeCount: spectrumModel.points.length,
    primaryMode: primaryMode
      ? `mode ${primaryMode.rawModeIndex} at ${formatFrequency(primaryMode.frequencyHz)}`
      : "not available",
    residualCoverage: `${residualCount}/${spectrumModel.points.length} mode(s)`,
    solveStatus:
      solveSucceeded == null
        ? "unknown"
        : solveSucceeded
          ? "succeeded"
          : "failed",
    spectrumCompleteness:
      stringValue(payload?.spectrum_completeness) ?? "unknown",
    spectrumModel,
    spectrumResource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
    windowCertificate:
      windowComplete == null
        ? "unknown"
        : windowComplete
          ? "complete"
          : "incomplete",
  };
}

export function responseMapAvailabilityFromTypedResource(
  resource: unknown,
): "ready" | "loading" | "stale" | "error" | "unsupported" {
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
    return "unsupported";
  }

  const candidate = resource as { data?: unknown; status?: unknown };
  if (candidate.status === "ready" && candidate.data != null) {
    return "ready";
  }
  if (
    candidate.status === "loading" ||
    candidate.status === "stale" ||
    candidate.status === "error"
  ) {
    return candidate.status;
  }
  return "unsupported";
}

export function useFrequencyDomainResponseMapSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const demagCapabilities = record(capabilities?.demag);
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
  );
  const modeRows = buildFrequencyDomainCalculationModeRows(
    manifest.data?.capabilities,
    manifest.data?.floquet_nonzero_k_response_supported,
  );
  const responseMapRow = modeRows.find((row) => row.mode === "response_map");
  const spinWaveBc = record(manifestPayload?.spin_wave_bc);
  const kVector = Array.isArray(spinWaveBc?.floquet_k_vector_rad_per_m)
    ? spinWaveBc.floquet_k_vector_rad_per_m.flatMap((value) => {
        const parsed = finiteNumber(value);
        return parsed == null ? [] : [parsed];
      })
    : [];
  const fieldCount =
    responseFieldResourcesFromManifest(manifestPayload).length ||
    responseModel.points.filter((point) => point.fieldId).length;
  // The capability bit describes a legal execution lane, not a published
  // k-by-f response resource. Until that typed resource is exposed, keep the
  // result unavailable and fall back to the verified FMR response sweep.
  const responseMapAvailability =
    responseMapAvailabilityFromTypedResource(null);

  return {
    availability: responseMapAvailability,
    badge: responseMapAvailability,
    blockingPhysics: `dynamic_demag_k: ${capabilityStatus(demagCapabilities?.floquet_dynamic_k)}`,
    capabilityGate: responseMapRow?.capabilityStatus ?? "not available",
    currentResponseEvidence: `${responseModel.points.length} point(s), ${fieldCount} response field(s)`,
    floquetRequest:
      spinWaveBc && stringValue(spinWaveBc.kind)
        ? `kind=${stringValue(spinWaveBc.kind)}; k=[${kVector
            .map(formatNumber)
            .join(", ")}] rad/m`
        : "not requested",
    manifestResource: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    uiFallback:
      responseMapAvailability === "ready"
        ? "show response map controls"
        : "Typed response-map resource is not published; show FMR response sweep until nonzero-k map is executable",
  };
}

export function useEigenModesSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const visualizationCapabilities = record(capabilities?.visualization);
  const modeCount = spectrumModel.points.length;
  const overlayReadyCount = spectrumModel.points.filter(
    (point) => eigenModeFieldAvailable(point),
  ).length;
  const firstSelectableMode =
    spectrumModel.points.find((point) => eigenModeFieldAvailable(point)) ??
    spectrumModel.points[0] ??
    null;

  return {
    badge: spectrum.status === "ready" ? `${modeCount} mode(s)` : spectrum.status,
    capabilitySummary: `mode_table: ${capabilityStatus(visualizationCapabilities?.mode_table)}; mode_3d_overlay: ${capabilityStatus(visualizationCapabilities?.mode_3d_overlay)}`,
    firstSelectableMode: firstSelectableMode
      ? `sample ${firstSelectableMode.sampleIndex}, mode ${firstSelectableMode.rawModeIndex}, ${formatFrequency(firstSelectableMode.frequencyHz)}`
      : "not available",
    frequencyRange: formatFrequencyRange(
      spectrumModel.points.map((point) => point.frequencyHz),
    ),
    modeTable: `${modeCount} mode(s), ${overlayReadyCount} field-ready`,
    modeTableResource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
    spectrumModel,
  };
}

export function useFrequencyDomainExportsSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const branches = useFrequencyDomainEigenBranchesResource();
  const dispersion = useFrequencyDomainEigenDispersionResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    frequencyDomainManifestPayload(manifest.data),
  );
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const responseFieldCount =
    responseFieldResourcesFromManifest(manifestPayload).length ||
    responseModel.points.filter((point) => point.fieldId).length;
  const modalFieldCount = spectrumModel.points.filter(
    (point) => eigenModeFieldAvailable(point),
  ).length;
  const readyArtifacts = [
    manifest.data?.result_manifest?.artifact_path,
    spectrum.data?.artifact_path,
    branches.data?.artifact_path,
    responseSweep.data?.artifact_path,
    dispersion.status === "ready" ? "eigen/dispersion.csv" : null,
  ].filter((item): item is string => Boolean(item));

  return {
    apiResources: [
      ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
      ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    ].join("; "),
    badge: readyArtifacts.length ? `${readyArtifacts.length} artifact(s)` : "missing",
    bundle: "manifest + modal artifacts + driven response artifacts",
    drivenSweep:
      responseSweep.data?.artifact_path ??
      (responseSweep.status === "ready" ? "response/magnetic_response_sweep.v2.json" : "not available"),
    exportFormats: "JSON control plane, CSV dispersion, Zarr field payloads",
    fieldPayloads: `${responseFieldCount} response field(s), ${modalFieldCount} modal field(s)`,
    manifest:
      manifest.data?.result_manifest?.artifact_path ??
      "frequency_domain/manifest.v1.json",
    modalBranches: branches.data?.artifact_path ?? "not available",
    modalDispersion:
      dispersion.status === "ready" ? "eigen/dispersion.csv" : "not available",
    modalSpectrum: spectrum.data?.artifact_path ?? "not available",
    pythonRoundTrip: "canonical Eigenmodes / FrequencyResponse studies",
  };
}

export function useCalculationModesSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const chartRoute = routeFrequencyDomainCalculationMode(manifestPayload);
  const modeRows = buildFrequencyDomainCalculationModeRows(
    manifest.data?.capabilities,
    manifest.data?.floquet_nonzero_k_response_supported,
  );
  const activeRow =
    modeRows.find((row) => row.mode === chartRoute.mode) ?? modeRows[0]!;
  const modalRows = modeRows.filter(
    (row) => row.canonicalStudy === "Eigenmodes",
  );
  const drivenRows = modeRows.filter(
    (row) => row.canonicalStudy === "FrequencyResponse",
  );
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
  );
  const responseMapRow = modeRows.find((row) => row.mode === "response_map");

  return {
    activeMode: chartRoute.mode,
    activeStudy: activeRow.canonicalStudy,
    activeWorkflow: `${chartRoute.mode}; ${chartRoute.status}${
      chartRoute.unavailableReason ? ` (${chartRoute.unavailableReason})` : ""
    }`,
    capabilityRoute: activeRow.capabilityStatus,
    drivenEvidence:
      responseModel.points.length > 0
        ? `${responseModel.points.length} response point(s), ${responseModel.series.length} observable series`
        : "no driven response sweep loaded",
    drivenWorkflows: drivenRows.map((row) => row.mode).join(", "),
    modalEvidence:
      spectrumModel.points.length > 0
        ? `${spectrumModel.points.length} mode(s), ${
            spectrumModel.points.filter((point) => eigenModeFieldAvailable(point)).length
          } field-ready`
        : "no modal spectrum loaded",
    modalWorkflows: modalRows.map((row) => row.mode).join(", "),
    modeRows,
    primaryChart: chartRoute.primaryChart,
    requiredArtifacts: activeRow.artifacts,
    responseMapGate: responseMapRow?.capabilityStatus ?? "not available",
  };
}

export function useFmrPeakSummary({ selection }: InspectorPanelProps) {
  const ref = selection.ref?.type === "frequency-domain" ? selection.ref : null;
  const peakIndex = ref?.fmrPeakIndex ?? null;
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const manifestPayload = frequencyDomainManifestPayload(manifest.data);
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep.data,
    manifestPayload,
  );
  const peakModel = buildFmrPeakTableModel({
    manifestPayload,
    responseSweep: responseSweep.data,
    spectrum: spectrum.data,
  });
  const peak = peakIndex == null ? null : peakModel.peaks[peakIndex] ?? null;
  const source = peak?.source ?? null;
  const isModal = source === "modal";
  const modeRef = peak?.modeRef ?? null;
  const frequencyPointIndex = peak?.frequencyPointIndex ?? null;
  const fieldResource = peak?.fieldResourceKey ?? null;
  const sourceResource = isModal
    ? ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH
    : ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH;
  const resource =
    ref?.resourceRef ??
    fieldResource ??
    sourceResource;
  const sourceInspectorKind = isModal
    ? "results.frequency_domain.fmr_modal_spectrum"
    : "results.frequency_domain.fmr_response_sweep";
  const sourceInspectorLabel = isModal
    ? "FMR Modal Spectrum"
    : "FMR Response Sweep";
  const sourceInspectorNodeId = isModal
    ? "results:frequency-domain:fmr:modal-spectrum"
    : "results:frequency-domain:fmr:response-sweep";
  const amplitudeUnit =
    peak?.amplitudeUnit ?? frequencyResponseSeriesUnit(responseModel, "amplitude");
  const absorbedPowerDensityUnit =
    peak?.absorbedPowerDensityUnit ??
    frequencyResponseSeriesUnit(responseModel, "absorbed-power-density");

  return {
    absorbedPowerDensity:
      peak?.absorbedPowerDensity == null
        ? "not available"
        : formatQuantity(peak.absorbedPowerDensity, absorbedPowerDensityUnit),
    amplitude: formatQuantity(peak?.amplitude, amplitudeUnit),
    actionBadge: peak?.fieldId ? "3D-ready" : "metadata",
    artifactFamily: isModal ? "eigen/spectrum.v2.json" : "response/magnetic-sweep",
    badge:
      peakIndex == null
        ? "unselected"
        : peak
          ? `peak ${peakIndex + 1}`
          : "missing",
    fieldId: peak?.fieldId ?? null,
    fieldPayload: peak?.fieldId ? `${peak.fieldId}; field-ready` : "missing",
    dataPlaneResource: fieldResource ?? resource ?? "not available",
    frequency: formatFrequency(peak?.frequencyHz),
    frequencyPointIndex,
    hasLinkedTarget: Boolean(modeRef || frequencyPointIndex != null),
    interpretation: isModal
      ? "modal resonance from the eigen spectrum"
      : source === "driven_response"
        ? "driven-response peak from the FMR sweep"
        : "peak metadata is unavailable",
    linewidth: formatFrequency(peak?.linewidthHz),
    missingSpectralValues: missingValueSummary([
      ["amplitude", peak?.amplitude],
      ["absorbed power", peak?.absorbedPowerDensity],
      ["phase", peak?.phaseRad],
      ["linewidth", peak?.linewidthHz],
    ]),
    modeRef,
    phase: peak?.phaseRad == null ? "not available" : `${formatNumber(peak.phaseRad)} rad`,
    provenanceBadge: peak?.fieldId ? "field-linked" : "metadata",
    resource,
    source:
      source === "modal"
        ? "modal eigenmode"
        : source === "driven_response"
          ? "driven response"
          : "not available",
    sourceBadge:
      source === "modal"
        ? "modal"
        : source === "driven_response"
          ? "driven"
          : "missing",
    sourceInspectorKind,
    sourceInspectorLabel,
    sourceInspectorNodeId,
    sourceResource,
    spectralBadge:
      peak == null
        ? "missing"
        : [peak.amplitude, peak.absorbedPowerDensity, peak.phaseRad, peak.linewidthHz].some(
              (value) => value != null,
            )
          ? "partial"
          : "metadata-only",
    target: isModal
      ? modeRef
        ? `sample ${modeRef.sampleIndex}, mode ${modeRef.rawModeIndex}`
        : "mode not available"
      : frequencyPointIndex == null
        ? "frequency point not available"
        : `frequency point ${frequencyPointIndex}`,
    validation: peak?.validationStatus ?? "not available",
    visualizationReadiness: peak?.fieldId
      ? "field id is published; plot command can use the linked field id"
      : "field payload missing; 3D field is unavailable",
  };
}
