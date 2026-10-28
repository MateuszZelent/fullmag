import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");
const root = new URL("../src/", import.meta.url);
let version = 1, server = false, error = null, scope = "session:1", result = { status: "completed" };
let disabled = new Set();
const calls = [], enabledContexts = [];
const cameraRegistry = {};
const kernel = { cameraRegistry, commands: {
  subscribe: () => () => {}, getVersion: () => version, getSessionScopeKey: () => scope,
  isEnabled: (id, context) => { enabledContexts.push(context); return !disabled.has(id); },
  execute: async (id, context) => { calls.push({ id, context }); return result; },
} };
const cache = new Map();
function synthetic(names, values) {
  const syntheticModule = new vm.SyntheticModule(names, function () { for (const name of names) this.setExport(name, values[name]); });
  return syntheticModule;
}
const modules = {
  react: synthetic(["useState", "useSyncExternalStore"], {
    useState: () => [error, value => { error = value; }],
    useSyncExternalStore: (_subscribe, snapshot, serverSnapshot) => server ? serverSnapshot() : snapshot(),
  }),
  "react/jsx-runtime": synthetic(["jsx", "jsxs"], {
    jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }),
  }),
  "@/kernel/KernelContext": synthetic(["useKernel"], { useKernel: () => kernel }),
  "@/shared/ui/Button": synthetic(["Button"], { Button: "button" }),
};
function load(url) {
  if (!cache.has(url.href)) {
    const source = readFileSync(url, "utf8");
    const output = ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX,
    }, fileName: url.pathname }).outputText;
    cache.set(url.href, new vm.SourceTextModule(output, { identifier: url.href }));
  }
  return cache.get(url.href);
}
function link(name, parent) {
  if (modules[name]) return modules[name];
  if (name.startsWith("@/")) return load(new URL(`${name.slice(2)}.ts`, root));
  return load(new URL(`${name}.tsx`, parent.identifier));
}
const entry = load(new URL("modules/inspector/visualization/ViewportCameraControls.tsx", root));
await entry.link(link); await entry.evaluate();
const alias = load(new URL("modules/inspector/panels/antenna/AntennaCameraControls.tsx", root));
await alias.link(link); await alias.evaluate();
const render = () => entry.namespace.ViewportCameraControls();
function flatten(node) {
  if (node == null || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap(flatten);
  return [node, ...flatten(node?.props?.children)];
}
const buttons = node => flatten(node).filter(item => item?.type === "button");
let checks = 0;
async function check(name, run) { await run(); checks++; console.log(`PASS ${name}`); }
await check("legacy antenna export uses the exact shared camera component", () => {
  assert.equal(alias.namespace.AntennaCameraControls, entry.namespace.ViewportCameraControls);
});
await check("server snapshot keeps all camera actions disabled", () => {
  server = true; assert.equal(buttons(render()).length, 3);
  assert.ok(buttons(render()).every(button => button.props.disabled)); server = false;
});
await check("three registered camera actions are exposed", () => {
  assert.deepEqual(buttons(render()).map(button => button.props.children), ["Fit scene", "Reset camera", "Camera parameters"]);
  assert.ok(buttons(render()).every(button => !button.props.disabled));
});
await check("camera actions use the canonical registry and current session context", async () => {
  for (const button of buttons(render())) await button.props.onClick();
  assert.deepEqual(calls.map(call => call.id), ["viewport-3d.fit", "viewport-3d.reset-camera", "viewport-3d.open-camera-dialog"]);
  for (const { context } of calls) {
    assert.equal(context.source, "inspector"); assert.equal(context.sourceDetail, "viewport-camera");
    assert.equal(context.cameraRegistry, cameraRegistry); assert.equal(context.sessionScopeKey, scope);
    assert.equal(context.isCurrentSessionScope(), true);
  }
});
await check("one unavailable command leaves unrelated controls enabled", () => {
  disabled = new Set(["viewport-3d.reset-camera"]);
  assert.deepEqual(buttons(render()).map(button => button.props.disabled), [false, true, false]); disabled.clear();
});
await check("uninitialized registry does not expose active actions", () => {
  version = -1; assert.ok(buttons(render()).every(button => button.props.disabled)); version = 2;
});
await check("command failure is visible and a subsequent success clears it", async () => {
  result = { status: "failed", message: "Camera unavailable" }; await buttons(render())[0].props.onClick();
  assert.equal(flatten(render()).find(node => node?.props?.role === "alert")?.props.children, "Camera unavailable");
  result = { status: "completed" }; await buttons(render())[0].props.onClick();
  assert.equal(flatten(render()).some(node => node?.props?.role === "alert"), false);
});
await check("camera click resolves a fresh session scope rather than a render-time pin", async () => {
  const old = render(), prior = calls[0].context; scope = "session:2";
  assert.equal(prior.isCurrentSessionScope(), false); await buttons(old)[0].props.onClick();
  assert.equal(calls.at(-1).context.sessionScopeKey, scope); assert.equal(calls.at(-1).context.isCurrentSessionScope(), true);
});
await check("enablement also uses canonical camera context", () => {
  render(); assert.ok(enabledContexts.every(context => context.source === "inspector" && context.cameraRegistry === cameraRegistry));
});
await check("shared Object and Airbox panel is wired to the real camera component", () => {
  const source = readFileSync(new URL("modules/inspector/panels/ObjectVisualizationPanel.tsx", root), "utf8");
  assert.ok(source.includes("camera={<ViewportCameraControls />}"));
  assert.equal(source.includes("Camera framing follows the active viewport."), false);
});
console.log(JSON.stringify({ status: "passed", checks, unit_test_compilation: false, browser_qualification: false }));
