"use client";

import { Database, Pin } from "lucide-react";

import { usePostprocessingDefinitionsResource } from "@/kernel/resources/postprocessingDefinitionResources";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorOverviewFrame } from "../../primitives/InspectorOverviewFrame";
import {
  buildPinnedVisualizationsInspectorModel,
  type PinnedVisualizationsInspectorModel,
} from "./PinnedVisualizationsInspectorModel";

/**
 * Pinned visualizations of one analysis family (ADR 0054). Definitions are
 * saved with the project; each pinned node reuses the published mode node.
 */
export function PinnedVisualizationsInspectorPanel({ selection }: InspectorPanelProps) {
  const definitions = usePostprocessingDefinitionsResource();
  const model = buildPinnedVisualizationsInspectorModel(selection, definitions);

  return (
    <div className="fm-inspector-panel" data-inspector-owner="results.pinned_visualizations">
      <InspectorOverviewFrame
        metrics={[
          { label: "Pinned", value: String(model.pinned.length), tone: model.pinned.length > 0 ? "success" : "neutral" },
          { label: "Storage", value: "project", tone: "neutral" },
          { label: "Scene revision", value: definitions.data ? String(definitions.data.scene_revision) : "—" },
          { label: "State", value: model.unavailable ? "not published" : definitions.status, tone: model.unavailable ? "warning" : "neutral" },
        ]}
        primary={<PinnedVisualizationsPrimary model={model} />}
        primaryIcon={<Pin size={18} strokeWidth={1.5} />}
        primaryTitle={model.unavailable ? selection.label ?? "Pinned visualization" : "Pinned visualizations"}
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

function PinnedVisualizationsPrimary({
  model,
}: {
  model: PinnedVisualizationsInspectorModel;
}) {
  if (model.unavailable) {
    return (
      <FieldRow
        label="Field"
        value="The pinned field is not published by this run; remove it or rerun the study."
      />
    );
  }
  if (model.pinned.length === 0) {
    return <FieldRow label="Pinned" value="None. Use Pin mode visualization on a mode node." />;
  }
  return (
    <>
      {model.pinned.map((definition) => (
        <FieldRow
          key={definition.definition_id}
          label={definition.label}
          value={definition.module_id}
        />
      ))}
    </>
  );
}

