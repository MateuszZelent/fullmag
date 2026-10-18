import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

// Execute the production routing function without compiling unit-test targets.
const source = readFileSync(new URL("../src/modules/inspector/panels/ObjectVisualizationPanelModel.ts", import.meta.url), "utf8");
const start = source.indexOf("export function resolveObjectVisualizationTargetForLane(");
const end = source.indexOf("export function resolveObjectVisualizationResourceGates(", start);
assert.ok(start >= 0 && end > start, "Production target resolver boundaries must exist");
const route = vm.runInNewContext(`${stripTypeScriptTypes(source.slice(start, end)).replace("export function", "function")}\nresolveObjectVisualizationTargetForLane`, {
  targetForFdmNativeLayer: (id, label) => ({ id, label, kind: "fdm-native-layer" }),
});
const target = { id: "object:antenna", kind: "object", label: "Source" };
const selection = { kind: "object.antenna.visualization", objectId: "antenna", ref: { type: "scene-object", objectId: "antenna" } };
const layers = [{ layer_id: "magnetic-layer", magnet_name: "Magnet", object_id: "antenna" }];
let checks = 0;
function check(name, run) { run(); checks++; console.log(`PASS ${name}`); }
for (const lane of ["fdm", "fem"]) {
  check(`${lane}: antenna retains its object target even with a matching magnetic layer`, () => {
    assert.strictEqual(route({ lane, selection, selectionTarget: target, fdmNativeLayers: layers }), target);
  });
  for (const kind of ["fdm-domain", "fdm-native-layer", "region", "airbox"]) {
    check(`${lane}: antenna rejects an unrelated ${kind} target`, () => {
      assert.equal(route({ lane, selection, selectionTarget: { id: "other", kind } }), null);
    });
  }
  check(`${lane}: antenna without a resolved object stays unavailable`, () => assert.equal(route({ lane, selection, selectionTarget: null }), null));
}
check("Unresolved lane cannot activate antenna controls", () => assert.equal(route({ lane: "unresolved", selection, selectionTarget: target }), null));
check("Ordinary FDM object still resolves to its native magnetic layer", () => {
  assert.equal(route({ lane: "fdm", selection: { ...selection, kind: "object.visualization" }, selectionTarget: target, fdmNativeLayers: layers }).id, "magnetic-layer");
});
check("Unknown FDM semantic node does not gain visualization implicitly", () => {
  assert.equal(route({ lane: "fdm", selection: { ...selection, kind: "object.antenna.port" }, selectionTarget: target }), null);
});
console.log(JSON.stringify({ status: "passed", checks, unit_test_compilation: false, scope: "target identity routing; no field availability or runtime qualification" }));
