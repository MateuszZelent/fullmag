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

const STRICT_COMPUTE_ACTIONS = [
  { actionId: "study.compute-fields", kind: "compute_fields", label: "Compute Fields" },
  { actionId: "study.compute-energies", kind: "compute_energies", label: "Compute Energies" },
  { actionId: "study.run", kind: "solve", label: "Compute Study" },
];

const VIEWPORT_3D_COMPUTE_MEASURE_NAMES = [
  "fullmag.viewport3d.buildTopologyRenderModel",
  "fullmag.viewport3d.buildMeshQualityVertexColors",
  "fullmag.viewport3d.buildFdmCuboidInstanceModel",
  "fullmag.viewport3d.buildFieldRenderModel",
];
const REACT_RENDER_MEASURE_NAMES = [
  "fullmag.react.render.ExplorerModule.mount",
  "fullmag.react.render.ExplorerModule.update",
  "fullmag.react.render.RibbonModule.mount",
  "fullmag.react.render.RibbonModule.update",
  "fullmag.react.render.Viewport3DModule.mount",
  "fullmag.react.render.Viewport3DModule.update",
  "fullmag.react.render.WorkspaceDockLayout.mount",
  "fullmag.react.render.WorkspaceDockLayout.update",
];
const COMPUTE_PERFORMANCE_MEASURE_NAMES = [
  ...VIEWPORT_3D_COMPUTE_MEASURE_NAMES,
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
    await page.locator("main").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByRole("tab", { name: "Study" }).first().click({ timeout: 30_000 });

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
  const button = page.locator(`[data-action-id="${cssAttributeValue(action.actionId)}"]`).first();
  await button.waitFor({ state: "visible", timeout: timeoutMs });
  await waitForEnabledAction(button, action.label);

  const resultResourceStartIndex = resultResourceRequests.length;
  const commandResponsePromise = page.waitForResponse(
    (response) =>
      isSimulationCommandsUrl(response.url()) &&
      response.request().method() === "POST",
    { timeout: timeoutMs },
  );
  await button.click({ timeout: timeoutMs });
  const commandResponse = await commandResponsePromise;
  const commandAcceptedAt = Date.now();
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

  await page.waitForTimeout(ACCEPTANCE_RESOURCE_RELOAD_GRACE_MS);
  assertNoImmediateResultResourceReloads({
    action,
    commandAcceptedAt,
    requests: resultResourceRequests.slice(resultResourceStartIndex),
  });

  const detail =
    action.kind === "solve"
      ? await waitForCommandDetail(responseBody.command_id, action.kind)
      : await waitForCommandSettled(responseBody.command_id, action.kind);
  return {
    actionId: action.actionId,
    commandId: responseBody.command_id,
    kind: action.kind,
    resultResourceRequestCount: resultResourceRequests.length - resultResourceStartIndex,
    status: commandStatus(detail),
  };
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

async function waitForCommandDetail(commandId, kind) {
  return waitForJson(
    `/v2/sessions/current/simulation/commands/${encodeURIComponent(commandId)}`,
    `${kind} command detail`,
    (value) => value.command_id === commandId && value.kind === kind,
  );
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

function commandStatus(detail) {
  return String(detail.status ?? detail.status_kind ?? "");
}

async function cleanupSolveCommand(commandId) {
  const state = await runtimeState().catch(() => "");
  if (!["running", "paused"].includes(state)) return;

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
    const state = {
      longTasks: [],
      measures: [],
      resources: [],
      responsiveness: {
        delayedTickCount: 0,
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
      let expectedAt = performance.now() + intervalMs;
      function probeTick() {
        const now = performance.now();
        const delayMs = Math.max(0, now - expectedAt);
        state.responsiveness.sampleCount += 1;
        if (delayMs > thresholdMs) {
          state.responsiveness.delayedTickCount += 1;
          state.responsiveness.maxDelayMs = Math.max(
            state.responsiveness.maxDelayMs,
            delayMs,
          );
          state.responsiveness.totalDelayMs += delayMs;
        }
        expectedAt = now + intervalMs;
        setTimeout(probeTick, intervalMs);
      }
      setTimeout(probeTick, intervalMs);
    }

    observePerformanceEntries("longtask", (entry) => {
      state.longTasks.push({
        duration: entry.duration,
        name: entry.name,
        startTime: entry.startTime,
      });
    });
    observePerformanceEntries("measure", (entry) => {
      if (!measureNames.includes(entry.name)) return;
      state.measures.push({
        duration: entry.duration,
        name: entry.name,
        startTime: entry.startTime,
      });
    });
    observePerformanceEntries("resource", (entry) => {
      if (!String(entry.name).includes("/v2/sessions/current/")) return;
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
        .filter((entry) => String(entry.name).includes("/v2/sessions/current/"))
        .map((entry) => ({
          duration: entry.duration,
          initiatorType: entry.initiatorType,
          name: entry.name,
          startTime: entry.startTime,
          transferSize: entry.transferSize,
        }));
      const measureEntries = performance
        .getEntriesByType("measure")
        .filter((entry) => measureNames.includes(entry.name))
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
      const reactRenderMeasureNames = measureNames.filter((name) =>
        name.startsWith("fullmag.react.render."),
      );
      const viewportMeasureNames = measureNames.filter(
        (name) => !name.startsWith("fullmag.react.render."),
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

async function runtimeState() {
  const value = await getJson("/v2/sessions/current/simulation/solver/status");
  return String(value.runtime_state ?? value.runtime_status_kind ?? "");
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
