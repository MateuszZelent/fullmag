"use client";

import { Pin, Database, GitCommit, Table2, TriangleAlert, Waves } from "lucide-react";

import { PIN_MODE_VISUALIZATION_COMMAND } from "@/kernel/analysis-modules/postprocessingCommandContributions";
import {
  useAnalysisResultBranchResource,
  useAnalysisResultDatasetManifestResource,
  useAnalysisResultItemResource,
  useAnalysisResultProjectionResource,
  useAnalysisResultSamplesResource,
} from "@/kernel/resources/analysisResultResources";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { AnalysisFieldOverlayState } from "@/kernel/visualization/AnalysisFieldOverlayController";
import {
  analysisResultFieldOverlayAdapter,
  createAnalysisResultFieldOverlayIntent,
} from "@/kernel/visualization/AnalysisResultFieldOverlayIntent";
import { Button } from "@/shared/ui/Button";
import { FrequencyDomainModeDisplayControls, useFrequencyDomainModeDisplaySettings } from "../FrequencyDomainModeDisplayControls";
import { ANALYSIS_FIELD_VIEW_OPTIONS } from "../FrequencyDomainModeDisplayControls.model";
import { ModeVisualizationPhaseControl } from "../ModeVisualizationInspectorPanel";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { InspectorOverviewFrame } from "../../primitives/InspectorOverviewFrame";
import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  type AnalysisResultSelectionRef,
} from "@/shared/domain/analysis/results";
import { buildAnalysisResultInspectorModel } from "./analysisResultInspectorModel";

function display(
  value: string | number | null | undefined,
  placeholder = "Unavailable",
): string {
  if (value == null || value === "") return placeholder;
  return String(value);
}

function sanitizeRows<T extends { value: string }>(
  rows: readonly T[],
  placeholder: string,
): readonly T[] {
  if (placeholder === "Unavailable") return rows;
  return rows.map((row) =>
    row.value === "Unavailable" ? { ...row, value: placeholder } : row,
  );
}

function resultSelection(selection: Selection) {
  return selection.ref?.type === "analysis-result" ? selection.ref : null;
}

function focusLabel(focus: string | undefined): string {
  switch (focus) {
    case "dataset":
      return "Dataset";
    case "slice":
      return "Slice";
    case "sample":
      return "Sample";
    case "item":
      return "Spectral item";
    case "branch":
      return "Branch";
    case "field":
      return "Field";
    case "projection-point":
      return "Projection point";
    default:
      return "Analysis result";
  }
}

export function AnalysisResultInspectorPanel({
  embedded = false,
  emptyPlaceholder = "Unavailable",
  selection,
}: InspectorPanelProps & {
  embedded?: boolean;
  emptyPlaceholder?: string;
}) {
  const resultRef = resultSelection(selection);
  const sampleId = resultRef?.sampleId;
  const sampleQuery = sampleId ? { limit: 1, sample_id: sampleId } : {};
  const manifest = useAnalysisResultDatasetManifestResource(
    resultRef?.runId,
    resultRef?.datasetId,
    { enabled: Boolean(resultRef) },
  );
  const sample = useAnalysisResultSamplesResource(
    resultRef?.runId,
    resultRef?.datasetId,
    { enabled: Boolean(sampleId), query: sampleQuery },
  );
  const branch = useAnalysisResultBranchResource(
    resultRef?.runId,
    resultRef?.datasetId,
    resultRef?.branchId,
    { enabled: Boolean(resultRef?.focus === "branch" && resultRef?.branchId) },
  );
  const item = useAnalysisResultItemResource(
    resultRef?.runId,
    resultRef?.datasetId,
    resultRef?.itemId,
    { enabled: Boolean(resultRef?.itemId) },
  );
  const projection = useAnalysisResultProjectionResource(
    resultRef?.runId,
    resultRef?.datasetId,
    resultRef?.projectionId,
    { enabled: Boolean(resultRef?.projectionId) },
  );

  if (!resultRef) {
    if (embedded) {
      return (
        <InspectorGroup title="Result diagnostics">
          <FieldRow
            label="Reference"
            value="The selected node does not contain an analysis-result reference."
          />
        </InspectorGroup>
      );
    }
    return (
      <div className="fm-inspector-panel" data-inspector-owner="results.analysis_result">
        <InspectorOverviewFrame
          metrics={[
            { label: "Scope", value: "Result" },
            { label: "Method", value: "Run-scoped result dataset" },
            { label: "Status", value: "missing" },
          ]}
          primary={
            <FieldRow
              label="Reference"
              value="The selected node does not contain an analysis-result reference."
            />
          }
          primaryIcon={<Database size={18} strokeWidth={1.5} />}
          primaryTitle="Analysis result"
          sections={[]}
        />
      </div>
    );
  }

  const itemData = item.data;
  const branchData = branch.data;
  const sampleData = sample.data?.items[0];
  const manifestData = manifest.data;
  const status =
    itemData?.status ??
    branchData?.status ??
    sampleData?.status ??
    manifestData?.status ??
    null;
  const transportStatus =
    item.status !== "idle"
      ? item.status
      : branch.status !== "idle"
        ? branch.status
        : sample.status !== "idle"
          ? sample.status
          : manifest.status;
  const diagnostics = [
    ...(manifestData?.status.reason_code
      ? [`Result status: ${manifestData.status.reason_code}`]
      : []),
    ...(manifestData?.status.detail ? [manifestData.status.detail] : []),
    ...(projection.data?.unsupported_reason
      ? [`Projection unsupported: ${projection.data.unsupported_reason}`]
      : []),
    ...(resultRef.focus === "branch" && !branchData && branch.status !== "loading"
      ? ["Branch detail is not available for the selected result dataset."]
      : []),
    ...(resultRef.focus === "field" && !itemData?.field_ref
      ? ["Spatial field data is not published for the selected result item."]
      : []),
    ...(itemData?.field_ref?.status === "unsupported"
      ? ["The selected field is marked unsupported by the result adapter."]
      : []),
  ];
  const rawInspectorModel = buildAnalysisResultInspectorModel({
    item: itemData,
    manifest: manifestData,
  });
  const inspectorModel =
    emptyPlaceholder === "Unavailable"
      ? rawInspectorModel
      : {
          axes: sanitizeRows(rawInspectorModel.axes, emptyPlaceholder),
          metadata: sanitizeRows(rawInspectorModel.metadata, emptyPlaceholder),
          provenance: sanitizeRows(rawInspectorModel.provenance, emptyPlaceholder),
          relations: sanitizeRows(rawInspectorModel.relations, emptyPlaceholder),
          sources: sanitizeRows(rawInspectorModel.sources, emptyPlaceholder),
        };

  const properties: readonly { label: string; mono?: boolean; unit?: string; value: string }[] = [
    { label: "Run", mono: true, value: resultRef.runId },
    { label: "Stage", mono: true, value: resultRef.stageId },
    { label: "Dataset", mono: true, value: resultRef.datasetId },
    { label: "Dataset revision", mono: true, value: resultRef.datasetRevision },
    { label: "Sample", mono: true, value: display(resultRef.sampleId, emptyPlaceholder) },
    { label: "Item", mono: true, value: display(resultRef.itemId, emptyPlaceholder) },
    { label: "Item kind", value: display(resultRef.itemKind, emptyPlaceholder) },
    { label: "Frequency", unit: "Hz", value: display(itemData?.frequency_hz, emptyPlaceholder) },
    { label: "Tracking score", value: display(itemData?.quality.tracking_score, emptyPlaceholder) },
    { label: "Branch", mono: true, value: display(resultRef.branchId ?? itemData?.branch_id, emptyPlaceholder) },
    { label: "Branch points", value: display(branchData?.point_count, emptyPlaceholder) },
    { label: "Field", mono: true, value: display(resultRef.fieldId ?? itemData?.field_ref?.field_id, emptyPlaceholder) },
    { label: "Projection", mono: true, value: display(resultRef.projectionId, emptyPlaceholder) },
    { label: "Projection point", value: display(resultRef.projectionOrdinal, emptyPlaceholder) },
    {
      label: "Sample coordinates",
      value:
        sampleData?.coordinates
          .map((coordinate) => `${coordinate.axis_id}=${coordinate.label ?? coordinate.token}`)
          .join(" · ") ?? emptyPlaceholder,
    },
  ];
  const provenance = [
    { label: "Selection node", mono: true, value: resultRef.nodeId },
    {
      label: "Source revision",
      mono: true,
      value: display(itemData?.source_revision ?? branchData?.source_revision, emptyPlaceholder),
    },
    {
      label: "Field revision",
      mono: true,
      value: display(resultRef.fieldRevision ?? itemData?.field_ref?.field_revision, emptyPlaceholder),
    },
    { label: "Resource transport", value: display(transportStatus, emptyPlaceholder) },
    { label: "Selection source", value: selection.moduleSource },
  ];

  if (embedded) {
    return (
      <div className="grid min-w-0 gap-3" data-inspector-owner="results.analysis_result">
        <InspectorGroup title="Dataset & Item Identity" badge={focusLabel(resultRef.focus)}>
          {properties.map((row) => <FieldRow key={row.label} {...row} />)}
        </InspectorGroup>
        <AnalysisResultFieldControls emptyPlaceholder={emptyPlaceholder} selectionRef={resultRef} />
        <AnalysisResultMetadata model={inspectorModel} />
        <InspectorGroup
          title="Diagnostics"
          badge={diagnostics.length > 0 ? `${diagnostics.length} notes` : "none"}
        >
          {diagnostics.length > 0 ? (
            [...new Set(diagnostics)].map((line) => <FieldRow key={line} label="Note" value={line} />)
          ) : (
            <FieldRow label="Diagnostics" value="None" />
          )}
        </InspectorGroup>
        <InspectorGroup title="Provenance">
          {provenance.map((row) => <FieldRow key={row.label} {...row} />)}
        </InspectorGroup>
      </div>
    );
  }

  return (
    <div className="fm-inspector-panel" data-inspector-owner="results.analysis_result">
      <InspectorOverviewFrame
        metrics={[
          { label: "Focus", value: focusLabel(resultRef.focus) },
          {
            label: "Status",
            value: display(status?.completeness ?? transportStatus, emptyPlaceholder),
            tone: status?.completeness === "complete" ? "success" : "neutral",
          },
          { label: "Residual L2", value: display(itemData?.quality.residual_relative_l2, emptyPlaceholder) },
          { label: "Axes", value: display(manifestData?.axes.length, emptyPlaceholder) },
        ]}
        primary={properties.map((row) => <FieldRow key={row.label} {...row} />)}
        primaryIcon={<Database size={18} strokeWidth={1.5} />}
        primaryTitle={selection.label ?? resultRef.itemId ?? resultRef.sampleId ?? resultRef.datasetId}
        sections={[
          {
            id: "field",
            title: "Result field visualization",
            icon: <Waves size={16} strokeWidth={1.5} />,
            defaultOpen: true,
            content: <AnalysisResultFieldControls emptyPlaceholder={emptyPlaceholder} selectionRef={resultRef} />,
          },
          {
            id: "metadata",
            title: "Dataset metadata",
            icon: <Table2 size={16} strokeWidth={1.5} />,
            summary: manifestData?.title,
            content: <AnalysisResultMetadata model={inspectorModel} />,
          },
          {
            id: "diagnostics",
            title: "Diagnostics",
            icon: <TriangleAlert size={16} strokeWidth={1.5} />,
            summary: diagnostics.length > 0 ? `${diagnostics.length} notes` : "none",
            defaultOpen: diagnostics.length > 0,
            content:
              diagnostics.length > 0 ? (
                [...new Set(diagnostics)].map((line) => <FieldRow key={line} label="Note" value={line} />)
              ) : (
                <FieldRow label="Diagnostics" value="None" />
              ),
          },
          {
            id: "provenance",
            title: "Provenance",
            icon: <GitCommit size={16} strokeWidth={1.5} />,
            content: provenance.map((row) => <FieldRow key={row.label} {...row} />),
          },
        ]}
      />
    </div>
  );
}

function AnalysisResultMetadata({
  model,
}: {
  model: ReturnType<typeof buildAnalysisResultInspectorModel>;
}) {
  return (
    <>
      {model.axes.length > 0 ? (
        <InspectorGroup title="Dataset axes">
          {model.axes.map((row) => <FieldRow key={row.label} {...row} />)}
        </InspectorGroup>
      ) : null}
      {model.metadata.length > 0 ? (
        <InspectorGroup title="Time-domain metadata">
          {model.metadata.map((row) => <FieldRow key={row.label} {...row} />)}
        </InspectorGroup>
      ) : null}
      {model.provenance.length > 0 ? (
        <InspectorGroup title="Published provenance">
          {model.provenance.map((row) => <FieldRow key={`${row.label}:${row.value}`} {...row} />)}
        </InspectorGroup>
      ) : null}
      {model.sources.length > 0 ? (
        <InspectorGroup title="Source artifacts">
          {model.sources.map((row) => <FieldRow key={`${row.label}:${row.value}`} {...row} />)}
        </InspectorGroup>
      ) : null}
      <InspectorGroup title="Item relations">
        {model.relations.map((row) => <FieldRow key={`${row.label}:${row.value}`} {...row} />)}
      </InspectorGroup>
    </>
  );
}

function AnalysisResultFieldControls({
  emptyPlaceholder = "Unavailable",
  selectionRef,
}: {
  emptyPlaceholder?: string;
  selectionRef: AnalysisResultSelectionRef;
}) {
  const kernel = useKernel();
  const fieldIntent = createAnalysisResultFieldOverlayIntent(selectionRef);
  const adapter = selectionRef.itemKind
    ? analysisResultFieldOverlayAdapter(selectionRef.itemKind)
    : null;
  const settings = useFrequencyDomainModeDisplaySettings({
    activation:
      fieldIntent && adapter
        ? {
            commandId: adapter.plotCommandId,
            fieldId: fieldIntent.fieldId,
            label: selectionRef.itemId ?? adapter.label,
            source: fieldIntent.source,
          }
        : undefined,
    sourceDetail: "analysis-result",
  });
  const activeOverlay = settings.activeAnalysisFieldOverlay;
  const activeOverlayOwned = resultFieldOverlayOwnsSelection(
    activeOverlay,
    fieldIntent,
  );
  const fieldStatus = selectionRef.fieldRef?.status ?? "not_published";
  const meshRef = selectionRef.fieldRef?.mesh_ref;
  const phaseRad =
    activeOverlayOwned
      ? activeOverlay?.visualizationPhaseRad ?? activeOverlay?.query.phase_rad ?? 0
      : 0;

  const setPhase = (value: string): void => {
    const nextPhaseRad = Number(value);
    if (!activeOverlayOwned || !Number.isFinite(nextPhaseRad)) return;
    void kernel.commands.execute(
      "analysis.frequency-domain.set-3d-phase",
      createCommandContext("inspector", kernel, {
        sourceDetail: "analysis-result",
      }),
      { phaseRad: nextPhaseRad },
    );
  };

  const setAnimation = (
    animation: NonNullable<AnalysisFieldOverlayState["animation"]>,
  ): void => {
    if (!activeOverlayOwned) return;
    kernel.analysisFieldOverlay.update({ animation });
  };

  return (
    <InspectorGroup
      title="Result field visualization"
      badge={fieldIntent ? "3D field ready" : "field unavailable"}
    >
      <FieldRow label="Field status" value={fieldStatus} />
      <FieldRow
        label="Field revision"
        mono
        value={display(selectionRef.fieldRevision ?? selectionRef.fieldRef?.field_revision, emptyPlaceholder)}
      />
      <FieldRow
        label="Representation"
        value={display(selectionRef.fieldRef?.representation, emptyPlaceholder)}
      />
      <FieldRow
        label="Result mesh"
        mono
        value={display(meshRef?.mesh_id, emptyPlaceholder)}
      />
      <FieldRow
        label="Topology fingerprint"
        mono
        value={display(meshRef?.topology_fingerprint, emptyPlaceholder)}
      />
      {fieldIntent && adapter ? (
        <div className="fm-frequency-domain-table__actions">
          <Button
            className="fm-inspector-action-button"
            size="sm"
            type="button"
            variant="primary"
            onClick={() => settings.setView(settings.view)}
          >
            Plot {adapter.label} in 3D
          </Button>
          <Button
            aria-label="Pin Mode Visualization"
            className="fm-inspector-action-button"
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => {
              void kernel.commands.execute(
                PIN_MODE_VISUALIZATION_COMMAND,
                createCommandContext("inspector", kernel, {
                  sourceDetail: "analysis-result",
                }),
              );
            }}
          >
            <Pin aria-hidden="true" size={13} />
            <span>Pin Mode Visualization</span>
          </Button>
        </div>
      ) : null}
      {fieldIntent && adapter ? (
        <InspectorGroup title="Phase and animation">
          <ModeVisualizationPhaseControl
            animate={activeOverlay?.animation?.animatePhase ?? false}
            animationDirection={activeOverlay?.animation?.direction ?? 1}
            animationLoop={activeOverlay?.animation?.loop ?? true}
            animationRateHz={activeOverlay?.animation?.animationRateHz ?? 1}
            disabled={!activeOverlayOwned}
            livePhaseController={
              activeOverlayOwned ? kernel.analysisFieldOverlay : null
            }
            onAnimationChange={setAnimation}
            onSetPhase={setPhase}
            phaseRad={String(phaseRad)}
          />
        </InspectorGroup>
      ) : null}
      {fieldIntent && adapter ? (
        <FrequencyDomainModeDisplayControls
          disabled={!activeOverlayOwned}
          labelPrefix="Result field"
          settings={settings}
          viewDefaultValue={settings.view}
          viewOptions={ANALYSIS_FIELD_VIEW_OPTIONS}
        />
      ) : (
        <p className="fm-inspector-empty" role="status">
          The selected result item has no verified complex XYZ field and immutable mesh reference.
        </p>
      )}
      {fieldIntent && !activeOverlayOwned ? (
        <p className="fm-inspector-empty" role="status">
          Plot the field first to enable its presentation controls.
        </p>
      ) : null}
      {activeOverlayOwned ? (
        <FieldRow label="Overlay source" value={activeOverlay?.source ?? "—"} />
      ) : null}
    </InspectorGroup>
  );
}

function resultFieldOverlayOwnsSelection(
  overlay: AnalysisFieldOverlayState | null,
  intent: ReturnType<typeof createAnalysisResultFieldOverlayIntent>,
): boolean {
  const activeIntent = overlay?.analysisResultFieldIntent;
  return Boolean(
    activeIntent &&
      intent &&
      activeIntent.source === intent.source &&
      activeIntent.analysisRunId === intent.analysisRunId &&
      activeIntent.analysisStageId === intent.analysisStageId &&
      activeIntent.datasetId === intent.datasetId &&
      activeIntent.datasetRevision === intent.datasetRevision &&
      activeIntent.sampleId === intent.sampleId &&
      activeIntent.itemId === intent.itemId &&
      activeIntent.fieldId === intent.fieldId &&
      activeIntent.fieldRevision === intent.fieldRevision &&
      activeIntent.fieldRef.resource_key === intent.fieldRef.resource_key &&
      activeIntent.fieldRef.mesh_ref?.mesh_id === intent.fieldRef.mesh_ref?.mesh_id &&
      activeIntent.fieldRef.mesh_ref?.mesh_revision === intent.fieldRef.mesh_ref?.mesh_revision &&
      activeIntent.fieldRef.mesh_ref?.topology_fingerprint === intent.fieldRef.mesh_ref?.topology_fingerprint
  );
}
