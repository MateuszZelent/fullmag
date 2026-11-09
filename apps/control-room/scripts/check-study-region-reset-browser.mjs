// Fixed S46 browser flows. All solver and authoring writes originate in real UI actions.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { startBrowserQaLoopbackProxy } from "./lib/browser-qa-loopback-proxy.mjs";
import {
  buildStageBRegionObjectTextureResetTransaction, buildStageBEnabledTransaction,
  fillStageBRegionObjectTextureResetInInspector, setStageBStudyInclusionInInspector,
  saveStageBStudyChangeAndWaitForAck, validateStageBRegionObjectTextureResetExchange,
  validateStageBEnabledExchange,
} from "./lib/study-region-reset-browser-qa.mjs";
import {
  studyStageCameraPatchAllowed, studyStageRerunClientAckAllowed,
  studyStageResultIdentity, studyStageTerminalScope,
} from "./check-study-stage-rerun-browser.mjs";

const schema = "fullmag.docker-dev-region-reset-result.v1";
const modes = ["s46-local-export", "s46-independent-export", "s46-local-import", "s46-independent-import"];
const stages = ["relax-a", "relax-b", "relax-c"];
const base = "/v2/sessions/current/";
const commandsPath = base + "simulation/commands";
const scenePath = base + "model/scene";
const transactionsPath = base + "model/transactions";
const scriptImportPath = "/v2/persistence/projects/from-script";
const canonical = (value) => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sort(value[k])]));
  return value;
}
const hash = (value) => createHash("sha256").update(value).digest("hex");
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (left, right) => canonical(left) === canonical(right);
const scope = (session) => "session=" + encodeURIComponent(session.session_id) + "&epoch=" +
  encodeURIComponent(session.session_epoch) + "&request_scope_epoch=" + encodeURIComponent(session.request_scope_epoch);
const prefixKeys = ["region_topology_revision", "region_membership_revision", "region_coefficients_revision",
  "region_initial_state_revision", "scene_revision", "mesh_revision"];

const readTimeoutObservationCountLimit = 32;
const readTimeoutElapsedMsLimit = 120000;
const apiRequestContextGetTimeout = /^apiRequestContext\.get: Timeout ([0-9]+)ms exceeded\./;

/** Record only the known APIRequestContext.get timeout shape; all other read failures remain fatal. */
export async function regionResetObserveGet(read, request, report) {
  const startedAt = Date.now();
  try {
    return { kind: "response", value: await read() };
  } catch (error) {
    const timeoutMs = Number(apiRequestContextGetTimeout.exec(
      typeof error?.message === "string" ? error.message : "",
    )?.[1]);
    const observations = report?.read_timeout_observations;
    if (!Number.isSafeInteger(timeoutMs) || !Array.isArray(observations) ||
        observations.length >= readTimeoutObservationCountLimit) throw error;
    assert.equal(request?.method, "GET", "Only GET read timeouts can be observed");
    assert(typeof request.path === "string" && request.path.length <= 1024);
    assert(typeof request.phase === "string" && request.phase.length <= 64);
    assert(typeof request.api_instance_id === "string" && request.api_instance_id.length <= 128);
    assert(typeof request.session_scope === "string" && request.session_scope.length <= 512);
    observations.push({
      method: "GET",
      path: request.path,
      phase: request.phase,
      api_instance_id: request.api_instance_id,
      session_scope: request.session_scope,
      timeout_ms: timeoutMs,
      elapsed_ms: Math.min(readTimeoutElapsedMsLimit, Math.max(0, Date.now() - startedAt)),
    });
    return { kind: "read_timeout" };
  }
}

export function regionResetExpectedComputePrecondition(status, solver, queue) {
  const result = {};
  for (const key of prefixKeys) {
    assert(Number.isSafeInteger(status?.resources?.[key]) && status.resources[key] >= 0, "Missing revision " + key);
    result[key] = status.resources[key];
  }
  if (status.resources.domain_generation_id) result.domain_generation_id = status.resources.domain_generation_id;
  result.current_run = status.run ? { kind: "run", run_id: status.run.run_id } : { kind: "none" };
  assert(typeof solver?.runtime_state === "string" && solver.runtime_state, "Missing solver state");
  assert(Array.isArray(queue?.commands), "Missing command ledger");
  result.runtime_state = solver.runtime_state;
  result.command_revision = queue.commands.length;
  return result;
}

function validStorage(value, defaults) {
  if (!record(value) || !record(defaults)) return false;
  const within = (path, parent) => typeof path === "string" && typeof parent === "string" &&
    path.startsWith(parent.replace(/\/$/, "") + "/") && posix.normalize(path) === path &&
    path.startsWith("/") && !path.includes("\\") && !path.includes("\0");
  const temporary = defaults.temp_parent?.trim() || defaults.output_parent.replace(/\/$/, "") + "/.fullmag-tmp";
  return same(Object.keys(value).sort(), ["output_dir", "temp_dir", "data_format", "cleanup", "existing_output"].sort()) &&
    within(value.output_dir, defaults.output_parent) && value.temp_dir === temporary &&
    posix.normalize(value.temp_dir) === value.temp_dir &&
    value.output_dir !== value.temp_dir && !value.output_dir.startsWith(value.temp_dir + "/") &&
    !value.temp_dir.startsWith(value.output_dir + "/") &&
    value.data_format === (defaults.data_format ?? "zarr") &&
    value.cleanup === (defaults.cleanup ?? "on_success") &&
    value.existing_output === (defaults.existing_output ?? "timestamp") &&
    defaults.supported_formats?.includes(value.data_format);
}

/** Fail closed before forwarding any UI write; the caller supplies the exact current phase and scope. */
export function regionResetWriteAllowed(request, gate) {
  const { method, path, headers = {}, body } = request;
  if (headers["x-fullmag-api-instance"] !== gate.apiInstance) return false;
  const scoped = gate.session && headers["x-fullmag-session-scope"] === scope(gate.session);
  if (method === "POST" && path === scriptImportPath) {
    return gate.phase === "import" && gate.importAttempts === 0 &&
      same(body, { source: { name: gate.sourceName, text: gate.sourceText },
        project_name: gate.sourceName.replace(/\.py$/i, ""), origin: "python:" + gate.sourceName,
        consent: { executed_by_user: true } });
  }
  if (method === "POST" && path === "/v2/sessions") {
    return gate.phase === "import" && gate.createAttempts === 0 && record(gate.project) &&
      same(Object.keys(body ?? {}).sort(), ["name", "backend", "device", "precision", "replace_current", "output_storage"].sort()) &&
      body.name === gate.project.name && body.backend === "fdm" && body.device === "cpu" &&
      body.precision === "double" && body.replace_current === false &&
      (gate.project.scene_document?.study?.output_storage
        ? same(body.output_storage, gate.project.scene_document.study.output_storage)
        : validStorage(body.output_storage, gate.storageDefaults));
  }
  if (!scoped) return false;
  if (method === "POST" && path === transactionsPath) {
    return gate.phase === "import" ? gate.replaceAttempts === 0 && same(body, gate.expectedReplacement)
      : ["region-reset", "disable", "enable"].includes(gate.phase) &&
        gate.editAttempts === 0 && same(body, gate.expectedEdit);
  }
  if (method === "POST" && path === base + "model/syncs") {
    return gate.phase === "export" && gate.syncAttempts === 0 &&
      same(body, { expected_scene_revision: gate.sceneRevision });
  }
  if (method === "POST" && path === commandsPath) {
    if (body?.kind === "fdm_grid_refresh") {
      return gate.phase === "build-study" && gate.gridAttempts === 0 &&
        same(Object.keys(body).sort(), ["client_intent_id", "kind", "precondition", "reason"].sort()) &&
        body.reason === "explicit_build_grid" && /^mesh-confirm-[0-9]+-[0-9]+$/.test(body.client_intent_id) &&
        body.precondition?.scene_revision === gate.sceneRevision &&
        same(body.precondition, gate.expectedGridPrecondition);
    }
    const isStage = gate.phase === "stage-b";
    const target = isStage ? { kind: "stage_id", stage_id: "relax-b" } : { kind: "study" };
    const keys = ["kind", "target", "precondition", "client_intent_id", "reason", "requested_at_unix_ms",
      ...(isStage ? ["initial_state"] : [])].sort();
    return ["build-study", "stage-b"].includes(gate.phase) &&
      (isStage || (gate.gridAcknowledged === true && gate.gridReady === true)) && gate.solverAttempts === 0 &&
      same(Object.keys(body ?? {}).sort(), keys) && body.kind === (isStage ? "relax" : "solve") &&
      same(body.target, target) && (!isStage || same(body.initial_state, { kind: "default_for_target" })) &&
      same(body.precondition, gate.expectedComputePrecondition) &&
      typeof body.client_intent_id === "string" &&
      body.client_intent_id.startsWith("study:" + (isStage ? "relax:" : "solve:")) &&
      body.client_intent_id.length <= 128 && body.reason === "user_requested" &&
      Number.isSafeInteger(body.requested_at_unix_ms) && body.requested_at_unix_ms > 0;
  }
  return ((gate.cameraAttempts ?? 0) < 4 &&
    studyStageCameraPatchAllowed({ method, path, body, scope: headers["x-fullmag-session-scope"] }, gate.session)) ||
    ((gate.clientAckAttempts ?? 0) < 16 && ["applied", "rendered"].includes(body?.status) &&
    studyStageRerunClientAckAllowed({ method, path, body, scope: headers["x-fullmag-session-scope"] }, gate.session));
}

const failedWriteResponseByteLimit = 2 * 1024 * 1024;
const failedWriteResponsePrefixByteLimit = 16 * 1024;
const failedWriteObservationCountLimit = 32;

/** Fetch one already-authorized UI write and preserve bounded same-API HTTP failures for the UI. */
export async function regionResetFetchWriteResponse({ route, request, apiInstance, report, timeout }) {
  assert.equal(request?.headers?.["x-fullmag-api-instance"], apiInstance, "Write request from another API");
  const response = await route.fetch({ timeout });
  const responseHeaders = response.headers();
  assert.equal(responseHeaders["x-fullmag-api-instance"], apiInstance, "Write response from another API");
  if (response.ok()) return response;
  assert(Array.isArray(report.failed_write_observations), "Missing bounded write-failure observations");
  assert(report.failed_write_observations.length < failedWriteObservationCountLimit,
    "UI write failure observation count exceeds its bound");

  const contentLength = responseHeaders["content-length"];
  if (contentLength !== undefined) {
    const declaredBytes = Number(contentLength);
    assert(/^(0|[1-9]\d*)$/.test(contentLength) && Number.isSafeInteger(declaredBytes) &&
      declaredBytes <= failedWriteResponseByteLimit, "UI write failure response exceeds its byte bound");
  }
  const raw = await response.body();
  assert(Buffer.isBuffer(raw) && raw.byteLength <= failedWriteResponseByteLimit,
    "UI write failure response exceeds its byte bound");
  const prefix = raw.subarray(0, failedWriteResponsePrefixByteLimit);
  report.failed_write_observations.push({
    method: request.method,
    path: request.path,
    request_body: request.body,
    session_scope: request.headers["x-fullmag-session-scope"] ?? null,
    api_instance_id: apiInstance,
    http_status: response.status(),
    response_sha256: hash(raw),
    response_bytes: raw.byteLength,
    response_body_prefix_base64: prefix.toString("base64"),
    response_body_prefix_bytes: prefix.byteLength,
    response_body_truncated: raw.byteLength > prefix.byteLength,
  });
  await route.fulfill({ response });
  const error = new Error("UI write failed HTTP" + response.status() + " " + request.path);
  error.regionResetResponseForwarded = true;
  throw error;
}

export async function regionResetHandleWriteFailure(route, report, error) {
  report.violations.push(String(error?.message ?? error).slice(0,512));
  if (error?.regionResetResponseForwarded !== true) await route.abort().catch(() => {});
}

export function regionResetCommandBindingMatches(binding, target, runId, previousRun) {
  return record(binding) && binding.run_id === runId && runId !== previousRun &&
    same(binding.requested_target, target) &&
    (target.kind === "stage_id" ? binding.step_id === target.stage_id : binding.step_id == null);
}

export function regionResetValidateImportedSource(payload, sourceName, sourceText) {
  assert(typeof payload?.project_id === "string" && payload.project_id, "Missing imported project ID");
  assert(record(payload.scene_document), "Imported scene is absent");
  assert.equal(payload.script_import?.name, sourceName, "Import returned another source name");
  assert.equal(payload.script_import?.sha256, hash(sourceText), "Import stored different source bytes");
  assert.equal(payload.script_import?.origin, "python:" + sourceName);
  assert.equal(payload.script_import?.fidelity?.scene_exported, true);
  assert.equal(payload.script_import?.fidelity?.round_trip, "verified", "Import scene round trip is unqualified");
}

export function regionResetValidateImportAck(ack, expectedReplacement) {
  assert.equal(ack?.transaction_kind, "replace_scene");
  const revision = expectedReplacement.base_revision + 1;
  assert.equal(ack.scene_revision, revision, "Imported scene ACK revision differs");
  assert.deepEqual(ack.committed_scene, { ...expectedReplacement.scene, revision },
    "Imported scene ACK changed authored data");
  return ack.committed_scene;
}

export function regionResetAssertExecutionIdentity(execution, session, runId) {
  assert.equal(execution?.run_id, runId, "Stage execution belongs to another run");
  for (const key of ["session_id", "session_epoch", "request_scope_epoch"]) {
    assert.equal(execution?.[key], session[key], "Stage execution changed " + key);
  }
}

export function regionResetValidateSync(sync, text, revision) {
  assert.equal(sync?.scene_revision, revision, "Canonical export ACK revision differs");
  assert.equal(sync?.source, text, "Downloaded source differs from acknowledged scene sync");
}

export function regionResetGridIsReady({ status, queue, preparation, run, execution, solver, session,
  sceneRevision, gridCommandId }) {
  const last = queue?.commands?.at(-1);
  assert(last?.command_id === gridCommandId && last.kind === "fdm_grid_refresh" && last.status === "completed",
    "Study Compute requires its exact successfully completed grid command");
  assert.equal(queue.pending_count, 0); assert.equal(queue.running_count, 0);
  assert.equal(queue.revision, status?.resources?.commands_revision);
  assert.equal(status.resources.scene_revision, sceneRevision);
  assert.equal(status.domain?.discretization, "fdm");
  assert.equal(status.domain?.cell_count, 8);
  assert(status.resources.domain_generation_id && status.resources.domain_generation_id === status.domain.generation_id);
  assert.equal(run?.status, "waiting_for_solve");
  assert.equal(status.run?.run_id, run.run_id); assert.equal(run.session_id, session.session_id);
  assert.equal(status.solver?.state, "awaiting_command"); assert.equal(solver?.runtime_state, "awaiting_command");
  regionResetAssertExecutionIdentity(execution, session, run.run_id);
  assert.equal(execution.runtime_state, "awaiting_command");
  assert.deepEqual(execution.stage_statuses, stages.map(() => "pending"));
  assert.deepEqual(execution.completed_stage_indexes, []);
  assert.equal(preparation?.status, "ready"); assert.equal(preparation.failure ?? null, null);
  assert.equal(preparation.revision, status.resources.simulation_preparation_revision);
  assert.equal(preparation.receipt?.schema_version, "preparation_receipt.v1");
  assert.equal(preparation.receipt.run_id, run.run_id);
  assert.equal(preparation.receipt.preparation_id, preparation.preparation_id);
  assert(/^sha256:[0-9a-f]{64}$/.test(preparation.receipt.plan_fingerprint));
  assert(/^[0-9a-f]{64}$/.test(preparation.receipt.payload_sha256));
  return true;
}

export function regionResetReadCancellationAllowed(row, { apiInstance, observedCount }) {
  return row.method === "GET" && row.path === "/v2/platform/health" &&
    row.failure === "net::ERR_ABORTED" && ["preflight", "import", "reload"].includes(row.phase) &&
    typeof apiInstance === "string" && apiInstance.length > 0 && row.api_instance_id === apiInstance &&
    Number.isSafeInteger(observedCount) && observedCount >= 0 && observedCount < 4;
}

export function regionResetHealthResponseMatches(row, apiInstance) {
  return row.method === "GET" && row.path === "/v2/platform/health" && row.status === 200 &&
    typeof apiInstance === "string" && apiInstance.length > 0 && row.api_instance_id === apiInstance;
}

export function regionResetPinnedHomeUrl(publicUrl, apiInstance) {
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(apiInstance),
    "The workspace must pin the observed API incarnation");
  const url = new URL("/home", publicUrl);
  url.searchParams.set("fullmag_api_instance", apiInstance);
  return url.href;
}

function identity(status, expectedId) {
  const session = status?.session;
  assert(record(session) && (!expectedId || session.session_id === expectedId), "Unexpected active session");
  for (const key of ["session_id", "session_epoch", "request_scope_epoch"]) {
    assert(typeof session[key] === "string" && session[key] && session[key].length <= 512, "Session scope absent");
  }
  return Object.fromEntries(["session_id", "session_epoch", "request_scope_epoch"].map((key) => [key, session[key]]));
}

function pipelineStages(scene) {
  const output = [], seen = new Set();
  const visit = (nodes) => {
    assert(Array.isArray(nodes), "Missing canonical pipeline nodes");
    for (const node of nodes) {
      assert(!seen.has(node.id), "Duplicate authored node ID");
      seen.add(node.id);
      if (node.node_kind === "group") visit(node.children);
      else { assert.equal(node.node_kind, "primitive"); output.push(node); }
    }
  };
  visit(scene?.study?.study_pipeline?.nodes);
  assert.deepEqual(output.map((item) => item.id), stages);
  assert(output.every((item) => item.stage_kind === "relax"), "Unexpected stage kind");
  const magnets = scene.objects.filter((item) => item.role === "magnet");
  assert.equal(magnets.length, 1);
  assert.equal(magnets[0].id, "film");
  assert.equal(magnets[0].regions.filter((r) => r.region_id === "left-half" && r.enabled !== false).length, 1);
  return output;
}

async function sourceHashes(paths) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const output = {};
  assert(record(paths) && Object.keys(paths).length >= 20 && Object.keys(paths).length <= 32, "Unpinned source map");
  for (const [key, relative] of Object.entries(paths)) {
    assert(typeof relative === "string" && !relative.startsWith("/") && !relative.split("/").includes("..") &&
      /^(apps\/control-room\/|examples\/interactive_study\/)/.test(relative), "Source path outside fixed QA roots");
    output[key] = hash(await fs.readFile(key === "fixture" ? "/opt/fullmag/p22-fixture.py" : resolve(root, relative)));
  }
  return output;
}

export async function runRegionResetBrowserQa() {
  const mode = process.argv[2];
  assert.equal(process.argv.length, 3);
  assert(modes.includes(mode));
  assert.equal(process.env.CONTROL_ROOM_BROWSER_QA_SCENARIO, "study-stage-rerun");
  assert.equal(process.env.CONTROL_ROOM_STUDY_STAGE_RERUN_MODE, mode);
  const isImport = mode.endsWith("-import"), local = mode.startsWith("s46-local-");
  const parent = JSON.parse(process.env.CONTROL_ROOM_REGION_RESET_PARENT ?? "null");
  assert.equal(parent !== null, isImport);
  if (parent) {
    assert.equal(hash(parent.source_text), parent.script_sha256);
    assert.equal(parent.mode, mode.replace(/-import$/, "-export"));
  }
  const paths = JSON.parse(process.env.CONTROL_ROOM_REGION_RESET_SOURCE_PATHS ?? "null");
  const expectedSources = JSON.parse(process.env.CONTROL_ROOM_STUDY_STAGE_RERUN_SOURCE_SHA256 ?? "null");
  const beforeHashes = await sourceHashes(paths);
  assert.deepEqual(beforeHashes, expectedSources);
  const fixture = await fs.readFile("/opt/fullmag/p22-fixture.py", "utf8");
  const sourceText = parent?.source_text ?? fixture;
  const sourceName = parent?.source_name ?? ("p22-s46-" + (local ? "local" : "independent") + ".py");
  assert(/^[A-Za-z0-9_.-]+\.py$/.test(sourceName) && sourceName.length <= 128);
  assert(Buffer.byteLength(sourceText) > 0 && Buffer.byteLength(sourceText) <= 65536);
  const timeout = Number(process.env.CONTROL_ROOM_BROWSER_QA_TIMEOUT_MS);
  assert(Number.isInteger(timeout) && timeout >= 30000 && timeout <= 900000);
  const started = Date.now(), remaining = () => Math.max(1, timeout - 20000 - (Date.now() - started));
  const report = { schema, scenario: "study-stage-rerun", mode, state: "failed", outcome: "not-dispatched",
    phase: "preflight", public_url: process.env.CONTROL_ROOM_PUBLIC_URL, probe_url: process.env.CONTROL_ROOM_URL,
    source_hashes_before: beforeHashes, source_hashes_after: null, api_instance_id: null, session: null,
    command_count: 0, command_attempt_count: 0, grid_command_count: 0, request_counts: {},
    violations: [], failed_write_observations: [], read_timeout_observations: [],
    errors: { page: [], console: [], http: [] }, edits: [], parent_evidence: parent,
    expected_empty_404: [], expected_console_404: [], cleanup_cancellations: [], cleanup_errors: [], auxiliary_writes: [], read_cancellations: [], successful_read_responses: [] };
  const gate = { phase: "preflight", session: null, apiInstance: null, sourceName, sourceText,
    importAttempts: 0, createAttempts: 0, replaceAttempts: 0, editAttempts: 0, syncAttempts: 0,
    solverAttempts: 0, gridAttempts: 0, cameraAttempts: 0, clientAckAttempts: 0 };
  let proxy, browser, context, page, writes = [], editAck = null, sync = null, importedScene = null;
  let attemptedWrite = false, origin, total = 0, cleanupStarted = false;
  const emptyRequests = new WeakSet();
  const pendingHealthObservations = new Set();
  const emptyPaths = new Set([base.slice(0, -1), base + "status", base + "simulation/runs/current",
    base + "simulation/stages/execution", base + "simulation/solver/status",
    base + "simulation/preparation"]);
  function note(method, path) {
    assert(++total <= 2400, "Request budget exceeded");
    const key = method + " " + new URL(path, "http://fixed").pathname;
    assert(Object.keys(report.request_counts).length < 160 || Object.hasOwn(report.request_counts, key), "Path budget exceeded");
    report.request_counts[key] = (report.request_counts[key] ?? 0) + 1;
    assert(report.request_counts[key] <= 160, "Per-path observation budget exceeded");
  }
  async function get(path, { optional = false, scoped = Boolean(gate.session) } = {}) {
    note("GET", path);
    const response = await page.request.get(origin + path, { headers: {
      accept: "application/json", ...(gate.apiInstance ? { "x-fullmag-api-instance": gate.apiInstance } : {}),
      ...(scoped ? { "x-fullmag-session-scope": scope(gate.session) } : {}),
    }, timeout: Math.min(20000, remaining()) });
    const instance = response.headers()["x-fullmag-api-instance"];
    assert(instance && (!gate.apiInstance || instance === gate.apiInstance), "API identity changed");
    gate.apiInstance = instance;
    if (optional && response.status() === 404) return null;
    assert(response.ok(), "GET failed: " + path + " HTTP" + response.status());
    const raw = await response.body();
    assert(raw.length <= 2 * 1024 * 1024, "API observation exceeds its byte bound");
    return JSON.parse(raw.toString("utf8"));
  }
  async function freshStatus() {
    const status = await get(base + "status");
    assert.deepEqual(identity(status, gate.session.session_id), gate.session);
    return status;
  }
  async function expand(id) {
    const row = page.locator('[role="treeitem"][data-node-id="' + id + '"]');
    await row.waitFor({ state: "visible", timeout: Math.min(20000, remaining()) });
    if (await row.getAttribute("aria-expanded") !== "true") { await row.focus(); await row.press("ArrowRight"); }
    return row;
  }
  async function selectB() {
    await expand("model:study"); await expand("model:study:stages");
    await page.locator('[role="treeitem"][data-node-id="model:study:stages:stage:relax-b"]').click();
  }
  async function sceneAndStatus() {
    const status = await freshStatus(), scene = await get(scenePath);
    assert.equal(status.resources.scene_revision, scene.revision);
    pipelineStages(scene);
    gate.sceneRevision = scene.revision;
    return { scene, status };
  }
  async function edit(kind) {
    const { scene, status } = await sceneAndStatus();
    const args = { scene, sceneRevision: scene.revision, statusSceneRevision: status.resources.scene_revision };
    gate.phase = kind; report.phase = kind; gate.editAttempts = 0; writes = []; editAck = null;
    gate.expectedEdit = kind === "region-reset" ? buildStageBRegionObjectTextureResetTransaction(args)
      : buildStageBEnabledTransaction({ ...args, enabled: kind === "enable" });
    await selectB();
    if (kind === "region-reset") await fillStageBRegionObjectTextureResetInInspector(page);
    else await setStageBStudyInclusionInInspector(page, { enabled: kind === "enable" });
    await saveStageBStudyChangeAndWaitForAck(page, { timeout: Math.min(30000, remaining()) });
    const exchange = { ...args, sessionScopeKey: scope(gate.session), writes, acknowledgement: editAck };
    if (kind === "region-reset") validateStageBRegionObjectTextureResetExchange(exchange);
    else validateStageBEnabledExchange({ ...exchange, enabled: kind === "enable" });
    report.edits.push({ kind, stage_id: "relax-b", ...(kind === "region-reset" ? { object_id: "film", region_id: "left-half" } : {}),
      before_revision: scene.revision, after_revision: scene.revision + 1,
      request_sha256: hash(canonical(writes[0].body)), committed_scene_sha256: hash(canonical(editAck.body.committed_scene)),
      session_scope: scope(gate.session) });
    gate.phase = "observe";
  }
  async function results(runId, expectedIds) {
    const resource = await get(base + "simulation/stages/results?run_id=" + encodeURIComponent(runId) + "&limit=100");
    assert.equal(resource.next_cursor ?? null, null);
    const ids = resource.results.map(studyStageResultIdentity).sort((a,b) => a.authored_stage_id.localeCompare(b.authored_stage_id));
    assert.deepEqual(ids.map((r) => r.authored_stage_id), expectedIds);
    assert(ids.every((r) => r.source.run_id === runId));
    return ids;
  }
  async function waitRun(previousRun, expectedIds) {
    let binding = null;
    while (remaining() > 1) {
      assert.deepEqual(report.violations, [], "Request guard rejected the operation");
      const submitted = gate.lastSolverCommand;
      const detailPath = submitted ? commandsPath + "/" + encodeURIComponent(submitted.command_id) : null;
      const detailObservation = submitted ? await regionResetObserveGet(
        () => get(detailPath, { optional: true }),
        { method: "GET", path: detailPath, phase: gate.phase, api_instance_id: gate.apiInstance,
          session_scope: scope(gate.session) }, report) : { kind: "response", value: null };
      if (detailObservation.kind === "read_timeout") {
        await page.waitForTimeout(Math.min(5000, remaining()));
        continue;
      }
      const detail = detailObservation.value;
      if (detail) {
        assert.equal(detail.command_id, submitted.command_id, "Command detail belongs to another intent");
        assert(!["failed", "rejected", "cancelled"].includes(detail.status), "Submitted command failed");
        if (detail.execution_binding) {
          assert(regionResetCommandBindingMatches(detail.execution_binding, submitted.target,
            detail.execution_binding.run_id, previousRun), "Wrong command target/run binding");
          if (binding) assert.deepEqual(detail.execution_binding, binding, "Command binding changed");
          binding = detail.execution_binding;
        }
      }
      const runPath = base + "simulation/runs/current";
      const runObservation = await regionResetObserveGet(
        () => get(runPath, { optional: true }),
        { method: "GET", path: runPath, phase: gate.phase, api_instance_id: gate.apiInstance,
          session_scope: scope(gate.session) }, report);
      if (runObservation.kind === "read_timeout") {
        await page.waitForTimeout(Math.min(5000, remaining()));
        continue;
      }
      const run = runObservation.value;
      if (run && binding && run.run_id === binding.run_id && run.run_id !== previousRun) {
        assert.equal(run.session_id, gate.session.session_id);
        assert(!["failed", "cancelled", "interrupted"].includes(run.status), "New run failed: " + run.run_id);
        if (run.status === "completed" && detail?.status === "completed") {
          const execution = await get(base + "simulation/stages/execution");
          const terminalStatus = await freshStatus();
          assert.equal(terminalStatus.run?.run_id, run.run_id, "Terminal status switched runs");
          regionResetAssertExecutionIdentity(execution, gate.session, run.run_id);
          studyStageTerminalScope(execution, stages, expectedIds);
          return { run_id: run.run_id, command_id: submitted.command_id, execution_binding: binding,
            status: "completed", stage_ids: expectedIds, results: await results(run.run_id, expectedIds) };
        }
      }
      // Observe the same operation; never repeat a UI click after timeout.
      await page.waitForTimeout(Math.min(5000, remaining()));
    }
    throw new Error("Timed out observing the submitted run");
  }
  async function runStudy(expectedIds) {
    const { scene, status } = await sceneAndStatus();
    gate.expectedGridPrecondition = { scene_revision: status.resources.scene_revision,
      mesh_revision: status.resources.mesh_revision,
      current_run: status.run ? { kind: "run", run_id: status.run.run_id } : { kind: "none" } };
    gate.phase = "build-study"; report.phase = gate.phase; gate.solverAttempts = 0; gate.gridAttempts = 0;
    gate.lastSolverCommand = null; gate.gridAcknowledged = false; gate.gridReady = false;
    const prior = await get(base + "simulation/runs/current", { optional: true });
    const row = page.locator('[role="treeitem"][data-node-id="model:study"]');
    await row.click();
    await page.getByRole("button", { name: "Build + Study", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Build Grid & Materialize Masks", exact: true }).click();
    const result = await waitRun(prior?.run_id ?? null, expectedIds);
    assert.equal(gate.solverAttempts, 1);
    assert.equal(gate.gridAttempts, 1);
    assert.equal((await get(scenePath)).revision, scene.revision);
    if (await dialog.isVisible()) { await dialog.press("Escape"); await dialog.waitFor({ state: "hidden" }); }
    gate.phase = "observe";
    return result;
  }
  try {
    proxy = await startBrowserQaLoopbackProxy(report.public_url, report.probe_url); origin = proxy.origin;
    const require = createRequire(import.meta.url);
    assert.equal(require("playwright/package.json").version, process.env.CONTROL_ROOM_EXPECTED_PLAYWRIGHT_VERSION);
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--use-angle=swiftshader-webgl"] });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on("pageerror", (e) => report.errors.page.push(String(e.message).slice(0,512)));
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text().slice(0,512);
      if (/^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/.test(text)) {
        report.expected_console_404.push(text);
      } else report.errors.console.push(text);
    });
    page.on("response", (response) => {
      if (response.status() < 400) return;
      const request = response.request(), path = new URL(response.url()).pathname;
      if (response.status() === 404 && request.method() === "GET" && emptyRequests.has(request) && emptyPaths.has(path)) {
        report.expected_empty_404.push(path);
      } else report.errors.http.push({ path, status: response.status() });
    });
    page.on("requestfinished", (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() !== "GET" || path !== "/v2/platform/health") return;
      // requestfinished requires a fully received response; aborted bodies never qualify as positive proof.
      const observation = request.response().then((response) => {
        if (!response || response.status() !== 200) return;
        const row = { method: "GET", path, status: 200,
          api_instance_id: response.headers()["x-fullmag-api-instance"] };
        if (!regionResetHealthResponseMatches(row, gate.apiInstance)) {
          report.errors.http.push({ path, failure: "Health response belongs to another API incarnation" });
        } else if (report.successful_read_responses.length < 16) report.successful_read_responses.push(row);
      }).catch((error) => report.errors.http.push({ path, failure: String(error.message).slice(0,512) }));
      pendingHealthObservations.add(observation);
      void observation.finally(() => pendingHealthObservations.delete(observation));
    });
    page.on("requestfailed", (request) => {
      const path = new URL(request.url()).pathname;
      const failure = request.failure()?.errorText ?? "transport failure";
      if (cleanupStarted && ["GET", "HEAD"].includes(request.method()) && failure === "net::ERR_ABORTED") {
        if (report.cleanup_cancellations.length < 32) report.cleanup_cancellations.push({ method: request.method(), path, failure });
        return;
      }
      const cancellation = { method: request.method(), path, failure, phase: gate.phase,
        api_instance_id: request.headers()["x-fullmag-api-instance"] };
      if (regionResetReadCancellationAllowed(cancellation, {
        apiInstance: gate.apiInstance, observedCount: report.read_cancellations.length,
      })) {
        report.read_cancellations.push(cancellation);
        return;
      }
      // Aborted route violations are already evidence; all other failed requests are unexpected.
      if (!report.violations.length) report.errors.http.push({
        path, method: request.method(), failure, phase: gate.phase,
        api_instance_id: request.headers()["x-fullmag-api-instance"] ?? null,
        session_scope: request.headers()["x-fullmag-session-scope"] ?? null,
      });
    });
    await context.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (url.origin !== origin) { report.violations.push("Foreign origin " + url.origin); return route.abort(); }
      if (!url.pathname.startsWith("/v2/")) {
        if (["GET", "HEAD"].includes(method)) return route.continue();
        report.violations.push("Non-control-plane write " + method + " " + url.pathname);
        return route.abort();
      }
      note(method, url.pathname);
      if (["GET","HEAD"].includes(method)) {
        if (!gate.session) emptyRequests.add(request);
        return route.continue();
      }
      try {
        const body = request.postDataJSON(), headers = request.headers();
        if (url.pathname === commandsPath && ["solve","relax"].includes(body?.kind)) {
          const status = await freshStatus(), solver = await get(base + "simulation/solver/status"),
            queue = await get(commandsPath);
          if (body.kind === "solve") {
            assert.equal(gate.gridAcknowledged, true, "Grid command has no successful ACK");
            gate.gridReady = regionResetGridIsReady({ status, queue, solver, session: gate.session,
              sceneRevision: gate.sceneRevision, gridCommandId: gate.gridCommandId,
              preparation: await get(base + "simulation/preparation"),
              run: await get(base + "simulation/runs/current"), execution: await get(base + "simulation/stages/execution") });
          }
          gate.expectedComputePrecondition = regionResetExpectedComputePrecondition(status, solver, queue);
        }
        if (!regionResetWriteAllowed({ method, path: url.pathname, body, headers }, gate)) {
          report.violations.push("Forbidden write " + method + " " + url.pathname); return route.abort();
        }
        attemptedWrite = true;
        const auxiliary = [base + "visualization/state", base + "visualization/client-acks"].includes(url.pathname);
        if (url.pathname === base + "visualization/state") gate.cameraAttempts++;
        else if (url.pathname === base + "visualization/client-acks") gate.clientAckAttempts++;
        if (url.pathname === scriptImportPath) gate.importAttempts++;
        else if (url.pathname === "/v2/sessions") gate.createAttempts++;
        else if (url.pathname === transactionsPath && gate.phase === "import") gate.replaceAttempts++;
        else if (url.pathname === transactionsPath) gate.editAttempts++;
        else if (url.pathname === base + "model/syncs") gate.syncAttempts++;
        else if (url.pathname === commandsPath && body.kind === "fdm_grid_refresh") gate.gridAttempts++;
        else if (url.pathname === commandsPath) { gate.solverAttempts++; report.command_attempt_count++; }
        const response = await regionResetFetchWriteResponse({ route,
          request: { method, path: url.pathname + url.search, body, headers },
          apiInstance: gate.apiInstance, report, timeout: Math.min(30000, remaining()) });
        const raw = await response.body();
        assert(raw.length <= 2 * 1024 * 1024, "UI acknowledgment exceeds its byte bound");
        const payload = JSON.parse(raw.toString("utf8"));
        if (url.pathname === scriptImportPath) {
          regionResetValidateImportedSource(payload, sourceName, sourceText);
          gate.project = payload;
        }
        else if (url.pathname === "/v2/sessions") {
          gate.createdStorage = body.output_storage;
          gate.session = identity(await get(base + "status", { scoped: false }), payload.session_id);
          const current = await get(scenePath);
          gate.expectedReplacement = { kind: "replace_scene", base_revision: current.revision,
            scene: { ...gate.project.scene_document, study: { ...gate.project.scene_document.study, output_storage: body.output_storage } } };
        } else if (url.pathname === transactionsPath && gate.phase === "import") {
          importedScene = regionResetValidateImportAck(payload, gate.expectedReplacement);
          report.import = { project_id: gate.project.project_id, source_sha256: hash(sourceText),
            session_id: gate.session.session_id, scene_revision: payload.scene_revision,
            fidelity: gate.project.script_import.fidelity.round_trip };
        } else if (url.pathname === transactionsPath) {
          writes.push({ method, path: url.pathname, body, headers }); editAck = { status: response.status(), body: payload };
        } else if (url.pathname === base + "model/syncs") sync = payload;
        else if (url.pathname === commandsPath) {
          assert.equal(payload.accepted, true);
          assert(typeof payload.command_id === "string");
          if (body.kind === "fdm_grid_refresh") {
            report.grid_command_count++; gate.gridAcknowledged = true; gate.gridCommandId = payload.command_id;
          } else {
            report.command_count++;
            gate.lastSolverCommand = { command_id: payload.command_id, target: body.target };
          }
        }
        if (auxiliary) report.auxiliary_writes.push({ method, path: url.pathname, body,
          session_scope: headers["x-fullmag-session-scope"], api_instance_id: gate.apiInstance, status: response.status() });
        await route.fulfill({ response });
      } catch (error) {
        await regionResetHandleWriteFailure(route, report, error);
      }
    });
    const collection = await get("/v2/sessions", { scoped: false });
    assert(Array.isArray(collection.sessions) && !collection.sessions.some((s) => s.current),
      "S46 import requires an empty task-owned API; no current workspace is replaced");
    gate.storageDefaults = await get("/v2/platform/output-storage", { scoped: false });
    await page.goto(regionResetPinnedHomeUrl(origin, gate.apiInstance), { waitUntil: "domcontentloaded", timeout: Math.min(60000, remaining()) });
    await page.evaluate(() => {
      const events = [{ kind: "initial", at_ms: performance.now(),
        section: document.querySelector(".fm-start")?.getAttribute("data-section") }];
      window.__fullmagS46NavigationEvents = events;
      const record = (event) => { if (events.length < 32) events.push({ ...event, at_ms: performance.now() }); };
      document.addEventListener("click", (event) => {
        const button = event.target instanceof Element ? event.target.closest("button") : null;
        if (button && (button.closest(".fm-start__rail") || button.textContent.trim() === "Home")) {
          record({ kind: "click", section: button.getAttribute("data-section"),
            text: button.textContent.slice(0,100) });
        }
      }, true);
      new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.target instanceof Element && mutation.target.classList.contains("fm-start")) {
            record({ kind: "section", old_section: mutation.oldValue,
              section: mutation.target.getAttribute("data-section") });
          }
        }
      }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-section"], attributeOldValue: true });
    });
    await page.locator('.fm-start__rail button[data-section="import"]').click();
    gate.phase = "import"; report.phase = "import";
    await page.getByRole("heading", { name: "Import", exact: true }).waitFor({ state: "visible" });
    await page.locator('input[type="file"][accept*=".py"]').setInputFiles({
      name: sourceName, mimeType: "text/x-python", buffer: Buffer.from(sourceText, "utf8") });
    await page.getByRole("button", { name: "Create project…", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Run script and create project", exact: true }).click();
    while (!importedScene && remaining() > 1) {
      assert.deepEqual(report.violations, [], "Import guard rejected the operation");
      await page.waitForTimeout(Math.min(100, remaining()));
    }
    assert(importedScene && gate.session, "Import activation was not acknowledged");
    await page.waitForFunction(() => Boolean(document.querySelector('[data-node-id="model:study"]')), null,
      { timeout: Math.min(60000, remaining()) });
    const importedStages = pipelineStages(importedScene);
    assert.equal(importedStages[1].enabled !== false, !isImport);
    if (isImport && local) assert.deepEqual(importedStages[1].payload.stage_magnetization_assignments?.assignments,
      [{ object_id: "film", region_id: "left-half", initializer: null }]);
    report.session = gate.session; report.api_instance_id = gate.apiInstance;
    gate.phase = "observe";
    if (!isImport) {
      report.baseline = await runStudy(stages);
      if (local) await edit("region-reset");
      await edit("disable");
      const { scene } = await sceneAndStatus();
      gate.phase = "export"; report.phase = "export";
      const downloadPromise = page.waitForEvent("download", { timeout: Math.min(30000, remaining()) });
      void downloadPromise.catch(() => {});
      await page.getByRole("button", { name: "File", exact: true }).click();
      await page.getByRole("menuitem", { name: /^Save canonical copy as/ }).click();
      const download = await downloadPromise, stream = await download.createReadStream();
      assert(stream, "Canonical copy has no readable bytes");
      const chunks = []; let length = 0;
      for await (const chunk of stream) { length += chunk.length; assert(length <= 65536); chunks.push(chunk); }
      const bytes = Buffer.concat(chunks), text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      regionResetValidateSync(sync, text, scene.revision);
      assert(/^[A-Za-z0-9_.-]+\.py$/.test(download.suggestedFilename()));
      assert.equal(gate.syncAttempts, 1);
      report.export = { source_text: text, source_name: download.suggestedFilename(),
        script_sha256: hash(bytes), scene_revision: scene.revision };
      report.outcome = "exported";
    } else {
      report.study = await runStudy(["relax-a","relax-c"]);
      await edit("enable");
      const previous = report.study.run_id;
      await sceneAndStatus(); await selectB();
      const row = page.locator('[role="treeitem"][data-node-id="model:study:stages:stage:relax-b"]');
      gate.phase = "stage-b"; report.phase = gate.phase; gate.solverAttempts = 0; gate.lastSolverCommand = null;
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Run This Stage", exact: true }).click();
      report.stage_only = await waitRun(previous, ["relax-b"]);
      assert.equal(gate.solverAttempts, 1);
      assert.deepEqual(await results(report.study.run_id, ["relax-a","relax-c"]), report.study.results,
        "Rerunning B changed prior A/C history");
      report.outcome = "completed";
    }
    gate.phase = "reload"; report.phase = "reload";
    const beforeSession = gate.session, response = await page.reload({ waitUntil: "domcontentloaded", timeout: Math.min(60000, remaining()) });
    assert.equal(response.status(), 200);
    const afterReloadStatus = await freshStatus();
    const afterReloadRun = await get(base + "simulation/runs/current");
    const expectedLast = isImport ? report.stage_only : report.baseline;
    assert.equal(afterReloadRun.run_id, expectedLast.run_id, "Reload selected another run");
    assert.equal(afterReloadRun.status, "completed");
    assert.equal(afterReloadStatus.run?.run_id, expectedLast.run_id);
    regionResetAssertExecutionIdentity(await get(base + "simulation/stages/execution"), gate.session, expectedLast.run_id);
    assert.deepEqual(await results(expectedLast.run_id, expectedLast.stage_ids), expectedLast.results,
      "Reload changed accepted stage result identities");
    await page.locator(".fm-viewport-3d canvas").waitFor({ state: "visible", timeout: Math.min(30000, remaining()) });
    report.canvas = await page.locator(".fm-viewport-3d canvas").evaluate((canvas) => {
      const gl = canvas.getContext("webgl2");
      return { context_type: gl?.constructor.name, context_lost: gl?.isContextLost(),
        drawing_buffer_width: gl?.drawingBufferWidth, drawing_buffer_height: gl?.drawingBufferHeight };
    });
    assert.equal(report.canvas.context_type, "WebGL2RenderingContext");
    assert.equal(report.canvas.context_lost, false);
    assert(report.canvas.drawing_buffer_width > 0 && report.canvas.drawing_buffer_height > 0);
    report.reload = { method: "page.reload", response_status: 200, identity_preserved: same(beforeSession, gate.session),
      run_id: afterReloadRun.run_id };
    assert.equal(report.command_count, isImport ? 2 : 1);
    assert.equal(report.command_attempt_count, report.command_count);
    assert.equal(report.grid_command_count, 1);
    assert.deepEqual(report.violations, []);
    assert(report.expected_empty_404.length <= 12 &&
      report.expected_console_404.length <= report.expected_empty_404.length, "Uncorrelated empty-workspace errors");
    await Promise.all([...pendingHealthObservations]);
    assert(report.read_cancellations.length === 0 || report.successful_read_responses.some((row) =>
      regionResetHealthResponseMatches(row, gate.apiInstance)), "Canceled health read has no completed same-API response");
    assert(report.read_cancellations.length + report.successful_read_responses.length <=
      (report.request_counts["GET /v2/platform/health"] ?? 0), "Health observations exceed their request count");
    assert.deepEqual(report.errors, { page: [], console: [], http: [] });
    report.source_hashes_after = await sourceHashes(paths); assert.deepEqual(report.source_hashes_after, beforeHashes);
    report.state = "passed"; report.phase = "complete";
  } catch (error) {
    report.failure = String(error?.stack ?? error).slice(0,4096);
    report.outcome = attemptedWrite ? "unknown" : "not-dispatched";
    if (page && !page.isClosed()) {
      try {
        report.ui_failure_snapshot = await page.evaluate(() => ({
          url: location.href, ready_state: document.readyState,
          navigation_events: window.__fullmagS46NavigationEvents ?? [],
          sections: [...document.querySelectorAll(".fm-start")].map((element) => ({
            section: element.getAttribute("data-section"), text: element.textContent?.slice(0,4000),
          })),
          navigation: [...document.querySelectorAll(".fm-start__rail button[data-section]")].map((element) => ({
            section: element.getAttribute("data-section"), current: element.getAttribute("aria-current"),
            disabled: element.disabled, text: element.textContent?.slice(0,200),
          })),
          file_inputs: [...document.querySelectorAll('input[type="file"]')].map((element) => ({
            accept: element.accept, disabled: element.disabled, outer: element.outerHTML.slice(0,1000),
          })),
          alerts: [...document.querySelectorAll('[role="alert"], [role="status"]')]
            .map((element) => element.textContent?.slice(0,1000)).slice(0,20),
        }));
        const screenshot = await page.screenshot({ type: "png", timeout: 5000 });
        if (screenshot.length <= 700000) report.ui_failure_screenshot_png_base64 = screenshot.toString("base64");
      } catch (diagnosticError) {
        report.ui_failure_snapshot_error = String(diagnosticError.message).slice(0,512);
      }
    }
    process.exitCode = 1;
  } finally {
    cleanupStarted = true;
    for (const [name, resource] of [["context", context], ["browser", browser], ["proxy", proxy]]) {
      try { await resource?.close(); }
      catch (error) { report.cleanup_errors.push(name + ": " + String(error.message).slice(0,512)); }
    }
    await Promise.allSettled([...pendingHealthObservations]);
    if (report.state === "passed" && (report.cleanup_errors.length ||
        Object.values(report.errors).some((errors) => errors.length) || report.violations.length)) {
      report.state = "failed"; report.outcome = "unknown"; report.failure = "Browser cleanup or a late response is unconfirmed";
      process.exitCode = 1;
    }
    process.stdout.write(JSON.stringify(report) + "\n");
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runRegionResetBrowserQa().catch((error) => {
    process.stdout.write(JSON.stringify({ schema, scenario: "study-stage-rerun", mode: process.argv[2] ?? null,
      state: "failed", outcome: "not-dispatched", failure: String(error.message).slice(0,2048) }) + "\n");
    process.exitCode = 1;
  });
}
