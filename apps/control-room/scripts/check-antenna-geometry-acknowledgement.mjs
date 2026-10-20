import assert from "node:assert/strict";
import { antennaGeometryAcknowledgementError as error } from "../src/modules/inspector/panels/antenna/AntennaGeometryAcknowledgement.ts";

// Interpret production TypeScript directly; no test compilation or JSX runtime.
const geometry = { geometry_kind: "MicrostripAntennaLayout", geometry_params: {
  length_m: 1e-6, stations: [{ s: 0, signal_width_m: 40e-9 }, { s: 1, signal_width_m: 20e-9 }],
  transform: { translation_m: [0, 0, 10e-9] }, loop: { enabled: true, inlet_connection_part_id: "inlet" },
} };
const patch = {
  objects: [{ id: "source", geometry, transform: { translation: [0, 0, 0] } }, { id: "other", name: "Unrelated" }],
  current_transports: [{ name: "charge", domain: [{ object_id: "source" }], gauge: "zero_mean", boundaries: [],
    materials: [{ region: { object_id: "source", region_id: "inlet" }, material: { sigma_Spm: 3e7 } }],
    structured_current_closure: { source_cuts: [{ source_cut_id: "cut", drive: { potential_jump_V: 0.25 } }] } }],
  antenna_port_modes: [{ id: "port", source_object_id: "source", current_transport_id: "charge", schema_version: "antenna_port_mode.v3",
    normalization: { kind: "source_cut_rt0", source_cut_ref: "cut", orientation: "minus_outward" }, branches: [{ id: "signal", signed_weight: 1 }] }],
  antenna_field_solve_stages: [{ id: "solve", source_object_id: "source", current_transport_id: "charge", target_refs: [{ kind: "global" }] }],
};
let checks = 0;
function check(name, run) { run(); checks++; console.log(`PASS ${name}`); }
const accept = (scene, circuit = patch) => error(scene, "source", geometry, circuit);
check("complete ACK accepts derived metadata and unrelated object changes", () => {
  const scene = structuredClone(patch); scene.objects[0].geometry.bounds_min = [0, 0, 0]; scene.objects[1].name = "New label";
  assert.equal(accept(scene), null);
});
for (const [name, mutate, message] of [
  ["missing owner", scene => scene.objects.shift(), /Geometry ACK/],
  ["duplicate owner", scene => scene.objects.push(scene.objects[0]), /Geometry ACK/],
  ["changed station", scene => scene.objects[0].geometry.geometry_params.stations[1].signal_width_m = 19e-9, /Geometry ACK/],
  ["changed placement", scene => scene.objects[0].geometry.geometry_params.transform.translation_m[2] = 11e-9, /Geometry ACK/],
  ["changed owner placement", scene => scene.objects[0].transform.translation[0] = 1e-6, /Geometry ACK/],
  ["changed bridge", scene => scene.objects[0].geometry.geometry_params.loop.inlet_connection_part_id = "other", /Geometry ACK/],
  ["missing current", scene => scene.current_transports = [], /materials, source cut/],
  ["duplicate current", scene => scene.current_transports.push(scene.current_transports[0]), /materials, source cut/],
  ["changed charge material", scene => scene.current_transports[0].materials[0].material.sigma_Spm = 5.8e7, /materials, source cut/],
  ["changed source identity", scene => scene.current_transports[0].structured_current_closure.source_cuts[0].source_cut_id = "foreign", /materials, source cut/],
  ["missing port normalization", scene => delete scene.antenna_port_modes[0].normalization, /port normalization/],
  ["changed observation", scene => scene.antenna_port_modes[0].branches[0].signed_weight = -1, /port normalization/],
  ["missing stage", scene => scene.antenna_field_solve_stages = [], /field stage/],
  ["stale stage view", scene => scene.antenna_field_solve_stages[0].conservative_current_view_ref = "old", /stale current-view/],
]) check(`rejects ${name}`, () => { const scene = structuredClone(patch); mutate(scene); assert.match(accept(scene), message); });
for (const field of ["external_lead_preparation", "conservative_current_source", "conservative_current_view", "closure_receipts"]) {
  check(`rejects stale ${field}`, () => { const scene = structuredClone(patch); scene.current_transports[0][field] = {}; assert.match(accept(scene), /stale preparation/); });
}
check("geometry-only ACK still rejects changed station values", () => {
  const scene = structuredClone(patch); scene.objects[0].geometry.geometry_params.stations.reverse();
  assert.match(error(scene, "source", geometry), /Geometry ACK/);
  assert.equal(error(patch, "source", geometry), null);
});
check("validation never mutates expected or acknowledged resources", () => {
  const before = JSON.stringify(patch); assert.equal(accept(patch), null); assert.equal(JSON.stringify(patch), before);
});
console.log(JSON.stringify({ state: "passed", checks, scope: "interpreted production acknowledgement validation; browser/backend not covered" }));
