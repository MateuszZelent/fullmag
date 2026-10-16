"use client";

import { Database, FileText, Trash2 } from "lucide-react";
import { useState } from "react";

import {
  IMPORTED_REFERENCE_SCHEMA,
  importedReferencePoints,
} from "@/kernel/analysis-modules/postprocessingDefinitions";
import {
  REMOVE_DISPERSION_REFERENCE_COMMAND,
} from "@/kernel/analysis-modules/postprocessingCommandContributions";
import type { PostprocessingDefinition } from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { usePostprocessingDefinitionsResource } from "@/kernel/resources/postprocessingDefinitionResources";
import { Button } from "@/shared/ui/Button";
import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorOverviewFrame } from "../../primitives/InspectorOverviewFrame";

const REFERENCE_KIND = "analysis.dispersion.reference";

function selectedReference(selection: InspectorPanelProps["selection"]) {
  const ref = selection.ref;
  if (
    selection.kind !== REFERENCE_KIND ||
    ref?.type !== "analysis-reference" ||
    ref.kind !== REFERENCE_KIND ||
    selection.nodeId === null ||
    selection.nodeId !== ref.nodeId ||
    !ref.definitionId.trim() ||
    !ref.runId.trim() ||
    !ref.stageId.trim()
  ) {
    return null;
  }
  return ref;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function referenceMatchesSelection(
  definition: PostprocessingDefinition | undefined,
  reference: NonNullable<ReturnType<typeof selectedReference>>,
): definition is PostprocessingDefinition {
  return Boolean(
    definition &&
    definition.definition_id === reference.definitionId &&
    definition.module_id === "analysis.dispersion" &&
    definition.node_kind === REFERENCE_KIND &&
    definition.definition_schema === IMPORTED_REFERENCE_SCHEMA &&
    definition.data_ref.run_id === reference.runId &&
    definition.data_ref.dataset_id === reference.stageId,
  );
}

export function ImportedDispersionReferenceInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const kernel = useKernel();
  const definitions = usePostprocessingDefinitionsResource();
  const reference = selectedReference(selection);
  const candidate = reference && definitions.status === "ready"
    ? definitions.data?.definitions.find(
        (definition) => definition.definition_id === reference.definitionId,
      )
    : undefined;
  const definition = reference && referenceMatchesSelection(candidate, reference)
    ? candidate
    : undefined;
  const settings = definition ? record(definition.settings) : null;
  const sourceUnits = record(settings?.source_units);
  const fileName = typeof settings?.file_name === "string" ? settings.file_name : "Unavailable";
  const pathUnit = typeof sourceUnits?.path === "string" ? sourceUnits.path : "Unavailable";
  const frequencyUnit = typeof sourceUnits?.frequency === "string"
    ? sourceUnits.frequency
    : "Unavailable";
  const points = definition ? importedReferencePoints(definition) : null;
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const unavailableReason = !reference
    ? "The selected node has no imported dispersion reference identity."
    : definitions.status === "loading"
      ? "Loading the saved reference definition."
      : definitions.status === "error"
        ? "The saved reference definition could not be loaded."
        : definitions.status === "stale"
          ? "The saved reference definition is stale and cannot be changed."
          : definitions.status === "idle"
            ? "The saved reference definition has not been loaded yet."
            : candidate
              ? "This reference no longer matches the selected run and stage."
              : "This imported reference no longer exists in the current scene.";

  const removeReference = async (): Promise<void> => {
    if (!reference || !definition || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const result = await kernel.commands.execute(
        REMOVE_DISPERSION_REFERENCE_COMMAND,
        createCommandContext("inspector", kernel, { sourceDetail: "dispersion-reference" }),
        { definitionId: reference.definitionId },
      );
      setFeedback(result.message ?? (result.status === "completed" ? "Reference removed." : "Reference removal failed."));
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Reference removal failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fm-inspector-panel" data-inspector-owner="analysis.dispersion.reference">
      <InspectorOverviewFrame
        metrics={[
          {
            label: "Status",
            value: definition ? "Imported · not qualified" : "Unavailable",
            tone: definition ? "warning" : "neutral",
          },
          { label: "Points", value: definition ? String(points?.length ?? "Unavailable") : "—" },
          {
            label: "Scene revision",
            value: definitions.status === "ready" && definitions.data
              ? String(definitions.data.scene_revision)
              : "—",
          },
        ]}
        primary={definition ? (
          <>
            <FieldRow label="File" value={fileName} />
            <FieldRow label="Reference" value={definition.label} />
            <FieldRow label="Source units" value={pathUnit + " · " + frequencyUnit} />
            <FieldRow label="Run" value={reference?.runId ?? "Unavailable"} />
            <FieldRow label="Stage" value={reference?.stageId ?? "Unavailable"} />
            <Button
              disabled={busy}
              onClick={() => void removeReference()}
              size="sm"
              type="button"
              variant="danger"
            >
              <Trash2 size={15} strokeWidth={1.7} />
              {busy ? "Removing…" : "Remove reference"}
            </Button>
            {feedback ? <p role="status">{feedback}</p> : null}
          </>
        ) : (
          <FieldRow label="Reference" value={unavailableReason} />
        )}
        primaryIcon={<FileText size={18} strokeWidth={1.5} />}
        primaryTitle={definition?.label ?? selection.label ?? "Imported dispersion reference"}
        sections={[
          {
            id: "storage",
            title: "Storage",
            icon: <Database size={16} strokeWidth={1.5} />,
            summary: "saved with the project",
            content: (
              <>
                <FieldRow label="Resource" value="analysis/postprocessing/definitions" />
                <FieldRow label="Identity" value="definition · run · stage" />
              </>
            ),
          },
        ]}
      />
    </div>
  );
}
