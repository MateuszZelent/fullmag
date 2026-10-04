import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MaterializedDatasetResource, MaterializedDatasetSliceEnvelopeResource } from "../apiTypes";
import { decodeMaterializedDatasetSlice, materializedDatasetSliceByteLimit } from "./materializedDatasetSliceCodec";

const range = { elementOffset: "0", elementCount: "2", maxResponseBytes: "16" };
const hash = "a".repeat(64);
const digest = `sha256:${hash}`;

function dataset(): MaterializedDatasetResource {
  const source = { run_id: "run", solution_set_id: "set", solution_revision: "9007199254740992", member_id: "member", artifact_id: "tensor", tensor_object_ref: hash, run_spec_digest: digest };
  const status = { availability: "ready" as const, reason: null, actions: [] };
  return {
    schema_version: "fullmag.analysis.materialized_dataset.v1", project_id: "project", run_id: "run", solution_set_id: "set",
    containing_solution_revision: "9007199254740993", owner_solution_revision: source.solution_revision,
    member_id: "member", artifact_id: `materialized-dataset-${hash}`, manifest_object_ref: hash, manifest_byte_length: "1024",
    integrity: "verified", source, owner_execution_status: "running", owner_scientific_assessment: { status: "unassessed", reason: null, evidence_artifact_count: 0 },
    sample_id: "sample", item_id: "item", field_id: "field",
    dataset: { schema_version: "1.0.0", dataset_id: "dataset", revision: "1", definition_id: "definition", definition_revision: "1", source, status },
    definition: { schema_version: "1.0.0", definition_id: "definition", revision: "1", source,
      domain_selection: { selection_id: digest, selection_revision: "1" }, axes: [], transforms: [],
      evaluation_policy: { precision: "f64", approximation: "exact_only", unavailable_data: "fail" } },
    field: {
      sample_id: "sample", item_id: "item", field_id: "field", group_id: "group", producer_id: "producer", producer_version: "1",
      tensor_schema_id: "fullmag.tensor.v1", tensor_byte_length: "1024", plane: "values", accepted_state: null,
      tensor_artifact: { artifact_id: "tensor", schema_id: "fullmag.tensor.v1", object_ref: hash, byte_length: "1024", accepted_state: null },
      coverage: { total_elements: "2", component_count: "1", dtype: "f64", endian: "little", total_bytes: "16", chunk_count: "1" },
      descriptor: { quantity_id: "e_total", unit: "J", tensor_rank: "0", frame: { kind: "laboratory", frame_id: "lab" }, sample_location: "global",
        active_support: { support_fingerprint: digest, selection: null }, function_space: null, topology_id: digest, carrier_id: "carrier", layout_digest: digest,
        axes: [{ axis_id: "element", unit: "1", length: "2" }], component_axis: null, complex_encoding: "real", harmonic_convention: null,
        normalization: "none", value_representation: "physical_field", modal_semantics: null, resolution: "quantitative" },
    },
  };
}

async function envelope(expected: MaterializedDatasetResource, mutate?: (metadata: MaterializedDatasetSliceEnvelopeResource) => void, values: number[] = [1.5, -2]): Promise<ArrayBuffer> {
  const width = expected.field.coverage.dtype === "f32" ? 4 : 8;
  const payload = new ArrayBuffer(width * 2);
  const payloadView = new DataView(payload);
  for (const [index, value] of values.entries()) {
    if (width === 4) payloadView.setFloat32(index * width, value, true);
    else payloadView.setFloat64(index * width, value, true);
  }
  const checksum = `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", payload)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const metadata: MaterializedDatasetSliceEnvelopeResource = {
    schema_version: "fullmag.binary.materialized_dataset_slice.v1", project_id: expected.project_id, run_id: expected.run_id,
    solution_set_id: expected.solution_set_id, containing_solution_revision: expected.containing_solution_revision, member_id: expected.member_id,
    artifact_id: expected.artifact_id, manifest_object_ref: expected.manifest_object_ref, manifest_byte_length: expected.manifest_byte_length,
    integrity: "verified_returned_ranges", source: structuredClone(expected.source), descriptor: structuredClone(expected.field.descriptor),
    slice: { schema_version: "1.0.0", dataset_id: "dataset", dataset_revision: "1", sample_id: "sample", item_id: "item", field_id: "field",
      field_layout_digest: digest, element_offset: "0", element_count: "2", total_elements: "2", component_count: "1", precision: width === 4 ? "f32" : "f64",
      byte_order: "little_endian", payload_bytes: payload.byteLength.toString(),
      parts: [{ plane: "values", object_ref: hash, object_offset_bytes: "0", plane_offset_bytes: "0", byte_length: payload.byteLength.toString(), range_sha256: checksum }] },
  };
  mutate?.(metadata);
  const json = new TextEncoder().encode(JSON.stringify(metadata));
  const buffer = new ArrayBuffer(12 + json.byteLength + payload.byteLength);
  const bytes = new Uint8Array(buffer);
  bytes.set(new TextEncoder().encode("FMDS"));
  new DataView(buffer).setUint16(4, 1, true);
  new DataView(buffer).setUint32(8, json.byteLength, true);
  bytes.set(json, 12);
  bytes.set(new Uint8Array(payload), 12 + json.byteLength);
  return buffer;
}

describe("exact pinned FMDS slice", () => {
  beforeEach(() => vi.stubGlobal("crypto", webcrypto));
  afterEach(() => vi.unstubAllGlobals());

  it.each(["f32", "f64"] as const)("preserves %s values and revisions above 2^53", async (precision) => {
    const expected = dataset();
    expected.field.coverage.dtype = precision;
    expected.field.coverage.total_bytes = precision === "f32" ? "8" : "16";
    expected.definition.evaluation_policy.precision = precision;
    const decoded = await decodeMaterializedDatasetSlice(await envelope(expected), expected, range);
    expect([...decoded.values]).toEqual([1.5, -2]);
    expect(decoded.values).toBeInstanceOf(precision === "f32" ? Float32Array : Float64Array);
    expect(decoded.metadata.containing_solution_revision).toBe("9007199254740993");
  });

  it("rejects a forged source, descriptor, missing plane and range gap", async () => {
    const expected = dataset();
    for (const mutate of [
      (metadata: MaterializedDatasetSliceEnvelopeResource) => { metadata.source.tensor_object_ref = "b".repeat(64); },
      (metadata: MaterializedDatasetSliceEnvelopeResource) => { metadata.descriptor.unit = "T"; },
      (metadata: MaterializedDatasetSliceEnvelopeResource) => { metadata.slice.parts[0].plane = "real"; },
      (metadata: MaterializedDatasetSliceEnvelopeResource) => { metadata.slice.parts[0].plane_offset_bytes = "8"; },
    ]) {
      await expect(decodeMaterializedDatasetSlice(await envelope(expected, mutate), expected, range)).rejects.toThrow();
    }
  });

  it("rejects corrupt bytes, trailing bytes and aborted reads", async () => {
    const expected = dataset();
    const buffer = await envelope(expected);
    new Uint8Array(buffer)[buffer.byteLength - 1] ^= 1;
    await expect(decodeMaterializedDatasetSlice(buffer, expected, range)).rejects.toThrow(/checksum/);
    const good = await envelope(expected);
    const trailing = new Uint8Array(good.byteLength + 1);
    trailing.set(new Uint8Array(good));
    await expect(decodeMaterializedDatasetSlice(trailing.buffer, expected, range)).rejects.toThrow(/length/);
    const controller = new AbortController(); controller.abort();
    await expect(decodeMaterializedDatasetSlice(good, expected, range, controller.signal)).rejects.toThrow();
  });

  it("rejects noncanonical counters and u64 overflow before transport", () => {
    for (const elementOffset of ["01", "-1", "18446744073709551615"]) {
      expect(() => materializedDatasetSliceByteLimit({ ...range, elementOffset })).toThrow();
    }
  });

  it.each(["f32", "f64"] as const)("rejects checksum-valid nonfinite %s values", async (precision) => {
    const expected = dataset();
    expected.field.coverage.dtype = precision;
    expected.field.coverage.total_bytes = precision === "f32" ? "8" : "16";
    expected.definition.evaluation_policy.precision = precision;
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expect(decodeMaterializedDatasetSlice(await envelope(expected, undefined, [value, 0]), expected, range)).rejects.toThrow(/nonfinite/);
    }
  });
});
