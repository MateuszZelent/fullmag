import { canonicalMeshTopologyHash } from "@/shared/domain/mesh/topologyFingerprint";

import type { FieldVectorResponseMetadata } from "@/kernel/api/apiTypes";
import type { DecodedFieldVector } from "@/kernel/api/codecs";

import { resolveCanonicalQuantityId } from "@/kernel/api/quantityIds";

import { buildFdmFieldIndexResolver } from "./fdmFieldIndexing";

type FieldResponseDomainIdentity = Pick<
  FieldVectorResponseMetadata,
  "domainGenerationId" | "identityIssues"
>;

export interface Viewport3DFieldDomainIdentity {
  discretization?: "fdm" | "fem";
  domainGenerationId: string | null;
  /** Published sample location for the current live FEM damping field. */
  liveDampingLocation?: string | null;
  gridShape?: readonly [number, number, number] | null;
  meshTopologyHash: string | null;
  meshTopologyRevision: string | null;
  pointCount: number;
}

export type Viewport3DFieldDomainCompatibility =
  | { reason: "compatible"; status: "compatible" }
  | { reason: "fmvp-v2-legacy"; status: "degraded" }
  | {
      reason:
        | "damping-location-mismatch"
        | "duplicate-node-index"
        | "domain-generation-mismatch"
        | "domain-generation-unknown"
        | "fdm-carrier-identity-unknown"
        | "missing-node-indices"
        | "mesh-topology-hash-mismatch"
        | "mesh-topology-revision-mismatch"
        | "node-index-out-of-range"
        | "point-count-mismatch";
      status: "mismatch";
    };

type Viewport3DFieldDomainMismatchReason = Extract<
  Viewport3DFieldDomainCompatibility,
  { status: "mismatch" }
>["reason"];

export interface Viewport3DLiveFemDomainRefreshers {
  airboxFieldVectors: () => void;
  domainManifest: () => void;
  domainMeta: () => void;
  magneticPartFields: () => void;
  targetQuantityFields: () => void;
  topology: () => void;
}

export function refreshViewport3DLiveFemDomainResources({
  airboxFieldVectors,
  domainManifest,
  domainMeta,
  magneticPartFields,
  targetQuantityFields,
  topology,
}: Viewport3DLiveFemDomainRefreshers): void {
  domainMeta();
  domainManifest();
  topology();
  magneticPartFields();
  targetQuantityFields();
  airboxFieldVectors();
}

const FIELD_DOMAIN_MISMATCH_TEXT: Record<Viewport3DFieldDomainMismatchReason, string> = {
  "damping-location-mismatch": "live FEM damping requires a field published at mesh nodes",
  "domain-generation-mismatch":
    "the field was computed for a different domain generation than the one shown",
  "domain-generation-unknown":
    "the field does not declare which domain generation it belongs to",
  "duplicate-node-index": "the field maps two samples to the same location",
  "fdm-carrier-identity-unknown":
    "the grid carrier identity of the displayed domain is not published yet",
  "mesh-topology-hash-mismatch":
    "the field belongs to a different mesh topology than the one shown",
  "mesh-topology-revision-mismatch":
    "the field belongs to an older or newer mesh revision than the one shown",
  "missing-node-indices": "the compact field carries no sample-to-location map",
  "node-index-out-of-range":
    "the field references locations outside the displayed domain",
  "point-count-mismatch":
    "the field sample count does not match the displayed domain",
};

export function retryViewport3DFieldDomainMismatch(
  reason: Viewport3DFieldDomainMismatchReason,
  retryField: () => void,
  refreshLiveFemDomain?: () => void,
): void {
  if (reason === "domain-generation-mismatch") {
    refreshLiveFemDomain?.();
  }
  retryField();
}

/**
 * User-facing explanation for a blocked field buffer. The internal reason
 * code stays available for diagnostics; the renderer never guesses a map.
 */
export function describeViewport3DFieldDomainMismatch(
  reason: Viewport3DFieldDomainMismatchReason,
): string {
  return `${FIELD_DOMAIN_MISMATCH_TEXT[reason]}; it is not drawn until matching data arrives (${reason}).`;
}

export function safeViewport3DDomainGenerationId(value: unknown): string | null {
  if (typeof value === "string") return value;
  return typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : null;
}

export function resolveTrustedViewport3DResponseDomainGenerationId(
  field: Pick<DecodedFieldVector, "domainGenerationId" | "formatVersion">,
  responseMetadata: FieldResponseDomainIdentity | null | undefined,
): string | null {
  if (field.formatVersion === 3) {
    return field.domainGenerationId ?? null;
  }
  const responseGeneration = responseMetadata?.domainGenerationId?.trim() ?? "";
  if (!responseGeneration) return null;
  return responseMetadata?.identityIssues.every(
    (issue) => issue.field === "domainGenerationId",
  )
    ? responseGeneration
    : null;
}

export function resolveViewport3DFieldVectorForDomain({
  domain,
  fieldVector,
  responseDomainGenerationId,
}: {
  domain: Viewport3DFieldDomainIdentity;
  fieldVector: DecodedFieldVector | null;
  responseDomainGenerationId?: string | null;
}): DecodedFieldVector | null {
  if (!fieldVector) return null;
  return resolveViewport3DFieldDomainCompatibility({
    domain,
    field: fieldVector,
    responseDomainGenerationId,
  })
    .status === "mismatch"
    ? null
    : fieldVector;
}

// Undefined means the caller is displaying a source outside the live FEM field catalog.
// Null means the current catalog has no damping descriptor.
export function liveFemDampingLocationMismatch(
  quantityId: string | undefined,
  location: string | null | undefined,
): boolean {
  return location !== undefined && location !== "node" && quantityId !== undefined &&
    resolveCanonicalQuantityId(quantityId) === "mat_alpha";
}

export function resolveViewport3DFieldDomainCompatibility({
  domain,
  field,
  responseDomainGenerationId,
}: {
  domain: Viewport3DFieldDomainIdentity;
  field: Pick<
    DecodedFieldVector,
    | "domainGenerationId"
    | "formatVersion"
    | "indexing"
    | "meshTopologyHash"
    | "meshTopologyRevision"
    | "nodeIndices"
    | "pointCount"
  > &
    Partial<Pick<DecodedFieldVector, "grid" | "nComp" | "quantityId">>;
  responseDomainGenerationId?: string | null;
}): Viewport3DFieldDomainCompatibility {
  if (domain.discretization === "fem" && liveFemDampingLocationMismatch(field.quantityId, domain.liveDampingLocation)) {
    return { reason: "damping-location-mismatch", status: "mismatch" };
  }
  if (field.formatVersion === 3) {
    if (!field.domainGenerationId || !domain.domainGenerationId) {
      return { reason: "domain-generation-unknown", status: "mismatch" };
    }
    if (field.domainGenerationId !== domain.domainGenerationId) {
      return { reason: "domain-generation-mismatch", status: "mismatch" };
    }
  }

  if (
    field.meshTopologyHash !== null &&
    field.meshTopologyHash !== undefined &&
    domain.meshTopologyHash !== null &&
    canonicalMeshTopologyHash(field.meshTopologyHash) !==
      canonicalMeshTopologyHash(domain.meshTopologyHash)
  ) {
    return { reason: "mesh-topology-hash-mismatch", status: "mismatch" };
  }
  if (
    field.meshTopologyRevision !== null &&
    field.meshTopologyRevision !== undefined &&
    domain.meshTopologyRevision !== null &&
    field.meshTopologyRevision !== domain.meshTopologyRevision
  ) {
    return { reason: "mesh-topology-revision-mismatch", status: "mismatch" };
  }

  if (
    (field.indexing === "explicit_node_indices" ||
      field.indexing === "sampled_node_indices") &&
    hasDuplicateFieldNodeIndex(field.nodeIndices, field.pointCount)
  ) {
    return { reason: "duplicate-node-index", status: "mismatch" };
  }

  if (
    domain.discretization !== "fdm" &&
    (field.indexing === "explicit_node_indices" ||
      field.indexing === "sampled_node_indices")
  ) {
    if (!field.nodeIndices || field.nodeIndices.length !== field.pointCount) {
      return { reason: "missing-node-indices", status: "mismatch" };
    }
    for (let index = 0; index < field.nodeIndices.length; index += 1) {
      const nodeIndex = field.nodeIndices[index];
      if (
        nodeIndex === undefined ||
        !Number.isSafeInteger(nodeIndex) ||
        nodeIndex < 0 ||
        (domain.pointCount > 0 && nodeIndex >= domain.pointCount)
      ) {
        return { reason: "node-index-out-of-range", status: "mismatch" };
      }
    }
  }

  if (domain.discretization === "fdm") {
    if (field.formatVersion === 2) {
      if (!responseDomainGenerationId || !domain.domainGenerationId) {
        return { reason: "domain-generation-unknown", status: "mismatch" };
      }
      if (responseDomainGenerationId !== domain.domainGenerationId) {
        return { reason: "domain-generation-mismatch", status: "mismatch" };
      }
    }
    if (field.meshTopologyHash != null && domain.meshTopologyHash == null) {
      return { reason: "fdm-carrier-identity-unknown", status: "mismatch" };
    }
    const fdmIndexing = buildFdmFieldIndexResolver(
      field,
      domain.pointCount,
      domain.gridShape,
    );
    if (fdmIndexing.status === "degraded") {
      return { reason: fdmIndexing.reason, status: "mismatch" };
    }
  }

  if (
    domain.discretization !== "fdm" &&
    field.indexing === "full_domain" &&
    field.pointCount > 0 &&
    domain.pointCount > 0 &&
    field.pointCount !== domain.pointCount
  ) {
    return { reason: "point-count-mismatch", status: "mismatch" };
  }

  return field.formatVersion === 2 && domain.discretization !== "fdm"
    ? { reason: "fmvp-v2-legacy", status: "degraded" }
    : { reason: "compatible", status: "compatible" };
}

function hasDuplicateFieldNodeIndex(
  nodeIndices: ArrayLike<number> | null | undefined,
  pointCount: number,
): boolean {
  if (!nodeIndices || nodeIndices.length !== pointCount) return false;
  const seen = new Set<number>();
  for (let index = 0; index < nodeIndices.length; index += 1) {
    const nodeIndex = nodeIndices[index];
    if (nodeIndex !== undefined && seen.has(nodeIndex)) return true;
    if (nodeIndex !== undefined) seen.add(nodeIndex);
  }
  return false;
}
