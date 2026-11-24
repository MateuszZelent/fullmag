import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

// Interpret production code without compiling a unit-test bundle.
const source = path => readFileSync(new URL(path, import.meta.url), "utf8");
const controllerSource = stripTypeScriptTypes(source("../src/kernel/saved-results/SavedRunController.ts"));
const SavedRunController = vm.runInNewContext(controllerSource.replace("export class", "class").replace("export function", "function") + "\nSavedRunController;");
const resources = source("../src/kernel/resources/projectRunResources.ts");
const validatorSource = resources.slice(resources.indexOf("export function validateProjectRunEnvelope("), resources.indexOf("export function useProjectRunsResource("));
const validateProjectRunEnvelope = vm.runInNewContext(stripTypeScriptTypes(validatorSource).replace("export function", "function") + "\nvalidateProjectRunEnvelope;");
const helper = stripTypeScriptTypes(source("../src/kernel/saved-results/openSavedRun.ts"))
  .replace(/^import .*;$/gm, "").replace("export async function", "async function");
const effects = [];
const openSavedRun = vm.runInNewContext(helper + "\nopenSavedRun;", {
  validateProjectRunEnvelope, homeView: { close: () => effects.push("home-close") },
});
function fixture(getRun) {
  effects.length = 0;
  const controller = new SavedRunController();
  const transition = { assertCurrent() {}, release() { effects.push("release"); } };
  const kernel = {
    savedRun: controller,
    api: { resourceCacheScope: "api-a", persistence: { projects: { getRun: getRun ?? (async (project_id, run_id) => ({project_id, run_id})) } } },
    pendingForms: { prepareTransition: async () => transition },
    objectEditSession: { getSnapshot: () => ({dirty: false}) },
    savedResultsPlayback: { close: () => effects.push("playback-close") },
    visualization: { clearSavedFieldPresentation: () => effects.push("clear-field") },
    selection: { clear: () => effects.push("clear-selection") },
    layout: { setResultsSource: value => effects.push(value), setActiveTab: value => effects.push(value) },
  };
  return {kernel, controller, transition};
}
const input = {projectId: "project-a", runId: "run-a"};
let checks = 0;
{
  const f = fixture();
  assert.equal(f.controller.getServerSnapshot(), null);
  await openSavedRun(f.kernel, input);
  assert.equal(f.controller.getSnapshot().projectId, input.projectId);
  assert.equal(f.controller.getSnapshot().runId, input.runId);
  assert.equal(f.controller.getSnapshot().apiScope, "api-a");
  assert.ok(effects.includes("results") && effects.includes("home-close"));
  f.controller.close(); assert.equal(f.controller.getSnapshot(), null); checks++;
}
for (const [name, getRun] of [
  ["wrong owner", async () => ({project_id: "other", run_id: "run-a"})],
  ["missing run", async () => { throw new Error("not found"); }],
]) {
  const f = fixture(getRun);
  await assert.rejects(openSavedRun(f.kernel, input), undefined, name);
  assert.equal(f.controller.getSnapshot(), null);
  assert.deepEqual(effects, ["release"]); checks++;
}
for (const change of [
  f => { f.kernel.api.resourceCacheScope = "api-b"; },
  f => { f.controller.close(); },
  f => { f.transition.assertCurrent = () => { throw new Error("draft changed"); }; },
  f => { f.kernel.objectEditSession.getSnapshot = () => ({dirty: true}); },
]) {
  let resolve, entered;
  const reached = new Promise(done => { entered = done; });
  const f = fixture(() => new Promise(done => { resolve = done; entered(); }));
  const opening = openSavedRun(f.kernel, input);
  await reached;
  change(f); resolve({project_id: input.projectId, run_id: input.runId});
  await assert.rejects(opening);
  assert.equal(f.controller.getSnapshot(), null);
  assert.deepEqual(effects, ["release"]); checks++;
}
{
  const pending = [];
  let entered;
  let reached = new Promise(done => { entered = done; });
  const f = fixture((project_id, run_id) => new Promise(resolve => { pending.push(() => resolve({project_id, run_id})); entered(); }));
  const old = openSavedRun(f.kernel, input);
  await reached;
  reached = new Promise(done => { entered = done; });
  const fresh = openSavedRun(f.kernel, {...input, runId: "run-b"});
  await reached; pending[1](); await fresh;
  pending[0](); await assert.rejects(old);
  assert.equal(f.controller.getSnapshot().runId, "run-b"); checks++;
}
console.log(`saved run navigation: ${checks} behavioral checks passed; GET-only dependencies, no session or Solve API`);

const matches = vm.runInNewContext(controllerSource.replace("export class", "class").replace("export function", "function") + "\nsavedResultScopeMatches;");
assert.equal(matches({projectId: "p", runId: "r"}, {projectId: "p", runId: "other"}), false);
assert.equal(matches({projectId: "p", runId: "r"}, {projectId: "p", runId: "r"}), true);
assert.equal(matches({projectId: null, runId: null}, {projectId: "p", runId: "r"}), false);
console.log("saved result ownership: 3 behavioral checks passed");
