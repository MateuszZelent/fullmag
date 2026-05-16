const apiBase = (
  process.env.CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_RUNTIME_HTTP_BASE ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:8081"
).replace(/\/$/, "");

const workspaceUrl =
  process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const timeoutMs = Number(
  process.env.CONTROL_ROOM_STUDY_SMOKE_TIMEOUT_MS ?? 180_000,
);
const pollMs = Number(process.env.CONTROL_ROOM_STUDY_SMOKE_POLL_MS ?? 500);
const browserMode = process.env.CONTROL_ROOM_STUDY_SMOKE_BROWSER ?? "1";

const commandResourceExpectations = {
  compute_fields: ["data/fields", "visualization/display"],
  compute_energies: [
    "data/scalars",
    "simulation/solver/energies/current",
    "simulation/objects/*/metrics",
  ],
  pause: ["simulation/stages/execution", "simulation/solver/status"],
  resume: ["simulation/stages/execution", "simulation/solver/status"],
  skip: ["simulation/stages/execution", "simulation/solver/status"],
  solve: ["simulation/stages/execution", "simulation/solver/status"],
  stop: ["simulation/stages/execution", "simulation/solver/status"],
};

async function main() {
  await openWorkspaceIfRequested();

  await waitForJson(
    "/v2/sessions/current/status",
    "active session status",
    (status) =>
      typeof status.session?.session_id === "string" ||
      typeof status.session_id === "string",
  );

  const scene = await waitForJson(
    "/v2/sessions/current/model/scene",
    "authoring scene with objects",
    (value) => Array.isArray(value.objects) && value.objects.length > 0,
  );
  const objectId = resolveObjectId(scene);
  await waitForEngineLog(
    /Script materialized|waiting for compute|Dev mesh API smoke test passed/i,
    "materialized interactive workspace",
  );

  const initialSolver = await getJson(
    "/v2/sessions/current/simulation/solver/status",
  );
  const initialStep = Number(initialSolver.step_index ?? 0);
  const initialTime = Number(initialSolver.sim_time_seconds ?? 0);

  await submitAndObserveCommand("compute_fields");
  await waitForEngineLog(
    /Field snapshots computed|Compute fields requested/i,
    "compute fields log",
  );
  await assertSolverDidNotAdvance(initialStep, initialTime, "compute_fields");

  await submitAndObserveCommand("compute_energies");
  await waitForEnergyReadback("compute energies readback");
  await waitForObjectMetrics(objectId, "object metrics after compute energies");
  await assertSolverDidNotAdvance(initialStep, initialTime, "compute_energies");

  await submitAndObserveCommand("solve");
  await waitForRuntimeState(
    (state) => state === "running",
    "solver running after Start Study",
  );
  await waitForActiveStage("active stage after Start Study");

  await submitAndObserveCommand("pause");
  await waitForRuntimeState((state) => state === "paused", "solver paused");
  await waitForStageExecution(
    (execution) =>
      execution.runtime_state === "paused" &&
      execution.stages.some((stage) => stage.status === "paused"),
    "paused stage execution",
  );

  const checkpoint = await createCheckpoint();
  await waitForCheckpoint(checkpoint.checkpoint_id);

  await submitAndObserveCommand("resume");
  await waitForStageExecution(
    (execution) =>
      execution.stages.some(
        (stage) =>
          stage.resume_from_checkpoint_ref || stage.state_transition === "resumed",
      ) || execution.runtime_state === "running",
    "resume checkpoint linkage",
  );

  await submitAndObserveCommand("skip");
  await waitForStageExecution(
    (execution) =>
      execution.completed_stage_indexes.length > 0 ||
      execution.stages.some((stage) => stage.status === "skipped"),
    "skipped stage execution",
  );

  const stateAfterSkip = await runtimeState();
  if (["running", "paused"].includes(stateAfterSkip)) {
    await submitAndObserveCommand("stop");
    await waitForRuntimeState(
      (state) => !["running", "paused"].includes(state),
      "solver stopped",
    );
  }

  await restoreCheckpoint(checkpoint.checkpoint_id);
  await waitForStageExecution(
    (execution) =>
      execution.stages.some(
        (stage) =>
          stage.loaded_state_ref ||
          stage.checkpoint_ref === checkpoint.checkpoint_id ||
          stage.state_transition === "restored",
      ),
    "restore checkpoint linkage",
  );

  await submitAndObserveCommand("compute_energies");
  await waitForEnergyReadback("compute energies after restore");
  await waitForObjectMetrics(objectId, "object metrics after restore");
  await waitForEngineLog(
    /Energies computed|Checkpoint restored|Loaded workspace state|Pause/i,
    "runtime footer/engine log entries",
  );

  console.log(
    `Study runtime control smoke passed against ${apiBase} for object ${objectId} and checkpoint ${checkpoint.checkpoint_id}.`,
  );
}

async function openWorkspaceIfRequested() {
  if (browserMode === "0") return;
  const playwright = await loadPlaywright();
  if (!playwright?.chromium) {
    if (browserMode === "required") {
      throw new Error(
        "Playwright is required for workspace smoke but is not installed.",
      );
    }
    console.warn(
      "Playwright unavailable; continuing with API lifecycle smoke only.",
    );
    return;
  }

  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  try {
    await page.goto(workspaceUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.locator("main").waitFor({ state: "visible", timeout: 15_000 });
    if (errors.length > 0) {
      throw new Error(
        `Workspace emitted console/page errors: ${errors.join("\n")}`,
      );
    }
  } finally {
    await browser.close();
  }
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    try {
      return await import("@playwright/test");
    } catch {
      return null;
    }
  }
}

function resolveObjectId(scene) {
  const object = scene.objects.find((entry) => typeof entry.id === "string");
  if (!object) {
    throw new Error("Scene has no object id suitable for object metrics readback.");
  }
  return object.id;
}

async function submitAndObserveCommand(kind) {
  const response = await postJson("/v2/sessions/current/simulation/commands", {
    client_intent_id: `study-runtime-smoke:${kind}:${Date.now()}`,
    kind,
    reason: "smoke_acceptance",
    requested_at_unix_ms: Date.now(),
    target: {
      kind: ["compute_fields", "compute_energies", "solve"].includes(kind)
        ? "study"
        : "current_stage",
    },
  });
  if (!response.accepted) {
    throw new Error(
      `Command ${kind} was rejected: ${response.error ?? "unknown error"}`,
    );
  }

  const detail = await waitForJson(
    `/v2/sessions/current/simulation/commands/${encodeURIComponent(response.command_id)}`,
    `${kind} command detail`,
    (value) =>
      value.command_id === response.command_id &&
      value.kind === kind &&
      commandHasExpectedInvalidations(kind, value),
  );
  return detail;
}

function commandHasExpectedInvalidations(kind, detail) {
  const expected = commandResourceExpectations[kind] ?? [];
  if (expected.length === 0) return true;
  const actual = new Set(
    Array.isArray(detail.resource_invalidations)
      ? detail.resource_invalidations.map((entry) => entry.resource_key)
      : [],
  );
  return expected.every((key) => actual.has(key));
}

async function createCheckpoint() {
  const response = await postJson(
    "/v2/sessions/current/persistence/checkpoints",
    {
      profile: "resume",
      reason: "smoke_acceptance",
    },
  );
  const checkpoint = response.checkpoint;
  if (!checkpoint?.checkpoint_id) {
    throw new Error("Checkpoint create response did not include checkpoint.checkpoint_id.");
  }
  if (!checkpoint.resume_class) {
    throw new Error("Checkpoint create response did not include resume_class provenance.");
  }
  return checkpoint;
}

async function restoreCheckpoint(checkpointId) {
  const response = await postJson(
    `/v2/sessions/current/persistence/checkpoints/${encodeURIComponent(checkpointId)}/restore`,
    { reason: "smoke_acceptance" },
  );
  if (response.restored_vector_count <= 0) {
    throw new Error(
      `Checkpoint restore returned invalid restored_vector_count=${response.restored_vector_count}.`,
    );
  }
  if (!response.restore_class) {
    throw new Error("Checkpoint restore response did not include restore_class.");
  }
  return response;
}

async function waitForCheckpoint(checkpointId) {
  return waitForJson(
    "/v2/sessions/current/persistence/checkpoints",
    `checkpoint catalog entry ${checkpointId}`,
    (value) =>
      Array.isArray(value.checkpoints) &&
      value.checkpoints.some((entry) => entry.checkpoint_id === checkpointId),
  );
}

async function waitForRuntimeState(predicate, label) {
  return waitForJson(
    "/v2/sessions/current/simulation/solver/status",
    label,
    (value) => predicate(String(value.runtime_state ?? value.runtime_status_kind ?? "")),
  );
}

async function runtimeState() {
  const value = await getJson("/v2/sessions/current/simulation/solver/status");
  return String(value.runtime_state ?? value.runtime_status_kind ?? "");
}

async function waitForStageExecution(predicate, label) {
  return waitForJson(
    "/v2/sessions/current/simulation/stages/execution",
    label,
    (value) => Array.isArray(value.stages) && predicate(value),
  );
}

async function waitForActiveStage(label) {
  return waitForStageExecution(
    (execution) =>
      execution.runtime_state === "running" &&
      Number.isInteger(execution.active_stage_index) &&
      execution.stages.some((stage) => stage.status === "running"),
    label,
  );
}

async function waitForEnergyReadback(label) {
  return waitForJson(
    "/v2/sessions/current/simulation/solver/energies/current",
    label,
    (value) => Number.isFinite(value.total) && Number.isFinite(value.step),
  );
}

async function waitForObjectMetrics(objectId, label) {
  return waitForJson(
    `/v2/sessions/current/simulation/objects/${encodeURIComponent(objectId)}/metrics`,
    label,
    (value) =>
      value.object_id === objectId &&
      value.has_solver_sample === true &&
      Number.isFinite(value.energies?.total),
  );
}

async function waitForEngineLog(pattern, label) {
  return waitForJson(
    "/v2/sessions/current/diagnostics/engine-log",
    label,
    (value) =>
      Array.isArray(value.entries) &&
      value.entries.some((entry) => pattern.test(String(entry.message ?? ""))),
  );
}

async function assertSolverDidNotAdvance(step, timeSeconds, label) {
  const current = await getJson(
    "/v2/sessions/current/simulation/solver/status",
  );
  const currentStep = Number(current.step_index ?? 0);
  const currentTime = Number(current.sim_time_seconds ?? 0);
  if (currentStep !== step || currentTime !== timeSeconds) {
    throw new Error(
      `${label} advanced solver state: before step/time=${step}/${timeSeconds}, after=${currentStep}/${currentTime}`,
    );
  }
}

async function waitForJson(path, label, ready) {
  return poll(label, async () => {
    const value = await getJson(path);
    return ready(value) ? value : null;
  });
}

async function poll(label, read) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(pollMs);
  }
  const suffix = lastError ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${label}.${suffix}`);
}

async function getJson(path) {
  const response = await fetch(`${apiBase}${path}`, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  return readJsonResponse(response, "GET", path);
}

async function postJson(path, body) {
  const response = await fetch(`${apiBase}${path}`, {
    body: JSON.stringify(body),
    cache: "no-store",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    method: "POST",
  });
  return readJsonResponse(response, "POST", path);
}

async function readJsonResponse(response, method, path) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} failed with ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(
    `Study runtime control smoke failed: ${error.stack ?? error.message}`,
  );
  process.exit(1);
});
