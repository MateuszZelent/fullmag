"use client";

import {
  useAnalysisResultBranchResource,
  useAnalysisResultDatasetManifestResource,
  useAnalysisResultItemResource,
  useAnalysisResultProjectionResource,
  useAnalysisResultSamplesResource,
} from "@/kernel/resources/analysisResultResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { ScientificInspectorTemplate } from "../../components/ScientificInspectorTemplate";
import type { InspectorPanelProps } from "../../inspectorTypes";

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
  const ref = resultSelection(selection);
  const sampleId = ref?.sampleId;
  const sampleQuery = sampleId ? { limit: 1, sample_id: sampleId } : {};
  const manifest = useAnalysisResultDatasetManifestResource(
    ref?.runId,
    ref?.datasetId,
    { enabled: Boolean(ref) },
  );
  const sample = useAnalysisResultSamplesResource(
    ref?.runId,
    ref?.datasetId,
    { enabled: Boolean(sampleId), query: sampleQuery },
  );
  const branch = useAnalysisResultBranchResource(
    ref?.runId,
    ref?.datasetId,
    ref?.branchId,
    { enabled: Boolean(ref?.focus === "branch" && ref?.branchId) },
  );
  const item = useAnalysisResultItemResource(
    ref?.runId,
    ref?.datasetId,
    ref?.itemId,
    { enabled: Boolean(ref?.itemId) },
  );
  const projection = useAnalysisResultProjectionResource(
    ref?.runId,
    ref?.datasetId,
    ref?.projectionId,
    { enabled: Boolean(ref?.projectionId) },
  );

  if (!ref) {
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
    ...(ref.focus === "branch" && !branchData && branch.status !== "loading"
      ? ["Branch detail is not available for the selected result dataset."]
      : []),
    ...(ref.focus === "field" && !itemData?.field_ref
      ? ["Spatial field data is not published for the selected result item."]
      : []),
    ...(itemData?.field_ref?.status === "unsupported"
      ? ["The selected field is marked unsupported by the result adapter."]
      : []),
  ];

  return (
    <ScientificInspectorTemplate
      breadcrumbs={["Results", manifestData?.title ?? ref.datasetId, focusLabel(ref.focus)]}
      diagnostics={diagnostics}
      methodLabel="Run-scoped result dataset"
      physicalLabel={focusLabel(ref.focus)}
      properties={[
        { label: "Run", mono: true, value: ref.runId },
        { label: "Stage", mono: true, value: ref.stageId },
        { label: "Dataset", mono: true, value: ref.datasetId },
        { label: "Dataset revision", mono: true, value: ref.datasetRevision },
        { label: "Sample", mono: true, value: display(ref.sampleId) },
        { label: "Item", mono: true, value: display(ref.itemId) },
        { label: "Item kind", value: display(ref.itemKind) },
        {
          label: "Frequency",
          unit: "Hz",
          value: display(itemData?.frequency_hz),
        },
        { label: "Branch", mono: true, value: display(ref.branchId ?? itemData?.branch_id) },
        {
          label: "Branch points",
          value: display(branchData?.point_count),
        },
        {
          label: "Field",
          mono: true,
          value: display(ref.fieldId ?? itemData?.field_ref?.field_id),
        },
        {
          label: "Projection",
          mono: true,
          value: display(ref.projectionId),
        },
        {
          label: "Projection point",
          value: display(ref.projectionOrdinal),
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
        { label: "Selection node", mono: true, value: ref.nodeId },
        {
          label: "Source revision",
          mono: true,
          value: display(itemData?.source_revision ?? branchData?.source_revision),
        },
        { label: "Field revision", mono: true, value: display(ref.fieldRevision ?? itemData?.field_ref?.field_revision) },
        { label: "Resource transport", value: transportStatus },
        { label: "Selection source", value: selection.moduleSource },
      ]}
      status={{
        availability: status?.completeness ?? "unknown",
        execution: status?.execution ?? "unknown",
        resource: status?.resource ?? transportStatus,
      }}
      title={selection.label ?? ref.itemId ?? ref.sampleId ?? ref.datasetId}
    />
  );
}
