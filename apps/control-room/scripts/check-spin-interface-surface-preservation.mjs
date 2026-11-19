import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const modelPath = process.argv[2] ?? fileURLToPath(new URL("../src/modules/inspector/panels/SpinInterfaceInspectorModel.ts", import.meta.url));
const source = readFileSync(modelPath, "utf8");
const javascript = stripTypeScriptTypes(source);
const { INTERFACE_TRACE_DIRECTIONS, bindInterfaceTraces, canBindInterfaceTraces, interfaceTraceSelection, interfaceDraft, buildInterface, reconcileInterfaceDraft } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
const input = {
  id: "nf", kind: "mixing_conductance",
  normal_side: { object_id: "normal", region_id: "n" },
  ferromagnet_side: { object_id: "ferro", region_id: "f" },
  normal_to_ferromagnet: [0, 0, 1],
  normal_surface: { object_id: "normal", surface_id: "z+", orientation: [0, 0, 1] },
  ferromagnet_surface: { object_id: "ferro", surface_id: "z-", orientation: [0, 0, -1] },
  g_up_Spm2: 1, g_down_Spm2: 2, g_r_Spm2: 3, g_i_Spm2: -4,
  absorption: "full_absorption", formula_version: "magnetoelectronic.fullmag.v2",
};
const baseline = interfaceDraft(input);
const edited = { ...baseline, gR: "7" };
const output = buildInterface(edited);
assert.deepEqual(output, { ...input, g_r_Spm2: 7 }, "Editing mixing conductance must preserve both explicit surface bindings");
const refreshed = interfaceDraft(structuredClone(input));
const reconciled = reconcileInterfaceDraft(refreshed, edited, baseline);
assert.deepEqual(reconciled.conflicts, [], "Equivalent refreshed bindings must not conflict by object identity");
assert.deepEqual(buildInterface(reconciled.draft), output);
const moved = structuredClone(input);
moved.normal_side.object_id = "normal-v2";
moved.normal_surface.object_id = "normal-v2";
const remote = reconcileInterfaceDraft(interfaceDraft(moved), edited, baseline);
assert.deepEqual(remote.conflicts, []);
assert.equal(buildInterface(remote.draft).normal_surface.object_id, "normal-v2", "Unedited surface bindings follow the latest owner snapshot");
const concurrent = reconcileInterfaceDraft(interfaceDraft({ ...input, g_r_Spm2: 9 }), edited, baseline);
assert.deepEqual(concurrent.conflicts, ["gR"], "Concurrent edits to the same parameter still conflict");
const withoutBindings = structuredClone(input);
delete withoutBindings.normal_surface;
delete withoutBindings.ferromagnet_surface;
assert.deepEqual(buildInterface(interfaceDraft(withoutBindings)), withoutBindings, "Legacy payloads must retain absence of optional surface bindings");
const oneBinding = structuredClone(input);
delete oneBinding.ferromagnet_surface;
assert.throws(() => buildInterface(interfaceDraft(oneBinding)), /both|together/i, "A partial authored binding pair must not be silently discarded");
assert.equal(interfaceDraft(null).absorption, "full_absorption", "New mixing drafts must use the public Python absorption default");

assert.equal(interfaceTraceSelection(interfaceDraft(withoutBindings)), "", "Opening a legacy interface must not select a default trace");
assert.equal(interfaceTraceSelection(interfaceDraft(oneBinding)), "stored", "Partial imported bindings remain visible");
assert.equal(interfaceTraceSelection(baseline), "z+");
const expectedDirections = [
  { surfaceId: "x+", normal: [1, 0, 0], oppositeId: "x-", opposite: [-1, 0, 0] },
  { surfaceId: "x-", normal: [-1, 0, 0], oppositeId: "x+", opposite: [1, 0, 0] },
  { surfaceId: "y+", normal: [0, 1, 0], oppositeId: "y-", opposite: [0, -1, 0] },
  { surfaceId: "y-", normal: [0, -1, 0], oppositeId: "y+", opposite: [0, 1, 0] },
  { surfaceId: "z+", normal: [0, 0, 1], oppositeId: "z-", opposite: [0, 0, -1] },
  { surfaceId: "z-", normal: [0, 0, -1], oppositeId: "z+", opposite: [0, 0, 1] },
];
assert.deepEqual(INTERFACE_TRACE_DIRECTIONS, expectedDirections, "All six labels and signed axes must match the independent canonical fixture");
for (const direction of expectedDirections) {
  const bound = { ...interfaceDraft(withoutBindings), ...bindInterfaceTraces(interfaceDraft(withoutBindings), direction.surfaceId) };
  const payload = buildInterface(bound);
  assert.equal(interfaceTraceSelection(bound), direction.surfaceId);
  assert.deepEqual(payload.normal_to_ferromagnet, direction.normal);
  assert.deepEqual(payload.normal_surface, { object_id: "normal", surface_id: direction.surfaceId, orientation: direction.normal });
  assert.deepEqual(payload.ferromagnet_surface, { object_id: "ferro", surface_id: direction.oppositeId, orientation: direction.opposite });
  assert.equal(payload.g_r_Spm2, input.g_r_Spm2);
}
const regionDraft = { ...interfaceDraft(withoutBindings), normalObject: "stack", normalRegion: "n", ferromagnetObject: "stack", ferromagnetRegion: "f" };
assert.equal(canBindInterfaceTraces(regionDraft), true, "Two regions of one object are supported");
const regionBound = { ...regionDraft, ...bindInterfaceTraces(regionDraft, "x-") };
const regionPayload = buildInterface(regionBound);
assert.deepEqual(regionPayload.normal_side, { object_id: "stack", region_id: "n" });
assert.deepEqual(regionPayload.ferromagnet_side, { object_id: "stack", region_id: "f" });
assert.equal(regionPayload.normal_surface.object_id, "stack");
assert.equal(regionPayload.ferromagnet_surface.object_id, "stack");
const changedRegion = { ...regionBound, normalRegion: "n2" };
assert.equal(interfaceTraceSelection(changedRegion), "x-", "An explicit region edit keeps its declared orientation under the canonical parent scope");
assert.deepEqual(buildInterface(changedRegion).normal_side, { object_id: "stack", region_id: "n2" });
assert.deepEqual(buildInterface(changedRegion).normal_surface, regionPayload.normal_surface);

assert.throws(() => bindInterfaceTraces({ ...regionDraft, ferromagnetRegion: "n" }, "x+"), /distinct/);
assert.throws(() => bindInterfaceTraces({ ...regionDraft, normalObject: "" }, "x+"), /distinct/);
assert.throws(() => bindInterfaceTraces(regionDraft, "nearest-face"), /canonical/);
const customInput = { ...input,
  normal_to_ferromagnet: [0.6, 0.8, 0],
  normal_surface: { object_id: "normal", surface_id: "imported:n", orientation: [0.6, 0.8, 0] },
  ferromagnet_surface: { object_id: "ferro", surface_id: "imported:f", orientation: [-0.6, -0.8, 0] },
};
const custom = interfaceDraft(customInput);
assert.equal(interfaceTraceSelection(custom), "stored");
assert.deepEqual(buildInterface({ ...custom, gR: "8" }), { ...customInput, g_r_Spm2: 8 }, "Unrelated edits preserve custom/noncardinal refs exactly");
const mismatch = { ...baseline, normalObject: "different" };
assert.equal(interfaceTraceSelection(mismatch), "stored");
assert.equal(buildInterface(mismatch).normal_surface.object_id, "normal", "Changing a scope does not silently rebind its stored trace");
const cleared = { ...custom, normalSurface: null, ferromagnetSurface: null };
assert.equal(cleared.normalToFerromagnet, custom.normalToFerromagnet, "Explicit clear does not invent a normal");
assert.equal(interfaceTraceSelection(cleared), "");
assert.equal(Object.hasOwn(buildInterface(cleared), "normal_surface"), false);
assert.equal(Object.hasOwn(buildInterface(cleared), "ferromagnet_surface"), false);
const partialCleared = { ...interfaceDraft(oneBinding), normalSurface: null, ferromagnetSurface: null };
assert.equal(Object.hasOwn(buildInterface(partialCleared), "normal_surface"), false);
const pendingEdit = { ...regionBound, gR: "11" };
const ack = reconcileInterfaceDraft(interfaceDraft(buildInterface(regionBound)), pendingEdit, regionBound);
assert.deepEqual(ack.conflicts, []);
assert.equal(ack.draft.gR, "11", "Local coefficient edit after submit survives ACK");
assert.deepEqual(buildInterface(ack.draft).normal_surface, regionPayload.normal_surface);
assert.deepEqual(buildInterface(ack.draft).ferromagnet_surface, regionPayload.ferromagnet_surface);
const refreshedPair = reconcileInterfaceDraft(interfaceDraft(regionPayload), pendingEdit, regionBound);
assert.deepEqual(refreshedPair.conflicts, []);
assert.equal(interfaceTraceSelection(refreshedPair.draft), "x-");

console.log(JSON.stringify({ status: "passed", check: "spin-interface-surface-preservation", axisDirectionsChecked: INTERFACE_TRACE_DIRECTIONS.length, modelPath }));
