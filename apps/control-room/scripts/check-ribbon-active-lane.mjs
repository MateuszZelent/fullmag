import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Interpret production capability/ribbon selectors without compiling a test target.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const context = vm.createContext({});
const capability = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(resolve(root, "src/kernel/resources/useActiveLaneCapabilities.ts"), "utf8")), { context });
await capability.link(() => new vm.SyntheticModule(["useSessionStatusSelector"], function () {
  this.setExport("useSessionStatusSelector", () => { throw new Error("Unexpected hook call"); });
}, { context }));
await capability.evaluate();
context.resolveActiveLaneDiscretization = capability.namespace.resolveActiveLaneDiscretization;
context.resolveActiveLaneOperation = capability.namespace.resolveActiveLaneOperation;
context.SESSION_STATUS_RESOURCE_KEY = "status";
const commands = readFileSync(resolve(root, "src/kernel/authoring/geometryLifecycleCommandContributions.ts"), "utf8");
for (const name of ["FDM_MESH_COMMAND_NOT_APPLICABLE_REASON", "UNKNOWN_MESH_COMMAND_LANE_REASON"]) {
  const start = commands.indexOf(`export const ${name}`);
  const end = commands.indexOf("\n\n", start);
  vm.runInContext(commands.slice(start, end).replace("export ", ""), context);
}
for (const [path, name] of [
  ["src/modules/ribbon/ribbonContributions.tsx", "ribbonDiscretization"],
  ["src/modules/ribbon/ribbonCommands.ts", "asRecord"],
  ["src/modules/ribbon/ribbonCommands.ts", "ribbonInteractionDiscretization"],
  ["src/kernel/authoring/geometryLifecycleCommandContributions.ts", "resourceData"],
  ["src/kernel/authoring/geometryLifecycleCommandContributions.ts", "meshCommandLane"],
  ["src/kernel/authoring/geometryLifecycleCommandContributions.ts", "femMeshCommandDisabledReason"],
  ["src/modules/overlay/MeshBuildDialog.tsx", "resolveMeshBuildDialogLane"],
  ["src/modules/overlay/MeshBuildDialog.tsx", "meshBuildDialogRuntimeStatusEquals"],
]) {
  const text = readFileSync(resolve(root, path), "utf8");
  const start = text.indexOf(`function ${name}(`);
  const end = text.indexOf("\n}\n", start) + 2;
  assert.ok(start >= 0 && end > start, `Missing production selector ${name}`);
  vm.runInContext(stripTypeScriptTypes(text.slice(start, end)), context);
}
let checks = 0;
function check(name, status, expected) {
  assert.equal(context.ribbonDiscretization({ sessionStatus: status }), expected);
  assert.equal(context.ribbonInteractionDiscretization({ resourceData: { status: { data: status } } }), expected);
  assert.equal(context.meshCommandLane({ resourceData: { status } }), expected);
  assert.equal(context.resolveMeshBuildDialogLane(status?.capabilities?.active_lane ?? null), expected);
  checks++;
  console.log(`PASS ${name}`);
}
function status(lane, carrier) {
  return { domain: { discretization: carrier }, capabilities: { active_lane: {
    source: { kind: "planner" }, resolved: { discretization: lane }, operations: {},
  } } };
}
check("FEM bootstrap with empty FDM carrier", status("fem", "fdm"), "fem");
check("FDM lane with retained FEM carrier", status("fdm", "fem"), "fdm");
check("missing capability does not infer lane from carrier", { domain: { discretization: "fem" } }, "unknown");
check("unresolved resource", null, "unknown");
const unresolved = status("fem", "fem");
unresolved.capabilities.active_lane.resolved = null;
check("null resolved identity", unresolved, "unknown");
const unavailable = status("fem", "fem");
unavailable.capabilities.active_lane.source.kind = "unavailable";
check("unavailable planner snapshot", unavailable, "unknown");
check("unknown discretization fails closed", status("other", "fem"), "unknown");
const baseline = { ...status("fem", "fdm"), resources: { mesh_revision: 5, mesh_build_revision: 5 } };
assert.equal(context.meshBuildDialogRuntimeStatusEquals(baseline, structuredClone(baseline)), true);
assert.equal(context.meshBuildDialogRuntimeStatusEquals(baseline, { ...baseline, capabilities: status("fdm", "fdm").capabilities }), false);
const deferredBaseline = structuredClone(baseline);
deferredBaseline.capabilities.active_lane.operations.shared_mesh_build = { state: "deferred" };
assert.equal(context.meshBuildDialogRuntimeStatusEquals(baseline, deferredBaseline), false);
checks++;
console.log("PASS modal selector updates on lane/operation changes, not snapshot identity");
for (const state of ["supported", "deferred", "semantic_only", "unsupported", "stale"]) {
  const current = status("fem", "fdm");
  const snapshot = current.capabilities.active_lane;
  snapshot.operations.shared_mesh_build = { state, reason: `${state} mesh` };
  assert.equal(capability.namespace.resolveActiveLaneOperation(snapshot, "shared_mesh_build").enabled, state === "supported");
  assert.equal(context.femMeshCommandDisabledReason({ resourceData: { status: current } }), state === "supported" ? null : `${state} mesh`);
  checks++;
  console.log(`PASS mesh operation ${state}`);
}
console.log(`${checks} interpreted production checks passed`);
