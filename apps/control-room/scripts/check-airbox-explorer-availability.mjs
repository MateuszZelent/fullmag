import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const root = new URL("../src/", import.meta.url);
const cache = new Map();
function load(url) {
  const resolved = existsSync(url) ? url : new URL(url.href.replace(/\.ts$/, "/index.ts"));
  if (!cache.has(resolved.href)) {
    cache.set(resolved.href, new vm.SourceTextModule(
      stripTypeScriptTypes(readFileSync(resolved, "utf8"), { mode: "transform" }),
      { identifier: resolved.href },
    ));
  }
  return cache.get(resolved.href);
}
const entry = load(new URL("modules/explorer/builders/buildModelTree.ts", root));
await entry.link((name, parent) => load(name.startsWith("@/")
  ? new URL(`${name.slice(2)}.ts`, root)
  : new URL(`${name}.ts`, parent.identifier)));
await entry.evaluate();
const { buildModelTree, flattenExplorerNodes, findExplorerNodePath } = entry.namespace;
let checks = 0;
for (const [name, snapshot] of [
  ["unresolved", null],
  ["FEM without a mesh", { domainDiscretization: "fem" }],
  ["FDM without a grid", { domainDiscretization: "fdm" }],
  ["historical antenna with a separate sampling object", {
    domainDiscretization: "fem",
    objects: [{ id: "antenna", label: "Antenna", objectRole: "antenna" },
      { id: "sampling", label: "Sampling" }],
  }],
]) {
  const tree = buildModelTree(snapshot);
  const nodes = flattenExplorerNodes(tree);
  const visualizations = nodes.filter(node => node.kind === "airbox.visualization");
  assert.equal(visualizations.length, 1, name);
  assert.equal(visualizations[0].visualizationTargetId, "airbox", name);
  assert.equal(visualizations[0].status, "ready", name);
  assert.deepEqual(findExplorerNodePath(tree, visualizations[0].id),
    ["model:session", "model:universe", "model:airbox", "model:airbox:visualization"], name);
  assert.equal(nodes.some(node => node.kind === "airbox.mesh"), false, name);
  assert.equal(nodes.find(node => node.kind === "airbox.root").badge, "no mesh", name);
  checks++;
  console.log(`PASS ${name}: reachable visualization without fabricated mesh`);
}
for (const realized of [false, true]) {
  const nodes = flattenExplorerNodes(buildModelTree({
    domainDiscretization: "fem",
    airbox: { authoredPolicy: true, realizedCarrier: realized },
    mesh: { sourceSceneRevision: 3, manifestSourceSceneRevision: 3, meshRevision: 3 },
  }));
  assert.equal(nodes.filter(node => node.kind === "airbox.visualization").length, 1);
  assert.equal(nodes.filter(node => node.kind === "airbox.mesh").length, 1);
  assert.equal(nodes.find(node => node.kind === "airbox.root").badge, realized ? "realized" : "authored");
  checks++;
  console.log(`PASS existing FEM ${realized ? "realized" : "authored"} branch retained`);
}
console.log(JSON.stringify({ status: "passed", checks, browser_verified: false }));
