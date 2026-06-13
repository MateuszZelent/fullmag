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
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
  MESHING_PERIODIC_PAIRS_PATH,
} from "@/kernel/api/apiPaths";
import type {
  FrequencyDomainJsonArtifactResource,
  FrequencyDomainManifestResource,
  FrequencyDomainTextArtifactResource,
} from "@/kernel/api/apiTypes";
import {
  buildEigenBranchesModel,
  buildEigenDispersionChartModel,
  buildEigenSpectrumChartModel,
  buildFrequencyResponseChartModel,
  buildFmrPeakTableModel,
  responseFieldResourcesFromManifest,
} from "@/shared/domain/analysis/frequencyDomainChartModels";

import type { ExplorerNode, ExplorerNodeStatus } from "../explorerTypes";

const EIGEN_MODE_FIELD_3D_COMMANDS = [
  "analysis.eigen.plot-mode-3d",
  "analysis.eigen.plot-mode-3d-real",
  "analysis.eigen.plot-mode-3d-imag",
  "analysis.eigen.plot-mode-3d-amplitude",
  "analysis.eigen.plot-mode-3d-phase",
  "analysis.eigen.plot-mode-3d-phase-rotated-real",
];

const FREQUENCY_RESPONSE_FIELD_3D_COMMANDS = [
  "analysis.frequency-response.plot-response-field-3d",
  "analysis.frequency-response.plot-response-field-3d-real",
  "analysis.frequency-response.plot-response-field-3d-imag",
  "analysis.frequency-response.plot-response-field-3d-amplitude",
  "analysis.frequency-response.plot-response-field-3d-phase",
  "analysis.frequency-response.plot-response-field-3d-phase-rotated-real",
];

export interface ExplorerTreeResources {
  frequencyDomainBranches?: FrequencyDomainJsonArtifactResource | null;
  frequencyDomainDispersion?: FrequencyDomainTextArtifactResource | null;
  frequencyDomainManifest?: FrequencyDomainManifestResource | null;
  frequencyDomainResponseSweep?: FrequencyDomainJsonArtifactResource | null;
  frequencyDomainSpectrum?: FrequencyDomainJsonArtifactResource | null;
}

export function buildFrequencyDomainResultNode(
  manifest: FrequencyDomainManifestResource | null | undefined,
  branches?: FrequencyDomainJsonArtifactResource | null,
  dispersion?: FrequencyDomainTextArtifactResource | null,
  responseSweep?: FrequencyDomainJsonArtifactResource | null,
  spectrum?: FrequencyDomainJsonArtifactResource | null,
): ExplorerNode {
  const status: ExplorerNodeStatus = manifest ? "ready" : "stale";
  const parentId = "results:frequency-domain";
  return {
    id: parentId,
    kind: "results.frequency_domain.root",
    label: "Frequency Domain",
    parentId: "results:root",
    badge: manifest ? manifest.schema_version : "missing manifest",
    icon: "wave",
    status,
    children: [
      {
        id: `${parentId}:calculation-modes`,
        kind: "results.frequency_domain.calculation_modes",
        label: "Calculation Modes",
        parentId,
        badge: "FMR / dispersion",
        icon: "sparkles",
        status,
      },
      buildFrequencyDomainFmrNode({
        manifest,
        parentId,
        responseSweep,
        spectrum,
        status,
      }),
      {
        id: `${parentId}:dispersion`,
        kind: "results.frequency_domain.dispersion",
        label: "Dispersion",
        parentId,
        badge: manifest?.floquet_nonzero_k_demag_supported
          ? "Floquet demag-k"
          : "demag-k blocked",
        icon: "wave",
        status: manifest?.floquet_nonzero_k_demag_supported
          ? "ready"
          : "unsupported",
        children: [
          buildEigenKPathNode({
            dispersion,
            id: "results:eigen:k-path",
            manifest,
            parentId: `${parentId}:dispersion`,
          }),
          buildEigenBranchesNode({
            branches,
            id: `${parentId}:dispersion:branches`,
            manifest,
            parentId: `${parentId}:dispersion`,
          }),
        ],
      },
      {
        id: `${parentId}:response-map`,
        kind: "results.frequency_domain.response_map",
        label: "Response Map",
        parentId,
        badge: manifest?.floquet_nonzero_k_response_supported
          ? "Floquet response"
          : "response-k blocked",
        icon: "database",
        status: manifest?.floquet_nonzero_k_response_supported
          ? "stale"
          : "unsupported",
      },
      buildEigenResultNode(manifest, parentId, branches, dispersion, spectrum),
      buildFrequencyResponseResultNode(manifest, parentId, responseSweep),
      {
        id: `${parentId}:comparison`,
        kind: "results.frequency_domain.comparison",
        label: "Modal vs Driven Comparison",
        parentId,
        badge: "FMR",
        icon: "gauge",
        status: manifest ? "stale" : "unsupported",
      },
      {
        id: `${parentId}:exports`,
        kind: "results.frequency_domain.exports",
        label: "Exports",
        parentId,
        badge: "artifacts",
        icon: "file",
        status: manifest ? "ready" : "stale",
      },
    ],
  };
}

function buildEigenKPathNode({
  dispersion,
  id,
  manifest,
  parentId,
}: {
  dispersion: FrequencyDomainTextArtifactResource | null | undefined;
  id: string;
  manifest: FrequencyDomainManifestResource | null | undefined;
  parentId: string;
}): ExplorerNode {
  const model = buildEigenDispersionChartModel(dispersion);
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
  manifest,
  parentId,
  responseSweep,
  spectrum,
  status,
}: {
  manifest: FrequencyDomainManifestResource | null | undefined;
  parentId: string;
  responseSweep: FrequencyDomainJsonArtifactResource | null | undefined;
  spectrum: FrequencyDomainJsonArtifactResource | null | undefined;
  status: ExplorerNodeStatus;
}): ExplorerNode {
  const fmrPeaks = buildFmrPeakTableModel({ responseSweep, spectrum });
  const peakCount = fmrPeaks.peaks.length;
  return {
    id: `${parentId}:fmr`,
    kind: "results.frequency_domain.fmr",
    label: "FMR",
    parentId,
    badge: fmrBadge(manifest),
    icon: "activity",
    status,
    children: [
      {
        id: `${parentId}:fmr:modal-spectrum`,
        kind: "results.frequency_domain.fmr_modal_spectrum",
        label: "Modal FMR Spectrum",
        parentId: `${parentId}:fmr`,
        badge: availabilityBadge(manifest?.eigenmodes.modal_solver_available),
        icon: "wave",
        status: availabilityStatus(manifest?.eigenmodes.modal_solver_available),
      },
      {
        id: `${parentId}:fmr:response-sweep`,
        kind: "results.frequency_domain.fmr_response_sweep",
        label: "Driven FMR Sweep",
        parentId: `${parentId}:fmr`,
        badge: availabilityBadge(manifest?.response.driven_response_available),
        icon: "activity",
        status: availabilityStatus(manifest?.response.driven_response_available),
      },
      {
        artifactPath:
          responseSweep?.artifact_path ?? spectrum?.artifact_path ?? undefined,
        calculationMode: "fmr_response",
        id: `${parentId}:fmr:peaks`,
        kind: "results.frequency_domain.fmr_peaks",
        label: "FMR Peaks",
        parentId: `${parentId}:fmr`,
        badge: peakCount > 0 ? `${peakCount} peak(s)` : "waiting for artifacts",
        icon: "gauge",
        resourceRef: responseSweep
          ? ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH
          : spectrum
            ? ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH
            : undefined,
        status: peakCount > 0 ? "ready" : manifest ? "stale" : "unsupported",
      },
    ],
  };
}

function buildEigenResultNode(
  manifest: FrequencyDomainManifestResource | null | undefined,
  familyParentId: string,
  branches: FrequencyDomainJsonArtifactResource | null | undefined,
  dispersion: FrequencyDomainTextArtifactResource | null | undefined,
  spectrum: FrequencyDomainJsonArtifactResource | null | undefined,
): ExplorerNode {
  const parentId = "results:eigen";
  const available = manifest?.eigenmodes.modal_solver_available;
  const modeNodes = buildEigenModeNodes(`${parentId}:modes`, spectrum);
  const dispersionModel = buildEigenDispersionChartModel(dispersion);
  return {
    id: parentId,
    kind: "results.eigen.root",
    label: "Modal Eigen Results",
    parentId: familyParentId,
    badge: manifest?.eigenmodes.status ?? "missing",
    icon: "activity",
    status: availabilityStatus(available),
    children: [
      {
        id: `${parentId}:study`,
        kind: "results.eigen.study",
        label: "Eigen Study",
        parentId,
        badge: manifest?.eigen_namespace ?? "eigen",
        icon: "settings",
        status: availabilityStatus(available),
      },
      {
        id: `${parentId}:spectrum`,
        kind: "results.eigen.spectrum",
        label: "Spectrum",
        parentId,
        badge: availabilityBadge(available),
        icon: "wave",
        status: availabilityStatus(available),
      },
      {
        id: `${parentId}:modes`,
        kind: "results.eigen.modes",
        label: "Modes",
        parentId,
        badge:
          modeNodes.length > 0
            ? `${modeNodes.length} listed`
            : "waiting for metadata",
        icon: "layers",
        status:
          modeNodes.length > 0
            ? "ready"
            : available
              ? "stale"
              : "unsupported",
        children: modeNodes,
      },
      {
        id: `${parentId}:dispersion`,
        kind: "results.eigen.dispersion",
        label: "Dispersion",
        parentId,
        badge:
          dispersionModel.points.length > 0
            ? `${dispersionModel.points.length} point(s)`
            : manifest?.floquet_nonzero_k_demag_supported
              ? "Floquet"
              : "demag-k blocked",
        icon: "wave",
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
        status:
          dispersionModel.points.length > 0
            ? "ready"
            : manifest?.floquet_nonzero_k_demag_supported
              ? "stale"
              : "unsupported",
      },
      buildEigenBranchesNode({
        branches,
        id: `${parentId}:branches`,
        manifest,
        parentId,
      }),
      {
        id: `${parentId}:diagnostics`,
        kind: "results.eigen.diagnostics",
        label: "Diagnostics",
        parentId,
        badge: manifest?.eigenmodes.reason ?? "not reported",
        icon: "gauge",
        status: availabilityStatus(available),
      },
      {
        id: `${parentId}:provenance`,
        kind: "results.eigen.provenance",
        label: "Provenance",
        parentId,
        badge: "manifest",
        icon: "file",
        status: manifest ? "ready" : "stale",
      },
    ],
  };
}

function buildEigenBranchesNode({
  branches,
  id,
  manifest,
  parentId,
}: {
  branches: FrequencyDomainJsonArtifactResource | null | undefined;
  id: string;
  manifest: FrequencyDomainManifestResource | null | undefined;
  parentId: string;
}): ExplorerNode {
  const model = buildEigenBranchesModel(branches);
  const branchNodes = model.branches.slice(0, 64).map((branch) => ({
    id: `${id}:branch:${branch.branchId}`,
    kind: "results.eigen.branch" as const,
    label: branch.label ?? `Branch ${branch.branchId}`,
    parentId: id,
    badge:
      branch.frequencyMinHz != null && branch.frequencyMaxHz != null
        ? `${(branch.frequencyMinHz / 1e9).toFixed(3)}-${(branch.frequencyMaxHz / 1e9).toFixed(3)} GHz`
        : `${branch.points.length} points`,
    branchId: branch.branchId,
    calculationMode: "dispersion_modal" as const,
    icon: "wave" as const,
    resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
    status: "ready" as const,
  }));

  return {
    id,
    kind: "results.eigen.branches",
    label: "Branches",
    parentId,
    badge:
      branchNodes.length > 0
        ? `${branchNodes.length} tracked`
        : "waiting for artifacts",
    icon: "layers",
    resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
    status:
      branchNodes.length > 0
        ? "ready"
        : manifest?.eigenmodes.modal_solver_available
          ? "stale"
          : "unsupported",
    children: branchNodes,
  };
}

function buildEigenModeNodes(
  parentId: string,
  spectrum: FrequencyDomainJsonArtifactResource | null | undefined,
): ExplorerNode[] {
  const model = buildEigenSpectrumChartModel(spectrum);
  return model.points.slice(0, 64).map((point) => {
    const modeIndex = point.rawModeIndex;
    const sampleIndex = point.sampleIndex;
    return {
      id: `results:eigen:sample:${sampleIndex}:mode:${modeIndex}`,
      kind: "results.eigen.mode",
      label: `Sample ${sampleIndex} Mode ${modeIndex}`,
      parentId,
      badge: `${(point.frequencyHz / 1e9).toFixed(3)} GHz`,
      branchId: point.branchId ?? undefined,
      contextCommands: EIGEN_MODE_FIELD_3D_COMMANDS,
      fieldId:
        point.modeFieldId ??
        `analysis:eigen:sample-${String(sampleIndex).padStart(4, "0")}:mode-${String(modeIndex).padStart(4, "0")}`,
      icon: "wave",
      modeIndex,
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
      sampleIndex,
      status: "ready",
    } satisfies ExplorerNode;
  });
}

function buildFrequencyResponseResultNode(
  manifest: FrequencyDomainManifestResource | null | undefined,
  familyParentId: string,
  responseSweep: FrequencyDomainJsonArtifactResource | null | undefined,
): ExplorerNode {
  const parentId = "results:frequency-response";
  const available = manifest?.response.driven_response_available;
  const progress = manifest?.response_progress;
  const cancelRequested = manifest?.response_cancel_requested;
  const observableNodes = buildResponseObservableNodes(
    `${parentId}:observables`,
    responseSweep,
  );
  const frequencyPointNodes = buildResponseFrequencyPointNodes(
    `${parentId}:frequency-points`,
    manifest,
    responseSweep,
    progress?.completed_frequency_points ?? 0,
  );
  return {
    id: parentId,
    kind: "results.frequency_response.root",
    label: "Driven Frequency Response",
    parentId: familyParentId,
    badge: manifest?.response.status ?? "missing",
    icon: "activity",
    status: availabilityStatus(available),
    children: [
      {
        id: `${parentId}:study`,
        kind: "results.frequency_response.study",
        label: "Response Study",
        parentId,
        badge: manifest?.family_namespace ?? "frequencyDomain",
        icon: "settings",
        status: availabilityStatus(available),
      },
      {
        id: `${parentId}:sweep`,
        kind: "results.frequency_response.sweep",
        label: "Sweep",
        parentId,
        badge: availabilityBadge(available),
        icon: "wave",
        status: availabilityStatus(available),
      },
      {
        id: `${parentId}:progress`,
        kind: "results.frequency_response.progress",
        label: "Sweep Progress",
        parentId,
        badge: progress
          ? `${progress.completed_frequency_points}/${progress.total_frequency_points}`
          : "partial artifacts",
        icon: "gauge",
        status: progress?.partial_artifacts_available
          ? "ready"
          : manifest
            ? "stale"
            : "unsupported",
      },
      {
        id: `${parentId}:cancel-requested`,
        kind: "results.frequency_response.cancel_requested",
        label: "Cancel Requested",
        parentId,
        badge: cancelRequested
          ? `${cancelRequested.completed_frequency_points}/${cancelRequested.total_frequency_points}`
          : "not requested",
        icon: "gauge",
        status: cancelRequested?.partial_artifacts_available
          ? "ready"
          : manifest
            ? "stale"
            : "unsupported",
        artifactPath: cancelRequested
          ? "response/cancel_requested.v1.json"
          : undefined,
        resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
      },
      {
        id: `${parentId}:frequency-points`,
        kind: "results.frequency_response.frequency_points",
        label: "Frequency Points",
        parentId,
        badge:
          frequencyPointNodes.length > 0
            ? `${frequencyPointNodes.length} listed`
            : "waiting for artifacts",
        icon: "layers",
        status:
          frequencyPointNodes.length > 0
            ? "ready"
            : available
              ? "stale"
              : "unsupported",
        children: frequencyPointNodes,
      },
      {
        id: `${parentId}:observables`,
        kind: "results.frequency_response.observables",
        label: "Observables",
        parentId,
        badge:
          observableNodes.length > 0
            ? `${observableNodes.length} observable(s)`
            : "waiting for artifacts",
        icon: "gauge",
        status:
          observableNodes.length > 0
            ? "ready"
            : available
              ? "stale"
              : "unsupported",
        children: observableNodes,
      },
      {
        id: `${parentId}:diagnostics`,
        kind: "results.frequency_response.diagnostics",
        label: "Diagnostics",
        parentId,
        badge: manifest?.response.reason ?? "not reported",
        icon: "gauge",
        status: availabilityStatus(available),
      },
      {
        id: `${parentId}:provenance`,
        kind: "results.frequency_response.provenance",
        label: "Provenance",
        parentId,
        badge: "manifest",
        icon: "file",
        status: manifest ? "ready" : "stale",
      },
    ],
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
    return fromSweep.map(([frequencyIndex, point]) => ({
      id: `${parentId}:${frequencyIndex}`,
      kind: "results.frequency_response.frequency_point",
      label: `Frequency ${frequencyIndex}`,
      parentId,
      badge: `${(point.frequencyHz / 1e9).toFixed(3)} GHz, ${point.observableCount} observable(s)`,
      contextCommands: FREQUENCY_RESPONSE_FIELD_3D_COMMANDS,
      fieldId: responseFieldId(fieldResources, frequencyIndex),
      frequencyIndex,
      icon: "wave",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
      status: "ready",
    }));
  }

  const count = Math.max(0, Math.min(completedFrequencyPoints, 64));
  return Array.from({ length: count }, (_, frequencyIndex) => ({
    id: `${parentId}:${frequencyIndex}`,
    kind: "results.frequency_response.frequency_point",
    label: `Frequency ${frequencyIndex}`,
    parentId,
    badge: "field-ready",
    contextCommands: FREQUENCY_RESPONSE_FIELD_3D_COMMANDS,
    fieldId: responseFieldId(fieldResources, frequencyIndex),
    frequencyIndex,
    icon: "wave",
    resourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    status: "ready",
  }));
}

export function buildFrequencyDomainResourceNodes(
  manifest: FrequencyDomainManifestResource | null | undefined,
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
      children: [
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
        {
          id: `${parentId}:calculation-modes`,
          kind: "resources.analysis.frequency_domain.calculation_modes",
          label: "Calculation Modes",
          parentId,
          badge: "FMR / dispersion",
          icon: "sparkles",
          status,
        },
        {
          id: `${parentId}:fmr`,
          kind: "resources.analysis.frequency_domain.fmr",
          label: "FMR Resources",
          parentId,
          badge: fmrBadge(manifest),
          icon: "activity",
          status,
        },
        {
          id: `${parentId}:dispersion`,
          kind: "resources.analysis.frequency_domain.dispersion",
          label: "Dispersion Resources",
          parentId,
          badge: manifest?.floquet_nonzero_k_demag_supported
            ? "Floquet"
            : "demag-k blocked",
          icon: "wave",
          status: manifest?.floquet_nonzero_k_demag_supported
            ? "ready"
            : "unsupported",
        },
        {
          id: `${parentId}:response-map`,
          kind: "resources.analysis.frequency_domain.response_map",
          label: "Response Map Resources",
          parentId,
          badge: manifest?.floquet_nonzero_k_response_supported
            ? "Floquet response"
            : "response-k blocked",
          icon: "database",
          status: manifest?.floquet_nonzero_k_response_supported
            ? "stale"
            : "unsupported",
        },
        {
          id: "resources:mesh:periodic-pairs",
          kind: "resources.mesh.periodic_pairs",
          label: "Periodic Pairs",
          parentId,
          badge: "PBC/Floquet",
          icon: "layers",
          resourceRef: MESHING_PERIODIC_PAIRS_PATH,
          status: "stale",
        },
        eigenResourceNode(parentId, "spectrum", "Eigen Spectrum", "wave", manifest),
        eigenResourceNode(parentId, "branches", "Eigen Branches", "layers", manifest),
        eigenResourceNode(parentId, "dispersion", "Eigen Dispersion", "wave", manifest),
        eigenResourceNode(parentId, "diagnostics", "Eigen Diagnostics", "gauge", manifest),
        eigenResourceNode(parentId, "mode-metadata", "Mode Metadata", "file", manifest),
        eigenResourceNode(parentId, "mode-field", "Mode Fields", "wave", manifest),
        responseResourceNode(parentId, "sweep", "Response Sweep", "wave", manifest),
        responseResourceNode(
          parentId,
          "frequency-point",
          "Response Frequency Points",
          "layers",
          manifest,
        ),
        responseResourceNode(parentId, "field", "Response Fields", "wave", manifest),
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
      ],
    },
  ];
}

function eigenResourceNode(
  parentId: string,
  key: string,
  label: string,
  icon: ExplorerNode["icon"],
  manifest: FrequencyDomainManifestResource | null | undefined,
): ExplorerNode {
  const suffix = key.replace("-", "_");
  if (key === "mode-metadata") {
    const artifactPaths = manifestStringArray(
      manifest,
      "artifacts",
      "mode_metadata_paths",
    );
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
    return {
      id: `resources:analysis:eigen:${key}`,
      kind: `resources.analysis.eigen.${suffix}` as ExplorerNode["kind"],
      label,
      parentId,
      badge:
        resources.length > 0
          ? `${resources.length} mode fields`
          : "waiting for artifacts",
      icon,
      status: resources.length > 0 ? "ready" : manifest ? "stale" : "unsupported",
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
    ? manifestString(manifest, "artifacts", manifestRefs.artifactKey)
    : undefined;
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
): ExplorerNode {
  const suffix = key.replace("-", "_");
  if (key === "field") {
    const fieldResources = responseFieldResourcesFromManifest(
      manifest?.result_manifest?.payload,
    );
    const firstFrequencyIndex = fieldResources[0]?.frequencyIndex;
    return {
      id: `resources:analysis:frequency-response:${key}`,
      kind: `resources.analysis.frequency_response.${suffix}` as ExplorerNode["kind"],
      label,
      parentId,
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
    ? manifestString(manifest, "artifacts", manifestRefs.artifactKey)
    : undefined;
  return {
    id: `resources:analysis:frequency-response:${key}`,
    kind: `resources.analysis.frequency_response.${suffix}` as ExplorerNode["kind"],
    label,
    parentId,
    badge:
      key === "sweep"
        ? availabilityBadge(manifest?.response.driven_response_available)
        : "waiting for artifacts",
    icon,
    status:
      key === "sweep"
        ? availabilityStatus(manifest?.response.driven_response_available)
        : manifest
          ? "stale"
          : "unsupported",
    artifactPath,
    resourceRef,
  };
}

function responseManifestRefs(key: string):
  | {
      artifactKey: string;
      fallbackResourceRef: string;
      legacyResourceKey?: string;
      resourceKey: string;
    }
  | undefined {
  if (key === "sweep") {
    return {
      artifactKey: "response_sweep_v1_path",
      fallbackResourceRef: ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
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
  const payload = manifest?.result_manifest?.payload;
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
  const payload = manifest?.result_manifest?.payload;
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
    manifest?.result_manifest?.payload,
  )) {
    fieldResources.set(entry.frequencyIndex, entry.fieldResourceId);
  }
  return fieldResources;
}

function responseFieldId(
  fieldResources: Map<number, string>,
  frequencyIndex: number,
): string {
  return (
    fieldResources.get(frequencyIndex) ??
    `analysis:frequency-response:frequency-${String(frequencyIndex).padStart(4, "0")}`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function buildFrequencyDomainJobsNode(): ExplorerNode {
  const parentId = "jobs:frequency-domain";
  return {
    id: parentId,
    kind: "jobs.frequency_domain.root",
    label: "Frequency Domain",
    parentId: "jobs:root",
    badge: "modal / driven",
    icon: "activity",
    status: "ready",
    children: [
      jobNode(parentId, "stage-run", "jobs.frequency_domain.stage_run", "Stage Runs", "waiting", "play"),
      jobNode(parentId, "eigen-sample", "jobs.frequency_domain.eigen_sample", "Eigen k-Samples", "per sample", "wave"),
      jobNode(parentId, "response-frequency", "jobs.frequency_domain.response_frequency", "Response Frequencies", "per frequency", "activity"),
      jobNode(parentId, "response-progress", "jobs.frequency_domain.response_progress", "Response Progress", "partial artifacts", "gauge"),
      jobNode(parentId, "artifact-export", "jobs.frequency_domain.artifact_export", "Artifact Export", "exports", "file"),
    ],
  };
}

function jobNode(
  parentId: string,
  key: string,
  kind: ExplorerNode["kind"],
  label: string,
  badge: string,
  icon: ExplorerNode["icon"],
): ExplorerNode {
  return {
    id: `${parentId}:${key}`,
    kind,
    label,
    parentId,
    badge,
    icon,
    status: "stale",
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
