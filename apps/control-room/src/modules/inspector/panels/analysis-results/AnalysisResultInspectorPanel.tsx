"use client";

import { Database, GitCommit, Table2, TriangleAlert, Waves } from "lucide-react";

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
import {
  ANALYSIS_FIELD_VIEW_OPTIONS,
  FrequencyDomainModeDisplayControls,
  useFrequencyDomainModeDisplaySettings,
} from "../FrequencyDomainModeDisplayControls";
import { ModeVisualizationPhaseControl } from "../ModeVisualizationInspectorPanel";
import { ScientificInspectorTemplate } from "../../components/ScientificInspectorTemplate";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { InspectorOverviewFrame } from "../../primitives/InspectorOverviewFrame";
import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  type AnalysisResultSelectionRef,
} from "@/shared/domain/analysis/results";
import { buildAnalysisResultInspectorModel } from "./analysisResultInspectorModel";

function display(value: string | number | null | undefined): string {
  if (value == null || value === "") return "Unavailable";
  return String(value);
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
  selection,
}: InspectorPanelProps) {
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
    return (
      <ScientificInspectorTemplate
        breadcrumbs={["Results", "Analysis result"]}
        diagnostics={["The selected node does not contain an analysis-result reference."]}
        methodLabel="Run-scoped result dataset"
        physicalLabel="Result"
        status={{
          availability: "missing",
          execution: "not_applicable",
          resource: "missing",
        }}
        title="Analysis result"
      />
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
  const inspectorModel = buildAnalysisResultInspectorModel({
    item: itemData,
    manifest: manifestData,
  });

  const properties: readonly { label: string; mono?: boolean; unit?: string; value: string }[] = [
    { label: "Run", mono: true, value: resultRef.runId },
    { label: "Stage", mono: true, value: resultRef.stageId },
    { label: "Dataset", mono: true, value: resultRef.datasetId },
    { label: "Dataset revision", mono: true, value: resultRef.datasetRevision },
    { label: "Sample", mono: true, value: display(resultRef.sampleId) },
    { label: "Item", mono: true, value: display(resultRef.itemId) },
    { label: "Item kind", value: display(resultRef.itemKind) },
    { label: "Frequency", unit: "Hz", value: display(itemData?.frequency_hz) },
    { label: "Branch", mono: true, value: display(resultRef.branchId ?? itemData?.branch_id) },
    { label: "Branch points", value: display(branchData?.point_count) },
    { label: "Field", mono: true, value: display(resultRef.fieldId ?? itemData?.field_ref?.field_id) },
    { label: "Projection", mono: true, value: display(resultRef.projectionId) },
    { label: "Projection point", value: display(resultRef.projectionOrdinal) },
    {
      label: "Sample coordinates",
      value:
        sampleData?.coordinates
          .map((coordinate) => `${coordinate.axis_id}=${coordinate.label ?? coordinate.token}`)
          .join(" · ") ?? "Unavailable",
    },
  ];
  const provenance = [
    { label: "Selection node", mono: true, value: resultRef.nodeId },
    {
      label: "Source revision",
      mono: true,
      value: display(itemData?.source_revision ?? branchData?.source_revision),
    },
    {
      label: "Field revision",
      mono: true,
      value: display(resultRef.fieldRevision ?? itemData?.field_ref?.field_revision),
    },
    { label: "Resource transport", value: display(transportStatus) },
    { label: "Selection source", value: selection.moduleSource },
  ];

  return (
    <div className="fm-inspector-panel" data-inspector-owner="results.analysis_result">
      <InspectorOverviewFrame
        metrics={[
          { label: "Focus", value: focusLabel(resultRef.focus) },
          {
            label: "Status",
            value: display(status?.completeness ?? transportStatus),
            tone: status?.completeness === "complete" ? "success" : "neutral",
          },
          { label: "Residual L2", value: display(itemData?.quality.residual_relative_l2) },
          { label: "Axes", value: display(manifestData?.axes.length) },
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
            content: <AnalysisResultFieldControls selectionRef={resultRef} />,
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
                diagnostics.map((line) => <FieldRow key={line} label="Note" value={line} />)
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
  selectionRef,
}: {
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
        value={display(selectionRef.fieldRevision ?? selectionRef.fieldRef?.field_revision)}
      />
      <FieldRow
        label="Representation"
        value={display(selectionRef.fieldRef?.representation)}
      />
      <FieldRow
        label="Result mesh"
        mono
        value={display(meshRef?.mesh_id)}
      />
      <FieldRow
        label="Topology fingerprint"
        mono
        value={display(meshRef?.topology_fingerprint)}
      />
      {fieldIntent && adapter ? (
        <div className="fm-frequency-domain-table__actions">
          <button
            className="fm-inspector-action-button"
            type="button"
            onClick={() => settings.setView(settings.view)}
          >
            Plot {adapter.label} in 3D
          </button>
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
        <FieldRow label="Overlay source" value={activeOverlay?.source ?? "unknown"} />
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
