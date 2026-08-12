import type { ArtifactResource, TableResource } from "@/kernel/api/apiTypes";

export type PostprocessingDefinitionKind =
  | "analysis_view"
  | "derived_value"
  | "export"
  | "table";

export const POSTPROCESSING_OWNER_CONTRACT_GAP =
  "No persistent owner resource is published for user-defined postprocessing definitions.";

export type PostprocessingResourceOwner =
  | {
      kind: "table";
      resourceRef: string;
      revision: number;
      schemaRevision: number;
      tableId: string;
    }
  | {
      artifactKind: string;
      kind: "artifact";
      path: string;
      resourceRef: string;
    };

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeOwner(
  owner: PostprocessingResourceOwner | null,
): PostprocessingResourceOwner | null {
  if (
    owner?.kind === "table" &&
    nonEmpty(owner.resourceRef) &&
    nonEmpty(owner.tableId) &&
    finite(owner.revision) &&
    finite(owner.schemaRevision)
  ) {
    return {
      kind: "table",
      resourceRef: owner.resourceRef,
      revision: owner.revision,
      schemaRevision: owner.schemaRevision,
      tableId: owner.tableId,
    };
  }
  if (
    owner?.kind === "artifact" &&
    nonEmpty(owner.artifactKind) &&
    nonEmpty(owner.path) &&
    nonEmpty(owner.resourceRef)
  ) {
    return {
      artifactKind: owner.artifactKind,
      kind: "artifact",
      path: owner.path,
      resourceRef: owner.resourceRef,
    };
  }
  return null;
}

export interface PostprocessingDefinitionInput {
  datasetRef?: string | null;
  id: string;
  kind: PostprocessingDefinitionKind;
  label: string;
  owner?: PostprocessingResourceOwner | null;
  resourceRevision?: number | string;
}

export interface PostprocessingDefinition {
  availability: "available" | "unavailable";
  contractGap: string | null;
  datasetRef: string | null;
  id: string;
  kind: PostprocessingDefinitionKind;
  label: string;
  owner: PostprocessingResourceOwner | null;
  resourceRevision?: number | string;
}

export function definePostprocessing(
  input: PostprocessingDefinitionInput,
): PostprocessingDefinition {
  if (!nonEmpty(input.id) || !nonEmpty(input.label)) {
    throw new Error("Postprocessing definitions require an ID and label.");
  }

  const owner = normalizeOwner(input.owner ?? null);
  const datasetRef =
    typeof input.datasetRef === "string"
      ? input.datasetRef
      : owner?.resourceRef ?? null;
  const ownerMatchesKind =
    (input.kind === "table" && owner?.kind === "table") ||
    (input.kind === "export" && owner?.kind === "artifact");
  const ownerMatchesDataset =
    owner !== null && datasetRef !== null && owner.resourceRef === datasetRef;
  const available = ownerMatchesKind && ownerMatchesDataset;

  return {
    availability: available ? "available" : "unavailable",
    contractGap: available ? null : POSTPROCESSING_OWNER_CONTRACT_GAP,
    datasetRef,
    id: input.id,
    kind: input.kind,
    label: input.label,
    owner: available ? owner : null,
    ...(available && input.resourceRevision !== undefined
      ? { resourceRevision: input.resourceRevision }
      : available && owner?.kind === "table"
        ? { resourceRevision: owner.revision }
        : {}),
  };
}

export function postprocessingDefinitionFromTable(
  table: TableResource,
): PostprocessingDefinition {
  const tableId = typeof table?.table_id === "string" ? table.table_id : "";
  const revision = typeof table?.revision === "number" ? table.revision : Number.NaN;
  const schemaRevision =
    typeof table?.schema_revision === "number" ? table.schema_revision : Number.NaN;
  const resourceRef = `table:${tableId}`;
  return definePostprocessing({
    datasetRef: resourceRef,
    id: resourceRef,
    kind: "table",
    label: nonEmpty(tableId) ? tableId : "Table unavailable",
    owner: {
      kind: "table",
      resourceRef,
      revision,
      schemaRevision,
      tableId,
    },
  });
}

export function postprocessingDefinitionFromArtifact(
  artifact: ArtifactResource,
): PostprocessingDefinition {
  const path = typeof artifact?.path === "string" ? artifact.path : "";
  const artifactKind = typeof artifact?.kind === "string" ? artifact.kind : "";
  const resourceRef = `artifact:${path}`;
  const label = nonEmpty(path)
    ? path.split("/").at(-1) || "Export unavailable"
    : "Export unavailable";
  return definePostprocessing({
    datasetRef: resourceRef,
    id: resourceRef,
    kind: "export",
    label,
    owner: {
      artifactKind,
      kind: "artifact",
      path,
      resourceRef,
    },
  });
}
