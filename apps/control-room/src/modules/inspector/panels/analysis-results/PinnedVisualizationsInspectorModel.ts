import type { AnalysisNodeKind } from "@/kernel/analysis-modules/analysisModuleContract";
import { ANALYSIS_FEATURE_MANIFESTS } from "@/kernel/analysis-modules/analysisModuleManifests";
import type {
  PostprocessingDefinition,
  PostprocessingDefinitionCollectionResource,
} from "@/kernel/api/apiTypes";

import type { InspectorPanelProps } from "../../inspectorTypes";

const PINNED_VISUALIZATIONS_KIND = "results.pinned_visualizations.root";

export interface PinnedVisualizationsInspectorModel {
  pinned: PostprocessingDefinition[];
  unavailable: boolean;
}

function selectedPinnedGroup(selection: InspectorPanelProps["selection"]) {
  const ref = selection.ref;
  if (
    selection.kind !== PINNED_VISUALIZATIONS_KIND ||
    ref?.type !== "analysis-pinned-group" ||
    ref.kind !== PINNED_VISUALIZATIONS_KIND ||
    selection.nodeId === null ||
    selection.nodeId !== ref.nodeId ||
    ref.moduleId.trim().length === 0 ||
    ref.runId.trim().length === 0
  ) {
    return null;
  }
  return ref;
}

function modeVisualizationSchema(moduleId: string): string | undefined {
  const nodeKind = `${moduleId}.mode_visualization` as AnalysisNodeKind;
  return ANALYSIS_FEATURE_MANIFESTS.find((manifest) => manifest.id === moduleId)
    ?.definitionSchemas[nodeKind];
}

export function buildPinnedVisualizationsInspectorModel(
  selection: InspectorPanelProps["selection"],
  definitions: {
    data?: PostprocessingDefinitionCollectionResource | null;
  },
): PinnedVisualizationsInspectorModel {
  const group = selectedPinnedGroup(selection);
  const nodeKind = group ? `${group.moduleId}.mode_visualization` : null;
  const schema = group ? modeVisualizationSchema(group.moduleId) : undefined;
  const unavailable = group === null || schema === undefined;
  const pinned =
    group && nodeKind && schema
      ? (definitions.data?.definitions ?? []).filter(
          (definition) =>
            definition.module_id === group.moduleId &&
            definition.data_ref.run_id === group.runId &&
            definition.node_kind === nodeKind &&
            definition.definition_schema === schema,
        )
      : [];

  return { pinned, unavailable };
}

