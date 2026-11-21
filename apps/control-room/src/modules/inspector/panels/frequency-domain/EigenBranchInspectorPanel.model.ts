import type { EigenBranchPoint, FrequencyDomainResultContext } from "@/shared/domain/analysis/frequencyDomainChartModels";
import { buildEigenBranchPointModeSelectionRef, eigenModeFieldAvailable, frequencyDomainManifestPayload, frequencyDomainResultContextFromManifest } from "@/shared/domain/analysis/frequencyDomainChartModels";
import type { FrequencyDomainJsonArtifactResource } from "@/kernel/api/apiTypes";
import type { SelectionRef } from "@/kernel/selection/selectionTypes";

export interface EigenBranchPointViewModel {
  branchId: string;
  fieldAvailable: boolean;
  frequencyHz: number;
  modeIndex: number;
  pointId: string;
  sampleIndex: number;
}

export interface EigenBranchModePlotHandoff {
  commandInput: Record<string, unknown>;
  selectionRef: Extract<SelectionRef, { type: "frequency-domain" }> & {
    frequencyHz: number;
    representation: "complex-vector-xyz";
  };
}

export type FrequencyDomainDatasetIdentity = Pick<
  Extract<SelectionRef, { type: "frequency-domain" }>,
  "datasetId" | "datasetRevision"
>;

export const EIGEN_MODE_FIELD_REPRESENTATION = "complex-vector-xyz" as const;

const EIGEN_MODE_FIELD_VIEW = "phase_rotated_real" as const;

export interface EigenBranchResultManifestOwner {
  artifactSetId: string;
  resultContext: FrequencyDomainResultContext;
  runId: string;
  sessionId: string;
  stageId: string;
}

export function buildEigenBranchResultManifestOwner(
  manifestResource: unknown,
): EigenBranchResultManifestOwner | null {
  const resultManifest = record(record(manifestResource)?.result_manifest);
  const payload = record(frequencyDomainManifestPayload(manifestResource));
  const sessionId = resultManifest?.session_id;
  const artifactSetId = resultManifest?.artifact_set_id;
  const runId = resultManifest?.run_id;
  const stageId = resultManifest?.stage_id;
  if (
    resultManifest?.status !== "ready" ||
    !payload ||
    !isNonEmptyString(sessionId) ||
    !isNonEmptyString(artifactSetId) ||
    !isNonEmptyString(runId) ||
    !isNonEmptyString(stageId)
  ) {
    return null;
  }

  return {
    artifactSetId,
    resultContext: frequencyDomainResultContextFromManifest({
      ...payload,
      // The owned resource envelope is authoritative over legacy payload placeholders.
      run_id: runId,
      stage_id: stageId,
    }),
    runId,
    sessionId,
    stageId,
  };
}

export function buildEigenBranchModePlotHandoff(
  branchId: string,
  point: EigenBranchPoint,
  resourceStatus: string,
  artifact: FrequencyDomainJsonArtifactResource | null | undefined,
  manifestStatus: string,
  manifestOwner: EigenBranchResultManifestOwner | null,
  datasetIdentity: FrequencyDomainDatasetIdentity = {},
): EigenBranchModePlotHandoff | null {
  const sessionId = artifact?.session_id;
  const artifactSetId = artifact?.artifact_set_id;
  const runId = artifact?.run_id;
  const stageId = artifact?.stage_id;
  const artifactRevision = artifact?.revision;
  const artifactPath = artifact?.artifact_path;
  const resourceRef = point.modeFieldResourceKey;
  const manifestContext = manifestOwner?.resultContext;
  const equilibriumId = manifestContext?.equilibriumId;
  const kContextKind = manifestContext?.classification?.kContext.kind;
  const studyProduct = manifestContext?.studyProduct;
  const wavevectorKf = point.wavevectorKf;
  if (
    !hasReadyOrRetainedSnapshot(resourceStatus) ||
    artifact?.status !== "ready" ||
    !hasReadyOrRetainedSnapshot(manifestStatus) ||
    !eigenModeFieldAvailable(point) ||
    !isNonEmptyString(sessionId) ||
    !isNonEmptyString(artifactSetId) ||
    !isNonEmptyString(runId) ||
    !isNonEmptyString(stageId) ||
    !isNonEmptyString(artifactRevision) ||
    !isNonEmptyString(artifactPath) ||
    !manifestOwner ||
    !manifestContext ||
    manifestOwner.sessionId !== sessionId ||
    manifestOwner.artifactSetId !== artifactSetId ||
    manifestOwner.runId !== runId ||
    manifestOwner.stageId !== stageId ||
    manifestContext.runId !== runId ||
    manifestContext.stageId !== stageId ||
    studyProduct !== "modal_eigen" ||
    !isNonEmptyString(equilibriumId) ||
    !kContextKind ||
    !isNonEmptyString(resourceRef) ||
    !isNonEmptyString(point.modeId) ||
    !isNonEmptyString(point.sampleId) ||
    !isNonNegativeInteger(point.sampleIndex) ||
    !isNonNegativeInteger(point.rawModeIndex) ||
    !Number.isFinite(point.frequencyRealHz)
  ) {
    return null;
  }
  if (
    (kContextKind === "fixed_k" ||
      kContextKind === "k_path" ||
      kContextKind === "k_grid") &&
    !isFiniteVector3(wavevectorKf)
  ) {
    return null;
  }
  if (
    kContextKind === "k_path" &&
    (point.pathS == null || !Number.isFinite(point.pathS))
  ) {
    return null;
  }
  if (
    kContextKind === "fixed_k" &&
    wavevectorKf?.every((component) => component === 0)
  ) {
    return null;
  }
  if (
    kContextKind === "gamma" &&
    wavevectorKf?.some((component) => Math.abs(component) > 1e-12)
  ) {
    return null;
  }

  const selectionRef = buildEigenBranchPointModeSelectionRef(
    branchId,
    point,
    {
      analysisRunId: runId,
      analysisStageId: stageId,
      artifactPath,
      artifactRevision,
      equilibriumId,
      kContextKind,
      normalization: manifestContext.normalization,
      representation: EIGEN_MODE_FIELD_REPRESENTATION,
      resourceRef,
      studyProduct,
      ...datasetIdentity,
    },
  );
  if (selectionRef.type !== "frequency-domain" || !selectionRef.fieldId) {
    return null;
  }

  return {
    commandInput: {
      artifactRevision,
      fieldId: selectionRef.fieldId,
      frequencyHz: point.frequencyRealHz,
      equilibriumId,
      kContextKind,
      kPathCoordinateRadPerM: point.pathS ?? undefined,
      label: `sample ${point.sampleIndex}, mode ${point.rawModeIndex}`,
      modeIndex: point.rawModeIndex,
      phaseRad: 0,
      representation: EIGEN_MODE_FIELD_REPRESENTATION,
      resourceRef,
      runId,
      sampleIndex: point.sampleIndex,
      source: "eigen-mode",
      stageId,
      studyProduct,
      normalization: manifestContext.normalization ?? undefined,
      view: EIGEN_MODE_FIELD_VIEW,
      wavevectorKf,
    },
    selectionRef: {
      ...selectionRef,
      frequencyHz: point.frequencyRealHz,
      representation: EIGEN_MODE_FIELD_REPRESENTATION,
    },
  };
}

export function buildEigenBranchPointViewModel(
  branchId: string,
  point: EigenBranchPoint,
): EigenBranchPointViewModel {
  return {
    branchId,
    fieldAvailable: eigenModeFieldAvailable(point),
    frequencyHz: point.frequencyRealHz,
    modeIndex: point.rawModeIndex,
    pointId: `results:eigen:branch:${branchId}:sample:${point.sampleIndex}:mode:${point.rawModeIndex}`,
    sampleIndex: point.sampleIndex,
  };
}

// Stale and failed-refresh hooks retain their last successful envelope.
// Availability and owner identity are checked separately before plotting.
export function hasReadyOrRetainedSnapshot(status: string): boolean {
  return status === "ready" || status === "stale" || status === "error";
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function isFiniteVector3(
  value: readonly [number, number, number] | null | undefined,
): value is readonly [number, number, number] {
  return value !== undefined && value !== null && value.every(Number.isFinite);
}
