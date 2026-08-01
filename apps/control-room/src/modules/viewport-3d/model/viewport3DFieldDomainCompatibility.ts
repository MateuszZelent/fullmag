import type { DecodedFieldVector } from "@/kernel/api/codecs";

export interface Viewport3DFieldDomainIdentity {
  domainGenerationId: string | null;
  meshTopologyHash: string | null;
  meshTopologyRevision: string | null;
  pointCount: number;
}

export type Viewport3DFieldDomainCompatibility =
  | { reason: "compatible"; status: "compatible" }
  | { reason: "fmvp-v2-legacy"; status: "degraded" }
  | {
      reason:
        | "domain-generation-mismatch"
        | "domain-generation-unknown"
        | "mesh-topology-hash-mismatch"
        | "mesh-topology-revision-mismatch"
        | "point-count-mismatch";
      status: "mismatch";
    };

export function safeViewport3DDomainGenerationId(value: unknown): string | null {
  if (typeof value === "string") return value;
  return typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : null;
}

export function resolveViewport3DFieldVectorForDomain({
  domain,
  fieldVector,
}: {
  domain: Viewport3DFieldDomainIdentity;
  fieldVector: DecodedFieldVector | null;
}): DecodedFieldVector | null {
  if (!fieldVector) return null;
  return resolveViewport3DFieldDomainCompatibility({ domain, field: fieldVector })
    .status === "mismatch"
    ? null
    : fieldVector;
}

export function resolveViewport3DFieldDomainCompatibility({
  domain,
  field,
}: {
  domain: Viewport3DFieldDomainIdentity;
  field: Pick<
    DecodedFieldVector,
    | "domainGenerationId"
    | "formatVersion"
    | "indexing"
    | "meshTopologyHash"
    | "meshTopologyRevision"
    | "pointCount"
  >;
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
    field.indexing === "full_domain" &&
    field.pointCount > 0 &&
    domain.pointCount > 0 &&
    field.pointCount !== domain.pointCount
  ) {
    return { reason: "point-count-mismatch", status: "mismatch" };
  }

  return field.formatVersion === 2
    ? { reason: "fmvp-v2-legacy", status: "degraded" }
    : { reason: "compatible", status: "compatible" };
}

function canonicalMeshTopologyHash(value: string): string {
  const match = /^(?:sha256:)?([0-9a-f]{64})$/i.exec(value);
  return match?.[1]?.toLowerCase() ?? value;
}
