import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

// Interpret the actual production gate; do not build a unit-test bundle.
const source = readFileSync(new URL("../src/kernel/resources/antennaResources.ts", import.meta.url), "utf8");
const start = source.indexOf("function inspectionDisplayPayloadMatchesManifest(");
const end = source.indexOf("export function useAntennaInspectionDisplayResource(", start);
assert.ok(start >= 0 && end > start, "production inspection gate must remain discoverable");
const gate = vm.runInNewContext(`${stripTypeScriptTypes(source.slice(start, end))
  .replace("export function antennaInspectionDisplayMatchesOwner", "function antennaInspectionDisplayMatchesOwner")}
  antennaInspectionDisplayMatchesOwner;`);

const sha = "a".repeat(64);
const payload = (path, layout, unit, count) => ({
  path, layout, unit, value_count: count, byte_count: count * 8,
  scalar_type: "float64_le", sha256: sha,
});
function fixture(version) {
  const owner = {
    session_id: "session", session_epoch: 2, request_scope_epoch: 3,
    run_id: "run", runtime_stage_id: "runtime-stage", stage_revision: 4,
    record_content_digest: "b".repeat(64),
  };
  const carrier = {
    carrier_kind: "target_mesh", location: "cell_center", sample_count: 2,
    topology_digest: "c".repeat(64), domain: { kind: "object", object_id: "receiver" },
  };
  const fields = {
    device_potential: payload("potential.bin", "vertex_scalar", "V", 4),
    sample_positions: payload("positions.bin", "xyz_interleaved", "m", 6),
    magnetic_field: payload("field.bin", "vector_xyz_interleaved", "A/m", 6),
  };
  const manifest = {
    schema_version: `antenna_external_lead_solution.v${version}`,
    content_digest: sha, source_object_id: "antenna", sampling_carrier: carrier, ...fields,
  };
  const display = {
    ...owner, ...fields, schema_version: `antenna_inspection_display.v${version}`,
    content_digest: sha, source_object_id: "antenna", device_cell_count: 2,
    sampling_carrier: structuredClone(carrier), status: "inspection_only",
    qualification: "NOT VERIFIED", field_scope: "external_electrode_truncation",
    normalization: "raw_authored_current",
    capabilities: {
      display: true, current_density: version === 2,
      per_ampere_basis: false, llg_drive: false, source_fft: false,
    },
  };
  if (version === 2) {
    const snapshot = {
      ...payload("current_display.v1.bin", "accepted_external_lead_current_display.ordered.v1", "A/m^2", 4096),
      scalar_type: "ordered_binary_v1", byte_count: 4096,
    };
    const receipt = {
      schema_version: "accepted_external_lead_current_display.ordered.v1",
      operator_version: "fem_accepted_external_lead_current_display.v1",
      current_evaluator_version: "fem_generic_affine_rt0.v1",
      sampling_policy: "cell_center_and_cell_local_vertices.v1",
      center_policy: "vertex_quarter_sum.long_double.v1",
      normalization: "raw_authored_current", coordinate_unit: "m",
      current_density_unit: "A/m^2", cell_count: 2, payload: snapshot,
    };
    manifest.current_display = structuredClone(receipt);
    display.device_current = {
      receipt, ordered_snapshot: structuredClone(snapshot),
      center_positions: payload("display/current_center_positions.bin", "cell_xyz_interleaved", "m", 6),
      center_current_density: payload("display/current_center_density.bin", "cell_vector_xyz_interleaved", "A/m^2", 6),
      trace_positions: payload("display/current_trace_positions.bin", "cell_local_vertex_xyz_interleaved", "m", 24),
      trace_current_density: payload("display/current_trace_density.bin", "cell_local_vertex_vector_xyz_interleaved", "A/m^2", 24),
    };
  }
  return {
    inspection: {
      ...owner, schema_version: `antenna_external_lead_stage_output.v${version}`,
      outputs: [{ inspection_ref: { content_digest: sha } }], manifest,
    },
    display,
  };
}

let checks = 0;
for (const version of [1, 2]) {
  const { inspection, display } = fixture(version);
  assert.equal(gate(inspection, display), true, `v${version} must remain readable`);
  checks++;
}
function rejects(label, mutate, version = 2) {
  const pair = fixture(version);
  mutate(pair);
  assert.equal(gate(pair.inspection, pair.display), false, label);
  checks++;
}
rejects("v2 display must not bind a v1 manifest", ({ inspection }) => {
  inspection.manifest.schema_version = "antenna_external_lead_solution.v1";
});
rejects("v2 display must not bind a v1 stage", ({ inspection }) => {
  inspection.schema_version = "antenna_external_lead_stage_output.v1";
});
rejects("v1 display must not hide a v2 current receipt", ({ inspection }) => {
  inspection.manifest.current_display = fixture(2).inspection.manifest.current_display;
}, 1);
rejects("legacy display must not advertise J", ({ display }) => {
  display.capabilities.current_density = true;
}, 1);
rejects("missing owned current", ({ display }) => { delete display.device_current; });
rejects("missing immutable current receipt", ({ inspection }) => { delete inspection.manifest.current_display; });
rejects("missing current capability", ({ display }) => { display.capabilities.current_density = false; });
rejects("different device cell count", ({ display }) => { display.device_cell_count = 3; });
rejects("fractional current cell count", ({ display }) => { display.device_current.receipt.cell_count = 1.5; });
for (const key of ["operator_version", "current_evaluator_version", "sampling_policy", "center_policy",
  "normalization", "coordinate_unit", "current_density_unit"]) {
  rejects(`unknown ${key} even when both receipts agree`, ({ inspection, display }) => {
    inspection.manifest.current_display[key] = "foreign";
    display.device_current.receipt[key] = "foreign";
  });
}
rejects("unbound snapshot digest", ({ display }) => { display.device_current.ordered_snapshot.sha256 = "d".repeat(64); });
for (const key of ["center_positions", "center_current_density", "trace_positions", "trace_current_density"]) {
  rejects(`${key}: wrong binary path`, ({ display }) => { display.device_current[key].path = "foreign.bin"; });
  rejects(`${key}: wrong unit`, ({ display }) => { display.device_current[key].unit = "T"; });
  rejects(`${key}: wrong size`, ({ display }) => { display.device_current[key].byte_count++; });
  rejects(`${key}: malformed digest`, ({ display }) => { display.device_current[key].sha256 = "invalid"; });
}
for (const key of ["session_id", "session_epoch", "request_scope_epoch", "run_id", "runtime_stage_id",
  "stage_revision", "record_content_digest", "source_object_id"]) {
  rejects(`foreign ${key}`, ({ display }) => { display[key] = "foreign"; });
}
for (const key of ["per_ampere_basis", "llg_drive", "source_fft"]) {
  rejects(`inspection must not advertise ${key}`, ({ display }) => { display.capabilities[key] = true; });
}
rejects("mismatched V digest", ({ display }) => {
  display.device_potential = { ...display.device_potential, sha256: "d".repeat(64) };
});
rejects("mismatched receiving domain", ({ display }) => { display.sampling_carrier.domain.object_id = "foreign"; });
console.log(`Antenna inspection generation: ${checks}/${checks} PASS (interpreted production gate; no native solve or browser proof).`);
