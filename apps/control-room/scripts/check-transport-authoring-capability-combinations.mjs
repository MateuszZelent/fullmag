import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

let gate;
if (process.argv[2] === "--legacy") {
  const source = readFileSync(process.argv[3], "utf8");
  const start = source.indexOf("function requestedCapability(");
  const end = source.indexOf("export function TransportAuthoringInspector", start);
  const javascript = stripTypeScriptTypes(`export ${source.slice(start, end)}`);
  const { requestedCapability } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
  gate = (family, resource, _scene, capabilities) => requestedCapability(family, family === "current_transport" ? resource : {
    mode: resource.mode, executionDevice: resource.requested_execution.device, executionPrecision: resource.requested_execution.precision,
  }, capabilities);
} else {
  const path = fileURLToPath(new URL("../src/shared/domain/physics/transportAuthoringCapabilities.ts", import.meta.url));
  const javascript = stripTypeScriptTypes(readFileSync(path, "utf8"));
  ({ getTransportAuthoringCapability: gate } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`));
}
const allowed = { status: "semantic_only", authoring_allowed: true, reason: "Semantic authoring only." };
const denied = { status: "unsupported", authoring_allowed: false, reason: "Blocked by active-session policy." };
const capabilities = { contract_version: "transport-authoring-capabilities.v1", m1_one_way_steady: allowed, m2_reciprocal: allowed, m3_transient: denied, gpu: denied, single_precision: denied, hybrid: denied };
const source = { name: "charge", model: "ohmic_poisson", coupling: "one_way" };
const spin = { id: "spin", current_source_id: "charge", mode: "steady", constitutive_version: "transport_constitutive.one_way.fullmag.v1", requested_execution: { discretization: "fdm", device: "cpu", precision: "double", execution_mode: "strict" } };
const scene = { current_transports: [source], spin_transports: [spin] };
const m2Source = { ...source, model: "magnetoresistive_poisson" };
assert.equal(gate("current_transport", m2Source, scene, { ...capabilities, m2_reciprocal: denied }).authoring_allowed, false, "Magnetoresistive source must require M2 even with one-way coupling");
assert.equal(gate("spin_transport", spin, scene, capabilities).authoring_allowed, true);
const m2 = { ...spin, constitutive_version: "transport_constitutive.reciprocal.fullmag.v1" };
const m2Scene = { current_transports: [{ ...m2Source, coupling: "bidirectional" }], spin_transports: [m2] };
assert.equal(gate("spin_transport", m2, m2Scene, capabilities).authoring_allowed, true);
assert.equal(gate("spin_transport", m2, m2Scene, { ...capabilities, m2_reciprocal: denied }).authoring_allowed, false);
for (const [patch, expected] of [
  [{ device: "gpu" }, ["m2_reciprocal", "gpu"]],
  [{ precision: "single" }, ["m2_reciprocal", "single_precision"]],
  [{ discretization: "hybrid" }, ["m2_reciprocal", "hybrid"]],
  [{ execution_mode: "hybrid" }, ["m2_reciprocal", "hybrid"]],
]) {
  const candidate = { ...m2, requested_execution: { ...m2.requested_execution, ...patch } };
  const result = gate("spin_transport", candidate, m2Scene, capabilities);
  assert.equal(result.authoring_allowed, false);
  assert.deepEqual(result.required, expected);
}
const combined = { ...m2, mode: "transient", requested_execution: { ...m2.requested_execution, device: "gpu", precision: "single" } };
assert.deepEqual(gate("spin_transport", combined, m2Scene, capabilities).required, ["m2_reciprocal", "m3_transient", "gpu", "single_precision"]);
assert.equal(gate("spin_transport", combined, m2Scene, capabilities).authoring_allowed, false);
const transient = gate("spin_transport", { ...spin, mode: "transient", requested_execution: { ...spin.requested_execution, device: "gpu", precision: "single" } }, scene, capabilities);
assert.deepEqual(transient.required, ["m3_transient", "gpu", "single_precision"]);
assert.equal(transient.authoring_allowed, false);
assert.equal(gate("spin_transport", spin, null, capabilities), null);
const auto = gate("spin_transport", { ...spin, requested_execution: { ...spin.requested_execution, discretization: "auto", device: "auto" } }, scene, capabilities);
assert.equal(auto.authoring_allowed, true);
assert.equal(auto.required.includes("hybrid"), false);
assert.equal(gate("spin_transport", spin, scene, null), null);
assert.equal(gate("spin_transport", null, scene, capabilities), null);
const blockedOwner = { ...spin, requested_execution: { ...spin.requested_execution, device: "gpu" } };
assert.equal(gate("current_transport", source, { ...scene, spin_transports: [blockedOwner] }, capabilities).authoring_allowed, false, "Editing a current source cannot bypass its dependent owner gate");
assert.equal(gate("current_transport", source, { ...scene, spin_transports: [{ ...blockedOwner, current_source_id: "unrelated" }] }, capabilities).authoring_allowed, true, "An unrelated blocked owner cannot lock this source");
assert.equal(gate("spin_transport", spin, { ...scene, current_transports: [m2Source] }, { ...capabilities, m2_reciprocal: denied }).authoring_allowed, false, "The referenced source model also participates in owner gating");
assert.equal(gate("spin_transport", spin, scene, capabilities).status, "semantic_only");
console.log(JSON.stringify({ status: "passed", check: "transport-authoring-capability-combinations", matrix: "M1/M2, full combinations, source/owner, auto/hybrid, missing capabilities", nativeRuntime: "NOT VERIFIED" }));