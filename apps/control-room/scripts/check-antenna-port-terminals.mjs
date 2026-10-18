import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const source = new URL("../src/shared/domain/physics/antennaPortValidation.ts", import.meta.url);
const entry = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(source, "utf8")));
await entry.link(() => { throw new Error("Unexpected runtime dependency"); });
await entry.evaluate();
const { antennaPortTerminalChoices: choices, antennaPortValidationMessages: validate } = entry.namespace;
const mode = { id: "port", schema_version: "antenna_port_mode.v2", source_object_id: "signal", current_transport_id: "charge", normalization_current_a: 1,
  branches: [{ id: "signal", inlet_terminal_ref: "si", outlet_terminal_ref: "so", signed_weight: 1 },
    { id: "return", inlet_terminal_ref: "ri", outlet_terminal_ref: "ro", signed_weight: -1 }] };
const ids = ["si", "so", "ri", "ro"];
const scene = { objects: [{ id: "signal", name: "Signal", role: "antenna" }, { id: "return", name: "Return", role: "conductor" }],
  current_transports: [{ name: "charge", kind: "current_transport", model: "ohmic_poisson", domain: [{ object_id: "signal" }, { object_id: "return" }],
    boundaries: ids.map((id, i) => ({ id, kind: "voltage_electrode", surfaces: [{ object_id: i < 2 ? "signal" : "return" }] })) }], antenna_port_modes: [mode] };
let checks = 0;
const check = (name, run) => { run(); checks++; console.log(`PASS ${name}`); };
const optionIds = (value, port = mode) => Array.from(choices(value, port), entry => entry.id);
check("boundary terminal identities and labels remain exact", () => {
  assert.deepEqual(optionIds(scene), ids);
  assert.equal(choices(scene, mode)[0].label, "si · Signal");
  assert.equal(validate(mode, scene).length, 0);
});
for (const [name, mutate] of [
  ["missing transport", s => { s.current_transports = []; }],
  ["ambiguous transport", s => { s.current_transports.push(structuredClone(s.current_transports[0])); }],
  ["unsupported model", s => { s.current_transports[0].model = "other"; }],
  ["malformed source never borrows boundaries", s => { s.current_transports[0].conservative_current_source = {}; }],
  ["malformed preparation never borrows boundaries", s => { s.current_transports[0].external_lead_preparation = {}; }],
]) check(name, () => { const copy = structuredClone(scene); mutate(copy); assert.deepEqual(optionIds(copy), []); assert.ok(validate(mode, copy).length); });
check("ambiguous IDs cannot be selected", () => {
  const copy = structuredClone(scene); copy.current_transports[0].boundaries.push(structuredClone(copy.current_transports[0].boundaries[0]));
  assert.deepEqual(optionIds(copy), ids.slice(1)); assert.ok(validate(mode, copy).some(message => message.includes("ambiguous")));
});
check("foreign-domain and ambiguous object terminals cannot be selected", () => {
  const copy = structuredClone(scene); copy.objects.push({ ...copy.objects[0] }); assert.deepEqual(optionIds(copy), ["ri", "ro"]);
  copy.objects.pop(); copy.current_transports[0].domain = [{ object_id: "return" }]; assert.deepEqual(optionIds(copy), ["ri", "ro"]);
});
for (const prepared of [false, true]) check(`${prepared ? "source" : "preparation"} takes precedence over boundary IDs`, () => {
  const copy = structuredClone(scene), transport = copy.current_transports[0];
  const entries = ids.map((id, i) => ({ [prepared ? "id" : "observation_id"]: `obs-${id}`, object_id: i < 2 ? "signal" : "return" }));
  transport[prepared ? "conservative_current_source" : "external_lead_preparation"] = {
    schema_version: prepared ? "conservative_current_source.v1" : "antenna_external_lead_preparation.v1",
    kind: prepared ? "external_lead_current" : "isolated_branch_straight_stubs",
    [prepared ? "terminal_observations" : "extensions"]: entries, drives: [{ id: "drive", port_mode_ref: "port" }],
  };
  assert.deepEqual(optionIds(copy), ids.map(id => `obs-${id}`));
});
check("prepared v3 uses observations and excludes duplicates", () => {
  const copy = structuredClone(scene), port = { ...mode, schema_version: "antenna_port_mode.v3" };
  copy.current_transports[0].conservative_current_source = { schema_version: "conservative_current_source.v2", kind: "closed_geometry_potential_jump", object_id: "signal",
    terminal_observations: [{ id: "min", part_id: "signal", selector: "local_u_min" }, { id: "max", part_id: "signal", selector: "local_u_max" }] };
  assert.deepEqual(optionIds(copy, port), ["min", "max"]);
  copy.current_transports[0].conservative_current_source.terminal_observations.push({ id: "min", part_id: "signal", selector: "local_u_min" });
  assert.deepEqual(optionIds(copy, port), ["max"]);
});
check("authored structured v3 never manufactures observations from boundaries", () => {
  const copy = structuredClone(scene), port = { ...mode, schema_version: "antenna_port_mode.v3" };
  copy.current_transports[0].structured_current_closure = { schema_version: "structured_current_closure.v2", kind: "closed_geometry" };
  assert.deepEqual(optionIds(copy, port), []);
});
check("choice derivation does not modify authoring resources", () => { const before = JSON.stringify(scene); choices(scene, mode); assert.equal(JSON.stringify(scene), before); });
console.log(JSON.stringify({ state: "passed", checks, scope: "interpreted production terminal inventory; not native qualification" }));
