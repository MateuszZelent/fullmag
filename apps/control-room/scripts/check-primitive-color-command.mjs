import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import * as three from "three";

// Execute source modules directly; no unit-test target compilation or renderer.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const context = vm.createContext({ console });
const modules = new Map();
modules.set("three", new vm.SyntheticModule(Object.keys(three), function () {
  for (const [key, value] of Object.entries(three)) this.setExport(key, value);
}, { context }));
function source(path) {
  if (!modules.has(path)) modules.set(path, new vm.SourceTextModule(
    stripTypeScriptTypes(readFileSync(path, "utf8")), { context, identifier: path },
  ));
  return modules.get(path);
}
function link(specifier, owner) {
  if (modules.has(specifier)) return modules.get(specifier);
  const base = specifier.startsWith("@/")
    ? resolve(root, "src", specifier.slice(2))
    : resolve(dirname(owner.identifier), specifier);
  const path = [base, `${base}.ts`].find((candidate) => existsSync(candidate));
  assert.ok(path, `Unsupported source dependency: ${specifier}`);
  return source(path);
}
const entry = new vm.SourceTextModule(`
  export * from "@/kernel/visualization/visualizationCommandContributions";
  export * from "@/kernel/visualization/ObjectVisualizationController";
  export * from "@/modules/viewport-3d/layers/PrimitiveObjectLayerModel";
`, { context, identifier: resolve(root, "src", "regression.ts") });
await entry.link(link);
await entry.evaluate();
const { VISUALIZATION_TARGET_COMMANDS: commands, resolveTargetVisualization: resolveTarget,
  primitiveObjectSurfaceColor: renderColor,
  airboxVisualizationStatePatchFromTargetPatch: airboxPatch } = entry.namespace;
const primitiveCommand = commands.find((command) => command.id === "visualization.target.set-primitive-mono-color");
assert.ok(primitiveCommand, "Primitive color requires its own command, not a shader-color mutation");
let checks = 0;
for (const kind of ["object", "airbox"]) {
  const target = { kind, id: kind === "object" ? "antenna-stable-id" : "airbox" };
  const writes = [];
  const snapshot = { defaults: {}, overrides: {}, version: 0 };
  const commandContext = {
    input: "#123456", visualizationTarget: target,
    visualization: {
      getSnapshot: () => snapshot,
      patchViewportPreferences: (address, patch) => writes.push({ address, patch }),
    },
    api: { visualization: { patch: () => assert.fail("Primitive color must not write server state") } },
  };
  assert.equal(primitiveCommand.isEnabled(commandContext), true);
  assert.equal((await primitiveCommand.run(commandContext)).status, "completed");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].address, target);
  assert.equal(JSON.stringify(writes[0].patch), JSON.stringify({ primitiveMonoColor: "#123456" }));
  assert.equal((await primitiveCommand.run({ ...commandContext, input: 123 })).status, "failed");
  assert.equal(writes.length, 1);
  checks++;
}
const persistentAirbox = { visible: true, wireframeVisible: true, wireframeOpacityPercent: 42, vectorBudget: 17, vectorLengthScale: 2, wireframeColor: "#234567" };
const localAirbox = { primitiveMonoColor: "#123456", primitiveVisible: true, primitiveOpacityPercent: 50 };
const existingOverrides = [{ scope: "object", scope_id: "other-object", style: { surface_mono_color: "#abcdef" } }];
const mixedPatch = airboxPatch({ ...persistentAirbox, ...localAirbox }, existingOverrides);
assert.equal(JSON.stringify(airboxPatch(localAirbox, existingOverrides)), "{}");
assert.equal(JSON.stringify(mixedPatch), JSON.stringify(airboxPatch(persistentAirbox, existingOverrides)));
assert.equal(mixedPatch.layers.airbox.wireframe.opacity, 0.42);
assert.equal(mixedPatch.layers.airbox.vectors.density, 17);
assert.equal(mixedPatch.overrides.find((entry) => entry.scope === "airbox").style.vector_length_scale, 2);
assert.equal(mixedPatch.overrides[0].scope_id, "other-object");
checks++;
const shared = source(resolve(root, "src/kernel/visualization/primitiveSurfaceColor.ts"));
const { resolvePrimitiveSurfaceColor } = shared.namespace;
const settings = resolveTarget({ snapshot: { defaults: {}, overrides: {}, version: 0 }, target: { kind: "object", id: "antenna" } }).settings;
for (const [role, patch, expected, sourceKind, rendered] of [
  ["antenna", {}, "var(--fm-surface-antenna)", "antenna-theme", "gold"],
  ["magnet", {}, "var(--fm-surface-3)", "object-theme", "gray"],
  [undefined, {}, "var(--fm-surface-3)", "object-theme", "gray"],
  ["antenna", { primitiveMonoColor: "#123456" }, "#123456", "primitive", "#123456"],
  ["antenna", { surfaceColorSource: "solid", shaderMonoColor: "#abcdef", primitiveMonoColor: "#123456" }, "#abcdef", "solid-shader", "#abcdef"],
  ["antenna", { primitiveMonoColor: "var(--fm-accent)" }, "var(--fm-surface-antenna)", "antenna-theme", "gold"],
]) {
  const effective = resolvePrimitiveSurfaceColor(role, { ...settings, ...patch });
  assert.equal(effective.color, expected);
  assert.equal(effective.source, sourceKind);
  assert.equal(renderColor({ role }, { ...settings, ...patch }, { antenna: "gold", mesh: "gray" }), rendered);
  checks++;
}
console.log(`Primitive color source/command: ${checks} checks passed; browser lifecycle and WebGL NOT VERIFIED.`);
