import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { runMaterialAssignmentDraftCheck } from "./check-material-assignment-draft.mjs";

// Interpret the production service, controller, and Host. Owner and typed API
// protocols are controlled fixtures; this is not browser or native qualification.
const context = vm.createContext({ AggregateError, crypto: webcrypto, structuredClone });
const source = (path) => new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(path, "utf8")), { context });
const modules = new Map();

const pin = source("src/kernel/api/apiInstancePin.ts");
const controller = source("src/kernel/development/DevelopmentRestartController.ts");
const service = source("src/kernel/development/DevelopmentRestartActionService.ts");
const host = source("src/kernel/development/DevelopmentKernelHost.ts");
const buildService = source("src/kernel/development/DevelopmentBackendBuildActionService.ts");
const apiPaths = new vm.SourceTextModule(
  'export const PLATFORM_DEVELOPMENT_BACKEND_PATH = "/v2/platform/development-backend";',
  { context },
);
const resourceStore = new vm.SourceTextModule(
  "export const sharedResourceRuntimeStore = { beginPauseMatching() { return () => {}; } };",
  { context },
);
const clientScope = new vm.SourceTextModule(
  "export function resourceRuntimeKeyForClientScope(key) { return key; }",
  { context },
);
const ownerAdapter = new vm.SourceTextModule(
  "export function createDevelopmentKernelOwners(kernel, options) { return globalThis.createControlledOwners(kernel, options); }",
  { context },
);

for (const leaf of [pin, apiPaths, resourceStore, clientScope, ownerAdapter]) {
  await leaf.link(() => { throw new Error("Unexpected leaf dependency"); });
  await leaf.evaluate();
}
await controller.link((specifier) => {
  assert.equal(specifier, "../api/apiInstancePin");
  return pin;
});
await controller.evaluate();
await service.link((specifier) => {
  if (specifier === "./DevelopmentRestartController") return controller;
  if (specifier === "../api/apiInstancePin") return pin;
  throw new Error(`Unexpected service dependency: ${specifier}`);
});
await service.evaluate();
await buildService.link((specifier) => {
  assert.equal(specifier, "../api/apiInstancePin");
  return pin;
});
await buildService.evaluate();
modules.set("../api/apiInstancePin", pin);
modules.set("../api/apiPaths", apiPaths);
modules.set("../resources/ResourceRuntimeStore", resourceStore);
modules.set("../resources/resourceClientScope", clientScope);
modules.set("./DevelopmentKernelOwners", ownerAdapter);
modules.set("./DevelopmentRestartActionService", service);
modules.set("./DevelopmentBackendBuildActionService", buildService);
await host.link((specifier) => {
  assert.ok(modules.has(specifier), `Unexpected Host dependency: ${specifier}`);
  return modules.get(specifier);
});
await host.evaluate();

const { DevelopmentKernelHost } = host.namespace;
const { DevelopmentRestartCaptureError } = controller.namespace;
const OLD_PIN = "11111111-1111-4111-8111-111111111111";
const NEW_PIN = "22222222-2222-4222-8222-222222222222";
const READY_SHA = "a".repeat(64);
const CURRENT_SHA = "b".repeat(64);
let groups = 0;

function backend(pinId, {
  readySha = READY_SHA,
  currentSha = CURRENT_SHA,
  readyId = "ready-build",
  currentId = "current-build",
  sessionId = "old-session",
  sessionEpoch = 4,
  configured = true,
  state = "ready",
  restartAvailable = true,
  schemaVersion = "1.0.0",
  revision = 7,
  currentBuild = true,
} = {}) {
  return {
    schema_version: schemaVersion,
    configured,
    revision,
    state,
    restart_available: restartAvailable,
    reason: "restart_integration_pending",
    current_build: currentBuild ? { id: currentId, source_sha256: currentSha } : null,
    ready_build: { id: readyId, source_sha256: readySha },
    workspace_identity: {
      api_instance_id: pinId ?? "",
      session_id: sessionId,
      session_epoch: sessionEpoch,
    },
  };
}

function resource(data, overrides = {}) {
  return {
    data,
    error: null,
    refreshError: null,
    refetch() {},
    revision: null,
    status: "ready",
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeRig({ initialPin = OLD_PIN, replacementPin = NEW_PIN } = {}) {
  const apiStates = new Map();
  const calls = { status: 0, submit: [], read: [] };
  const owner = {
    captures: 0,
    releases: 0,
    hydrates: 0,
    apply: 0,
    reset: 0,
    captureFailure: false,
    untaggedCaptureFailure: false,
    hydrationFailure: false,
    releaseFailure: false,
    releaseFailureResumes: false,
  };

  function stateFor(pinId) {
    const key = pinId ?? null;
    if (!apiStates.has(key)) {
      const isInitial = pinId === initialPin;
      apiStates.set(key, {
        pin: pinId,
        backend: backend(pinId, isInitial
          ? {}
          : { readySha: READY_SHA, currentSha: READY_SHA, sessionId: "restored-session", sessionEpoch: 1 }),
        queue: [],
        submitMode: "pending",
        readMode: "ready",
        request: null,
        token: null,
        replacementPin,
      });
    }
    return apiStates.get(key);
  }

  function makeApi(apiState, clientScope) {
    return {
      resourceCacheScope: clientScope,
      getExpectedApiInstance: () => apiState.pin,
      getBaseUrl: () => "http://localhost:3197",
      developmentHandoffTransportPauseCount: 0,
      retired: false,
      beginDevelopmentHandoffTransportPause() {
        this.developmentHandoffTransportPauseCount += 1;
        return () => {
          if (!this.retired) this.developmentHandoffTransportPauseCount = Math.max(0, this.developmentHandoffTransportPauseCount - 1);
        };
      },
      retireDevelopmentHandoffTransport() {
        this.retired = true;
      },
      platform: {
        developmentBackend: async () => {
          calls.status += 1;
          const next = apiState.queue.shift();
          const value = typeof next === "function" ? await next() : next ?? apiState.backend;
          return structuredClone(value);
        },
        submitDevelopmentRestartRequest: async (request, token) => {
          calls.submit.push({ request: structuredClone(request), token });
          apiState.request = structuredClone(request);
          apiState.token = token;
          if (apiState.submitMode === "lost-ack") throw new Error("Lost submit acknowledgement");
          return restartResource(apiState, "pending");
        },
        developmentRestartRequest: async (requestId, token) => {
          calls.read.push({ requestId, token });
          assert.equal(requestId, apiState.request?.request_id);
          assert.equal(token, apiState.token);
          return restartResource(apiState, apiState.readMode);
        },
      },
    };
  }

  function factory(options, developmentWorkspace) {
    const pinId = Object.hasOwn(options, "expectedApiInstance") ? options.expectedApiInstance : initialPin;
    const apiState = stateFor(pinId);
    const commands = {
      beginDevelopmentHandoffPause() {
        let released = false;
        return () => { released = true; void released; };
      },
    };
    return {
      developmentWorkspace,
      commands,
      api: makeApi(apiState, `kernel-client-${apiStates.size}-${apiState.pin ?? "unpinned"}`),
      cameraRegistry: {
        getSnapshot: () => ({ dirty: false, syncInFlight: false, error: null }),
        stop() {},
      },
      visualizationSync: {
        getSnapshot: () => ({ error: null, pendingPatch: null, inflightPatch: null }),
        stop() {},
      },
      resources: { invalidateMatching() {} },
    };
  }

  context.createControlledOwners = (kernel, options) => ({
    capture: async () => {
      owner.captures += 1;
      if (owner.captureFailure) throw new DevelopmentRestartCaptureError(true);
      if (owner.untaggedCaptureFailure) throw new Error("Unclassified owner capture rejection.");
      const resume = options.pauseOldKernel();
      let released = false;
      try {
        const observation = await kernel.api.platform.developmentBackend();
        const identity = observation.workspace_identity;
        assert.ok(identity);
        return {
          sessionId: identity.session_id ?? null,
          sessionEpoch: identity.session_epoch,
          editor: { schema: "fullmag.development-editor-handoff.v1", state: "absent" },
          workspace: { schema: "fullmag.development-layout-handoff.v1", layout: "captured" },
          projectDocument: { schema: "fullmag.project-document-handoff.v1", document: "captured" },
          assertCurrent() {
            assert.equal(kernel.developmentWorkspace.getSnapshot().kernel, kernel);
            assert.equal(kernel.developmentWorkspace.getSnapshot().paused, true);
          },
          release() {
            if (released) return;
            released = true;
            owner.releases += 1;
            if (owner.releaseFailure) {
              if (owner.releaseFailureResumes) resume();
              throw new Error("Controlled owner guard release failure.");
            }
            resume();
          },
        };
      } catch (error) {
        if (!released) resume();
        throw error;
      }
    },
    hydrate: async (result) => {
      owner.hydrates += 1;
      if (owner.hydrationFailure) throw new Error("Controlled owner hydration failure.");
      const replacement = await options.prepareReplacement(result.new_api_instance_id);
      const replacementState = stateFor(result.new_api_instance_id);
      replacementState.backend = backend(result.new_api_instance_id, {
        readySha: READY_SHA,
        currentSha: READY_SHA,
        sessionId: result.session_id,
        sessionEpoch: result.session_epoch,
      });
      const restoredObservation = await replacement.api.platform.developmentBackend();
      assert.equal(restoredObservation.workspace_identity.api_instance_id, result.new_api_instance_id);
      assert.equal(restoredObservation.workspace_identity.session_id, result.session_id);
      assert.equal(restoredObservation.workspace_identity.session_epoch, result.session_epoch);
      const publication = options.publishReplacement(replacement);
      await Promise.resolve();
      kernel.developmentWorkspace.confirmMounted(replacement);
      await publication;
    },
  });

  function restartResource(apiState, state) {
    const request = apiState.request;
    assert.ok(request, "restart response requires the submitted request");
    const base = {
      schema: "fullmag.development-ui-restart-resource.v1",
      request_id: request.request_id,
      state,
    };
    if (state !== "ready") return base;
    return {
      ...base,
      new_api_instance_id: apiState.replacementPin,
      session_id: request.session_id === null ? null : "restored-session",
      session_epoch: request.session_id === null ? 0 : 1,
      editor: request.editor,
      workspace: request.workspace,
      project_document: request.project_document,
    };
  }

  const kernelHost = new DevelopmentKernelHost(factory);
  const kernel = kernelHost.getSnapshot().kernel;
  return {
    host: kernelHost,
    kernel,
    action: kernelHost.restartAction,
    calls,
    owner,
    apiStates,
    stateFor,
    backend: (pinId = initialPin) => stateFor(pinId).backend,
    setBackend: (pinId, value) => { stateFor(pinId).backend = value; },
    queueBackend: (pinId, value) => stateFor(pinId).queue.push(value),
    setSubmitMode: (pinId, value) => { stateFor(pinId).submitMode = value; },
    setReadMode: (pinId, value) => { stateFor(pinId).readMode = value; },
    result: (value, overrides) => resource(value, overrides),
  };
}

function readyResource(rig, value = rig.backend(), overrides) {
  return rig.result(value, overrides);
}

// Capability, resource freshness, API pin, and malformed resource schema gate before GET.
for (const [label, makeInvalid] of [
  ["restart unavailable", (value) => ({ ...value, restart_available: false })],
  ["not configured", (value) => ({ ...value, configured: false })],
  ["wrong backend state", (value) => ({ ...value, state: "building" })],
  ["wrong schema", (value) => ({ ...value, schema_version: "unknown" })],
  ["unsafe revision", (value) => ({ ...value, revision: Number.MAX_SAFE_INTEGER + 1 })],
  ["negative revision", (value) => ({ ...value, revision: -1 })],
  ["missing current build", (value) => ({ ...value, current_build: null })],
]) {
  const rig = makeRig();
  const result = readyResource(rig, makeInvalid(rig.backend()));
  assert.equal(rig.action.canStart(rig.kernel, result), false, label);
  await rig.action.start(rig.kernel, result);
  assert.equal(rig.calls.status, 0, label);
  assert.equal(rig.calls.submit.length, 0, label);
  groups += 1;
}
for (const override of [
  { status: "stale" },
  { status: "loading" },
  { error: new Error("controlled resource error") },
  { refreshError: new Error("controlled refresh error") },
]) {
  const rig = makeRig();
  const result = readyResource(rig, rig.backend(), override);
  assert.equal(rig.action.canStart(rig.kernel, result), false);
  await rig.action.start(rig.kernel, result);
  assert.equal(rig.calls.status, 0);
  assert.equal(rig.calls.submit.length, 0);
  groups += 1;
}
{
  const rig = makeRig({ initialPin: null });
  const result = readyResource(rig);
  assert.equal(rig.action.canStart(rig.kernel, result), false);
  await rig.action.start(rig.kernel, result);
  assert.equal(rig.calls.status, 0);
  assert.equal(rig.calls.submit.length, 0);
  groups += 1;
}

// A candidate or identity change on the service's fresh typed read cannot submit.
for (const fresh of [
  backend(OLD_PIN, { readySha: "c".repeat(64), currentSha: CURRENT_SHA }),
  backend(OLD_PIN, { readyId: "different-ready-id", currentSha: CURRENT_SHA }),
  backend(OLD_PIN, { sessionId: "changed-session", currentSha: CURRENT_SHA }),
  backend(OLD_PIN, { sessionEpoch: 5, currentSha: CURRENT_SHA }),
]) {
  const rig = makeRig();
  rig.queueBackend(OLD_PIN, fresh);
  await rig.action.start(rig.kernel, readyResource(rig));
  assert.equal(rig.calls.status, 1);
  assert.equal(rig.owner.captures, 0);
  assert.equal(rig.calls.submit.length, 0);
  assert.equal(rig.host.getSnapshot().paused, false);
  groups += 1;
}

// The single concurrent action is shared while its fresh read is unresolved.
{
  const rig = makeRig();
  const gate = deferred();
  rig.queueBackend(OLD_PIN, () => gate.promise);
  const result = readyResource(rig);
  const first = rig.action.start(rig.kernel, result);
  await Promise.resolve();
  const second = rig.action.start(rig.kernel, result);
  assert.equal(second, first);
  gate.resolve(rig.backend());
  await first;
  assert.equal(rig.calls.submit.length, 1);
  assert.equal(rig.action.getSnapshot().state, "pending");
  assert.equal(rig.action.getSnapshot().busy, false);
  groups += 1;
}

// A candidate change after guarded capture releases those guards and still sends no POST.
{
  const rig = makeRig();
  rig.queueBackend(OLD_PIN, rig.backend());
  rig.queueBackend(OLD_PIN, rig.backend());
  rig.queueBackend(OLD_PIN, backend(OLD_PIN, { readySha: "d".repeat(64), currentSha: CURRENT_SHA }));
  await rig.action.start(rig.kernel, readyResource(rig));
  assert.equal(rig.owner.captures, 1);
  assert.equal(rig.owner.releases, 1);
  assert.equal(rig.calls.submit.length, 0);
  assert.equal(rig.host.getSnapshot().paused, false);
  assert.equal(rig.action.getSnapshot().state, "failed");
  groups += 1;
}

// A clean pre-intent owner rejection may be retried only after a later explicit action.
{
  const rig = makeRig();
  rig.owner.captureFailure = true;
  const result = readyResource(rig);
  await rig.action.start(rig.kernel, result);
  assert.equal(rig.action.getSnapshot().state, "failed");
  assert.equal(rig.action.getSnapshot().requestId, null);
  assert.equal(rig.action.controller.getSnapshot().captureCleanup, "confirmed");
  assert.equal(rig.calls.submit.length, 0);
  assert.equal(rig.host.getSnapshot().paused, false);
  assert.equal(rig.action.canStart(rig.kernel, result), true);
  rig.owner.captureFailure = false;
  await rig.action.start(rig.kernel, result);
  assert.equal(rig.calls.submit.length, 1);
  assert.equal(rig.owner.apply, 0);
  assert.equal(rig.owner.reset, 0);
  groups += 1;
}

// An untagged owner rejection cannot establish that cleanup completed, so custody blocks retry.
{
  const rig = makeRig();
  rig.owner.untaggedCaptureFailure = true;
  const result = readyResource(rig);
  await rig.action.start(rig.kernel, result);
  const controller = rig.action.controller;
  assert.ok(controller);
  assert.equal(rig.action.getSnapshot().state, "failed");
  assert.equal(rig.action.getSnapshot().requestId, null);
  assert.equal(controller.getSnapshot().captureCleanup, "unconfirmed");
  assert.equal(rig.calls.submit.length, 0);
  assert.equal(rig.host.getSnapshot().paused, false);
  const statusReads = rig.calls.status;
  assert.equal(rig.action.canStart(rig.kernel, result), false);
  await rig.action.start(rig.kernel, result);
  assert.equal(rig.calls.status, statusReads);
  assert.equal(rig.calls.submit.length, 0);
  assert.equal(rig.action.controller, controller);
  assert.ok(rig.action.attempt);
  groups += 1;
}

// Even a release that resumes the Host cannot authorize retry when its cleanup result is unconfirmed.
{
  const rig = makeRig();
  rig.queueBackend(OLD_PIN, rig.backend());
  rig.queueBackend(OLD_PIN, rig.backend());
  rig.queueBackend(OLD_PIN, backend(OLD_PIN, { readySha: "d".repeat(64), currentSha: CURRENT_SHA }));
  rig.owner.releaseFailure = true;
  rig.owner.releaseFailureResumes = true;
  const result = readyResource(rig);
  await rig.action.start(rig.kernel, result);
  const controller = rig.action.controller;
  assert.ok(controller);
  assert.equal(rig.owner.captures, 1);
  assert.equal(rig.owner.releases, 1);
  assert.equal(rig.host.getSnapshot().paused, false);
  assert.equal(rig.action.getSnapshot().state, "failed");
  assert.equal(rig.action.getSnapshot().requestId, null);
  assert.equal(controller.getSnapshot().captureCleanup, "unconfirmed");
  assert.equal(rig.calls.submit.length, 0);
  const statusReads = rig.calls.status;
  assert.equal(rig.action.canStart(rig.kernel, result), false);
  await rig.action.start(rig.kernel, result);
  assert.equal(rig.calls.status, statusReads);
  assert.equal(rig.calls.submit.length, 0);
  assert.equal(rig.action.controller, controller);
  assert.ok(rig.action.attempt);
  groups += 1;
}

// Lost acknowledgement reconciles the same request/token; the Host retains its service across generations.
{
  const rig = makeRig();
  rig.setSubmitMode(OLD_PIN, "lost-ack");
  await rig.action.start(rig.kernel, readyResource(rig));
  const serviceBeforeRemount = rig.host.restartAction;
  const firstSubmission = rig.calls.submit[0];
  const controllerBeforeRestore = rig.action.controller;
  assert.equal(rig.action.getSnapshot().state, "unknown");
  assert.equal(rig.action.getSnapshot().busy, false);
  assert.equal(JSON.stringify(rig.action.getSnapshot()).includes(firstSubmission.token), false);
  assert.equal(rig.host.getSnapshot().paused, true);

  await rig.host.restartAction.reconcile(); // A banner remount reuses the Host-owned service.
  assert.equal(rig.host.restartAction, serviceBeforeRemount);
  assert.equal(rig.host.getSnapshot().generation, 1);
  assert.equal(rig.host.getSnapshot().kernel.api.getExpectedApiInstance(), NEW_PIN);
  assert.equal(rig.host.getSnapshot().paused, false);
  assert.equal(rig.action.getSnapshot().state, "restored");
  assert.equal(rig.action.getSnapshot().requestId, firstSubmission.request.request_id);
  assert.equal(rig.action.controller, null);
  assert.equal(rig.action.attempt, null);
  assert.equal(rig.action.unsubscribeController, null);
  assert.equal(controllerBeforeRestore.getSnapshot().state, "restored");
  assert.equal(rig.kernel.api.retired, true);
  assert.equal(rig.calls.submit.length, 1);
  assert.equal(rig.calls.read.length, 1);
  assert.equal(rig.calls.read[0].requestId, firstSubmission.request.request_id);
  assert.equal(rig.calls.read[0].token, firstSubmission.token);
  await rig.action.reconcile();
  assert.equal(rig.calls.read.length, 1);

  const oldKernel = rig.kernel;
  const currentKernel = rig.host.getSnapshot().kernel;
  const appliedBackend = backend(NEW_PIN, {
    readySha: READY_SHA,
    currentSha: CURRENT_SHA,
    sessionId: "restored-session",
    sessionEpoch: 1,
  });
  rig.setBackend(NEW_PIN, appliedBackend);
  const repeatedSource = readyResource(rig, appliedBackend);
  assert.equal(rig.action.canStart(currentKernel, repeatedSource), false);
  assert.equal(rig.action.canStart(oldKernel, readyResource(rig)), false);
  await rig.action.start(oldKernel, readyResource(rig));
  assert.equal(rig.calls.submit.length, 1);

  const nextSource = backend(NEW_PIN, {
    readySha: "e".repeat(64),
    currentSha: READY_SHA,
    sessionId: "restored-session",
    sessionEpoch: 1,
  });
  rig.setBackend(NEW_PIN, nextSource);
  assert.equal(rig.action.canStart(currentKernel, readyResource(rig, nextSource)), true);
  await rig.action.start(currentKernel, readyResource(rig, nextSource));
  assert.equal(rig.calls.submit.length, 2);
  assert.notEqual(rig.calls.submit[0].request.request_id, rig.calls.submit[1].request.request_id);
  groups += 1;
}

// A confirmed native ready response with failed hydration retains protection and is never hydrated twice.
{
  const rig = makeRig();
  rig.owner.hydrationFailure = true;
  await rig.action.start(rig.kernel, readyResource(rig));
  assert.equal(rig.action.getSnapshot().state, "pending");
  rig.setReadMode(OLD_PIN, "ready");
  await rig.action.reconcile();
  const reads = rig.calls.read.length;
  assert.equal(rig.action.getSnapshot().state, "failed");
  assert.equal(rig.action.getSnapshot().requestId, rig.calls.submit[0].request.request_id);
  assert.equal(rig.owner.hydrates, 1);
  assert.equal(rig.owner.releases, 0);
  assert.equal(rig.host.getSnapshot().paused, true);
  await rig.action.reconcile();
  await rig.action.start(rig.kernel, readyResource(rig));
  assert.equal(rig.calls.read.length, reads);
  assert.equal(rig.calls.submit.length, 1);
  assert.equal(rig.owner.hydrates, 1);
  assert.equal(rig.host.getSnapshot().paused, true);
  groups += 1;
}

// A cleanup failure after confirmed restoration cannot make hydration repeatable.
{
  const rig = makeRig();
  rig.setSubmitMode(OLD_PIN, "lost-ack");
  rig.owner.releaseFailure = true;
  await rig.action.start(rig.kernel, readyResource(rig));
  await rig.action.reconcile();
  assert.equal(rig.host.getSnapshot().generation, 1);
  assert.equal(rig.action.getSnapshot().state, "restored");
  assert.match(rig.action.getSnapshot().message, /cleanup failed/);
  const currentKernel = rig.host.getSnapshot().kernel;
  const nextSource = backend(NEW_PIN, {
    readySha: "f".repeat(64),
    currentSha: READY_SHA,
    sessionId: "restored-session",
    sessionEpoch: 1,
  });
  rig.setBackend(NEW_PIN, nextSource);
  const statusReads = rig.calls.status;
  assert.equal(rig.action.canStart(currentKernel, readyResource(rig, nextSource)), false);
  await rig.action.start(currentKernel, readyResource(rig, nextSource));
  assert.equal(rig.calls.status, statusReads);
  assert.equal(rig.calls.submit.length, 1);
  assert.equal(rig.owner.hydrates, 1);
  groups += 1;
}

// A failed preflight for a second build remains visible after the completed controller is retired.
{
  const rig = makeRig();
  rig.setSubmitMode(OLD_PIN, "lost-ack");
  await rig.action.start(rig.kernel, readyResource(rig));
  await rig.action.reconcile();
  const currentKernel = rig.host.getSnapshot().kernel;
  const selected = backend(NEW_PIN, {
    readySha: "c".repeat(64),
    currentSha: READY_SHA,
    sessionId: "restored-session",
    sessionEpoch: 1,
  });
  rig.queueBackend(NEW_PIN, backend(NEW_PIN, {
    readySha: "d".repeat(64),
    currentSha: READY_SHA,
    sessionId: "restored-session",
    sessionEpoch: 1,
  }));
  await rig.action.start(currentKernel, readyResource(rig, selected));
  assert.equal(rig.action.getSnapshot().state, "failed");
  assert.match(rig.action.getSnapshot().message, /changed/);
  assert.equal(rig.calls.submit.length, 1);
  groups += 1;
}

console.log(JSON.stringify(await runMaterialAssignmentDraftCheck()));
console.log(JSON.stringify({
  check: "development-restart-action",
  groups,
  passed: true,
  emitted_code: false,
  adapter: "actual_service_controller_host_with_controlled_owner_and_typed_api_protocols",
}));
