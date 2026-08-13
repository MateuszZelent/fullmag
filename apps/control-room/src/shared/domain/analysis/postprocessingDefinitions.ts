import type {
  ArtifactResource,
  ResourceRevision,
  TableListResource,
  TableResource,
} from "@/kernel/api/apiTypes";
import type { ResourceStatus } from "@/kernel/resources/resourceTypes";

import type {
  PostprocessingDefinitionKind,
  PostprocessingFreshness,
  PostprocessingOwnerReadiness,
} from "./postprocessingTypes";

export type {
  PostprocessingDefinitionKind,
  PostprocessingFreshness,
  PostprocessingOwnerKind,
  PostprocessingOwnerReadiness,
} from "./postprocessingTypes";

export const POSTPROCESSING_OWNER_CONTRACT_GAP =
  "No persistent owner resource is published for user-defined postprocessing definitions.";
export const POSTPROCESSING_RESOURCE_REVISION_CONTRACT_GAP =
  "Resource revision is missing or invalid.";

export interface PostprocessingCatalogSnapshot<T> {
  data: T | null;
  error: string | null;
  missing: boolean;
  revision: ResourceRevision | null;
  status: ResourceStatus;
}

export interface PostprocessingResourceState {
  freshness: PostprocessingFreshness;
  readiness: PostprocessingOwnerReadiness;
  reason: string | null;
  revision: ResourceRevision | null;
  status: ResourceStatus;
}

export type PostprocessingResourceOwner =
  | {
      artifactKind: string;
      catalogRevision: ResourceRevision;
      kind: "artifact";
      path: string;
      resourceRef: string;
    }
  | {
      catalogRevision: ResourceRevision;
      kind: "table";
      resourceRef: string;
      revision: number;
      schemaRevision: number;
      tableId: string;
    };

export interface PostprocessingDefinitionInput {
  contractGap?: string | null;
  datasetRef?: string | null;
  id: string;
  kind: PostprocessingDefinitionKind;
  label: string;
  owner?: PostprocessingResourceOwner | null;
  ownerState?: PostprocessingResourceState;
}

export interface PostprocessingDefinition {
  availability: "available" | "unavailable";
  catalogRevision: ResourceRevision | null;
  contractGap: string | null;
  datasetRef: string | null;
  freshness: PostprocessingFreshness;
  id: string;
  kind: PostprocessingDefinitionKind;
  label: string;
  owner: PostprocessingResourceOwner | null;
  ownerReadiness: PostprocessingOwnerReadiness;
  resourceRevision?: ResourceRevision;
  resourceStatus: ResourceStatus;
}

type PostprocessingResourceOwnerCandidate =
  | {
      artifactKind: unknown;
      catalogRevision: unknown;
      kind: "artifact";
      path: unknown;
      resourceRef: unknown;
    }
  | {
      catalogRevision: unknown;
      kind: "table";
      resourceRef: unknown;
      revision: unknown;
      schemaRevision: unknown;
      tableId: unknown;
    };

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validOpaqueRevision(value: unknown): value is ResourceRevision {
  return (
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === "string" && value.trim().length > 0)
  );
}

function validIntRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeOwner(
  owner: PostprocessingResourceOwnerCandidate | null,
): PostprocessingResourceOwner | null {
  if (
    owner?.kind === "table" &&
    nonEmpty(owner.resourceRef) &&
    nonEmpty(owner.tableId) &&
    validIntRevision(owner.revision) &&
    validIntRevision(owner.schemaRevision) &&
    validOpaqueRevision(owner.catalogRevision)
  ) {
    return {
      catalogRevision: owner.catalogRevision,
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
    nonEmpty(owner.resourceRef) &&
    validOpaqueRevision(owner.catalogRevision)
  ) {
    return {
      artifactKind: owner.artifactKind,
      catalogRevision: owner.catalogRevision,
      kind: "artifact",
      path: owner.path,
      resourceRef: owner.resourceRef,
    };
  }
  return null;
}

function unavailableState(
  status: ResourceStatus,
  revision: ResourceRevision | null,
  reason: string,
): PostprocessingResourceState {
  return {
    freshness: "unknown",
    readiness: "unavailable",
    reason,
    revision,
    status: status === "ready" ? "error" : status,
  };
}

export function postprocessingCatalogState(
  catalog: PostprocessingCatalogSnapshot<unknown> | null | undefined,
  label: "Artifact" | "Table",
): PostprocessingResourceState {
  if (!catalog) {
    return unavailableState(
      "idle",
      null,
      `${label} resource catalog is unavailable.`,
    );
  }
  if (!validOpaqueRevision(catalog.revision)) {
    return unavailableState(
      catalog.status,
      catalog.revision,
      POSTPROCESSING_RESOURCE_REVISION_CONTRACT_GAP,
    );
  }
  if (catalog.status === "ready" && catalog.data !== null) {
    return {
      freshness: "fresh",
      readiness: "available-ready",
      reason: null,
      revision: catalog.revision,
      status: "ready",
    };
  }
  if (catalog.status === "loading") {
    return {
      freshness: "unknown",
      readiness: "loading",
      reason: `${label} resource catalog is loading.`,
      revision: catalog.revision,
      status: "loading",
    };
  }
  if (catalog.status === "stale") {
    return {
      freshness: "stale",
      readiness: "stale",
      reason: `${label} resource catalog is stale; published state is not current.`,
      revision: catalog.revision,
      status: "stale",
    };
  }
  if (catalog.status === "error") {
    return {
      freshness: "unknown",
      readiness: "error",
      reason: catalog.error ?? `${label} resource catalog failed to load.`,
      revision: catalog.revision,
      status: "error",
    };
  }
  return unavailableState(
    catalog.status,
    catalog.revision,
    catalog.missing
      ? `${label} resource catalog was not found.`
      : `${label} resource catalog is unavailable.`,
  );
}

function ownerState(
  catalog: PostprocessingCatalogSnapshot<unknown> | null | undefined,
  label: "Artifact" | "Table",
  owner: PostprocessingResourceOwner | null,
): PostprocessingResourceState {
  const state = postprocessingCatalogState(catalog, label);
  return owner
    ? state
    : unavailableState(
        state.status,
        state.revision,
        "Owner identity or owner revision is missing or invalid.",
      );
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
  const state = input.ownerState ?? unavailableState(
    "error",
    null,
    input.contractGap ?? POSTPROCESSING_OWNER_CONTRACT_GAP,
  );
  const available =
    ownerMatchesKind &&
    ownerMatchesDataset &&
    state.readiness === "available-ready" &&
    state.freshness === "fresh";

  return {
    availability: available ? "available" : "unavailable",
    catalogRevision: owner?.catalogRevision ?? state.revision,
    contractGap: available
      ? null
      : input.contractGap ??
        state.reason ??
        POSTPROCESSING_OWNER_CONTRACT_GAP,
    datasetRef,
    freshness: state.freshness,
    id: input.id,
    kind: input.kind,
    label: input.label,
    owner,
    ownerReadiness: state.readiness,
    ...(owner
      ? {
          resourceRevision:
            owner.kind === "table" ? owner.revision : owner.catalogRevision,
        }
      : {}),
    resourceStatus: state.status,
  };
}

export function postprocessingDefinitionFromTable(
  table: TableResource,
  catalog?: PostprocessingCatalogSnapshot<TableListResource> | null,
): PostprocessingDefinition {
  const tableId = typeof table?.table_id === "string" ? table.table_id : "";
  const resourceRef = `table:${tableId}`;
  const owner = normalizeOwner({
    catalogRevision: catalog?.revision ?? null,
    kind: "table",
    resourceRef,
    revision: table?.revision,
    schemaRevision: table?.schema_revision,
    tableId,
  });
  return definePostprocessing({
    datasetRef: resourceRef,
    id: resourceRef,
    kind: "table",
    label: nonEmpty(tableId) ? tableId : "Table unavailable",
    owner,
    ownerState: ownerState(catalog, "Table", owner),
  });
}

export function postprocessingDefinitionFromArtifact(
  artifact: ArtifactResource,
  catalog?: PostprocessingCatalogSnapshot<readonly ArtifactResource[]> | null,
): PostprocessingDefinition {
  const path = typeof artifact?.path === "string" ? artifact.path : "";
  const artifactKind = typeof artifact?.kind === "string" ? artifact.kind : "";
  const resourceRef = `artifact:${path}`;
  const label = nonEmpty(path)
    ? path.split("/").at(-1) || "Export unavailable"
    : "Export unavailable";
  const owner = normalizeOwner({
    artifactKind,
    catalogRevision: catalog?.revision ?? null,
    kind: "artifact",
    path,
    resourceRef,
  });
  return definePostprocessing({
    datasetRef: resourceRef,
    id: resourceRef,
    kind: "export",
    label,
    owner,
    ownerState: ownerState(catalog, "Artifact", owner),
  });
}
