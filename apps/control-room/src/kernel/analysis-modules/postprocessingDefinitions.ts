import type { PostprocessingDefinition } from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  isReferenceAxisUnit,
  isReferenceFrequencyUnit,
  isReferencePointPairs,
  referencePointPairsValidationError,
} from "@/shared/domain/analysis/referenceImport";

import { ANALYSIS_FEATURE_MANIFESTS } from "./analysisModuleManifests";
import type { AnalysisModuleId, AnalysisNodeKind } from "./analysisModuleContract";
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
  if (!ref.analysisRunId || !ref.analysisStageId || ref.artifactRevision === undefined) {
    return { ok: false, reason: "The selected field has no published run, stage or revision identity." };
  }
  const dataRef: ModeVisualizationDataRef = {
    run_id: ref.analysisRunId,
    dataset_id: ref.analysisStageId,
    dataset_revision: String(ref.artifactRevision),
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
export function importedReferenceDefinition(input: ImportedReferenceInput): PostprocessingDefinition {
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
  const stamp = `${input.fileName}:${input.points.length}:${input.points[0]?.join(",") ?? ""}`;
  return {
    definition_id: `analysis.dispersion:reference:${input.dataset.runId}:${input.dataset.stageId}:${stamp}`,
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
      // The complete array was validated and bounded before this copy.
      points: input.points.map(([path, frequency]) => [path, frequency]),
      source: "imported_table",
      source_units: {
        frequency: input.sourceUnits.frequency,
        path: input.sourceUnits.path,
      },
      y_quantity: "frequency_hz",
    },
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
