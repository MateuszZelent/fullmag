import {
  classifyFrequencyDomainResult,
  type FrequencyDomainResultEvidence,
} from "@/shared/domain/analysis/frequencyDomainResultClassification";

import type { ExplorerNode, ExplorerNodeKind } from "../explorerTypes";
import type { PostprocessingDefinition } from "@/shared/domain/analysis/postprocessingDefinitions";

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
  artifactRevision: number | string;
  products: PhysicsFirstResultProducts;
  stageLabel: string;
}

export interface PhysicsFirstResultsSnapshot {
  entries: readonly PhysicsFirstResultEntry[];
  postprocessing?: readonly PostprocessingDefinition[];
  resultContextRunId: string;
}

interface ResultResourceLike {
  status?: string;
}

interface ResultManifestLike extends ResultResourceLike {
  payload?: unknown;
}

export interface PhysicsFirstResultResourceInput {
  branches?: ResultResourceLike | null;
  currentRun?: { revision: number | string; run_id: string } | null;
  dispersion?: (ResultResourceLike & { path_metadata?: unknown }) | null;
  manifest?: { result_manifest?: ResultManifestLike | null } | null;
  responseSweep?: ResultResourceLike | null;
  spectrum?: ResultResourceLike | null;
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

function ready(resource: ResultResourceLike | null | undefined): boolean {
  return resource?.status === "ready";
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

  const kSampling = pathSamplingFromMetadata(input.dispersion?.path_metadata);
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
          responseMap: Boolean(kSampling) && ready(input.responseSweep),
          responseSpectrum: ready(input.responseSweep),
        };
  const entry: PhysicsFirstResultEntry = {
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
    snapshot: { entries: [entry], resultContextRunId: runId },
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
  });
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
      children.push(leaf(stageId, "modes", "results.resonance.modal.modes", "Mode Shapes", entry));
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
      children.push(
        leaf(stageId, "response-fields", "results.resonance.driven.fields", "Response Fields", entry),
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
      children.push(leaf(stageId, "modes-at-k", "results.dispersion.modal.modes_at_k", "Modes at k", entry));
    }
  } else if (entry.products.responseMap) {
    children.push(
      leaf(stageId, "response-map", "results.dispersion.driven.response_map", classification.resultLabel, entry),
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
  return definitions.filter((definition) => definition.kind === kind).map((definition) =>
    node(`${parentId}:${key(definition.id)}`, nodeKind, definition.label, parentId, {
      badge: definition.persistentOwner ? "saved" : "session only",
      resourceRef: definition.datasetRef,
    }),
  );
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
  const definitions = snapshot.postprocessing ?? [];

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
