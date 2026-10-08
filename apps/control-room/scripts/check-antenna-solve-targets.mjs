import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

// Interpret the production validator without compiling test targets or running physics.
const path = new URL("../src/shared/domain/physics/antennaStageValidation.ts", import.meta.url);
const context = vm.createContext({});
const validatorModule = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(path, "utf8")), { context });
await validatorModule.link(() => { throw new Error("Unexpected runtime validator dependency"); });
await validatorModule.evaluate();
const validate = validatorModule.namespace.antennaStageValidationMessages;
const commandSource = readFileSync(new URL("../src/kernel/authoring/geometryLifecycleCommandContributions.ts", import.meta.url), "utf8");
const start = commandSource.indexOf("function defaultMicrostripFieldSolveStage(");
const end = commandSource.indexOf("\nfunction selectCommittedObject(", start);
assert.ok(start >= 0 && end > start, "Default factory source boundaries must be explicit");
vm.runInContext(stripTypeScriptTypes(commandSource.slice(start, end)), context);
const created = vm.runInContext('defaultMicrostripFieldSolveStage("immutable-antenna")', context);
assert.deepEqual(JSON.parse(JSON.stringify(created.target_refs)), [{ kind: "global" }]);
assert.deepEqual(JSON.parse(JSON.stringify(created.field_sampling_domain)), { kind: "global" });
assert.equal(created.source_object_id, "immutable-antenna");
assert.ok(!validate(created, null).some((message) => message.includes("target")));
const stage = { source_object_id: "conductor", current_transport_id: "current", port_mode_ids: ["port"],
  outputs: [{ id: "basis", quantity: "H_ant_basis" }], target_refs: [] };
const expected = "field solve requires at least one explicitly authored target";
assert.ok(validate(stage, null).includes(expected), "Empty targets must be diagnosed even before a scene loads");
assert.ok(validate(stage, { current_transports: [], antenna_port_modes: [] }).includes(expected),
  "Transport failures must not hide missing solve targets");
assert.ok(!validate({ ...stage, target_refs: [{ kind: "global" }] }, null).includes(expected),
  "An explicit global sampling target is valid; do not invent an object target");
assert.ok(!validate({ ...stage, target_refs: [{ kind: "object", object_id: "waveguide" }] }, null).includes(expected));
assert.deepEqual(stage.target_refs, [], "Validation must not mutate or fill the authored target list");
console.log("PASS real creation factory authors global target; empty targets diagnosed; explicit global/object retained; no mutation");
