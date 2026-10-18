import type { ClosedLoopPayloadKind } from "@/kernel/resources/antennaClosedLoopInspectionModel";

/** Synthetic UI-only carrier. Auxiliary evidence bytes are not a physical certificate. */
export async function makeClosedLoopBrowserFixture(owner: { session_id: string; session_epoch: string; request_scope_epoch: string }, cancellation?: "current" | "magnetic") {
  const f64 = (values: number[]) => {
    const data = new ArrayBuffer(values.length * 8), view = new DataView(data);
    values.forEach((value, index) => view.setFloat64(index * 8, value, true));
    return data;
  };
  const positions = [-2e-7,-1e-7,0, 0,-1e-7,0, -2e-7,1e-7,0, -2e-7,-1e-7,1e-7];
  const samplePositions = positions.map((value, index) => value + (index % 3 === 0 ? 3e-7 : index % 3 === 2 ? 3e-8 : 0));
  const affineCancellation = (coordinates: number[]) => coordinates.map((value, index) =>
    (value - [1,2,3].reduce((sum, vertex) => sum + coordinates[vertex * 3 + index % 3] / 3, 0)) * 1e15);
  const localCurrent = cancellation === "current" ? affineCancellation(positions)
    : positions.map((value, index) => (index % 3 + 1) * 1e8 + value * 1e14);
  const centers = [0,1,2].map(axis => [0,1,2,3].reduce((sum, vertex) => sum + positions[vertex * 3 + axis] / 4, 0));
  const centerCurrent = [0,1,2].map(axis => [0,1,2,3].reduce((sum, vertex) => sum + localCurrent[vertex * 3 + axis] / 4, 0));
  const ids = new ArrayBuffer(32), idView = new DataView(ids);
  for (let vertex = 0; vertex < 4; vertex++) idView.setBigUint64(vertex * 8, BigInt("9007199254740992") + BigInt(vertex), true);
  const cells = new ArrayBuffer(280), cell = new DataView(cells);
  cell.setBigUint64(0, BigInt(7), true);
  for (let vertex = 0; vertex < 4; vertex++) cell.setBigUint64(8 + vertex * 8, idView.getBigUint64(vertex * 8, true), true);
  for (const [offset, values] of [[40, positions], [136, localCurrent], [232, centers], [256, centerCurrent]] as const) {
    values.forEach((value, index) => cell.setFloat64(offset + index * 8, value, true));
  }
  const sampleCells = new ArrayBuffer(16), connectivity = new DataView(sampleCells);
  [0,1,2,3].forEach((index) => connectivity.setUint32(index * 4, index, true));
  const potential = [-2,0,3,4], magnetic = cancellation === "magnetic" ? affineCancellation(samplePositions)
    : [10,-20,30,-40,50,-60,70,-80,90,-100,110,-120];
  const scale = -0.5;
  const payloads: Record<ClosedLoopPayloadKind, ArrayBuffer> = {
    stable_vertex_ids: ids, vertex_xyz: f64(positions), sample_xyz: f64(samplePositions), sample_cells: sampleCells,
    conductivity: f64([5.8e7]), v_raw: f64(potential), v_per_a: f64(potential.map(value => value * scale)),
    j_center_raw: f64(centerCurrent), j_center_per_a: f64(centerCurrent.map(value => value * scale)),
    j_local_raw: f64(localCurrent), j_local_per_a: f64(localCurrent.map(value => value * scale)),
    h_raw: f64(magnetic), h_per_a: f64(magnetic.map(value => value * scale)), cells,
    faces: new ArrayBuffer(128), weak: new ArrayBuffer(32), prepared_preimage: new ArrayBuffer(1),
    charge_preimage: new ArrayBuffer(1), source_preimage: new ArrayBuffer(1), certificate: new ArrayBuffer(1),
    authoring_receipt: new TextEncoder().encode('{"fixture_only":true}').buffer as ArrayBuffer,
    direct_evidence: new ArrayBuffer(680),
  };
  const shapes: [ClosedLoopPayloadKind, string, string][] = [
    ["stable_vertex_ids","node_u64_le","1"], ["vertex_xyz","node_xyz_f64_le","m"], ["sample_xyz","sample_xyz_f64_le","m"],
    ["sample_cells","sample_tet4_u32_le","1"], ["conductivity","cell_f64_le","S/m"],
    ["v_raw","node_f64_le","V"], ["v_per_a","node_f64_le","V/A"],
    ["j_center_raw","cell_xyz_f64_le","A/m^2"], ["j_center_per_a","cell_xyz_f64_le","1/m^2"],
    ["j_local_raw","cell_local4_xyz_f64_le","A/m^2"], ["j_local_per_a","cell_local4_xyz_f64_le","1/m^2"],
    ["h_raw","sample_xyz_f64_le","A/m"], ["h_per_a","sample_xyz_f64_le","1/m"], ["cells","closed_loop_cell280_le","SI"],
    ["faces","face_u64x3_f64_le","A"], ["weak","paired_u64x2_f64x2_le","A"],
    ["prepared_preimage","canonical_named_fields_be_bits.v2","1"], ["charge_preimage","canonical_named_fields_be_bits.v2","1"],
    ["source_preimage","canonical_named_fields_be_bits.v2","1"], ["certificate","canonical_balance_certificate.v1","1"],
    ["authoring_receipt","utf8_json_input.v1","1"], ["direct_evidence","fem_direct_oersted_evidence.v2","SI"],
  ];
  const descriptors = await Promise.all(shapes.map(async ([kind, layout, unit]) => {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", payloads[kind]));
    return [kind, { path: `antenna/field_solutions/inspection/${kind}.bin`, layout, unit, byte_length: payloads[kind].byteLength,
      sha256: Array.from(hash, byte => byte.toString(16).padStart(2,"0")).join("") }] as const;
  }));
  const pin = `sha256:${"a".repeat(64)}`;
  const source = { source_current_a: -2, source_absolute_flux_a: 2, potential_jump_v: 0.25, measured_potential_jump_v: 0.25,
    gauge_mean_v: 0, charge_relative_residual: 0, max_paired_weak_flux_mismatch_a: 0, terminal_observation_currents: {},
    prepared_execution_digest: "a".repeat(64), accepted_charge_field_digest: "a".repeat(64),
    accepted_source_state_digest: "a".repeat(64), current_balance_certificate_digest: "a".repeat(64), view_identity_digest: "a".repeat(64) };
  const manifest = { schema_version: "antenna_field_solution.v2", status: "inspection_only", validation_scope: "full_cold_bundle",
    qualification: "NOT VERIFIED", field_scope: "full_closed_loop.inspection_only.v2", content_digest: pin,
    source_object_id: "antenna", current_transport_id: "transport", stage_id: "solve", port_mode_id: "port", solution_id: "inspection",
    requested_intent: { fixture_only: true }, resolved_execution: { fixture_only: true }, source,
    sample_carrier: { domain: { kind: "global" }, carrier_kind: "mesh_nodes", location: "node", topology_digest: pin },
    vertex_count: 4, cell_count: 1, target_count: 4, sample_cell_count: 1, face_count: 4, weak_reaction_count: 1,
    signed_normalization_a: -2, scale_per_a: scale, payloads: Object.fromEntries(descriptors) };
  const inspection = { ...owner, schema_version: "antenna_closed_loop_stage_output.v2", resource_id: "fixture-closed-inspection",
    run_id: "fixture-run", runtime_stage_id: "runtime-solve-001", stage_revision: 1, record_content_digest: pin,
    stage_id: "solve", stage_kind: "antenna_field_solve", output_id: "inspection", port_mode_id: "port", source_object_id: "antenna",
    status: "inspection_only", resolved_action: "closed_loop_inspection", field_scope: manifest.field_scope, qualification: "NOT VERIFIED", manifest: null, closed_loop_manifest: manifest,
    outputs: [{ kind: "antenna_closed_loop_inspection", manifest_ref: "antenna/field_solutions/inspection/manifest.v2.json",
      payload_units: { V_electric: "V", J_charge: "A/m^2", H_ant: "A/m", H_ant_per_a: "1/m", positions: "m" }, reused_existing: false,
      content_digest: pin, source, inspection_ref: { content_digest: pin, output_id: "inspection", stage_id: "solve" } }] };
  const display = { ...owner, schema_version: "antenna_inspection_display.closed_loop.v2", resource_id: "fixture-closed-display",
    run_id: inspection.run_id, runtime_stage_id: inspection.runtime_stage_id, stage_revision: 1, record_content_digest: pin, content_digest: pin,
    normalization: "raw_authored_potential_jump", closed_loop_display: manifest,
    capabilities: { display: true, current_density: true, per_ampere_basis: false, source_fft: false, llg_drive: false } };
  return { inspection, display, payloads };
}
