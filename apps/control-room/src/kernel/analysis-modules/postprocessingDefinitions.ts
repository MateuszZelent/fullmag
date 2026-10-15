import type {
  AnalysisResultDatasetManifestResource,
  AnalysisResultSpectralItemSummary,
  PostprocessingDefinition,
} from "@/kernel/api/apiTypes";
import type { AnalysisResultSelectionRef } from "@/shared/domain/analysis/results";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  isReferenceAxisUnit,
  isReferenceFrequencyUnit,
  isReferencePointPairs,
  referencePointPairsValidationError,
} from "@/shared/domain/analysis/referenceImport";

import { ANALYSIS_FEATURE_MANIFESTS } from "./analysisModuleManifests";
import { matchDataset, templateAvailability } from "./analysisDatasetMatching";
import type {
  AnalysisFeatureManifest,
  AnalysisModuleId,
  AnalysisNodeKind,
  MatchableDataset,
} from "./analysisModuleContract";
import { analysisModuleIdForNodeKind } from "./analysisSurfaceRouting";

/**
 * Builds the persistent definition of a mode visualization pinned from a
 * selected Results mode node (ADR 0054, spec 32 §8). Only published
 * identities are stored: module, run, dataset, revision, field, and optional
 * sample/item IDs when the producer supplies them.
 */
export type ModeVisualizationDefinitionResult =
  | { definition: PostprocessingDefinition; ok: true }
  | { ok: false; reason: string };

export interface ModeVisualizationOwnerIdentity {
  moduleId: string;
  runId: string;
  datasetId: string;
  datasetRevision: string;
  fieldId: string | null;
  sampleId?: string | null;
  itemId?: string | null;
}

export function modeVisualizationOwnerKey(identity: ModeVisualizationOwnerIdentity): string {
  return JSON.stringify([
    identity.moduleId,
    identity.runId,
    identity.datasetId,
    identity.datasetRevision,
    identity.fieldId,
    identity.sampleId ?? null,
    identity.itemId ?? null,
  ]);
}

export function modeVisualizationBaseOwnerKey(
  identity: Omit<ModeVisualizationOwnerIdentity, "sampleId" | "itemId">,
): string {
  return JSON.stringify([
    identity.moduleId,
    identity.runId,
    identity.datasetId,
    identity.datasetRevision,
    identity.fieldId,
  ]);
}

type ModeVisualizationDataRef = Pick<
  PostprocessingDefinition["data_ref"],
  "run_id" | "dataset_id" | "dataset_revision"
> & {
  field_id: string;
  sample_id?: string;
  item_id?: string;
};

export type ModeVisualizationOwnerMatch =
  | "exact"
  | "compatible-incomplete"
  | "different";

export function pinnedModeVisualizationId(
  moduleId: AnalysisModuleId,
  dataRef: ModeVisualizationDataRef,
): string {
  const identity: ModeVisualizationOwnerIdentity = {
    moduleId,
    runId: dataRef.run_id,
    datasetId: dataRef.dataset_id,
    datasetRevision: dataRef.dataset_revision,
    fieldId: dataRef.field_id,
    sampleId: dataRef.sample_id ?? null,
    itemId: dataRef.item_id ?? null,
  };
  const ownerKey = encodeURIComponent(modeVisualizationOwnerKey(identity));
  return `${moduleId}:mode-visualization:${ownerKey}`;
}

/** Compares exact published owners and identifies older partial identities safely. */
export function modeVisualizationOwnerMatch(
  left: Pick<PostprocessingDefinition, "module_id" | "node_kind" | "data_ref">,
  right: Pick<PostprocessingDefinition, "module_id" | "node_kind" | "data_ref">,
): ModeVisualizationOwnerMatch {
  const identity = (definition: typeof left): ModeVisualizationOwnerIdentity => ({
    moduleId: definition.module_id,
    runId: definition.data_ref.run_id,
    datasetId: definition.data_ref.dataset_id,
    datasetRevision: definition.data_ref.dataset_revision,
    fieldId: definition.data_ref.field_id ?? null,
    sampleId: definition.data_ref.sample_id ?? null,
    itemId: definition.data_ref.item_id ?? null,
  });
  const leftIdentity = identity(left);
  const rightIdentity = identity(right);
  if (
    left.module_id !== right.module_id ||
    left.node_kind !== right.node_kind ||
    modeVisualizationBaseOwnerKey(leftIdentity) !==
      modeVisualizationBaseOwnerKey(rightIdentity)
  ) {
    return "different";
  }

  let incomplete = false;
  for (const key of ["sampleId", "itemId"] as const) {
    const leftValue = leftIdentity[key] ?? null;
    const rightValue = rightIdentity[key] ?? null;
    if (leftValue !== null && rightValue !== null && leftValue !== rightValue) {
      return "different";
    }
    if ((leftValue === null) !== (rightValue === null)) incomplete = true;
  }
  return incomplete ? "compatible-incomplete" : "exact";
}

/** Exact owner equality, retained for callers that need a boolean predicate. */
export function sameModeVisualizationOwner(
  left: Pick<PostprocessingDefinition, "module_id" | "node_kind" | "data_ref">,
  right: Pick<PostprocessingDefinition, "module_id" | "node_kind" | "data_ref">,
): boolean {
  return modeVisualizationOwnerMatch(left, right) === "exact";
}

export function modeVisualizationDefinitionFromSelection(
  selection: Pick<Selection, "kind" | "label" | "ref"> | null,
): ModeVisualizationDefinitionResult {
  const ref = selection?.ref;
  if (!selection || ref?.type !== "frequency-domain" || !ref.fieldId) {
    return { ok: false, reason: "Select a mode or response field in the Results tree." };
  }
  const moduleId = analysisModuleIdForNodeKind(selection.kind ?? "");
  const manifest = ANALYSIS_FEATURE_MANIFESTS.find((candidate) => candidate.id === moduleId);
  const nodeKind = moduleId ? (`${moduleId}.mode_visualization` as AnalysisNodeKind) : null;
  const schema = nodeKind ? manifest?.definitionSchemas[nodeKind] : undefined;
  if (!manifest || !nodeKind || !schema) {
    return { ok: false, reason: "This result's analysis module cannot pin mode visualizations." };
  }
  if (
    !ref.analysisRunId ||
    typeof ref.datasetId !== "string" || ref.datasetId.trim().length === 0 ||
    typeof ref.datasetRevision !== "string" || ref.datasetRevision.trim().length === 0
  ) {
    return { ok: false, reason: "The selected field has no canonical published dataset identity." };
  }
  const dataRef: ModeVisualizationDataRef = {
    run_id: ref.analysisRunId,
    dataset_id: ref.datasetId,
    dataset_revision: ref.datasetRevision,
    field_id: ref.fieldId,
    ...(ref.sampleId ? { sample_id: ref.sampleId } : {}),
    ...(ref.modeId ? { item_id: ref.modeId } : {}),
  };
  const frequency =
    typeof ref.frequencyHz === "number" && Number.isFinite(ref.frequencyHz)
      ? ` · ${(ref.frequencyHz / 1e9).toFixed(4)} GHz`
      : "";
  return {
    ok: true,
    definition: {
      definition_id: pinnedModeVisualizationId(manifest.id, dataRef),
      revision: 0,
      module_id: manifest.id,
      module_version: manifest.version,
      definition_schema: schema,
      node_kind: nodeKind,
      label: `${selection.label ?? "Mode"}${frequency}`,
      data_ref: dataRef,
      settings: { placement: "beside" },
    },
  };
}

export type PublishedModeVisualizationSelectionRef = AnalysisResultSelectionRef & {
  itemKind: "eigen_mode" | "driven_frequency_point";
  itemId: string;
  sampleId: string;
  fieldId: string;
  fieldRevision: string;
  fieldRef: NonNullable<AnalysisResultSelectionRef["fieldRef"]> & {
    field_id: string;
    field_revision: string;
    resource_key: string;
    status: "ready";
  };
};

export type ModeVisualizationAnalysisResultSelectionResult =
  | { ok: true; selection: PublishedModeVisualizationSelectionRef }
  | { ok: false; reason: string };

function nonEmptyPublishedIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Minimum typed item selection accepted by the async published-resource path. */
export function modeVisualizationAnalysisResultSelection(
  selection: Pick<Selection, "kind" | "label" | "ref"> | null,
): ModeVisualizationAnalysisResultSelectionResult {
  const ref = selection?.ref;
  if (
    selection?.kind !== "analysis.result" ||
    ref?.type !== "analysis-result" ||
    ref.kind !== "analysis.result" ||
    (ref.focus !== "item" && ref.focus !== "field")
  ) {
    return { ok: false, reason: "Select a published mode or response field in the Results tree." };
  }
  const itemId = ref.itemId;
  const sampleId = ref.sampleId;
  const fieldId = ref.fieldId;
  const fieldRevision = ref.fieldRevision;
  const itemKind = ref.itemKind;
  if (
    !nonEmptyPublishedIdentity(ref.runId) ||
    !nonEmptyPublishedIdentity(ref.stageId) ||
    !nonEmptyPublishedIdentity(ref.datasetId) ||
    !nonEmptyPublishedIdentity(ref.datasetRevision) ||
    !nonEmptyPublishedIdentity(itemId) ||
    !nonEmptyPublishedIdentity(sampleId) ||
    !nonEmptyPublishedIdentity(fieldId) ||
    !nonEmptyPublishedIdentity(fieldRevision) ||
    (itemKind !== "eigen_mode" && itemKind !== "driven_frequency_point")
  ) {
    return { ok: false, reason: "The selected result lacks a complete published item and field identity." };
  }
  const fieldRef = ref.fieldRef;
  if (!fieldRef || fieldRef.status !== "ready") {
    return { ok: false, reason: "The selected result field is not ready for visualization." };
  }
  const resourceKey = fieldRef.resource_key;
  if (
    fieldRef.field_id !== fieldId ||
    fieldRef.field_revision !== fieldRevision ||
    !nonEmptyPublishedIdentity(resourceKey)
  ) {
    return { ok: false, reason: "The selected result field identity is incomplete or inconsistent." };
  }
  return {
    ok: true,
    selection: {
      ...ref,
      itemKind,
      itemId,
      sampleId,
      fieldId,
      fieldRevision,
      fieldRef: {
        ...fieldRef,
        field_id: fieldId,
        field_revision: fieldRevision,
        resource_key: resourceKey,
        status: "ready",
      },
    },
  };
}

function matchableDataset(
  manifest: AnalysisResultDatasetManifestResource,
): MatchableDataset {
  return {
    dataset_id: manifest.dataset_id,
    product_kind: manifest.product_kind,
    item_kinds: manifest.item_kinds,
    axes: manifest.axes.map((axis) => ({
      cardinality: axis.cardinality,
      role: axis.role,
    })),
    capabilities: manifest.capabilities,
  };
}

interface ModeVisualizationTarget {
  manifest: AnalysisFeatureManifest;
  nodeKind: AnalysisNodeKind;
  schema: string;
}

function modeVisualizationTarget(
  manifest: AnalysisResultDatasetManifestResource,
  candidates: readonly AnalysisFeatureManifest[],
): { ok: true; target: ModeVisualizationTarget } | { ok: false; reason: string } {
  const dataset = matchableDataset(manifest);
  const available: ModeVisualizationTarget[] = [];
  for (const feature of candidates) {
    const nodeKind = (feature.id + ".mode_visualization") as AnalysisNodeKind;
    const schema = feature.definitionSchemas[nodeKind];
    const templates = feature.nodeTemplates.filter((template) => template.kind === nodeKind);
    const template = templates[0];
    const availability = templateAvailability(feature, dataset).filter(
      (entry) => entry.template.kind === nodeKind,
    );
    if (
      !matchDataset(feature, dataset).matched ||
      typeof schema !== "string" ||
      schema.trim().length === 0 ||
      templates.length !== 1 ||
      !template ||
      template.role !== "field-visualization" ||
      template.instantiation !== "user" ||
      availability.length !== 1 ||
      availability[0]?.available !== true
    ) {
      continue;
    }
    available.push({ manifest: feature, nodeKind, schema });
  }
  if (available.length === 0) {
    return {
      ok: false,
      reason: "The selected dataset has no available analysis module mode-visualization template.",
    };
  }
  if (available.length !== 1) {
    return {
      ok: false,
      reason: "The selected dataset matches multiple available mode-visualization modules.",
    };
  }
  const target = available[0];
  if (!target) {
    return {
      ok: false,
      reason: "The selected dataset has no available analysis module mode-visualization template.",
    };
  }
  return { ok: true, target };
}

function samePublishedFieldOwner(
  left: AnalysisResultSelectionRef["fieldRef"],
  right: AnalysisResultSpectralItemSummary["field_ref"],
): boolean {
  if (!left || !right) return false;
  return (
    left.field_id === right.field_id &&
    left.field_revision === right.field_revision &&
    left.resource_key === right.resource_key &&
    left.status === right.status &&
    left.quantity_id === right.quantity_id &&
    left.representation === right.representation &&
    left.mesh_ref?.mesh_id === right.mesh_ref?.mesh_id &&
    left.mesh_ref?.mesh_revision === right.mesh_ref?.mesh_revision &&
    left.mesh_ref?.topology_fingerprint === right.mesh_ref?.topology_fingerprint
  );
}

/**
 * Builds a pin only after the caller has read the canonical dataset manifest
 * and item resources. Item source_revision is intentionally not treated as
 * dataset_revision; the latter is copied solely from the exact manifest.
 */
export function modeVisualizationDefinitionFromAnalysisResult(
  selection: Pick<Selection, "kind" | "label" | "ref"> | null,
  manifest: AnalysisResultDatasetManifestResource,
  item: AnalysisResultSpectralItemSummary,
  candidates: readonly AnalysisFeatureManifest[] = ANALYSIS_FEATURE_MANIFESTS,
): ModeVisualizationDefinitionResult {
  const selected = modeVisualizationAnalysisResultSelection(selection);
  if (!selected.ok) return selected;
  const ref = selected.selection;
  if (
    manifest.run_id !== ref.runId ||
    manifest.stage_id !== ref.stageId ||
    manifest.dataset_id !== ref.datasetId ||
    manifest.dataset_revision !== ref.datasetRevision
  ) {
    return { ok: false, reason: "The published dataset manifest no longer matches the selected result." };
  }
  const itemKind = ref.itemKind;
  const expectedItemKind =
    (manifest.product_kind === "modal_eigen" && itemKind === "eigen_mode") ||
    (manifest.product_kind === "driven_response" && itemKind === "driven_frequency_point");
  if (!itemKind || !expectedItemKind || !manifest.item_kinds.includes(itemKind)) {
    return { ok: false, reason: "The selected item kind does not match the published dataset product." };
  }
  const itemFieldRef = item.field_ref;
  if (
    item.item_id !== ref.itemId ||
    item.item_kind !== itemKind ||
    item.sample_id !== ref.sampleId ||
    (ref.branchId !== undefined && item.branch_id !== ref.branchId) ||
    !itemFieldRef ||
    itemFieldRef.status !== "ready" ||
    itemFieldRef.field_id !== ref.fieldId ||
    itemFieldRef.field_revision !== ref.fieldRevision ||
    !samePublishedFieldOwner(ref.fieldRef, itemFieldRef)
  ) {
    return { ok: false, reason: "The published item or field identity does not match the selection." };
  }
  const target = modeVisualizationTarget(manifest, candidates);
  if (!target.ok) return target;
  const dataRef: ModeVisualizationDataRef = {
    run_id: manifest.run_id,
    dataset_id: manifest.dataset_id,
    dataset_revision: manifest.dataset_revision,
    field_id: itemFieldRef.field_id,
    sample_id: item.sample_id,
    item_id: item.item_id,
  };
  const frequency =
    typeof item.frequency_hz === "number" && Number.isFinite(item.frequency_hz)
      ? " · " + (item.frequency_hz / 1e9).toFixed(4) + " GHz"
      : "";
  return {
    ok: true,
    definition: {
      definition_id: pinnedModeVisualizationId(target.manifest.id, dataRef),
      revision: 0,
      module_id: target.manifest.id,
      module_version: target.manifest.version,
      definition_schema: target.schema,
      node_kind: target.nodeKind,
      label: selection?.label?.trim() || item.item_id + frequency,
      data_ref: dataRef,
      settings: { placement: "beside" },
    },
  };
}

export interface ImportedReferenceInput {
  /** Published identity of the dispersion result the reference is compared with. */
  dataset: { artifactRevision: number | string; runId: string; stageId: string };
  fileName: string;
  label: string;
  points: readonly (readonly [number, number])[];
  sourceUnits: { frequency: string; path: string };
}

export const IMPORTED_REFERENCE_SCHEMA = "analysis.dispersion.reference.v1";

/**
 * Definition of an imported reference (COMSOL or CSV) overlaid on the
 * dispersion relation. Points are stored in SI: path coordinate [rad/m] and
 * frequency [Hz]. The reference carries no physics assumptions of its own;
 * its comparison status stays "unknown" until metadata is provided.
 */
export async function importedReferenceDefinition(input: ImportedReferenceInput): Promise<PostprocessingDefinition> {
  if (!input || typeof input !== "object") {
    throw new TypeError("Reference import details are required.");
  }
  const pointError = referencePointPairsValidationError(input.points);
  if (pointError) throw new RangeError(pointError);
  if (typeof input.fileName !== "string" || input.fileName.trim().length === 0) {
    throw new TypeError("Choose a reference file name.");
  }
  if (typeof input.label !== "string" || input.label.trim().length === 0) {
    throw new TypeError("Choose a label for the reference.");
  }
  if (
    !input.sourceUnits || typeof input.sourceUnits !== "object" ||
    !isReferenceFrequencyUnit(input.sourceUnits.frequency) ||
    !isReferenceAxisUnit(input.sourceUnits.path)
  ) {
    throw new TypeError("Choose supported units for the reference.");
  }
  const dataset = input.dataset;
  if (
    !dataset || typeof dataset !== "object" ||
    typeof dataset.runId !== "string" || dataset.runId.trim().length === 0 ||
    typeof dataset.stageId !== "string" || dataset.stageId.trim().length === 0 ||
    !(
      (typeof dataset.artifactRevision === "number" && Number.isFinite(dataset.artifactRevision)) ||
      (typeof dataset.artifactRevision === "string" && dataset.artifactRevision.trim().length > 0)
    )
  ) {
    throw new TypeError("The selected dispersion result has an invalid published identity.");
  }
  const manifest = ANALYSIS_FEATURE_MANIFESTS.find((candidate) => candidate.id === "analysis.dispersion");
  const payload: Omit<PostprocessingDefinition, "definition_id"> = {
    revision: 0,
    module_id: "analysis.dispersion",
    module_version: manifest?.version ?? "0.1.0",
    definition_schema: IMPORTED_REFERENCE_SCHEMA,
    node_kind: "analysis.dispersion.reference",
    label: input.label,
    data_ref: {
      run_id: dataset.runId,
      dataset_id: dataset.stageId,
      dataset_revision: String(dataset.artifactRevision),
    },
    settings: {
      file_name: input.fileName,
      path_quantity: "path_coordinate_rad_per_m",
      // The complete array was validated and bounded before this detached copy.
      points: input.points.map(([path, frequency]) => [path, frequency]),
      source: "imported_table",
      source_units: {
        frequency: input.sourceUnits.frequency,
        path: input.sourceUnits.path,
      },
      y_quantity: "frequency_hz",
    },
  };
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("SHA-256 digest is unavailable for reference identity.");
  }
  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const contentSha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    definition_id: `analysis.dispersion:reference:sha256:${contentSha256}`,
    ...payload,
  };
}

/** SI points of a stored imported reference, or null when the settings are not a reference. */
export function importedReferencePoints(definition: PostprocessingDefinition): [number, number][] | null {
  if (
    !definition || definition.definition_schema !== IMPORTED_REFERENCE_SCHEMA ||
    typeof definition.label !== "string" || definition.label.trim().length === 0
  ) return null;
  const settings = definition.settings as Record<string, unknown> | undefined;
  if (
    !settings || settings.source !== "imported_table" ||
    settings.path_quantity !== "path_coordinate_rad_per_m" ||
    settings.y_quantity !== "frequency_hz" ||
    typeof settings.file_name !== "string" || settings.file_name.trim().length === 0
  ) return null;
  const sourceUnits = settings.source_units;
  if (
    !sourceUnits || typeof sourceUnits !== "object" ||
    !isReferenceFrequencyUnit((sourceUnits as Record<string, unknown>).frequency) ||
    !isReferenceAxisUnit((sourceUnits as Record<string, unknown>).path)
  ) return null;
  const points = settings.points;
  if (!isReferencePointPairs(points)) return null;
  // Reject malformed or oversized stored data as a whole before allocating a render copy.
  return points.map(([path, frequency]): [number, number] => [path, frequency]);
}
