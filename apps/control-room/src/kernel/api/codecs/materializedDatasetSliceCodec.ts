import type { MaterializedDatasetResource, MaterializedDatasetSliceEnvelopeResource } from "../apiTypes";

export const MAX_DATASET_SLICE_BYTES = 64 * 1024 * 1024;
export const MAX_DATASET_SLICE_METADATA_BYTES = 1024 * 1024;
export const DATASET_SLICE_HEADER_BYTES = 12;
const MAX_U64 = BigInt("18446744073709551615");
const ZERO = BigInt(0);

export interface MaterializedDatasetSliceRange {
  elementOffset: string;
  elementCount: string;
  maxResponseBytes: string;
}

export interface DecodedMaterializedDatasetSlice {
  metadata: MaterializedDatasetSliceEnvelopeResource;
  values: Float32Array | Float64Array;
}

function counter(value: string): bigint {
  if (typeof value !== "string" || value.length > 20 || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Dataset slice counter must be a canonical decimal u64.");
  }
  const parsed = BigInt(value);
  if (parsed > MAX_U64) throw new Error("Dataset slice counter exceeds u64.");
  return parsed;
}

export function materializedDatasetSliceByteLimit(range: MaterializedDatasetSliceRange): number {
  const offset = counter(range.elementOffset);
  const count = counter(range.elementCount);
  const budget = counter(range.maxResponseBytes);
  if (count === ZERO || count > BigInt(8 * 1024 * 1024) || offset + count > MAX_U64 ||
      budget === ZERO || budget > BigInt(MAX_DATASET_SLICE_BYTES)) {
    throw new Error("Dataset slice range or budget exceeds the bounded contract.");
  }
  return Number(budget) + MAX_DATASET_SLICE_METADATA_BYTES + DATASET_SLICE_HEADER_BYTES;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Decode v1 Values without replacing unavailable, nonfinite or complex data. */
export async function decodeMaterializedDatasetSlice(
  buffer: ArrayBuffer,
  expected: MaterializedDatasetResource,
  range: MaterializedDatasetSliceRange,
  signal?: AbortSignal,
): Promise<DecodedMaterializedDatasetSlice> {
  signal?.throwIfAborted();
  const limit = materializedDatasetSliceByteLimit(range);
  if (buffer.byteLength < DATASET_SLICE_HEADER_BYTES || buffer.byteLength > limit) {
    throw new Error("FMDS envelope length is outside its bounded contract.");
  }
  const view = new DataView(buffer);
  if (String.fromCharCode(...new Uint8Array(buffer, 0, 4)) !== "FMDS" ||
      view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 0) {
    throw new Error("Unsupported FMDS header.");
  }
  const metadataLength = view.getUint32(8, true);
  const payloadStart = DATASET_SLICE_HEADER_BYTES + metadataLength;
  if (metadataLength === 0 || metadataLength > MAX_DATASET_SLICE_METADATA_BYTES || payloadStart > buffer.byteLength) {
    throw new Error("FMDS metadata length is invalid.");
  }
  const metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
    new Uint8Array(buffer, DATASET_SLICE_HEADER_BYTES, metadataLength),
  )) as MaterializedDatasetSliceEnvelopeResource;
  if (expected.schema_version !== "fullmag.analysis.materialized_dataset.v1" || expected.integrity !== "verified" ||
      metadata.schema_version !== "fullmag.binary.materialized_dataset_slice.v1" ||
      metadata.project_id !== expected.project_id || metadata.run_id !== expected.run_id ||
      metadata.solution_set_id !== expected.solution_set_id ||
      metadata.containing_solution_revision !== expected.containing_solution_revision ||
      metadata.member_id !== expected.member_id || metadata.artifact_id !== expected.artifact_id ||
      metadata.manifest_object_ref !== expected.manifest_object_ref ||
      metadata.manifest_byte_length !== expected.manifest_byte_length ||
      metadata.artifact_id !== `materialized-dataset-${metadata.manifest_object_ref}` ||
      !/^[a-f0-9]{64}$/.test(metadata.manifest_object_ref) ||
      metadata.integrity !== "verified_returned_ranges" ||
      canonicalJson(metadata.source) !== canonicalJson(expected.source) ||
      canonicalJson(metadata.descriptor) !== canonicalJson(expected.field.descriptor)) {
    throw new Error("Dataset slice source or descriptor differs from the pinned dataset.");
  }
  const slice = metadata.slice;
  if (slice.schema_version !== "1.0.0" || slice.dataset_id !== expected.dataset.dataset_id ||
      slice.dataset_revision !== expected.dataset.revision || slice.sample_id !== expected.sample_id ||
      slice.item_id !== expected.item_id || slice.field_id !== expected.field_id ||
      slice.field_layout_digest !== expected.field.descriptor.layout_digest ||
      slice.element_offset !== range.elementOffset || slice.element_count !== range.elementCount ||
      slice.total_elements !== expected.field.coverage.total_elements ||
      slice.component_count !== expected.field.coverage.component_count ||
      slice.precision !== expected.field.coverage.dtype || !["f32", "f64"].includes(slice.precision) ||
      slice.byte_order !== "little_endian" || expected.field.coverage.endian !== "little" ||
      metadata.descriptor.complex_encoding !== "real" || metadata.descriptor.harmonic_convention !== null ||
      !Array.isArray(slice.parts) || slice.parts.length === 0 || slice.parts.length > 4096) {
    throw new Error("Dataset slice shape, range or plane semantics are incompatible.");
  }
  const count = counter(slice.element_count);
  const components = counter(slice.component_count);
  const scalarBytes = BigInt(slice.precision === "f32" ? 4 : 8);
  const payloadBytes = counter(slice.payload_bytes);
  if (components === ZERO || counter(slice.element_offset) + count > counter(slice.total_elements) ||
      payloadBytes !== count * components * scalarBytes || payloadBytes > counter(range.maxResponseBytes) ||
      BigInt(buffer.byteLength - payloadStart) !== payloadBytes) {
    throw new Error("Dataset slice payload length or coverage is invalid.");
  }
  let written = ZERO;
  for (const part of slice.parts) {
    signal?.throwIfAborted();
    const length = counter(part.byte_length);
    const objectOffset = counter(part.object_offset_bytes);
    if (part.plane !== "values" || counter(part.plane_offset_bytes) !== written || length === ZERO ||
        length % scalarBytes !== ZERO || objectOffset % scalarBytes !== ZERO || objectOffset + length > MAX_U64 ||
        written + length > payloadBytes || !/^[a-f0-9]{64}$/.test(part.object_ref) ||
        !/^sha256:[a-f0-9]{64}$/.test(part.range_sha256)) {
      throw new Error("Dataset slice parts have missing, duplicate or invalid ranges.");
    }
    const bytes = new Uint8Array(buffer, payloadStart + Number(written), Number(length));
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const digest = `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    if (digest !== part.range_sha256) throw new Error("Dataset slice returned range checksum mismatch.");
    written += length;
  }
  signal?.throwIfAborted();
  if (written !== payloadBytes) throw new Error("Dataset slice has incomplete payload coverage.");
  const valuesCount = Number(count * components);
  const values = slice.precision === "f32" ? new Float32Array(valuesCount) : new Float64Array(valuesCount);
  const width = Number(scalarBytes);
  for (let index = 0; index < valuesCount; index++) {
    const offset = payloadStart + index * width;
    values[index] = width === 4 ? view.getFloat32(offset, true) : view.getFloat64(offset, true);
    if (!Number.isFinite(values[index])) throw new Error("Dataset slice contains nonfinite payload values.");
  }
  return { metadata, values };
}
