import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

// Exercise the production service through native type erasure; no test bundle is compiled.
const context = vm.createContext({ crypto: webcrypto });
const source = (path) => new vm.SourceTextModule(
  stripTypeScriptTypes(readFileSync(new URL(path, import.meta.url), "utf8")),
  { context },
);
const pin = source("../src/kernel/api/apiInstancePin.ts");
const serviceModule = source("../src/kernel/development/DevelopmentBackendBuildActionService.ts");
await pin.link(() => { throw new Error("Unexpected API pin dependency"); });
await serviceModule.link((specifier) => {
  assert.equal(specifier, "../api/apiInstancePin");
  return pin;
});
await pin.evaluate();
await serviceModule.evaluate();

const { DevelopmentBackendBuildActionService } = serviceModule.namespace;
const apiInstanceId = "11111111-1111-4111-8111-111111111111";
const readyBuildId = "a".repeat(64);
const readySourceSha256 = "b".repeat(64);

function response(requestId, state) {
  return {
    schema: "fullmag.development-backend-build-request-resource.v1",
    request_id: requestId,
    state,
    ready_build_id: state === "ready" ? readyBuildId : null,
    ready_source_sha256: state === "ready" ? readySourceSha256 : null,
  };
}

function fixture({ submitStates = ["pending"], readStates = ["ready"] } = {}) {
  const calls = { submit: [], read: [] };
  const api = {
    getExpectedApiInstance: () => apiInstanceId,
    platform: {
      submitDevelopmentBackendBuildRequest: async (request, token) => {
        calls.submit.push({ request: structuredClone(request), token });
        const state = submitStates.shift() ?? "pending";
        if (state === "conflict") throw new Error("Build request rejected");
        return response(request.request_id, state);
      },
      developmentBackendBuildRequest: async (requestId, token) => {
        calls.read.push({ requestId, token });
        return response(requestId, readStates.shift() ?? "unknown");
      },
    },
  };
  const backend = {
    schema_version: "1.0.0",
    configured: true,
    state: "waiting",
    build_available: true,
    build_request_id: null,
    workspace_identity: { api_instance_id: apiInstanceId },
  };
  return { action: new DevelopmentBackendBuildActionService(), api, backend, calls };
}

for (const terminal of ["ready", "failed"]) {
  const { action, api, backend } = fixture({ readStates: [terminal] });
  await action.start(api, backend);
  assert.equal(action.getSnapshot().state, "pending");
  assert.equal(action.blocksWorkspaceTransition(), true);
  await action.reconcile();
  assert.equal(action.getSnapshot().state, terminal);
  assert.equal(action.blocksWorkspaceTransition(), false);

  const requestId = action.getSnapshot().requestId;
  for (const observedState of ["waiting", "building"]) {
    action.observeBackend({ ...backend, state: observedState, build_request_id: requestId });
    assert.equal(action.getSnapshot().state, terminal, "late public state must not roll back a private terminal result");
  }
}

{
  const { action, api, backend } = fixture({ submitStates: ["building"] });
  await action.start(api, backend);
  const requestId = action.getSnapshot().requestId;
  action.observeBackend({ ...backend, state: "waiting", build_request_id: requestId });
  assert.equal(action.getSnapshot().state, "building", "late queued status must not roll back building");
}

{
  const { action, api, backend, calls } = fixture({
    submitStates: ["conflict", "pending"],
    readStates: ["unknown", "unknown"],
  });
  await action.start(api, backend);
  assert.equal(action.getSnapshot().state, "unknown");
  assert.equal(action.blocksWorkspaceTransition(), true);
  const first = calls.submit[0];

  await action.retrySameRequest();
  assert.equal(calls.submit.length, 2);
  assert.equal(calls.submit[1].request.request_id, first.request.request_id);
  assert.equal(calls.submit[1].request.api_instance_id, first.request.api_instance_id);
  assert.equal(calls.submit[1].token, first.token);
  assert.deepEqual(calls.read.map((call) => call.requestId), [first.request.request_id, first.request.request_id]);
  assert.equal(action.getSnapshot().state, "pending");
}

{
  const { action, api, backend, calls } = fixture({
    submitStates: ["conflict"],
    readStates: ["unknown", "pending"],
  });
  await action.start(api, backend);
  await action.retrySameRequest();
  assert.equal(calls.submit.length, 1, "a known active request must not be POSTed again");
  assert.equal(action.getSnapshot().state, "pending");
}

console.log(JSON.stringify({ check: "development-backend-build-action", passed: true, production_type_erasure: true, test_compilation: false }));
