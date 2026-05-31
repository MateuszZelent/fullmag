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
  process.env.CONTROL_ROOM_COMPUTE_SMOKE_TIMEOUT_MS ?? 180_000,
);
const pollMs = Number(process.env.CONTROL_ROOM_COMPUTE_SMOKE_POLL_MS ?? 500);
const COMPUTE_RESPONSIVENESS_PROBE_INTERVAL_MS = 50;
const COMPUTE_RESPONSIVENESS_DELAY_THRESHOLD_MS = 50;
const VIEWPORT_3D_SELECTOR = ".fm-viewport-3d";
const VIEWPORT_3D_CANVAS_SELECTOR = ".fm-viewport-3d canvas";
const COMPUTE_VIEWPORT_GESTURE_LABEL = "compute-viewport-camera-gestures";
const COMPUTE_VIEWPORT_GESTURE_SETTLE_MS = 25;

const STRICT_COMPUTE_ACTIONS = [
  { actionId: "study.compute-fields", kind: "compute_fields", label: "Compute Fields" },
  { actionId: "study.compute-energies", kind: "compute_energies", label: "Compute Energies" },
  { actionId: "study.run", kind: "solve", label: "Compute Study" },
];

const VIEWPORT_3D_COMPUTE_MEASURE_NAMES = [
  "fullmag.viewport3d.buildViewport3DTopologyRenderModel",
  "fullmag.viewport3d.buildMeshQualityVertexColors",
  "fullmag.viewport3d.buildFdmCuboidInstanceModel",
  "fullmag.viewport3d.buildViewport3DFieldRenderModel",
  "fullmag.viewport3d.buildVectorGlyphInstances",
  "fullmag.viewport3d.uploadVectorGlyphColors",
  "fullmag.viewport3d.uploadVectorGlyphMatrices",
];
const BINARY_RESOURCE_MEASURE_NAMES = [
  "fullmag.api.requestBinaryResource.topology",
  "fullmag.api.requestBinaryResource.topology.transport",
  "fullmag.api.requestBinaryResource.topology.decode",
  "fullmag.api.requestBinaryResource.mesh-quality-data",
  "fullmag.api.requestBinaryResource.mesh-quality-data.transport",
  "fullmag.api.requestBinaryResource.mesh-quality-data.decode",
  "fullmag.api.requestBinaryResource.field-vector",
  "fullmag.api.requestBinaryResource.field-vector.transport",
  "fullmag.api.requestBinaryResource.field-vector.decode",
];
const REACT_RENDER_MEASURE_NAMES = [
  "fullmag.react.render.ExplorerModule.mount",
  "fullmag.react.render.ExplorerModule.update",
  "fullmag.react.render.RibbonModule.mount",
  "fullmag.react.render.RibbonModule.update",
  "fullmag.react.render.Viewport3DModule.mount",
  "fullmag.react.render.Viewport3DModule.update",
  "fullmag.react.render.FooterModule.mount",
  "fullmag.react.render.FooterModule.update",
  "fullmag.react.render.WorkspaceDockLayout.mount",
  "fullmag.react.render.WorkspaceDockLayout.update",
];
const COMPUTE_PERFORMANCE_MEASURE_NAMES = [
  ...VIEWPORT_3D_COMPUTE_MEASURE_NAMES,
  ...BINARY_RESOURCE_MEASURE_NAMES,
  ...REACT_RENDER_MEASURE_NAMES,
];
const TERMINAL_COMMAND_STATUSES = new Set([
  "cancelled",
  "completed",
  "failed",
  "rejected",
  "skipped",
]);
const ACCEPTANCE_RESOURCE_RELOAD_GRACE_MS = 100;
const FORBIDDEN_ACCEPTANCE_RESOURCE_PATHS = new Set([
  "/v2/sessions/current/data/fields",
  "/v2/sessions/current/data/scalars",
  "/v2/sessions/current/simulation/solver/energies/current",
  "/v2/sessions/current/simulation/solver/energies/history",
]);
const COMPUTE_VIEWPORT_GESTURE_FORBIDDEN_REQUEST_PREFIXES = [
  "/v2/sessions/current/model/",
  "/v2/sessions/current/meshing/",
  "/v2/sessions/current/visualization/state",
];

const viewportGestureRequests = [];
let recordViewportGestureRequests = false;


async function main() {
  await assertActiveSession();
  const playwright = await loadPlaywright();
  if (!playwright?.chromium) {
    throw new Error(
      "Compute performance smoke requires Playwright or @playwright/test in the current environment.",
    );
  }

  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });
  const errors = [];
  const commandRequests = [];
  const commandResponses = [];
  const resultResourceRequests = [];

  await page.addInitScript((baseUrl) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      controlRoomApiBase: baseUrl,
    };
  }, apiBase);
  await installComputePerformanceProbe(page, {
    responsivenessDelayThresholdMs: COMPUTE_RESPONSIVENESS_DELAY_THRESHOLD_MS,
    responsivenessProbeIntervalMs: COMPUTE_RESPONSIVENESS_PROBE_INTERVAL_MS,
  });

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (!isIgnorableConsoleError(text)) {
      errors.push(text);
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (recordViewportGestureRequests && isCurrentSessionResourceUrl(request.url())) {
      viewportGestureRequests.push({
        method: request.method(),
        path: pathnameFromUrl(request.url()),
        timestamp: Date.now(),
        url: request.url(),
      });
    }

    if (request.method() === "GET" && isForbiddenAcceptanceResourceUrl(request.url())) {
      resultResourceRequests.push({
        path: pathnameFromUrl(request.url()),
        timestamp: Date.now(),
        url: request.url(),
      });
    }

    if (!isSimulationCommandsUrl(request.url())) return;
    if (request.method() !== "POST") return;
    commandRequests.push({
      postData: request.postData(),
      timestamp: Date.now(),
      url: request.url(),
    });
  });
  page.on("response", (response) => {
    if (!isSimulationCommandsUrl(response.url())) return;
    if (response.request().method() !== "POST") return;
    commandResponses.push({
      status: response.status(),
      timestamp: Date.now(),
      url: response.url(),
    });
  });

  try {
    await page.goto(workspaceUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await page.locator("main").waitFor({ state: "visible", timeout: timeoutMs });
    await ensureViewport3DActive(page);
    await page.getByRole("tab", { name: "Study" }).first().click({ timeout: timeoutMs });
    await waitForComputeActionReady(page, STRICT_COMPUTE_ACTIONS[0]);
    await resetComputePerformanceProbe(page);

    const actionResults = [];
    for (const action of STRICT_COMPUTE_ACTIONS) {
      const result = await clickComputeAction(page, action, resultResourceRequests);
      actionResults.push(result);
      if (action.kind === "solve") {
        await cleanupSolveCommand(result.commandId);
      }
    }

    if (errors.length > 0) {
      throw new Error("Browser console errors:\n" + errors.join("\n"));
    }

    const metrics = await collectComputePerformanceProbe(page, {
      actionResults,
      commandRequestCount: commandRequests.length,
      commandResponseCount: commandResponses.length,
      label: "compute-performance-smoke",
      resultResourceRequestCount: actionResults.reduce(
        (total, result) => total + result.resultResourceRequestCount,
        0,
      ),
    });
    console.log(`Compute performance metrics: ${JSON.stringify(metrics)}`);
    console.log(`Compute performance smoke passed at ${workspaceUrl}.`);
  } finally {
    await browser.close();
  }
}

async function clickComputeAction(page, action, resultResourceRequests) {
  const button = await waitForComputeActionReady(page, action);

  const commandLedgerBefore = await readCommandLedger();
  const resultResourceStartIndex = resultResourceRequests.length;
  const commandAcceptancePromise = waitForCommandAcceptanceFromBrowserResponse(
    page,
    action,
  );
  await button.click({ timeout: timeoutMs });
  const commandAcceptance = await Promise.race([
    commandAcceptancePromise,
    waitForCommandAcceptanceFromLedger(action, commandLedgerBefore),
  ]);
  const commandAcceptedAt = Date.now();

  await page.waitForTimeout(ACCEPTANCE_RESOURCE_RELOAD_GRACE_MS);
  assertNoImmediateResultResourceReloads({
    action,
    commandAcceptedAt,
    requests: resultResourceRequests.slice(resultResourceStartIndex),
  });

  let detail;
  let viewportGestureProof = null;
  if (action.kind === "solve") {
    detail = await waitForSolveExecutionProof(commandAcceptance.commandId);
    viewportGestureProof = await verifyViewport3DGesturesDuringSolve(page);
  } else {
    detail = await waitForCommandSettled(commandAcceptance.commandId, action.kind);
  }
  return {
    actionId: action.actionId,
    commandId: commandAcceptance.commandId,
    kind: action.kind,
    resultResourceRequestCount: resultResourceRequests.length - resultResourceStartIndex,
    status: commandStatus(detail),
    viewportGestureProof,
  };
}

async function waitForCommandAcceptanceFromBrowserResponse(page, action) {
  const commandResponse = await page.waitForResponse(
    (response) =>
      isSimulationCommandsUrl(response.url()) &&
      response.request().method() === "POST",
    { timeout: timeoutMs },
  );
  const responseText = await commandResponse.text();
  if (!commandResponse.ok()) {
    throw new Error(
      `${action.label} request failed with ${commandResponse.status()}: ${responseText}`,
    );
  }
  const responseBody = responseText ? JSON.parse(responseText) : {};
  if (!responseBody.accepted) {
    throw new Error(
      `${action.label} was rejected: ${responseBody.error ?? "unknown error"}`,
    );
  }
  if (typeof responseBody.command_id !== "string") {
    throw new Error(`${action.label} response did not include command_id.`);
  }
  return { commandId: responseBody.command_id, source: "browser-response" };
}

async function waitForCommandAcceptanceFromLedger(action, previousLedger) {
  const previousCommandIds = new Set(
    (previousLedger?.commands ?? [])
      .map((command) => command.command_id)
      .filter((commandId) => typeof commandId === "string"),
  );
  return poll(`${action.label} command accepted in backend ledger`, async () => {
    const ledger = await readCommandLedger();
    const command = (ledger.commands ?? []).find(
      (entry) =>
        entry.kind === action.kind &&
        typeof entry.command_id === "string" &&
        !previousCommandIds.has(entry.command_id),
    );
    if (!command) return null;
    if (command.status === "rejected" || command.completion_status === "rejected") {
      throw new Error(
        `${action.label} was rejected in command ledger: ${
          command.error ?? command.completion_reason ?? "unknown error"
        }`,
      );
    }
    return { commandId: command.command_id, source: "command-ledger" };
  });
}

async function waitForComputeActionReady(page, action) {
  const button = page.locator(`[data-action-id="${cssAttributeValue(action.actionId)}"]`).first();
  await button.waitFor({ state: "visible", timeout: timeoutMs });
  await waitForEnabledAction(button, action.label);
  return button;
}

async function ensureViewport3DActive(page) {
  const viewportTab = page.getByRole("tab", { name: "3D Viewport" }).first();
  if ((await viewportTab.count()) > 0) {
    await viewportTab.click({ timeout: timeoutMs });
  }

  await waitForCanvasClipBox(page);
  const { drawingBuffer, hasContext } = await readCanvasContextState(page);
  if (!hasContext || drawingBuffer.width <= 0 || drawingBuffer.height <= 0) {
    throw new Error(
      `3D viewport canvas is not renderable before compute smoke: context=${hasContext} drawingBuffer=${drawingBuffer.width}x${drawingBuffer.height}.`,
    );
  }
}

async function verifyViewport3DGesturesDuringSolve(page) {
  const box = await waitForCanvasClipBox(page);
  const x = box.x + box.width * 0.5;
  const y = box.y + box.height * 0.5;
  const startIndex = viewportGestureRequests.length;

  let cameraSignature = await readViewportCameraSignature(page);
  cameraSignature = await assertViewportGestureDoesNotFetch(
    page,
    "compute orbit rotate",
    cameraSignature,
    "left-button orbit rotate changes the compute viewport camera state",
    async () => {
      await page.mouse.move(x, y);
      await page.mouse.down({ button: "left" });
      await page.mouse.move(x + 120, y + 42, { steps: 8 });
      await page.mouse.up({ button: "left" });
    },
  );

  cameraSignature = await assertViewportGestureDoesNotFetch(
    page,
    "compute wheel zoom",
    cameraSignature,
    "wheel zoom changes the compute viewport camera state",
    async () => {
      await page.mouse.move(x, y);
      for (let index = 0; index < 4; index += 1) {
        await page.mouse.wheel(0, -240);
      }
    },
  );

  await assertViewportGestureDoesNotFetch(
    page,
    "compute right pan",
    cameraSignature,
    "right-button pan changes the compute viewport camera state",
    async () => {
      await page.mouse.down({ button: "right" });
      await page.mouse.move(x + 80, y + 36, { steps: 8 });
      await page.mouse.up({ button: "right" });
    },
  );

  const { drawingBuffer, hasContext } = await readCanvasContextState(page);
  if (!hasContext || drawingBuffer.width <= 0 || drawingBuffer.height <= 0) {
    throw new Error(
      `3D viewport canvas is not renderable after compute camera gestures: context=${hasContext} drawingBuffer=${drawingBuffer.width}x${drawingBuffer.height}.`,
    );
  }

  const requests = viewportGestureRequests.slice(startIndex);
  const unexpectedRequests = unexpectedViewportGestureRequests(requests);
  if (unexpectedRequests.length > 0) {
    throw new Error(
      `${COMPUTE_VIEWPORT_GESTURE_LABEL} emitted background resource work: ` +
        unexpectedRequests
          .map((request) => `${request.method} ${request.path}`)
          .join(", "),
    );
  }

  return {
    canvasHasContext: hasContext,
    drawingBuffer,
    forbiddenRequestCount: unexpectedRequests.length,
    label: COMPUTE_VIEWPORT_GESTURE_LABEL,
    requestCount: requests.length,
  };
}

async function assertViewportGestureDoesNotFetch(
  page,
  gestureName,
  previousCameraSignature,
  cameraChangeLabel,
  gesture,
) {
  const startIndex = viewportGestureRequests.length;
  let nextCameraSignature = previousCameraSignature;
  recordViewportGestureRequests = true;
  try {
    await gesture();
    await waitForViewportGestureSettle(page);
    nextCameraSignature = await waitForCameraSignatureChange(
      page,
      previousCameraSignature,
      cameraChangeLabel,
    );
  } finally {
    recordViewportGestureRequests = false;
  }

  const unexpectedRequests = unexpectedViewportGestureRequests(
    viewportGestureRequests.slice(startIndex),
  );
  if (unexpectedRequests.length > 0) {
    throw new Error(
      `${gestureName} triggered unexpected resource work: ` +
        unexpectedRequests
          .map((request) => `${request.method} ${request.path}`)
          .join(", "),
    );
  }
  return nextCameraSignature;
}

function unexpectedViewportGestureRequests(requests) {
  return requests.filter((request) =>
    COMPUTE_VIEWPORT_GESTURE_FORBIDDEN_REQUEST_PREFIXES.some((prefix) =>
      request.path.startsWith(prefix),
    ),
  );
}

async function waitForViewportGestureSettle(page) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => resolve(null))),
  );
  await page.waitForTimeout(COMPUTE_VIEWPORT_GESTURE_SETTLE_MS);
}

async function waitForCameraSignatureChange(page, previousSignature, label) {
  return poll(label, async () => {
    const signature = await readViewportCameraSignature(page);
    return signature && signature !== previousSignature ? signature : null;
  });
}

async function readViewportCameraSignature(page) {
  return page.evaluate((selector) => {
    const node = document.querySelector(selector);
    return [
      node?.getAttribute("data-camera-position") ?? "",
      node?.getAttribute("data-camera-target") ?? "",
      node?.getAttribute("data-camera-projection") ?? "",
    ].join("|");
  }, VIEWPORT_3D_SELECTOR);
}

async function readCanvasContextState(page) {
  return page.evaluate((selector) => {
    const node = document.querySelector(selector);
    if (!(node instanceof HTMLCanvasElement)) {
      return {
        drawingBuffer: { height: 0, width: 0 },
        hasContext: false,
      };
    }
    const context = node.getContext("webgl2") ?? node.getContext("webgl");
    return {
      drawingBuffer: {
        height: context?.drawingBufferHeight ?? 0,
        width: context?.drawingBufferWidth ?? 0,
      },
      hasContext: Boolean(context),
    };
  }, VIEWPORT_3D_CANVAS_SELECTOR);
}

async function waitForCanvasClipBox(page) {
  return poll("measurable 3D viewport canvas bounds", async () => {
    const box = await readCanvasClipBox(page);
    return box.width > 0 && box.height > 0 ? box : null;
  });
}

async function readCanvasClipBox(page) {
  return page.evaluate((selector) => {
    const node = document.querySelector(selector);
    if (!(node instanceof HTMLCanvasElement)) {
      return { height: 0, width: 0, x: 0, y: 0 };
    }
    const rect = node.getBoundingClientRect();
    return {
      height: rect.height,
      width: rect.width,
      x: rect.x,
      y: rect.y,
    };
  }, VIEWPORT_3D_CANVAS_SELECTOR);
}

function assertNoImmediateResultResourceReloads({
  action,
  commandAcceptedAt,
  requests,
}) {
  const immediateRequests = requests.filter(
    (request) =>
      request.timestamp >= commandAcceptedAt &&
      request.timestamp - commandAcceptedAt <= ACCEPTANCE_RESOURCE_RELOAD_GRACE_MS,
  );
  if (immediateRequests.length === 0) return;

  const formatted = immediateRequests
    .map((request) => `${request.path} at +${request.timestamp - commandAcceptedAt}ms`)
    .join(", ");
  throw new Error(
    `${action.label} triggered immediate result resource reload(s) after command acceptance: ${formatted}`,
  );
}

async function waitForEnabledAction(button, label) {
  return poll(`${label} action enabled`, async () => {
    const state = await button.evaluate((node) => ({
      dataDisabled: node.getAttribute("data-disabled"),
      disabled: node instanceof HTMLButtonElement ? node.disabled : false,
      title: node.getAttribute("title"),
    }));
    if (!state.disabled && state.dataDisabled !== "true") {
      return state;
    }
    throw new Error(
      `${label} disabled (title=${state.title ?? "none"}, data-disabled=${state.dataDisabled})`,
    );
  });
}

async function waitForCommandSettled(commandId, kind) {
  return waitForJson(
    `/v2/sessions/current/simulation/commands/${encodeURIComponent(commandId)}`,
    `${kind} command settled`,
    (value) =>
      value.command_id === commandId &&
      value.kind === kind &&
      TERMINAL_COMMAND_STATUSES.has(commandStatus(value)),
  );
}

async function waitForSolveExecutionProof(commandId) {
  return poll(`solve command ${commandId} to start solver execution`, async () => {
    const [command, execution, solverStatus] = await Promise.all([
      getJson(
        `/v2/sessions/current/simulation/commands/${encodeURIComponent(commandId)}`,
      ),
      getJson("/v2/sessions/current/simulation/stages/execution"),
      getJson("/v2/sessions/current/simulation/solver/status"),
    ]);
    if (command.command_id !== commandId || command.kind !== "solve") {
      return null;
    }

    assertCommandDidNotFail(command, "Compute Study");
    if (hasSolveStageExecutionProof(commandId, command, execution, solverStatus)) {
      return command;
    }
    if (isCommandTerminal(command)) {
      throw new Error(
        `Compute Study reached terminal status without solver/stage execution proof: ${formatCommandTerminalStatus(command)}`,
      );
    }
    return null;
  });
}

function assertCommandDidNotFail(command, label) {
  const status = commandStatus(command);
  const completionStatus = commandCompletionStatus(command);
  if (
    status === "failed" ||
    status === "rejected" ||
    completionStatus === "failed" ||
    completionStatus === "rejected" ||
    completionStatus === "cancelled"
  ) {
    throw new Error(
      `${label} did not start successfully: ${formatCommandTerminalStatus(command)}`,
    );
  }
}

function hasSolveStageExecutionProof(commandId, command, execution, solverStatus) {
  if (command.started_at_unix_ms != null) {
    return true;
  }

  const stages = Array.isArray(execution.stages) ? execution.stages : [];
  const linkedStage = stages.find((stage) => stage.command_id === commandId);
  if (linkedStage) {
    if (linkedStage.started_at_unix_ms != null || linkedStage.completed_at_unix_ms != null) {
      return true;
    }
    if (["running", "completed"].includes(String(linkedStage.status ?? ""))) {
      return true;
    }
  }

  const activeIndex = execution.active_stage_index;
  const activeStage = Number.isInteger(activeIndex)
    ? stages.find((stage) => stage.index === activeIndex)
    : null;
  const activeStageMatchesCommand = activeStage?.command_id === commandId;
  const executionState = String(execution.runtime_state ?? "");
  const solverState = String(
    solverStatus.runtime_state ?? solverStatus.runtime_status_kind ?? "",
  );
  return (
    activeStageMatchesCommand &&
    (["running", "paused"].includes(executionState) ||
      ["running", "paused"].includes(solverState))
  );
}

function isCommandTerminal(command) {
  return TERMINAL_COMMAND_STATUSES.has(commandStatus(command));
}

function commandStatus(detail) {
  return String(detail.status ?? detail.status_kind ?? "");
}

function commandCompletionStatus(detail) {
  return String(detail.completion_status ?? "");
}

function formatCommandTerminalStatus(command) {
  return [
    `status=${commandStatus(command) || "unknown"}`,
    `completion_status=${commandCompletionStatus(command) || "none"}`,
    command.error ? `error=${command.error}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

async function cleanupSolveCommand(commandId) {
  const cleanupState = await waitForSolveCleanupState(commandId);
  if (cleanupState === "terminal") return;

  const response = await postJson("/v2/sessions/current/simulation/commands", {
    client_intent_id: `compute-performance-smoke:stop:${commandId}:${Date.now()}`,
    kind: "stop",
    reason: "compute_performance_smoke_cleanup",
    requested_at_unix_ms: Date.now(),
    target: { kind: "current_stage" },
  });
  if (!response.accepted) {
    throw new Error(
      `Cleanup stop command was rejected: ${response.error ?? "unknown error"}`,
    );
  }
  await waitForRuntimeState(
    (nextState) => !["running", "paused"].includes(nextState),
    "runtime stopped after compute performance smoke",
  );
}

async function waitForSolveCleanupState(commandId) {
  return poll(`solve command ${commandId} ready for cleanup`, async () => {
    const [command, execution] = await Promise.all([
      getJson(
        `/v2/sessions/current/simulation/commands/${encodeURIComponent(commandId)}`,
      ),
      getJson("/v2/sessions/current/simulation/stages/execution"),
    ]);
    if (TERMINAL_COMMAND_STATUSES.has(commandStatus(command))) {
      return "terminal";
    }

    const runtimeState = String(execution.runtime_state ?? "");
    const activeStage = activeStageForExecution(execution);
    if (
      ["running", "paused"].includes(runtimeState) &&
      activeStage?.command_id === commandId
    ) {
      return "active-stage";
    }
    return null;
  });
}

function activeStageForExecution(execution) {
  const activeIndex = execution.active_stage_index;
  const stages = Array.isArray(execution.stages) ? execution.stages : [];
  if (!Number.isInteger(activeIndex)) return null;
  return stages.find((stage) => stage.index === activeIndex) ?? null;
}

async function assertActiveSession() {
  let status;
  try {
    status = await getJson("/v2/sessions/current/status");
  } catch (error) {
    throw new Error(
      `Active session status is unavailable at ${apiBase}: ${error.message}`,
    );
  }

  const sessionId = status.session?.session_id ?? status.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("Active session status does not include a session id.");
  }
}

async function installComputePerformanceProbe(
  page,
  { responsivenessDelayThresholdMs, responsivenessProbeIntervalMs },
) {
  await page.addInitScript(({ measureNames, responsivenessDelayThresholdMs, responsivenessProbeIntervalMs }) => {
    window.__FULLMAG_REACT_PROFILER__ = true;
    const now = performance.now();
    const state = {
      longTasks: [],
      measures: [],
      resetStartTime: now,
      resources: [],
      responsiveness: {
        delayedTickCount: 0,
        expectedAt: now + responsivenessProbeIntervalMs,
        maxDelayMs: 0,
        sampleCount: 0,
        totalDelayMs: 0,
      },
      supportedEntryTypes:
        typeof PerformanceObserver === "undefined"
          ? []
          : PerformanceObserver.supportedEntryTypes ?? [],
    };
    window.__FULLMAG_COMPUTE_PERFORMANCE__ = state;
    window.__FULLMAG_RESET_COMPUTE_PERFORMANCE__ = () => {
      const resetStartTime = performance.now();
      state.longTasks = [];
      state.measures = [];
      state.resources = [];
      state.resetStartTime = resetStartTime;
      state.responsiveness.delayedTickCount = 0;
      state.responsiveness.expectedAt = resetStartTime + responsivenessProbeIntervalMs;
      state.responsiveness.maxDelayMs = 0;
      state.responsiveness.sampleCount = 0;
      state.responsiveness.totalDelayMs = 0;
      performance.clearMeasures?.();
      performance.clearResourceTimings?.();
    };
    startResponsivenessProbe(
      state,
      responsivenessProbeIntervalMs,
      responsivenessDelayThresholdMs,
    );

    function observePerformanceEntries(type, handler) {
      if (typeof PerformanceObserver === "undefined") return;
      if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return;
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            handler(entry);
          }
        });
        observer.observe({ buffered: true, type });
      } catch {
        // Browser support for buffered observers differs across Chromium versions.
      }
    }

    function startResponsivenessProbe(state, intervalMs, thresholdMs) {
      function probeTick() {
        const now = performance.now();
        const delayMs = Math.max(0, now - state.responsiveness.expectedAt);
        state.responsiveness.sampleCount += 1;
        if (delayMs > thresholdMs) {
          state.responsiveness.delayedTickCount += 1;
          state.responsiveness.maxDelayMs = Math.max(
            state.responsiveness.maxDelayMs,
            delayMs,
          );
          state.responsiveness.totalDelayMs += delayMs;
        }
        state.responsiveness.expectedAt = now + intervalMs;
        setTimeout(probeTick, intervalMs);
      }
      setTimeout(probeTick, intervalMs);
    }

    observePerformanceEntries("longtask", (entry) => {
      if (entry.startTime < state.resetStartTime) return;
      state.longTasks.push({
        duration: entry.duration,
        name: entry.name,
        startTime: entry.startTime,
      });
    });
    observePerformanceEntries("measure", (entry) => {
      if (!measureNames.includes(entry.name)) return;
      if (entry.startTime < state.resetStartTime) return;
      state.measures.push({
        duration: entry.duration,
        name: entry.name,
        startTime: entry.startTime,
      });
    });
    observePerformanceEntries("resource", (entry) => {
      if (!String(entry.name).includes("/v2/sessions/current/")) return;
      if (entry.startTime < state.resetStartTime) return;
      state.resources.push({
        duration: entry.duration,
        initiatorType: entry.initiatorType,
        name: entry.name,
        startTime: entry.startTime,
        transferSize: entry.transferSize,
      });
    });
  }, {
    measureNames: COMPUTE_PERFORMANCE_MEASURE_NAMES,
    responsivenessDelayThresholdMs,
    responsivenessProbeIntervalMs,
  });
}

async function resetComputePerformanceProbe(page) {
  await page.evaluate(() => {
    const reset = window.__FULLMAG_RESET_COMPUTE_PERFORMANCE__;
    if (typeof reset !== "function") {
      throw new Error("Compute performance probe reset hook is not installed.");
    }
    reset();
  });
}

async function collectComputePerformanceProbe(
  page,
  {
    actionResults,
    commandRequestCount,
    commandResponseCount,
    label,
    resultResourceRequestCount,
  },
) {
  return page.evaluate(
    ({
      actionResults,
      commandRequestCount,
      commandResponseCount,
      label,
      measureNames,
      resultResourceRequestCount,
    }) => {
      const state = window.__FULLMAG_COMPUTE_PERFORMANCE__ ?? {
        longTasks: [],
        measures: [],
        resources: [],
        supportedEntryTypes: [],
      };
      const sessionResourceEntries = performance
        .getEntriesByType("resource")
        .filter(
          (entry) =>
            entry.startTime >= (state.resetStartTime ?? 0) &&
            String(entry.name).includes("/v2/sessions/current/"),
        )
        .map((entry) => ({
          duration: entry.duration,
          initiatorType: entry.initiatorType,
          name: entry.name,
          startTime: entry.startTime,
          transferSize: entry.transferSize,
        }));
      const measureEntries = performance
        .getEntriesByType("measure")
        .filter(
          (entry) =>
            entry.startTime >= (state.resetStartTime ?? 0) &&
            measureNames.includes(entry.name),
        )
        .map((entry) => ({
          duration: entry.duration,
          name: entry.name,
          startTime: entry.startTime,
        }));
      const resources = dedupePerformanceRows([
        ...state.resources,
        ...sessionResourceEntries,
      ]);
      const measuredEntries = dedupePerformanceRows([
        ...state.measures,
        ...measureEntries,
      ]);
      const binaryResourceMeasureNames = measureNames.filter((name) =>
        name.startsWith("fullmag.api.requestBinaryResource."),
      );
      const reactRenderMeasureNames = measureNames.filter((name) =>
        name.startsWith("fullmag.react.render."),
      );
      const viewportMeasureNames = measureNames.filter((name) =>
        name.startsWith("fullmag.viewport3d."),
      );
      const binaryResourceMeasures = measuredEntries.filter((entry) =>
        binaryResourceMeasureNames.includes(entry.name),
      );
      const viewportMeasures = measuredEntries.filter((entry) =>
        viewportMeasureNames.includes(entry.name),
      );
      const reactRenderMeasures = measuredEntries.filter((entry) =>
        reactRenderMeasureNames.includes(entry.name),
      );
      const longTasks = state.longTasks;
      const responsiveness = state.responsiveness ?? {
        delayedTickCount: 0,
        maxDelayMs: 0,
        sampleCount: 0,
        totalDelayMs: 0,
      };

      return {
        actionResults,
        commandRequestCount,
        commandResponseCount,
        compute_metrics: true,
        delayedResponsivenessTickCount: responsiveness.delayedTickCount,
        label,
        longTaskCount: longTasks.length,
        maxLongTaskMs: Math.max(0, ...longTasks.map((entry) => entry.duration)),
        maxResponsivenessDelayMs: responsiveness.maxDelayMs,
        binaryResourceMeasureCount: binaryResourceMeasures.length,
        binaryResourceMeasureTotals: summarizeMeasureTotals(
          binaryResourceMeasureNames,
          binaryResourceMeasures,
        ),
        reactRenderMeasureCount: reactRenderMeasures.length,
        resultResourceRequestCount,
        reactRenderMeasureTotals: summarizeMeasureTotals(
          reactRenderMeasureNames,
          reactRenderMeasures,
        ),
        responsivenessSampleCount: responsiveness.sampleCount,
        sessionRequestCount: resources.length,
        supportedEntryTypes: state.supportedEntryTypes,
        totalLongTaskMs: longTasks.reduce(
          (total, entry) => total + entry.duration,
          0,
        ),
        totalResponsivenessDelayMs: responsiveness.totalDelayMs,
        viewportMeasureCount: viewportMeasures.length,
        viewportMeasureTotals: summarizeMeasureTotals(
          viewportMeasureNames,
          viewportMeasures,
        ),
      };

      function summarizeMeasureTotals(names, entries) {
        return Object.fromEntries(
          names.map((name) => {
            const rows = entries.filter((entry) => entry.name === name);
            return [
              name,
              {
                count: rows.length,
                maxDurationMs: Math.max(0, ...rows.map((entry) => entry.duration)),
                totalDurationMs: rows.reduce(
                  (total, entry) => total + entry.duration,
                  0,
                ),
              },
            ];
          }),
        );
      }

      function dedupePerformanceRows(rows) {
        const seen = new Set();
        return rows.filter((row) => {
          const key = `${row.name}:${row.startTime}:${row.duration}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
    },
    {
      actionResults,
      commandRequestCount,
      commandResponseCount,
      label,
      measureNames: COMPUTE_PERFORMANCE_MEASURE_NAMES,
      resultResourceRequestCount,
    },
  );
}

async function waitForRuntimeState(predicate, label) {
  return waitForJson(
    "/v2/sessions/current/simulation/solver/status",
    label,
    (value) => predicate(String(value.runtime_state ?? value.runtime_status_kind ?? "")),
  );
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

async function readCommandLedger() {
  const ledger = await getJson("/v2/sessions/current/simulation/commands");
  if (!Array.isArray(ledger.commands)) {
    throw new Error("Command ledger response did not include commands array.");
  }
  return ledger;
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

function isSimulationCommandsUrl(responseUrl) {
  return pathnameFromUrl(responseUrl) === "/v2/sessions/current/simulation/commands";
}

function isForbiddenAcceptanceResourceUrl(requestUrl) {
  const pathname = pathnameFromUrl(requestUrl);
  return (
    FORBIDDEN_ACCEPTANCE_RESOURCE_PATHS.has(pathname) ||
    /^\/v2\/sessions\/current\/simulation\/objects\/[^/]+\/metrics$/.test(
      pathname,
    )
  );
}

function isCurrentSessionResourceUrl(requestUrl) {
  return pathnameFromUrl(requestUrl).startsWith("/v2/sessions/current/");
}

function pathnameFromUrl(rawUrl) {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return "";
  }
}

function isIgnorableConsoleError(text) {
  return text === "Failed to load resource: the server responded with a status of 404 (Not Found)";
}

function cssAttributeValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(
    `Compute performance smoke failed: ${error.stack ?? error.message}`,
  );
  process.exit(1);
});
