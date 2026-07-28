import {
  ANALYSIS_EIGEN_MODE_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DIAGNOSTICS_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
  MESHING_PERIODIC_PAIRS_PATH,
} from "@/kernel/api/apiPaths";
import type {
  FrequencyDomainJsonArtifactResource,
  FrequencyDomainManifestResource,
  FrequencyDomainSweepProgressResource,
  FrequencyDomainTextArtifactResource,
} from "@/kernel/api/apiTypes";
import {
  buildEigenBranchesModel,
  buildEigenDispersionChartModel,
  buildEigenSpectrumChartModel,
  buildFrequencyResponseChartModel,
  buildFmrPeakTableModel,
  frequencyDomainManifestPayload,
  responseFieldResourcesFromManifest,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import {
  formatFrequencyHz,
  formatFrequencyRangeBoundsHz,
} from "@/shared/domain/analysis/frequencyUnits";
import type { AnalysisFieldOverlayState } from "@/kernel/visualization/AnalysisFieldOverlayController";
import type { PinnedQuickChart } from "@/kernel/workspace/quickChartWorkspace";

import type { ExplorerNode, ExplorerNodeStatus } from "../explorerTypes";

const EIGEN_MODE_FIELD_3D_COMMANDS = [
  "analysis.eigen.plot-mode-3d",
  "analysis.eigen.plot-mode-3d-real",
  "analysis.eigen.plot-mode-3d-imag",
  "analysis.eigen.plot-mode-3d-amplitude",
  "analysis.eigen.plot-mode-3d-abs",
  "analysis.eigen.plot-mode-3d-phase",
  "analysis.eigen.plot-mode-3d-phase-rotated-real",
  "analysis.eigen.set-mode-3d-animation",
];

const FREQUENCY_RESPONSE_FIELD_3D_COMMANDS = [
  "analysis.frequency-response.plot-response-field-3d",
  "analysis.frequency-response.plot-response-field-3d-real",
  "analysis.frequency-response.plot-response-field-3d-imag",
  "analysis.frequency-response.plot-response-field-3d-amplitude",
  "analysis.frequency-response.plot-response-field-3d-abs",
  "analysis.frequency-response.plot-response-field-3d-phase",
  "analysis.frequency-response.plot-response-field-3d-phase-rotated-real",
  "analysis.frequency-domain.set-3d-animation",
];

export interface ExplorerTreeResources {
  frequencyDomainBranches?: FrequencyDomainJsonArtifactResource | null;
  frequencyDomainCancelRequested?: FrequencyDomainSweepProgressResource | null;
  frequencyDomainDispersion?: FrequencyDomainTextArtifactResource | null;
  frequencyDomainManifest?: FrequencyDomainManifestResource | null;
  frequencyDomainResponseProgress?: FrequencyDomainSweepProgressResource | null;
  frequencyDomainResponseSweep?: FrequencyDomainJsonArtifactResource | null;
  frequencyDomainSpectrum?: FrequencyDomainJsonArtifactResource | null;
  activeAnalysisFieldOverlay?: AnalysisFieldOverlayState | null;
  pinnedQuickChart?: PinnedQuickChart | null;
}

export function buildFrequencyDomainResultNode(
  manifest: FrequencyDomainManifestResource | null | undefined,
  branches?: FrequencyDomainJsonArtifactResource | null,
  dispersion?: FrequencyDomainTextArtifactResource | null,
  responseSweep?: FrequencyDomainJsonArtifactResource | null,
  spectrum?: FrequencyDomainJsonArtifactResource | null,
  activeAnalysisFieldOverlay?: AnalysisFieldOverlayState | null,
): ExplorerNode {
  const status: ExplorerNodeStatus = manifest ? "ready" : "stale";
  const parentId = "results:frequency-domain";
  const spectrumModel = buildEigenSpectrumChartModel(spectrum);
  const branchesModel = buildEigenBranchesModel(branches);
  const dispersionModel = buildEigenDispersionChartModel(
    dispersion,
    branchesModel,
  );
  const manifestPayload = frequencyDomainManifestPayload(manifest);
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep,
    manifestPayload,
  );
  const fmrPeaks = buildFmrPeakTableModel({
    manifestPayload,
    responseSweep,
    spectrum,
  });
  const hasEigenResults =
    spectrumModel.points.length > 0 ||
    dispersionModel.points.length > 0 ||
    branchesModel.branches.length > 0;
  const hasResponseResults =
    responseModel.points.length > 0 ||
    Boolean(manifest?.response_progress?.partial_artifacts_available) ||
    Boolean(manifest?.response_cancel_requested?.partial_artifacts_available);
  const hasExports =
    Boolean(spectrum?.artifact_path) ||
    Boolean(branches?.artifact_path) ||
    Boolean(dispersion?.artifact_path) ||
    Boolean(responseSweep?.artifact_path) ||
    Boolean(manifest?.result_manifest?.artifact_path);
  return {
    id: parentId,
    kind: "results.frequency_domain.root",
    label: "Frequency Domain",
    parentId: "results:root",
    badge: manifest ? manifest.schema_version : "missing manifest",
    icon: "wave",
    status,
    children: compactExplorerNodes([
      {
        id: `${parentId}:run`,
        kind: "results.frequency_domain.run",
        label: "Run Provenance",
        parentId,
        badge: manifest ? "manifest" : "missing manifest",
        icon: "file",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
        status,
      },
      buildFrequencyDomainCalculationModesNode({
        branchesModel,
        dispersionModel,
        fmrPeaks,
        manifest,
        parentId,
        responseModel,
        spectrumModel,
        status,
      }),
      fmrPeaks.peaks.length > 0 ||
      spectrumModel.points.length > 0 ||
      responseModel.points.length > 0
        ? buildFrequencyDomainFmrNode({
            manifest,
            parentId,
            responseSweep,
            spectrum,
            status,
            activeAnalysisFieldOverlay,
          })
        : null,
      dispersionModel.points.length > 0 || branchesModel.branches.length > 0
        ? {
            id: `${parentId}:dispersion`,
            kind: "results.frequency_domain.dispersion",
            label: "Dispersion",
            parentId,
            badge:
              dispersionModel.points.length > 0
                ? `${dispersionModel.points.length} point(s)`
                : `${branchesModel.branches.length} branch(es)`,
            icon: "wave",
            status: "ready",
            children: compactExplorerNodes([
              buildEigenKPathNode({
                branches,
                dispersion,
                id: "results:eigen:k-path",
                manifest,
                parentId: `${parentId}:dispersion`,
              }),
              buildEigenBranchesNode({
                branches,
                id: `${parentId}:dispersion:branches`,
                parentId: `${parentId}:dispersion`,
              }),
            ]),
          } satisfies ExplorerNode
        : null,
      hasEigenResults
        ? buildEigenResultNode(
            manifest,
            parentId,
            branches,
            dispersion,
            spectrum,
            activeAnalysisFieldOverlay,
          )
        : null,
      hasResponseResults
        ? buildFrequencyResponseResultNode(
            manifest,
            parentId,
            responseSweep,
            activeAnalysisFieldOverlay,
          )
        : null,
      fmrPeaks.peaks.some((peak) => peak.source === "modal") &&
      fmrPeaks.peaks.some((peak) => peak.source === "driven_response")
        ? {
            id: `${parentId}:comparison`,
            kind: "results.frequency_domain.comparison",
            label: "Modal vs Driven Comparison",
            parentId,
            badge: "FMR",
            icon: "gauge",
            status: "ready",
          } satisfies ExplorerNode
        : null,
      hasExports
        ? {
            id: `${parentId}:exports`,
            kind: "results.frequency_domain.exports",
            label: "Exports",
            parentId,
            badge: "artifacts",
            icon: "file",
            status: "ready",
          } satisfies ExplorerNode
        : null,
    ]),
  };
}

function buildFrequencyDomainCalculationModesNode({
  branchesModel,
  dispersionModel,
  fmrPeaks,
  manifest,
  parentId,
  responseModel,
  spectrumModel,
  status,
}: {
  branchesModel: ReturnType<typeof buildEigenBranchesModel>;
  dispersionModel: ReturnType<typeof buildEigenDispersionChartModel>;
  fmrPeaks: ReturnType<typeof buildFmrPeakTableModel>;
  manifest: FrequencyDomainManifestResource | null | undefined;
  parentId: string;
  responseModel: ReturnType<typeof buildFrequencyResponseChartModel>;
  spectrumModel: ReturnType<typeof buildEigenSpectrumChartModel>;
  status: ExplorerNodeStatus;
}): ExplorerNode {
  const hasModalFmr = spectrumModel.points.length > 0;
  const hasDrivenFmr = responseModel.points.length > 0;
  const hasFmr = hasModalFmr || hasDrivenFmr || fmrPeaks.peaks.length > 0;
  const hasDispersion =
    dispersionModel.points.length > 0 || branchesModel.branches.length > 0;
  const responseMap = responseMapResultState(manifest);
  const children = compactExplorerNodes([
    hasFmr
      ? {
          id: `${parentId}:calculation-modes:fmr`,
          kind: "results.frequency_domain.fmr",
          label: "FMR",
          parentId: `${parentId}:calculation-modes`,
          badge:
            hasModalFmr && hasDrivenFmr
              ? "modal + driven"
              : hasModalFmr
                ? "modal"
                : "driven",
          calculationMode: hasDrivenFmr ? "fmr_response" : "fmr_modal",
          icon: "activity",
          resourceRef: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
          status: "ready",
        }
      : null,
    hasDispersion
      ? {
          id: `${parentId}:calculation-modes:dispersion`,
          kind: "results.frequency_domain.dispersion",
          label: "Dispersion",
          parentId: `${parentId}:calculation-modes`,
          badge:
            dispersionModel.points.length > 0
              ? `${dispersionModel.points.length} point(s)`
              : `${branchesModel.branches.length} branch(es)`,
          calculationMode: "dispersion_modal",
          icon: "wave",
          resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
          status: "ready",
        }
      : null,
    responseMap.show
      ? {
          id: `${parentId}:calculation-modes:response-map`,
          kind: "results.frequency_domain.response_map",
          label: "Response Map",
          parentId: `${parentId}:calculation-modes`,
          artifactPath: responseMap.artifactPath,
          badge: responseMap.badge,
          calculationMode: "response_map",
          icon: "gauge",
          resourceRef: responseMap.resourceRef,
          status: responseMap.status,
        }
      : null,
  ]);
  return {
    id: `${parentId}:calculation-modes`,
    kind: "results.frequency_domain.calculation_modes",
    label: "Calculation Modes",
    parentId,
    badge:
      hasFmr && hasDispersion
        ? "FMR + dispersion"
        : hasFmr
          ? "FMR"
          : hasDispersion
            ? "dispersion"
            : "workflow presets",
    children: children.length > 0 ? children : undefined,
    icon: "settings",
    resourceRef: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    status,
  };
}

function responseMapResultState(
  manifest: FrequencyDomainManifestResource | null | undefined,
): {
  artifactPath?: string;
  badge: string;
  resourceRef: string;
  show: boolean;
  status: ExplorerNodeStatus;
} {
  const requested =
    manifestString(manifest, "requested_execution", "calculation_mode") ===
    "response_map";
  const artifactPath =
    manifestString(manifest, "artifacts", "response_map_v2_path") ??
    manifestString(manifest, "artifacts", "response_map_v1_path");
  const resourceRef =
    manifestString(manifest, "resources", "response_map_resource_key") ??
    ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH;
  const hasResourceRef =
    resourceRef !== ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH;
  const available =
    Boolean(artifactPath) ||
    hasResourceRef ||
    manifest?.floquet_nonzero_k_response_supported === true;

  return {
    artifactPath,
    badge: available ? "available" : "unsupported",
    resourceRef,
    show: requested || Boolean(artifactPath) || hasResourceRef,
    status: available ? "ready" : "unsupported",
  };
}

function buildEigenKPathNode({
  branches,
  dispersion,
  id,
  manifest,
  parentId,
}: {
  branches: FrequencyDomainJsonArtifactResource | null | undefined;
  dispersion: FrequencyDomainTextArtifactResource | null | undefined;
  id: string;
  manifest: FrequencyDomainManifestResource | null | undefined;
  parentId: string;
}): ExplorerNode {
  const model = buildEigenDispersionChartModel(
    dispersion,
    buildEigenBranchesModel(branches),
  );
  const sampleCount = new Set(model.points.map((point) => point.sampleIndex)).size;
  return {
    id,
    kind: "results.eigen.k_path",
    label: "k-Path",
    parentId,
    badge: sampleCount > 0 ? `${sampleCount} k sample(s)` : "Bloch/Floquet",
    icon: "wave",
    resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
    status:
      sampleCount > 0
        ? "ready"
        : manifest?.floquet_nonzero_k_demag_supported
          ? "stale"
          : manifest
            ? "unsupported"
            : "stale",
  };
}

function buildFrequencyDomainFmrNode({
  activeAnalysisFieldOverlay,
  manifest,
  parentId,
  responseSweep,
  spectrum,
  status,
}: {
  activeAnalysisFieldOverlay?: AnalysisFieldOverlayState | null;
  manifest: FrequencyDomainManifestResource | null | undefined;
  parentId: string;
  responseSweep: FrequencyDomainJsonArtifactResource | null | undefined;
  spectrum: FrequencyDomainJsonArtifactResource | null | undefined;
  status: ExplorerNodeStatus;
}): ExplorerNode {
  const manifestPayload = frequencyDomainManifestPayload(manifest);
  const fmrPeaks = buildFmrPeakTableModel({
    manifestPayload,
    responseSweep,
    spectrum,
  });
  const spectrumModel = buildEigenSpectrumChartModel(spectrum);
  const responseModel = buildFrequencyResponseChartModel(
    responseSweep,
    manifestPayload,
  );
  const peakCount = fmrPeaks.peaks.length;
  return {
    id: `${parentId}:fmr`,
    kind: "results.frequency_domain.fmr",
    label: "FMR",
    parentId,
    badge: fmrBadge(manifest),
    icon: "activity",
    status,
    children: compactExplorerNodes([
      spectrumModel.points.length > 0
        ? {
            artifactPath: spectrum?.artifact_path ?? undefined,
            calculationMode: "fmr_modal",
            id: `${parentId}:fmr:modal-spectrum`,
            kind: "results.frequency_domain.fmr_modal_spectrum",
            label: "Modal FMR Spectrum",
            parentId: `${parentId}:fmr`,
            badge: `${spectrumModel.points.length} mode(s)`,
            icon: "wave",
            resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
            status: "ready",
          }
        : null,
      responseModel.points.length > 0
        ? {
            artifactPath: responseSweep?.artifact_path ?? undefined,
            calculationMode: "fmr_response",
            id: `${parentId}:fmr:response-sweep`,
            kind: "results.frequency_domain.fmr_response_sweep",
            label: "Driven FMR Sweep",
            parentId: `${parentId}:fmr`,
            badge: `${responseModel.points.length} point(s)`,
            icon: "activity",
            resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
            status: "ready",
          }
        : null,
      peakCount > 0
        ? {
            artifactPath:
              responseSweep?.artifact_path ?? spectrum?.artifact_path ?? undefined,
            calculationMode: "fmr_response",
            id: `${parentId}:fmr:peaks`,
            kind: "results.frequency_domain.fmr_peaks",
            label: "FMR Peaks",
            parentId: `${parentId}:fmr`,
            badge: `${peakCount} peak(s)`,
            icon: "gauge",
            resourceRef: responseSweep
              ? ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH
              : spectrum
                ? ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH
                : undefined,
            status: "ready",
            children: buildFmrPeakNodes({
              activeAnalysisFieldOverlay,
              parentId: `${parentId}:fmr:peaks`,
              peaks: fmrPeaks.peaks,
              responseSweep,
              spectrum,
            }),
          }
        : null,
    ]),
  };
}

function buildFmrPeakNodes({
  activeAnalysisFieldOverlay,
  parentId,
  peaks,
  responseSweep,
  spectrum,
}: {
  activeAnalysisFieldOverlay?: AnalysisFieldOverlayState | null;
  parentId: string;
  peaks: ReturnType<typeof buildFmrPeakTableModel>["peaks"];
  responseSweep: FrequencyDomainJsonArtifactResource | null | undefined;
  spectrum: FrequencyDomainJsonArtifactResource | null | undefined;
}): ExplorerNode[] {
  return peaks.map((peak, index) => {
    const isModal = peak.source === "modal";
    const hasField = peak.fieldId != null;
    const activeAnalysisField = isActiveAnalysisField(
      activeAnalysisFieldOverlay,
      peak.fieldId,
      isModal ? "eigen-mode" : "frequency-response",
    );
    return {
      activeAnalysisField,
      artifactPath: isModal
        ? spectrum?.artifact_path ?? undefined
        : responseSweep?.artifact_path ?? undefined,
      calculationMode: isModal ? "fmr_modal" : "fmr_response",
      contextCommands: hasField
        ? isModal
          ? EIGEN_MODE_FIELD_3D_COMMANDS
          : FREQUENCY_RESPONSE_FIELD_3D_COMMANDS
        : undefined,
      fieldId: peak.fieldId ?? undefined,
      fmrPeakIndex: index,
      frequencyIndex: peak.frequencyPointIndex ?? undefined,
      icon: isModal ? "wave" : "activity",
      id: `${parentId}:peak:${index}`,
      kind: "results.frequency_domain.fmr_peak",
      label: `${isModal ? "Modal" : "Driven"} Peak ${index + 1}`,
      modeIndex: peak.modeRef?.rawModeIndex,
      observableId: isModal ? undefined : "response",
      parentId,
      resourceRef: isModal
        ? peak.fieldResourceKey ?? ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH
        : peak.fieldResourceKey ??
          ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
      sampleIndex: peak.modeRef?.sampleIndex,
      status: "ready",
      badge: formatFrequencyHz(peak.frequencyHz),
    };
  });
}

function buildEigenResultNode(
  manifest: FrequencyDomainManifestResource | null | undefined,
  familyParentId: string,
  branches: FrequencyDomainJsonArtifactResource | null | undefined,
  dispersion: FrequencyDomainTextArtifactResource | null | undefined,
  spectrum: FrequencyDomainJsonArtifactResource | null | undefined,
  activeAnalysisFieldOverlay?: AnalysisFieldOverlayState | null,
): ExplorerNode {
  const parentId = "results:eigen";
  const modeNodes = buildEigenModeNodes(
    `${parentId}:modes`,
    spectrum,
    activeAnalysisFieldOverlay,
  );
  const branchesModel = buildEigenBranchesModel(branches);
  const dispersionModel = buildEigenDispersionChartModel(
    dispersion,
    branchesModel,
  );
  const spectrumModel = buildEigenSpectrumChartModel(spectrum);
  const modeVisualizationNode = buildEigenModesVisualizationNode(
    `${parentId}:modes`,
    spectrumModel,
    activeAnalysisFieldOverlay,
  );
  return {
    id: parentId,
    kind: "results.eigen.root",
    label: "Modal Eigen Results",
    parentId: familyParentId,
    badge: manifest?.eigenmodes.status ?? "missing",
    icon: "activity",
    status: "ready",
    children: compactExplorerNodes([
      {
        id: `${parentId}:study`,
        kind: "results.eigen.study",
        label: "Eigen Study",
        parentId,
        badge: manifest?.eigen_namespace ?? "eigen",
        icon: "settings",
        status: "ready",
      },
      spectrumModel.points.length > 0
        ? {
            id: `${parentId}:spectrum`,
            kind: "results.eigen.spectrum",
            label: "Spectrum",
            parentId,
            badge: `${spectrumModel.points.length} mode(s)`,
            icon: "wave",
            status: "ready",
          }
        : null,
      modeNodes.length > 0
        ? {
            id: `${parentId}:modes`,
            kind: "results.eigen.modes",
            label: "Modes",
            parentId,
            badge: `${modeNodes.length} listed`,
            icon: "layers",
            status: "ready",
            children: compactExplorerNodes([modeVisualizationNode, ...modeNodes]),
          }
        : null,
      dispersionModel.points.length > 0
        ? {
            id: `${parentId}:dispersion`,
            kind: "results.eigen.dispersion",
            label: "Dispersion",
            parentId,
            badge: `${dispersionModel.points.length} point(s)`,
            icon: "wave",
            resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
            status: "ready",
          }
        : null,
      buildEigenBranchesNode({
        branches,
        id: `${parentId}:branches`,
        parentId,
      }),
      {
        id: `${parentId}:provenance`,
        kind: "results.eigen.provenance",
        label: "Provenance",
        parentId,
        badge: "manifest",
        icon: "file",
        status: manifest ? "ready" : "stale",
      },
    ]),
  };
}

function buildEigenBranchesNode({
  branches,
  id,
  parentId,
}: {
  branches: FrequencyDomainJsonArtifactResource | null | undefined;
  id: string;
  parentId: string;
}): ExplorerNode | null {
  const model = buildEigenBranchesModel(branches);
  const branchNodes = model.branches.slice(0, 64).map((branch) => ({
    id: `${id}:branch:${branch.branchId}`,
    kind: "results.eigen.branch" as const,
    label: branch.label ?? `Branch ${branch.branchId}`,
    parentId: id,
    badge:
      branch.frequencyMinHz != null && branch.frequencyMaxHz != null
        ? formatFrequencyRangeBoundsHz(
            branch.frequencyMinHz,
            branch.frequencyMaxHz,
          )
        : `${branch.points.length} points`,
    branchId: branch.branchId,
    calculationMode: "dispersion_modal" as const,
    icon: "wave" as const,
    resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
    status: "ready" as const,
  }));
  if (branchNodes.length === 0) return null;

  return {
    id,
    kind: "results.eigen.branches",
    label: "Branches",
    parentId,
    badge: `${branchNodes.length} tracked`,
    icon: "layers",
    resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
    status: "ready",
    children: branchNodes,
  };
}

function buildEigenModeNodes(
  parentId: string,
  spectrum: FrequencyDomainJsonArtifactResource | null | undefined,
  activeAnalysisFieldOverlay?: AnalysisFieldOverlayState | null,
): ExplorerNode[] {
  const model = buildEigenSpectrumChartModel(spectrum);
  return model.points.slice(0, 64).map((point) => {
    const modeIndex = point.rawModeIndex;
    const sampleIndex = point.sampleIndex;
    const hasModeField = point.modeFieldId != null;
    const activeAnalysisField = isActiveAnalysisField(
      activeAnalysisFieldOverlay,
      point.modeFieldId,
      "eigen-mode",
    );
    return {
      activeAnalysisField,
      id: `results:eigen:sample:${sampleIndex}:mode:${modeIndex}`,
      kind: "results.eigen.mode",
      label: `Sample ${sampleIndex} Mode ${modeIndex}`,
      parentId,
      badge: formatFrequencyHz(point.frequencyHz),
      branchId: point.branchId ?? undefined,
      contextCommands: hasModeField ? EIGEN_MODE_FIELD_3D_COMMANDS : undefined,
      fieldId: point.modeFieldId ?? undefined,
      icon: "wave",
      modeIndex,
      resourceRef:
        point.modeFieldResourceKey ?? ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
      sampleIndex,
      status: hasModeField ? "ready" : "stale",
    } satisfies ExplorerNode;
  });
}

function buildEigenModesVisualizationNode(
  parentId: string,
  spectrumModel: ReturnType<typeof buildEigenSpectrumChartModel>,
  activeAnalysisFieldOverlay?: AnalysisFieldOverlayState | null,
): ExplorerNode | null {
  const modeFieldPoints = spectrumModel.points.filter(
    (point) => point.modeFieldId != null,
  );
  const firstModeField = modeFieldPoints[0];
  if (!firstModeField) return null;
  return {
    id: `${parentId}:visualization`,
    kind: "results.eigen.modes.visualization",
    label: "Visualization",
    parentId,
    badge: `${modeFieldPoints.length} mode field(s)`,
    contextCommands: EIGEN_MODE_FIELD_3D_COMMANDS,
    activeAnalysisField: isActiveAnalysisField(
      activeAnalysisFieldOverlay,
      firstModeField.modeFieldId,
      "eigen-mode",
    ),
    fieldId: firstModeField.modeFieldId ?? undefined,
    icon: "wave",
    resourceRef:
      firstModeField.modeFieldResourceKey ??
      ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
    status: "ready",
  };
}

function buildFrequencyResponseResultNode(
  manifest: FrequencyDomainManifestResource | null | undefined,
  familyParentId: string,
  responseSweep: FrequencyDomainJsonArtifactResource | null | undefined,
  activeAnalysisFieldOverlay?: AnalysisFieldOverlayState | null,
): ExplorerNode {
  const parentId = "results:frequency-response";
  const progress = manifest?.response_progress;
  const cancelRequested = manifest?.response_cancel_requested;
  const responseModel = buildFrequencyResponseChartModel(responseSweep);
  const observableNodes = buildResponseObservableNodes(
    `${parentId}:observables`,
    responseSweep,
  );
  const frequencyPointNodes = buildResponseFrequencyPointNodes(
    `${parentId}:frequency-points`,
    manifest,
    responseSweep,
    progress?.completed_frequency_points ?? 0,
    activeAnalysisFieldOverlay,
  );
  return {
    id: parentId,
    kind: "results.frequency_response.root",
    label: "Driven Frequency Response",
    parentId: familyParentId,
    badge: manifest?.response.status ?? "missing",
    icon: "activity",
    status: "ready",
    children: compactExplorerNodes([
      {
        id: `${parentId}:study`,
        kind: "results.frequency_response.study",
        label: "Response Study",
        parentId,
        badge: manifest?.family_namespace ?? "frequencyDomain",
        icon: "settings",
        status: "ready",
      },
      responseModel.points.length > 0
        ? {
            id: `${parentId}:sweep`,
            kind: "results.frequency_response.sweep",
            label: "Sweep",
            parentId,
            badge: `${responseModel.points.length} point(s)`,
            icon: "wave",
            status: "ready",
          }
        : null,
      progress
        ? {
            id: `${parentId}:progress`,
            kind: "results.frequency_response.progress",
            label: "Sweep Progress",
            parentId,
            badge:
              frequencyDomainProgressBadge(progress) ??
              `${progress.completed_frequency_points}/${progress.total_frequency_points}`,
            icon: "gauge",
            status: progress.partial_artifacts_available
              ? "ready"
              : manifest
                ? "stale"
                : "unsupported",
          }
        : null,
      cancelRequested
        ? {
            id: `${parentId}:cancel-requested`,
            kind: "results.frequency_response.cancel_requested",
            label: "Cancel Requested",
            parentId,
            badge:
              frequencyDomainProgressBadge(cancelRequested) ??
              `${cancelRequested.completed_frequency_points}/${cancelRequested.total_frequency_points}`,
            icon: "gauge",
            status: cancelRequested.partial_artifacts_available
              ? "ready"
              : manifest
                ? "stale"
                : "unsupported",
            artifactPath: "response/cancel_requested.v1.json",
            resourceRef:
              ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
          }
        : null,
      frequencyPointNodes.length > 0
        ? {
            id: `${parentId}:frequency-points`,
            kind: "results.frequency_response.frequency_points",
            label: "Frequency Points",
            parentId,
            badge: `${frequencyPointNodes.length} listed`,
            icon: "layers",
            status: "ready",
            children: frequencyPointNodes,
          }
        : null,
      observableNodes.length > 0
        ? {
            id: `${parentId}:observables`,
            kind: "results.frequency_response.observables",
            label: "Observables",
            parentId,
            badge: `${observableNodes.length} observable(s)`,
            icon: "gauge",
            status: "ready",
            children: observableNodes,
          }
        : null,
      {
        id: `${parentId}:provenance`,
        kind: "results.frequency_response.provenance",
        label: "Provenance",
        parentId,
        badge: "manifest",
        icon: "file",
        status: manifest ? "ready" : "stale",
      },
    ]),
  };
}

function buildResponseObservableNodes(
  parentId: string,
  responseSweep: FrequencyDomainJsonArtifactResource | null | undefined,
): ExplorerNode[] {
  const model = buildFrequencyResponseChartModel(responseSweep);
  const groups = new Map<string, number>();
  for (const point of model.points) {
    groups.set(point.observableId, (groups.get(point.observableId) ?? 0) + 1);
  }
  return [...groups.entries()].slice(0, 64).map(([observableId, pointCount]) => ({
    id: `${parentId}:${observableId}`,
    kind: "results.frequency_response.observable",
    label: observableId,
    parentId,
    badge: `${pointCount} point(s)`,
    icon: "gauge",
    observableId,
    resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    status: "ready",
  }));
}

function buildResponseFrequencyPointNodes(
  parentId: string,
  manifest: FrequencyDomainManifestResource | null | undefined,
  responseSweep: FrequencyDomainJsonArtifactResource | null | undefined,
  completedFrequencyPoints: number,
  activeAnalysisFieldOverlay?: AnalysisFieldOverlayState | null,
): ExplorerNode[] {
  const model = buildFrequencyResponseChartModel(responseSweep);
  const fieldResources = responseFieldResourceMap(manifest);
  const frequencyPoints = new Map<
    number,
    { frequencyHz: number; observableCount: number }
  >();
  for (const point of model.points) {
    const frequencyIndex =
      point.frequencyIndex == null ? frequencyPoints.size : point.frequencyIndex;
    const existing = frequencyPoints.get(frequencyIndex);
    frequencyPoints.set(frequencyIndex, {
      frequencyHz: point.frequencyHz,
      observableCount: (existing?.observableCount ?? 0) + 1,
    });
  }
  const fromSweep = [...frequencyPoints.entries()].slice(0, 64);
  if (fromSweep.length > 0) {
    return fromSweep.map(([frequencyIndex, point]) =>
      responseFrequencyPointNode({
        badge: `frequency ${frequencyIndex}, ${point.observableCount} observable(s)`,
        fieldResources,
        frequencyHz: point.frequencyHz,
        frequencyIndex,
        parentId,
        activeAnalysisFieldOverlay,
      }),
    );
  }

  const count = Math.max(0, Math.min(completedFrequencyPoints, 64));
  return Array.from({ length: count }, (_, frequencyIndex) =>
    responseFrequencyPointNode({
      badge: "field-ready",
      fieldResources,
      frequencyIndex,
      parentId,
      activeAnalysisFieldOverlay,
    }),
  );
}

function responseFrequencyPointNode({
  activeAnalysisFieldOverlay,
  badge,
  fieldResources,
  frequencyHz,
  frequencyIndex,
  parentId,
}: {
  activeAnalysisFieldOverlay?: AnalysisFieldOverlayState | null;
  badge: string;
  fieldResources: Map<number, string>;
  frequencyHz?: number;
  frequencyIndex: number;
  parentId: string;
}): ExplorerNode {
  const fieldId = responseFieldId(fieldResources, frequencyIndex);
  const label =
    frequencyHz == null ? `Frequency ${frequencyIndex}` : formatFrequencyHz(frequencyHz);
  return {
    id: `${parentId}:${frequencyIndex}`,
    kind: "results.frequency_response.frequency_point",
    label,
    parentId,
    activeAnalysisField: isActiveAnalysisField(
      activeAnalysisFieldOverlay,
      fieldId,
      "frequency-response",
    ),
    badge,
    contextCommands: fieldId ? FREQUENCY_RESPONSE_FIELD_3D_COMMANDS : undefined,
    fieldId: fieldId ?? undefined,
    frequencyIndex,
    icon: "wave",
    resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    status: fieldId ? "ready" : "stale",
  };
}

export function buildFrequencyDomainResourceNodes(
  manifest: FrequencyDomainManifestResource | null | undefined,
  activeAnalysisFieldOverlay?: AnalysisFieldOverlayState | null,
): ExplorerNode[] {
  const parentId = "resources:analysis:frequency-domain";
  const status: ExplorerNodeStatus = manifest ? "ready" : "stale";
  return [
    {
      id: parentId,
      kind: "resources.analysis.frequency_domain",
      label: "Frequency Domain",
      parentId: "resources:root",
      badge: manifest ? manifest.schema_version : "missing",
      icon: "database",
      status,
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
      children: compactExplorerNodes([
        {
          id: `${parentId}:manifest`,
          kind: "resources.analysis.frequency_domain.manifest",
          label: "Manifest",
          parentId,
          badge: manifest ? "loaded" : "missing",
          icon: "file",
          status,
          resourceRef: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
        },
        frequencyDomainWorkflowResourceNode(
          parentId,
          "calculation-modes",
          "resources.analysis.frequency_domain.calculation_modes",
          "Calculation Modes",
          "workflow presets",
          "settings",
          status,
        ),
        frequencyDomainWorkflowResourceNode(
          parentId,
          "fmr",
          "resources.analysis.frequency_domain.fmr",
          "FMR",
          fmrBadge(manifest),
          "activity",
          fmrStatus(manifest),
        ),
        frequencyDomainWorkflowResourceNode(
          parentId,
          "dispersion",
          "resources.analysis.frequency_domain.dispersion",
          "Dispersion",
          manifest?.floquet_nonzero_k_demag_supported
            ? "demag-k supported"
            : "demag-k rejected",
          "wave",
          manifest?.floquet_nonzero_k_demag_supported ? "ready" : "unsupported",
        ),
        frequencyDomainWorkflowResourceNode(
          parentId,
          "response-map",
          "resources.analysis.frequency_domain.response_map",
          "Response Map",
          manifest?.floquet_nonzero_k_response_supported
            ? "available"
            : "unsupported",
          "gauge",
          manifest?.floquet_nonzero_k_response_supported
            ? "ready"
            : "unsupported",
        ),
        eigenResourceNode(parentId, "spectrum", "Eigen Spectrum", "wave", manifest),
        eigenResourceNode(parentId, "branches", "Eigen Branches", "layers", manifest),
        eigenResourceNode(parentId, "dispersion", "Eigen Dispersion", "wave", manifest),
        eigenResourceNode(parentId, "diagnostics", "Eigen Diagnostics", "gauge", manifest),
        eigenResourceNode(parentId, "mode-metadata", "Mode Metadata", "file", manifest),
        eigenResourceNode(
          parentId,
          "mode-field",
          "Mode Fields",
          "wave",
          manifest,
          activeAnalysisFieldOverlay,
        ),
        responseResourceNode(parentId, "sweep", "Response Sweep", "wave", manifest),
        responseResourceNode(
          parentId,
          "frequency-point",
          "Response Frequency Points",
          "layers",
          manifest,
        ),
        responseResourceNode(
          parentId,
          "field",
          "Response Fields",
          "wave",
          manifest,
          activeAnalysisFieldOverlay,
        ),
        responseResourceNode(
          parentId,
          "observables",
          "Response Observables",
          "gauge",
          manifest,
        ),
        responseResourceNode(
          parentId,
          "progress",
          "Response Progress",
          "gauge",
          manifest,
        ),
        responseResourceNode(
          parentId,
          "cancel-requested",
          "Response Cancel Requested",
          "gauge",
          manifest,
        ),
        responseResourceNode(
          parentId,
          "diagnostics",
          "Response Diagnostics",
          "gauge",
          manifest,
        ),
      ]),
    },
  ];
}

function frequencyDomainWorkflowResourceNode(
  parentId: string,
  key: string,
  kind: ExplorerNode["kind"],
  label: string,
  badge: string,
  icon: ExplorerNode["icon"],
  status: ExplorerNodeStatus,
): ExplorerNode {
  return {
    id: `${parentId}:${key}`,
    kind,
    label,
    parentId,
    badge,
    icon,
    resourceRef: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    status,
  };
}

export function buildPeriodicPairsResourceNode(): ExplorerNode {
  return {
    id: "resources:mesh:periodic-pairs",
    kind: "resources.mesh.periodic_pairs",
    label: "Periodic Pairs",
    parentId: "resources:mesh",
    badge: "periodic mesh",
    icon: "mesh",
    resourceRef: MESHING_PERIODIC_PAIRS_PATH,
    status: "stale",
  };
}

function compactExplorerNodes(
  nodes: Array<ExplorerNode | null | undefined>,
): ExplorerNode[] {
  return nodes.filter((node): node is ExplorerNode => node != null);
}

function eigenResourceNode(
  parentId: string,
  key: string,
  label: string,
  icon: ExplorerNode["icon"],
  manifest: FrequencyDomainManifestResource | null | undefined,
  activeAnalysisFieldOverlay?: AnalysisFieldOverlayState | null,
): ExplorerNode | null {
  const suffix = key.replace("-", "_");
  if (key === "mode-metadata") {
    const artifactPaths = manifestStringArray(
      manifest,
      "artifacts",
      "mode_metadata_paths",
    );
    if (artifactPaths.length === 0) return null;
    return {
      id: `resources:analysis:eigen:${key}`,
      kind: `resources.analysis.eigen.${suffix}` as ExplorerNode["kind"],
      label,
      parentId,
      badge:
        artifactPaths.length > 0
          ? `${artifactPaths.length} mode metadata`
          : "waiting for artifacts",
      icon,
      status:
        artifactPaths.length > 0 ? "ready" : manifest ? "stale" : "unsupported",
      artifactPath: artifactPaths[0],
      resourceRef: ANALYSIS_EIGEN_MODE_V2_PATH,
    };
  }
  if (key === "mode-field") {
    const resources = manifestStringArray(
      manifest,
      "resources",
      "mode_field_resources",
    );
    const metadataPaths = manifestStringArray(
      manifest,
      "artifacts",
      "mode_metadata_paths",
    );
    const ready = resources.length > 0 && metadataPaths.length > 0;
    if (resources.length === 0 && metadataPaths.length === 0) return null;
    return {
      id: `resources:analysis:eigen:${key}`,
      kind: `resources.analysis.eigen.${suffix}` as ExplorerNode["kind"],
      label,
      parentId,
      activeAnalysisField: isActiveAnalysisSource(
        activeAnalysisFieldOverlay,
        "eigen-mode",
      ),
      badge:
        ready
          ? `${resources.length} mode fields`
          : resources.length > 0
            ? "metadata missing"
          : "waiting for artifacts",
      icon,
      status: ready ? "ready" : manifest ? "stale" : "unsupported",
      resourceRef:
        resources[0] ?? ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH,
    };
  }
  const manifestRefs = eigenManifestRefs(key);
  const resourceRef = manifestRefs
    ? manifestString(manifest, "resources", manifestRefs.resourceKey) ??
      (manifestRefs.legacyResourceKey
        ? manifestString(manifest, "resources", manifestRefs.legacyResourceKey)
        : undefined) ??
      manifestRefs.fallbackResourceRef
    : undefined;
  const artifactPath = manifestRefs
    ? manifestString(manifest, "artifacts", manifestRefs.artifactKey) ??
      (manifestRefs.legacyArtifactKey
        ? manifestString(manifest, "artifacts", manifestRefs.legacyArtifactKey)
        : undefined)
    : undefined;
  if (!artifactPath) return null;
  return {
    id: `resources:analysis:eigen:${key}`,
    kind: `resources.analysis.eigen.${suffix}` as ExplorerNode["kind"],
    label,
    parentId,
    badge:
      key === "spectrum"
        ? availabilityBadge(manifest?.eigenmodes.modal_solver_available)
        : "waiting for artifacts",
    icon,
    status:
      key === "spectrum"
        ? availabilityStatus(manifest?.eigenmodes.modal_solver_available)
        : manifest
          ? "stale"
          : "unsupported",
    artifactPath,
    resourceRef,
  };
}

function eigenManifestRefs(key: string):
  | {
      artifactKey: string;
      fallbackResourceRef: string;
      legacyArtifactKey?: string;
      legacyResourceKey?: string;
      resourceKey: string;
    }
  | undefined {
  if (key === "spectrum") {
    return {
      artifactKey: "spectrum_v2_path",
      fallbackResourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
      resourceKey: "spectrum_resource_key",
    };
  }
  if (key === "branches") {
    return {
      artifactKey: "branches_v2_path",
      fallbackResourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
      resourceKey: "branches_resource_key",
    };
  }
  if (key === "dispersion") {
    return {
      artifactKey: "dispersion_csv_path",
      fallbackResourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
      resourceKey: "dispersion_resource_key",
    };
  }
  if (key === "diagnostics") {
    return {
      artifactKey: "eigen_diagnostics_v2_path",
      fallbackResourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DIAGNOSTICS_V2_PATH,
      resourceKey: "eigen_diagnostics_resource_key",
    };
  }
  return undefined;
}

function responseResourceNode(
  parentId: string,
  key: string,
  label: string,
  icon: ExplorerNode["icon"],
  manifest: FrequencyDomainManifestResource | null | undefined,
  activeAnalysisFieldOverlay?: AnalysisFieldOverlayState | null,
): ExplorerNode | null {
  const suffix = key.replace("-", "_");
  if (key === "frequency-point") {
    const pointPaths = manifestStringArray(
      manifest,
      "artifacts",
      "frequency_point_paths",
    );
    const frequencyIndex = frequencyIndexFromPointPath(pointPaths[0]) ?? 0;
    if (pointPaths.length === 0) return null;
    return {
      id: `resources:analysis:frequency-response:${key}`,
      kind: `resources.analysis.frequency_response.${suffix}` as ExplorerNode["kind"],
      label,
      parentId,
      badge:
        pointPaths.length > 0
          ? `${pointPaths.length} frequency points`
          : "waiting for artifacts",
      icon,
      status:
        pointPaths.length > 0 ? "ready" : manifest ? "stale" : "unsupported",
      artifactPath: pointPaths[0],
      resourceRef:
        ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH.replace(
          "{frequency_index}",
          String(frequencyIndex),
        ),
    };
  }
  if (key === "field") {
    const fieldResources = responseFieldResourcesFromManifest(
      frequencyDomainManifestPayload(manifest),
    );
    const firstFrequencyIndex = fieldResources[0]?.frequencyIndex;
    if (fieldResources.length === 0) return null;
    return {
      id: `resources:analysis:frequency-response:${key}`,
      kind: `resources.analysis.frequency_response.${suffix}` as ExplorerNode["kind"],
      label,
      parentId,
      activeAnalysisField: isActiveAnalysisSource(
        activeAnalysisFieldOverlay,
        "frequency-response",
      ),
      badge:
        fieldResources.length > 0
          ? `${fieldResources.length} response fields`
          : "waiting for artifacts",
      icon,
      status:
        fieldResources.length > 0 ? "ready" : manifest ? "stale" : "unsupported",
      artifactPath: fieldResources[0]?.payloadPath,
      resourceRef:
        firstFrequencyIndex === undefined
          ? ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH
          : ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH.replace(
              "{frequency_index}",
              String(firstFrequencyIndex),
            ),
    };
  }
  const manifestRefs = responseManifestRefs(key);
  const resourceRef = manifestRefs
    ? manifestString(manifest, "resources", manifestRefs.resourceKey) ??
      (manifestRefs.legacyResourceKey
        ? manifestString(manifest, "resources", manifestRefs.legacyResourceKey)
        : undefined) ??
      manifestRefs.fallbackResourceRef
    : undefined;
  const artifactPath = manifestRefs
    ? manifestString(manifest, "artifacts", manifestRefs.artifactKey) ??
      (manifestRefs.legacyArtifactKey
        ? manifestString(manifest, "artifacts", manifestRefs.legacyArtifactKey)
        : undefined)
    : undefined;
  if (!artifactPath) return null;
  return {
    id: `resources:analysis:frequency-response:${key}`,
    kind: `resources.analysis.frequency_response.${suffix}` as ExplorerNode["kind"],
    label,
    parentId,
    badge:
      key === "sweep" || key === "observables"
        ? availabilityBadge(manifest?.response.driven_response_available)
        : "waiting for artifacts",
    icon,
    status:
      key === "sweep" || key === "observables"
        ? availabilityStatus(manifest?.response.driven_response_available)
        : manifest
          ? "stale"
          : "unsupported",
    artifactPath,
    resourceRef,
  };
}

function frequencyIndexFromPointPath(path: string | undefined): number | null {
  const match = path?.match(/frequency_(\d+)\.json$/);
  if (!match) return null;
  return Number.parseInt(match[1] ?? "", 10);
}

function responseManifestRefs(key: string):
  | {
      artifactKey: string;
      fallbackResourceRef: string;
      legacyArtifactKey?: string;
      legacyResourceKey?: string;
      resourceKey: string;
    }
  | undefined {
  if (key === "sweep") {
    return {
      artifactKey: "response_sweep_v2_path",
      fallbackResourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
      legacyArtifactKey: "response_sweep_v1_path",
      resourceKey: "response_sweep_resource_key",
    };
  }
  if (key === "observables") {
    return {
      artifactKey: "response_sweep_v2_path",
      fallbackResourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
      legacyArtifactKey: "response_sweep_v1_path",
      resourceKey: "response_sweep_resource_key",
    };
  }
  if (key === "progress") {
    return {
      artifactKey: "response_progress_v1_path",
      fallbackResourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
      resourceKey: "response_progress_resource_key",
    };
  }
  if (key === "cancel-requested") {
    return {
      artifactKey: "response_cancel_requested_v1_path",
      fallbackResourceRef:
        ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
      resourceKey: "response_cancel_requested_resource_key",
    };
  }
  if (key === "diagnostics") {
    return {
      artifactKey: "response_diagnostics_v1_path",
      fallbackResourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
      legacyResourceKey: "diagnostics_resource_key",
      resourceKey: "response_diagnostics_resource_key",
    };
  }
  return undefined;
}

function manifestString(
  manifest: FrequencyDomainManifestResource | null | undefined,
  section: string,
  key: string,
): string | undefined {
  const payload = frequencyDomainManifestPayload(manifest);
  if (!isRecord(payload)) return undefined;
  const sectionValue = payload[section];
  if (!isRecord(sectionValue)) return undefined;
  const value = sectionValue[key];
  return typeof value === "string" ? value : undefined;
}

function manifestStringArray(
  manifest: FrequencyDomainManifestResource | null | undefined,
  section: string,
  key: string,
): string[] {
  const payload = frequencyDomainManifestPayload(manifest);
  if (!isRecord(payload)) return [];
  const sectionValue = payload[section];
  if (!isRecord(sectionValue)) return [];
  const value = sectionValue[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function responseFieldResourceMap(
  manifest: FrequencyDomainManifestResource | null | undefined,
): Map<number, string> {
  const fieldResources = new Map<number, string>();
  for (const entry of responseFieldResourcesFromManifest(
    frequencyDomainManifestPayload(manifest),
  )) {
    fieldResources.set(entry.frequencyIndex, entry.fieldResourceId);
  }
  return fieldResources;
}

function responseFieldId(
  fieldResources: Map<number, string>,
  frequencyIndex: number,
): string | null {
  return fieldResources.get(frequencyIndex) ?? null;
}

function isActiveAnalysisField(
  activeAnalysisFieldOverlay: AnalysisFieldOverlayState | null | undefined,
  fieldId: string | null | undefined,
  source: AnalysisFieldOverlayState["source"],
): boolean {
  return (
    Boolean(fieldId) &&
    activeAnalysisFieldOverlay?.fieldId === fieldId &&
    activeAnalysisFieldOverlay?.source === source
  );
}

function isActiveAnalysisSource(
  activeAnalysisFieldOverlay: AnalysisFieldOverlayState | null | undefined,
  source: AnalysisFieldOverlayState["source"],
): boolean {
  return activeAnalysisFieldOverlay?.source === source;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function buildFrequencyDomainJobsNode(
  resources: ExplorerTreeResources = {},
): ExplorerNode {
  const parentId = "jobs:frequency-domain";
  const manifest = resources.frequencyDomainManifest;
  const progress =
    resources.frequencyDomainResponseProgress ?? manifest?.response_progress ?? null;
  const cancelRequested =
    resources.frequencyDomainCancelRequested ??
    manifest?.response_cancel_requested ??
    null;
  const spectrumModel = buildEigenSpectrumChartModel(
    resources.frequencyDomainSpectrum,
  );
  const branchesModel = buildEigenBranchesModel(
    resources.frequencyDomainBranches,
  );
  const responseModel = buildFrequencyResponseChartModel(
    resources.frequencyDomainResponseSweep,
  );
  const jobStatus = frequencyDomainJobStatus(progress, cancelRequested);
  const progressBadge = frequencyDomainProgressBadge(progress);
  const completedFrequencyPoints =
    progress?.completed_frequency_points ??
    cancelRequested?.completed_frequency_points ??
    responseModel.points.length;
  const totalFrequencyPoints =
    progress?.total_frequency_points ??
    cancelRequested?.total_frequency_points ??
    responseModel.points.length;
  const hasExports =
    Boolean(resources.frequencyDomainSpectrum?.artifact_path) ||
    Boolean(resources.frequencyDomainBranches?.artifact_path) ||
    Boolean(resources.frequencyDomainDispersion?.artifact_path) ||
    Boolean(resources.frequencyDomainResponseSweep?.artifact_path) ||
    Boolean(manifest?.result_manifest?.artifact_path) ||
    Boolean(progress?.latest_artifact_manifest_path) ||
    Boolean(cancelRequested?.latest_artifact_manifest_path);
  return {
    id: parentId,
    kind: "jobs.frequency_domain.root",
    label: "Frequency Domain",
    parentId: "jobs:root",
    badge: progressBadge ?? (manifest ? "manifest loaded" : "waiting"),
    icon: "activity",
    status: jobStatus,
    children: [
      jobNode({
        badge: manifest?.schema_version ?? "waiting for manifest",
        icon: "play",
        kind: "jobs.frequency_domain.stage_run",
        key: "stage-run",
        label: "Stage Runs",
        parentId,
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
        status: manifest ? jobStatus : "stale",
      }),
      jobNode({
        badge:
          spectrumModel.points.length > 0
            ? `${spectrumModel.points.length} mode(s)`
            : branchesModel.branches.length > 0
              ? `${branchesModel.branches.length} branch(es)`
              : "waiting for modes",
        icon: "wave",
        kind: "jobs.frequency_domain.eigen_sample",
        key: "eigen-sample",
        label: "Eigen k-Samples",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
        parentId,
        status:
          spectrumModel.points.length > 0 || branchesModel.branches.length > 0
            ? "completed"
            : manifest
              ? "stale"
              : "unsupported",
      }),
      jobNode({
        badge:
          frequencyDomainProgressRangeBadge(progress ?? cancelRequested) ??
          (totalFrequencyPoints > 0
            ? `${completedFrequencyPoints}/${totalFrequencyPoints}`
            : responseModel.points.length > 0
              ? `${responseModel.points.length} point(s)`
              : "waiting for sweep"),
        icon: "activity",
        kind: "jobs.frequency_domain.response_frequency",
        key: "response-frequency",
        label: "Response Frequencies",
        parentId,
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
        status: progress ? jobStatus : responseModel.points.length > 0 ? "completed" : "stale",
      }),
      jobNode({
        badge: progressBadge ?? "not published",
        icon: "gauge",
        kind: "jobs.frequency_domain.response_progress",
        key: "response-progress",
        label: "Response Progress",
        parentId,
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
        status: progress ? jobStatus : "stale",
      }),
      jobNode({
        badge:
          progress?.latest_artifact_manifest_path ??
          cancelRequested?.latest_artifact_manifest_path ??
          (hasExports ? "artifacts ready" : "waiting for artifacts"),
        icon: "file",
        kind: "jobs.frequency_domain.artifact_export",
        key: "artifact-export",
        label: "Artifact Export",
        parentId,
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
        status: hasExports ? "ready" : manifest ? "stale" : "unsupported",
      }),
    ],
  };
}

function frequencyDomainProgressBadge(
  progress: FrequencyDomainSweepProgressResource | null | undefined,
): string | null {
  if (!progress) return null;
  const currentFrequency =
    progress.current_frequency_hz == null || progress.current_frequency_hz <= 0
      ? null
      : formatFrequencyHz(progress.current_frequency_hz);
  return [
    `${progress.completed_frequency_points}/${progress.total_frequency_points}`,
    progress.state,
    currentFrequency == null ? null : `@ ${currentFrequency}`,
    progress.demag_mode ?? null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

function frequencyDomainProgressRangeBadge(
  progress: FrequencyDomainSweepProgressResource | null | undefined,
): string | null {
  if (!progress) return null;
  const range = formatFrequencyRangeBoundsHz(
    progress.frequency_min_hz,
    progress.frequency_max_hz,
  );
  return range === "not available" ? null : range;
}

function frequencyDomainJobStatus(
  progress: FrequencyDomainSweepProgressResource | null | undefined,
  cancelRequested: FrequencyDomainSweepProgressResource | null | undefined,
): ExplorerNodeStatus {
  if (cancelRequested) return "cancelled";
  if (!progress) return "stale";
  const state = progress.state.trim().toLowerCase();
  if (progress.complete || state === "complete" || state === "completed") {
    return "completed";
  }
  if (state === "failed" || progress.status.trim().toLowerCase() === "failed") {
    return "failed";
  }
  if (state === "cancel_requested" || state === "cancelled") return "cancelled";
  if (state === "queued" || state === "pending") return "queued";
  if (state === "paused") return "paused";
  return "running";
}

function jobNode({
  badge,
  icon,
  key,
  kind,
  label,
  parentId,
  resourceRef,
  status,
}: {
  badge: string;
  icon: ExplorerNode["icon"];
  key: string;
  kind: ExplorerNode["kind"];
  label: string;
  parentId: string;
  resourceRef?: string;
  status: ExplorerNodeStatus;
}): ExplorerNode {
  return {
    id: `${parentId}:${key}`,
    kind,
    label,
    parentId,
    badge,
    icon,
    resourceRef,
    status,
  };
}

export function buildFrequencyDomainDiagnosticsNode(
  manifest: FrequencyDomainManifestResource | null | undefined,
): ExplorerNode {
  const parentId = "diagnostics:frequency-domain";
  return {
    id: parentId,
    kind: "diagnostics.frequency_domain.root",
    label: "Frequency Domain",
    parentId: "diagnostics:root",
    badge: manifest ? manifest.schema_version : "missing manifest",
    icon: "gauge",
    status: manifest ? "ready" : "stale",
    children: [
      diagnosticNode(parentId, "capabilities", "Capabilities", "capabilities", manifest),
      diagnosticNode(parentId, "equilibrium", "Equilibrium", "linearization", manifest),
      diagnosticNode(parentId, "operator", "Operator", "LLG tangent", manifest),
      diagnosticNode(parentId, "solver", "Solver", "modal / driven", manifest),
      diagnosticNode(parentId, "artifacts", "Artifacts", "manifest", manifest),
      diagnosticNode(parentId, "api-resources", "API Resources", "resource-first", manifest),
      diagnosticNode(parentId, "visualization", "Visualization", "3D mode fields", manifest),
      {
        id: `${parentId}:periodic-floquet`,
        kind: "diagnostics.frequency_domain.periodic_floquet",
        label: "Periodic / Floquet",
        parentId,
        badge: manifest?.floquet_nonzero_k_demag_supported
          ? "demag-k supported"
          : "demag-k rejected",
        icon: "wave",
        status: manifest?.floquet_nonzero_k_demag_supported
          ? "ready"
          : "unsupported",
      },
    ],
  };
}

function diagnosticNode(
  parentId: string,
  key: string,
  label: string,
  badge: string,
  manifest: FrequencyDomainManifestResource | null | undefined,
): ExplorerNode {
  const kind =
    `diagnostics.frequency_domain.${key.replace("-", "_")}` as ExplorerNode["kind"];
  return {
    id: `${parentId}:${key}`,
    kind,
    label,
    parentId,
    badge,
    icon: "gauge",
    status: manifest ? "ready" : "stale",
  };
}

function availabilityStatus(
  available: boolean | null | undefined,
): ExplorerNodeStatus {
  if (available === true) return "ready";
  if (available === false) return "unsupported";
  return "stale";
}

function availabilityBadge(available: boolean | null | undefined): string {
  if (available === true) return "available";
  if (available === false) return "unavailable";
  return "unknown";
}

function fmrBadge(
  manifest: FrequencyDomainManifestResource | null | undefined,
): string {
  if (!manifest) return "missing manifest";
  const modal = manifest.eigenmodes.modal_solver_available ? "modal" : null;
  const driven = manifest.response.driven_response_available ? "driven" : null;
  return [modal, driven].filter(Boolean).join(" + ") || "unavailable";
}

function fmrStatus(
  manifest: FrequencyDomainManifestResource | null | undefined,
): ExplorerNodeStatus {
  if (!manifest) return "stale";
  return manifest.eigenmodes.modal_solver_available ||
    manifest.response.driven_response_available
    ? "ready"
    : "unsupported";
}
