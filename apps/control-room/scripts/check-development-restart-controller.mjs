import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

// Execute production source after native type erasure; no unit-test bundle or emitted code.
const context = vm.createContext({ crypto: webcrypto, structuredClone, URLSearchParams });
const pin = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync("src/kernel/api/apiInstancePin.ts", "utf8")), { context });
const source = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync("src/kernel/development/DevelopmentRestartController.ts", "utf8")), { context });
await pin.link(() => { throw new Error("Unexpected pin dependency"); });
await source.link((name) => {
  assert.equal(name, "../api/apiInstancePin");
  return pin;
});
await source.evaluate();
const { DevelopmentRestartController, DevelopmentRestartCaptureError } = source.namespace;
const generatedPaths = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync("src/kernel/api/generated/openapi-v2-paths.ts", "utf8")), { context });
await generatedPaths.link(() => { throw new Error("Unexpected generated path dependency"); });
const paths = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync("src/kernel/api/apiPaths.ts", "utf8")), { context });
await paths.link((name) => {
  assert.equal(name, "./generated/openapi-v2-paths");
  return generatedPaths;
});
await paths.evaluate();
const oldPin = "11111111-1111-4111-8111-111111111111";
const newPin = "22222222-2222-4222-8222-222222222222";
let groups = 0;
for (const [path, expected] of [
  ["/v2/platform/development-restart-requests/request-id", true],
  ["/v2/platform/development-restart-requests", false],
  ["/v2/platform/development-restart-requests/", false],
  ["/v2/platform/development-restart-requests/a/b", false],
  ["/v2/platform/development-restart-requests/a?query=1", false],
  ["/v2/sessions/current/status", false],
  ["/v2/platform/development-restart-requests-foreign/a", false],
]) {
  assert.equal(paths.namespace.isDevelopmentRestartRequestStatusPath(path), expected);
  groups++;
}

function fixture(overrides = {}) {
  const calls = { submit: 0, read: 0, hydrate: 0, release: 0, request: null, token: null };
  const result = (state) => ({
    schema: "fullmag.development-ui-restart-resource.v1", request_id: calls.request.request_id, state,
    ...(state === "ready" ? { new_api_instance_id: newPin,
      session_id: calls.request.session_id === null ? null : "restored-session", session_epoch: calls.request.session_id === null ? 0 : 1,
      editor: calls.request.editor, workspace: calls.request.workspace, project_document: calls.request.project_document } : {}),
  });
  const controller = new DevelopmentRestartController(oldPin, {
    submit: async (request, token) => {
      calls.submit++; calls.request = request; calls.token = token;
      if (overrides.submitError) throw overrides.submitError;
      if (overrides.lostAck) throw new Error("Lost acknowledgement");
      return result("pending");
    },
    read: async (requestId, token) => {
      calls.read++; assert.equal(requestId, calls.request.request_id); assert.equal(token, calls.token);
      if (overrides.readFailure) throw new Error("Disconnected");
      return { ...result(overrides.state ?? "ready"), ...overrides.response };
    },
  }, {
    capture: async () => {
      if (overrides.captureError) throw overrides.captureError;
      if (overrides.captureFailure) throw new Error("Busy owner");
      return { sessionId: overrides.sessionId ?? null, sessionEpoch: 2,
        editor: { draft: "unsaved" }, workspace: { panel: "Geometry" }, projectDocument: { archive: "original" },
        assertCurrent: () => { if (overrides.captureChanged) throw new Error("Captured owner changed"); },
        release: () => { calls.release++; if (overrides.releaseFailure) throw new Error("Cleanup failed"); } };
    },
    hydrate: async () => {
      calls.hydrate++;
      if (overrides.hydrationFailure) throw new Error("Owner restore failed");
    },
  });
  return { controller, calls };
}

for (const lostAck of [false, true]) {
  const { controller, calls } = fixture({ lostAck });
  await controller.start();
  assert.equal(controller.getSnapshot().state, lostAck ? "unknown" : "pending");
  assert.equal(calls.release, 0);
  assert.match(calls.token, /^[a-f0-9]{32}$/);
  assert.equal(JSON.stringify(controller.getSnapshot()).includes(calls.token), false);
  await assert.rejects(controller.start(), /already owns/);
  await controller.reconcile();
  assert.equal(controller.getSnapshot().state, "restored");
  assert.equal(calls.submit, 1); assert.equal(calls.hydrate, 1); assert.equal(calls.release, 1);
  await controller.reconcile(); assert.equal(calls.read, 1);
  groups++;
}
for (const response of [
  { request_id: "foreign" }, { schema: "foreign" }, { new_api_instance_id: oldPin },
  { new_api_instance_id: "invalid" }, { session_epoch: -1 }, { session_epoch: 0.5 },
  { session_id: "foreign" }, { editor: {} }, { workspace: {} }, { project_document: {} }, { state: "foreign" },
]) {
  const { controller, calls } = fixture({ response });
  await controller.start(); await controller.reconcile();
  assert.equal(controller.getSnapshot().state, "unknown");
  assert.equal(calls.hydrate, 0); assert.equal(calls.release, 0); assert.equal(calls.submit, 1);
  groups++;
}
for (const state of ["pending", "unknown", "failed"]) {
  const { controller, calls } = fixture({ state });
  await controller.start(); await controller.reconcile();
  assert.equal(controller.getSnapshot().state, state);
  assert.equal(calls.release, state === "failed" ? 1 : 0); assert.equal(calls.hydrate, 0);
  groups++;
}
for (const mode of ["captureFailure", "readFailure", "hydrationFailure"]) {
  const { controller, calls } = fixture({ [mode]: true });
  await controller.start(); await controller.reconcile();
  assert.equal(controller.getSnapshot().state, mode === "readFailure" ? "unknown" : "failed");
  assert.equal(calls.submit, mode === "captureFailure" ? 0 : 1); assert.equal(calls.release, 0);
  if (mode === "captureFailure") {
    assert.equal(controller.getSnapshot().captureCleanup, "unconfirmed");
    assert.match(controller.getSnapshot().message, /cleanup is unconfirmed/);
  }
  if (mode === "hydrationFailure") { await controller.reconcile(); assert.equal(calls.hydrate, 1); }
  groups++;
}
{
  const { controller, calls } = fixture({ releaseFailure: true });
  controller.subscribe(() => { throw new Error("Subscriber failed"); });
  await controller.start(); await controller.reconcile(); await controller.reconcile();
  assert.equal(controller.getSnapshot().state, "restored");
  assert.equal(calls.hydrate, 1); assert.equal(calls.read, 1); assert.equal(calls.release, 1);
  groups++;
}
for (const releaseFailure of [false, true]) {
  const { controller, calls } = fixture({ captureChanged: true, releaseFailure });
  await controller.start();
  assert.equal(controller.getSnapshot().state, "failed");
  assert.equal(calls.submit, 0); assert.equal(calls.release, 1);
  assert.equal(controller.getSnapshot().captureCleanup, releaseFailure ? "unconfirmed" : "confirmed");
  groups++;
}
for (const confirmed of [true, false]) {
  const { controller, calls } = fixture({ captureError: new DevelopmentRestartCaptureError(confirmed, "pending_changes") });
  await controller.start();
  assert.equal(controller.getSnapshot().state, "failed");
  assert.equal(controller.getSnapshot().captureCleanup, confirmed ? "confirmed" : "unconfirmed");
  assert.equal(calls.submit, 0); assert.equal(calls.release, 0);
  assert.match(controller.getSnapshot().message, confirmed ? /Apply or revert pending Inspector changes/ : /cleanup is unconfirmed/);
  groups++;
}
for (const confirmed of [true, false]) {
  const { controller, calls } = fixture({ captureError: new DevelopmentRestartCaptureError(confirmed) });
  await controller.start();
  assert.equal(controller.getSnapshot().state, "failed");
  assert.equal(controller.getSnapshot().captureCleanup, confirmed ? "confirmed" : "unconfirmed");
  assert.equal(calls.submit, 0); assert.equal(calls.release, 0);
  groups++;
}
{
  const { controller, calls } = fixture({ sessionId: "old-session" });
  await controller.start(); await controller.reconcile();
  assert.equal(controller.getSnapshot().state, "restored"); assert.equal(calls.hydrate, 1);
  groups++;
}
for (const response of [{ session_id: "old-session" }, { session_id: null }, { session_id: "" }, { session_epoch: 0 }, { session_epoch: 2 }]) {
  const { controller, calls } = fixture({ sessionId: "old-session", response });
  await controller.start(); await controller.reconcile();
  assert.equal(controller.getSnapshot().state, "unknown"); assert.equal(calls.hydrate, 0); assert.equal(calls.release, 0);
  groups++;
}
for (const [code, status, name, expected] of [
  ["development_restart_workspace_changed", 409, "ControlRoomApiError", "failed"],
  ["development_restart_publication_unconfirmed", 409, "ControlRoomApiError", "unknown"],
  ["development_restart_workspace_changed", 500, "ControlRoomApiError", "unknown"],
  ["development_restart_workspace_changed", 409, "Error", "unknown"],
]) {
  const { controller, calls } = fixture({ submitError: { name, status, code } });
  await controller.start();
  assert.equal(controller.getSnapshot().state, expected);
  assert.equal(calls.release, expected === "failed" ? 1 : 0);
  assert.equal(calls.submit, 1); assert.equal(calls.hydrate, 0);
  if (expected === "failed") { await controller.reconcile(); assert.equal(calls.read, 0); }
  groups++;
}
console.log(JSON.stringify({ check: "development-restart-controller", groups, passed: true, emitted_code: false }));
