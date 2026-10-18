import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
const root = new URL("../src/", import.meta.url);
const load = path => new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(new URL(path, root), "utf8")));
const plan = load("modules/viewport-3d/model/antennaFieldOverlayPlan.ts");
const shape = load("modules/viewport-3d/model/antennaFieldOverlayModel.ts");
// Evaluate the actual production ETag function without mounting resource hooks.
const resources = readFileSync(new URL("kernel/resources/antennaResources.ts", root), "utf8");
const start = resources.indexOf("export function antennaFieldPayloadEtag(");
const end = resources.indexOf("export function requireMatchingAntennaPayloadRevision(", start);
assert.ok(start >= 0 && end > start);
const etags = new vm.SourceTextModule(stripTypeScriptTypes(resources.slice(start, end)));
await shape.link(() => { throw new Error("Unexpected shape dependency"); });
await etags.link(() => { throw new Error("Unexpected ETag dependency"); });
await plan.link(name => name.endsWith("antennaResources") ? etags : name === "./antennaFieldOverlayModel" ? shape : Promise.reject(new Error(name)));
await plan.evaluate();
const resolve = plan.namespace.resolveAntennaBasisOverlayPlan;
const runtime = load("modules/inspector/panels/antenna/AntennaCompositionRuntime.ts");
await runtime.link(() => { throw new Error("Unexpected runtime dependency"); }); await runtime.evaluate();
const identity = (f, c) => runtime.namespace.antennaFieldSolutionIdentityStatus({ solutionId: "basis", stageId: "solve" }, f, c);
const intent = { kind: "basis", sessionId: "session", sessionEpoch: "epoch", requestScopeEpoch: "scope", sourceObjectId: "source", stageId: "solve", solutionId: "basis", contentDigest: "sha256:content", portModeId: "port", quantity: "magnetic_field_per_ampere" };
const descriptor = { scalar_type: "float64_le", layout: "sample_xyz_interleaved", unit: "m", value_count: 6, sha256: "a".repeat(64) };
const field = { status: "ready", data: { status: "ready", quantity: "H_ant_basis", session_id: "session", session_epoch: "epoch", request_scope_epoch: "scope", solution_id: "basis", stage_id: "solve", source_object_id: "source", content_digest: "sha256:content", asset_id: "asset", sample_positions: descriptor, bases: [{ port_mode_id: "port", magnetic_field_per_ampere: { ...descriptor, unit: "A/m/A" } }] } };
const catalog = { status: "ready", data: { status: "ready", session_id: "session", session_epoch: "epoch", request_scope_epoch: "scope", stage_id: "solve", outputs: [{ output_id: "basis", solution_ref: { output_id: "basis", stage_id: "solve", asset_id: "asset", content_digest: "sha256:content" } }] } };
let checks = 0;
function check(name, run) { run(); checks++; console.log(`PASS ${name}`); }
check("unique matching owner returns complete pinned data", () => {
  const result = resolve(intent, field, catalog); assert.equal(identity(field, catalog), "ready"); assert.equal(result.count, 2); assert.equal(result.values.unit, "A/m/A"); assert.match(result.fieldEtag, /port/);
});
for (const [name, mutate] of [
  ["nested output ID differs", (_f, c) => { c.data.outputs[0].solution_ref.output_id = "other"; }],
  ["duplicate output ID", (_f, c) => { c.data.outputs.push(structuredClone(c.data.outputs[0])); }],
  ["duplicate port ID", f => { f.data.bases.push(structuredClone(f.data.bases[0])); }],
  ["foreign producer stage", f => { f.data.stage_id = "other"; }],
  ["wrong asset", (_f, c) => { c.data.outputs[0].solution_ref.asset_id = "other"; }],
  ["wrong digest", (_f, c) => { c.data.outputs[0].solution_ref.content_digest = "other"; }],
  ["wrong scope", f => { f.data.request_scope_epoch = "other"; }],
  ["raw H is not a basis", f => { f.data.bases[0].magnetic_field_per_ampere.unit = "A/m"; }],
]) check(name, () => { const f = structuredClone(field), c = structuredClone(catalog); mutate(f, c); assert.equal(resolve(intent, f, c), null); if (name !== "raw H is not a basis") assert.equal(identity(f, c), "identity mismatch"); });
check("other unrelated output and port remain allowed", () => {
  const f = structuredClone(field), c = structuredClone(catalog); f.data.bases.push({ ...f.data.bases[0], port_mode_id: "other" }); c.data.outputs.push({ ...c.data.outputs[0], output_id: "other" }); assert.ok(resolve(intent, f, c));
});
console.log(JSON.stringify({ status: "passed", checks, unit_test_compilation: false }));
