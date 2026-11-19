import type { components } from "@/kernel/api/generated/openapi-v2-types";
import type { ArtifactCarrierGeometryQuery, FieldVectorQuery, FieldVectorResponseMetadata } from "@/kernel/api/apiTypes";
import type { DecodedFieldVector, DecodedTopology } from "@/kernel/api/codecs/types";

interface ArtifactFieldLocator {
  sample_carrier?: components["schemas"]["AntennaSampleCarrierResource"] | null;
  carrier_scope_kind: "object" | "full"; carrier_scope_id: string | null;
  carrier_id: string; carrier_digest: string; carrier_revision: string;
  indexing: string; sample_count: number; coordinate_frame: "world"; coordinate_unit: "m"; topology_binary_schema: "FMMT.v2";
  owner: Record<string, unknown> & Record<"session_id" | "session_epoch" | "request_scope_epoch" | "run_id" | "runtime_stage_id" | "authored_stage_id" | "module_id" | "object_id" | "output_id" | "source_digest" | "content_digest" | "native_mesh_identity" | "native_topology_identity", string> & { historical_inspection: true };
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Artifact carrier requires typed metadata.");
  return value as Record<string, unknown>;
};
export function parseArtifactFieldLocator(value: unknown): ArtifactFieldLocator {
  const locator = record(value), owner = record(locator.owner);
  for (const key of ["session_id", "session_epoch", "request_scope_epoch", "run_id", "runtime_stage_id", "authored_stage_id", "module_id", "object_id", "output_id", "source_digest", "content_digest", "native_mesh_identity", "native_topology_identity"]) {
    if (typeof owner[key] !== "string" || !(owner[key] as string).trim() || (owner[key] as string).includes("\0") || (owner[key] as string).length > 4096) throw new Error("Incomplete immutable artifact owner.");
  }
  if (owner.accepted_artifact != null) {
    const accepted = record(owner.accepted_artifact);
    const keys = ["project_id", "task_id", "attempt_id", "ownership_epoch", "artifact_id", "object_ref"];
    if (Object.keys(accepted).length !== keys.length || keys.some(key => typeof accepted[key] !== "string"
      || !(accepted[key] as string).trim() || (accepted[key] as string).length > 4096 || (accepted[key] as string).includes("\0"))

      || !/^[1-9][0-9]*$/.test(accepted.ownership_epoch as string)
      || BigInt(accepted.ownership_epoch as string) > BigInt("18446744073709551615")
      || !/^[0-9a-f]{64}$/.test(accepted.object_ref as string)) throw new Error("Invalid accepted artifact task/attempt/epoch/CAS binding.");
  }
  if (!((locator.carrier_scope_kind === "object" && typeof locator.carrier_scope_id === "string" && locator.carrier_scope_id.trim() && !locator.carrier_scope_id.includes("\0")) || (locator.carrier_scope_kind === "full" && locator.carrier_scope_id === null))
    || owner.historical_inspection !== true || typeof locator.carrier_digest !== "string" || !/^[0-9a-f]{64}$/.test(locator.carrier_digest)
    || typeof locator.carrier_revision !== "string" || !/^[1-9][0-9]*$/.test(locator.carrier_revision) || BigInt(locator.carrier_revision) > BigInt("18446744073709551615")
    || typeof locator.indexing !== "string" || !["source_nodes", "sample_nodes", "point_samples", "tet4_cell_local_nodes", "cell_centers"].includes(locator.indexing)
    || locator.carrier_id !== `artifact:${locator.carrier_digest}:${locator.indexing}`
    || !Number.isSafeInteger(locator.sample_count) || (locator.sample_count as number) <= 0
    || locator.coordinate_frame !== "world" || locator.coordinate_unit !== "m" || locator.topology_binary_schema !== "FMMT.v2") throw new Error("Invalid immutable artifact carrier.");
  return locator as unknown as ArtifactFieldLocator;
}
export function artifactCarrierQueries(value: unknown): { vector: FieldVectorQuery; geometry: ArtifactCarrierGeometryQuery } {
  const locator = parseArtifactFieldLocator(value);
  return { vector: { carrier_id: locator.carrier_id, stage_id: locator.owner.runtime_stage_id, expected_carrier_revision: locator.carrier_revision,
    expected_generation_id: locator.carrier_digest, scope_kind: locator.carrier_scope_kind, scope_id: locator.carrier_scope_id, geometry_scope: "full", component: "full" },
    geometry: { carrier_id: locator.carrier_id, stage_id: locator.owner.runtime_stage_id, expected_carrier_revision: locator.carrier_revision } };
}
/** Admission against owned immutable geometry; never adopts a current magnetic domain. */
export function admitArtifactFieldCarrier(value: unknown, field: DecodedFieldVector, fieldHeaders: FieldVectorResponseMetadata, topology: DecodedTopology, topologyHeaders: unknown) {
  const locator = parseArtifactFieldLocator(value), geometry = record(topologyHeaders);
  if (field.formatVersion !== 6 || field.sourceKind !== "artifact_inspection" || !field.artifactMapping
    || field.domainGenerationId !== locator.carrier_digest || field.meshTopologyHash !== locator.carrier_digest || field.meshTopologyRevision !== locator.carrier_revision
    || field.sourceId !== locator.owner.source_digest || field.fieldGenerationId !== locator.owner.content_digest || field.scopeKind !== locator.carrier_scope_kind || (field.scopeId ?? null) !== locator.carrier_scope_id
    || field.indexing !== locator.indexing || field.pointCount !== locator.sample_count || fieldHeaders.identityIssues.length
    || fieldHeaders.carrierId !== locator.carrier_id || fieldHeaders.carrierDigest !== locator.carrier_digest || fieldHeaders.carrierRevision !== locator.carrier_revision
    || geometry.carrierId !== locator.carrier_id || geometry.carrierDigest !== locator.carrier_digest || geometry.carrierRevision !== locator.carrier_revision
    || geometry.coordinateFrame !== "world" || geometry.coordinateUnit !== "m" || topology.formatVersion !== 2
    || topology.nodeCount !== locator.sample_count || topology.positions.length !== locator.sample_count * 3
    || topology.positions.some(v => !Number.isFinite(v))) throw new Error("Artifact field/owned topology identity mismatch.");
  if (locator.indexing === "tet4_cell_local_nodes") {
    const mapping = field.artifactMapping;
    if (!topology.cellTypes || !topology.cellOffsets || !topology.cellNodes || topology.cellTypes.length * 4 !== locator.sample_count ||
        topology.cellOffsets.length !== topology.cellTypes.length + 1 || topology.cellNodes.length !== locator.sample_count ||
        mapping.indexing !== locator.indexing || mapping.identityIds.length !== locator.sample_count ||
        mapping.elementOrdinals?.length !== locator.sample_count || mapping.localVertexIndices?.length !== locator.sample_count) throw new Error("Missing owned cell-local Tet4 topology or mapping.");
    const elements = new Set<bigint>();
    for (let cell = 0; cell < topology.cellTypes.length; cell++) {
      const ordinal = mapping.elementOrdinals[cell * 4];
      if (elements.has(ordinal)) throw new Error("Duplicate cell-local element identity.");
      elements.add(ordinal);
      for (let local = 0; local < 4; local++) if (mapping.elementOrdinals[cell * 4 + local] !== ordinal || mapping.localVertexIndices[cell * 4 + local] !== local) throw new Error("Cell-local mapping order differs from its owned topology.");
      if (topology.cellTypes[cell] !== 1 || topology.cellOffsets[cell] !== cell * 4 || topology.cellOffsets[cell + 1] !== (cell + 1) * 4) throw new Error("Cell-local Tet4 ownership mismatch.");
      for (let local = 0; local < 4; local++) if (topology.cellNodes[cell * 4 + local] !== cell * 4 + local) throw new Error("Cell-local trace geometry cannot be shared or averaged.");
    }
  }
  return { status: "historical_inspection" as const, coordinateUnit: "m" as const, field, topology, locator };
}
