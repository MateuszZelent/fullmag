import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(scriptsRoot, "fixtures/native-workspace-restart-page.tsx");
const fixtureSource = await readFile(fixturePath, "utf8");
const classStart = fixtureSource.indexOf("class NativeWorkspaceRestartFixture {");
const classEnd = fixtureSource.indexOf("\nfunction requestTarget", classStart);
assert.ok(classStart >= 0 && classEnd > classStart, "the private fixture class must remain extractable");
const classSource = fixtureSource.slice(classStart, classEnd);
const executableClass = stripTypeScriptTypes(classSource, {
  mode: "strip",
  sourceUrl: "native-workspace-restart-page.tsx#NativeWorkspaceRestartFixture",
});
const requestTargetStart = fixtureSource.indexOf("function requestTarget(");
const requestTargetEnd = fixtureSource.indexOf("\nfunction validateEligibilityProof", requestTargetStart);
assert.ok(requestTargetStart >= 0 && requestTargetEnd > requestTargetStart,
  "the fixture request target resolver must remain extractable");
const executableRequestTarget = stripTypeScriptTypes(
  fixtureSource.slice(requestTargetStart, requestTargetEnd),
  {
    mode: "strip",
    sourceUrl: "native-workspace-restart-page.tsx#requestTarget",
  },
);

const apiInstanceHeader = "x-fullmag-api-instance";
const backendStatusPath = "/v2/platform/development-backend";
const eligibilityPath = "/native-browser-probe/eligibility";
const oldPin = "11111111-1111-4111-8111-111111111111";
const replacementPin = "22222222-2222-4222-8222-222222222222";

function createHarness({ baselinePin, responsePin, proofPin, neverResolveEligibility = false }) {
  let eligibilityCalls = 0;
  const statusHeaders = new Headers({ "Content-Type": "application/json" });
  if (responsePin !== null) statusHeaders.set(apiInstanceHeader, responsePin);
  const statusResponse = new Response(JSON.stringify({
    configured: true,
    state: "ready",
    restart_available: false,
  }), { status: 200, headers: statusHeaders });
  const proofResponse = new Response(JSON.stringify({
    schema: "fullmag.development-browser-native-ready.v1",
    api_instance_id: proofPin,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  const sandbox = {
    API_INSTANCE_HEADER: apiInstanceHeader,
    PLATFORM_DEVELOPMENT_BACKEND_PATH: backendStatusPath,
    PRIVATE_PROBE_PATH: "/native-browser-probe",
    INITIAL_FIXTURE_SNAPSHOT: {
      proof: null,
      proofState: "waiting",
      proofMessage: "",
      operation: "idle",
      message: null,
      preparedDraft: null,
      baseline: null,
      beforeAttempted: false,
      finishAttempted: false,
      finished: false,
      finishResponse: null,
    },
    Headers,
    Request,
    Response,
    URL,
    window: { location: { origin: "http://localhost:3258", href: "http://localhost:3258/native-browser-proof" } },
    validateEligibilityProof: (value) => value,
    sameProofScope: (left, right) => left.api_instance_id === right.api_instance_id,
    eligibilityRejection: (_backend, responsePinValue, proof) =>
      responsePinValue === proof.api_instance_id ? null : "status response pin does not match the proof",
    errorMessage: (error) => error instanceof Error ? error.message : String(error),
    boundedResponseText: (response) => response.text(),
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input, "http://localhost:3258");
      if (url.pathname === backendStatusPath) return statusResponse;
      if (url.pathname === eligibilityPath) {
        eligibilityCalls += 1;
        return neverResolveEligibility ? new Promise(() => {}) : proofResponse;
      }
      throw new Error(`Unexpected fixture test request: ${url.pathname}`);
    },
  };
  vm.runInNewContext(
    `${executableRequestTarget}\n${executableClass}\nglobalThis.NativeWorkspaceRestartFixture = NativeWorkspaceRestartFixture;`,
    sandbox,
  );
  const fixture = new sandbox.NativeWorkspaceRestartFixture();
  if (baselinePin !== null) {
    fixture.completeBeforeCapture({ api_instance_id: baselinePin, nonce: "before-capture" });
  }
  const request = new Request(`http://localhost:3258${backendStatusPath}`);
  return {
    eligibilityCalls: () => eligibilityCalls,
    fixture,
    request,
    statusResponse,
  };
}

{
  const test = createHarness({
    baselinePin: oldPin,
    responsePin: replacementPin,
    proofPin: oldPin,
    neverResolveEligibility: true,
  });
  const timeout = Symbol("eligibility lookup did not get bypassed");
  const response = await Promise.race([
    test.fixture.fetch(test.request),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(timeout), 100)),
  ]);
  assert.notEqual(response, timeout, "the replacement pin must not wait on private eligibility");
  assert.equal(response, test.statusResponse, "replacement status must pass through unchanged");
  assert.equal(test.eligibilityCalls(), 0);
}

{
  const test = createHarness({ baselinePin: oldPin, responsePin: oldPin, proofPin: oldPin });
  const response = await test.fixture.fetch(test.request);
  assert.notEqual(response, test.statusResponse, "the captured old pin keeps the private status overlay");
  assert.equal(test.eligibilityCalls(), 1);
  assert.equal((await response.json()).restart_available, true);
}

{
  const test = createHarness({ baselinePin: null, responsePin: replacementPin, proofPin: replacementPin });
  const response = await test.fixture.fetch(test.request);
  assert.notEqual(response, test.statusResponse, "without a captured baseline, pin changes must not bypass eligibility");
  assert.equal(test.eligibilityCalls(), 1);
  assert.equal((await response.json()).restart_available, true);
}

{
  const test = createHarness({ baselinePin: oldPin, responsePin: null, proofPin: oldPin });
  const response = await test.fixture.fetch(test.request);
  assert.equal(response, test.statusResponse, "missing response pins must follow the existing validation path");
  assert.equal(test.eligibilityCalls(), 1);
  assert.equal((await response.json()).restart_available, false);
}

console.log(JSON.stringify({
  schema: "fullmag.control-room.check-result.v1",
  check: "native-workspace-restart-pin-overlay",
  status: "passed",
  cases: [
    "replacement-pin-bypasses-never-resolving-private-eligibility",
    "old-pin-retains-private-overlay",
    "no-baseline-does-not-bypass-eligibility",
    "missing-header-does-not-bypass-validation",
  ],
}));
