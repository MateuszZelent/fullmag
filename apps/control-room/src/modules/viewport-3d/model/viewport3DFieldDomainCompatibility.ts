import type { FieldVectorResponseMetadata } from "@/kernel/api/apiTypes";
import type { DecodedFieldVector } from "@/kernel/api/codecs";

import { buildFdmFieldIndexResolver } from "./fdmFieldIndexing";

type FieldResponseDomainIdentity = Pick<
  FieldVectorResponseMetadata,
  "domainGenerationId" | "identityIssues"
>;

export interface Viewport3DFieldDomainIdentity {
  discretization?: "fdm" | "fem";
  domainGenerationId: string | null;
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
    Partial<Pick<DecodedFieldVector, "grid" | "nComp">>;
  responseDomainGenerationId?: string | null;
}): Viewport3DFieldDomainCompatibility {
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

function canonicalMeshTopologyHash(value: string): string {
  const match = /^(?:sha256:)?([0-9a-f]{64})$/i.exec(value);
  return match?.[1]?.toLowerCase() ?? value;
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
