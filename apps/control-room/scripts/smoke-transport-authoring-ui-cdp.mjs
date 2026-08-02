import { spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  connectCdpSocket,
  removeProfileDirectory,
  runTransportAuthoringSmoke,
  startChromium,
} from "./smoke-transport-authoring-ui-runtime.mjs";

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
    interfaces: [{
      id: "transparent",
      kind: "transparent",
      side_a: { object_id: "left", region_id: "normal" },
      side_b: { object_id: "right", region_id: "ferromagnet" },
      normal_a_to_b: [1, 0, 0],
    }],
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
      spin_memory_loss: { formula_version: "sml_reservoir.fullmag.v2", g_n_Spm2: 1, g_f_Spm2: 2, g_lattice_Spm2: 3 },
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
const spinInterfaces = [
  { interface_id: "transparent", interface: spinTransports[0].interfaces[0], known: true, owner_spin_transport_id: "known-spin" },
  { interface_id: "nf", interface: spinTransports[1].interfaces[0], known: false, owner_spin_transport_id: "future-mixing" },
];
const spinTorques = [{ kind: "zhang_li", id: "torque", current_density: [1, 0, 0], current_source: " torque-source ", degree: 0.4, beta: 0 }];
const oerstedFields = [{ kind: "oersted_cylinder", id: "oersted", center: [0, 0, 0], axis: [0, 0, 1], radius: 1e-9, current: 1 }];

let cdp = null;
let sessionId = null;

await runTransportAuthoringSmoke({
  connectCdp,
  removeProfile: removeProfileDirectory,
  run: async ({ cdp: acquiredCdp, fixtureServer }) => {
    cdp = acquiredCdp;
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
    await clickSelector('[data-node-id="model:physics:current-transports"]');
    await setControl("Name", " charge ");
    await clickEnabledButton("Create");
    await waitForText(".fm-inspector", "Transport resource committed.");
    await verifyKnownRoute(
      "model:physics:spin-transports:id:known-spin",
      "Spin transport",
      "Current source id",
    );
    await replaceField("Current source id", " charge ");
    await verifyUnsupportedRoute(
      "model:physics:current-transports:id:future-current",
    );
    await verifyUnsupportedRoute(
      "model:physics:spin-transports:id:future-mixing",
    );
    await clickSelector('[data-node-id="model:physics:current-transports:id:known-current"]');
    await clickEnabledButton("Delete");
    await waitForText(".fm-inspector", "Transport resource deleted.");
    for (const nodeId of [
      "model:physics:current-transports",
      "model:physics:spin-transports",
      "model:physics:spin-interfaces",
      "model:physics:spin-torques",
      "model:physics:oersted-fields",
    ]) await waitForVisible(`[data-node-id="${nodeId}"]`);

    await visibleCrud("model:physics:spin-torques:position:0", "Polarization degree", "0.61", "model:physics:spin-torques");
    await visibleCrud("model:physics:oersted-fields:position:0", "Current", "7", "model:physics:oersted-fields");
    await clickSelector('[data-node-id="model:physics:spin-interfaces:known-spin:position:0"]');
    await replaceField("Source-to-target orientation", "0, 1, 0", "Interface committed through its owning spin transport.");
    await clickSelector('[data-node-id="model:physics:spin-interfaces"]');
    await setControl("Owning spin transport", "known-spin");
    await setControl("Source object", "left");
    await setControl("Target object", "right");
    await clickEnabledButton("Create");
    await waitForText(".fm-inspector", "Interface committed through its owning spin transport.");
    await clickSelector('[data-node-id="model:physics:spin-interfaces:known-spin:position:0"]');
    await clickEnabledButton("Delete");
    await waitForText(".fm-inspector", "Interface deleted through its owning spin transport.");

    await clickTabByText("Study");
    await clickVisibleButton("Export State");
    await clickVisibleButton("Compute");
    await clickTabByText("Results");
    await clickExplorerTabByText("Results");
    const resultsSnapshot = await evaluate(`() => ({
      explorer: document.querySelector(".fm-explorer")?.innerText || "",
      nodes: Array.from(document.querySelectorAll(".fm-explorer [data-node-id]")).map((node) => node.getAttribute("data-node-id")),
      tabs: Array.from(document.querySelectorAll(".fm-explorer-tabs [role=tab]")).map((node) => ({ selected: node.getAttribute("aria-selected"), text: (node.textContent || "").trim() })),
    })`);
    if (!resultsSnapshot.nodes.includes("results:root")) {
      throw new Error(`Explorer did not navigate to Results: ${JSON.stringify(resultsSnapshot)}`);
    }
    await clickSelector('[data-node-id="results:root"]');
    await clickSelector('[data-node-id="results:field:m"]');
    await waitForText(".fm-inspector", "Magnetization");
    const writes = fixtureServer.requests.filter((request) => request.method !== "GET" && request.method !== "OPTIONS");
    if (writes.some((request) => request.method === "PATCH" && request.path === "/v2/sessions/current/model/current-transports/known-current")) throw new Error("Replace must not rename current transport path identity.");
    assertRequest(writes, "PATCH", "/v2/sessions/current/model/spin-transports/known-spin", (body) => body.resource.current_source_id === " charge ");
    assertRequest(writes, "POST", "/v2/sessions/current/model/current-transports", (body) => body.resource.name === " charge ");
    assertRequest(writes, "DELETE", "/v2/sessions/current/model/current-transports/known-current", (body) => body.base_revision === 1);
    assertRequest(writes, "PATCH", "/v2/sessions/current/model/spin-torques/torque", (body) => body.resource.degree === 0.61 && body.resource.current_source === " torque-source ");
    assertRequest(writes, "POST", "/v2/sessions/current/model/spin-torques", (body) => body.resource.kind === "zhang_li");
    assertRequest(writes, "DELETE", "/v2/sessions/current/model/spin-torques/torque", (body) => body.base_revision === 1);
    assertRequest(writes, "PATCH", "/v2/sessions/current/model/oersted-fields/oersted", (body) => body.resource.current === 7);
    assertRequest(writes, "POST", "/v2/sessions/current/model/oersted-fields", (body) => body.resource.kind === "oersted_cylinder");
    assertRequest(writes, "DELETE", "/v2/sessions/current/model/oersted-fields/oersted", (body) => body.base_revision === 1);
    assertRequest(writes, "PATCH", "/v2/sessions/current/model/spin-transports/known-spin", (body) => body.resource.interfaces.some((item) => item.normal_a_to_b?.[1] === 1));
    assertRequest(writes, "POST", "/v2/sessions/current/persistence/exports", (body) => body.profile === "resume");
    assertRequest(writes, "POST", "/v2/sessions/current/simulation/commands", (body) => body.kind === "solve");
    if (browserErrors.length > 0) {
      throw new Error(`Browser errors:\n${browserErrors.join("\n")}`);
    }
    console.log(`Transport authoring UI smoke passed at ${workspaceUrl}; driver=cdp.`);
  },
  startChromium: startChromiumForSmoke,
  startFixtureServer,
  stopChromium,
});

async function verifyKnownRoute(nodeId, title, fieldLabel) {
  await clickSelector(`[data-node-id="${nodeId}"]`);
  await waitForText(".fm-inspector", title);
  await waitForVisible(`.fm-inspector [aria-label="${fieldLabel}"]`);
}

async function replaceField(label, value, successText = "Transport resource committed.") {
  await setControl(label, value);
  await waitForEvaluate(`() => Array.from(document.querySelectorAll('.fm-inspector button')).some((button) => button.textContent.trim() === "Replace" && !button.disabled)`);
  await evaluate(`() => {
    const button = Array.from(document.querySelectorAll('.fm-inspector button')).find((entry) => entry.textContent.trim() === "Replace");
    button.click();
    return true;
  }`);
  await waitForText(".fm-inspector", successText);
}

async function visibleCrud(memberNodeId, fieldLabel, replacement, rootNodeId) {
  await clickSelector(`[data-node-id="${memberNodeId}"]`);
  await replaceField(fieldLabel, replacement, "Authoring resource committed.");
  await clickSelector(`[data-node-id="${rootNodeId}"]`);
  await clickEnabledButton("Create");
  await waitForText(".fm-inspector", "Authoring resource committed.");
  await clickSelector(`[data-node-id="${memberNodeId}"]`);
  await clickEnabledButton("Delete");
  await waitForText(".fm-inspector", "Authoring resource deleted.");
}

async function setControl(label, value) {
  await waitForVisible(`.fm-inspector [aria-label="${label}"]`);
  await evaluate(`() => {
    const control = document.querySelector('.fm-inspector [aria-label=${JSON.stringify(label)}]');
    const prototype = control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(control, ${JSON.stringify(value)});
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }`);
}

async function clickVisibleButton(text) {
  await waitForEvaluate(`() => Array.from(document.querySelectorAll('button')).some((button) => button.textContent.trim() === ${JSON.stringify(text)} && !button.disabled && button.getBoundingClientRect().width > 0)`);
  await evaluate(`() => {
    const button = Array.from(document.querySelectorAll('button')).find((entry) => entry.textContent.trim() === ${JSON.stringify(text)} && !entry.disabled && entry.getBoundingClientRect().width > 0);
    button.click(); return true;
  }`);
}

async function clickEnabledButton(text) {
  await waitForEvaluate(`() => Array.from(document.querySelectorAll('.fm-inspector button')).some((button) => button.textContent.trim() === ${JSON.stringify(text)} && !button.disabled)`);
  await evaluate(`() => {
    const button = Array.from(document.querySelectorAll('.fm-inspector button')).find((entry) => entry.textContent.trim() === ${JSON.stringify(text)} && !entry.disabled);
    button.click();
    return true;
  }`);
}

function assertRequest(requests, method, path, predicate) {
  if (!requests.some((request) => request.method === method && request.path === path && predicate(request.body))) {
    throw new Error(`Missing exact ${method} ${path} request in ${JSON.stringify(requests)}`);
  }
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
  const requests = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "OPTIONS") {
      writeEmpty(response, 204);
      return;
    }
    const body = request.method === "GET" ? null : await readJson(request);
    requests.push({ body, method: request.method, path });
    if (path === "/v2/sessions/current/model/transport-validation" && request.method === "POST") {
      const candidate = body?.candidate ?? {};
      const identity = candidate.kind === "current_transport" ? candidate.resource?.name : candidate.resource?.id;
      const pathIdentityValid = candidate.operation !== "replace" || candidate.path_id == null || identity === candidate.path_id;
      const currentNames = [...currentTransports.map((item) => item.name), ...requests.filter((item) => item.method === "POST" && item.path === "/v2/sessions/current/model/current-transports").map((item) => item.body?.resource?.name)];
      const bindingValid = candidate.kind !== "spin_transport" || currentNames.includes(candidate.resource?.current_source_id);
      const valid = pathIdentityValid && bindingValid;
      writeJson(response, {
        execution: { authoring_allowed: valid, qualification: valid ? "semantic_only" : "unsupported", reason: valid ? "Fixture validates path identity and resulting-scene bindings." : "Fixture rejected path identity or current binding.", requested_lane: null, resolved_lane: null, status: valid ? "semantic_only" : "unsupported" },
        scene_revision: 1,
        semantic: { issues: valid ? [] : [{ code: "fixture_invalid_candidate", message: "Path identity or current binding is invalid.", path: "candidate" }], valid },
        validation_version: "transport-authoring-validation.v1",
      });
      return;
    }
    if (path === "/v2/sessions/current/persistence/exports" && request.method === "POST") {
      writeJson(response, { fms_base64: "Zml4dHVyZQ==", profile: body.profile, session_id: "transport-authoring-smoke", size_bytes: 7 });
      return;
    }
    if (path === "/v2/sessions/current/simulation/commands" && request.method === "POST") {
      writeJson(response, { accepted: true, command_id: "fixture-command", error: null });
      return;
    }
    if (request.method === "PATCH" || request.method === "POST" || request.method === "DELETE") {
      writeJson(response, { resource: body?.resource ?? null, scene_revision: 1 });
      return;
    }
    if (path === "/v2/sessions/current/status") {
      writeJson(response, statusFixture());
      return;
    }
    if (path === "/v2/sessions/current/simulation/preparation") {
      writeJson(response, preparationFixture());
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
    if (path === "/v2/sessions/current/model/spin-interfaces") {
      writeJson(response, { items: spinInterfaces, scene_revision: 1 });
      return;
    }
    if (path === "/v2/sessions/current/model/spin-torques") {
      writeJson(response, { items: spinTorques, scene_revision: 1 });
      return;
    }
    if (path === "/v2/sessions/current/model/oersted-fields") {
      writeJson(response, { items: oerstedFields, scene_revision: 1 });
      return;
    }
    if (path === "/v2/sessions/current/simulation/commands") {
      writeJson(response, { commands: [], revision: 1, runtime_controls: [{ enabled: true, kind: "solve", reason: null }] });
      return;
    }
    if (path === "/v2/sessions/current/simulation/solver/status") {
      writeJson(response, { revision: 1, runtime_state: "idle" });
      return;
    }
    if (path === "/v2/sessions/current/simulation/stages/execution") {
      writeJson(response, { active_stage_index: null, completed_stage_indexes: [0], revision: 1, runtime_state: "idle", stages: [{ artifact_refs: ["fixture://m"], id: "fixture-stage", result: { quantity: "m" }, status: "completed" }], total_stages: 1 });
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
    requests,
  };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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

async function startChromiumForSmoke() {
  return startChromium({
    createProfile: () => mkdtempSync(join(tmpdir(), "fullmag-transport-smoke-")),
    findExecutable: findChromiumExecutable,
    removeProfile: removeProfileDirectory,
    spawnBrowser: (executable, userDataDir) => spawn(executable, [
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
    ], { stdio: ["ignore", "ignore", "pipe"] }),
    stopChromium,
    waitForDevTools,
  });
}

async function waitForDevTools(child) {
  return new Promise((resolve, reject) => {
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
  return connectCdpSocket({
    createWebSocket: (url) => new WebSocket(url),
    timeoutMs: 5_000,
    url: wsUrl,
  });
}

async function evaluate(expression) {
  const source = expression.trim();
  const wrapped = source.startsWith("() =>") || source.startsWith("async () =>")
    ? `(${source})()`
    : expression;
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
  try {
    await waitForEvaluate(`() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return false;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none"
        && rect.width > 0 && rect.height > 0;
    }`);
  } catch (error) {
    const diagnostics = await evaluate(`() => ({
      url: location.href,
      title: document.title,
      bodyText: (document.body?.innerText || "").slice(0, 4000),
      explorerNodes: Array.from(document.querySelectorAll(".fm-explorer [data-node-id]"))
        .map((node) => node.getAttribute("data-node-id")),
      apiErrors: Array.from(document.querySelectorAll("[role=alert], .fm-feedback-banner"))
        .map((node) => (node.textContent || "").trim())
        .filter(Boolean),
      resources: performance.getEntriesByType("resource")
        .map((entry) => entry.name)
        .slice(-40),
    })`);
    throw new Error(`${error.message} selector=${selector} browserErrors=${JSON.stringify(browserErrors)} diagnostics=${JSON.stringify(diagnostics)}`);
  }
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

async function clickExplorerTabByText(text) {
  const selector = ".fm-explorer-tabs [role=\"tab\"]";
  await waitForEvaluate(
    `() => Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some((node) => (node.textContent || "").trim() === ${JSON.stringify(text)})`,
  );
  await evaluate(`() => {
    const node = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
      .find((entry) => (entry.textContent || "").trim() === ${JSON.stringify(text)});
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, ctrlKey: false }));
    return true;
  }`);
  await waitForEvaluate(
    `() => Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some((node) => (node.textContent || "").trim() === ${JSON.stringify(text)} && node.getAttribute("aria-selected") === "true")`,
  );
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
    capabilities: {
      algorithms_available: [], binary_fields: true, cell_fields: true, eigen_modes: false,
      explicit_topology: false, gpu_telemetry: false, node_fields: false,
      preview_2d: true, preview_3d: true, scalar_history: true, structured_grid: true,
      transport_authoring: {
        contract_version: "spin-transport-capabilities.v1",
        m1_one_way_steady: { authoring_allowed: true, reason: "M1 semantic authoring available.", status: "semantic_only" },
        m2_reciprocal: { authoring_allowed: false, reason: "M2 unavailable.", status: "unsupported" },
        m3_transient: { authoring_allowed: false, reason: "M3 unavailable.", status: "unsupported" },
        gpu: { authoring_allowed: false, reason: "GPU unavailable.", status: "unsupported" },
        single_precision: { authoring_allowed: false, reason: "Single unavailable.", status: "unsupported" },
        hybrid: { authoring_allowed: false, reason: "Hybrid unavailable.", status: "unsupported" },
      },
    },
    display: {},
    domain: { cell_count: 0, discretization: "fdm", generation_id: 0 },
    energies: {},
    metrics: {
      steps_per_second: null,
      total: { steps: 0, time_seconds: 0 },
      total_steps: 0,
      uptime_seconds: 0,
    },
    resources: { command_completion_revision: 1, commands_revision: 1, mesh_revision: 0, scene_revision: 1, stages_revision: 1, workspace_revision: 0 },
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

function preparationFixture() {
  const stageIds = [
    "runtime_startup",
    "script_materialization",
    "validation",
    "planning",
    "domain_preparation",
    "meshing",
    "mesh_postprocessing",
    "solver_initialization",
    "ready",
  ];
  return {
    preparation_id: "transport-authoring-smoke-preparation",
    revision: 1,
    status: "ready",
    started_at_unix_ms: 0,
    completed_at_unix_ms: 1,
    active_stage_id: null,
    requested_execution: {
      backend: "fdm",
      device: "cpu",
      engine_id: "fullmag",
      mode: "strict",
      precision: "double",
      runtime_family: "fixture",
      worker: "fixture",
    },
    resolved_execution: {
      backend: "fdm",
      device: "cpu",
      engine_id: "fullmag",
      mode: "strict",
      precision: "double",
      runtime_family: "fixture",
      worker: "fixture",
    },
    stages: stageIds.map((id) => ({
      id,
      label: id.replaceAll("_", " "),
      detail: "Fixture stage completed.",
      status: "completed",
      progress_percent: 100,
      progress_label: "Complete",
      started_at_unix_ms: 0,
      completed_at_unix_ms: 1,
      duration_ms: 1,
      clock_adjustment: null,
    })),
    log_tail: [],
    failure: null,
  };
}
