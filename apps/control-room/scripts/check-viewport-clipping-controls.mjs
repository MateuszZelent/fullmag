import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
const ts = createRequire(new URL("../package.json", import.meta.url))("typescript");
const root = new URL("../src/", import.meta.url);
let server = false, version = 1, scope = "session:1", enabled = true;
let states = [], cursor = 0, response = { status: "completed" };
const calls = [];
const kernel = { commands: {
  subscribe: () => () => {}, getVersion: () => version, getSessionScopeKey: () => scope,
  isEnabled: () => enabled,
  execute: async (id, context, input) => { calls.push({ id, context, input }); return response; },
}, visualizationSync: { getSnapshot: () => ({ pendingPatch: { clip: { enabled: true } } }) } };
function synthetic(values) { return new vm.SyntheticModule(Object.keys(values), function () {
  for (const [key, value] of Object.entries(values)) this.setExport(key, value);
}); }
const jsx = (type, props) => ({ type, props });
const mocks = {
  react: synthetic({ useState: initial => {
    const index = cursor++; if (!(index in states)) states[index] = initial;
    return [states[index], value => { states[index] = value; }];
  }, useSyncExternalStore: (_subscribe, snapshot, fallback) => server ? fallback() : snapshot() }),
  "react/jsx-runtime": synthetic({ jsx, jsxs: jsx }),
  "@/kernel/KernelContext": synthetic({ useKernel: () => kernel }),
  "@/modules/ribbon/public": synthetic({ RIBBON_VISUALIZATION_PATCH_STATE_COMMAND: "patch-visualization", visualizationStateCommandInput: patch => patch }),
  "@/shared/ui/Slider": synthetic({ Slider: "slider" }),
  "@/shared/ui/Switch": synthetic({ Switch: "switch" }),
  "../primitives/FieldRow": synthetic({ FieldRow: "row" }),
  "../primitives/FormField": synthetic({ FormField: "select" }),
};
const cache = new Map();
function load(url) {
  if (!cache.has(url.href)) cache.set(url.href, new vm.SourceTextModule(ts.transpileModule(readFileSync(url, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX }, fileName: url.pathname,
  }).outputText, { identifier: url.href }));
  return cache.get(url.href);
}
function link(name, parent) {
  if (mocks[name]) return mocks[name];
  return load(name.startsWith("@/") ? new URL(`${name.slice(2)}.ts`, root) : new URL(`${name}.tsx`, parent.identifier));
}
const entry = load(new URL("modules/inspector/visualization/ViewportClippingControls.tsx", root));
await entry.link(link); await entry.evaluate();
const alias = load(new URL("modules/inspector/panels/antenna/AntennaClippingControls.tsx", root));
await alias.link(link); await alias.evaluate();
const clip = { enabled: true, axis: "y", position_percent: 37, flipped: true };
let resource = { data: { clip }, optimisticData: null };
const render = (ownerKey = "airbox") => { cursor = 0; return entry.namespace.ViewportClippingControls({ resource, ownerKey }); };
function flatten(node) {
  if (node == null || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap(flatten);
  return [node, ...flatten(node?.props?.children), ...flatten(node?.props?.value)];
}
const controls = type => flatten(render()).filter(node => node?.type === type);
let checks = 0;
async function check(name, run) { await run(); checks++; console.log(`PASS ${name}`); }
await check("antenna and Universe use the same clipping implementation", () => assert.equal(alias.namespace.AntennaClippingControls, entry.namespace.ViewportClippingControls));
await check("canonical resource remains usable without an optimistic overlay", () => {
  assert.equal(controls("select")[0].props.value, "y");
  assert.deepEqual(controls("switch").map(node => node.props.checked), [true, true]);
  assert.deepEqual(controls("slider")[0].props.value, [37]);
});
await check("server snapshot disables controls consistently", () => {
  server = true; for (const type of ["slider", "switch", "select"]) assert.ok(controls(type).every(node => node.props.disabled)); server = false;
});
await check("pending clipping does not disable unrelated controls", () => {
  for (const type of ["slider", "switch", "select"]) assert.ok(controls(type).every(node => !node.props.disabled));
});
await check("optimistic clipping takes precedence", () => {
  resource = { ...resource, optimisticData: { clip: { ...clip, axis: "x" } } };
  assert.equal(controls("select")[0].props.value, "x"); resource = { ...resource, optimisticData: null };
});
await check("dragging stays local until commit", async () => {
  const before = calls.length; controls("slider")[0].props.onValueChange([62]);
  assert.equal(calls.length, before); assert.deepEqual(controls("slider")[0].props.value, [62]);
  await controls("slider")[0].props.onValueCommit([62]);
  assert.deepEqual(calls.at(-1).input, { clip: { position_percent: 62, enabled: true } });
});
await check("owner change never reuses a slider draft", () => {
  controls("slider")[0].props.onValueChange([75]);
  assert.deepEqual(flatten(render("other-object")).find(node => node?.type === "slider").props.value, [37]); states = [];
});
await check("section actions only patch global visualization with current session context", async () => {
  const old = controls("select")[0]; scope = "session:2";
  await old.props.onChange({ target: { value: "z" } });
  await controls("switch")[0].props.onCheckedChange(false);
  await controls("switch")[1].props.onCheckedChange(false);
  for (const call of calls) assert.equal(call.id, "patch-visualization");
  assert.equal(calls.at(-1).context.sessionScopeKey, scope);
  assert.equal(calls.at(-1).context.sourceDetail, "viewport-global-section");
  assert.deepEqual(calls.at(-1).input, { clip: { flipped: false, enabled: true } });
});
await check("failure is visible only for its owner", async () => {
  response = { status: "failed", message: "Section unavailable" };
  await controls("switch")[0].props.onCheckedChange(true);
  assert.ok(flatten(render()).some(node => node?.props?.role === "alert" && node.props.children === "Section unavailable"));
  assert.equal(flatten(render("other-object")).some(node => node?.props?.role === "alert"), false);
});
await check("missing resource and unavailable command disable safely", () => {
  resource = { data: null }; assert.ok(controls("slider")[0].props.disabled);
  resource = { data: { clip } }; enabled = false; assert.ok(controls("slider")[0].props.disabled); enabled = true;
});
console.log(JSON.stringify({ status: "passed", checks, browser_qualification: false, unit_test_compilation: false }));
