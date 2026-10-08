import {
  classifyFrequencyDomainResult,
  type FrequencyDomainResultEvidence,
} from "@/shared/domain/analysis/frequencyDomainResultClassification";
import {
  frequencyDomainResultContextFromManifest,
  buildEigenDispersionChartModel,
  buildEigenSpectrumChartModel,
  enrichEigenSpectrumChartModelForFixedK,
  buildFrequencyResponseChartModel,
  eigenModeFieldAvailable,
  responseFieldResourcesFromManifest,
  type FrequencyDomainJsonArtifactLike,
  type FrequencyDomainTextArtifactLike,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import { fieldVectorResourceKey } from "@/kernel/api/fieldQueryIdentity";
import type {
  ArtifactResource,
  ObservationFrameListResource,
  TableListResource,
} from "@/kernel/api/apiTypes";
import {
  definePostprocessing,
  postprocessingCatalogState,
  postprocessingDefinitionFromArtifact,
  postprocessingDefinitionFromTable,
  POSTPROCESSING_OWNER_CONTRACT_GAP,
  type PostprocessingDefinition,
  type PostprocessingDefinitionInput,
  type PostprocessingCatalogSnapshot,
} from "@/shared/domain/analysis/postprocessingDefinitions";
import type {
  PostprocessingDefinitionKind,
  PostprocessingOwnerReadiness,
} from "@/shared/domain/analysis/postprocessingTypes";

import type { ExplorerNode, ExplorerNodeKind } from "../explorerTypes";

export interface PhysicsFirstResultProducts {
  coupling?: boolean;
  frequencyPoints?: boolean;
  modeBranches?: boolean;
  modeShapes?: boolean;
  peaks?: boolean;
  responseFields?: boolean;
  responseMap?: boolean;
  responseSpectrum?: boolean;
  spectrum?: boolean;
}

export interface PhysicsFirstResultEntry extends FrequencyDomainResultEvidence {
  analysisFieldTargets?: readonly PhysicsFirstAnalysisFieldTarget[];
  artifactRevision: number | string;
  products: PhysicsFirstResultProducts;
  stageLabel: string;
}

export interface PhysicsFirstAnalysisFieldTarget {
  branchId?: string;
  fieldId: string;
  frequencyHz: number;
  frequencyIndex?: number;
  kPathCoordinateRadPerM?: number;
  label: string;
  modeId?: string;
  modeIndex?: number;
  observableId?: string;
  representation: "complex-vector-xyz";
  resourceRef: string;
  sampleId?: string;
  sampleIndex?: number;
  source: "eigen-mode" | "frequency-response";
  view: "phase_rotated_real";
  wavevectorKf?: readonly [number, number, number];
}

export interface PhysicsFirstResultsSnapshot {
  contractGaps?: readonly string[];
  entries: readonly PhysicsFirstResultEntry[];
  observationFrames?: PostprocessingCatalogSnapshot<ObservationFrameListResource>;
  pinnedObservationFrameId?: string | null;
  postprocessing?: PhysicsFirstPostprocessingSnapshot;
  resultContextRunId: string;
}

export interface PhysicsFirstPostprocessingSnapshot {
  analysisViews?: readonly PostprocessingFamilyDefinition<"analysis_view">[];
  artifactCatalog?: PostprocessingCatalogSnapshot<readonly ArtifactResource[]>;
  derivedValues?: readonly PostprocessingFamilyDefinition<"derived_value">[];
  tableCatalog?: PostprocessingCatalogSnapshot<TableListResource>;
}

type PostprocessingFamilyDefinition<
  Kind extends "analysis_view" | "derived_value",
> = Omit<PostprocessingDefinitionInput, "kind"> & { kind: Kind };

interface ResultResourceLike {
  artifact_set_id?: string | null;
  content_digest?: string | null;
  mesh_generation_id?: string | null;
  revision?: number | string | null;
  run_id?: string | null;
  session_id?: string | null;
  stage_id?: string | null;
  status?: string;
}

interface ResultManifestLike extends ResultResourceLike {
  payload?: unknown;
}

export interface PhysicsFirstResultResourceInput {
  contractGaps?: readonly string[];
  artifacts?: PostprocessingCatalogSnapshot<readonly ArtifactResource[]>;
  branches?: ResultResourceLike | null;
  currentRun?: { revision: number | string; run_id: string } | null;
  dispersion?: (ResultResourceLike & { path_metadata?: unknown; text?: string | null }) | null;
  manifest?: { result_manifest?: ResultManifestLike | null } | null;
  observationFrames?: PostprocessingCatalogSnapshot<ObservationFrameListResource>;
  pinnedObservationFrameId?: string | null;
  responseSweep?: (ResultResourceLike & { payload?: unknown }) | null;
  spectrum?: (ResultResourceLike & { payload?: unknown }) | null;
  tableCatalog?: PostprocessingCatalogSnapshot<TableListResource>;
}

export interface PhysicsFirstResultAdaptation {
  contractGaps: string[];
  snapshot: PhysicsFirstResultsSnapshot;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function vector3(value: unknown): readonly [number, number, number] | null {
  return Array.isArray(value) && value.length === 3 && value.every((item) => finiteNumber(item) !== null)
    ? [value[0] as number, value[1] as number, value[2] as number]
    : null;
}

function ready(resource: ResultResourceLike | null | undefined): boolean {
  return resource?.status === "ready";
}

function jsonArtifact(
  resource: (ResultResourceLike & { payload?: unknown }) | null | undefined,
): FrequencyDomainJsonArtifactLike | null {
  return resource
    ? {
        artifact_set_id: resource.artifact_set_id,
        content_digest: resource.content_digest,
        mesh_generation_id: resource.mesh_generation_id,
        payload: resource.payload,
        revision: resource.revision == null ? null : String(resource.revision),
        run_id: resource.run_id,
        session_id: resource.session_id,
        stage_id: resource.stage_id,
        status: resource.status ?? "idle",
      }
    : null;
}

function dispersionArtifact(
  resource:
    | (ResultResourceLike & { path_metadata?: unknown; text?: string | null })
    | null
    | undefined,
): FrequencyDomainTextArtifactLike | null {
  return resource
    ? {
        artifact_set_id: resource.artifact_set_id,
        content_digest: resource.content_digest,
        ...(resource.path_metadata !== undefined
          ? {
              path_metadata: resource.path_metadata as FrequencyDomainTextArtifactLike["path_metadata"],
            }
          : {}),
        mesh_generation_id: resource.mesh_generation_id,
        revision: resource.revision == null ? null : String(resource.revision),
        run_id: resource.run_id,
        session_id: resource.session_id,
        stage_id: resource.stage_id,
        status: resource.status ?? "idle",
        text: resource.text,
      }
    : null;
}

function sampleCount(value: unknown): number | null {
  const count = finiteNumber(value);
  return count !== null && Number.isInteger(count) && count > 0 ? count : null;
}

function samplingFromRecord(
  sampling: Record<string, unknown> | null,
): FrequencyDomainResultEvidence["kSampling"] | null {
  if (!sampling) return null;
  const kind = nonEmptyString(sampling.kind) ??
    (sampling.path !== undefined ? "path" : sampling.grid !== undefined ? "grid" : null);
  if (kind === "single") {
    const vector = vector3(
      sampling.vector_rad_per_m ?? sampling.k_vector ?? sampling.vector,
    );
    return vector ? { kind: "single", vectorRadPerM: vector } : null;
  }
  if (kind === "grid") {
    const count =
      sampleCount(sampling.sample_count) ??
      sampleCount(sampling.sampleCount) ??
      sampleCount(sampling.count) ??
      sampleCount(sampling.points) ??
      (Array.isArray(sampling.points) ? sampleCount(sampling.points.length) : null);
    return count ? { kind: "grid", sampleCount: count } : null;
  }
  if (kind !== "path") return null;
  const points = Array.isArray(sampling.points) ? sampling.points : [];
  const segmentSamples = Array.isArray(sampling.samples_per_segment)
    ? sampling.samples_per_segment.filter((sample): sample is number => typeof sample === "number")
    : [];
  const labels = points
    .map((point) => nonEmptyString(record(point)?.label))
    .filter((label): label is string => label !== null);
  const count =
    segmentSamples.length > 0
      ? sampleCount(segmentSamples.reduce((sum, value) => sum + value, 1))
      : sampleCount(sampling.sample_count) ??
        sampleCount(sampling.sampleCount) ??
        sampleCount(sampling.count) ??
        sampleCount(sampling.points);
  if (!count) return null;
  return {
    kind: "path",
    label: labels.length > 1 ? labels.join("–") : undefined,
    sampleCount: count,
  };
}

function kSamplingFromMetadata(value: unknown): FrequencyDomainResultEvidence["kSampling"] | null {
  return samplingFromRecord(record(record(value)?.sampling));
}

function pathWavevectorAtSample(
  value: unknown,
  sampleIndex: number,
): readonly [number, number, number] | null {
  const sampling = record(record(value)?.sampling);
  if (sampling?.kind !== "path" || !Number.isInteger(sampleIndex) || sampleIndex < 0) {
    return null;
  }
  const points = Array.isArray(sampling.points)
    ? sampling.points.map((point) => vector3(record(point)?.k_vector))
    : [];
  const counts = Array.isArray(sampling.samples_per_segment)
    ? sampling.samples_per_segment.map(finiteNumber)
    : [];
  if (points.length < 2 || counts.some((count) => count === null || !Number.isInteger(count) || count <= 0)) {
    return null;
  }
  let segmentStart = 0;
  for (let segmentIndex = 0; segmentIndex < counts.length; segmentIndex += 1) {
    const count = counts[segmentIndex]!;
    if (sampleIndex > segmentStart + count) {
      segmentStart += count;
      continue;
    }
    const start = points[segmentIndex];
    const end = points[segmentIndex + 1] ?? (sampling.closed === true ? points[0] : null);
    if (!start || !end) return null;
    const fraction = (sampleIndex - segmentStart) / count;
    return [
      start[0] + (end[0] - start[0]) * fraction,
      start[1] + (end[1] - start[1]) * fraction,
      start[2] + (end[2] - start[2]) * fraction,
    ];
  }
  return null;
}

function gridWavevectorAtSample(
  value: unknown,
  sampleIndex: number,
): readonly [number, number, number] | null {
  const sampling = record(record(value)?.sampling);
  if (sampling?.kind !== "grid" || !Number.isInteger(sampleIndex) || sampleIndex < 0) {
    return null;
  }
  const points = Array.isArray(sampling.points) ? sampling.points : [];
  const point = points[sampleIndex];
  return vector3(point) ?? vector3(record(point)?.k_vector ?? record(point)?.vector_rad_per_m);
}

function kSamplingForFrequencyContext(
  sampling: NonNullable<FrequencyDomainResultEvidence["kSampling"]>,
): Record<string, unknown> {
  if (sampling.kind === "single") {
    return {
      kind: "single",
      vector_rad_per_m: sampling.vectorRadPerM,
    };
  }
  if (sampling.kind === "grid") {
    return {
      kind: "grid",
      sample_count: sampling.sampleCount,
    };
  }
  return {
    kind: "path",
    sample_count: sampling.sampleCount,
    ...(sampling.label ? { label: sampling.label } : {}),
  };
}

function modalFieldTargets({
  dispersion,
  kSampling,
  runId,
  spectrum,
  stageId,
}: {
  dispersion?: (ResultResourceLike & { path_metadata?: unknown; text?: string | null }) | null;
  kSampling?: FrequencyDomainResultEvidence["kSampling"];
  runId: string;
  spectrum?: (ResultResourceLike & { payload?: unknown }) | null;
  stageId: string;
}): PhysicsFirstAnalysisFieldTarget[] {
  if (kSampling?.kind === "path") {
    return buildEigenDispersionChartModel(dispersionArtifact(dispersion)).points.flatMap((point) => {
      if (
        !eigenModeFieldAvailable(point) ||
        !point.modeFieldId ||
        !point.modeFieldResourceKey
      ) return [];
      const wavevectorKf = point.wavevectorKf ??
        pathWavevectorAtSample(dispersion?.path_metadata, point.sampleIndex);
      if (!wavevectorKf || !Number.isFinite(point.pathS)) return [];
      return [{
        fieldId: point.modeFieldId,
        frequencyHz: point.frequencyHz,
        kPathCoordinateRadPerM: point.pathS,
        label: `Sample ${point.sampleIndex} · Mode ${point.rawModeIndex}`,
        ...(point.branchId != null ? { branchId: point.branchId } : {}),
        ...(point.modeId ? { modeId: point.modeId } : {}),
        modeIndex: point.rawModeIndex,
        representation: "complex-vector-xyz" as const,
        resourceRef: point.modeFieldResourceKey,
        ...(point.sampleId ? { sampleId: point.sampleId } : {}),
        sampleIndex: point.sampleIndex,
        source: "eigen-mode" as const,
        view: "phase_rotated_real" as const,
        wavevectorKf,
      }];
    });
  }
  const fixedWavevector = kSampling?.kind === "single" ? kSampling.vectorRadPerM : undefined;
  const spectrumData = jsonArtifact(spectrum);
  const spectrumModel = fixedWavevector
    ? enrichEigenSpectrumChartModelForFixedK({
        dispersion: dispersionArtifact(dispersion),
        expectedRunId: runId,
        expectedStageId: stageId,
        spectrum: spectrumData,
        wavevectorKf: fixedWavevector,
      })
    : buildEigenSpectrumChartModel(spectrumData);
  return spectrumModel.points.flatMap((point) => {
    if (
      !eigenModeFieldAvailable(point) ||
      !point.modeFieldId ||
      !point.modeFieldResourceKey
    ) return [];
    return [{
      fieldId: point.modeFieldId,
      frequencyHz: point.frequencyHz,
      label: `Sample ${point.sampleIndex} · Mode ${point.rawModeIndex}`,
      ...(point.branchId ? { branchId: point.branchId } : {}),
      ...(point.modeId ? { modeId: point.modeId } : {}),
      modeIndex: point.rawModeIndex,
      representation: "complex-vector-xyz" as const,
      resourceRef: point.modeFieldResourceKey,
      ...(point.sampleId ? { sampleId: point.sampleId } : {}),
      sampleIndex: point.sampleIndex,
      source: "eigen-mode" as const,
      view: "phase_rotated_real" as const,
      ...(fixedWavevector
        ? { wavevectorKf: fixedWavevector }
        : kSampling?.kind === "grid"
          ? (() => {
              const wavevectorKf = gridWavevectorAtSample(
                dispersion?.path_metadata,
                point.sampleIndex,
              );
              return wavevectorKf ? { wavevectorKf } : {};
            })()
          : {}),
    }];
  });
}

function responseFieldTargets(
  manifestPayload: unknown,
  responseSweep: (ResultResourceLike & { payload?: unknown }) | null | undefined,
  kSampling: FrequencyDomainResultEvidence["kSampling"] | undefined,
): PhysicsFirstAnalysisFieldTarget[] {
  const fieldIds = new Map(
    responseFieldResourcesFromManifest(manifestPayload).map((resource) => [
      resource.frequencyIndex,
      resource.fieldResourceId,
    ]),
  );
  const fixedWavevector = kSampling?.kind === "single" ? kSampling.vectorRadPerM : undefined;
  const seen = new Set<number>();
  return buildFrequencyResponseChartModel(jsonArtifact(responseSweep)).points.flatMap((point) => {
    if (point.frequencyIndex === null || seen.has(point.frequencyIndex)) return [];
    const fieldId = point.fieldId ?? fieldIds.get(point.frequencyIndex);
    if (!fieldId) return [];
    seen.add(point.frequencyIndex);
    return [{
      fieldId,
      frequencyHz: point.frequencyHz,
      frequencyIndex: point.frequencyIndex,
      label: `Frequency ${point.frequencyIndex}`,
      observableId: point.observableId,
      representation: "complex-vector-xyz" as const,
      resourceRef: fieldVectorResourceKey(fieldId),
      source: "frequency-response" as const,
      view: "phase_rotated_real" as const,
      ...(fixedWavevector ? { wavevectorKf: fixedWavevector } : {}),
    }];
  });
}

function observablesFromPayload(value: unknown): FrequencyDomainResultEvidence["observables"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const candidate = record(item);
    const kind = nonEmptyString(candidate?.kind);
    const identity = nonEmptyString(candidate?.identity);
    const unit = nonEmptyString(candidate?.unit);
    if (
      !identity ||
      !unit ||
      !kind ||
      !["absorbed_power", "drive_projected_response", "response_amplitude", "rf_coupling", "susceptibility"].includes(kind)
    ) {
      return [];
    }
    return [{ identity, kind, unit } as FrequencyDomainResultEvidence["observables"][number]];
  });
}

export function physicsFirstResultsSnapshotFromResources(
  input: PhysicsFirstResultResourceInput,
): PhysicsFirstResultAdaptation {
  const resultManifest = input.manifest?.result_manifest;
  const resultManifestReady = ready(resultManifest);
  const payload = resultManifestReady ? record(resultManifest?.payload) : null;
  const payloadRunId = nonEmptyString(payload?.run_id);
  const envelopeRunId = resultManifestReady ? nonEmptyString(resultManifest?.run_id) : null;
  const currentRunId = nonEmptyString(input.currentRun?.run_id);
  const runIds = [payloadRunId, envelopeRunId, currentRunId]
    .filter((runId): runId is string => runId !== null);
  const runIdentityMismatch = runIds.some((runId) => runId !== runIds[0]);
  const runId = currentRunId ?? envelopeRunId ?? payloadRunId ?? "";
  const contractGaps: string[] = [...(input.contractGaps ?? [])];
  const contractGapSet = new Set(contractGaps);
  const addContractGap = (gap: string) => {
    if (contractGapSet.has(gap)) return;
    contractGapSet.add(gap);
    contractGaps.push(gap);
  };
  const postprocessing =
    input.artifacts || input.tableCatalog
      ? {
          ...(input.artifacts ? { artifactCatalog: input.artifacts } : {}),
          ...(input.tableCatalog ? { tableCatalog: input.tableCatalog } : {}),
        }
      : undefined;
  const emptySnapshot: PhysicsFirstResultsSnapshot = {
    contractGaps,
    entries: [],
    ...(input.observationFrames ? { observationFrames: input.observationFrames } : {}),
    ...(input.pinnedObservationFrameId
      ? { pinnedObservationFrameId: input.pinnedObservationFrameId }
      : {}),
    ...(postprocessing ? { postprocessing } : {}),
    resultContextRunId: runId,
  };
  const selectedRunContextMismatch = contractGaps.some((gap) =>
    gap.startsWith("Selected run is not the current session run") ||
    gap.startsWith("Selected run result resources") ||
    gap.startsWith("Selected result run "),
  );
  if (selectedRunContextMismatch) return { contractGaps, snapshot: emptySnapshot };
  if (runIdentityMismatch) {
    addContractGap("Frequency-domain artifact run identity does not match its owner");
    return { contractGaps, snapshot: emptySnapshot };
  }
  if (!payload) return { contractGaps, snapshot: emptySnapshot };

  const metadataKSampling = kSamplingFromMetadata(input.dispersion?.path_metadata);
  const contextPayload = metadataKSampling
    ? { ...payload, k_sampling: kSamplingForFrequencyContext(metadataKSampling) }
    : payload;
  const frequencyContext = frequencyDomainResultContextFromManifest(contextPayload, {
    meshGenerationId: resultManifestReady
      ? nonEmptyString(resultManifest?.mesh_generation_id)
      : null,
    runId: envelopeRunId ?? currentRunId,
    stageId: resultManifestReady ? nonEmptyString(resultManifest?.stage_id) : null,
  });
  const resultRunId = frequencyContext.runId;
  const stageId = frequencyContext.stageId;
  const equilibriumId = frequencyContext.equilibriumId;
  const studyProduct = frequencyContext.studyProduct;
  const boundaryContext = frequencyContext.boundaryContext;
  const kSampling = metadataKSampling ?? frequencyContext.kSampling;

  const requiredGaps: Readonly<Record<string, string>> = {
    "boundary context unavailable": "Frequency-domain artifact does not publish boundary_context",
    "equilibrium identity unavailable": "Frequency-domain artifact does not publish equilibrium_identity",
    "run identity unavailable": "Frequency-domain artifact does not publish run identity",
    "stage identity unavailable": "Frequency-domain artifact does not publish stage_id",
    "study product unavailable": "Frequency-domain artifact does not publish study_product",
  };
  for (const gap of frequencyContext.contractGaps) {
    const mappedGap = requiredGaps[gap];
    if (mappedGap) addContractGap(mappedGap);
  }
  if (!resultRunId || !stageId || !equilibriumId || !studyProduct || !boundaryContext) {
    return { contractGaps, snapshot: emptySnapshot };
  }

  if (boundaryContext === "floquet_periodic" && !kSampling) {
    addContractGap("Periodic/Floquet artifact does not publish a supported k sampling resource");
    return {
      contractGaps,
      snapshot: { ...emptySnapshot, contractGaps: [...contractGaps] },
    };
  }
  for (const gap of frequencyContext.contractGaps) {
    if (!(gap in requiredGaps) && gap !== "k context unavailable") {
      addContractGap(gap);
    }
  }
  const artifactRevision =
    nonEmptyString(payload.revision) ??
    (resultManifestReady ? resultManifest?.revision : null) ??
    input.currentRun?.revision ??
    "unknown";
  const products: PhysicsFirstResultProducts =
    studyProduct === "modal_eigen"
      ? {
          ...(frequencyContext.classification?.fmrQualified
            ? { coupling: true }
            : {}),
          modeBranches: ready(input.branches),
          modeShapes: ready(input.spectrum),
          spectrum: ready(input.spectrum),
        }
      : {
          frequencyPoints: ready(input.responseSweep),
          peaks: ready(input.responseSweep),
          responseFields: ready(input.responseSweep),
          responseSpectrum: ready(input.responseSweep),
        };
  const drive = frequencyContext.evidence?.drive;
  const entry: PhysicsFirstResultEntry = {
    analysisFieldTargets:
      studyProduct === "modal_eigen"
        ? modalFieldTargets({
            dispersion: input.dispersion,
            ...(kSampling ? { kSampling } : {}),
            runId: resultRunId,
            spectrum: input.spectrum,
            stageId,
          })
        : responseFieldTargets(payload, input.responseSweep, kSampling ?? undefined),
    artifactRevision,
    boundaryContext,
    ...(drive ? { drive } : {}),
    equilibriumId,
    ...(kSampling ? { kSampling } : {}),
    observables: observablesFromPayload(payload.observables),
    ...(frequencyContext.normalization ? { normalization: frequencyContext.normalization } : {}),
    products,
    runId: resultRunId,
    stageId,
    stageLabel: nonEmptyString(payload.stage_label) ?? stageId,
    studyProduct,
  };

  return {
    contractGaps,
    snapshot: {
      contractGaps: [...contractGaps],
      entries: [entry],
      ...(input.observationFrames ? { observationFrames: input.observationFrames } : {}),
      ...(input.pinnedObservationFrameId
        ? { pinnedObservationFrameId: input.pinnedObservationFrameId }
        : {}),
      ...(postprocessing ? { postprocessing } : {}),
      resultContextRunId: resultRunId,
    },
  };
}

function key(identity: string): string {
  return encodeURIComponent(identity);
}

function observationFramesRoot(
  parentId: string,
  snapshot: PhysicsFirstResultsSnapshot,
): ExplorerNode {
  const id = `${parentId}:observation-frames`;
  const resource = snapshot.observationFrames;
  const frames = resource?.data?.frames ?? [];
  const resourceReady = resource?.status === "ready" && resource.data !== null;
  const resourceFailed = resource?.status === "error";
  const children = frames.map((frame) => {
    const pinned = frame.frame_id === snapshot.pinnedObservationFrameId;
    return node(
      `${id}:${key(frame.frame_id)}`,
      "results.observation_frame",
      `Step ${frame.accepted_state_ref.id.accepted_step}`,
      id,
      {
        badge: pinned ? "pinned" : frame.stage_id,
        icon: "database",
        observationFrame: frame,
      },
    );
  });
  return node(id, "results.observation_frames.root", "State snapshots", parentId, {
    availability: resourceReady ? "available" : "unavailable",
    badge: resourceReady ? String(frames.length) : resourceFailed ? "error" : "loading",
    children,
    executionState: resourceReady ? "completed" : "not_started",
    resourceState: resource?.status ?? "idle",
    status: resourceFailed ? "failed" : resourceReady ? "ready" : "unavailable",
  });
}

function node(
  id: string,
  kind: ExplorerNodeKind,
  label: string,
  parentId: string | null,
  overrides: Partial<ExplorerNode> = {},
): ExplorerNode {
  return {
    availability: "available",
    executionState: "completed",
    icon: "folder",
    id,
    kind,
    label,
    parentId,
    resourceState: "ready",
    status: "ready",
    ...overrides,
  };
}

function leaf(
  stageId: string,
  suffix: string,
  kind: ExplorerNodeKind,
  label: string,
  entry: PhysicsFirstResultEntry,
  overrides: Partial<ExplorerNode> = {},
): ExplorerNode {
  const classification = classifyFrequencyDomainResult(entry);
  return node(`${stageId}:${suffix}`, kind, label, stageId, {
    analysisRunId: entry.runId,
    analysisStageId: entry.stageId,
    artifactRevision: entry.artifactRevision,
    badge: String(entry.artifactRevision),
    equilibriumId: entry.equilibriumId,
    kContextKind: classification.kContext.kind,
    resourceRef: `artifact-revision:${entry.artifactRevision}`,
    ...(entry.normalization ? { normalization: entry.normalization } : {}),
    studyProduct: entry.studyProduct,
    ...overrides,
  });
}

function analysisFieldTargetNodes(
  parentId: string,
  entry: PhysicsFirstResultEntry,
  kind:
    | "results.dispersion.driven.field_at_k"
    | "results.dispersion.modal.mode_at_k"
    | "results.resonance.driven.field"
    | "results.resonance.modal.mode",
): ExplorerNode[] {
  const classification = classifyFrequencyDomainResult(entry);
  return (entry.analysisFieldTargets ?? []).map((target) =>
    node(
      `${parentId}:${target.source}:${key(target.fieldId)}`,
      kind,
      target.label,
      parentId,
      {
        analysisFieldRepresentation: target.representation,
        analysisFieldSource: target.source,
        analysisFieldView: target.view,
        analysisRunId: entry.runId,
        analysisStageId: entry.stageId,
        artifactRevision: entry.artifactRevision,
        equilibriumId: entry.equilibriumId,
        fieldId: target.fieldId,
        frequencyHz: target.frequencyHz,
        ...(target.frequencyIndex !== undefined
          ? { frequencyIndex: target.frequencyIndex }
          : {}),
        kContextKind: classification.kContext.kind,
        ...(target.kPathCoordinateRadPerM !== undefined
          ? { kPathCoordinateRadPerM: target.kPathCoordinateRadPerM }
          : {}),
        ...(target.branchId ? { branchId: target.branchId } : {}),
        ...(target.modeId ? { modeId: target.modeId } : {}),
        ...(target.modeIndex !== undefined ? { modeIndex: target.modeIndex } : {}),
        ...(target.observableId ? { observableId: target.observableId } : {}),
        resourceRef: target.resourceRef,
        ...(entry.normalization ? { normalization: entry.normalization } : {}),
        ...(target.sampleId ? { sampleId: target.sampleId } : {}),
        ...(target.sampleIndex !== undefined ? { sampleIndex: target.sampleIndex } : {}),
        studyProduct: entry.studyProduct,
        ...(target.wavevectorKf ? { wavevectorKf: target.wavevectorKf } : {}),
      },
    ),
  );
}

function resultProvenanceNode(
  family: "resonance" | "dispersion",
  studyProduct: PhysicsFirstResultEntry["studyProduct"],
): { kind: ExplorerNodeKind; label: string } {
  if (family === "resonance") {
    return studyProduct === "modal_eigen"
      ? {
          kind: "results.resonance.modal.provenance",
          label: "Modal Equilibrium & Provenance",
        }
      : {
          kind: "results.resonance.driven.provenance",
          label: "Driven Equilibrium & Provenance",
        };
  }

  return studyProduct === "modal_eigen"
    ? {
        kind: "results.dispersion.modal.provenance",
        label: "Modal Dispersion Provenance",
      }
    : {
        kind: "results.dispersion.driven.provenance",
        label: "Driven Response-Map Provenance",
      };
}

function hasPublishedProduct(products: PhysicsFirstResultProducts): boolean {
  return Object.values(products).some(Boolean);
}

function resonanceStage(
  rootId: string,
  entry: PhysicsFirstResultEntry,
): ExplorerNode | null {
  if (!hasPublishedProduct(entry.products)) return null;
  const classification = classifyFrequencyDomainResult(entry);
  if (classification.family !== "resonance") return null;
  const method = entry.studyProduct === "modal_eigen" ? "Modal" : "Driven";
  const stageId = `${rootId}:stage:${key(entry.stageId)}:${entry.studyProduct}`;
  const children: ExplorerNode[] = [];

  if (entry.studyProduct === "modal_eigen") {
    if (entry.products.spectrum) {
      children.push(
        leaf(
          stageId,
          "spectrum",
          "results.resonance.modal.spectrum",
          classification.resultLabel,
          entry,
        ),
      );
    }
    if (entry.products.modeShapes) {
      const parentId = `${stageId}:modes`;
      children.push(leaf(stageId, "modes", "results.resonance.modal.modes", "Mode Shapes", entry, {
        children: analysisFieldTargetNodes(
          parentId,
          entry,
          "results.resonance.modal.mode",
        ),
      }));
    }
    if (entry.products.coupling && classification.fmrQualified) {
      children.push(
        leaf(
          stageId,
          "rf-coupling",
          "results.resonance.modal.coupling",
          "RF Coupling / FMR Activity",
          entry,
        ),
      );
    }
  } else {
    if (entry.products.responseSpectrum) {
      children.push(
        leaf(
          stageId,
          "response-spectrum",
          "results.resonance.driven.spectrum",
          classification.resultLabel,
          entry,
        ),
      );
    }
    if (entry.products.peaks) {
      children.push(leaf(stageId, "peaks", "results.resonance.driven.peaks", "Resonance Peaks", entry));
    }
    if (entry.products.frequencyPoints) {
      children.push(
        leaf(stageId, "frequency-points", "results.resonance.driven.frequency_points", "Frequency Points", entry),
      );
    }
    if (entry.products.responseFields) {
      const parentId = `${stageId}:response-fields`;
      children.push(
        leaf(stageId, "response-fields", "results.resonance.driven.fields", "Response Fields", entry, {
          children: analysisFieldTargetNodes(
            parentId,
            entry,
            "results.resonance.driven.field",
          ),
        }),
      );
    }
  }
  const provenance = resultProvenanceNode("resonance", entry.studyProduct);
  children.push(leaf(stageId, "provenance", provenance.kind, provenance.label, entry));

  return node(
    stageId,
    entry.studyProduct === "modal_eigen"
      ? "results.resonance.modal.stage"
      : "results.resonance.driven.stage",
    `${entry.stageLabel} · ${method}`,
    rootId,
    {
    analysisRunId: entry.runId,
    analysisStageId: entry.stageId,
    artifactRevision: entry.artifactRevision,
    badge: classification.kContext.label,
    children,
    equilibriumId: entry.equilibriumId,
    kContextKind: classification.kContext.kind,
    studyProduct: entry.studyProduct,
    },
  );
}

function kResolvedStage(
  rootId: string,
  entry: PhysicsFirstResultEntry,
): ExplorerNode | null {
  if (!hasPublishedProduct(entry.products)) return null;
  const classification = classifyFrequencyDomainResult(entry);
  if (classification.family !== "k_resolved") return null;
  const method = entry.studyProduct === "modal_eigen" ? "Modal" : "Driven";
  const stageId = `${rootId}:stage:${key(entry.stageId)}:${entry.studyProduct}`;
  const children: ExplorerNode[] = [
    leaf(stageId, "k-sampling", "results.dispersion.k_sampling", classification.kContext.label, entry),
  ];

  if (entry.studyProduct === "modal_eigen") {
    if (entry.products.spectrum || entry.products.modeBranches) {
      children.push(
        leaf(stageId, "dispersion", "results.dispersion.modal.relation", classification.resultLabel, entry),
      );
    }
    if (entry.products.modeBranches) {
      children.push(leaf(stageId, "branches", "results.dispersion.modal.branches", "Mode Branches", entry));
    }
    if (entry.products.modeShapes) {
      const parentId = `${stageId}:modes-at-k`;
      children.push(leaf(stageId, "modes-at-k", "results.dispersion.modal.modes_at_k", "Modes at k", entry, {
        children: analysisFieldTargetNodes(
          parentId,
          entry,
          "results.dispersion.modal.mode_at_k",
        ),
      }));
    }
  } else if (entry.products.responseMap) {
    const parentId = `${stageId}:response-map`;
    children.push(
      leaf(stageId, "response-map", "results.dispersion.driven.response_map", classification.resultLabel, entry, {
        children: analysisFieldTargetNodes(
          parentId,
          entry,
          "results.dispersion.driven.field_at_k",
        ),
      }),
    );
  }
  const provenance = resultProvenanceNode("dispersion", entry.studyProduct);
  children.push(leaf(stageId, "provenance", provenance.kind, provenance.label, entry));

  return node(
    stageId,
    entry.studyProduct === "modal_eigen"
      ? "results.dispersion.modal.stage"
      : "results.dispersion.driven.stage",
    `${entry.stageLabel} · ${method}`,
    rootId,
    {
    analysisRunId: entry.runId,
    analysisStageId: entry.stageId,
    artifactRevision: entry.artifactRevision,
    badge: classification.kContext.label,
    children,
    equilibriumId: entry.equilibriumId,
    kContextKind: classification.kContext.kind,
    studyProduct: entry.studyProduct,
    },
  );
}

function rootWithChildren(
  id: string,
  kind: ExplorerNodeKind,
  label: string,
  parentId: string,
  children: readonly (ExplorerNode | null)[],
): ExplorerNode {
  const materializedChildren = children.filter(
    (child): child is ExplorerNode => child !== null,
  );
  return node(id, kind, label, parentId, {
    children: materializedChildren,
    ...(materializedChildren.length === 0
      ? {
          availability: "unavailable" as const,
          executionState: "not_started" as const,
          resourceState: "idle" as const,
          status: "unavailable" as const,
        }
      : {}),
  });
}

function postprocessingChildren(
  parentId: string,
  kind: PostprocessingDefinition["kind"],
  definitions: readonly PostprocessingDefinition[],
): ExplorerNode[] {
  const nodeKind = `results.${kind === "analysis_view" ? "analysis_views" : kind === "derived_value" ? "derived_values" : kind === "table" ? "tables" : "exports"}.definition` as ExplorerNodeKind;
  return definitions
    .filter((definition) => definition.kind === kind)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((definition) => {
      const available = definition.ownerReadiness === "available-ready" &&
        definition.availability === "available" &&
        definition.owner !== null;
      const owner = definition.owner;
      const status = postprocessingNodeStatus(definition.ownerReadiness);
      const tableAction = available && definition.kind === "table" && owner?.kind === "table"
        ? {
            contextCommands: ["analysis-plots.open" as const],
            contextCommandInputs: {
              "analysis-plots.open": {
                datasetRef: definition.datasetRef,
                surface: "dynamics" as const,
                tableId: owner.tableId,
              },
            },
          }
        : {};
      return node(
        `${parentId}:${key(definition.id)}`,
        nodeKind,
        definition.label,
        parentId,
        {
          artifactPath: owner?.kind === "artifact" ? owner.path : undefined,
          availability: available ? "available" : "unavailable",
          badge: available ? "published" : postprocessingReadinessBadge(definition.ownerReadiness),
          executionState: available ? "completed" : "not_started",
          postprocessingCatalogRevision: definition.catalogRevision,
          postprocessingContractGap: definition.contractGap,
          postprocessingDefinitionKind: definition.kind,
          postprocessingFreshness: definition.freshness,
          postprocessingOwnerId:
            owner?.kind === "table"
              ? owner.tableId
              : owner?.kind === "artifact"
                ? owner.path
                : null,
          postprocessingOwnerKind: owner?.kind ?? null,
          postprocessingOwnerReadiness: definition.ownerReadiness,
          postprocessingResourceRevision: definition.resourceRevision ?? null,
          postprocessingSchemaRevision:
            owner?.kind === "table" ? owner.schemaRevision : null,
          ...(owner?.kind === "table" ? { tableId: owner.tableId } : {}),
          ...(owner?.kind === "artifact"
            ? { postprocessingArtifactKind: owner.artifactKind }
            : {}),
          ...(definition.datasetRef
            ? { resourceRef: definition.datasetRef }
            : {}),
          resourceState: definition.resourceStatus,
          status,
          ...tableAction,
        },
      );
    });
}

function unavailableDefinition(
  kind: PostprocessingDefinition["kind"],
  state?: ReturnType<typeof postprocessingCatalogState>,
): PostprocessingDefinition {
  const labels: Record<PostprocessingDefinition["kind"], string> = {
    analysis_view: "Analysis Views unavailable",
    derived_value: "Derived Values unavailable",
    export: "Exports unavailable",
    table: "Tables unavailable",
  };
  return definePostprocessing({
    id: `${kind}:contract-gap`,
    kind,
    label: labels[kind],
    ...(state ? { contractGap: state.reason, ownerState: state } : {}),
  });
}

function postprocessingNodeStatus(
  readiness: PostprocessingOwnerReadiness,
): ExplorerNode["status"] {
  if (readiness === "available-ready") return "ready";
  if (readiness === "loading") return "warning";
  if (readiness === "stale") return "stale";
  if (readiness === "error") return "failed";
  return "unavailable";
}

function postprocessingReadinessBadge(
  readiness: PostprocessingOwnerReadiness,
): string {
  if (readiness === "loading") return "loading";
  if (readiness === "stale") return "stale";
  if (readiness === "error") return "error";
  return "contract gap";
}

function postprocessingRootState(
  kind: PostprocessingDefinitionKind,
  catalog: PostprocessingCatalogSnapshot<unknown> | null | undefined,
) {
  if (kind === "analysis_view" || kind === "derived_value") {
    return {
      freshness: "unknown" as const,
      readiness: "unavailable" as const,
      reason: POSTPROCESSING_OWNER_CONTRACT_GAP,
      revision: null,
      status: "error" as const,
    };
  }
  return postprocessingCatalogState(catalog, kind === "table" ? "Table" : "Artifact");
}

function postprocessingRootWithChildren(
  id: string,
  explorerKind: ExplorerNodeKind,
  label: string,
  parentId: string,
  kind: PostprocessingDefinitionKind,
  catalog: PostprocessingCatalogSnapshot<unknown> | null | undefined,
  children: readonly ExplorerNode[],
): ExplorerNode {
  const state = postprocessingRootState(kind, catalog);
  const available = state.readiness === "available-ready";
  return node(id, explorerKind, label, parentId, {
    availability: available ? "available" : "unavailable",
    children: [...children],
    executionState: available ? "completed" : "not_started",
    postprocessingCatalogRevision: state.revision,
    postprocessingContractGap: state.reason,
    postprocessingDefinitionKind: kind,
    postprocessingFreshness: state.freshness,
    postprocessingOwnerReadiness: state.readiness,
    resourceState: state.status,
    status: postprocessingNodeStatus(state.readiness),
  });
}

function postprocessingDefinitions(
  snapshot: PhysicsFirstPostprocessingSnapshot | undefined,
): PostprocessingDefinition[] {
  const tableCatalog = snapshot?.tableCatalog;
  const artifactCatalog = snapshot?.artifactCatalog;
  const definitions = [
    ...(tableCatalog?.data?.tables ?? []).map((table) =>
      postprocessingDefinitionFromTable(table, tableCatalog),
    ),
    ...(artifactCatalog?.data ?? []).map((artifact) =>
      postprocessingDefinitionFromArtifact(artifact, artifactCatalog),
    ),
    ...(snapshot?.analysisViews ?? []).map((definition) =>
      definePostprocessing(definition),
    ),
    ...(snapshot?.derivedValues ?? []).map((definition) =>
      definePostprocessing(definition),
    ),
  ];
  if (!snapshot?.analysisViews?.length) {
    definitions.push(unavailableDefinition("analysis_view"));
  }
  if (!snapshot?.derivedValues?.length) {
    definitions.push(unavailableDefinition("derived_value"));
  }
  if (tableCatalog === undefined) {
    definitions.push(unavailableDefinition("table"));
  } else if (tableCatalog.data === null || tableCatalog.status !== "ready") {
    definitions.push(
      unavailableDefinition(
        "table",
        postprocessingCatalogState(tableCatalog, "Table"),
      ),
    );
  }
  if (artifactCatalog === undefined) {
    definitions.push(unavailableDefinition("export"));
  } else if (artifactCatalog.data === null || artifactCatalog.status !== "ready") {
    definitions.push(
      unavailableDefinition(
        "export",
        postprocessingCatalogState(artifactCatalog, "Artifact"),
      ),
    );
  }
  return definitions;
}

export function buildPhysicsFirstResultsTree(snapshot: PhysicsFirstResultsSnapshot): ExplorerNode[] {
  for (const entry of snapshot.entries) {
    if (entry.runId !== snapshot.resultContextRunId) {
      throw new Error(
        `Result entry ${entry.runId} does not belong to context ${snapshot.resultContextRunId}`,
      );
    }
  }

  const runKey = key(snapshot.resultContextRunId);
  const resultsId = `results:run:${runKey}`;
  const resonanceId = `${resultsId}:resonance`;
  const dispersionId = `${resultsId}:k-resolved`;
  const resonanceStages = snapshot.entries.map((entry) => resonanceStage(resonanceId, entry));
  const dispersionStages = snapshot.entries.map((entry) => kResolvedStage(dispersionId, entry));
  const definitions = postprocessingDefinitions(snapshot.postprocessing);
  const contractGap = snapshot.contractGaps?.filter(Boolean).join("; ") ?? "";
  const resultHasPublishedProducts = snapshot.entries.some((entry) =>
    hasPublishedProduct(entry.products),
  ) || (snapshot.observationFrames?.data?.frames.length ?? 0) > 0;

  return [
    node(resultsId, "results.root", "Results", null, {
      analysisRunId: snapshot.resultContextRunId,
      ...(contractGap ? { badge: "contract gap", postprocessingContractGap: contractGap } : {}),
      ...(!resultHasPublishedProducts
        ? {
            availability: "unavailable" as const,
            executionState: "not_started" as const,
            resourceState: contractGap ? ("error" as const) : ("idle" as const),
            status: contractGap ? ("failed" as const) : ("unavailable" as const),
          }
        : {}),
      children: [
        rootWithChildren(
          `${resultsId}:dynamics`,
          "results.dynamics.root",
          "Dynamics",
          resultsId,
          [observationFramesRoot(`${resultsId}:dynamics`, snapshot)],
        ),
        rootWithChildren(resonanceId, "results.resonance.root", "Resonance & FMR", resultsId, resonanceStages),
        rootWithChildren(
          dispersionId,
          "results.dispersion.root",
          "Dispersion & k-resolved response",
          resultsId,
          dispersionStages,
        ),
        rootWithChildren(`${resultsId}:hysteresis`, "results.hysteresis.root", "Hysteresis", resultsId, []),
        postprocessingRootWithChildren(
          `${resultsId}:analysis-views`,
          "results.analysis_views.root",
          "Analysis Views",
          resultsId,
          "analysis_view",
          undefined,
          postprocessingChildren(`${resultsId}:analysis-views`, "analysis_view", definitions),
        ),
        postprocessingRootWithChildren(
          `${resultsId}:derived-values`,
          "results.derived_values.root",
          "Derived Values",
          resultsId,
          "derived_value",
          undefined,
          postprocessingChildren(`${resultsId}:derived-values`, "derived_value", definitions),
        ),
        postprocessingRootWithChildren(
          `${resultsId}:tables`,
          "results.tables.root",
          "Tables",
          resultsId,
          "table",
          snapshot.postprocessing?.tableCatalog,
          postprocessingChildren(`${resultsId}:tables`, "table", definitions),
        ),
        postprocessingRootWithChildren(
          `${resultsId}:exports`,
          "results.exports.root",
          "Exports",
          resultsId,
          "export",
          snapshot.postprocessing?.artifactCatalog,
          postprocessingChildren(`${resultsId}:exports`, "export", definitions),
        ),
      ],
    }),
  ];
}
