import {
  classifyFrequencyDomainResult,
  type FrequencyDomainResultEvidence,
} from "@/shared/domain/analysis/frequencyDomainResultClassification";
import {
  buildEigenDispersionChartModel,
  buildEigenSpectrumChartModel,
  buildFrequencyResponseChartModel,
  responseFieldResourcesFromManifest,
  type FrequencyDomainJsonArtifactLike,
  type FrequencyDomainTextArtifactLike,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import { fieldVectorResourceKey } from "@/kernel/api/fieldQueryIdentity";
import type {
  ArtifactResource,
  TableListResource,
  TableResource,
} from "@/kernel/api/apiTypes";
import {
  definePostprocessing,
  postprocessingDefinitionFromArtifact,
  postprocessingDefinitionFromTable,
  type PostprocessingDefinition,
  type PostprocessingDefinitionInput,
} from "@/shared/domain/analysis/postprocessingDefinitions";

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
  fieldId: string;
  frequencyHz: number;
  frequencyIndex?: number;
  kPathCoordinateRadPerM?: number;
  label: string;
  modeIndex?: number;
  observableId?: string;
  representation: "complex-vector-xyz";
  resourceRef: string;
  sampleIndex?: number;
  source: "eigen-mode" | "frequency-response";
  view: "phase_rotated_real";
  wavevectorKf?: readonly [number, number, number];
}

export interface PhysicsFirstResultsSnapshot {
  entries: readonly PhysicsFirstResultEntry[];
  postprocessing?: PhysicsFirstPostprocessingSnapshot;
  resultContextRunId: string;
}

export interface PhysicsFirstPostprocessingSnapshot {
  analysisViews?: readonly PostprocessingFamilyDefinition<"analysis_view">[];
  artifacts?: readonly ArtifactResource[];
  derivedValues?: readonly PostprocessingFamilyDefinition<"derived_value">[];
  tables?: readonly TableResource[];
}

type PostprocessingFamilyDefinition<
  Kind extends "analysis_view" | "derived_value",
> = Omit<PostprocessingDefinitionInput, "kind"> & { kind: Kind };

interface ResultResourceLike {
  status?: string;
}

interface ResultManifestLike extends ResultResourceLike {
  payload?: unknown;
}

export interface PhysicsFirstResultResourceInput {
  artifacts?: readonly ArtifactResource[];
  branches?: ResultResourceLike | null;
  currentRun?: { revision: number | string; run_id: string } | null;
  dispersion?: (ResultResourceLike & { path_metadata?: unknown; text?: string | null }) | null;
  manifest?: { result_manifest?: ResultManifestLike | null } | null;
  responseSweep?: (ResultResourceLike & { payload?: unknown }) | null;
  spectrum?: (ResultResourceLike & { payload?: unknown }) | null;
  tableCatalog?: TableListResource | null;
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
    ? { payload: resource.payload, status: resource.status ?? "idle" }
    : null;
}

function dispersionArtifact(
  resource:
    | (ResultResourceLike & { path_metadata?: unknown; text?: string | null })
    | null
    | undefined,
): FrequencyDomainTextArtifactLike | null {
  return resource
    ? { status: resource.status ?? "idle", text: resource.text }
    : null;
}

function pathSamplingFromMetadata(value: unknown): FrequencyDomainResultEvidence["kSampling"] | null {
  const sampling = record(record(value)?.sampling);
  if (sampling?.kind !== "path") return null;
  const points = Array.isArray(sampling.points) ? sampling.points : [];
  const segmentSamples = Array.isArray(sampling.samples_per_segment)
    ? sampling.samples_per_segment.filter((sample): sample is number => typeof sample === "number")
    : [];
  const labels = points
    .map((point) => nonEmptyString(record(point)?.label))
    .filter((label): label is string => label !== null);
  return {
    kind: "path",
    label: labels.length > 1 ? labels.join("–") : undefined,
    sampleCount: segmentSamples.reduce((sum, count) => sum + count, 0) + 1,
  };
}

function singleKSamplingFromRequestedExecution(
  requested: Record<string, unknown> | null,
): FrequencyDomainResultEvidence["kSampling"] | null {
  const sampling = record(requested?.k_sampling);
  const vector = vector3(
    sampling?.vector_rad_per_m ??
      sampling?.vector ??
      requested?.k_vector_rad_per_m ??
      requested?.wavevector_kf,
  );
  return vector ? { kind: "single", vectorRadPerM: vector } : null;
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

function modalFieldTargets({
  dispersion,
  kSampling,
  spectrum,
}: {
  dispersion?: (ResultResourceLike & { path_metadata?: unknown; text?: string | null }) | null;
  kSampling?: FrequencyDomainResultEvidence["kSampling"];
  spectrum?: (ResultResourceLike & { payload?: unknown }) | null;
}): PhysicsFirstAnalysisFieldTarget[] {
  if (kSampling?.kind === "path") {
    return buildEigenDispersionChartModel(dispersionArtifact(dispersion)).points.flatMap((point) => {
      if (!point.modeFieldId) return [];
      const wavevectorKf = pathWavevectorAtSample(dispersion?.path_metadata, point.sampleIndex);
      if (!wavevectorKf || !Number.isFinite(point.pathS)) return [];
      return [{
        fieldId: point.modeFieldId,
        frequencyHz: point.frequencyHz,
        kPathCoordinateRadPerM: point.pathS,
        label: `Sample ${point.sampleIndex} · Mode ${point.rawModeIndex}`,
        modeIndex: point.rawModeIndex,
        representation: "complex-vector-xyz" as const,
        resourceRef: point.modeFieldResourceKey ?? fieldVectorResourceKey(point.modeFieldId),
        sampleIndex: point.sampleIndex,
        source: "eigen-mode" as const,
        view: "phase_rotated_real" as const,
        wavevectorKf,
      }];
    });
  }
  const fixedWavevector = kSampling?.kind === "single" ? kSampling.vectorRadPerM : undefined;
  return buildEigenSpectrumChartModel(jsonArtifact(spectrum)).points.flatMap((point) =>
    point.modeFieldId
      ? [{
          fieldId: point.modeFieldId,
          frequencyHz: point.frequencyHz,
          label: `Sample ${point.sampleIndex} · Mode ${point.rawModeIndex}`,
          modeIndex: point.rawModeIndex,
          representation: "complex-vector-xyz" as const,
          resourceRef: point.modeFieldResourceKey ?? fieldVectorResourceKey(point.modeFieldId),
          sampleIndex: point.sampleIndex,
          source: "eigen-mode" as const,
          view: "phase_rotated_real" as const,
          ...(fixedWavevector ? { wavevectorKf: fixedWavevector } : {}),
        }]
      : [],
  );
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
  const runId = input.currentRun?.run_id ?? "";
  const resultManifest = input.manifest?.result_manifest;
  const payload = ready(resultManifest) ? record(resultManifest?.payload) : null;
  const contractGaps: string[] = [];
  const emptySnapshot: PhysicsFirstResultsSnapshot = {
    entries: [],
    resultContextRunId: runId,
  };
  if (!runId || !payload) return { contractGaps, snapshot: emptySnapshot };

  const studyProduct = nonEmptyString(payload.study_product);
  const stageId = nonEmptyString(payload.stage_id);
  const equilibriumId = nonEmptyString(payload.equilibrium_identity);
  const requested = record(payload.requested_execution);
  const boundaryContext = nonEmptyString(requested?.boundary_context);
  if (!equilibriumId) {
    contractGaps.push("Frequency-domain artifact does not publish equilibrium_identity");
  }
  if (boundaryContext !== "finite_open" && boundaryContext !== "floquet_periodic") {
    contractGaps.push("Frequency-domain artifact does not publish boundary_context");
  }
  if (
    !stageId ||
    !equilibriumId ||
    (studyProduct !== "modal_eigen" && studyProduct !== "driven_response") ||
    (boundaryContext !== "finite_open" && boundaryContext !== "floquet_periodic")
  ) {
    return { contractGaps, snapshot: emptySnapshot };
  }

  const kSampling =
    pathSamplingFromMetadata(input.dispersion?.path_metadata) ??
    singleKSamplingFromRequestedExecution(requested);
  const artifactRevision =
    nonEmptyString(payload.revision) ?? input.currentRun?.revision ?? "unknown";
  const products: PhysicsFirstResultProducts =
    studyProduct === "modal_eigen"
      ? {
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
  const entry: PhysicsFirstResultEntry = {
    analysisFieldTargets:
      studyProduct === "modal_eigen"
        ? modalFieldTargets({
            dispersion: input.dispersion,
            ...(kSampling ? { kSampling } : {}),
            spectrum: input.spectrum,
          })
        : responseFieldTargets(payload, input.responseSweep, kSampling ?? undefined),
    artifactRevision,
    boundaryContext,
    equilibriumId,
    ...(kSampling ? { kSampling } : {}),
    observables: observablesFromPayload(payload.observables),
    products,
    runId,
    stageId,
    stageLabel: nonEmptyString(payload.stage_label) ?? stageId,
    studyProduct,
  };

  return {
    contractGaps,
    snapshot: {
      entries: [entry],
      postprocessing: {
        ...(input.artifacts ? { artifacts: input.artifacts } : {}),
        ...(input.tableCatalog ? { tables: input.tableCatalog.tables } : {}),
      },
      resultContextRunId: runId,
    },
  };
}

function key(identity: string): string {
  return encodeURIComponent(identity);
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
        ...(target.modeIndex !== undefined ? { modeIndex: target.modeIndex } : {}),
        ...(target.observableId ? { observableId: target.observableId } : {}),
        resourceRef: target.resourceRef,
        ...(target.sampleIndex !== undefined ? { sampleIndex: target.sampleIndex } : {}),
        studyProduct: entry.studyProduct,
        ...(target.wavevectorKf ? { wavevectorKf: target.wavevectorKf } : {}),
      },
    ),
  );
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
  children.push(
    leaf(stageId, "provenance", "results.frequency_domain.provenance", "Equilibrium & Provenance", entry),
  );

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
  children.push(
    leaf(stageId, "provenance", "results.frequency_domain.provenance", "Equilibrium & Provenance", entry),
  );

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
  return node(id, kind, label, parentId, { children: children.filter((child): child is ExplorerNode => child !== null) });
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
      const available =
        definition.availability === "available" && definition.owner !== null;
      return node(
        `${parentId}:${key(definition.id)}`,
        nodeKind,
        definition.label,
        parentId,
        {
          ...(available && definition.resourceRevision !== undefined
            ? { artifactRevision: definition.resourceRevision }
            : {}),
          availability: available ? "available" : "unavailable",
          badge: available ? "published" : "contract gap",
          executionState: available ? "completed" : "not_started",
          ...(available && definition.datasetRef
            ? { resourceRef: definition.datasetRef }
            : {}),
          resourceState: available ? "ready" : "error",
          status: available ? "ready" : "unavailable",
        },
      );
    });
}

function unavailableDefinition(
  kind: PostprocessingDefinition["kind"],
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
  });
}

function postprocessingDefinitions(
  snapshot: PhysicsFirstPostprocessingSnapshot | undefined,
): PostprocessingDefinition[] {
  const definitions = [
    ...(snapshot?.tables ?? []).map(postprocessingDefinitionFromTable),
    ...(snapshot?.artifacts ?? []).map(postprocessingDefinitionFromArtifact),
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
  if (snapshot?.tables === undefined) {
    definitions.push(unavailableDefinition("table"));
  }
  if (snapshot?.artifacts === undefined) {
    definitions.push(unavailableDefinition("export"));
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

  return [
    node(resultsId, "results.root", "Results", null, {
      analysisRunId: snapshot.resultContextRunId,
      children: [
        rootWithChildren(`${resultsId}:dynamics`, "results.dynamics.root", "Dynamics", resultsId, []),
        rootWithChildren(resonanceId, "results.resonance.root", "Resonance & FMR", resultsId, resonanceStages),
        rootWithChildren(
          dispersionId,
          "results.dispersion.root",
          "Dispersion & k-resolved response",
          resultsId,
          dispersionStages,
        ),
        rootWithChildren(`${resultsId}:hysteresis`, "results.hysteresis.root", "Hysteresis", resultsId, []),
        rootWithChildren(`${resultsId}:analysis-views`, "results.analysis_views.root", "Analysis Views", resultsId, postprocessingChildren(`${resultsId}:analysis-views`, "analysis_view", definitions)),
        rootWithChildren(`${resultsId}:derived-values`, "results.derived_values.root", "Derived Values", resultsId, postprocessingChildren(`${resultsId}:derived-values`, "derived_value", definitions)),
        rootWithChildren(`${resultsId}:tables`, "results.tables.root", "Tables", resultsId, postprocessingChildren(`${resultsId}:tables`, "table", definitions)),
        rootWithChildren(`${resultsId}:exports`, "results.exports.root", "Exports", resultsId, postprocessingChildren(`${resultsId}:exports`, "export", definitions)),
      ],
    }),
  ];
}
