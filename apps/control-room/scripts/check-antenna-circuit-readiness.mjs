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
console.log(JSON.stringify({ state: "passed", checks, scope: "interpreted input validation; no runtime or scientific qualification" }));
