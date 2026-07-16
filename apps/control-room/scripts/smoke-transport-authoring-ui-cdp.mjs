import { spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workspaceUrl =
  process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const timeoutMs = Number(
  process.env.CONTROL_ROOM_TRANSPORT_SMOKE_TIMEOUT_MS ?? 60_000,
);
const browserErrors = [];

const currentTransports = [
  {
    coupling: "one_way",
    current_density: [1, 0, 0],
    kind: "current_transport",
    model: "prescribed_density",
    name: "known-current",
  },
  {
    future_key: { preserve: true },
    kind: "current_transport",
    model: "prescribed_density",
    name: "future-current",
  },
];
const spinSolver = {
  default_external_boundary: "spin_insulating",
  engine: "gmres",
  linear: {
    absolute_tolerance: 1e-12,
    max_iterations: 100,
    relative_tolerance: 1e-8,
  },
  operator_version: "fv_spin_upwind_v1",
  physical_residual_version: "transport_balance_integrated_l2.v1",
};
const requestedExecution = {
  device: "cpu",
  discretization: "fdm",
  execution_mode: "strict",
  precision: "double",
};
const spinTransports = [
  {
    boundaries: [],
    constitutive_version: "transport_constitutive.one_way.fullmag.v1",
    current_source_id: "known-current",
    domain: [],
    id: "known-spin",
    interfaces: [],
    materials: [],
    mode: "steady",
    requested_execution: requestedExecution,
    schema_version: "spin_transport.v1",
    solver: spinSolver,
  },
  {
    boundaries: [],
    constitutive_version: "transport_constitutive.one_way.fullmag.v1",
    current_source_id: "known-current",
    domain: [],
    id: "future-mixing",
    interfaces: [{
      absorption: "partial_absorption.v2",
      ferromagnet_side: { object_id: "stack", region_id: "free" },
      formula_version: "magnetoelectronic.fullmag.v2",
      g_down_Spm2: 2,
      g_i_Spm2: 3,
      g_r_Spm2: 4,
      g_sml_Spm2: 5,
      g_up_Spm2: 6,
      id: "nf",
      kind: "mixing_conductance",
      normal_side: { object_id: "stack", region_id: "normal" },
      normal_to_ferromagnet: [1, 0, 0],
    }],
    materials: [],
    mode: "steady",
    requested_execution: requestedExecution,
    schema_version: "spin_transport.v1",
    solver: spinSolver,
  },
];

const fixtureServer = await startFixtureServer();
const browser = await startChromium();
const cdp = await connectCdp(browser.wsUrl);
let sessionId = null;

try {
  const target = await cdp.send("Target.createTarget", { url: "about:blank" });
  const attached = await cdp.send("Target.attachToTarget", {
    flatten: true,
    targetId: target.targetId,
  });
  sessionId = attached.sessionId;
  cdp.on("Runtime.exceptionThrown", (event) => {
    browserErrors.push(event.exceptionDetails?.text ?? "Runtime exception");
  });
  cdp.on("Log.entryAdded", (event) => {
    if (event.entry?.level === "error") {
      const text = event.entry.text ?? "";
      if (!text.includes("WebSocket")) browserErrors.push(text);
    }
  });
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Log.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send(
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source: `window.__FULLMAG_CONFIG__ = { ...(window.__FULLMAG_CONFIG__ || {}), allowMissingSessionSmoke: true, controlRoomApiBase: ${JSON.stringify(fixtureServer.baseUrl)}, disableRealtime: true };`,
    },
    sessionId,
  );
  await cdp.send("Page.navigate", { url: workspaceUrl }, sessionId);
  await waitForVisible(".fm-explorer");
  await clickTabByText("Model");

  await verifyKnownRoute(
    "model:physics:current-transports:id:known-current",
    "Charge transport",
    "Name",
  );
  await verifyKnownRoute(
    "model:physics:spin-transports:id:known-spin",
    "Spin transport",
    "Current source id",
  );
  await verifyUnsupportedRoute(
    "model:physics:current-transports:id:future-current",
  );
  await verifyUnsupportedRoute(
    "model:physics:spin-transports:id:future-mixing",
  );

  if (browserErrors.length > 0) {
    throw new Error(`Browser errors:\n${browserErrors.join("\n")}`);
  }
  console.log(`Transport authoring UI smoke passed at ${workspaceUrl}; driver=cdp.`);
} finally {
  await cdp.close().catch(() => undefined);
  await stopChromium(browser.process);
  await fixtureServer.close();
  rmSync(browser.userDataDir, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 100,
  });
}

async function verifyKnownRoute(nodeId, title, fieldLabel) {
  await clickSelector(`[data-node-id="${nodeId}"]`);
  await waitForText(".fm-inspector", title);
  await waitForVisible(`.fm-inspector [aria-label="${fieldLabel}"]`);
}

async function verifyUnsupportedRoute(nodeId) {
  const selector = `[data-node-id="${nodeId}"]`;
  await waitForEvaluate(
    `() => (document.querySelector(${JSON.stringify(selector)})?.textContent || "").includes("read-only")`,
  );
  await clickSelector(selector);
  await waitForText(
    ".fm-inspector",
    "Unknown transport variant is preserved losslessly and is read-only.",
  );
  await waitForVisible('.fm-inspector [aria-label="Opaque payload"]');
  const exposed = await evaluate(`() => {
    const inspector = document.querySelector(".fm-inspector");
    if (!inspector) return ["missing inspector"];
    const buttons = Array.from(inspector.querySelectorAll("button"))
      .map((node) => (node.textContent || "").trim())
      .filter((text) => text === "Replace" || text === "Delete");
    const editable = ["Name", "Interfaces", "Current source id"].filter(
      (label) => inspector.querySelector('[aria-label="' + label + '"]'),
    );
    return [...buttons, ...editable];
  }`);
  if (exposed.length > 0) {
    throw new Error(`Unsupported transport exposes mutations: ${exposed.join(", ")}`);
  }
}

async function startFixtureServer() {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "OPTIONS") {
      writeEmpty(response, 204);
      return;
    }
    if (request.method !== "GET") {
      writeJson(response, { ok: true, scene_revision: 1 });
      return;
    }
    if (path === "/v2/sessions/current/status") {
      writeJson(response, statusFixture());
      return;
    }
    if (path === "/v2/sessions/current/model/scene") {
      writeJson(response, sceneFixture());
      return;
    }
    if (path === "/v2/sessions/current/model/current-transports") {
      writeJson(response, { items: currentTransports, scene_revision: 1 });
      return;
    }
    if (path === "/v2/sessions/current/model/spin-transports") {
      writeJson(response, { items: spinTransports, scene_revision: 1 });
      return;
    }
    writeJson(response, { items: [], scene_revision: 1 });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Transport fixture server did not bind to a TCP port.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function writeJson(response, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(200, fixtureHeaders({
    "content-length": String(payload.byteLength),
    "content-type": "application/json",
  }));
  response.end(payload);
}

function writeEmpty(response, status) {
  response.writeHead(status, fixtureHeaders());
  response.end();
}

function fixtureHeaders(extra = {}) {
  return {
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "x-api-contract-version,etag,x-request-id",
    "x-api-contract-version": "1.0.0",
    ...extra,
  };
}

async function startChromium() {
  const executable = findChromiumExecutable();
  const userDataDir = mkdtempSync(join(tmpdir(), "fullmag-transport-smoke-"));
  const child = spawn(executable, [
    "--headless=new",
    "--disable-dev-shm-usage",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--no-sandbox",
    "--remote-debugging-port=0",
    "--use-angle=swiftshader-webgl",
    "--use-gl=angle",
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for Chromium DevTools endpoint.")),
      timeoutMs,
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Chromium exited before DevTools was ready: code=${code} signal=${signal}`));
    });
    child.stderr.on("data", (chunk) => {
      const match = String(chunk).match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
  });
  return { process: child, userDataDir, wsUrl };
}

function findChromiumExecutable() {
  const explicit = process.env.CHROME_BIN
    ?? process.env.CHROMIUM_BIN
    ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (explicit) return explicit;
  const candidates = [
    "/home/kkingstoun/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
    "/home/kkingstoun/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  return candidates.find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) ?? candidates[0];
}

async function stopChromium(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("CDP WebSocket timed out.")), 5_000);
    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("CDP WebSocket failed to connect."));
    }, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener("message", (message) => {
    const payload = JSON.parse(String(message.data));
    if (payload.id && pending.has(payload.id)) {
      const entry = pending.get(payload.id);
      pending.delete(payload.id);
      if (payload.error) entry.reject(new Error(payload.error.message));
      else entry.resolve(payload.result ?? {});
      return;
    }
    for (const handler of listeners.get(payload.method) ?? []) {
      handler(payload.params ?? {});
    }
  });
  return {
    close: () => new Promise((resolve) => {
      ws.addEventListener("close", resolve, { once: true });
      ws.close();
    }),
    on: (method, handler) => {
      const handlers = listeners.get(method) ?? [];
      handlers.push(handler);
      listeners.set(method, handlers);
    },
    send: (method, params = {}, session = null) => {
      const id = nextId++;
      ws.send(JSON.stringify(session
        ? { id, method, params, sessionId: session }
        : { id, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(id, { reject, resolve });
      });
    },
  };
}

async function evaluate(expression) {
  const source = expression.trim();
  const wrapped = source.startsWith("() =>") ? `(${source})()` : expression;
  const result = await cdp.send("Runtime.evaluate", {
    awaitPromise: true,
    expression: wrapped,
    returnByValue: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "Runtime.evaluate failed");
  }
  return result.result?.value;
}

async function waitForEvaluate(functionSource) {
  await waitForCondition(async () => evaluate(`(${functionSource})()`));
}

async function waitForVisible(selector) {
  await waitForEvaluate(`() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return false;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none"
      && rect.width > 0 && rect.height > 0;
  }`);
}

async function waitForText(selector, text) {
  await waitForEvaluate(
    `() => (document.querySelector(${JSON.stringify(selector)})?.textContent || "").includes(${JSON.stringify(text)})`,
  );
}

async function clickSelector(selector) {
  await waitForVisible(selector);
  await evaluate(`() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    node.scrollIntoView({ block: "center", inline: "center" });
    node.click();
    return true;
  }`);
}

async function clickTabByText(text) {
  await waitForEvaluate(
    `() => Array.from(document.querySelectorAll('[role="tab"]')).some((node) => (node.textContent || "").trim() === ${JSON.stringify(text)})`,
  );
  await evaluate(`() => {
    const node = Array.from(document.querySelectorAll('[role="tab"]'))
      .find((entry) => (entry.textContent || "").trim() === ${JSON.stringify(text)});
    node.click();
    return true;
  }`);
}

async function waitForCondition(predicate) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Browser condition timed out.${lastError ? ` ${lastError.message}` : ""}`);
}

function sceneFixture() {
  return {
    current_modules: { excitation_analysis: null, modules: [] },
    editor: {},
    magnetization_assets: [],
    materials: [],
    metadata: {
      authoring_schema: "scene-document.v1",
      id: "transport-authoring-smoke",
      name: "Transport authoring smoke",
      source_of_truth: "fixture",
    },
    objects: [],
    outputs: { items: [] },
    revision: 1,
    study: { stages: [] },
    universe: null,
  };
}

function statusFixture() {
  return {
    api_contract_version: "1.0.0",
    capabilities: {},
    display: {},
    domain: { cell_count: 0, discretization: "fdm", generation_id: 0 },
    energies: {},
    metrics: {
      steps_per_second: null,
      total: { steps: 0, time_seconds: 0 },
      total_steps: 0,
      uptime_seconds: 0,
    },
    resources: { scene_revision: 1, workspace_revision: 0 },
    run: null,
    runtime_bundle_version: "transport-authoring-smoke",
    session: {
      created_at: "2026-07-16T00:00:00.000Z",
      name: "Transport authoring smoke",
      session_id: "transport-authoring-smoke",
      workspace_root: "/tmp/fullmag-transport-authoring-smoke",
    },
    solver: { state: "idle" },
  };
}
