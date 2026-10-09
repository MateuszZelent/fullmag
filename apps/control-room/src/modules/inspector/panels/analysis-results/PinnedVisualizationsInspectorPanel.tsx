"use client";

import { Database, Pin } from "lucide-react";

import { usePostprocessingDefinitionsResource } from "@/kernel/resources/postprocessingDefinitionResources";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorOverviewFrame } from "../../primitives/InspectorOverviewFrame";

/**
 * Pinned visualizations of one analysis family (ADR 0054). Definitions are
 * saved with the project; each pinned node reuses the published mode node.
 */
export function PinnedVisualizationsInspectorPanel({ selection }: InspectorPanelProps) {
  const definitions = usePostprocessingDefinitionsResource();
  const pinned = definitions.data?.definitions ?? [];
  const unavailable = selection.label !== "Pinned visualizations";

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
