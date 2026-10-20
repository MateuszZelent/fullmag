import type { DecodedFieldVector } from "./codecs/types";
import type { FieldVectorResponseMetadata } from "./apiTypes";

/** Transport admission only; the adapter must still bind metadata, owner and topology. */
export function artifactFieldResponseIdentityError(quantityId: string, query: Readonly<Record<string, unknown>>, field: DecodedFieldVector, metadata: FieldVectorResponseMetadata): string | null {
  const requestedArtifact = typeof query.carrier_id === "string" && query.carrier_id.startsWith("artifact:");
  if (field.formatVersion !== 6) return requestedArtifact ? "Artifact field request received a different binary format." : null;
  const digest = field.meshTopologyHash, revision = field.meshTopologyRevision;
  if (!requestedArtifact || !digest || !revision || query.carrier_id !== `artifact:${digest}:${field.indexing}` ||
    query.expected_carrier_revision !== revision || query.expected_generation_id !== digest ||
    typeof query.stage_id !== "string" || !query.stage_id.trim() || (query.component ?? "full") !== "full" ||
    quantityId !== field.quantityId || (query.scope_kind ?? "full") !== field.scopeKind ||
    (query.scope_id ?? null) !== (field.scopeId ?? null)) return "Artifact field response differs from the explicitly pinned request.";
  const expected = {
    component: "full",
    carrierId: query.carrier_id, carrierRevision: revision, carrierDigest: digest,
    quantityId: field.quantityId, pointCount: field.pointCount, valueCount: field.valueCount, nComp: field.nComp,
    domainGenerationId: digest, fieldIndexing: field.indexing, scopeKind: field.scopeKind,
    scopeId: field.scopeId ?? null, sourceKind: "artifact_inspection", sourceId: field.sourceId,
    sourceRevision: field.sourceRevision, fieldGenerationId: field.fieldGenerationId,
  };
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if ((metadata[key] ?? null) !== (expected[key] ?? null)) return `Artifact field response has missing or inconsistent ${key}.`;
  }
  if (!metadata.meshTopologyHash || metadata.meshTopologyHash.replace(/^sha256:/, "") !== digest || metadata.identityIssues.length)
    return "Artifact field response headers and payload identity differ.";
  return null;
}
