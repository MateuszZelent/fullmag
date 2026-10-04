import type { MaterializedDatasetResource, SavedFieldGeometryResource } from "./apiTypes";

export const MAX_SAVED_TOPOLOGY_BYTES = 64 * 1024 * 1024;
const MAX_U64 = BigInt("18446744073709551615");
const ZERO = BigInt(0);

function counter(value: string): bigint {
  if (typeof value !== "string" || value.length > 20 || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Saved geometry counter must be a canonical decimal u64.");
  }
  const result = BigInt(value);
  if (result > MAX_U64) throw new Error("Saved geometry counter exceeds u64.");
  return result;
}

export function canonicalSavedGeometryJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSavedGeometryJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalSavedGeometryJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function validateSavedGeometry(
  value: SavedFieldGeometryResource,
  dataset: MaterializedDatasetResource,
): SavedFieldGeometryResource {
  const source = dataset.source;
  if (
    value.schema_version !== "fullmag.persistence.saved_field_geometry.v1" ||
    dataset.schema_version !== "fullmag.analysis.materialized_dataset.v1" ||
    dataset.integrity !== "verified" ||
    value.coordinate_unit !== "m" ||
    value.geometry_schema_version !== "fullmag.fem_p1_field_geometry.v1" ||
    value.geometry_payload.schema_id !== value.geometry_schema_version ||
    value.geometry_manifest.schema_id !== "fullmag.solution_field_geometry.v1" ||
    value.topology_binary_schema !== "fullmag.binary.fem_mesh_topology.v2" ||
    value.support_binary_schema !== "fullmag.binary.saved_field_support.v1" ||
    value.representation_evidence !== "not_verified" ||
    value.project_id !== dataset.project_id ||
    value.run_id !== dataset.run_id ||
    value.solution_set_id !== dataset.solution_set_id ||
    value.containing_solution_revision !== dataset.containing_solution_revision ||
    value.owner_solution_revision !== source.solution_revision ||
    value.member_id !== dataset.member_id ||
    value.source.run_id !== source.run_id ||
    value.source.solution_set_id !== source.solution_set_id ||
    value.source.solution_revision !== source.solution_revision ||
    value.source.member_id !== source.member_id ||
    value.source.tensor_artifact_id !== source.artifact_id ||
    value.source.tensor_object_ref !== source.tensor_object_ref ||
    value.source.run_spec_digest !== source.run_spec_digest ||
    value.dataset_manifest.kind !== "other" ||
    value.geometry_manifest.kind !== "other" ||
    canonicalSavedGeometryJson(value.tensor_artifact.accepted_state ?? null) !==
      canonicalSavedGeometryJson(dataset.field.tensor_artifact.accepted_state ?? null) ||
    canonicalSavedGeometryJson(value.geometry_manifest.accepted_state ?? null) !==
      canonicalSavedGeometryJson(dataset.field.accepted_state ?? null) ||
    canonicalSavedGeometryJson(value.dataset_manifest.accepted_state ?? null) !==
      canonicalSavedGeometryJson(dataset.field.accepted_state ?? null) ||
    value.dataset_manifest.artifact_id !== dataset.artifact_id ||
    value.dataset_manifest.schema_id !== "fullmag.materialized_dataset.v1" ||
    value.dataset_manifest.object_ref !== dataset.manifest_object_ref ||
    value.dataset_manifest.byte_length !== dataset.manifest_byte_length ||
    value.tensor_artifact.artifact_id !== source.artifact_id ||
    value.tensor_artifact.object_ref !== source.tensor_object_ref ||
    value.tensor_artifact.artifact_id !== dataset.field.tensor_artifact.artifact_id ||
    value.tensor_artifact.object_ref !== dataset.field.tensor_artifact.object_ref ||
    value.tensor_artifact.schema_id !== dataset.field.tensor_artifact.schema_id ||
    value.tensor_artifact.byte_length !== dataset.field.tensor_artifact.byte_length ||
    value.tensor_artifact.schema_id !== dataset.field.tensor_schema_id ||
    value.tensor_artifact.byte_length !== dataset.field.tensor_byte_length ||
    value.geometry_manifest.artifact_id !==
      `solution-field-geometry-${value.geometry_manifest.object_ref}` ||
    value.dataset.dataset_id !== dataset.dataset.dataset_id ||
    value.dataset.revision !== dataset.dataset.revision ||
    value.dataset.sample_id !== dataset.sample_id ||
    value.dataset.item_id !== dataset.item_id ||
    value.dataset.field_id !== dataset.field_id ||
    value.dataset.group_id !== dataset.field.group_id ||
    canonicalSavedGeometryJson(value.dataset.descriptor) !==
      canonicalSavedGeometryJson(dataset.field.descriptor) ||
    value.layout_digest !== dataset.field.descriptor.layout_digest ||
    value.topology_fingerprint !== dataset.field.descriptor.topology_id ||
    value.support_fingerprint !== dataset.field.descriptor.active_support.support_fingerprint ||
    value.producer_id !== dataset.field.producer_id ||
    value.producer_version !== dataset.field.producer_version
  ) {
    throw new Error("Saved geometry differs from its exact pinned dataset.");
  }
  if (counter(value.owner_solution_revision) === ZERO ||
      counter(value.owner_solution_revision) > counter(value.containing_solution_revision) ||
      counter(value.node_count) === ZERO || value.node_count !== dataset.field.coverage.total_elements ||
      counter(value.node_count) > BigInt(Math.floor(MAX_SAVED_TOPOLOGY_BYTES / 24)) ||
      counter(value.cell_count) === ZERO || counter(value.active_node_count) > counter(value.node_count) ||
      counter(value.cell_count) > BigInt(MAX_SAVED_TOPOLOGY_BYTES / 16) ||
      counter(value.facet_count) > BigInt(Math.floor(MAX_SAVED_TOPOLOGY_BYTES / 12)) ||
      counter(value.geometry_decode_budget_bytes) !== BigInt(MAX_SAVED_TOPOLOGY_BYTES)) {
    throw new Error("Saved geometry extents or owner revision are invalid.");
  }
  if (counter(value.geometry_manifest.byte_length) > BigInt(1024 * 1024)) {
    throw new Error("Saved geometry manifest exceeds its metadata budget.");
  }
  for (const artifact of [value.geometry_manifest, value.geometry_payload]) {
    if (!/^[a-f0-9]{64}$/.test(artifact.object_ref) || counter(artifact.byte_length) === ZERO ||
        counter(artifact.byte_length) > BigInt(MAX_SAVED_TOPOLOGY_BYTES)) {
      throw new Error("Saved geometry CAS identity or byte budget is invalid.");
    }
  }
  return value;
}

export function savedTopologyByteLimit(value: SavedFieldGeometryResource): number {
  const length = value.topology_binary_byte_length;
  const hash = value.topology_binary_sha256;
  if (length == null || hash == null || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error("Pinned topology is unavailable within the bounded transport.");
  }
  const parsed = counter(length);
  if (parsed < BigInt(64) || parsed > BigInt(MAX_SAVED_TOPOLOGY_BYTES)) {
    throw new Error("Pinned topology body exceeds its bounded contract.");
  }
  return Number(parsed);
}

export async function verifySavedTopologyBody(
  buffer: ArrayBuffer,
  expected: SavedFieldGeometryResource,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (buffer.byteLength !== savedTopologyByteLimit(expected)) {
    throw new Error("Pinned topology body length mismatch.");
  }
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  signal?.throwIfAborted();
  const actual = Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("");
  if (actual !== expected.topology_binary_sha256) throw new Error("Pinned topology checksum mismatch.");
}
