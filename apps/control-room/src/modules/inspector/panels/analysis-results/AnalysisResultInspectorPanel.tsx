"use client";

import {
  useAnalysisResultBranchResource,
  useAnalysisResultDatasetManifestResource,
  useAnalysisResultItemResource,
  useAnalysisResultProjectionResource,
  useAnalysisResultSamplesResource,
} from "@/kernel/resources/analysisResultResources";
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
import { ScientificInspectorTemplate } from "../../components/ScientificInspectorTemplate";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import type { InspectorPanelProps } from "../../inspectorTypes";
import type { AnalysisResultSelectionRef } from "@/shared/domain/analysis/results";

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

  return (
    <>
      <ScientificInspectorTemplate
        breadcrumbs={["Results", manifestData?.title ?? resultRef.datasetId, focusLabel(resultRef.focus)]}
        diagnostics={diagnostics}
        methodLabel="Run-scoped result dataset"
        physicalLabel={focusLabel(resultRef.focus)}
        properties={[
          { label: "Run", mono: true, value: resultRef.runId },
          { label: "Stage", mono: true, value: resultRef.stageId },
          { label: "Dataset", mono: true, value: resultRef.datasetId },
          { label: "Dataset revision", mono: true, value: resultRef.datasetRevision },
          { label: "Sample", mono: true, value: display(resultRef.sampleId) },
          { label: "Item", mono: true, value: display(resultRef.itemId) },
          { label: "Item kind", value: display(resultRef.itemKind) },
          {
            label: "Frequency",
            unit: "Hz",
            value: display(itemData?.frequency_hz),
          },
          {
            label: "Residual relative L2",
            value: display(itemData?.quality.residual_relative_l2),
          },
          {
            label: "Branch tracking score",
            value: display(itemData?.quality.tracking_score),
          },
          { label: "Branch", mono: true, value: display(resultRef.branchId ?? itemData?.branch_id) },
          {
            label: "Branch points",
            value: display(branchData?.point_count),
          },
          {
            label: "Field",
            mono: true,
            value: display(resultRef.fieldId ?? itemData?.field_ref?.field_id),
          },
          {
            label: "Projection",
            mono: true,
            value: display(resultRef.projectionId),
          },
          {
            label: "Projection point",
            value: display(resultRef.projectionOrdinal),
          },
          {
            label: "Published axes",
            value: display(manifestData?.axes.length),
          },
          {
            label: "Sample coordinates",
            value: sampleData?.coordinates
              .map((coordinate) => `${coordinate.axis_id}=${coordinate.label ?? coordinate.token}`)
              .join(" · ") ?? "Unavailable",
          },
        ]}
        provenance={[
          { label: "Selection node", mono: true, value: resultRef.nodeId },
          {
            label: "Source revision",
            mono: true,
            value: display(itemData?.source_revision ?? branchData?.source_revision),
          },
          { label: "Field revision", mono: true, value: display(resultRef.fieldRevision ?? itemData?.field_ref?.field_revision) },
          { label: "Resource transport", value: transportStatus },
          { label: "Selection source", value: selection.moduleSource },
        ]}
        status={{
          availability: status?.completeness ?? "unknown",
          execution: status?.execution ?? "unknown",
          resource: status?.resource ?? transportStatus,
        }}
        title={selection.label ?? resultRef.itemId ?? resultRef.sampleId ?? resultRef.datasetId}
      />
      <AnalysisResultFieldControls selectionRef={resultRef} />
    </>
  );
}

function AnalysisResultFieldControls({
  selectionRef,
}: {
  selectionRef: AnalysisResultSelectionRef;
}) {
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
