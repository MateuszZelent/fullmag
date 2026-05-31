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
const runtimeActiveTitlePattern = /(?:runtime command|Runtime) is already active/i;
const buttonStateOnly =
  process.env.CONTROL_ROOM_STUDY_SMOKE_BUTTON_STATE_ONLY === "1";

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
const runtimeDebugPaths = new Set([
  "/v2/sessions/current/status",
  "/v2/sessions/current/simulation/commands",
  "/v2/sessions/current/simulation/solver/status",
  "/v2/sessions/current/simulation/stages/execution",
]);
const runtimeDebugEntryLimit = 30;

async function main() {
  const workspace = await openWorkspaceIfRequested();

  try {
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
    await waitForRuntimeRibbonControlState(
      workspace?.page,
      "study.run",
      { disabled: true, titlePattern: runtimeActiveTitlePattern },
      "Compute ribbon button disabled while runtime is active",
    );
    if (buttonStateOnly) {
      await waitForRuntimeRibbonControlState(
        workspace?.page,
        "study.stop",
        { disabled: false },
        "Stop ribbon button enabled while runtime is running",
      );
      console.log(
        `Study runtime button-state smoke passed against ${apiBase} for object ${objectId}.`,
      );
      return;
    }

    await waitForRuntimeRibbonControlState(
      workspace?.page,
      "study.pause",
      { disabled: false },
      "Pause ribbon button enabled while runtime is running",
    );

    await submitAndObserveCommand("pause");
    await waitForRuntimeState((state) => state === "paused", "solver paused");
    await waitForStageExecution(
      (execution) =>
        execution.runtime_state === "paused" &&
        execution.stages.some((stage) => stage.status === "paused"),
      "paused stage execution",
    );
    await waitForRuntimeRibbonControlState(
      workspace?.page,
      "study.resume",
      { disabled: false },
      "Resume ribbon button enabled while runtime is paused",
    );
    await waitForRuntimeRibbonControlState(
      workspace?.page,
      "study.discard-paused-state",
      { disabled: false },
      "Discard ribbon button enabled while runtime is paused",
    );
    await waitForRuntimeRibbonControlState(
      workspace?.page,
      "study.run",
      { disabled: true, titlePattern: runtimeActiveTitlePattern },
      "Compute ribbon button remains disabled while runtime is paused",
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
    await waitForRuntimeRibbonControlState(
      workspace?.page,
      "study.pause",
      { disabled: true, titlePattern: /Runtime is not running/ },
      "Pause ribbon button disabled after runtime stops",
    );
    await waitForRuntimeRibbonControlState(
      workspace?.page,
      "study.run",
      { forbiddenTitlePattern: runtimeActiveTitlePattern },
      "Compute ribbon button no longer reflects stale active runtime",
    );

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

    await submitAndObserveCommand("solve");
    await waitForRuntimeState(
      (state) => state === "running",
      "solver running before paused-state discard",
    );
    await waitForActiveStage("active stage before paused-state discard");
    await submitAndObserveCommand("pause");
    await waitForRuntimeState(
      (state) => state === "paused",
      "solver paused before paused-state discard",
    );
    await waitForRuntimeRibbonControlState(
      workspace?.page,
      "study.discard-paused-state",
      { disabled: false },
      "Discard ribbon button enabled before paused-state discard",
    );
    await submitAndObserveCommand("stop", {
      reason: "discard_paused_state",
    });
    await waitForRuntimeState(
      (state) => !["running", "paused"].includes(state),
      "solver inactive after paused-state discard",
    );
    await waitForStageExecution(
      (execution) =>
        execution.active_stage_index == null &&
        !["running", "paused"].includes(String(execution.runtime_state ?? "")),
      "stage execution inactive after paused-state discard",
    );
    await waitForRuntimeRibbonControlState(
      workspace?.page,
      "study.discard-paused-state",
      { disabled: true, titlePattern: /Runtime is not paused/ },
      "Discard ribbon button disabled after paused-state discard",
    );
    await waitForRuntimeRibbonControlState(
      workspace?.page,
      "study.stop",
      { disabled: true, titlePattern: /Runtime is not active/ },
      "Stop ribbon button disabled after paused-state discard",
    );
    await waitForRuntimeRibbonControlState(
      workspace?.page,
      "study.run",
      { forbiddenTitlePattern: runtimeActiveTitlePattern },
      "Compute ribbon button no longer reflects stale active runtime after paused-state discard",
    );
    await waitForEngineLog(
      /Paused stage discarded|Paused state discarded/i,
      "paused-state discard engine log",
    );

    console.log(
      `Study runtime control smoke passed against ${apiBase} for object ${objectId}, checkpoint ${checkpoint.checkpoint_id}, and paused-state discard reset.`,
    );
  } finally {
    await workspace?.close();
  }
}

async function openWorkspaceIfRequested() {
  if (browserMode === "0") return null;
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
    return null;
  }

  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });
  const errors = [];
  page.__runtimeResourceResponses = [];
  page.__runtimeWsFrames = [];
  const wrongApiRequests = [];
  const expectedApiOrigin = new URL(apiBase).origin;
  await page.addInitScript((baseUrl) => {
    window.__FULLMAG_WS_DEBUG__ = [];
    const NativeWebSocket = window.WebSocket;
    if (typeof NativeWebSocket === "function") {
      window.WebSocket = function FullmagSmokeWebSocket(url, protocols) {
        const entry = {
          events: [],
          protocols,
          ts: Date.now(),
          url: String(url),
        };
        window.__FULLMAG_WS_DEBUG__.push(entry);
        const socket = new NativeWebSocket(url, protocols);
        socket.addEventListener("open", () => entry.events.push({ type: "open", ts: Date.now() }));
        socket.addEventListener("close", (event) =>
          entry.events.push({
            code: event.code,
            reason: event.reason,
            ts: Date.now(),
            type: "close",
          }),
        );
        socket.addEventListener("error", () => entry.events.push({ type: "error", ts: Date.now() }));
        socket.addEventListener("message", (event) =>
          entry.events.push({
            data: typeof event.data === "string" ? event.data.slice(0, 300) : "[binary]",
            ts: Date.now(),
            type: "message",
          }),
        );
        return socket;
      };
      window.WebSocket.CONNECTING = NativeWebSocket.CONNECTING;
      window.WebSocket.OPEN = NativeWebSocket.OPEN;
      window.WebSocket.CLOSING = NativeWebSocket.CLOSING;
      window.WebSocket.CLOSED = NativeWebSocket.CLOSED;
      window.WebSocket.prototype = NativeWebSocket.prototype;
    }
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      controlRoomApiBase: baseUrl,
    };
  }, apiBase);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname.startsWith("/v2/sessions/current") &&
      url.origin !== expectedApiOrigin
    ) {
      wrongApiRequests.push(request.url());
    }
  });
  page.on("response", async (response) => {
    try {
      const url = new URL(response.url());
      if (
        url.origin !== expectedApiOrigin ||
        !runtimeDebugPaths.has(url.pathname)
      ) {
        return;
      }
      const entry = {
        body: null,
        method: response.request().method(),
        pathname: url.pathname,
        status: response.status(),
        ts: Date.now(),
      };
      const contentType = response.headers()["content-type"] ?? "";
      if (contentType.includes("application/json")) {
        entry.body = summarizeRuntimeDebugBody(await response.json());
      }
      pushLimited(page.__runtimeResourceResponses, entry, runtimeDebugEntryLimit);
    } catch (error) {
      pushLimited(
        page.__runtimeResourceResponses,
        {
          error: error instanceof Error ? error.message : String(error),
          ts: Date.now(),
        },
        runtimeDebugEntryLimit,
      );
    }
  });
  page.on("websocket", (socket) => {
    try {
      const url = new URL(socket.url());
      if (url.origin !== expectedApiOrigin || url.pathname !== "/v2/sessions/current/events/ws") {
        return;
      }
      pushLimited(
        page.__runtimeWsFrames,
        { direction: "open", ts: Date.now(), url: socket.url() },
        runtimeDebugEntryLimit,
      );
      socket.on("framereceived", (event) => {
        pushLimited(
          page.__runtimeWsFrames,
          {
            direction: "received",
            frame: summarizeRuntimeWsFrame(event?.payload ?? event),
            ts: Date.now(),
          },
          runtimeDebugEntryLimit,
        );
      });
    } catch (error) {
      pushLimited(
        page.__runtimeWsFrames,
        {
          direction: "error",
          error: error instanceof Error ? error.message : String(error),
          ts: Date.now(),
        },
        runtimeDebugEntryLimit,
      );
    }
  });

  try {
    await page.goto(workspaceUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.locator("main").waitFor({ state: "visible", timeout: 15_000 });
    if (wrongApiRequests.length > 0) {
      throw new Error(
        `Workspace used wrong API origin; expected ${expectedApiOrigin}, saw ${wrongApiRequests
          .slice(0, 5)
          .join(", ")}`,
      );
    }
    if (errors.length > 0) {
      throw new Error(
        `Workspace emitted console/page errors: ${errors.join("\n")}`,
      );
    }
  } catch (error) {
    await browser.close();
    throw error;
  }
  return {
    close: () => browser.close(),
    page,
  };
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

async function waitForRuntimeRibbonControlState(
  page,
  commandId,
  { disabled, forbiddenTitlePattern, titlePattern },
  label,
) {
  if (!page) return;

  await page.waitForFunction(
    ({ commandId, disabled, forbiddenTitlePattern, titlePattern }) => {
      const button = document.querySelector(`[data-action-id="${commandId}"]`);
      if (!(button instanceof HTMLButtonElement)) return false;
      const actualDisabled =
        button.disabled || button.getAttribute("data-disabled") === "true";
      if (typeof disabled === "boolean" && actualDisabled !== disabled) {
        return false;
      }

      const title =
        button.getAttribute("title") ??
        button.closest(".fm-ribbon-action-shell")?.getAttribute("title") ??
        "";
      if (titlePattern) {
        const expected = new RegExp(titlePattern.source, titlePattern.flags);
        if (!expected.test(title)) return false;
      }
      if (forbiddenTitlePattern) {
        const forbidden = new RegExp(
          forbiddenTitlePattern.source,
          forbiddenTitlePattern.flags,
        );
        if (forbidden.test(title)) return false;
      }
      return true;
    },
    {
      commandId,
      disabled,
      forbiddenTitlePattern: regexpPayload(forbiddenTitlePattern),
      titlePattern: regexpPayload(titlePattern),
    },
    { timeout: Math.min(timeoutMs, 30_000) },
  ).catch((error) => {
    return runtimeRibbonControlDebug(page, commandId).then((debug) => {
      throw new Error(`${label}: ${error.message}\n${debug}`);
    });
  });
}

function regexpPayload(pattern) {
  return pattern ? { flags: pattern.flags, source: pattern.source } : null;
}

async function runtimeRibbonControlDebug(page, commandId) {
  try {
    const debug = await page.evaluate((targetCommandId) => {
      const buttons = [...document.querySelectorAll("[data-action-id]")].map(
        (button) => ({
          dataActionId: button.getAttribute("data-action-id"),
          dataDisabled: button.getAttribute("data-disabled"),
          disabled:
            button instanceof HTMLButtonElement ? button.disabled : null,
          text: button.textContent?.trim() ?? "",
          title:
            button.getAttribute("title") ??
            button.closest(".fm-ribbon-action-shell")?.getAttribute("title") ??
            "",
        }),
      );
      return {
        activeElementActionId:
          document.activeElement?.getAttribute("data-action-id") ?? null,
        buttonCount: buttons.length,
        matchingButtons: buttons.filter(
          (entry) => entry.dataActionId === targetCommandId,
        ),
        runtimeButtons: buttons.filter((entry) =>
          entry.dataActionId?.startsWith("study."),
        ),
        wsDebug: window.__FULLMAG_WS_DEBUG__ ?? [],
      };
    }, commandId);
    return `Runtime ribbon debug: ${JSON.stringify(
      {
        ...debug,
        runtimeResourceResponses: page.__runtimeResourceResponses ?? [],
        runtimeWsFrames: page.__runtimeWsFrames ?? [],
      },
      null,
      2,
    )}`;
  } catch (debugError) {
    return `Runtime ribbon debug failed: ${
      debugError instanceof Error ? debugError.message : String(debugError)
    }`;
  }
}

function pushLimited(target, entry, limit) {
  if (!Array.isArray(target)) return;
  target.push(entry);
  if (target.length > limit) {
    target.splice(0, target.length - limit);
  }
}

function summarizeRuntimeDebugBody(body) {
  if (!body || typeof body !== "object") return body;
  if (Array.isArray(body)) return { length: body.length };
  return {
    accepted_count: body.accepted_count,
    active_stage_index: body.active_stage_index,
    can_accept_commands: body.can_accept_commands,
    command_completion_revision: body.resources?.command_completion_revision,
    commands_revision: body.resources?.commands_revision,
    completed_count: body.completed_count,
    pending_count: body.pending_count,
    revision: body.revision,
    running_count: body.running_count,
    runtime_controls: Array.isArray(body.runtime_controls)
      ? body.runtime_controls
      : undefined,
    runtime_state: body.runtime_state,
    session_solver_state: body.solver?.state,
    stage_statuses: body.stage_statuses,
    stages_revision: body.resources?.stages_revision,
  };
}

function summarizeRuntimeWsFrame(payload) {
  const text =
    typeof payload === "string"
      ? payload
      : Buffer.isBuffer(payload)
        ? payload.toString("utf8")
        : String(payload);
  try {
    const parsed = JSON.parse(text);
    return {
      changes: parsed.payload?.changes,
      run_id: parsed.run_id,
      seq: parsed.seq,
      session_id: parsed.session_id,
      type: parsed.type,
    };
  } catch {
    return text.slice(0, 300);
  }
}

function resolveObjectId(scene) {
  const object = scene.objects.find((entry) => typeof entry.id === "string");
  if (!object) {
    throw new Error("Scene has no object id suitable for object metrics readback.");
  }
  return object.id;
}

async function submitAndObserveCommand(kind, options = {}) {
  const response = await postJson("/v2/sessions/current/simulation/commands", {
    client_intent_id: `study-runtime-smoke:${kind}:${Date.now()}`,
    kind,
    reason: options.reason ?? "smoke_acceptance",
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
      typeof value.has_solver_sample === "boolean" &&
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
