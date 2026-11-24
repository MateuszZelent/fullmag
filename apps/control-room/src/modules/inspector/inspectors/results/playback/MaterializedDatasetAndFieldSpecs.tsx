"use client";

import {
  Activity,
  Box,
  Database,
  Gauge,
  GitCommit,
  History,
  Layers,
  Sigma,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useMemo,
} from "react";
import type { MaterializedDatasetResource } from "@/kernel/api/apiTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useSavedResultScope } from "@/kernel/saved-results/useSavedRun";
import { useMaterializedDatasetResource } from "@/kernel/resources/solutionSetResources";
import { useFieldMetaResource } from "@/kernel/resources/studyRuntimeResources";
import {
  materializedDatasetSelectionMatches,
  returnToCurrentFieldView,
} from "@/kernel/visualization/savedFieldPresentation";
import { useSavedFieldPresentation } from "@/kernel/visualization/useObjectVisualization";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import type { InspectorSpec } from "../../../template";
import { materializedDatasetSelection } from "../../../panels/MaterializedDatasetInspectorPanel.model";
import { MaterializedDatasetValues } from "../../../panels/MaterializedDatasetValues";
import { SavedFieldVisualizationPanel } from "../../../panels/SavedFieldVisualizationPanel";
import { savedFieldPresentationForDataset } from "../../../panels/SavedFieldVisualizationPanel.model";
import { ConnectedInspectorSpec } from "../../../panels/study/ConnectedInspectorSpec";
import { type EmptyPostprocessingDraft, DEFAULT_POSTPROCESSING_DRAFT } from "./playbackShared";

export function MaterializedDatasetTemplateInspectorPanel(
  props: InspectorPanelProps,
) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedMaterializedDatasetTemplatePanel {...props} />;
  }
  return (
    <MaterializedDatasetTemplateView
      {...props}
      activeProjectId={null}
      activeRunId={null}
      dataset={null}
      errorMessage={null}
      matRef={materializedDatasetSelection(props.selection)}
      projectMatches
      refreshWarning={null}
      resourceStatus="idle"
      savedPresentation={null}
    />
  );
}

function ConnectedMaterializedDatasetTemplatePanel(props: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const matRef = materializedDatasetSelection(props.selection);
  const scope = useSavedResultScope();
  const { presentation } = useSavedFieldPresentation();
  const projectMatches = scope.matches(matRef);
  const resource = useMaterializedDatasetResource(
    matRef?.projectId,
    matRef?.runId,
    matRef?.solutionSetId,
    matRef?.containingRevision,
    matRef?.memberId,
    matRef?.artifactId,
    { enabled: projectMatches },
  );
  const savedPresentation = useMemo(
    () => (matRef ? savedFieldPresentationForDataset(presentation, matRef) : null),
    [matRef, presentation],
  );
  return (
    <MaterializedDatasetTemplateView
      {...props}
      activeProjectId={scope.projectId}
      activeRunId={scope.runId}
      dataset={resource.data ?? null}
      errorMessage={resource.error?.message ?? null}
      matRef={matRef}
      projectMatches={projectMatches}
      refreshWarning={resource.refreshError?.message ?? null}
      resourceStatus={resource.status}
      savedPresentation={savedPresentation}
      onResetSavedDisplay={() => {
        if (kernel) {
          returnToCurrentFieldView(
            kernel.visualization,
            kernel.selection,
            "inspector",
          );
        }
      }}
    />
  );
}

function formatDatasetFunctionSpace(
  functionSpace: MaterializedDatasetResource["field"]["descriptor"]["function_space"],
): string {
  if (!functionSpace) return "—";
  return `${functionSpace.family} ${functionSpace.order} · ${functionSpace.space_id} · ${functionSpace.ordering}`;
}

function MaterializedDatasetTemplateView({
  activeProjectId,
  activeRunId,
  dataset,
  errorMessage,
  matRef,
  onResetSavedDisplay,
  projectMatches,
  refreshWarning,
  resourceStatus,
  savedPresentation,
  selection,
}: InspectorPanelProps & {
  activeProjectId: string | null;
  activeRunId: string | null;
  dataset: MaterializedDatasetResource | null;
  errorMessage: string | null;
  matRef: ReturnType<typeof materializedDatasetSelection>;
  onResetSavedDisplay?: () => void;
  projectMatches: boolean;
  refreshWarning: string | null;
  resourceStatus: string;
  savedPresentation: ReturnType<typeof savedFieldPresentationForDataset>;
}) {
  const kernel = useContext(KernelContext);
  const identityMismatch =
    matRef !== null &&
    dataset !== null &&
    !materializedDatasetSelectionMatches(matRef, dataset);
  const validDataset = identityMismatch ? null : dataset;

  const alertMessage = useMemo(() => {
    if (!matRef) {
      return kernel ? "Pinned dataset selection is missing." : null;
    }
    if (!projectMatches) {
      if (activeRunId) {
        return `The pinned dataset belongs to run ${matRef.runId} in project ${matRef.projectId}. Open that saved run to inspect it.`;
      }
      return `The pinned dataset belongs to project ${matRef.projectId}, but the active project is ${activeProjectId ?? "not open"}. Open the owning project to inspect it.`;
    }
    if (errorMessage) {
      return `Could not load the pinned materialized dataset: ${errorMessage}`;
    }
    if (identityMismatch) {
      return "The returned manifest does not match the selected immutable identity.";
    }
    return null;
  }, [activeProjectId, activeRunId, errorMessage, identityMismatch, kernel, matRef, projectMatches]);

  const statusNotice = useMemo(() => {
    if (alertMessage || !matRef || !kernel) return null;
    if (resourceStatus === "loading" && !dataset) {
      return "Verifying pinned materialized dataset…";
    }
    if (!dataset) {
      return "Materialized dataset is not published yet.";
    }
    return null;
  }, [alertMessage, dataset, kernel, matRef, resourceStatus]);

  const spec = useMemo<InspectorSpec<EmptyPostprocessingDraft>>(
    () => ({
      id: `results.materialized_dataset:${selection.nodeId ?? matRef?.artifactId ?? "mat"}`,
      header: {
        breadcrumbs: [
          { id: "res", label: "Results" },
          { id: "mat", label: selection.label || "Materialized Dataset" },
        ],
      },
      identity: {
        domain: "physics",
        icon: Database,
        title: () =>
          validDataset?.dataset.dataset_id ||
          selection.label ||
          "Materialized Field Dataset",
        kindLabel: "Pinned Zarr v3 solution array",
        entityId: validDataset?.dataset.dataset_id ?? matRef?.datasetId ?? undefined,
        statePill: () => ({
          tone: alertMessage ? "err" : validDataset ? "ok" : "neutral",
          label: alertMessage
            ? "Mismatch"
            : validDataset
              ? `Integrity ${validDataset.integrity}`
              : resourceStatus === "loading"
                ? "Verifying…"
                : "Materialized",
        }),
      },
      facts: () => [
        {
          id: "field",
          label: "Field",
          value: validDataset?.field_id ?? matRef?.fieldId ?? "—",
        },
        {
          id: "unit",
          label: "Unit",
          value: validDataset?.field.descriptor.unit ?? "—",
        },
        {
          id: "dtype",
          label: "Dtype",
          value: validDataset?.field.coverage.dtype ?? "—",
        },
        {
          id: "chunks",
          label: "Chunks",
          value:
            validDataset?.field.coverage.chunk_count != null
              ? String(validDataset.field.coverage.chunk_count)
              : "—",
        },
      ],
      notices: () => [
        ...(alertMessage
          ? [{ id: "mat-alert", tone: "err" as const, text: alertMessage }]
          : []),
        ...(statusNotice
          ? [{ id: "mat-status", tone: "info" as const, text: statusNotice }]
          : []),
      ],
      modeTabs: [
        { id: "overview", label: "Overview" },
        { id: "data", label: "Data" },
        { id: "provenance", label: "Provenance" },
        { id: "diagnostics", label: "Diagnostics" },
      ],
      sections: [
        ...(validDataset && savedPresentation
          ? [
              {
                id: "saved-field-3d",
                modeTabId: "overview",
                title: "Saved Field 3D Visualization",
                icon: Layers,
                defaultOpen: true,
                live: true,
                rows: [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: () => (
                      <SavedFieldVisualizationPanel
                        dataset={validDataset}
                        presentation={savedPresentation}
                        refreshWarning={refreshWarning}
                      />
                    ),
                  },
                ],
              },
            ]
          : []),
        {
          id: "pinned-identity",
          modeTabId: "provenance",
          title: "Pinned Identity",
          icon: GitCommit,
          defaultOpen: true,
          rows: [
            {
              type: "readonly",
              label: "Project",
              mono: true,
              format: () => validDataset?.project_id ?? matRef?.projectId ?? "—",
            },
            {
              type: "readonly",
              label: "Run",
              mono: true,
              format: () => validDataset?.run_id ?? matRef?.runId ?? "—",
            },
            {
              type: "readonly",
              label: "SolutionSet",
              mono: true,
              format: () =>
                validDataset?.solution_set_id ?? matRef?.solutionSetId ?? "—",
            },
            {
              type: "readonly",
              label: "Containing revision",
              mono: true,
              format: () =>
                validDataset?.containing_solution_revision ??
                matRef?.containingRevision ??
                "—",
            },
            {
              type: "readonly",
              label: "Owner revision",
              mono: true,
              format: () => validDataset?.owner_solution_revision ?? "—",
            },
            {
              type: "readonly",
              label: "Member",
              mono: true,
              format: () => validDataset?.member_id ?? matRef?.memberId ?? "—",
            },
            {
              type: "readonly",
              label: "Manifest root",
              mono: true,
              format: () =>
                validDataset?.manifest_object_ref ?? matRef?.manifestObjectRef ?? "—",
            },
          ],
        },
        ...(validDataset
          ? [
              {
                id: "dataset-status",
                modeTabId: "diagnostics",
                title: "Dataset Status & Assessment",
                icon: Activity,
                defaultOpen: true,
                rows: [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: () => (
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="success">Integrity {validDataset.integrity}</Badge>
                        <Badge variant="secondary">
                          Availability {validDataset.dataset.status.availability}
                        </Badge>
                        <Badge variant="secondary">
                          Owner revision execution {validDataset.owner_execution_status}
                        </Badge>
                        <Badge variant="secondary">
                          Assessment {validDataset.owner_scientific_assessment.status}
                        </Badge>
                      </div>
                    ),
                  },
                  {
                    type: "readonly" as const,
                    label: "Dataset",
                    mono: true,
                    format: () =>
                      `${validDataset.dataset.dataset_id} · revision ${validDataset.dataset.revision}`,
                  },
                  {
                    type: "readonly" as const,
                    label: "Definition",
                    mono: true,
                    format: () =>
                      `${validDataset.definition.definition_id} · revision ${validDataset.definition.revision}`,
                  },
                  {
                    type: "readonly" as const,
                    label: "Scientific reason",
                    format: () =>
                      validDataset.owner_scientific_assessment.reason ?? "—",
                  },
                  {
                    type: "readonly" as const,
                    label: "Evidence artifacts",
                    format: () =>
                      String(validDataset.owner_scientific_assessment.evidence_artifact_count),
                  },
                ],
              },
              {
                id: "field-semantics",
                modeTabId: "overview",
                title: "Field Semantics",
                icon: Sigma,
                defaultOpen: true,
                rows: [
                  {
                    type: "readonly" as const,
                    label: "Sample / item / field",
                    mono: true,
                    format: () =>
                      `${validDataset.sample_id} / ${validDataset.item_id} / ${validDataset.field_id}`,
                  },
                  {
                    type: "readonly" as const,
                    label: "Quantity",
                    mono: true,
                    format: () => validDataset.field.descriptor.quantity_id,
                  },
                  {
                    type: "readonly" as const,
                    label: "Unit",
                    format: () => validDataset.field.descriptor.unit,
                  },
                  {
                    type: "readonly" as const,
                    label: "Frame",
                    mono: true,
                    format: () =>
                      `${validDataset.field.descriptor.frame.kind} · ${validDataset.field.descriptor.frame.frame_id}`,
                  },
                  {
                    type: "readonly" as const,
                    label: "Support",
                    mono: true,
                    format: () =>
                      validDataset.field.descriptor.active_support.support_fingerprint,
                  },
                  {
                    type: "readonly" as const,
                    label: "Function space",
                    format: () =>
                      formatDatasetFunctionSpace(validDataset.field.descriptor.function_space),
                  },
                  {
                    type: "readonly" as const,
                    label: "Plane / representation",
                    format: () =>
                      `${validDataset.field.plane} / ${validDataset.field.descriptor.value_representation}`,
                  },
                  {
                    type: "readonly" as const,
                    label: "Normalization",
                    format: () => validDataset.field.descriptor.normalization,
                  },
                  {
                    type: "readonly" as const,
                    label: "Complex encoding",
                    format: () => validDataset.field.descriptor.complex_encoding,
                  },
                ],
              },
              {
                id: "coverage-provenance",
                modeTabId: "provenance",
                title: "Zarr Coverage, Chunks & Provenance",
                icon: Database,
                defaultOpen: true,
                rows: [
                  {
                    type: "readonly" as const,
                    label: "Dtype / endian",
                    mono: true,
                    format: () =>
                      `${validDataset.field.coverage.dtype} / ${validDataset.field.coverage.endian}`,
                  },
                  {
                    type: "readonly" as const,
                    label: "Elements / components",
                    mono: true,
                    format: () =>
                      `${validDataset.field.coverage.total_elements} / ${validDataset.field.coverage.component_count}`,
                  },
                  {
                    type: "readonly" as const,
                    label: "Bytes / chunks",
                    mono: true,
                    format: () =>
                      `${validDataset.field.coverage.total_bytes} / ${validDataset.field.coverage.chunk_count}`,
                  },
                  {
                    type: "readonly" as const,
                    label: "Tensor artifact",
                    mono: true,
                    format: () => validDataset.field.tensor_artifact.artifact_id,
                  },
                  {
                    type: "readonly" as const,
                    label: "Tensor object",
                    mono: true,
                    format: () => validDataset.field.tensor_artifact.object_ref,
                  },
                  {
                    type: "readonly" as const,
                    label: "RunSpec digest",
                    mono: true,
                    format: () => validDataset.source.run_spec_digest,
                  },
                  {
                    type: "readonly" as const,
                    label: "Source member / artifact",
                    mono: true,
                    format: () =>
                      `${validDataset.source.member_id} / ${validDataset.source.artifact_id}`,
                  },
                  {
                    type: "readonly" as const,
                    label: "Source tensor",
                    mono: true,
                    format: () => validDataset.source.tensor_object_ref,
                  },
                ],
              },
              {
                id: "windowed-values",
                modeTabId: "data",
                title: "Windowed Values",
                icon: Database,
                defaultOpen: true,
                rows: [
                  {
                    type: "custom" as const,
                    label: "Windowed values",
                    wide: true,
                    render: () => (
                      <MaterializedDatasetValues
                        dataset={validDataset}
                        key={JSON.stringify(matRef)}
                      />
                    ),
                  },
                ],
              },
            ]
          : []),
      ],
      commitBar: savedPresentation
        ? {
            mode: "liveViewport",
            hasOverrides: () => false,
            onResetDisplay: () => {
              onResetSavedDisplay?.();
            },
          }
        : { mode: "readOnly" },
    }),
    [
      alertMessage,
      matRef,
      onResetSavedDisplay,
      refreshWarning,
      resourceStatus,
      savedPresentation,
      selection.label,
      selection.nodeId,
      statusNotice,
      validDataset,
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

function formatFiniteStat(
  value: number | null | undefined,
  unit?: string | null,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const suffix = unit ? ` ${unit}` : "";
  return `${value.toPrecision(6)}${suffix}`;
}

export function FieldQuantityTemplateInspectorPanel(props: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const requestedId = props.selection.nodeId?.startsWith("results:field:")
    ? props.selection.nodeId.slice("results:field:".length)
    : "m";
  return kernel ? (
    <ConnectedFieldQuantityTemplate {...props} requestedId={requestedId} />
  ) : (
    <FieldQuantityTemplateView
      {...props}
      meta={null}
      requestedId={requestedId}
      resourceStatus="idle"
    />
  );
}

function ConnectedFieldQuantityTemplate(
  props: InspectorPanelProps & { requestedId: string },
) {
  const fieldRes = useFieldMetaResource({ quantityId: props.requestedId });
  return (
    <FieldQuantityTemplateView
      {...props}
      meta={fieldRes.data ?? null}
      resourceStatus={fieldRes.status}
    />
  );
}

function FieldQuantityTemplateView({
  meta,
  requestedId,
  resourceStatus,
  selection,
}: InspectorPanelProps & {
  meta: ReturnType<typeof useFieldMetaResource>["data"];
  requestedId: string;
  resourceStatus: string;
}) {
  const kernel = useContext(KernelContext);
  const state = meta?.state ?? (resourceStatus === "idle" ? "Published" : resourceStatus);
  const statsRecord = (meta?.stats ?? null) as Record<string, unknown> | null;
  const normValue =
    typeof statsRecord?.norm === "number"
      ? statsRecord.norm
      : typeof statsRecord?.l2_norm === "number"
        ? statsRecord.l2_norm
        : null;

  const showIn3D = useCallback(() => {
    kernel?.layout?.setActiveViewportMainModule?.("viewport-3d");
    kernel?.layout?.setFocusedSlot?.("viewport-main");
    if (kernel) {
      void kernel.commands.execute(
        "workspace.focus-selection",
        createCommandContext("inspector", kernel),
      );
    }
  }, [kernel]);

  const spec = useMemo<InspectorSpec<EmptyPostprocessingDraft>>(
    () => ({
      id: `results.field_quantity:${requestedId}`,
      header: {
        breadcrumbs: [
          { id: "res", label: "Results" },
          { id: "field", label: meta?.label ?? selection.label ?? requestedId },
        ],
        ...(kernel
          ? {
              primaryHeaderAction: {
                label: "Show in 3D",
                icon: Box,
                onRun: () => showIn3D(),
              },
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: Activity,
        title: () => meta?.label ?? selection.label ?? requestedId,
        kindLabel: "Materialized spatial field quantity",
        entityId: meta?.quantity_id ?? requestedId,
        statePill: () => ({
          tone: state === "complete" || state === "ready" ? "ok" : "neutral",
          label: state,
        }),
      },
      facts: () => [
        {
          id: "comp",
          label: "Components",
          value: meta ? String(meta.components) : "—",
        },
        { id: "loc", label: "Location", value: meta?.location ?? "—" },
        { id: "state", label: "State", value: state },
        {
          id: "stale",
          label: "Stale steps",
          value: meta ? String(meta.stale_by_steps) : "—",
        },
      ],
      sections: [
        {
          id: "identity-support",
          title: "Field Quantity & Support",
          icon: Activity,
          defaultOpen: true,
          rows: [
            {
              type: "readonly",
              label: "Quantity",
              format: () => meta?.label ?? selection.label ?? requestedId,
            },
            {
              type: "readonly",
              label: "Quantity ID",
              mono: true,
              format: () => meta?.quantity_id ?? requestedId,
            },
            {
              type: "readonly",
              label: "Unit",
              format: () => meta?.unit ?? "—",
            },
            {
              type: "readonly",
              label: "Field kind",
              format: () => meta?.kind ?? "—",
            },
            {
              type: "readonly",
              label: "Support location",
              format: () => meta?.location ?? "—",
            },
            {
              type: "custom",
              wide: true,
              render: () => (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    type="button"
                    variant="primary"
                    onClick={showIn3D}
                  >
                    <Box aria-hidden="true" size={13} />
                    <span>Show in 3D</span>
                  </Button>
                </div>
              ),
            },
          ],
        },
        {
          id: "stats",
          title: "Spatial Statistics",
          icon: Gauge,
          defaultOpen: true,
          rows: [
            {
              type: "readonly",
              label: "Minimum",
              mono: true,
              format: () => formatFiniteStat(meta?.stats?.min, meta?.unit),
            },
            {
              type: "readonly",
              label: "Mean",
              mono: true,
              format: () => formatFiniteStat(meta?.stats?.mean, meta?.unit),
            },
            {
              type: "readonly",
              label: "Maximum",
              mono: true,
              format: () => formatFiniteStat(meta?.stats?.max, meta?.unit),
            },
            {
              type: "readonly",
              label: "Norm",
              mono: true,
              format: () => formatFiniteStat(normValue, meta?.unit),
            },
          ],
        },
        {
          id: "materialization",
          title: "Materialization",
          icon: Database,
          defaultOpen: true,
          rows: [
            {
              type: "readonly",
              label: "Resource state",
              format: () => resourceStatus,
            },
            {
              type: "readonly",
              label: "Materialization state",
              format: () => state,
            },
            {
              type: "readonly",
              label: "Error",
              format: () => meta?.materialization_error ?? "none",
            },
            {
              type: "readonly",
              label: "Wall time",
              mono: true,
              format: () => formatFiniteStat(meta?.materialization_wall_time_ns, "ns"),
            },
          ],
        },
        {
          id: "provenance",
          title: "Provenance",
          icon: History,
          defaultOpen: false,
          rows: [
            {
              type: "readonly",
              label: "Field revision",
              mono: true,
              format: () => (meta ? String(meta.field_revision) : "—"),
            },
            {
              type: "readonly",
              label: "Source revision",
              mono: true,
              format: () => (meta ? String(meta.source_revision) : "—"),
            },
            {
              type: "readonly",
              label: "Source step",
              mono: true,
              format: () => (meta ? String(meta.source_step) : "—"),
            },
            {
              type: "readonly",
              label: "Domain generation",
              mono: true,
              format: () => meta?.domain_generation_id ?? "—",
            },
          ],
        },
      ],
      commitBar: { mode: "readOnly" },
    }),
    [kernel, meta, normValue, requestedId, resourceStatus, selection.label, showIn3D, state],
  );

  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_POSTPROCESSING_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}
