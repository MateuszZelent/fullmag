// Run one guarded P22 Study command through the real Control Room context menu.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startBrowserQaLoopbackProxy } from "./lib/browser-qa-loopback-proxy.mjs";

const schema = "fullmag.docker-dev-study-stage-rerun-result.v1";
const scenario = "study-stage-rerun";
const sessionName = "P22 three Relax stages";
const fixturePath = "examples/interactive_study/fdm_cpu_three_relax_continue.py";
const fixtureRuntimePath = "/opt/fullmag/source/examples/interactive_study/fdm_cpu_three_relax_continue.py";
const stageIds = ["relax-a", "relax-b", "relax-c"];
const statusPath = "/v2/sessions/current/status";
const currentSessionPath = "/v2/sessions/current";
const scenePath = "/v2/sessions/current/model/scene";
const commandsPath = "/v2/sessions/current/simulation/commands";
const currentRunPath = "/v2/sessions/current/simulation/runs/current";
const executionPath = "/v2/sessions/current/simulation/stages/execution";
const solverStatusPath = "/v2/sessions/current/simulation/solver/status";
const resultsBasePath = "/v2/sessions/current/simulation/stages/results";
const commandPath = "/v2/sessions/current/simulation/commands";
const clientAckPath = "/v2/sessions/current/visualization/client-acks";
const reportDir = "/tmp/fullmag-study-stage-rerun";
const identityKeys = ["session_id", "session_epoch", "request_scope_epoch"];
const regionRevisionKeys = [
  "region_topology_revision",
  "region_membership_revision",
  "region_coefficients_revision",
  "region_initial_state_revision",
];
const sourceFiles = {
  runner: new URL("./check-study-stage-rerun-browser.mjs", import.meta.url),
  loopback_proxy: new URL("./lib/browser-qa-loopback-proxy.mjs", import.meta.url),
  fixture: new URL("file:///opt/fullmag/p22-fixture.py"),
  scene_adapter: new URL("../src/modules/explorer/builders/sceneModelTreeAdapter.ts", import.meta.url),
  tree_view: new URL("../src/modules/explorer/ExplorerTreeView.tsx", import.meta.url),
  study_nodes: new URL("../src/modules/explorer/builders/study/studyExplorerNodes.ts", import.meta.url),
  stage_builder: new URL("../src/modules/explorer/builders/study/studyStageCommon.ts", import.meta.url),
  command_adapter: new URL("../src/kernel/runtime/studyRuntimeCommandAdapters.ts", import.meta.url),
  command_contributions: new URL("../src/kernel/runtime/studyRuntimeCommandContributions.ts", import.meta.url),
  study_compute_input: new URL("../src/kernel/runtime/studyComputeInput.ts", import.meta.url),
};
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_API_BYTES = 2 * 1024 * 1024;
const MAX_REQUESTS = 512;
const MAX_REQUEST_PATHS = 128;
const MAX_READS_PER_PATH = 128;
const MAX_CLIENT_ACKS = 16;
const TERMINAL_COMMAND_STATES = new Set(["completed", "failed", "cancelled", "rejected"]);

function plainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (plainRecord(value)) {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function sessionScope(session) {
  return "session=" + encodeURIComponent(session.session_id)
    + "&epoch=" + encodeURIComponent(session.session_epoch)
    + "&request_scope_epoch=" + encodeURIComponent(session.request_scope_epoch);
}

export function studyStageCommandForMode(mode) {
  if (mode === "stage-b") {
    return {
      kind: "relax",
      target: { kind: "stage_id", stage_id: "relax-b" },
      initial_state: { kind: "default_for_target" },
    };
  }
  if (mode === "study") return { kind: "solve", target: { kind: "study" } };
  throw new TypeError("Study stage rerun mode must be stage-b or study");
}

export function studyStageExpectedStageIds(mode, phase) {
  if (mode !== "stage-b" && mode !== "study") throw new TypeError("Study stage rerun mode must be stage-b or study");
  if (phase === "before") return mode === "stage-b" ? [...stageIds] : ["relax-b"];
  if (phase === "after") return mode === "stage-b" ? ["relax-b"] : [...stageIds];
  throw new TypeError("Study stage rerun phase must be before or after");
}

export function studyStageCommandResponseOutcome(status, body) {
  if (Number.isSafeInteger(status) && status >= 200 && status < 300
      && plainRecord(body) && body.accepted === true
      && typeof body.command_id === "string" && body.command_id.length > 0) {
    return { outcome: "accepted", command_id: body.command_id };
  }
  return { outcome: "unknown", command_id: null };
}

export function studyStageExecutionBindingMatches(binding, mode, runId) {
  try {
    if (!plainRecord(binding) || typeof runId !== "string" || !runId
        || binding.run_id !== runId) return false;
    const target = studyStageCommandForMode(mode).target;
    if (canonical(binding.requested_target) !== canonical(target)) return false;
    if (mode === "stage-b") return binding.step_id === target.stage_id;
    return binding.step_id === undefined || binding.step_id === null;
  } catch {
    return false;
  }
}

export function studyStageRerunRequestAllowed(request, context) {
  try {
    const expected = studyStageCommandForMode(context?.mode);
    const body = request?.body;
    if (context.phase !== "ui-submit" || context.commandCount !== 0
        || request?.method !== "POST" || request?.path !== commandPath
        || request?.scope !== sessionScope(context.session) || !plainRecord(body)) return false;
    const isStageB = context.mode === "stage-b";
    const expectedKeys = isStageB
      ? ["kind", "target", "initial_state", "precondition", "client_intent_id", "reason", "requested_at_unix_ms"]
      : ["kind", "target", "precondition", "client_intent_id", "reason", "requested_at_unix_ms"];
    if (canonical(Object.keys(body).sort()) !== canonical(expectedKeys.sort())) return false;
    if (body.kind !== expected.kind || canonical(body.target) !== canonical(expected.target)
        || (isStageB && canonical(body.initial_state) !== canonical(expected.initial_state))
        || canonical(body.precondition) !== canonical(context.expectedPrecondition)) return false;
    return typeof body.client_intent_id === "string"
      && body.client_intent_id.length > 0 && body.client_intent_id.length <= 128
      && body.client_intent_id.startsWith("study:" + (isStageB ? "relax" : "solve") + ":")
      && body.reason === "user_requested"
      && Number.isSafeInteger(body.requested_at_unix_ms) && body.requested_at_unix_ms > 0;
  } catch {
    return false;
  }
}

export function studyStageRerunClientAckAllowed(request, session) {
  const body = request?.body;
  if (request?.method !== "POST" || request?.path !== clientAckPath
      || request?.scope !== sessionScope(session) || !plainRecord(body)) return false;
  const keys = ["client_id", "client_label", "effective_render_mode", "error", "revision", "status", "viewport_id"];
  if (Object.keys(body).some((key) => !keys.includes(key))
      || typeof body.client_id !== "string" || body.client_id.length < 1 || body.client_id.length > 256
      || !Number.isSafeInteger(body.revision) || body.revision < 0
      || !["applied", "rendered", "failed"].includes(body.status)) return false;
  for (const key of ["client_label", "effective_render_mode", "error", "viewport_id"]) {
    if (body[key] !== undefined && (typeof body[key] !== "string" || body[key].length > 512)) return false;
  }
  return true;
}

export function studyStageResultIdentity(result) {
  assert(plainRecord(result), "Study stage result is not an object");
  const source = result.source;
  assert(plainRecord(source), "Study stage result omitted its scalar-series identity");
  assert(typeof source.run_id === "string" && source.run_id.length > 0);
  for (const key of ["task_id", "step_id", "case_id", "attempt_id"]) {
    assert(typeof source[key] === "string" && source[key].length > 0);
  }
  assert(Number.isSafeInteger(source.ownership_epoch) && source.ownership_epoch >= 0);
  assert(typeof result.authored_stage_id === "string" && stageIds.includes(result.authored_stage_id));
  assert(typeof result.project_id === "string" && result.project_id.length > 0);
  assert(typeof result.study_id === "string" && result.study_id.length > 0);
  assert(typeof result.artifact_id === "string" && result.artifact_id.length > 0);
  assert(/^[0-9a-f]{64}$/.test(result.artifact_sha256));
  assert(typeof result.codec_id === "string" && result.codec_id.length > 0);
  assert(typeof result.codec_version === "string" && result.codec_version.length > 0);
  assert(typeof result.accepted_at === "string" && result.accepted_at.length > 0);
  return {
    project_id: result.project_id,
    study_id: result.study_id,
    source: {
      run_id: source.run_id,
      task_id: source.task_id,
      step_id: source.step_id,
      case_id: source.case_id,
      attempt_id: source.attempt_id,
      ownership_epoch: source.ownership_epoch,
    },
    authored_stage_id: result.authored_stage_id,
    artifact_id: result.artifact_id,
    artifact_sha256: result.artifact_sha256,
    codec_id: result.codec_id,
    codec_version: result.codec_version,
    accepted_at: result.accepted_at,
  };
}

export function studyStageHistoryIdentitiesPreserved(before, after) {
  try {
    const identities = (items) => items.map(studyStageResultIdentity)
      .sort((left, right) => left.authored_stage_id.localeCompare(right.authored_stage_id));
    return canonical(identities(before)) === canonical(identities(after));
  } catch {
    return false;
  }
}

function boundedMessage(error) {
  return String(error?.message ?? error).replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 512);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function deadline(promise, milliseconds, message) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

async function sourceHashes() {
  const entries = await Promise.all(Object.entries(sourceFiles).map(async ([key, path]) => {
    const raw = await fs.readFile(path);
    assert(raw.length <= MAX_SOURCE_BYTES, "Study stage rerun source exceeds its pin bound");
    return [key, createHash("sha256").update(raw).digest("hex")];
  }));
  return Object.fromEntries(entries);
}

function readSessionIdentity(status) {
  const session = status?.session;
  assert(plainRecord(session) && session.name === sessionName, "The current session is not the task-owned P22 fixture");
  for (const key of identityKeys) {
    assert(typeof session[key] === "string" && session[key].length > 0 && session[key].length <= 512,
      "The P22 session omitted its scoped identity");
  }
  assert(status.lifecycle?.connectivity === "connected"
    && status.lifecycle?.session_resource === "active"
    && status.lifecycle?.commandability === "allowed", "The P22 session is not commandable");
  return Object.fromEntries([...identityKeys, "name"].map((key) => [key, session[key]]));
}

function assertSameSession(expected, actual) {
  assert(identityKeys.every((key) => expected?.[key] === actual?.[key])
    && expected?.name === actual?.name, "P22 session identity or request scope changed");
}

function authoredSceneStageIds(scene) {
  const nodes = scene?.study?.study_pipeline?.nodes;
  assert(Array.isArray(nodes), "The committed P22 scene omitted Study pipeline nodes");
  const found = [];
  const visit = (items) => {
    for (const node of items) {
      if (!plainRecord(node)) continue;
      if (node.node_kind === "primitive") {
        const stageId = node.id ?? node.stage_id ?? node.payload?.stage_id;
        if (typeof stageId === "string") found.push(stageId);
      }
      if (Array.isArray(node.children)) visit(node.children);
    }
  };
  visit(nodes);
  assert.deepEqual(found, stageIds, "The committed scene is not the exact three-stage P22 fixture");
  return found;
}

export function validateStudyStageScene(scene) {
  const study = scene?.study;
  assert(plainRecord(study), "The P22 scene omitted its Study request profile");
  assert.equal(study.requested_backend, "fdm", "The current Study request is not FDM");
  assert.equal(study.requested_device, "cpu", "The current Study request is not CPU");
  assert.equal(study.requested_precision, "double", "The current Study request is not double precision");
  const pipeline = study.study_pipeline;
  assert(plainRecord(pipeline) && pipeline.version === "study_pipeline.v1"
    && canonical(Object.keys(pipeline).sort()) === canonical(["nodes", "version"]),
  "The P22 pipeline is not the exact imported Study pipeline");
  const expectedNodes = [
    {
      enabled: true, id: "relax-a", label: "Relax 1", node_kind: "primitive", source: "script_imported",
      stage_kind: "relax",
      payload: {
        adaptive_timestep: null, demag_interval_s: "", energy_tolerance: "", entrypoint_kind: "flat_relax",
        fixed_timestep: "1e-13", integrator: "rk23", kind: "relax", max_relaxation_time_s: "",
        max_steps: "10", relax_algorithm: "llg_overdamped", stage_id: "relax-a",
        torque_tolerance: "0.0001", until_seconds: "",
      },
    },
    {
      enabled: true, id: "relax-b", label: "Relax 2", node_kind: "primitive", source: "script_imported",
      stage_kind: "relax",
      payload: {
        energy_tolerance: "", entrypoint_kind: "flat_relax", kind: "relax", max_steps: "1",
        relax_algorithm: "projected_gradient_bb", stage_id: "relax-b", torque_tolerance: "0.0001",
        until_seconds: "",
      },
    },
    {
      enabled: true, id: "relax-c", label: "Relax 3", node_kind: "primitive", source: "script_imported",
      stage_kind: "relax",
      payload: {
        energy_tolerance: "", entrypoint_kind: "flat_relax", kind: "relax", max_steps: "1",
        relax_algorithm: "nonlinear_cg", stage_id: "relax-c", torque_tolerance: "0.0001",
        until_seconds: "",
      },
    },
  ];
  assert.deepEqual(pipeline.nodes, expectedNodes,
    "The P22 pipeline has an edited, disabled, grouped or additional stage");
  return {
    requested_backend: study.requested_backend,
    requested_device: study.requested_device,
    requested_precision: study.requested_precision,
    pipeline_version: pipeline.version,
    stages: pipeline.nodes.map((node) => ({
      id: node.id,
      enabled: node.enabled,
      node_kind: node.node_kind,
      stage_kind: node.stage_kind,
      relax_algorithm: node.payload.relax_algorithm,
      max_steps: node.payload.max_steps,
    })),
  };
}

function currentProfile(status, currentRun, currentSession, expectedSources) {
  const domain = status?.domain;
  const resources = status?.resources;
  assert(plainRecord(domain) && domain.discretization === "fdm" && domain.cell_count === 8,
    "The current P22 domain is not the expected eight-cell FDM domain");
  assert(typeof domain.generation_id === "string" && domain.generation_id.length > 0
    && domain.generation_id === resources?.domain_generation_id,
  "P22 domain generation differs from the published resource identity");
  assert(currentRun?.requested_backend === "fdm"
    && currentRun?.requested_device === "cpu"
    && currentRun?.requested_precision === "double",
  "The current run is not the pinned FDM CPU double profile");
  assert(currentSession?.current === true && currentSession?.session_id === status.session.session_id
    && currentSession?.name === sessionName,
  "The current-session resource differs from the pinned P22 session");
  assert(plainRecord(currentSession.script)
    && currentSession.script.path === fixtureRuntimePath
    && currentSession.script.sha256 === expectedSources.fixture,
  "The active script path or source hash differs from the pinned P22 fixture");
  assert(status.session.script?.path === fixtureRuntimePath,
    "The status resource reports a different active P22 script path");
  return {
    domain_discretization: domain.discretization,
    domain_cell_count: domain.cell_count,
    domain_generation_id: domain.generation_id,
    requested_backend: currentRun.requested_backend,
    requested_device: currentRun.requested_device,
    requested_precision: currentRun.requested_precision,
    script_path: currentSession.script.path,
    script_sha256: currentSession.script.sha256,
  };
}

function commandPrecondition(status, currentRun, execution, solverStatus, commands, mode) {
  const resources = status?.resources;
  assert(plainRecord(resources), "The P22 status omitted current resource revisions");
  const precondition = {};
  for (const key of regionRevisionKeys) {
    assert(Number.isSafeInteger(resources[key]) && resources[key] >= 0,
      "The P22 status omitted a region revision precondition");
    precondition[key] = resources[key];
  }
  for (const key of ["scene_revision", "mesh_revision"]) {
    assert(Number.isSafeInteger(resources[key]) && resources[key] >= 0,
      "The P22 status omitted a scene or mesh revision precondition");
    precondition[key] = resources[key];
  }
  assert(typeof resources.domain_generation_id === "string" && resources.domain_generation_id.length > 0);
  precondition.domain_generation_id = resources.domain_generation_id;
  assert(status.run?.run_id === currentRun.run_id, "Status and current-run resources disagree");
  precondition.current_run = { kind: "run", run_id: currentRun.run_id };
  assert(solverStatus?.runtime_state === "awaiting_command",
    "Solver status is not awaiting a command before submission");
  precondition.runtime_state = solverStatus.runtime_state;
  if (mode === "stage-b") {
    assert(Number.isSafeInteger(execution?.revision) && execution.revision >= 0,
      "Stage B precondition omitted the execution revision");
    precondition.stage_execution_revision = execution.revision;
  }
  assert(Array.isArray(commands?.commands), "Command queue resource is malformed");
  precondition.command_revision = commands.commands.length;
  return precondition;
}

function resultIdentities(resource, runId, expectedIds) {
  assert(plainRecord(resource) && Array.isArray(resource.results), "Study results resource is malformed");
  assert(resource.next_cursor == null, "Study result page is incomplete");
  const identities = resource.results.map(studyStageResultIdentity)
    .sort((left, right) => left.authored_stage_id.localeCompare(right.authored_stage_id));
  assert.deepEqual(identities.map((entry) => entry.authored_stage_id), expectedIds,
    "Study results include a missing, duplicate or extra authored stage");
  assert(identities.every((entry) => entry.source.run_id === runId),
    "Study result source belongs to another run");
  return identities;
}

function executionStageIds(execution, runId, session) {
  assert(plainRecord(execution) && execution.run_id === runId
    && execution.session_id === session.session_id
    && execution.session_epoch === session.session_epoch
    && execution.request_scope_epoch === session.request_scope_epoch,
  "Stage execution resource belongs to another run or session");
  assert(Array.isArray(execution.stages), "Stage execution omitted its stage rows");
  return execution.stages.map((stage) => stage?.stage_id);
}

function assertNoInflightCommands(queue) {
  assert(plainRecord(queue) && Array.isArray(queue.commands), "Simulation command queue is malformed");
  assert(queue.pending_count === 0 && queue.running_count === 0,
    "A Simulation command is pending or running before the P22 action");
  assert(queue.commands.every((command) => TERMINAL_COMMAND_STATES.has(command?.status)),
    "The command queue contains an in-flight or unknown command state");
}

function stableProjection(snapshot) {
  return {
    session: snapshot.session,
    current_run: {
      run_id: snapshot.currentRun.run_id,
      session_id: snapshot.currentRun.session_id,
      revision: snapshot.currentRun.revision,
      status: snapshot.currentRun.status,
      requested_backend: snapshot.currentRun.requested_backend,
      requested_device: snapshot.currentRun.requested_device,
      requested_precision: snapshot.currentRun.requested_precision,
    },
    current_session_script: snapshot.profile,
    resources: {
      ...Object.fromEntries([...regionRevisionKeys, "scene_revision", "mesh_revision", "domain_generation_id",
        "commands_revision", "stages_revision"].map((key) => [key, snapshot.status.resources[key]])),
    },
    solver_state: snapshot.solverStatus.runtime_state,
    commands: { revision: snapshot.commands.revision, count: snapshot.commands.commands.length,
      active_counts: [snapshot.commands.pending_count, snapshot.commands.running_count] },
    execution: {
      run_id: snapshot.execution.run_id,
      revision: snapshot.execution.revision,
      runtime_state: snapshot.execution.runtime_state,
      total_stages: snapshot.execution.total_stages,
      stage_ids: snapshot.stageIds,
      stage_statuses: snapshot.execution.stage_statuses,
    },
    scene_revision: snapshot.scene.revision,
    scene_stage_ids: snapshot.sceneStageIds,
    scene_profile: snapshot.sceneProfile,
    result_identities: snapshot.resultIdentities,
    precondition: snapshot.precondition,
  };
}

export async function runStudyStageRerun() {
  assert.equal(process.env.CONTROL_ROOM_BROWSER_QA_SCENARIO, scenario,
    "Managed Study stage rerun admission is required");
  const mode = process.argv[2];
  studyStageCommandForMode(mode);
  assert.equal(process.argv.length, 3, "The fixed Study stage runner accepts exactly one mode");
  assert.equal(process.env.CONTROL_ROOM_STUDY_STAGE_RERUN_MODE, mode);
  const upstreamUrl = process.env.CONTROL_ROOM_URL;
  const publicUrl = process.env.CONTROL_ROOM_PUBLIC_URL;
  const expectedSources = JSON.parse(process.env.CONTROL_ROOM_STUDY_STAGE_RERUN_SOURCE_SHA256 ?? "null");
  const beforeHashes = await sourceHashes();
  assert.deepEqual(beforeHashes, expectedSources, "Study stage rerun source pins differ");
  const expectedVersion = process.env.CONTROL_ROOM_EXPECTED_PLAYWRIGHT_VERSION;
  const require = createRequire(import.meta.url);
  const playwrightVersion = require("playwright/package.json").version;
  assert.equal(playwrightVersion, expectedVersion);
  const { chromium } = await import("playwright");
  const timeout = Number(process.env.CONTROL_ROOM_BROWSER_QA_TIMEOUT_MS);
  assert(Number.isInteger(timeout) && timeout >= 30_000 && timeout <= 900_000);
  const startedAt = Date.now();
  const cleanupReserveMs = 20_000;
  const timerBudget = () => Math.max(1, timeout - cleanupReserveMs - (Date.now() - startedAt));
  const readCounts = { status: 0, current_session: 0, scene: 0, commands: 0,
    current_run: 0, stage_execution: 0, solver_status: 0, stage_results: 0, command_details: 0 };
  const requestCounts = {};
  const errors = [];
  const violations = [];
  let totalRequests = 0;
  let phase = "preflight";
  let proxy, browser, context, page;
  let session = null;
  let before = null;
  let beforeSnapshot = null;
  let after = null;
  let commandCount = 0;
  let commandAttemptCount = 0;
  let clientAckCount = 0;
  let commandRequest = null;
  let commandReceipt = null;
  let executionBinding = null;
  let executionBindingReads = 0;
  let expectedPrecondition = null;
  let failure = null;
  let outcome = "not-dispatched";
  let publicTerminalProven = false;
  let uiCommandProven = false;
  let historyIdentityPreserved = null;

  function record(method, path) {
    totalRequests++;
    if (totalRequests > MAX_REQUESTS) throw new Error("Study stage rerun request evidence exceeded its bound");
    const key = method + " " + path;
    if (!Object.hasOwn(requestCounts, key) && Object.keys(requestCounts).length >= MAX_REQUEST_PATHS) {
      throw new Error("Study stage rerun API path inventory exceeded its bound");
    }
    requestCounts[key] = (requestCounts[key] ?? 0) + 1;
    if (requestCounts[key] > MAX_READS_PER_PATH) throw new Error("Study stage rerun per-path request budget exceeded");
  }

  async function apiGet(path, expectedSession = session, scoped = true) {
    record("GET", path);
    const response = await page.request.fetch(new URL(path, proxy.origin).href, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(scoped && expectedSession ? { "x-fullmag-session-scope": sessionScope(expectedSession) } : {}),
      },
      timeout: Math.min(10_000, timerBudget()),
    });
    assert(response.ok(), "P22 public API read was not acknowledged: " + path);
    const raw = await response.body();
    assert(raw.length <= MAX_API_BYTES, "P22 public API resource exceeded its size bound");
    return JSON.parse(raw.toString("utf8"));
  }

  async function readResults(runId, expectedSession, expectedStageIds) {
    const path = resultsBasePath + "?run_id=" + encodeURIComponent(runId) + "&limit=100";
    readCounts.stage_results++;
    const resource = await apiGet(path, expectedSession);
    return resultIdentities(resource, runId, expectedStageIds);
  }

  async function readSnapshot(expectedSession = null, {
    requireIdle = true,
    expectedStageIds = studyStageExpectedStageIds(mode, "before"),
  } = {}) {
    const status = await apiGet(statusPath, expectedSession, false);
    readCounts.status++;
    const observedSession = readSessionIdentity(status);
    if (expectedSession) assertSameSession(expectedSession, observedSession);
    else session = observedSession;
    if (requireIdle) {
      assert.equal(status.solver?.state, "awaiting_command", "P22 status solver is not awaiting a command");
    }
    const currentSession = await apiGet(currentSessionPath, observedSession);
    readCounts.current_session++;
    const scene = await apiGet(scenePath, observedSession);
    readCounts.scene++;
    const commands = await apiGet(commandsPath, observedSession);
    readCounts.commands++;
    const currentRun = await apiGet(currentRunPath, observedSession);
    readCounts.current_run++;
    const execution = await apiGet(executionPath, observedSession);
    readCounts.stage_execution++;
    const solverStatus = await apiGet(solverStatusPath, observedSession);
    readCounts.solver_status++;
    const statusAfter = await apiGet(statusPath, observedSession, false);
    readCounts.status++;
    const sessionAfter = readSessionIdentity(statusAfter);
    assertSameSession(observedSession, sessionAfter);
    for (const key of [...regionRevisionKeys, "scene_revision", "mesh_revision", "domain_generation_id",
      "commands_revision", "stages_revision"]) {
      assert.equal(statusAfter.resources?.[key], status.resources?.[key], "P22 status revisions changed during a snapshot");
    }
    if (requireIdle) assert.equal(statusAfter.solver?.state, "awaiting_command");
    assert.equal(currentRun?.session_id, observedSession.session_id,
      "Current run belongs to another P22 session");
    assert(typeof currentRun.run_id === "string" && currentRun.run_id.length > 0);
    assert.equal(currentRun.status, "completed", "P22 baseline run is not terminal-completed");
    assert.equal(statusAfter.run?.run_id, currentRun.run_id,
      "Status and owning current-run resource disagree");
    if (requireIdle) assertNoInflightCommands(commands);
    assert.equal(commands.revision, statusAfter.resources.commands_revision,
      "Command queue revision differs from current status");
    assert.equal(solverStatus?.runtime_state, "awaiting_command",
      "Owning solver status is not awaiting a command");
    const profile = currentProfile(statusAfter, currentRun, currentSession, expectedSources);
    const sceneStageIds = authoredSceneStageIds(scene);
    const sceneProfile = validateStudyStageScene(scene);
    assert.equal(scene.revision, statusAfter.resources.scene_revision,
      "Committed scene revision differs from the P22 status");
    const observedStageIds = executionStageIds(execution, currentRun.run_id, observedSession);
    assert.equal(execution.runtime_state, "completed", "P22 baseline stage execution is not completed");
    assert.equal(execution.total_stages, expectedStageIds.length);
    assert.deepEqual(observedStageIds, expectedStageIds, "P22 stage view differs from the selected phase");
    assert(execution.stage_statuses.every((value) => value === "completed"),
      "P22 baseline contains an unfinished stage");
    assert.deepEqual(execution.completed_stage_indexes, expectedStageIds.map((_, index) => index),
      "P22 baseline completed-stage indexes differ");
    const results = await readResults(currentRun.run_id, observedSession, expectedStageIds);
    const expectedResultIds = expectedStageIds;
    assert.deepEqual(results.map((result) => result.authored_stage_id), expectedResultIds,
      "P22 baseline durable results differ from the current stage view");
    const precondition = commandPrecondition(statusAfter, currentRun, execution, solverStatus, commands, mode);
    const fence = await apiGet(statusPath, observedSession, false);
    readCounts.status++;
    assertSameSession(observedSession, readSessionIdentity(fence));
    for (const key of [...regionRevisionKeys, "scene_revision", "mesh_revision", "domain_generation_id",
      "commands_revision", "stages_revision"]) {
      assert.equal(fence.resources?.[key], statusAfter.resources?.[key], "P22 revision fence changed after reads");
    }
    return {
      session: observedSession,
      status: statusAfter,
      currentSession,
      currentRun,
      execution,
      solverStatus,
      commands,
      scene,
      sceneStageIds,
      sceneProfile,
      stageIds: observedStageIds,
      profile,
      resultIdentities: results,
      precondition,
    };
  }

  function summary(snapshot) {
    return {
      run_id: snapshot.currentRun.run_id,
      run_status: snapshot.currentRun.status,
      solver_state: snapshot.solverStatus.runtime_state,
      execution_state: snapshot.execution.runtime_state,
      stage_ids: snapshot.stageIds,
      scene_profile: snapshot.sceneProfile,
      profile: snapshot.profile,
      result_identities: snapshot.resultIdentities,
      precondition: snapshot.precondition,
    };
  }

  function assertStageRerunSceneUnchanged(snapshot, expectedSession) {
    assertSameSession(expectedSession, snapshot.session);
    assert.deepEqual(snapshot.sceneStageIds, stageIds, "Authored P22 scene changed during the run");
    assert.equal(snapshot.scene.revision, beforeSnapshot?.precondition.scene_revision,
      "P22 scene changed during stage execution");
    assert.equal(snapshot.profile.domain_generation_id, before?.profile.domain_generation_id,
      "P22 domain generation changed during stage execution");
    assert.equal(snapshot.profile.domain_cell_count, 8);
    assert.equal(snapshot.profile.domain_discretization, "fdm");
    assert.equal(snapshot.profile.requested_backend, "fdm");
    assert.equal(snapshot.profile.requested_device, "cpu");
    assert.equal(snapshot.profile.requested_precision, "double");
    assert.equal(snapshot.profile.script_sha256, expectedSources.fixture);
  }

  async function readAfterCommand(expectedSession) {
    const status = await apiGet(statusPath, expectedSession, false);
    readCounts.status++;
    assertSameSession(expectedSession, readSessionIdentity(status));
    const currentRun = await apiGet(currentRunPath, expectedSession);
    readCounts.current_run++;
    const execution = await apiGet(executionPath, expectedSession);
    readCounts.stage_execution++;
    const solverStatus = await apiGet(solverStatusPath, expectedSession);
    readCounts.solver_status++;
    const commands = await apiGet(commandsPath, expectedSession);
    readCounts.commands++;
    for (const key of ["scene_revision", "mesh_revision", "domain_generation_id", ...regionRevisionKeys]) {
      assert.equal(status.resources?.[key], beforeSnapshot?.status.resources?.[key],
        "P22 authoring/resource precondition changed");
    }
    return { status, currentRun, execution, solverStatus, commands };
  }

  function retainExecutionBinding(candidate) {
    if (candidate == null) return false;
    assert(studyStageExecutionBindingMatches(candidate, mode, candidate.run_id),
      "The P22 command execution binding has the wrong target or selected step");
    if (executionBinding && canonical(executionBinding) !== canonical(candidate)) {
      throw new Error("The P22 accepted command execution binding changed across public readbacks");
    }
    executionBinding = candidate;
    commandReceipt.execution_binding = candidate;
    return true;
  }

  async function readExecutionBinding(commandId) {
    if (executionBinding) return true;
    if (executionBindingReads >= 8) return false;
    executionBindingReads++;
    const path = commandPath + "/" + encodeURIComponent(commandId);
    record("GET", path);
    readCounts.command_details++;
    const response = await page.request.fetch(new URL(path, proxy.origin).href, {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-fullmag-session-scope": sessionScope(session),
      },
      timeout: Math.min(10_000, timerBudget()),
    });
    if (response.status() === 404) return false;
    assert(response.ok(), "P22 command detail read was not acknowledged");
    const raw = await response.body();
    assert(raw.length <= 64 * 1024, "P22 command detail exceeded its size bound");
    const detail = JSON.parse(raw.toString("utf8"));
    assert(plainRecord(detail) && detail.command_id === commandId,
      "P22 command detail belongs to another command");
    return retainExecutionBinding(detail.execution_binding);
  }

  async function writeResult(result) {
    const encoded = JSON.stringify(result);
    assert(Buffer.byteLength(encoded, "utf8") <= MAX_RESULT_BYTES, "Study stage rerun result exceeded its bound");
    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(reportDir + "/result.json", encoded);
    process.stdout.write(encoded + "\n");
  }

  try {
    proxy = await startBrowserQaLoopbackProxy(publicUrl, upstreamUrl);
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--use-angle=swiftshader-webgl"],
    });
    context = await browser.newContext({ viewport: { width: 1440, height: 780 }, serviceWorkers: "block" });
    page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => { if (errors.length < 16) errors.push(boundedMessage(error)); });
    page.on("console", (message) => {
      if (message.type() === "error" && errors.length < 16) errors.push(boundedMessage(message.text()));
    });

    const initial = await readSnapshot(null, { requireIdle: true });
    session = initial.session;
    assert.deepEqual(stableProjection(initial), stableProjection(await readSnapshot(session, { requireIdle: true })),
      "P22 public resources changed between initial bounded snapshots");
    beforeSnapshot = initial;
    before = summary(initial);
    expectedPrecondition = initial.precondition;

    await page.route("**/v2/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      const path = url.pathname + url.search;
      try {
        record(method, path);
        if (method === "GET") return route.continue();
        if (method !== "POST" || !session) {
          if (violations.length < 16) violations.push("Unexpected non-GET API request: " + method + " " + url.pathname);
          return route.abort();
        }
        const scope = request.headers()["x-fullmag-session-scope"];
        if (url.pathname === clientAckPath) {
          const body = request.postDataJSON();
          if (!studyStageRerunClientAckAllowed({ method, path, scope, body }, session)
              || ++clientAckCount > MAX_CLIENT_ACKS) {
            if (violations.length < 16) violations.push("Invalid or over-budget visualization client acknowledgement");
            return route.abort();
          }
          return route.continue();
        }
        if (url.pathname === commandPath) {
          commandAttemptCount++;
          const body = request.postDataJSON();
          const allowed = studyStageRerunRequestAllowed(
            { method, path, scope, body },
            { mode, session, expectedPrecondition, commandCount, phase },
          );
          if (!allowed || commandCount !== 0) {
            if (violations.length < 16) violations.push("Rejected a duplicate or out-of-scope Study command");
            return route.abort();
          }
          commandRequest = request;
          commandReceipt = { method, path: url.pathname, status: null, scope_header: scope, payload: body };
          commandCount++;
          uiCommandProven = true;
          outcome = "unknown";
          phase = "command-dispatched";
          return route.continue();
        }
        if (violations.length < 16) violations.push("Rejected unexpected API mutation: " + method + " " + url.pathname);
        return route.abort();
      } catch (error) {
        if (violations.length < 16) violations.push(boundedMessage(error));
        return route.abort().catch(() => undefined);
      }
    });

    await page.goto(new URL("/workspace", proxy.origin).href, {
      waitUntil: "domcontentloaded", timeout: Math.min(90_000, timerBudget()),
    });
    const beforeClick = await readSnapshot(session, { requireIdle: true });
    assert.deepEqual(stableProjection(beforeClick), stableProjection(initial),
      "P22 current run, stage view or history changed before the UI action");
    beforeSnapshot = beforeClick;
    before = summary(beforeClick);
    expectedPrecondition = beforeClick.precondition;

    let action;
    if (mode === "stage-b") {
      for (const parentId of ["model:study", "model:study:stages"]) {
        const parent = page.locator('[role="treeitem"][data-node-id="' + parentId + '"]');
        await parent.waitFor({ state: "visible", timeout: Math.min(30_000, timerBudget()) });
        await parent.focus();
        if (await parent.getAttribute("aria-expanded") !== "true") await parent.press("ArrowRight");
      }
      const selectedStage = beforeClick.execution.stages.find((stage) => stage?.stage_id === "relax-b");
      assert(selectedStage, "The fresh completed stage execution omitted the exact Stage B target");
      const row = page.locator('[role="treeitem"][data-node-id="model:study:stages:stage:'
        + selectedStage.stage_id + '"]');
      assert.equal(await row.count(), 1, "The authored relax-b Explorer row is absent or duplicated");
      await row.click({ button: "right" });
      action = page.getByRole("menuitem", { name: "Run This Stage", exact: true });
    } else {
      const row = page.locator('[role="treeitem"][data-node-id="model:study"]');
      assert.equal(await row.count(), 1, "The Study Explorer row is absent or duplicated");
      await row.click({ button: "right" });
      action = page.getByRole("menuitem", { name: "Compute Study", exact: true });
    }
    await action.waitFor({ state: "visible", timeout: Math.min(15_000, timerBudget()) });
    assert.equal(await action.isEnabled(), true, "The pinned P22 command is disabled in the real UI");
    const responseWait = page.waitForResponse(
      (response) => {
        const request = response.request();
        const url = new URL(request.url());
        return request.method() === "POST" && url.pathname === commandPath
          && request.headers()["x-fullmag-session-scope"] === sessionScope(session);
      },
      { timeout: Math.min(20_000, timerBudget()) },
    ).catch((error) => { throw new Error("P22 command response was not observed: " + boundedMessage(error)); });
    phase = "ui-submit";
    await action.click();
    const commandResponse = await deadline(responseWait, Math.min(20_000, timerBudget()),
      "P22 command response timed out; native outcome is unknown");
    if (!commandRequest || commandCount !== 1 || !uiCommandProven) {
      throw new Error("The real UI did not submit exactly one guarded command");
    }
    assert.equal(commandResponse.request(), commandRequest,
      "The observed response was not for the exact guarded menu command");
    commandReceipt.status = commandResponse.status();
    const commandBody = await commandResponse.body();
    assert(commandBody.length <= 64 * 1024, "P22 command response exceeded its bound");
    const accepted = JSON.parse(commandBody.toString("utf8"));
    const acceptance = studyStageCommandResponseOutcome(commandResponse.status(), accepted);
    if (acceptance.outcome !== "accepted") {
      outcome = "unknown";
      throw new Error("The P22 command response did not establish durable acceptance; outcome is unknown");
    }
    commandReceipt.command_id = acceptance.command_id;
    if (accepted.execution_binding != null) {
      executionBinding = accepted.execution_binding;
      assert(studyStageExecutionBindingMatches(executionBinding, mode, executionBinding.run_id),
        "The accepted P22 command response has a mismatched execution binding");
      commandReceipt.execution_binding = executionBinding;
    }
    phase = "await-terminal";

    const expectedAfterIds = studyStageExpectedStageIds(mode, "after");
    const pollDeadline = Date.now() + Math.max(1, timerBudget() - 8_000);
    let terminal = null;
    while (Date.now() < pollDeadline) {
      if (!executionBinding) {
        await readExecutionBinding(accepted.command_id);
        if (!executionBinding) {
          await delay(Math.min(1_000, Math.max(0, pollDeadline - Date.now())));
          continue;
        }
      }
      const current = await readAfterCommand(session);
      const currentRunId = current.currentRun?.run_id;
      const commandState = current.commands?.commands?.find((entry) => entry.command_id === accepted.command_id);
      if (commandState?.execution_binding) retainExecutionBinding(commandState.execution_binding);
      if (currentRunId === executionBinding.run_id && currentRunId !== before.run_id
          && current.status.run?.run_id === currentRunId
          && current.currentRun.status === "completed"
          && current.execution.run_id === currentRunId
          && current.execution.runtime_state === "completed"
          && current.solverStatus.runtime_state === "awaiting_command"
          && current.status.solver?.state === "awaiting_command"
          && (!commandState || TERMINAL_COMMAND_STATES.has(commandState.status))) {
        terminal = current;
        break;
      }
      await delay(Math.min(1_000, Math.max(0, pollDeadline - Date.now())));
    }
    if (!terminal) {
      outcome = "unknown";
      throw new Error("P22 command was submitted but public terminal state was not observed before the bounded deadline");
    }

    assert.notEqual(terminal.currentRun.run_id, before.run_id, "P22 command reused the previous run ID");
    assert(studyStageExecutionBindingMatches(executionBinding, mode, terminal.currentRun.run_id),
      "P22 public terminal run does not match the accepted command execution binding");
    const afterSnapshot = await readSnapshot(session, {
      requireIdle: true,
      expectedStageIds: expectedAfterIds,
    });
    assert.equal(afterSnapshot.currentRun.run_id, terminal.currentRun.run_id,
      "P22 current run changed between terminal poll and result reads");
    assertStageRerunSceneUnchanged(afterSnapshot, session);
    assert.deepEqual(afterSnapshot.stageIds, expectedAfterIds,
      "P22 current stage view includes an unexpected stage");
    assert.deepEqual(afterSnapshot.execution.stage_statuses, expectedAfterIds.map(() => "completed"));
    const afterOldResults = await readResults(
      before.run_id, session, studyStageExpectedStageIds(mode, "before"),
    );
    const newResults = afterSnapshot.resultIdentities;
    historyIdentityPreserved = studyStageHistoryIdentitiesPreserved(before.result_identities, afterOldResults);
    assert.equal(historyIdentityPreserved, true, "A previous Study result identity changed");
    assert.deepEqual(afterOldResults, before.result_identities,
      "A previous Study run lost or changed its durable result identities");
    assert.deepEqual(newResults.map((entry) => entry.authored_stage_id), expectedAfterIds,
      "New P22 run results contain a stage outside the selected mode");
    after = summary(afterSnapshot);
    after.preserved_prior_result_identities = afterOldResults;
    publicTerminalProven = true;
    outcome = "terminal-confirmed";
  } catch (error) {
    failure = boundedMessage(error);
    if (commandCount === 1) outcome = "unknown";
  } finally {
    const afterHashes = await sourceHashes().catch((error) => {
      errors.push(boundedMessage(error));
      return null;
    });
    if (JSON.stringify(afterHashes) !== JSON.stringify(beforeHashes)) {
      failure ??= "Study stage rerun proof sources changed during the managed browser operation";
    }
    await context?.close().catch((error) => { errors.push(boundedMessage(error)); });
    await browser?.close().catch((error) => { errors.push(boundedMessage(error)); });
    await proxy?.close().catch((error) => { errors.push(boundedMessage(error)); });
    const result = {
      schema,
      scenario,
      state: failure ? (outcome === "unknown" ? "outcome-unknown" : "failed") : "passed",
      mode,
      failure,
      public_url: publicUrl,
      probe_url: upstreamUrl,
      playwright_version: playwrightVersion,
      browser_gpu_mode: process.env.CONTROL_ROOM_BROWSER_GPU_MODE,
      source_sha256_before: beforeHashes,
      source_sha256_after: afterHashes,
      session_before: session,
      session_after: session,
      before,
      command_receipt: commandReceipt,
      command_count: commandCount,
      command_attempt_count: commandAttemptCount,
      client_ack_count: clientAckCount,
      ui_command_proven: uiCommandProven,
      after,
      history_identity_preserved: historyIdentityPreserved,
      public_terminal_proven: publicTerminalProven,
      native_execution_proven: false,
      field_data_proven: false,
      outcome,
      read_counts: readCounts,
      request_counts: requestCounts,
      total_requests: totalRequests,
      request_limit: MAX_REQUESTS,
      request_path_limit: MAX_REQUEST_PATHS,
      per_path_read_limit: MAX_READS_PER_PATH,
      violations,
      errors,
      proxy_failures: proxy?.failures.slice(0, 16).map(boundedMessage) ?? [],
    };
    if (phase === "preflight" && !session) result.session_after = null;
    await writeResult(result).catch((error) => {
      process.stdout.write(JSON.stringify({ schema, scenario, state: "failed", outcome,
        failure: boundedMessage(error), native_execution_proven: false, field_data_proven: false }) + "\n");
      process.exitCode = 1;
    });
    if (result.state !== "passed") process.exitCode = 1;
    return result;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runStudyStageRerun();
  } catch (error) {
    process.stdout.write(JSON.stringify({
      schema,
      scenario,
      state: "failed",
      mode: process.argv[2] ?? null,
      outcome: "not-dispatched",
      native_execution_proven: false,
      field_data_proven: false,
      failure: boundedMessage(error),
    }) + "\n");
    process.exitCode = 1;
  }
}
