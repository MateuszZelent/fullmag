import type { Selection } from "@/kernel/selection/selectionTypes";

import type {
  PostprocessingDefinitionKind,
  PostprocessingOwnerReadiness,
  PostprocessingSelectionScope,
} from "@/shared/domain/analysis/postprocessingTypes";

export interface PostprocessingInspectorProperty {
  label: string;
  mono?: boolean;
  value: string;
}

export interface PostprocessingInspectorModel {
  actionLabel: string;
  breadcrumbs: readonly string[];
  diagnostics: readonly string[];
  methodLabel: string;
  physicalLabel: string;
  properties: readonly PostprocessingInspectorProperty[];
  provenance: readonly PostprocessingInspectorProperty[];
  status: {
    availability: string;
    execution: string;
    resource: string;
  };
  title: string;
}

type PostprocessingSelection = Extract<
  NonNullable<Selection["ref"]>,
  { type: "postprocessing" }
>;

function postprocessingSelection(
  selection: Selection,
): PostprocessingSelection | null {
  return selection.ref?.type === "postprocessing" ? selection.ref : null;
}

function display(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === ""
    ? "Unavailable"
    : String(value);
}

function readinessLabel(readiness: PostprocessingOwnerReadiness): string {
  return readiness;
}

const POSTPROCESSING_KIND_LABELS: Record<
  PostprocessingDefinitionKind,
  string
> = {
  analysis_view: "Analysis View",
  derived_value: "Derived Value",
  export: "Export",
  table: "Table",
};

function ownerLabel(ref: PostprocessingSelection | null): string {
  if (!ref?.ownerKind || !ref.ownerId) return "Unavailable";
  return `${ref.ownerKind}:${ref.ownerId}`;
}

function baseModel(
  selection: Selection,
  kind: PostprocessingDefinitionKind,
  scope: PostprocessingSelectionScope,
): PostprocessingInspectorModel {
  const ref = postprocessingSelection(selection);
  const kindLabel = POSTPROCESSING_KIND_LABELS[kind];
  const readiness = ref?.ownerReadiness ?? "unavailable";
  const freshness = ref?.freshness ?? "unknown";
  const published = readiness === "available-ready" && freshness === "fresh";
  const contractGap = ref?.contractGap ?? "None";
  return {
    actionLabel: "No legal action is published for this selection.",
    breadcrumbs: ["Results", kindLabel],
    diagnostics: contractGap === "None" ? [] : [contractGap],
    methodLabel: published ? "Published resource" : "Contract state",
    physicalLabel: "Postprocessing",
    properties: [
      { label: "Freshness", value: freshness },
      { label: "Contract gap", value: contractGap },
    ],
    provenance: [
      { label: "Owner", mono: true, value: ownerLabel(ref) },
      { label: "Resource reference", mono: true, value: display(ref?.resourceRef) },
      { label: "Catalog revision", mono: true, value: display(ref?.catalogRevision) },
      { label: "Resource revision", mono: true, value: display(ref?.ownerResourceRevision) },
      { label: "Selection scope", value: scope },
    ],
    status: {
      availability: published ? "available" : "unavailable",
      execution: published ? "published" : "not published",
      resource: readinessLabel(readiness),
    },
    title: selection.label ?? kindLabel,
  };
}

export function analysisViewInspectorModel(
  selection: Selection,
  scope: PostprocessingSelectionScope,
): PostprocessingInspectorModel {
  const model = baseModel(selection, "analysis_view", scope);
  if (scope === "root") {
    return {
      ...model,
      actionLabel: "No legal view-authoring command is published.",
      properties: [
        { label: "View catalog", value: "No persistent definition owner" },
        ...model.properties,
      ],
      title: selection.label ?? "Analysis Views",
    };
  }
  return {
    ...model,
    actionLabel: "No legal view mutation or refresh command is published.",
    properties: [
      { label: "View definition", value: display(selection.label) },
      { label: "Source dataset", mono: true, value: display(postprocessingSelection(selection)?.resourceRef) },
      { label: "Projection metadata", value: "Not published by the current contract" },
      ...model.properties,
    ],
    title: selection.label ?? "Analysis View",
  };
}

export function derivedValueInspectorModel(
  selection: Selection,
  scope: PostprocessingSelectionScope,
): PostprocessingInspectorModel {
  const model = baseModel(selection, "derived_value", scope);
  if (scope === "root") {
    return {
      ...model,
      actionLabel: "No legal derived-value authoring command is published.",
      properties: [
        { label: "Derived-value catalog", value: "No persistent definition owner" },
        ...model.properties,
      ],
      title: selection.label ?? "Derived Values",
    };
  }
  return {
    ...model,
    actionLabel: "No legal derived-value evaluation command is published.",
    properties: [
      { label: "Operation", value: "Not published by the current contract" },
      { label: "Output unit", value: "Not published by the current contract" },
      { label: "Source dataset", mono: true, value: display(postprocessingSelection(selection)?.resourceRef) },
      ...model.properties,
    ],
    title: selection.label ?? "Derived Value",
  };
}

export function tableInspectorModel(
  selection: Selection,
  scope: PostprocessingSelectionScope,
): PostprocessingInspectorModel {
  const ref = postprocessingSelection(selection);
  const model = baseModel(selection, "table", scope);
  if (scope === "root") {
    return {
      ...model,
      actionLabel: "Read-only TableResource catalog inspection; no mutation command is published.",
      properties: [
        { label: "Catalog", value: "TableResource" },
        ...model.properties,
      ],
      title: selection.label ?? "Tables",
    };
  }
  return {
    ...model,
    actionLabel: "Read-only table resource inspection; no mutation command is published.",
    properties: [
      { label: "Table ID", mono: true, value: display(ref?.ownerId) },
      { label: "Schema revision", mono: true, value: display(ref?.ownerSchemaRevision) },
      { label: "Table resource", mono: true, value: display(ref?.resourceRef) },
      ...model.properties,
    ],
    title: selection.label ?? "Table",
  };
}

export function exportInspectorModel(
  selection: Selection,
  scope: PostprocessingSelectionScope,
): PostprocessingInspectorModel {
  const ref = postprocessingSelection(selection);
  const model = baseModel(selection, "export", scope);
  if (scope === "root") {
    return {
      ...model,
      actionLabel: "Read-only ArtifactResource catalog inspection; no export command is published.",
      properties: [
        { label: "Catalog", value: "ArtifactResource" },
        ...model.properties,
      ],
      title: selection.label ?? "Exports",
    };
  }
  return {
    ...model,
    actionLabel: "Read-only artifact provenance inspection; no export command is published.",
    properties: [
      { label: "Artifact kind", value: display(ref?.artifactKind) },
      { label: "Artifact path", mono: true, value: display(ref?.ownerId) },
      { label: "Artifact resource", mono: true, value: display(ref?.resourceRef) },
      ...model.properties,
    ],
    title: selection.label ?? "Export",
  };
}
