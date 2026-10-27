#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const LOCAL_PLAYWRIGHT_MODULE = new URL(
  "../apps/control-room/node_modules/playwright/index.mjs",
  import.meta.url,
).href;
const DEFAULT_URL = process.env.CONTROL_ROOM_URL ?? "http://localhost:3217/workspace";
const DEFAULT_API_BASE =
  process.env.CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL ??
  new URL(DEFAULT_URL).origin;
const DEFAULT_OUTPUT = "/tmp/fullmag-eigen-mode-ui-report.json";
const SAFE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const TERMINAL_RUN_STATES = new Set([
  "completed",
  "complete",
  "succeeded",
  "success",
  "done",
]);
const FAILED_RUN_STATES = new Set([
  "failed",
  "failure",
  "error",
  "cancelled",
  "canceled",
  "stopped",
]);
const MAX_JSON_BYTES = 64 * 1024 * 1024;

function usage() {
  return [
    "Usage:",
    "  node scripts/verify_eigen_mode_ui.mjs --run RUN_ID [options]",
    "",
    "Options:",
    "  --url URL             Control Room URL (default: CONTROL_ROOM_URL or localhost:3217/workspace)",
    "  --api-base URL        v2 API base (default: CONTROL_ROOM_API_BASE_URL or URL origin)",
    "  --run RUN_ID          exact expected run identity (required)",
    "  --stage STAGE_ID      optional exact expected stage identity",
    "  --sample INDEX        sample index (default: 0)",
    "  --mode INDEX          raw mode index (default: 0)",
    "  --output PATH         JSON report path (default: /tmp/fullmag-eigen-mode-ui-report.json)",
    "  --timeout-ms N        bounded browser/API observation timeout (default: 60000)",
    "  --headed              show Chromium instead of running headless",
    "  --no-select-mode      do not navigate the Results tree; require an already visible field",
    "  --help                print this help",
  ].join("\n");
}

function parseArgs(argv) {
  let apiBaseExplicit = Boolean(
    process.env.CONTROL_ROOM_API_BASE_URL ??
      process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL,
  );
  const options = {
    apiBase: DEFAULT_API_BASE,
    headed: false,
    modeIndex: 0,
    output: DEFAULT_OUTPUT,
    sampleIndex: 0,
    selectMode: true,
    stageId: null,
    timeoutMs: 60_000,
    url: DEFAULT_URL,
    runId: process.env.FULLMAG_EXPECTED_RUN_ID ?? null,
  };

  const valueFor = (index, name) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value.\n\n${usage()}`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (argument === "--headed") {
      options.headed = true;
      continue;
    }
    if (argument === "--no-select-mode") {
      options.selectMode = false;
      continue;
    }
    const [name, inlineValue] = argument.split("=", 2);
    if (name === "--url") {
      options.url = inlineValue ?? valueFor(index++, "--url");
    } else if (name === "--api-base") {
      options.apiBase = inlineValue ?? valueFor(index++, "--api-base");
      apiBaseExplicit = true;
    } else if (name === "--run") {
      options.runId = inlineValue ?? valueFor(index++, "--run");
    } else if (name === "--stage") {
      options.stageId = inlineValue ?? valueFor(index++, "--stage");
    } else if (name === "--sample") {
      options.sampleIndex = Number(inlineValue ?? valueFor(index++, "--sample"));
    } else if (name === "--mode") {
      options.modeIndex = Number(inlineValue ?? valueFor(index++, "--mode"));
    } else if (name === "--output") {
      options.output = inlineValue ?? valueFor(index++, "--output");
    } else if (name === "--timeout-ms") {
      options.timeoutMs = Number(inlineValue ?? valueFor(index++, "--timeout-ms"));
    } else {
      throw new Error(`Unknown argument ${argument}.\n\n${usage()}`);
    }
  }

  assertExactIdentity(options.runId, "--run", true);
  if (options.stageId !== null) assertExactIdentity(options.stageId, "--stage", false);
  if (!Number.isSafeInteger(options.sampleIndex) || options.sampleIndex < 0) {
    throw new Error(`--sample must be a non-negative safe integer: ${options.sampleIndex}`);
  }
  if (!Number.isSafeInteger(options.modeIndex) || options.modeIndex < 0) {
    throw new Error(`--mode must be a non-negative safe integer: ${options.modeIndex}`);
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000) {
    throw new Error(`--timeout-ms must be a safe integer >= 1000: ${options.timeoutMs}`);
  }
  try {
    options.url = new URL(options.url).toString();
    options.apiBase = new URL(
      apiBaseExplicit ? options.apiBase : new URL(options.url).origin,
    ).toString().replace(/\/$/, "");
  } catch (error) {
    throw new Error(`Invalid --url/--api-base: ${error.message}`);
  }
  options.output = safeOutputPath(options.output);
  return options;
}

function assertExactIdentity(value, name, required) {
  if (value === null || value === undefined || value === "") {
    if (required) throw new Error(`${name} is required.\n\n${usage()}`);
    return;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    value === "current" ||
    value === "run:current" ||
    /[\\/\u0000-\u001f\u007f\"']/.test(value)
  ) {
    throw new Error(`${name} must be an exact non-placeholder identity: ${JSON.stringify(value)}`);
  }
}

function safeOutputPath(value) {
  const target = resolve(value);
  if (
    target === "/" ||
    target === process.env.HOME ||
    target.endsWith("/fullmag") ||
    target.endsWith("/scripts")
  ) {
    throw new Error(`Refusing unsafe report target: ${target}`);
  }
  return target;
}

async function loadPlaywright() {
  const candidates = [
    process.env.FULLMAG_PLAYWRIGHT_MODULE,
    "playwright",
    "@playwright/test",
    LOCAL_PLAYWRIGHT_MODULE,
  ].filter(Boolean);
  for (const moduleName of candidates) {
    try {
      return await import(moduleName);
    } catch {
      // Try the next configured installation; dependencies are never installed here.
    }
  }
  throw new Error(
    "Playwright is unavailable. Set FULLMAG_PLAYWRIGHT_MODULE to an existing installation; dependencies are never installed here.",
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function pathForUrl(value) {
  try {
    return new URL(value).pathname;
  } catch {
    return value;
  }
}

function queryForUrl(value) {
  try {
    return Object.fromEntries(new URL(value).searchParams.entries());
  } catch {
    return {};
  }
}

function samePath(actual, expected) {
  if (actual === expected) return true;
  try {
    return decodeURIComponent(actual) === decodeURIComponent(expected);
  } catch {
    return false;
  }
}

function modeFieldVectorPath(fieldId) {
  return `/v2/sessions/current/data/fields/${encodeURIComponent(fieldId)}/samples/vector`;
}

const MODE_FIELD_CONTROLLER_MARK = "viewport-3d.mode-field-overlay.resource-state";
const MODE_FIELD_RESPONSE_HEADERS = [
  "content-type",
  "x-fullmag-artifact-generation-id",
  "x-fullmag-component",
  "x-fullmag-domain-generation-id",
  "x-fullmag-encoding",
  "x-fullmag-field-indexing",
  "x-fullmag-field-revision",
  "x-fullmag-mesh-topology-hash",
  "x-fullmag-n-comp",
  "x-fullmag-point-count",
  "x-fullmag-quantity-id",
  "x-fullmag-scope-kind",
  "x-fullmag-value-count",
];

function selectedResponseHeaders(headers) {
  return Object.fromEntries(
    MODE_FIELD_RESPONSE_HEADERS.map((name) => [name, headers[name] ?? null]),
  );
}

async function readResponseText(response, maxBytes = MAX_JSON_BYTES) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`response exceeds ${maxBytes} bytes (${declaredLength})`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw new Error(`response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function getJson({ apiBase, path, headers, timeoutMs, observations }) {
  const url = new URL(path, `${apiBase}/`).toString();
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let bodyText = "";
  let body = null;
  let error = null;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json", ...headers },
      method: "GET",
      redirect: "error",
      signal: controller.signal,
    });
    bodyText = await readResponseText(response);
    if (bodyText.trim() !== "") {
      try {
        body = JSON.parse(bodyText);
      } catch (parseError) {
        error = `invalid JSON: ${parseError.message}`;
      }
    }
  } catch (requestError) {
    error = requestError?.name === "AbortError"
      ? `GET timed out after ${timeoutMs} ms`
      : String(requestError?.message ?? requestError);
  } finally {
    clearTimeout(timer);
  }
  const observation = {
    bodyBytes: Buffer.byteLength(bodyText),
    elapsedMs: Date.now() - started,
    error,
    method: "GET",
    ok: response ? response.ok : false,
    path,
    status: response?.status ?? null,
  };
  observations.push(observation);
  return { body, bodyText, observation, response, url };
}

function responseSummary(response) {
  return {
    method: response.observation.method,
    path: response.observation.path,
    status: response.observation.status,
    ok: response.observation.ok,
    bodyBytes: response.observation.bodyBytes,
  };
}

function requireResponse(response, label) {
  assert(response.observation.ok, `${label} GET failed: ${JSON.stringify(responseSummary(response))}`);
  assert(response.body && typeof response.body === "object", `${label} did not return a JSON object.`);
  return response.body;
}

function sessionScopeKey(status) {
  const session = status?.session;
  const sessionId = nonEmptyString(session?.session_id);
  const sessionEpoch = nonEmptyString(session?.session_epoch);
  const requestScopeEpoch = nonEmptyString(session?.request_scope_epoch);
  assert(sessionId && sessionEpoch && requestScopeEpoch, "Current status lacks canonical session identity.");
  return {
    header: `session=${encodeURIComponent(sessionId)}&epoch=${encodeURIComponent(sessionEpoch)}&request_scope_epoch=${encodeURIComponent(requestScopeEpoch)}`,
    sessionId,
    sessionEpoch,
    requestScopeEpoch,
  };
}

function runIdFromStatus(status) {
  return nonEmptyString(status?.run?.run_id) ?? nonEmptyString(status?.session?.run_id);
}

function runState(value) {
  return nonEmptyString(value)?.toLowerCase() ?? "unknown";
}

function unwrapPayload(resource) {
  return resource?.payload && typeof resource.payload === "object"
    ? resource.payload
    : resource;
}

function exactResourceOwner(resource, label, expected, requireStage = true) {
  assert(resource && typeof resource === "object", `${label} is not an object.`);
  assert(resource.status === "ready", `${label} is not ready: ${JSON.stringify(resource.status)}`);
  assert(
    resource.generation_status === "member_verified_owner_bound",
    `${label} is not owner-bound: ${JSON.stringify({
      generationId: resource.generation_id,
      generationStatus: resource.generation_status,
    })}`,
  );
  for (const [key, expectedValue] of [
    ["session_id", expected.sessionId],
    ["run_id", expected.runId],
  ]) {
    assert(resource[key] === expectedValue, `${label}.${key} is ${JSON.stringify(resource[key])}, expected ${JSON.stringify(expectedValue)}.`);
  }
  if (requireStage) {
    const stageId = nonEmptyString(resource.stage_id);
    assert(stageId, `${label}.stage_id is missing.`);
    if (expected.stageId) {
      assert(stageId === expected.stageId, `${label}.stage_id ${stageId} != ${expected.stageId}.`);
    }
  }
  const generationId = nonEmptyString(resource.generation_id);
  const digest = nonEmptyString(resource.content_digest);
  const revision = nonEmptyString(resource.revision);
  assert(generationId && digest && revision, `${label} lacks immutable generation/digest/revision evidence.`);
  assert(digest === revision, `${label} revision and content_digest disagree.`);
  return { digest, generationId, revision, stageId: resource.stage_id };
}

function artifactEvidence(resource, label) {
  return {
    artifactPath: resource.artifact_path ?? null,
    contentDigest: resource.content_digest ?? null,
    generationId: resource.generation_id ?? null,
    generationStatus: resource.generation_status ?? null,
    label,
    resourceKey: resource.resource_key ?? null,
    revision: resource.revision ?? null,
    stageId: resource.stage_id ?? null,
    status: resource.status ?? null,
  };
}

function fieldIdFor(sampleIndex, modeIndex) {
  return `analysis:eigen:sample-${String(sampleIndex).padStart(4, "0")}:mode-${String(modeIndex).padStart(4, "0")}`;
}

function selectedModeFromSpectrum(spectrumPayload, sampleIndex, modeIndex) {
  const samples = Array.isArray(spectrumPayload?.samples) ? spectrumPayload.samples : [];
  const sample = samples.find((candidate) => Number(candidate?.sample_index) === sampleIndex);
  assert(sample, `Spectrum has no sample_index ${sampleIndex}.`);
  const modes = Array.isArray(sample.modes) ? sample.modes : [];
  const mode = modes.find((candidate) => Number(candidate?.raw_mode_index) === modeIndex);
  assert(mode, `Spectrum sample ${sampleIndex} has no raw_mode_index ${modeIndex}.`);
  assert(mode.mode_field_available !== false, `Spectrum sample ${sampleIndex} mode ${modeIndex} has no available field.`);
  return { mode, sample };
}

async function collectArtifacts(options, observations) {
  const statusResponse = await getJson({
    apiBase: options.apiBase,
    headers: {},
    path: "/v2/sessions/current/status",
    timeoutMs: options.timeoutMs,
    observations,
  });
  const status = requireResponse(statusResponse, "current status");
  const scope = sessionScopeKey(status);
  const observedRunId = runIdFromStatus(status);
  assert(observedRunId === options.runId, `Current status run ${JSON.stringify(observedRunId)} != expected ${JSON.stringify(options.runId)}.`);
  const headers = { "x-fullmag-session-scope": scope.header };
  const deadline = Date.now() + options.timeoutMs;
  let lastTransient = null;
  while (true) {
    const runResponse = await getJson({
      apiBase: options.apiBase,
      headers,
      path: "/v2/sessions/current/simulation/runs/current",
      timeoutMs: options.timeoutMs,
      observations,
    });
    const run = requireResponse(runResponse, "current run");
    assert(run.run_id === options.runId, `Current run ${JSON.stringify(run.run_id)} != expected ${JSON.stringify(options.runId)}.`);
    const state = runState(run.status);
    if (FAILED_RUN_STATES.has(state)) {
      throw new Error(`Expected run ${options.runId} is terminally ${state}; no UI proof is valid.`);
    }
    if (!TERMINAL_RUN_STATES.has(state)) {
      lastTransient = `run status is ${state}`;
      if (Date.now() >= deadline) break;
      await sleep(Math.min(500, Math.max(1, deadline - Date.now())));
      continue;
    }

    const paths = {
      field: `/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/${options.sampleIndex}/${options.modeIndex}/meta`,
      manifest: "/v2/sessions/current/analysis/frequency-domain/manifest.v1",
      mode: `/v2/sessions/current/analysis/frequency-domain/eigen/modes/${options.sampleIndex}/${options.modeIndex}`,
      spectrum: "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2",
    };
    const [fieldResponse, manifestResponse, modeResponse, spectrumResponse] = await Promise.all(
      Object.values(paths).map((path) => getJson({
        apiBase: options.apiBase,
        headers,
        path,
        timeoutMs: options.timeoutMs,
        observations,
      })),
    );
    const transientResponses = [
      fieldResponse,
      manifestResponse,
      modeResponse,
      spectrumResponse,
    ].filter((candidate) =>
      candidate.observation.status === 404 ||
      candidate.observation.status === 409 ||
      candidate.observation.status === 425 ||
      candidate.observation.status === 503,
    );
    if (transientResponses.length > 0 && Date.now() < deadline) {
      lastTransient = `artifact GETs are not published yet: ${JSON.stringify(transientResponses.map(responseSummary))}`;
      await sleep(Math.min(500, Math.max(1, deadline - Date.now())));
      continue;
    }
    const resources = {
      field: requireResponse(fieldResponse, "mode-field metadata"),
      manifest: requireResponse(manifestResponse, "frequency-domain manifest"),
      mode: requireResponse(modeResponse, "selected mode"),
      spectrum: requireResponse(spectrumResponse, "frequency-domain spectrum"),
    };
    const resultManifest = resources.manifest.result_manifest;
    if (resources.manifest.schema_version && !resultManifest) {
      lastTransient = "frequency-domain manifest has no published result_manifest";
      if (Date.now() < deadline) {
        await sleep(Math.min(500, Math.max(1, deadline - Date.now())));
        continue;
      }
      break;
    }
    const missingResources = Object.entries(resources).filter(([, resource]) => resource?.status === "missing");
    if (missingResources.length > 0 && Date.now() < deadline) {
      lastTransient = `artifact resources remain missing: ${missingResources.map(([label]) => label).join(", ")}`;
      await sleep(Math.min(500, Math.max(1, deadline - Date.now())));
      continue;
    }
    const expectedOwner = {
      runId: options.runId,
      sessionId: scope.sessionId,
      stageId: options.stageId,
    };
    const owner = exactResourceOwner(resultManifest, "manifest result", expectedOwner);
    const spectrumOwner = exactResourceOwner(resources.spectrum, "spectrum", { ...expectedOwner, stageId: owner.stageId });
    const modeOwner = exactResourceOwner(resources.mode, "mode", { ...expectedOwner, stageId: owner.stageId });
    assert(resources.field.status === "ready", `mode-field metadata is not ready: ${JSON.stringify(resources.field.status)}`);
    assert(resources.field.generation_status === "member_verified_owner_bound", "mode-field metadata is not owner-bound.");
    assert(resources.field.generation_id === owner.generationId, "mode-field metadata generation differs from the published manifest.");
    assert(nonEmptyString(resources.field.content_digest) && resources.field.content_digest === resources.field.revision, "mode-field metadata lacks matching immutable digest/revision.");
    for (const [label, candidate] of [["spectrum", spectrumOwner], ["mode", modeOwner]]) {
      assert(candidate.generationId === owner.generationId, `${label} generation differs from manifest.`);
      assert(candidate.stageId === owner.stageId, `${label} stage differs from manifest.`);
    }
    const spectrumPayload = unwrapPayload(resources.spectrum);
    const selected = selectedModeFromSpectrum(spectrumPayload, options.sampleIndex, options.modeIndex);
    const modePayload = unwrapPayload(resources.mode);
    assert(Number(modePayload.sample_index) === options.sampleIndex, "Selected mode payload sample identity does not match the request.");
    assert(Number(modePayload.raw_mode_index) === options.modeIndex, "Selected mode payload mode identity does not match the request.");
    const fieldId = nonEmptyString(modePayload.mode_field_id) ?? nonEmptyString(selected.mode.mode_field_id) ?? fieldIdFor(options.sampleIndex, options.modeIndex);
    assert(fieldId === resources.field.field_id, `Mode-field metadata id ${resources.field.field_id} != selected field ${fieldId}.`);
    assert(resources.field.field_id === fieldIdFor(options.sampleIndex, options.modeIndex), `Unexpected field identity ${resources.field.field_id}.`);

    return {
      headers,
      paths,
      run,
      scope,
      status,
      resources,
      resultManifest,
      owner,
      spectrumOwner,
      modeOwner,
      selected,
      fieldId,
      modePayload,
      spectrumPayload,
      runStatus: state,
    };
  }
  throw new Error(`Timed out waiting for immutable modal artifacts: ${lastTransient ?? "no artifact snapshot"}`);
}

function escapeAttribute(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function remainingTimeout(deadline, label) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`Timed out waiting for ${label}.`);
  return remaining;
}

async function pollUntil(deadline, label, check, intervalMs = 250) {
  let lastError = null;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      const result = await check(remaining);
      if (result) return result;
    } catch (error) {
      lastError = String(error?.message ?? error);
    }
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
  throw new Error(
    `Timed out waiting for ${label}.${lastError ? ` Last observation: ${lastError}` : ""}`,
  );
}

async function waitForModeFieldBinaryEvidence(page, proof, uiRequests, uiResponses, deadline) {
  const expectedPath = modeFieldVectorPath(proof.fieldId);
  const expectedQuery = {
    component: "full",
    expected_artifact_generation_id: proof.generationId,
    scope_kind: "full",
    view: "complex",
  };
  const request = await pollUntil(deadline, "exact eigenmode binary request", async () => {
    const candidate = [...uiRequests].reverse().find((entry) =>
      entry.method === "GET" &&
      samePath(entry.path, expectedPath) &&
      entry.sessionScopeHeader === proof.sessionScopeHeader &&
      Object.entries(expectedQuery).every(([key, value]) => entry.query?.[key] === value),
    );
    return candidate ?? false;
  }, 150);
  const response = await pollUntil(deadline, "owner-bound eigenmode binary response", async () => {
    const candidate = [...uiResponses].reverse().find((entry) => {
      const headers = entry.headers ?? {};
      const pointCount = Number(headers["x-fullmag-point-count"]);
      const valueCount = Number(headers["x-fullmag-value-count"]);
      return entry.method === "GET" &&
        samePath(entry.path, expectedPath) &&
        entry.status === 200 &&
        entry.observedAtMs >= request.observedAtMs &&
        headers["x-fullmag-artifact-generation-id"] === proof.generationId &&
        headers["x-fullmag-quantity-id"] === proof.fieldId &&
        headers["x-fullmag-component"] === "full" &&
        headers["x-fullmag-field-indexing"] === "full_domain" &&
        // The native full-domain lane returns no ResolvedFieldScope and omits
        // this optional header. The request above still requires scope_kind=full,
        // and full_domain indexing plus exact generation/quantity remain required.
        (headers["x-fullmag-scope-kind"] == null || headers["x-fullmag-scope-kind"] === "full") &&
        /^FMVP;version=(?:3|5)(?:;.*)?$/i.test(headers["x-fullmag-encoding"] ?? "") &&
        /^application\/octet-stream(?:;|$)/i.test(headers["content-type"] ?? "") &&
        nonEmptyString(headers["x-fullmag-domain-generation-id"]) !== null &&
        nonEmptyString(headers["x-fullmag-mesh-topology-hash"]) !== null &&
        nonEmptyString(headers["x-fullmag-field-revision"]) !== null &&
        headers["x-fullmag-n-comp"] === "6" &&
        Number.isSafeInteger(pointCount) && pointCount > 0 &&
        Number.isSafeInteger(valueCount) && valueCount > 0;
    });
    return candidate ?? false;
  }, 150);
  return {
    path: expectedPath,
    query: request.query,
    requestObservedAtMs: request.observedAtMs,
    requestScopeHeader: request.sessionScopeHeader,
    response,
  };
}

async function waitForModeFieldControllerReady(page, binaryObservedAtMs, deadline) {
  return pollUntil(deadline, "decoded mode field controller ready", async () => {
    const marker = await page.evaluate((name) => {
      const exportArtifact = window.__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__;
      if (typeof exportArtifact !== "function") return null;
      try {
        const artifact = exportArtifact();
        const timeline = artifact?.streams?.timeline;
        if (!Array.isArray(timeline)) return null;
        for (let index = timeline.length - 1; index >= 0; index -= 1) {
          if (timeline[index]?.name === name) return timeline[index];
        }
      } catch {
        return null;
      }
      return null;
    }, MODE_FIELD_CONTROLLER_MARK);
    if (!marker || !Number.isFinite(Number(marker.timestampMs)) ||
        Number(marker.timestampMs) + 1_000 < binaryObservedAtMs) return false;
    const detail = marker.detail ?? {};
    if (detail.controllerStatus !== "ready" ||
        detail.controllerHasError === true ||
        detail.enabled !== true ||
        detail.hasIntent !== true ||
        detail.hasSession !== true ||
        detail.hasTopology !== true ||
        detail.topologyIdentityComplete !== true) return false;
    return {
      name: MODE_FIELD_CONTROLLER_MARK,
      lane: marker.lane ?? null,
      timestampMs: marker.timestampMs,
      detail: {
        controllerStatus: detail.controllerStatus,
        controllerHasError: detail.controllerHasError,
        enabled: detail.enabled,
        hasIntent: detail.hasIntent,
        hasSession: detail.hasSession,
        hasTopology: detail.hasTopology,
        topologyIdentityComplete: detail.topologyIdentityComplete,
      },
    };
  }, 150);
}

async function expandTreeNode(page, nodeId, deadline, probeMs = 4_000) {
  const selector = `[role="treeitem"][data-node-id="${escapeAttribute(nodeId)}"]`;
  const nodeDeadline = Math.min(deadline, Date.now() + probeMs);
  let clickIssued = false;
  try {
    return await pollUntil(nodeDeadline, `Results tree node ${nodeId}`, async (remaining) => {
      const row = page.locator(selector).first();
      if ((await row.count()) === 0 || !(await row.isVisible().catch(() => false))) return false;
      const expanded = await row.getAttribute("aria-expanded");
      if (expanded === "false") {
        if (!clickIssued) {
          const branch = row.locator(".fm-explorer-tree-row__branch").first();
          if ((await branch.count()) > 0) await branch.click({ timeout: remaining });
          else await row.click({ timeout: remaining });
          clickIssued = true;
        }
        return false;
      }
      return true;
    }, 150);
  } catch (error) {
    if (Date.now() >= deadline) throw error;
    return false;
  }
}

async function findModeRow(page, groupId, proof, options, deadline) {
  return pollUntil(deadline, `eigenmode Results row under ${groupId}`, async () =>
    page.locator('[role="treeitem"][data-node-id]').evaluateAll(
      (rows, expected) => rows.map((row) => ({
        id: row.getAttribute("data-node-id"),
        text: (row.textContent ?? "").replace(/\s+/g, " ").trim(),
        visible: (() => {
          const rect = row.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })(),
      })).find((row) => row.visible && row.id?.startsWith(`${expected.groupId}:`) && (
        row.id.includes(expected.encodedFieldId) ||
        row.text.includes(`Sample ${expected.sampleIndex}`) && row.text.includes(`Mode ${expected.modeIndex}`)
      )),
      {
        encodedFieldId: encodeURIComponent(proof.fieldId),
        groupId,
        modeIndex: options.modeIndex,
        sampleIndex: options.sampleIndex,
      },
    ),
  150);
}

async function selectModeInResultsTree(page, proof, options, deadline) {
  const resultsTab = page.locator(".fm-explorer .fm-tabs-trigger").filter({ hasText: /^Results$/ }).first();
  await pollUntil(deadline, "Results explorer tab", async (remaining) => {
    if ((await resultsTab.count()) === 0) return false;
    if ((await resultsTab.getAttribute("aria-selected")) !== "true") {
      await resultsTab.click({ timeout: remaining });
    }
    return (await resultsTab.getAttribute("aria-selected")) === "true";
  }, 150);
  const rootId = `results:run:${encodeURIComponent(options.runId)}`;
  if (!(await expandTreeNode(
    page,
    rootId,
    deadline,
    remainingTimeout(deadline, "Results run tree root"),
  ))) return false;
  const stageKey = encodeURIComponent(proof.owner.stageId);
  const familyIds = ["resonance", "k-resolved"];
  const groupSuffixes = ["modes", "modes-at-k"];
  const familyId = await pollUntil(deadline, "modal Results family", async () => {
    for (const family of familyIds) {
      const candidate = page.locator(
        `[role="treeitem"][data-node-id="${escapeAttribute(`${rootId}:${family}`)}"]`,
      ).first();
      if ((await candidate.count()) > 0 && await candidate.isVisible().catch(() => false)) {
        return `${rootId}:${family}`;
      }
    }
    return false;
  }, 150);
  if (!(await expandTreeNode(
    page,
    familyId,
    deadline,
    remainingTimeout(deadline, "modal Results family expansion"),
  ))) return false;
  const stageId = `${familyId}:stage:${stageKey}:modal_eigen`;
  if (!(await expandTreeNode(
    page,
    stageId,
    deadline,
    remainingTimeout(deadline, "modal Results stage"),
  ))) return false;
  const groupId = await pollUntil(deadline, "modal eigenmode Results group", async () => {
    for (const suffix of groupSuffixes) {
      const candidate = page.locator(
        `[role="treeitem"][data-node-id="${escapeAttribute(`${stageId}:${suffix}`)}"]`,
      ).first();
      if ((await candidate.count()) > 0 && await candidate.isVisible().catch(() => false)) {
        return `${stageId}:${suffix}`;
      }
    }
    return false;
  }, 150);
  if (!(await expandTreeNode(
    page,
    groupId,
    deadline,
    remainingTimeout(deadline, "modal eigenmode Results group expansion"),
  ))) return false;
  const selectedRow = await findModeRow(page, groupId, proof, options, deadline);
  const row = page.locator(`[role="treeitem"][data-node-id="${escapeAttribute(selectedRow.id)}"]`).first();
  await row.click({ timeout: remainingTimeout(deadline, "requested eigenmode Results row") });
  proof.selection = { nodeId: selectedRow.id, label: selectedRow.text };
  return true;
}

async function inspectVisibleField(page, options, proof, deadline) {
  const activeField = page.locator('[data-active-analysis-field="true"]').first();
  const activeFieldProof = (await activeField.count()) > 0 &&
      await activeField.isVisible().catch(() => false)
    ? await activeField.evaluate((node) => ({
        label: (node.textContent ?? "").replace(/\s+/g, " ").trim(),
        nodeId: node.getAttribute("data-node-id"),
        rect: (() => {
          const rect = node.getBoundingClientRect();
          return { height: rect.height, width: rect.width, x: rect.x, y: rect.y };
        })(),
        selector: '[data-active-analysis-field="true"]',
      }))
    : null;
  const eigenInspector = page.locator('[data-inspector-owner="frequency-domain.eigen-mode"]').first();
  const inspectorText = await pollUntil(
    deadline,
    "eigenmode inspector identity",
    async () => {
      if ((await eigenInspector.count()) === 0 || !(await eigenInspector.isVisible().catch(() => false))) return false;
      const text = await eigenInspector.innerText();
      return text.includes(proof.fieldId) &&
        text.includes(`sample ${options.sampleIndex}, mode ${options.modeIndex}`)
        ? text
        : false;
    },
    150,
  );
  assert(
    inspectorText.includes(proof.fieldId),
    `Eigenmode inspector does not expose the requested field ID ${proof.fieldId}.`,
  );
  assert(
    inspectorText.includes(`sample ${options.sampleIndex}, mode ${options.modeIndex}`),
    "Eigenmode inspector does not expose the requested sample/mode identity.",
  );
  const controls = eigenInspector.locator(
    '[aria-label="Selected eigen mode 3D visualization controls"]',
  );
  await controls.waitFor({ state: "visible", timeout: remainingTimeout(deadline, "eigenmode 3D controls") });
  const activeViews = controls.locator('button[aria-pressed="true"]');
  // Selecting Results establishes ownership; explicitly request the rendered
  // component through the same inspector action available to the user.
  if (await activeViews.count() === 0) {
    const rotated = controls.getByRole("button", {
      name: "Plot selected eigen mode with phase-rotated real display", exact: true,
    });
    await rotated.click({ timeout: remainingTimeout(deadline, "plot eigenmode component") });
  }
  await pollUntil(
    deadline,
    "active eigenmode 3D visualization view",
    async () => {
      const count = await activeViews.count();
      if (count > 1) throw new Error(`found ${count} active views`);
      return count === 1;
    },
    150,
  );
  if (activeFieldProof) {
    assert(
      activeFieldProof.nodeId?.includes(encodeURIComponent(proof.fieldId)) ||
        activeFieldProof.nodeId?.includes(proof.fieldId),
      "The active Results field row does not expose the requested eigenmode field identity.",
    );
  }

  const canvas = page.locator(".fm-viewport-3d canvas").first();
  const webgl = await pollUntil(
    deadline,
    "visible mode field WebGL canvas",
    async () => {
      if ((await canvas.count()) === 0 || !(await canvas.isVisible().catch(() => false))) return false;
      const state = await canvas.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const gl2 = node.getContext("webgl2");
        const gl = gl2 ?? node.getContext("webgl");
        return {
          canvasHeight: node.height,
          canvasWidth: node.width,
          context: gl2 ? "webgl2" : gl ? "webgl" : null,
          cssHeight: rect.height,
          cssWidth: rect.width,
          drawingBufferHeight: gl?.drawingBufferHeight ?? 0,
          drawingBufferWidth: gl?.drawingBufferWidth ?? 0,
          isContextLost: gl?.isContextLost() ?? true,
        };
      });
      if (!state.context || state.cssWidth <= 0 || state.cssHeight <= 0 || state.isContextLost ||
          state.drawingBufferWidth <= 0 || state.drawingBufferHeight <= 0) return false;
      return state;
    },
    150,
  );
  return {
    activeField: activeFieldProof,
    activeView: await activeViews.first().getAttribute("aria-label"),
    inspectorText,
    webgl,
  };
}

async function openAndInspectUi(page, options, proof, uiEvidence, deadline) {
  await page.addInitScript(({ apiBase }) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      controlRoomApiBase: apiBase,
      enableDiagnosticRecorder: true,
    };
  }, { apiBase: options.apiBase });

  await page.goto(options.url, {
    timeout: remainingTimeout(deadline, "Control Room page"),
    waitUntil: "domcontentloaded",
  });
  await page.locator("main").first().waitFor({ state: "visible", timeout: remainingTimeout(deadline, "Control Room shell") });
  const analysisTab = page.locator(".fm-viewport-tabs__trigger").filter({ hasText: /^Analysis$/ }).first();
  if ((await page.locator(".fm-analysis-plots").count()) === 0) {
    await analysisTab.waitFor({ state: "visible", timeout: remainingTimeout(deadline, "workspace Analysis tab") });
    await analysisTab.click({ timeout: remainingTimeout(deadline, "Analysis tab") });
  }
  await page.locator(".fm-analysis-plots").waitFor({ state: "visible", timeout: remainingTimeout(deadline, "analysis surface") });

  if (options.selectMode) {
    const selected = await selectModeInResultsTree(page, proof, options, deadline);
    assert(selected, "Could not locate the requested eigenmode field in the live Results tree; pass --no-select-mode only when the field is already selected.");
    const modelTab = page.locator(".fm-viewport-tabs__trigger").filter({ hasText: /^(Model|3D Viewport)$/ }).first();
    if ((await modelTab.count()) > 0 && (await modelTab.getAttribute("aria-selected")) !== "true") {
      await modelTab.click({ timeout: remainingTimeout(deadline, "Model tab") });
    }
  }
  const visibleField = await inspectVisibleField(page, options, proof, deadline);
  uiEvidence.pageUrl = page.url();
  uiEvidence.visibleField = visibleField;
  uiEvidence.analysisSurface = await page.locator(".fm-analysis-plots__surface-title").getAttribute("data-analysis-surface-title").catch(() => null);
  uiEvidence.analysisChartCanvas = await page.locator(".fm-analysis-chart-surface canvas").evaluateAll((nodes) => nodes.map((node) => {
    const rect = node.getBoundingClientRect();
    return { cssHeight: rect.height, cssWidth: rect.width, height: node.height, width: node.width };
  }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const observations = [];
  const mutationAttempts = [];
  const visualizationRequests = [];
  const browserConsole = { errors: [], warnings: [], pageErrors: [] };
  const uiRequests = [];
  const uiResponses = [];
  const report = {
    schemaVersion: "fullmag.eigen_mode_ui_verification.v1",
    status: "failed",
    startedAt: new Date().toISOString(),
    config: {
      apiBase: options.apiBase,
      expectedRunId: options.runId,
      expectedStageId: options.stageId,
      modeIndex: options.modeIndex,
      output: options.output,
      sampleIndex: options.sampleIndex,
      selectMode: options.selectMode,
      timeoutMs: options.timeoutMs,
      url: options.url,
    },
    api: { observations },
    browser: { console: browserConsole, requests: uiRequests, responses: uiResponses },
    safety: {
      mutationAttempts,
      mutationRequestsAborted: true,
      visualizationRequests,
      permittedApiMethods: ["GET", "HEAD", "OPTIONS"],
      permittedVisualizationMutations: [
        "PATCH /v2/sessions/current/visualization/state",
        "POST /v2/sessions/current/visualization/client-acks",
      ],
    },
  };
  let browser = null;
  let context = null;
  let page = null;
  try {
    const artifactProof = await collectArtifacts(options, observations);
    report.run = {
      requested: options.runId,
      status: artifactProof.runStatus,
      currentRun: {
        runId: artifactProof.run.run_id,
        revision: artifactProof.run.revision ?? null,
        status: artifactProof.run.status ?? null,
      },
      session: artifactProof.scope,
    };
    report.artifacts = {
      owner: {
        artifactSetId: artifactProof.resultManifest.artifact_set_id ?? null,
        sessionId: artifactProof.owner.sessionId ?? artifactProof.scope.sessionId,
        runId: artifactProof.owner.runId ?? options.runId,
        stageId: artifactProof.owner.stageId,
      },
      generationId: artifactProof.owner.generationId,
      members: {
        manifest: artifactEvidence(artifactProof.resultManifest, "manifest result"),
        spectrum: artifactEvidence(artifactProof.resources.spectrum, "spectrum"),
        mode: artifactEvidence(artifactProof.resources.mode, "mode"),
        field: artifactEvidence(artifactProof.resources.field, "mode field metadata"),
      },
      sample: {
        sampleId: artifactProof.selected.sample.sample_id ?? null,
        sampleIndex: artifactProof.selected.sample.sample_index,
      },
      mode: {
        fieldId: artifactProof.fieldId,
        modeId: artifactProof.selected.mode.mode_id ?? null,
        modeIndex: artifactProof.selected.mode.raw_mode_index,
        frequencyHz: artifactProof.selected.mode.frequency_hz ?? null,
        payloadSampleIndex: artifactProof.modePayload.sample_index,
        payloadRawModeIndex: artifactProof.modePayload.raw_mode_index,
      },
    };

    const playwright = await loadPlaywright();
    browser = await playwright.chromium.launch({ headless: !options.headed });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    page = await context.newPage();
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (SAFE_HTTP_METHODS.has(request.method())) {
        await route.continue();
        return;
      }
      const path = pathForUrl(request.url());
      const sameApiOrigin = new URL(request.url()).origin === new URL(options.apiBase).origin;
      const visualizationOnly = sameApiOrigin && (
        request.method() === "PATCH" && path === "/v2/sessions/current/visualization/state" ||
        request.method() === "POST" && path === "/v2/sessions/current/visualization/client-acks"
      );
      if (visualizationOnly) {
        visualizationRequests.push({ method: request.method(), path, url: request.url() });
        await route.continue();
        return;
      }
      mutationAttempts.push({ method: request.method(), path, url: request.url() });
      await route.abort("blockedbyclient");
    });
    page.on("console", (message) => {
      if (message.type() === "error") browserConsole.errors.push(message.text());
      if (message.type() === "warning") browserConsole.warnings.push(message.text());
    });
    page.on("pageerror", (error) => browserConsole.pageErrors.push(error.stack ?? error.message));
    page.on("request", (request) => {
      const path = pathForUrl(request.url());
      if (path.startsWith("/v2/")) {
        const headers = request.headers();
        uiRequests.push({
          method: request.method(),
          path,
          query: queryForUrl(request.url()),
          observedAtMs: Date.now(),
          sessionScopeHeader: headers["x-fullmag-session-scope"] ?? null,
        });
      }
    });
    page.on("response", (response) => {
      const path = pathForUrl(response.url());
      if (path.startsWith("/v2/")) {
        uiResponses.push({
          method: response.request().method(),
          path,
          query: queryForUrl(response.url()),
          status: response.status(),
          observedAtMs: Date.now(),
          headers: selectedResponseHeaders(response.headers()),
        });
      }
    });
    const uiEvidence = { pageUrl: options.url, visibleField: null };
    report.ui = uiEvidence;
    const uiDeadline = Date.now() + options.timeoutMs;
    await openAndInspectUi(page, options, {
      fieldId: report.artifacts.mode.fieldId,
      generationId: report.artifacts.generationId,
      modeIndex: options.modeIndex,
      owner: { stageId: report.artifacts.owner.stageId },
      sampleIndex: options.sampleIndex,
      sessionScopeHeader: artifactProof.headers["x-fullmag-session-scope"],
    }, uiEvidence, uiDeadline);
    const binaryEvidence = await waitForModeFieldBinaryEvidence(
      page,
      {
        fieldId: report.artifacts.mode.fieldId,
        generationId: report.artifacts.generationId,
        sessionScopeHeader: artifactProof.headers["x-fullmag-session-scope"],
      },
      uiRequests,
      uiResponses,
      uiDeadline,
    );
    report.ui.modeFieldBinary = binaryEvidence;
    report.ui.modeFieldController = await waitForModeFieldControllerReady(
      page,
      binaryEvidence.response.observedAtMs,
      uiDeadline,
    );
    const fitView = page.getByRole("button", { name: "Fit view", exact: true });
    await fitView.click({ timeout: Math.max(uiDeadline - Date.now(), 1) });
    report.ui.modeViewportBounds = await page.locator("[data-viewport-bounds]").first()
      .getAttribute("data-viewport-bounds");
    report.ui.displayChecks = [];
    for (const [view, label] of [
      ["real", "Plot selected eigen mode real component"],
      ["imag", "Plot selected eigen mode imaginary component"],
      ["abs", "Plot selected eigen mode complex magnitude"],
      ["phase", "Plot selected eigen mode phase"],
    ]) {
      const control = page.getByRole("button", { name: label, exact: true });
      await control.click();
      const binding = await pollUntil(Date.now() + 15000, `${view} complex surface binding`, async () => {
        if (await control.getAttribute("aria-pressed") !== "true") return false;
        const marker = await page.evaluate(() =>
          (window.__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__?.()?.streams?.timeline ?? [])
            .filter((entry) => entry.name === "viewport-3d.mode-surface-binding").at(-1));
        const detail = marker?.detail;
        return detail?.bufferRepresentation === view && detail?.complexValueCount > 0 &&
          detail?.rgbValueCount === 0 && detail?.bufferQuantity === report.artifacts.mode.fieldId &&
          detail?.requestedQuantity === report.artifacts.mode.fieldId ? detail : false;
      });
      await sleep(750);
      const screenshot = report.config.output.replace(/\.json$/i, "") + `-${view}.png`;
      await page.screenshot({ path: screenshot, fullPage: true });
      report.ui.displayChecks.push({ view, binding, screenshot });
    }
    assert(mutationAttempts.length === 0, `The UI attempted ${mutationAttempts.length} mutating HTTP request(s); they were blocked for safety: ${JSON.stringify(mutationAttempts.slice(0, 8))}`);
    assert(browserConsole.errors.length === 0, `Unexpected browser console errors: ${JSON.stringify(browserConsole.errors.slice(0, 8))}`);
    assert(browserConsole.pageErrors.length === 0, `Unexpected browser page errors: ${JSON.stringify(browserConsole.pageErrors.slice(0, 8))}`);
    const requiredUiPaths = [
      "/v2/sessions/current/analysis/frequency-domain/manifest.v1",
      "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2",
      `/v2/sessions/current/analysis/frequency-domain/eigen/modes/${options.sampleIndex}/${options.modeIndex}`,
      `/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/${options.sampleIndex}/${options.modeIndex}/meta`,
    ];
    report.ui.requiredApiPaths = requiredUiPaths.map((path) => ({
      path,
      requested: uiRequests.some((request) => request.method === "GET" && request.path === path),
      responded: uiResponses.some((response) => response.method === "GET" && response.path === path && response.status >= 200 && response.status < 300),
    }));
    for (const evidence of report.ui.requiredApiPaths) {
      assert(evidence.requested, `The live UI did not request ${evidence.path}.`);
      assert(evidence.responded, `The live UI did not receive a successful response for ${evidence.path}.`);
    }
    report.status = "passed";
  } catch (error) {
    report.error = String(error?.stack ?? error);
    throw error;
  } finally {
    if (page) {
      report.ui.modeControllerDiagnostics = await page.evaluate(() => {
        const artifact = window.__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__?.();
        return (artifact?.streams?.timeline ?? []).filter((entry) =>
          entry.name?.startsWith("viewport-3d.mode-field-overlay"),
        ).slice(-12);
      }).catch((error) => ({ error: String(error) }));
      const screenshot = report.config.output.replace(/\.json$/i, "") + ".png";
      try {
        await page.screenshot({ fullPage: true, path: screenshot });
        report.screenshot = screenshot;
      } catch (error) {
        report.screenshotError = String(error?.message ?? error);
      }
    }
    if (context) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    report.finishedAt = new Date().toISOString();
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
}

main().catch((error) => {
  console.error(`Eigen mode UI verification failed: ${error?.stack ?? error}`);
  process.exitCode = 1;
});
