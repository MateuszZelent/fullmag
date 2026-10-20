import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const src = new URL("../src/", import.meta.url);
async function pure(path) {
  const sourceModule = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(new URL(path, src), "utf8")));
  await sourceModule.link(() => { throw new Error("Unexpected pure dependency"); }); await sourceModule.evaluate(); return sourceModule;
}
const source = await pure("shared/domain/study/studyStageSource.ts");
const capability = await pure("shared/domain/study/antennaFieldSolveCapability.ts");
const command = readFileSync(new URL("kernel/runtime/antennaFieldSolveStudyCommand.ts", src), "utf8");
const first = command.indexOf("/** Build a reference instruction"), last = command.indexOf("export const addAntennaFieldSolveStudyCommand");
assert.ok(first >= 0 && last > first);
const code = 'import { readStudyStageSource } from "source"; import { antennaFieldSolveDefinitionPortError } from "capability";\n' + command.slice(first, last);
const sourceModule = new vm.SourceTextModule(stripTypeScriptTypes(code));
await sourceModule.link(name => { assert.ok(["source", "capability"].includes(name)); return name === "source" ? source : capability; }); await sourceModule.evaluate();
const resolve = sourceModule.namespace.antennaFieldSolveStudyReference;
const target = { objectId: "source", stageId: "definition", portModeId: "port" };
const action = { kind: "antenna_field_solve", entrypoint_kind: "flat_antenna_field_solve", stage_id: "definition", port_mode_ids: ["port"] };
const scene = { objects: [{ id: "source" }], antenna_field_solve_stages: [{ id: "definition", source_object_id: "source", current_transport_id: "charge", port_mode_ids: ["port"] }], antenna_port_modes: [{ id: "port", source_object_id: "source", current_transport_id: "charge" }], study: { stages: [] } };
let checks = 0;
const check = (name, run) => { run(); checks++; console.log(`PASS ${name}`); };
check("missing reference remains an authoring action", () => assert.equal(resolve(scene, target).state, "missing"));
check("flat reference uses definition ID and actual list index", () => {
  const result = resolve({ ...scene, study: { stages: [{ kind: "run", stage_id: "unrelated" }, action] } }, target);
  assert.equal(JSON.stringify(result), JSON.stringify({ state: "present", queueId: "definition", index: 1, enabled: true }));
});
const node = { id: "queue-id", node_kind: "primitive", stage_kind: "antenna_field_solve", enabled: true, payload: action };
const pipeline = { version: "study_pipeline.v1", nodes: [{ id: "group", node_kind: "group", enabled: false, children: [node] }] };
check("nested disabled pipeline retains queue identity and effective enabled state", () => {
  const result = resolve({ ...scene, study: { stages: [action], study_pipeline: pipeline } }, target);
  assert.equal(JSON.stringify(result), JSON.stringify({ state: "present", queueId: "queue-id", index: 0, enabled: false }));
});
check("pipeline ignores a dormant flat reference", () => assert.equal(resolve({ ...scene, study: { stages: [action], study_pipeline: { nodes: [] } } }, target).state, "missing"));
check("duplicate references cannot choose an arbitrary execution", () => assert.equal(resolve({ ...scene, study: { stages: [action, action] } }, target).state, "invalid"));
check("conflicting selected port cannot navigate or append", () => assert.equal(resolve({ ...scene, study: { stages: [{ ...action, port_mode_ids: ["other"] }] } }, target).state, "invalid"));
check("malformed pipeline does not fall back to flat stages", () => assert.equal(resolve({ ...scene, study: { stages: [action], study_pipeline: { version: "unknown", nodes: [] } } }, target).state, "invalid"));
check("missing source is rejected before adding", () => assert.equal(resolve({ ...scene, objects: [] }, target).state, "invalid"));
check("reference resolution never mutates the authored scene", () => { const before = JSON.stringify(scene); resolve(scene, target); assert.equal(JSON.stringify(scene), before); });
console.log(JSON.stringify({ state: "passed", checks, scope: "interpreted production planning and navigation; no execution" }));
