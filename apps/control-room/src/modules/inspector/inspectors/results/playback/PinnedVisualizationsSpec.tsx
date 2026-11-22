"use client";

import {
  Box,
  Database,
  Pin,
  PinOff,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useMemo,
} from "react";
import type { AnalysisNodeKind } from "@/kernel/analysis-modules/analysisModuleContract";
import { ANALYSIS_FEATURE_MANIFESTS } from "@/kernel/analysis-modules/analysisModuleManifests";
import { UNPIN_POSTPROCESSING_DEFINITION_COMMAND } from "@/kernel/analysis-modules/postprocessingCommandContributions";
import type { PostprocessingDefinition } from "@/kernel/api/apiTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { usePostprocessingDefinitionsResource } from "@/kernel/resources/postprocessingDefinitionResources";
import { Button } from "@/shared/ui/Button";
import { EmptyState } from "@/shared/ui/EmptyState";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import type { InspectorSpec } from "../../../template";
import { ConnectedInspectorSpec } from "../../../panels/study/ConnectedInspectorSpec";
import { type EmptyPostprocessingDraft, DEFAULT_POSTPROCESSING_DRAFT } from "./playbackShared";

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

function isDrivenPinnedVisualization(def: PostprocessingDefinition): boolean {
  const fieldId = def.data_ref.field_id ?? "";
  if (fieldId.startsWith("analysis:eigen:")) return false;
  if (fieldId.startsWith("analysis:frequency-response:")) return true;
  const settings =
    def.settings && typeof def.settings === "object" && !Array.isArray(def.settings)
      ? (def.settings as Record<string, unknown>)
      : null;
  if (
    settings?.source === "frequency-response" ||
    settings?.study_product === "driven_response" ||
    typeof settings?.frequencyIndex === "number" ||
    typeof settings?.frequency_index === "number"
  ) {
    return true;
  }
  const itemId = (def.data_ref.item_id ?? "").toLowerCase();
  if (itemId.startsWith("frequency") || itemId.startsWith("response")) {
    return true;
  }
  const datasetId = def.data_ref.dataset_id.toLowerCase();
  return (
    datasetId.includes("driven") ||
    datasetId.includes("frequency_response") ||
    datasetId.includes("frequency-response")
  );
}

function resolvePinnedFrequencyIndex(def: PostprocessingDefinition): number | undefined {
  const settings =
    def.settings && typeof def.settings === "object" && !Array.isArray(def.settings)
      ? (def.settings as Record<string, unknown>)
      : null;
  if (
    typeof settings?.frequencyIndex === "number" &&
    Number.isFinite(settings.frequencyIndex)
  ) {
    return settings.frequencyIndex;
  }
  if (
    typeof settings?.frequency_index === "number" &&
    Number.isFinite(settings.frequency_index)
  ) {
    return settings.frequency_index;
  }
  const itemMatch = def.data_ref.item_id?.match(/(\d+)$/);
  if (itemMatch?.[1] !== undefined) {
    const parsed = Number(itemMatch[1]);
    if (Number.isFinite(parsed)) return parsed;
  }
  const fieldMatch = def.data_ref.field_id?.match(/(?:frequency|field|point)[-_](\d+)$/i);
  if (fieldMatch?.[1] !== undefined) {
    const parsed = Number(fieldMatch[1]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function PinnedVisualizationsTemplateInspectorPanel(
  props: InspectorPanelProps,
) {
  const kernel = useContext(KernelContext);
  return kernel ? (
    <ConnectedPinnedVisualizationsTemplate {...props} />
  ) : (
    <PinnedVisualizationsTemplateView
      {...props}
      definitions={[]}
      resourceStatus="ready"
      sceneRevision={null}
    />
  );
}

function ConnectedPinnedVisualizationsTemplate(props: InspectorPanelProps) {
  const definitionsRes = usePostprocessingDefinitionsResource();
  return (
    <PinnedVisualizationsTemplateView
      {...props}
      definitions={definitionsRes.data?.definitions ?? []}
      resourceStatus={definitionsRes.status}
      sceneRevision={definitionsRes.data?.scene_revision ?? null}
    />
  );
}

function PinnedVisualizationsTemplateView({
  definitions,
  resourceStatus,
  sceneRevision,
  selection,
}: InspectorPanelProps & {
  definitions: readonly PostprocessingDefinition[];
  resourceStatus: string;
  sceneRevision: number | null;
}) {
  const kernel = useContext(KernelContext);
  const group = selectedPinnedGroup(selection);
  const nodeKind = group ? `${group.moduleId}.mode_visualization` : null;
  const schema = group ? modeVisualizationSchema(group.moduleId) : undefined;
  const unpublishedGroup = group === null || schema === undefined;

  const pinned = useMemo(() => {
    if (!group || !nodeKind || !schema) return [];
    return definitions.filter(
      (definition) =>
        definition.module_id === group.moduleId &&
        definition.data_ref.run_id === group.runId &&
        definition.node_kind === nodeKind &&
        definition.definition_schema === schema,
    );
  }, [definitions, group, nodeKind, schema]);

  const leafDefinitionId = useMemo(() => {
    if (!unpublishedGroup || !selection.nodeId) return null;
    const parts = selection.nodeId.split(":pinned:");
    return parts.length > 1 && parts[1] ? decodeURIComponent(parts[1]) : null;
  }, [selection.nodeId, unpublishedGroup]);

  const activatePinnedIn3D = useCallback(
    (def: PostprocessingDefinition) => {
      if (!kernel || !def.data_ref.field_id) return;
      const isDriven = isDrivenPinnedVisualization(def);
      const frequencyIndex = isDriven ? resolvePinnedFrequencyIndex(def) : undefined;
      void kernel.commands.execute(
        isDriven
          ? "analysis.frequency-response.plot-response-field-3d"
          : "analysis.eigen.plot-mode-3d",
        createCommandContext("inspector", kernel, {
          sourceDetail: "results.pinned_visualizations.root",
        }),
        {
          fieldId: def.data_ref.field_id,
          ...(frequencyIndex !== undefined ? { frequencyIndex } : {}),
          label: def.label,
          phaseRad: 0,
          source: isDriven ? "frequency-response" : "eigen-mode",
          view: "phase_rotated_real",
        },
      );
    },
    [kernel],
  );

  const openPinnedPublishedTarget = useCallback(
    (def: PostprocessingDefinition) => {
      if (!kernel) return;
      const dRef = def.data_ref;
      const isDispersion = def.module_id.includes("dispersion");
      const isDriven = isDrivenPinnedVisualization(def);
      const targetKind = isDriven
        ? isDispersion
          ? "results.dispersion.driven.field_at_k"
          : "results.resonance.driven.field"
        : isDispersion
          ? "results.dispersion.modal.mode_at_k"
          : "results.resonance.modal.mode";
      const targetNodeId = `${selection.nodeId ?? "results:pinned"}:${def.definition_id}`;
      const sampleMatch = dRef.sample_id?.match(/(\d+)$/);
      const itemMatch = dRef.item_id?.match(/(\d+)$/);
      const parsedSampleIndex = sampleMatch ? Number(sampleMatch[1]) : undefined;
      const parsedItemIndex = itemMatch ? Number(itemMatch[1]) : undefined;
      const frequencyIndex = isDriven ? resolvePinnedFrequencyIndex(def) : undefined;
      kernel.selection.set(
        {
          kind: targetKind,
          label: def.label,
          nodeId: targetNodeId,
          objectId: null,
          ref: {
            analysisRunId: dRef.run_id,
            datasetId: dRef.dataset_id,
            datasetRevision: dRef.dataset_revision,
            fieldId: dRef.field_id ?? undefined,
            ...(isDriven && frequencyIndex !== undefined
              ? { frequencyIndex }
              : {}),
            kind: targetKind,
            modeId: dRef.item_id ?? undefined,
            ...(!isDriven && parsedItemIndex !== undefined
              ? { modeIndex: parsedItemIndex }
              : {}),
            nodeId: targetNodeId,
            sampleId: dRef.sample_id ?? undefined,
            ...(parsedSampleIndex !== undefined ? { sampleIndex: parsedSampleIndex } : {}),
            source: isDriven ? "frequency-response" : "eigen-mode",
            type: "frequency-domain",
          },
        },
        "inspector",
      );
    },
    [kernel, selection.nodeId],
  );

  const spec = useMemo<InspectorSpec<EmptyPostprocessingDraft>>(
    () => ({
      id: `results.pinned_visualizations.root:${selection.nodeId ?? "pinned"}`,
      header: {
        breadcrumbs: [
          { id: "res", label: "Results" },
          { id: "pinned", label: "Pinned Visualizations" },
        ],
      },
      identity: {
        domain: "visualization",
        icon: Pin,
        title: () =>
          unpublishedGroup
            ? selection.label || "Pinned visualization"
            : "Pinned Visualizations",
        kindLabel: "Project-persisted 3D mode & field views",
        statePill: () => ({
          tone: unpublishedGroup ? "warn" : pinned.length > 0 ? "ok" : "neutral",
          label: unpublishedGroup ? "not published" : `${pinned.length} pinned`,
        }),
      },
      facts: () => [
        { id: "count", label: "Pinned", value: String(pinned.length) },
        { id: "storage", label: "Storage", value: "project" },
        {
          id: "rev",
          label: "Scene revision",
          value: sceneRevision !== null ? String(sceneRevision) : "—",
        },
        {
          id: "state",
          label: "State",
          value: unpublishedGroup ? "not published" : resourceStatus,
        },
      ],
      notices: () =>
        unpublishedGroup
          ? [
              {
                id: "unpublished-pin",
                tone: "warn",
                text: "The pinned field is not published by this run; remove it or rerun the study.",
                ...(leafDefinitionId && kernel
                  ? {
                      quickFix: {
                        label: "Unpin visualization",
                        onApply: () => {
                          void kernel.commands.execute(
                            UNPIN_POSTPROCESSING_DEFINITION_COMMAND,
                            createCommandContext("inspector", kernel),
                            { definitionId: leafDefinitionId },
                          );
                        },
                      },
                    }
                  : {}),
              },
            ]
          : [],
      sections: [
        {
          id: "pinned-list",
          title: "Saved Visualization Pins",
          icon: Pin,
          defaultOpen: true,
          rows: unpublishedGroup
            ? [
                {
                  type: "readonly",
                  label: "Field",
                  format: () =>
                    "The pinned field is not published by this run; remove it or rerun the study.",
                },
              ]
            : pinned.length === 0
              ? [
                  {
                    type: "custom",
                    label: "Pinned items",
                    wide: true,
                    render: () => (
                      <EmptyState
                        description="Use Pin Mode Visualization on any eigenmode or response field node to bookmark it here."
                        heading="No pinned visualizations"
                      />
                    ),
                  },
                ]
              : pinned.map((def) => ({
                  type: "custom" as const,
                  label: def.label,
                  wide: true,
                  render: () => (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-fm-border px-2.5 py-1.5 text-xs">
                      <div className="min-w-0">
                        <span className="block truncate font-medium">{def.label}</span>
                        <span className="block truncate text-fm-muted font-mono">
                          {def.module_id} · {def.data_ref.field_id ?? def.definition_id}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          aria-label={`Activate ${def.label} in 3D`}
                          disabled={!def.data_ref.field_id}
                          disabledReason="Pinned definition has no published field ID"
                          size="sm"
                          type="button"
                          variant="primary"
                          onClick={() => activatePinnedIn3D(def)}
                        >
                          <Box aria-hidden="true" size={12} />
                          <span>Activate in 3D</span>
                        </Button>
                        <Button
                          aria-label={`Open ${def.label}`}
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={() => openPinnedPublishedTarget(def)}
                        >
                          <span>Open</span>
                        </Button>
                        <Button
                          aria-label={`Unpin ${def.label}`}
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={() => {
                            if (!kernel) return;
                            void kernel.commands.execute(
                              UNPIN_POSTPROCESSING_DEFINITION_COMMAND,
                              createCommandContext("inspector", kernel),
                              { definitionId: def.definition_id },
                            );
                          }}
                        >
                          <PinOff aria-hidden="true" size={13} />
                        </Button>
                      </div>
                    </div>
                  ),
                })),
        },
        {
          id: "storage-contract",
          title: "Storage & Identity",
          icon: Database,
          defaultOpen: false,
          rows: [
            {
              type: "readonly",
              label: "Resource",
              mono: true,
              format: () => "analysis/postprocessing/definitions",
            },
            {
              type: "readonly",
              label: "Identity",
              format: () => "run · stage · revision · field",
            },
          ],
        },
      ],
      commitBar: { mode: "readOnly" },
    }),
    [
      activatePinnedIn3D,
      kernel,
      leafDefinitionId,
      openPinnedPublishedTarget,
      pinned,
      resourceStatus,
      sceneRevision,
      selection.label,
      selection.nodeId,
      unpublishedGroup,
    ],
  );

  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_POSTPROCESSING_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}
