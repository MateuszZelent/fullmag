import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const directory = new URL("../src/modules/inspector/panels/antenna/", import.meta.url);
const model = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(new URL("MicrostripGeometryEditorModel.ts", directory), "utf8")));
await model.link(() => { throw new Error("Unexpected circuit model dependency"); });
await model.evaluate();
const api = model.namespace;
const geometry = { geometry_kind: "CPWAntennaLayout", geometry_params: {
  length_m: 20e-6, thickness_m: 90e-9, conductivity_s_per_m: 3.5e7,
  stations: [0, 1].map(s => ({ s, signal_width_m: 200e-9, left_gap_m: 250e-9, right_gap_m: 250e-9,
    left_ground_width_m: 200e-9, right_ground_width_m: 200e-9 })),
  conductors: ["signal", "ground_left", "ground_right"].map(kind => ({ id: kind, kind })),
  transform: { rotation_matrix: [[0, -1, 0], [1, 0, 0], [0, 0, 1]], translation_m: [0, -10e-6, 75e-9] },
} };
const scene = { revision: 7, scene: { id: "GSG" }, objects: [{ id: "source", name: "GSG", role: "antenna", geometry }],
  current_transports: [{ name: "charge", kind: "current_transport", model: "ohmic_poisson", coupling: "one_way", domain: [{ object_id: "source" }],
    boundaries: [], gauge: "terminal_reference", materials: [{ region: { object_id: "source" }, material: { sigma_Spm: 3.5e7 } }] }],
  antenna_port_modes: [{ id: "port", source_object_id: "source", current_transport_id: "charge", schema_version: "antenna_port_mode.v2", normalization_current_a: 1,
    branches: ["signal", "ground_left", "ground_right"].map((id, i) => ({ id, inlet_terminal_ref: `${id}_in`, outlet_terminal_ref: `${id}_out`, signed_weight: i ? -0.5 : 1 })) }],
  antenna_field_solve_stages: [{ id: "field", source_object_id: "source", current_transport_id: "charge", port_mode_ids: ["port"],
    conservative_current_view_ref: "old", target_refs: [{ kind: "global" }], outputs: [{ id: "H", quantity: "H_ant_basis" }] }],
};
const draft = api.microstripCircuitDraft(geometry, scene, "source");
let checks = 0;
const check = (name, run) => { run(); checks++; console.log(`PASS ${name}`); };
check("open CPW does not infer source voltage or connection parameters", () => {
  assert.equal(draft.enabled, false); assert.equal(draft.potentialJumpV, ""); assert.equal(draft.sourceCutOffsetM, "");
  assert.equal(Object.keys(draft.parameters).length, 8); assert.ok(Object.values(draft.parameters).every(value => value === ""));
});
draft.enabled = true; draft.potentialJumpV = "0.001"; draft.sourceCutOffsetM = "-1e-6";
for (const end of ["inlet", "outlet"]) Object.assign(draft.parameters, { [`${end}_connection_length_m`]: "2e-6", [`${end}_crossbar_length_m`]: "200e-9",
  [`${end}_connection_part_id`]: end, [`${end}_connection_conductivity_s_per_m`]: end === "inlet" ? "35000000" : "20000000" });
const patch = () => api.buildMicrostripCircuitPatch(scene, "source", geometry, draft);
const before = JSON.stringify(scene), result = patch(), current = result.current_transports[0], port = result.antenna_port_modes[0];
check("one patch closes geometry, publishes five material assignments and clears terminal actuation", () => {
  assert.deepEqual(Object.keys(result).sort(), ["antenna_field_solve_stages", "antenna_port_modes", "current_transports", "objects"]);
  assert.equal(result.objects[0].geometry.geometry_params.loop.enabled, true);
  assert.equal(current.gauge, "zero_mean"); assert.equal(current.boundaries.length, 0);
  assert.deepEqual(Array.from(current.materials, row => row.region.region_id), ["signal", "ground_left", "ground_right", "inlet", "outlet"]);
  assert.deepEqual(Array.from(current.materials, row => row.material.sigma_Spm), [3.5e7, 3.5e7, 3.5e7, 3.5e7, 2e7]);
});
const cut = current.structured_current_closure.source_cuts[0];
check("x source cut lies in the central inlet neck and shares normalization identity", () => {
  assert.equal(cut.plane.axis, "x"); assert.equal(cut.plane.coordinate_frame, "object"); assert.equal(cut.plane.offset_m, -1e-6);
  assert.equal(cut.region.region_id, "inlet"); assert.equal(cut.drive.potential_jump_V, 0.001);
  assert.equal(port.schema_version, "antenna_port_mode.v3"); assert.equal(port.normalization.source_cut_ref, cut.source_cut_id);
  assert.equal(port.normalization.orientation, "minus_outward");
});
check("existing observation IDs and weights survive without prescribing return currents", () => {
  assert.equal(JSON.stringify(port.branches), JSON.stringify(scene.antenna_port_modes[0].branches));
  assert.equal(result.antenna_field_solve_stages[0].conservative_current_view_ref, undefined);
  assert.equal(result.antenna_field_solve_stages[0].conductor_mesh_policy, "authored_shared_domain");
});
const committed = { ...scene, ...result };
check("ACK/reopen preserves all physical GSG draft fields", () => assert.equal(api.microstripCircuitEqual(draft, api.microstripCircuitDraft(result.objects[0].geometry, committed, "source")), true));
check("newer crossbar edits remain dirty", () => assert.equal(api.microstripCircuitEqual(draft, { ...draft, parameters: { ...draft.parameters, inlet_crossbar_length_m: "300e-9" } }), false));
check("editing voltage retains the immutable source cut and original geometry", () => {
  const update = api.buildMicrostripCircuitPatch(committed, "source", result.objects[0].geometry, { ...draft, potentialJumpV: "-0.002" });
  const next = update.current_transports[0].structured_current_closure.source_cuts[0];
  assert.equal(next.source_cut_id, cut.source_cut_id); assert.equal(next.drive.potential_jump_V, -0.002);
  assert.equal(JSON.stringify(update.objects[0].geometry.geometry_params.stations), JSON.stringify(geometry.geometry_params.stations));
});
for (const offset of ["0", "-1.8e-6", "-2e-6", "1e-6"]) check(`cut offset ${offset} outside the open neck interval is rejected`, () => {
  assert.throws(() => api.buildMicrostripCircuitPatch(scene, "source", geometry, { ...draft, sourceCutOffsetM: offset }), /strictly inside/);
});
for (const length of ["0", "2e-6", "3e-6"]) check(`crossbar ${length} cannot remove the feed neck`, () => {
  assert.throws(() => api.buildMicrostripCircuitPatch(scene, "source", geometry, { ...draft, parameters: { ...draft.parameters, inlet_crossbar_length_m: length } }), /positive|neck/);
});
check("connection part IDs cannot alias a conductor", () => assert.throws(() => api.buildMicrostripCircuitPatch(scene, "source", geometry, { ...draft, parameters: { ...draft.parameters, inlet_connection_part_id: "ground_left" } }), /differ/));
check("a two-branch port cannot be silently promoted to GSG", () => {
  assert.throws(() => api.buildMicrostripCircuitPatch({ ...scene, antenna_port_modes: [{ ...scene.antenna_port_modes[0], branches: scene.antenna_port_modes[0].branches.slice(0, 2) }] }, "source", geometry, draft), /3 explicit/);
});
check("foreign source preparation requires explicit removal", () => {
  assert.throws(() => api.buildMicrostripCircuitPatch({ ...scene, current_transports: [{ ...scene.current_transports[0], external_lead_preparation: {} }] }, "source", geometry, draft), /Remove/);
});
check("whole-object material mismatch cannot be silently repaired", () => {
  assert.throws(() => api.buildMicrostripCircuitPatch({ ...scene, current_transports: [{ ...scene.current_transports[0], materials: [{ region: { object_id: "source" }, material: { sigma_Spm: 1 } }] }] }, "source", geometry, draft), /conductivity/);
});
check("authoring leaves the original resources untouched", () => assert.equal(JSON.stringify(scene), before));
const acknowledgement = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(new URL("AntennaGeometryAcknowledgement.ts", directory), "utf8")));
await acknowledgement.link(() => { throw new Error("Unexpected acknowledgement model dependency"); });
await acknowledgement.evaluate();
const acknowledged = { ...committed, revision: 8, scene_revision: 8 };
const ack = { scene_revision: 8, transaction_kind: "merge_patch", committed_scene: acknowledged };
const verifyAck = response => acknowledgement.namespace.committedAntennaGeometryScene(response, scene, "source", geometry, result);
check("matching GSG scene ACK is accepted without modifying resources", () => {
  const before = JSON.stringify(ack); assert.equal(verifyAck(ack), acknowledged); assert.equal(JSON.stringify(ack), before);
});
for (const [name, response] of [
  ["foreign model identity", { ...ack, committed_scene: { ...acknowledged, scene: { id: "foreign-model" } } }],
  ["old revision", { ...ack, scene_revision: 7, committed_scene: { ...acknowledged, revision: 7, scene_revision: 7 } }],
  ["non-integer revision", { ...ack, scene_revision: 8.5, committed_scene: { ...acknowledged, revision: 8.5, scene_revision: 8.5 } }],
  ["mixed revision", { ...ack, committed_scene: { ...acknowledged, revision: 9 } }],
  ["mixed scene_revision", { ...ack, committed_scene: { ...acknowledged, scene_revision: 9 } }],
  ["missing scene", { ...ack, committed_scene: null }],
]) check(`${name} is rejected before history/cache publication`, () => assert.throws(() => verifyAck(response), /matching revision/));
check("partial GSG normalization ACK is rejected", () => {
  const partial = structuredClone(ack);
  partial.committed_scene.antenna_port_modes[0].normalization = null;
  assert.throws(() => verifyAck(partial), /port normalization/);
});
if (process.argv.includes("--scene")) console.log(JSON.stringify(committed));
else console.log(JSON.stringify({ state: "passed", checks, scope: "interpreted production atomic authoring; no HTTP write, Solve or browser qualification" }));
