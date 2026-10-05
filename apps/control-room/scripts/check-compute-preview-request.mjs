import assert from "node:assert/strict";
import {
  isComputePreviewScopeCurrent,
  prepareComputeExecutionPreview,
} from "../src/kernel/resources/computeExecutionPreviewRequest.ts";

const input = {
  expected_profile_catalog_revision: 7,
  study_plan: { schema_version: "study_plan.v2", steps: [{ step_id: "run" }] },
  inputs: [{ step_id: "run", problem: { problem_meta: { name: "authored" } }, layers: [] }],
};
const scopes = { apiScope: "api-a", sessionScope: "session-a:epoch-1" };
const first = await prepareComputeExecutionPreview(input, scopes);
const repeat = await prepareComputeExecutionPreview(input, scopes);
assert.equal(first.bodySha256, repeat.bodySha256);
assert.equal(Object.isFrozen(first.request.inputs[0].problem.problem_meta), true);
input.inputs[0].problem.problem_meta.name = "edited";
assert.equal(first.request.inputs[0].problem.problem_meta.name, "authored");
const edited = await prepareComputeExecutionPreview(input, scopes);
assert.notEqual(edited.bodySha256, first.bodySha256);
assert.equal(isComputePreviewScopeCurrent(first, scopes.apiScope, scopes.sessionScope), true);
assert.equal(isComputePreviewScopeCurrent(first, "api-b", scopes.sessionScope), false);
assert.equal(isComputePreviewScopeCurrent(first, scopes.apiScope, "session-a:epoch-2"), false);
assert.equal(isComputePreviewScopeCurrent(first, scopes.apiScope, null), false);
const mutableScope = { ...scopes };
const pending = prepareComputeExecutionPreview(input, mutableScope);
mutableScope.apiScope = "api-b";
mutableScope.sessionScope = "session-b:epoch-1";
const captured = await pending;
assert.equal(captured.apiScope, scopes.apiScope);
assert.equal(captured.sessionScope, scopes.sessionScope);
await assert.rejects(prepareComputeExecutionPreview(input, { ...scopes, sessionScope: "" }), /scope/);
await assert.rejects(prepareComputeExecutionPreview({ ...input, study_plan: { payload: "x".repeat(8 * 1024 * 1024) } }, scopes), /8 MiB/);
console.log(JSON.stringify({ state: "passed", immutable_request: true, api_session_fence: true, unit_test_compilation: false }));
