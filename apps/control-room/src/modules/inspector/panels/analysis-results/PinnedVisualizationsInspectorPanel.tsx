"use client";

import { Database, Pin } from "lucide-react";

import type { AnalysisNodeKind } from "@/kernel/analysis-modules/analysisModuleContract";
import { ANALYSIS_FEATURE_MANIFESTS } from "@/kernel/analysis-modules/analysisModuleManifests";
import { usePostprocessingDefinitionsResource } from "@/kernel/resources/postprocessingDefinitionResources";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorOverviewFrame } from "../../primitives/InspectorOverviewFrame";

const PINNED_VISUALIZATIONS_KIND = "results.pinned_visualizations.root";

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

/**
 * Pinned visualizations of one analysis family (ADR 0054). Definitions are
 * saved with the project; each pinned node reuses the published mode node.
 */
export function PinnedVisualizationsInspectorPanel({ selection }: InspectorPanelProps) {
  const definitions = usePostprocessingDefinitionsResource();
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

  return (
    <div className="fm-inspector-panel" data-inspector-owner="results.pinned_visualizations">
      <InspectorOverviewFrame
        metrics={[
          { label: "Pinned", value: String(pinned.length), tone: pinned.length > 0 ? "success" : "neutral" },
          { label: "Storage", value: "project", tone: "neutral" },
          { label: "Scene revision", value: definitions.data ? String(definitions.data.scene_revision) : "—" },
          { label: "State", value: unavailable ? "not published" : definitions.status, tone: unavailable ? "warning" : "neutral" },
        ]}
        primary={
          unavailable ? (
            <FieldRow
              label="Field"
              value="The pinned field is not published by this run; remove it or rerun the study."
            />
          ) : pinned.length === 0 ? (
            <FieldRow label="Pinned" value="None. Use Pin mode visualization on a mode node." />
          ) : (
            pinned.map((definition) => (
              <FieldRow key={definition.definition_id} label={definition.label} value={definition.module_id} />
            ))
          )
        }
        primaryIcon={<Pin size={18} strokeWidth={1.5} />}
        primaryTitle={unavailable ? selection.label ?? "Pinned visualization" : "Pinned visualizations"}
        sections={[
          {
            id: "storage",
            title: "Storage",
            icon: <Database size={16} strokeWidth={1.5} />,
            summary: "saved with the project",
            content: (
              <>
                <FieldRow label="Resource" value="analysis/postprocessing/definitions" />
                <FieldRow label="Identity" value="run · stage · revision · field" />
              </>
            ),
          },
        ]}
      />
    </div>
  );
}
