import type { PostprocessingDefinition } from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

import { ANALYSIS_FEATURE_MANIFESTS } from "./analysisModuleManifests";
import type { AnalysisModuleId, AnalysisNodeKind } from "./analysisModuleContract";
import { analysisModuleIdForNodeKind } from "./analysisSurfaceRouting";

/**
 * Builds the persistent definition of a mode visualization pinned from a
 * selected Results mode node (ADR 0054, spec 32 §8). Only published
 * identities are stored: run, stage (dataset), artifact revision and field id.
 */
export type ModeVisualizationDefinitionResult =
  | { definition: PostprocessingDefinition; ok: true }
  | { ok: false; reason: string };

export function pinnedModeVisualizationId(moduleId: AnalysisModuleId, fieldId: string): string {
  return `${moduleId}:mode-visualization:${fieldId}`;
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
  const frequency =
    typeof ref.frequencyHz === "number" && Number.isFinite(ref.frequencyHz)
      ? ` · ${(ref.frequencyHz / 1e9).toFixed(4)} GHz`
      : "";
  return {
    ok: true,
    definition: {
      definition_id: pinnedModeVisualizationId(manifest.id, ref.fieldId),
      revision: 0,
      module_id: manifest.id,
      module_version: manifest.version,
      definition_schema: schema,
      node_kind: nodeKind,
      label: `${selection.label ?? "Mode"}${frequency}`,
      data_ref: {
        run_id: ref.analysisRunId,
        dataset_id: ref.analysisStageId,
        dataset_revision: String(ref.artifactRevision),
        field_id: ref.fieldId,
        ...(ref.sampleId ? { sample_id: ref.sampleId } : {}),
        ...(ref.modeId ? { item_id: ref.modeId } : {}),
      },
      settings: { placement: "beside" },
    },
  };
}
