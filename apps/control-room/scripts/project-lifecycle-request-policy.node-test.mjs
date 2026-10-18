import assert from "node:assert/strict";
import { test } from "node:test";
import { isForbiddenRuntimeMutation, isHostTelemetryRead } from "./project-lifecycle-request-policy.mjs";

test("only the two exact host telemetry GET aliases are session-free reads", () => {
  for (const device of ["cpu", "gpu"]) {
    const path = `/v2/sessions/current/diagnostics/${device}`;
    assert.equal(isHostTelemetryRead("GET", path), true);
    assert.equal(isHostTelemetryRead("POST", path), false);
    assert.equal(isHostTelemetryRead("GET", path + "/extra"), false);
  }
  assert.equal(isHostTelemetryRead("GET", "/v2/sessions/current/status"), false);
  assert.equal(isHostTelemetryRead("GET", "/v2/sessions/current/diagnostics/solver-profile"), false);
});

test("session-free lifecycle rejects transient session creation and deletion", () => {
  assert.equal(isForbiddenRuntimeMutation("POST", "/v2/sessions", "absent"), true);
  assert.equal(isForbiddenRuntimeMutation("DELETE", "/v2/sessions/transient-id", "absent"), true);
  assert.equal(isForbiddenRuntimeMutation("PATCH", "/v2/sessions/current", "absent"), true);
});

test("project persistence and session discovery remain permitted", () => {
  assert.equal(isForbiddenRuntimeMutation("GET", "/v2/sessions", "absent"), false);
  assert.equal(isForbiddenRuntimeMutation("POST", "/v2/persistence/projects", "absent"), false);
  assert.equal(isForbiddenRuntimeMutation("POST", "/v2/persistence/projects/open", "absent"), false);
  assert.equal(isForbiddenRuntimeMutation("POST", "/v2/persistence/projects/id/save", "absent"), false);
});

test("both modes retain the existing solver mutation guard", () => {
  for (const mode of ["active", "absent"]) {
    assert.equal(isForbiddenRuntimeMutation("POST", "/v2/sessions/current/simulation/runs", mode), true);
    assert.equal(isForbiddenRuntimeMutation("POST", "/v2/sessions/current/meshing/build", mode), true);
    assert.equal(isForbiddenRuntimeMutation("POST", "/v2/persistence/restore", mode), true);
  }
});
