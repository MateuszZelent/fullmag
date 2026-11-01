import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

// Execute the actual production validators without compiling test sources.
const directory = new URL("../src/shared/domain/physics/", import.meta.url);
const ports = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(new URL("antennaPortValidation.ts", directory), "utf8")));
await ports.link(() => { throw new Error("Unexpected port-validator dependency"); });
await ports.evaluate();
const stages = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(new URL("antennaStageValidation.ts", directory), "utf8")));
await stages.link(name => { assert.equal(name, "./antennaPortValidation"); return ports; });
await stages.evaluate();
const terminalSources = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(new URL("../src/modules/inspector/panels/antenna/AntennaTerminalSourceModel.ts", import.meta.url), "utf8")));
await terminalSources.link(name => { assert.equal(name, "@/shared/domain/physics/antennaPortValidation"); return ports; });
await terminalSources.evaluate();
const sourceState = terminalSources.namespace.antennaTerminalSourceState;
const portMessages = ports.namespace.antennaPortValidationMessages;
const stageMessages = stages.namespace.antennaStageValidationMessages;
const inspectionMessages = stages.namespace.antennaInspectionValidationMessages;
const port = { id: "port", source_object_id: "source", current_transport_id: "charge", schema_version: "antenna_port_mode.v3", normalization_current_a: 1,
  normalization: { kind: "source_cut_rt0", source_cut_ref: "cut", orientation: "minus_outward" },
  branches: [{ id: "signal", inlet_terminal_ref: "signal_in", outlet_terminal_ref: "signal_out", signed_weight: 1 },
    { id: "return", inlet_terminal_ref: "return_in", outlet_terminal_ref: "return_out", signed_weight: -1 }] };
const transport = { name: "charge", kind: "current_transport", model: "ohmic_poisson", coupling: "one_way", domain: [{ object_id: "source" }], boundaries: [],
  structured_current_closure: { kind: "closed_geometry", schema_version: "structured_current_closure.v2", source_cuts: [{ source_cut_id: "cut", region: { object_id: "source", region_id: "inlet" } }] } };
const scene = { objects: [{ id: "source", role: "antenna" }], current_transports: [transport], antenna_port_modes: [port] };
const stage = { id: "solve", source_object_id: "source", current_transport_id: "charge", port_mode_ids: ["port"], target_refs: [{ kind: "global" }], outputs: [{ quantity: "H_ant_basis" }] };
let checks = 0;
const check = (name, run) => { run(); checks++; console.log(`PASS ${name}`); };
check("explicit authored v3 cut has valid authoring references", () => assert.equal(portMessages(port, scene).length, 0));
check("v3 observation weights do not prescribe the source current", () => assert.equal(portMessages({ ...port, branches: port.branches.map(branch => ({ ...branch, signed_weight: 0 })) }, scene).length, 0));
check("foreign source cut is rejected", () => assert.match(portMessages({ ...port, normalization: { ...port.normalization, source_cut_ref: "foreign" } }, scene).join(), /exact single/));
check("wrong normalization orientation is rejected", () => assert.match(portMessages({ ...port, normalization: { ...port.normalization, orientation: "positive" } }, scene).join(), /minus_outward/));
check("v2 cannot silently use v3 source-cut normalization", () => assert.match(portMessages({ ...port, schema_version: "antenna_port_mode.v2" }, scene).join(), /explicit port v3/));
check("simultaneous authored and prepared sources are rejected", () => assert.match(portMessages(port, { ...scene, current_transports: [{ ...transport, conservative_current_source: {} }] }).join(), /cannot combine/));
check("source outside transport domain is rejected", () => assert.match(portMessages(port, { ...scene, current_transports: [{ ...transport, domain: [{ object_id: "other" }] }] }).join(), /outside/));
check("valid authoring stage does not require a legacy current view", () => assert.equal(stageMessages(stage, scene).length, 0));
check("stage propagates a mismatched source-cut diagnostic", () => assert.match(stageMessages(stage, { ...scene, antenna_port_modes: [{ ...port, normalization: { ...port.normalization, source_cut_ref: "foreign" } }] }).join(), /exact single/));
check("stage requires explicit sampling targets", () => assert.match(stageMessages({ ...stage, target_refs: [] }, scene).join(), /explicitly authored target/));
check("closed-circuit input validity never certifies execution or science", () => {
  const messages = inspectionMessages(stage, scene);
  assert.equal(messages.length, 1); assert.match(messages[0], /NOT VERIFIED.*execution validation/);
});
check("stale legacy bindings remain explicit inspection conflicts", () => assert.match(inspectionMessages({ ...stage, conservative_current_view_ref: "old" }, scene).join(), /conflicts with legacy/));
function preparedScene(parts) {
  const value = structuredClone(scene), port = value.antenna_port_modes[0], transport = value.current_transports[0];
  port.branches = parts.map(id => ({ id, inlet_terminal_ref: `${id}_in`, outlet_terminal_ref: `${id}_out`, signed_weight: 0 }));
  transport.structured_current_closure = null;
  transport.conservative_current_source = { schema_version: "conservative_current_source.v2", kind: "closed_geometry_potential_jump", object_id: "source",
    closure: { kind: "closed_geometry", source_cuts: [{ id: "cut" }] },
    material_parts: [...parts, "inlet", "outlet"].map(part_id => ({ part_id })),
    terminal_observations: parts.flatMap(part_id => [
      { id: `${part_id}_in`, part_id, selector: "local_u_min" }, { id: `${part_id}_out`, part_id, selector: "local_u_max" },
    ]) };
  return value;
}
const messages = value => portMessages(value.antenna_port_modes[0], value);
check("prepared microstrip keeps its two branches and four material parts", () => assert.equal(messages(preparedScene(["signal", "return"])).length, 0));
check("prepared GSG accepts three branches and five material parts", () => assert.equal(messages(preparedScene(["signal", "ground_left", "ground_right"])).length, 0));
for (const parts of [["signal", "return"], ["signal", "ground_left", "ground_right"]]) check(`prepared ${parts.length}-branch source rejects mismatched material-part count`, () => {
  const value = preparedScene(parts); value.current_transports[0].conservative_current_source.material_parts.pop();
  assert.match(messages(value).join(), /microstrip or GSG/);
});
check("prepared branch identity must match its observed conductor part", () => {
  const value = preparedScene(["signal", "return"]); value.antenna_port_modes[0].branches[1].id = "renamed-return";
  assert.match(messages(value).join(), /same conductor part/);
});
function authoredScene(axis) {
  const value = structuredClone(scene), closure = value.current_transports[0].structured_current_closure;
  closure.closure_id = "loop";
  Object.assign(closure.source_cuts[0], { circuit_id: "circuit", plane: { coordinate_frame: "object", axis, offset_m: 0, normal: "positive_axis" },
    drive: { schema_version: "impressed_potential_jump.v1", kind: "impressed_potential_jump", drive_id: "voltage", potential_jump_V: 0.001 } });
  if (axis === "x") value.antenna_port_modes[0].branches = ["signal", "ground_left", "ground_right"].map(id => ({
    id, inlet_terminal_ref: `${id}_in`, outlet_terminal_ref: `${id}_out`, signed_weight: 0,
  }));
  return value;
}
function sourceMessages(value) {
  const state = sourceState(value, "source");
  assert.equal(state.mode, "explicit");
  return [...state.messages, ...Array.from(state.sources).flatMap(source => Array.from(source.messages))];
}
for (const axis of ["x", "z"]) check(`authored object-frame ${axis} cut matches the public Python contract`, () => assert.equal(sourceMessages(authoredScene(axis)).length, 0));
check("unsupported y cut remains rejected", () => assert.match(sourceMessages(authoredScene("y")).join(), /object-frame/));
for (const frame of [undefined, "world"]) check(`cut frame ${String(frame)} cannot silently become object frame`, () => {
  const value = authoredScene("x"); value.current_transports[0].structured_current_closure.source_cuts[0].plane.coordinate_frame = frame;
  assert.match(sourceMessages(value).join(), /object-frame/);
});
check("GSG readiness inspection does not alter the authored source", () => {
  const value = authoredScene("x"), before = JSON.stringify(value); sourceMessages(value); messages(value); assert.equal(JSON.stringify(value), before);
});
console.log(JSON.stringify({ state: "passed", checks, scope: "interpreted input validation; no runtime or scientific qualification" }));
