import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

// Interpret production owners; no unit bundles or backend are compiled.
const context = vm.createContext({ atob, btoa, Uint8Array, TextDecoder, TextEncoder, structuredClone,
  window: { __TAURI__: { core: { invoke: null } } } });
const intoRealm = vm.runInContext("(value) => JSON.parse(JSON.stringify(value))", context);
const load = (path, mode = "strip") => new vm.SourceTextModule(
  stripTypeScriptTypes(readFileSync(path, "utf8"), { mode }), { context });
const handoff = load("src/kernel/persistence/ProjectDocumentDevelopmentHandoff.ts");
const identity = load("src/kernel/resources/sessionResourceIdentity.ts");
const projection = load("src/kernel/authoring/sceneDocumentPayload.ts");
for (const helperModule of [handoff, identity, projection]) {
  await helperModule.link(() => { throw new Error("Unexpected pure helper import"); });
  await helperModule.evaluate();
}
const controllerSource = load("src/kernel/persistence/ProjectDocumentController.ts", "transform");
await controllerSource.link((specifier) => {
  assert.equal(specifier, "./ProjectDocumentDevelopmentHandoff");
  return handoff;
});
await controllerSource.evaluate();
const bindingSource = load("src/kernel/persistence/ProjectAuthoringSessionBinding.ts");
await bindingSource.link((specifier) => {
  if (specifier === "../authoring/sceneDocumentPayload") return projection;
  if (specifier === "../resources/sessionResourceIdentity") return identity;
  throw new Error(`Unexpected binding import ${specifier}`);
});
await bindingSource.evaluate();
const { ProjectDocumentController } = controllerSource.namespace;
const { createProjectAuthoringSessionBinding } = bindingSource.namespace;
const json = (value) => JSON.parse(JSON.stringify(value));
const resource = () => ({ archive_base64: "UEsDBA==", dirty: false, durability: "memory_only",
  migration: { can_write: true, migrated: false, preserved_paths: [], source_schema: "fullmag.project.v1",
    target_schema: "fullmag.project.v1", warnings: [] }, mode: { kind: "read_write" }, name: "Bound project",
  persisted_revision: 1, project_id: "project-1", revision: 1, schema_version: "fullmag.project.v1", source_hash: "sha256:old" });

async function fixture() {
  const state = { sessionId: "session-1", epoch: "epoch-1", failRead: false, failSync: false,
    switchDuringSync: false, resource: intoRealm(resource()), scene: { version: "scene.v2", revision: 12,
      scene_revision: 12, study: { execution_profile: { profile_id: "exec:latest", version: "2", defaults: { device: "cpu" } },
        execution_layers: [{ origin: { kind: "study", location: "scene.study" }, request: { resources: { cpu: { threads: 4 } } } }] } } };
  const writes = [], updates = [], scopedReads = [];
  const api = { resourceCacheScope: "api-1", sessions: {
    list: async () => ({ sessions: [{ session_id: state.sessionId, current: true }] }),
    current: { status: async () => ({ session: { session_id: state.sessionId, session_epoch: state.epoch, request_scope_epoch: "scope-1" } }) },
  }, model: { scene: async (options) => {
    scopedReads.push(options);
    if (state.failRead) throw new Error("scene unavailable");
    return state.scene;
  } }, persistence: { projects: {
    create: async () => state.resource, open: async () => state.resource,
    authoringUpdate: async (request) => {
      updates.push(json(request));
      if (state.failSync) throw new Error("unknown synchronization outcome");
      if (state.switchDuringSync) state.epoch = "epoch-2";
      return intoRealm({ ...state.resource, archive_base64: Buffer.from(JSON.stringify(request.scene_document)).toString("base64"),
        revision: state.resource.revision + 1, dirty: true });
    },
  } } };
  context.window.__TAURI__.core.invoke = async (command, args) => {
    assert.equal(command, "save_project_archive");
    writes.push(json(args.request));
    return { path: "C:\\fixture\\bound.fms", project_id: "project-1", revision: 2 };
  };
  const controller = new ProjectDocumentController(api);
  await controller.create("Bound project");
  const binding = createProjectAuthoringSessionBinding(api, "project-1", "session-1");
  controller.bindAuthoringSession(binding);
  return { controller, binding, state, writes, updates, scopedReads, api };
}

let f = await fixture();
await f.controller.save();
assert.equal(f.writes.length, 1);
assert.equal(f.updates.length, 1);
assert.equal(Object.hasOwn(f.updates[0].scene_document, "scene_revision"), false);
assert.deepEqual(JSON.parse(Buffer.from(f.writes[0].archive_base64, "base64").toString()), f.updates[0].scene_document);
assert.equal(f.updates[0].scene_document.study.execution_profile.version, "2");
assert.equal(f.updates[0].scene_document.study.execution_layers[0].request.resources.cpu.threads, 4);
assert.match(f.scopedReads[0].sessionScopeKey, /session=session-1/);
assert.equal(f.controller.getSnapshot().resource.dirty, false);

for (const fault of ["failRead", "failSync", "switchDuringSync"]) {
  f = await fixture();
  f.state[fault] = true;
  await assert.rejects(f.controller.save());
  assert.equal(f.writes.length, 0, `${fault} must not write older archive bytes`);
  assert.equal(f.controller.getSnapshot().resource.revision, 1);
}
f = await fixture();
await f.binding.readSceneDocument();
f.state.epoch = "epoch-2";
await assert.rejects(f.controller.save(), /workspace changed/);
assert.equal(f.writes.length, 0);
assert.equal(f.updates.length, 0);
f = await fixture();
f.state.sessionId = "unrelated";
await assert.rejects(f.controller.save(), /workspace changed/);
assert.equal(f.writes.length, 0);
f = await fixture();
await f.binding.readSceneDocument();
f.api.resourceCacheScope = "api-2";
await assert.rejects(f.controller.save(), /connection changed/);
assert.equal(f.writes.length, 0);
f = await fixture();
assert.throws(() => f.controller.bindAuthoringSession({ ...f.binding, projectId: "wrong-project" }), /different project/);
f = await fixture();
f.state.resource.mode = intoRealm({ kind: "read_only", reason: "future schema" });
f.state.resource.migration.can_write = false;
await assert.rejects(f.controller.save(), /future schema/);
assert.equal(f.writes.length, 0);
assert.equal(f.updates.length, 0);

f = await fixture();
let releaseScene;
f.api.model.scene = () => new Promise((resolve) => { releaseScene = resolve; });
const pendingSave = f.controller.save();
for (let attempt = 0; !releaseScene && attempt < 20; attempt++) await Promise.resolve();
assert.ok(releaseScene);
f.state.resource = intoRealm({ ...resource(), project_id: "project-2", name: "Another project" });
await f.controller.create("Another project");
releaseScene(f.state.scene);
await assert.rejects(pendingSave, /project changed/);
assert.equal(f.writes.length, 0);
assert.equal(f.updates.length, 0);
console.log(JSON.stringify({ state: "passed", canonical_profile_save: true, session_api_fences: true,
  no_stale_fallback_after_failure: true, fixture_only: true, unit_test_compilation: false }));
