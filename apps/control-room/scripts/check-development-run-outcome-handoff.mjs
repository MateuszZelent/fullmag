import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const context = vm.createContext({
  AbortController,
  Blob,
  Date,
  TextDecoder,
  TextEncoder,
  Uint8Array,
  URL,
  atob,
  btoa,
  clearTimeout,
  setTimeout,
  structuredClone,
  window: { __TAURI__: { core: { invoke: null } } },
});

const source = (path, mode = "transform") =>
  new vm.SourceTextModule(
    stripTypeScriptTypes(readFileSync(path, "utf8"), { mode }),
    { context },
  );

const handoffModule = source("src/kernel/persistence/ProjectDocumentDevelopmentHandoff.ts", "strip");
await handoffModule.link(() => { throw new Error("Unexpected handoff helper dependency"); });
await handoffModule.evaluate();

const controllerModule = source("src/kernel/persistence/ProjectDocumentController.ts");
await controllerModule.link((specifier) => {
  assert.equal(specifier, "./ProjectDocumentDevelopmentHandoff");
  return handoffModule;
});
await controllerModule.evaluate();

const runOutcomeModule = source("src/kernel/persistence/runOutcome.ts", "strip");
await runOutcomeModule.link(() => { throw new Error("Unexpected run outcome dependency"); });
await runOutcomeModule.evaluate();

let currentStatus = { data: null };
let hookIndex = 0;
let hookRefs = [];
let hookEffects = new Map();
let hookSubscriptions = new Map();
let pendingEffects = [];
let documentStoreChanged = false;

function resetHooks() {
  hookIndex = 0;
  hookRefs = [];
  hookEffects = new Map();
  for (const unsubscribe of hookSubscriptions.values()) unsubscribe();
  hookSubscriptions = new Map();
  pendingEffects = [];
  documentStoreChanged = false;
}

function useRefMock(initialValue) {
  const index = hookIndex++;
  if (hookRefs[index] === undefined) hookRefs[index] = { current: initialValue };
  return hookRefs[index];
}

function useEffectMock(effect, dependencies) {
  const index = hookIndex++;
  const previous = hookEffects.get(index);
  const changed = !previous || dependencies.some((value, offset) => !Object.is(value, previous[offset]));
  if (!changed) return;
  hookEffects.set(index, dependencies);
  pendingEffects.push(effect);
}

function useSyncExternalStoreMock(subscribe, getSnapshot) {
  const index = hookIndex++;
  if (!hookSubscriptions.has(index)) {
    hookSubscriptions.set(index, subscribe(() => { documentStoreChanged = true; }));
  }
  return getSnapshot();
}

const reactModule = new vm.SyntheticModule(
  ["useEffect", "useRef", "useSyncExternalStore"],
  function () {
    this.setExport("useEffect", useEffectMock);
    this.setExport("useRef", useRefMock);
    this.setExport("useSyncExternalStore", useSyncExternalStoreMock);
  },
  { context },
);
const statusModule = new vm.SyntheticModule(
  ["useSessionStatusSelector"],
  function () {
    this.setExport("useSessionStatusSelector", (selector) => selector(currentStatus));
  },
  { context },
);
const viewportModule = new vm.SyntheticModule(
  ["captureRegisteredViewport3DThumbnail"],
  function () {
    this.setExport("captureRegisteredViewport3DThumbnail", async () => null);
  },
  { context },
);

const connectorModule = source("src/kernel/persistence/RunOutcomeConnector.tsx");
await connectorModule.link((specifier) => {
  if (specifier === "react") return reactModule;
  if (specifier === "@/modules/viewport-3d/public") return viewportModule;
  if (specifier === "../resources/useSessionStatus") return statusModule;
  if (specifier === "./runOutcome") return runOutcomeModule;
  throw new Error(`Unexpected connector dependency: ${specifier}`);
});
await connectorModule.evaluate();

const { ProjectDocumentController } = controllerModule.namespace;
const { RunOutcomeConnector } = connectorModule.namespace;
const makeResource = vm.runInContext(`(overrides = {}) => ({
  archive_base64: "UEsDBA==",
  dirty: false,
  durability: "memory_only",
  migration: {
    can_write: true,
    migrated: false,
    preserved_paths: [],
    source_schema: "fullmag.project.v1",
    target_schema: "fullmag.project.v1",
    warnings: [],
  },
  mode: { kind: "read_write" },
  name: "Demo project",
  persisted_revision: 1,
  project_id: "project-1",
  revision: 1,
  schema_version: "fullmag.project.v1",
  source_hash: "sha256:demo",
  ...overrides,
})`, context);

const hostPath = "C:\\projects\\demo.fms";
const run = {
  run_id: "run-controller-1",
  started_at: "2026-10-04T10:00:00.000Z",
  status: "ready",
  finished_at: "2026-10-04T10:05:00.000Z",
  duration_seconds: 300,
};
const preview = { png_base64: "iVBORw0KGgo=", colouring: "hsl-sphere" };
let groups = 0;

function makeFixture(initialResource = makeResource()) {
  const hostCalls = [];
  const openCalls = [];
  const state = {
    currentResource: initialResource,
    nextOpenResource: null,
  };

  async function invoke(command, args = {}) {
    hostCalls.push({ command, args });
    if (command === "save_project_archive") {
      const revision = state.currentResource.revision;
      state.currentResource = makeResource({
        ...state.currentResource,
        dirty: false,
        persisted_revision: revision,
        revision,
      });
      return { path: hostPath, project_id: state.currentResource.project_id, revision };
    }
    if (command === "project_record_outcome") {
      const revision = state.currentResource.revision + 1;
      state.nextOpenResource = makeResource({
        ...state.currentResource,
        archive_base64: "UEsDBAQ=",
        dirty: false,
        persisted_revision: revision,
        revision,
      });
      return { archive_base64: "UEsDBAQ=", file_name: "demo.fms", path: hostPath };
    }
    throw new Error(`Unexpected host command: ${command}`);
  }
  context.window.__TAURI__.core.invoke = invoke;

  const api = {
    persistence: {
      projects: {
        create: async () => state.currentResource,
        open: async (request) => {
          openCalls.push(request);
          if (state.nextOpenResource) {
            state.currentResource = state.nextOpenResource;
            state.nextOpenResource = null;
            return state.currentResource;
          }
          return state.currentResource;
        },
        authoringUpdate: async () => state.currentResource,
      },
    },
  };
  const controller = new ProjectDocumentController(api);
  return { api, controller, hostCalls, openCalls, state };
}

async function openFixture(initialResource = makeResource()) {
  const fixture = makeFixture(initialResource);
  await fixture.controller.open({
    bytes: new Uint8Array([80, 75, 3, 4]),
    fileName: "demo.fms",
    hostPath,
  });
  return fixture;
}

function assertHandoffOutcomeBusy(operation) {
  assert.throws(operation, /run outcome is pending or being recorded/);
}

function lifecycleStatus(solverState, runId) {
  return {
    data: {
      domain: { discretization: "FDM" },
      lifecycle: { solver: solverState },
      run: {
        resolved_device: "CPU",
        run_id: runId,
        started_at: "2026-10-04T10:00:00.000Z",
      },
      session: { session_epoch: "1", session_id: "session-1" },
    },
  };
}

function renderConnector(kernel, sessionIdentity, paused, status) {
  currentStatus = status;
  hookIndex = 0;
  pendingEffects = [];
  RunOutcomeConnector({ kernel, sessionIdentity, paused });
  const effects = pendingEffects;
  for (const effect of effects) effect();
}

async function waitForHandoffIdle(controller) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      controller.captureDevelopmentHandoff();
      return;
    } catch (error) {
      if (!String(error?.message).includes("run outcome is pending or being recorded")) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the run outcome reservation to release.");
}

{
  const fixture = await openFixture();
  const payload = fixture.controller.captureDevelopmentHandoff();
  const release = fixture.controller.tryReserveRunOutcome();
  assert.equal(typeof release, "function");
  assertHandoffOutcomeBusy(() => fixture.controller.captureDevelopmentHandoff());
  assertHandoffOutcomeBusy(() => fixture.controller.beginDevelopmentHandoff());

  const fresh = makeFixture();
  const restoreRelease = fresh.controller.tryReserveRunOutcome();
  await assert.rejects(
    fresh.controller.restoreDevelopmentHandoff(payload),
    /run outcome is pending or being recorded/,
  );
  restoreRelease();
  await fresh.controller.restoreDevelopmentHandoff(payload);

  release();
  release();
  const guard = fixture.controller.beginDevelopmentHandoff();
  assert.equal(fixture.controller.tryReserveRunOutcome(), null);
  guard.assertCurrent();
  guard.release();
  groups += 1;
}

{
  const fixture = await openFixture(makeResource({
    dirty: true,
    persisted_revision: 1,
    revision: 2,
  }));
  assert.equal(await fixture.controller.recordRunOutcome(run, preview), "queued");
  assertHandoffOutcomeBusy(() => fixture.controller.captureDevelopmentHandoff({ carryUnsaved: true }));
  assertHandoffOutcomeBusy(() => fixture.controller.beginDevelopmentHandoff({ carryUnsaved: true }));
  assert.equal(fixture.hostCalls.length, 0);

  await fixture.controller.save();
  assert.deepEqual(fixture.hostCalls.map(({ command }) => command), [
    "save_project_archive",
    "project_record_outcome",
  ]);
  fixture.controller.captureDevelopmentHandoff();
  groups += 1;
}

{
  const fixture = await openFixture();
  const guard = fixture.controller.beginDevelopmentHandoff();
  assert.equal(await fixture.controller.recordRunOutcome(run, preview), "queued");
  assert.throws(() => guard.assertCurrent(), /run outcome is pending or being recorded/);
  guard.release();
  assertHandoffOutcomeBusy(() => fixture.controller.captureDevelopmentHandoff());
  await fixture.controller.save();
  assert.equal(fixture.hostCalls.filter(({ command }) => command === "project_record_outcome").length, 1);
  fixture.controller.captureDevelopmentHandoff();
  groups += 1;
}

{
  const fixture = await openFixture();
  const release = fixture.controller.tryReserveRunOutcome();
  assert.equal(await fixture.controller.recordRunOutcome(run, preview), "recorded");
  assertHandoffOutcomeBusy(() => fixture.controller.captureDevelopmentHandoff());
  release();
  release();
  fixture.controller.captureDevelopmentHandoff();
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.hostCalls[0])), {
    command: "project_record_outcome",
    args: {
      request: {
        path: hostPath,
        preview,
        run,
      },
    },
  });
  groups += 1;
}

{
  resetHooks();
  const fixture = await openFixture();
  let hostPaused = false;
  let kernel;
  kernel = {
    developmentWorkspace: {
      getSnapshot: () => ({ kernel, paused: hostPaused }),
    },
    projectDocument: fixture.controller,
  };
  const sessionIdentity = { sessionEpoch: "1", sessionId: "session-1" };

  renderConnector(kernel, sessionIdentity, false, lifecycleStatus("running", "run-1"));
  const guard = fixture.controller.beginDevelopmentHandoff();
  renderConnector(kernel, sessionIdentity, false, lifecycleStatus("completed", "run-1"));
  assert.equal(fixture.hostCalls.length, 0);
  guard.assertCurrent();
  guard.release();
  assert.equal(documentStoreChanged, true);

  renderConnector(kernel, sessionIdentity, false, lifecycleStatus("completed", "run-1"));
  assertHandoffOutcomeBusy(() => fixture.controller.captureDevelopmentHandoff());
  await waitForHandoffIdle(fixture.controller);
  assert.equal(fixture.hostCalls.filter(({ command }) => command === "project_record_outcome").length, 1);
  assert.equal(fixture.hostCalls.find(({ command }) => command === "project_record_outcome").args.request.run.run_id, "run-1");

  renderConnector(kernel, sessionIdentity, false, lifecycleStatus("running", "run-2"));
  hostPaused = true;
  renderConnector(kernel, sessionIdentity, true, lifecycleStatus("completed", "run-2"));
  fixture.controller.captureDevelopmentHandoff();
  hostPaused = false;
  renderConnector(kernel, sessionIdentity, false, lifecycleStatus("completed", "run-2"));
  assertHandoffOutcomeBusy(() => fixture.controller.captureDevelopmentHandoff());
  await waitForHandoffIdle(fixture.controller);
  assert.equal(fixture.hostCalls.filter(({ command }) => command === "project_record_outcome").length, 2);
  assert.equal(fixture.hostCalls.at(-1).args.request.run.run_id, "run-2");
  groups += 1;
}

console.log(JSON.stringify({
  check: "development-run-outcome-handoff",
  groups,
  passed: true,
  emitted_code_files: false,
  production_source_transform: "in_memory_parameter_property_support",
  react_execution: "hook_protocol_harness_not_browser",
  exercised: ["ProjectDocumentController", "ProjectDocumentDevelopmentHandoff", "RunOutcomeConnector"],
}));
