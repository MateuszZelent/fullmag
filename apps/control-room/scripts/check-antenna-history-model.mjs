import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Interpret the real controller; fake transport only, no compiled tests, browser, or solver.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const relative = "apps/control-room/src/kernel/authoring/AuthoringHistoryController.ts";
const reference = process.argv[2];
if (reference) assert.match(reference, /^[a-f0-9]{40}$/, "Baseline must be a resolved full commit ID.");
const source = reference ? execFileSync("git", ["show", `${reference}:${relative}`], { cwd: root, encoding: "utf8" })
  : readFileSync(resolve(root, "src/kernel/authoring/AuthoringHistoryController.ts"), "utf8");
const context = vm.createContext({ console });
const controllerModule = new vm.SourceTextModule(stripTypeScriptTypes(source, { mode: "transform" }), { context });
const invalidations = [];
await controllerModule.link((specifier) => {
  let exports;
  if (specifier === "../api/apiPaths") exports = { MODEL_SCENE_PATH: "/v2/sessions/current/model/scene" };
  else if (specifier === "./authoringMutationInvalidation") exports = { invalidateAuthoringMutationDependents: (...args) => invalidations.push(args) };
  else if (specifier === "../resources/geometryLifecycleResources") exports = { publishCommittedSceneResource: () => undefined };
  else throw new Error(`Unexpected controller dependency: ${specifier}`);
  return new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
  }, { context });
});
await controllerModule.evaluate();
const { AuthoringHistoryController, sceneDocumentPayload } = controllerModule.namespace;
const collections = ["antenna_port_modes", "antenna_field_solve_stages", "antenna_target_projections", "solved_antenna_drives", "antenna_spectrum_requests"];
const before = { revision: 3, scene: { id: "placement-session" }, objects: [{ id: "immutable-antenna", name: "Antenna", transform: { translation: [0, 0, 0] } }],
  current_transports: [{ name: "transport", domain: [{ object_id: "immutable-antenna" }] }],
  ...Object.fromEntries(collections.map((name) => [name, [{ id: name, source_object_id: "immutable-antenna" }]])),
  runtime_only: "must not enter canonical authoring history" };
const after = structuredClone(before);
after.revision = 4;
after.objects[0].transform.translation[2] = 100e-9;
const json = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const payload = sceneDocumentPayload(before);
for (const name of collections) assert.deepEqual(json(payload[name]), before[name], `${name} must survive canonical scene snapshots`);
assert.equal(payload.runtime_only, undefined);
payload.antenna_port_modes[0].id = "detached-copy";
assert.equal(before.antenna_port_modes[0].id, "antenna_port_modes");
console.log("PASS all five antenna collections survive detached canonical snapshots");
let current = json(after);
const writes = [];
const api = { model: {
  scene: async () => json(current),
  commitTransaction: async (request, options) => {
    assert.equal(request.kind, "replace_scene");
    assert.equal(request.base_revision, current.revision);
    assert.equal(options.sessionScopeKey, "test-session-scope");
    writes.push(json(request));
    current = { ...json(request.scene), revision: current.revision + 1 };
    return { committed_scene: json(current), scene_revision: current.revision, transaction_kind: request.kind };
  },
} };
const history = new AuthoringHistoryController(api, { invalidate() {} });
history.record({ before, after, committedRevision: 4, label: "Place antenna" });
assert.equal((await history.undo("test-session-scope")).status, "completed");
assert.equal(current.objects[0].id, "immutable-antenna");
assert.deepEqual(current.objects[0].transform.translation, [0, 0, 0]);
for (const name of collections) assert.deepEqual(current[name], before[name]);
assert.equal((await history.redo("test-session-scope")).status, "completed");
assert.equal(current.objects[0].id, "immutable-antenna");
assert.deepEqual(current.objects[0].transform.translation, [0, 0, 100e-9]);
for (const name of collections) assert.deepEqual(current[name], after[name]);
assert.deepEqual(current.current_transports, before.current_transports);
assert.equal(writes.length, 2);
assert.deepEqual(invalidations.map(([, kind, revision]) => [kind, revision]),
  [5, 6].flatMap((revision) => ["geometry", "magnetization", "material", "interaction"].map((kind) => [kind, revision])));
console.log("PASS actual controller undo/redo preserve antenna identity and all collections");
current.revision++;
assert.equal((await history.undo("test-session-scope")).status, "failed");
assert.equal(writes.length, 2);
console.log("PASS external revision conflict sends no replacement");
console.log("Antenna history interpreted check passed; not a backend/browser qualification.");
