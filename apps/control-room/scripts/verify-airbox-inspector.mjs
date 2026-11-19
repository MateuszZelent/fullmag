import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startBrowserQaLoopbackProxy } from "./lib/browser-qa-loopback-proxy.mjs";

const timeout = Math.min(
  Number.parseInt(process.env.CONTROL_ROOM_BROWSER_QA_TIMEOUT_MS ?? "180000", 10),
  120_000,
);
const publicUrl = process.env.CONTROL_ROOM_PUBLIC_URL ?? "";
const probeUrl = process.env.CONTROL_ROOM_URL ?? "http://frontend:8080";
const expectedVersion = process.env.CONTROL_ROOM_EXPECTED_PLAYWRIGHT_VERSION ?? "1.62.1";
const browserGpuMode = process.env.CONTROL_ROOM_BROWSER_GPU_MODE ?? "swiftshader-webgl-requested";
const resultSchema = "fullmag.docker-dev-airbox-inspector-result.v1";
const proofSchema = "fullmag.airbox-inspector-browser-proof.v1";
const manifestPath = "/v2/sessions/current/meshing/meshes/shared-domain/manifest";
const statusPath = "/v2/sessions/current/status";
const planarMonitorsPath = "/v2/sessions/current/model/planar-monitors";
const visualizationClientAcksPath = "/v2/sessions/current/visualization/client-acks";
const timeoutMs = Number.isFinite(timeout) ? timeout : 120_000;
const qualityReadinessTimeoutMs = Math.min(timeoutMs, 15_000);
const require = createRequire(import.meta.url);

const panels = [
  {
    id: "root",
    nodeId: "model:airbox",
    selectionKind: "airbox.root",
    expectedHeader: "Airbox Overview",
    requiredGroup: "Domain policy",
  },
  {
    id: "mesh",
    nodeId: "model:airbox:mesh",
    selectionKind: "airbox.mesh",
    expectedHeader: "Airbox Mesh Overview",
    requiredGroup: "Airbox Mesh Overview",
  },
  {
    id: "parameters",
    nodeId: "model:airbox:mesh:parameters",
    selectionKind: "airbox.mesh.parameters",
    expectedHeader: "Airbox Mesh Parameters",
    requiredGroup: "Canonical Authored Parameters",
  },
  {
    id: "quality-gates",
    nodeId: "model:airbox:mesh:quality-gates",
    selectionKind: "airbox.mesh.quality-gates",
    expectedHeader: "Airbox Mesh Quality Gates",
    requiredGroup: "Airbox Quality Gates",
  },
  {
    id: "statistics",
    nodeId: "model:airbox:mesh:statistics",
    selectionKind: "airbox.mesh.statistics",
    expectedHeader: "Airbox Mesh Statistics",
    requiredGroup: "Airbox Mesh Statistics",
  },
  {
    id: "topology",
    nodeId: "model:airbox:mesh:topology",
    selectionKind: "airbox.mesh.topology",
    expectedHeader: "Airbox Mesh Topology",
    requiredGroup: "Airbox Mesh Topology",
  },
  {
    id: "build",
    nodeId: "model:airbox:mesh:build",
    selectionKind: "airbox.mesh.build",
    expectedHeader: "Airbox Mesh Build",
    requiredGroup: "Airbox Mesh Build",
  },
];

const resourcePaths = {
  sessionStatus: statusPath,
  universePolicy: "/v2/sessions/current/meshing/policies/universe",
  sharedDomainManifest: manifestPath,
  universeQuality: "/v2/sessions/current/meshing/meshes/universe/quality",
  universeReport: "/v2/sessions/current/meshing/meshes/universe/report",
  currentBuild: "/v2/sessions/current/meshing/builds/current",
  latestSuccessfulBuild: "/v2/sessions/current/meshing/builds/latest-successful",
};
const startupDiagnosticPaths = new Set([
  "/v2/sessions/current/diagnostics/cpu",
  "/v2/sessions/current/diagnostics/gpu",
  "/v2/platform/compute/nodes",
  "/v2/platform/health",
  "/v2/sessions/current/model/planar-monitors",
  "/v2/sessions/current/simulation/preparation",
]);

const pageErrors = [];
const consoleErrors = [];
const requestFailures = [];
const requestCancellations = [];
const startupRequestEvents = [];
const startupRequestByRequest = new WeakMap();
const startupUnmountCancellationProbes = [];
const requestStartedAt = new WeakMap();
const httpErrors = [];
const mutationRequests = [];
const visualizationClientAcknowledgements = [];
const visualizationAckByRequest = new WeakMap();
const planarMonitorRequests = [];
const planarMonitorRequestByRequest = new WeakMap();
const resourceResponses = [];
const syntheticQualityHttpErrors = [];
const syntheticQualityConsoleErrors = [];
const delayMs = 350;
let statusOverrides = 0;
let refreshCount = 0;
let refreshStatus = null;
let refreshBodyPreserved = false;
let syntheticQualityErrorActive = false;
let resourceInvalidationSequence = 0;
const runStartedAt = Date.now();
let startupRequestSequence = 0;
let teardownStartedAt = null;
let browserOrigin = null;
let harnessPhase = "startup";

const qualityPath = new URL(resourcePaths.universeQuality, probeUrl).pathname;

function bounded(value, limit = 2048) {
  return String(value).slice(0, limit);
}

function diagnosticText(value, limit = 800) {
  return bounded(String(value ?? "")
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (candidate) => {
      try {
        const url = new URL(candidate);
        return `${url.origin}${url.pathname}`;
      } catch {
        return "[url]";
      }
    })
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b((?:access|refresh)?_?(?:token|secret|password|api[_-]?key))\s*[:=]\s*["']?[^\s,"'<>]+/gi, "$1=[redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\b[A-Za-z0-9_-]{64,}\b/g, "[opaque]"), limit);
}

function safePageUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return bounded(value, 240);
  }
}

function diagnosticSamples(values, limit = 8) {
  return values.slice(0, limit).map((value) => diagnosticText(value, 600));
}

function mutationRequestDiagnostic(request, path, phase) {
  let payload;
  try {
    payload = JSON.parse(request.postData() ?? "null");
  } catch {
    return `${request.method()} ${path} [phase=${phase}; body=non-json]`;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return `${request.method()} ${path} [phase=${phase}; body=non-object-json]`;
  }

  const booleanFields = [];
  function collectBooleanFields(value, prefix, depth = 0) {
    if (booleanFields.length >= 12 || depth > 5 || value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value).slice(0, 16)) {
      const field = prefix ? `${prefix}.${key}` : key;
      if (typeof child === "boolean") {
        booleanFields.push(`${field}=${child}`);
      } else if (child && typeof child === "object") {
        if (Array.isArray(child)) {
          child.slice(0, 4).forEach((item, index) => collectBooleanFields(item, `${field}[${index}]`, depth + 1));
        } else {
          collectBooleanFields(child, field, depth + 1);
        }
      }
      if (booleanFields.length >= 12) break;
    }
  }
  collectBooleanFields(payload, "");
  const keys = Object.keys(payload).slice(0, 12).sort().join(",") || "none";
  const booleans = booleanFields.join(",") || "none";
  return `${request.method()} ${path} [phase=${phase}; json_keys=${keys}; boolean_fields=${booleans}]`;
}

function visualizationAckPayloadMetadata(request) {
  let payload;
  try {
    payload = JSON.parse(request.postData() ?? "null");
  } catch {
    return { body_valid_json: false };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { body_valid_json: false };
  }
  const fields = [
    "client_id",
    "client_label",
    "effective_render_mode",
    "error",
    "revision",
    "status",
    "viewport_id",
  ];
  return {
    body_valid_json: true,
    fields_present: fields.filter((field) => Object.prototype.hasOwnProperty.call(payload, field)),
    client_id_present: typeof payload.client_id === "string" && payload.client_id.length > 0,
    client_label_present: typeof payload.client_label === "string" && payload.client_label.length > 0,
    viewport_id_present: typeof payload.viewport_id === "string" && payload.viewport_id.length > 0,
    revision: Number.isSafeInteger(payload.revision) ? payload.revision : null,
    status: ["applied", "rendered", "failed"].includes(payload.status) ? payload.status : null,
    effective_render_mode: typeof payload.effective_render_mode === "string"
      ? bounded(payload.effective_render_mode, 128)
      : null,
    error_present: typeof payload.error === "string" && payload.error.length > 0,
  };
}

function planarMonitorRequestEvidence() {
  return planarMonitorRequests.slice(0, 16).map((request) => ({
    method: "GET",
    path: planarMonitorsPath,
    started_phase: request.startedPhase,
    settled: request.settled,
    outcome: request.outcome,
    status: request.status,
    error: request.error,
    duration_ms: request.settledAt === null
      ? null
      : Math.max(0, request.settledAt - request.startedAt),
  }));
}

async function waitForPendingPlanarMonitorRequests() {
  const pending = planarMonitorRequests.filter((request) => !request.settled);
  if (pending.length > 0) {
    await withTimeout(
      Promise.all(pending.map((request) => request.done.promise)),
      "Initial planar-monitor GET did not settle before the synthetic status probe",
    );
  }
  return {
    pending_at_probe_start: pending.length,
    settled_before_probe: pending.every((request) => request.settled),
    requests: planarMonitorRequestEvidence(),
  };
}

async function collectFailurePageDiagnostics(page, workspaceEntry) {
  if (!page) return null;
  let dom = null;
  let explorerNodes = null;
  try {
    dom = await page.evaluate(() => {
      const summarize = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return { present: false, visible: false };
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const visible = style.display !== "none" && style.visibility !== "hidden" &&
          Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
        const text = visible ? String(element.innerText ?? "").replace(/\s+/g, " ").trim() : "";
        return {
          present: true,
          visible,
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role"),
          state: element.getAttribute("data-state"),
          text: text.slice(0, 500),
        };
      };
      const bodyText = String(document.body?.innerText ?? "").replace(/\s+/g, " ").trim();
      return {
        title: String(document.title ?? "").slice(0, 120),
        document_ready_state: document.readyState,
        visible_body_text: bodyText.slice(0, 900),
        roots: {
          main: summarize("main"),
          workspace_shell: summarize(".fm-workspace-shell"),
          workspace_body: summarize("#fm-main-content.fm-workspace-body"),
          explorer: summarize(".fm-explorer"),
          home_overlay: summarize('.fm-home-overlay[data-state="home-overlay"]'),
          next_error: summarize("[data-nextjs-dialog]"),
        },
      };
    });
  } catch (error) {
    dom = { read_error: diagnosticText(error?.message ?? error, 400) };
  }
  try {
    explorerNodes = await readExplorerNodeDiagnostics(page);
  } catch {
    explorerNodes = { read_error: "Explorer node snapshot unavailable" };
  }
  return {
    current_url: safePageUrl(page.url()),
    workspace_entry: { ...workspaceEntry },
    dom: dom && {
      ...dom,
      title: diagnosticText(dom.title ?? "", 120),
      visible_body_text: diagnosticText(dom.visible_body_text ?? "", 900),
      read_error: dom.read_error ? diagnosticText(dom.read_error, 400) : undefined,
      roots: dom.roots && Object.fromEntries(Object.entries(dom.roots).map(([name, root]) => [name, {
        ...root,
        text: diagnosticText(root.text ?? "", 500),
      }])),
    },
    page_error_messages: diagnosticSamples(pageErrors),
    console_error_messages: diagnosticSamples(consoleErrors),
    request_failure_messages: diagnosticSamples(requestFailures),
    mutation_request_messages: diagnosticSamples(mutationRequests),
    visualization_client_acknowledgements: visualizationClientAcknowledgements.slice(0, 16),
    planar_monitor_requests: planarMonitorRequestEvidence(),
    explorer_nodes: explorerNodes,
  };
}

async function readExplorerNodeDiagnostics(page) {
  return page.evaluate(() => {
    const relevantNode = (nodeId) =>
      nodeId === "model:universe" ||
      nodeId === "model:boundary-faces" ||
      nodeId === "model:mesh" ||
      nodeId.startsWith("model:airbox");
    const rows = [...document.querySelectorAll('.fm-explorer [role="treeitem"][data-node-id]')]
      .filter((row) => relevantNode(row.getAttribute("data-node-id") ?? ""));
    return {
      count: rows.length,
      truncated: rows.length > 32,
      nodes: rows.slice(0, 32).map((row) => ({
        id: row.getAttribute("data-node-id"),
        label: row.querySelector(".fm-explorer-tree-row__label")?.textContent?.trim().slice(0, 120) ?? null,
        status: row.getAttribute("data-status"),
        status_text: row.querySelector(".fm-explorer-tree-row__status-text")?.textContent?.trim().slice(0, 120) ?? null,
        badge: row.querySelector(".fm-explorer-tree-row__badge")?.textContent?.trim().slice(0, 160) ?? null,
        reason: row.querySelector(".fm-explorer-tree-row__description")?.textContent?.trim().slice(0, 240) ?? null,
        text: String(row.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
      })),
    };
  });
}

function collect(target, value) {
  if (target.length < 32) target.push(bounded(value));
}

function collectRequestFailure(request, errorText) {
  const failedAt = Date.now();
  const startedAt = requestStartedAt.get(request) ?? null;
  const method = request.method();
  const path = new URL(request.url()).pathname;
  const startupRequest = startupRequestByRequest.get(request);
  const planarMonitor = planarMonitorRequestByRequest.get(request);
  const acknowledgement = visualizationAckByRequest.get(request);
  if (acknowledgement) {
    acknowledgement.outcome = "request_failed";
    acknowledgement.error = errorText;
  }
  const record = {
    method,
    path,
    error: errorText,
    run_elapsed_ms: Math.max(0, failedAt - runStartedAt),
    request_duration_ms: startedAt === null ? null : Math.max(0, failedAt - startedAt),
    phase: harnessPhase,
  };
  if (startupRequest) {
    startupRequest.outcome = teardownStartedAt !== null ? "browser-context-shutdown" : "request-failed";
    startupRequest.error = errorText;
    startupRequest.failure_phase = teardownStartedAt !== null ? "browser-context-shutdown" : harnessPhase;
    startupRequest.failure_elapsed_ms = Math.max(0, failedAt - runStartedAt);
  }
  if (planarMonitor) {
    planarMonitor.settled = true;
    planarMonitor.settledAt = failedAt;
    planarMonitor.outcome = "request-failed";
    planarMonitor.error = errorText;
    planarMonitor.done.resolve();
  }
  if (teardownStartedAt !== null && method === "GET" && errorText === "net::ERR_ABORTED") {
    if (requestCancellations.length < 32) {
      requestCancellations.push({
        ...record,
        teardown_elapsed_ms: Math.max(0, failedAt - teardownStartedAt),
        phase: "browser-context-shutdown",
      });
    }
    return;
  }
  const failureMessage = diagnosticText(
    `${method} ${path}: ${errorText} (phase ${harnessPhase}; run +${record.run_elapsed_ms}ms; request ${record.request_duration_ms ?? "unknown"}ms)`,
  );
  if (startupRequest) startupRequest.failure_message = failureMessage;
  collect(requestFailures, failureMessage);
}

function startupRequestEvidence() {
  return startupRequestEvents.slice(0, 32).map((event) => ({ ...event }));
}

async function proveStartupUnmountCancellationFollowupReads(page, workspaceEntry) {
  const candidates = startupRequestEvents.filter((event) =>
    event.outcome === "request-failed"
      && event.method === "GET"
      && startupDiagnosticPaths.has(event.path)
      && event.error === "net::ERR_ABORTED"
      && event.started_phase === "workspace-navigation"
      && event.failure_phase === "workspace-navigation"
      && event.same_origin === true,
  );
  if (candidates.length === 0) return [];

  workspaceEntry.home_overlay_visible = await page.locator('.fm-home-overlay[data-state="home-overlay"]').isVisible();
  workspaceEntry.workspace_body_visible = await page.locator("#fm-main-content.fm-workspace-body").isVisible();
  workspaceEntry.explorer_visible = await page.locator(".fm-explorer").isVisible();
  assert(workspaceEntry.stage === "ready"
    && workspaceEntry.workspace_body_visible === true
    && workspaceEntry.explorer_visible === true
    && workspaceEntry.home_overlay_visible === false,
  "Startup diagnostic request cancellation cannot be probed before the workspace is ready without the home overlay");
  assert(candidates.length <= startupDiagnosticPaths.size,
    "Startup control-resource cancellations exceeded the explicit path probe bound");
  assert.equal(new Set(candidates.map((event) => event.path)).size, candidates.length,
    "Startup diagnostic cancellation evidence contains duplicate paths");

  for (const cancelled of candidates) {
    assert.equal(typeof cancelled.failure_elapsed_ms, "number");
    assert.equal(typeof cancelled.failure_message, "string");
    const firstNewEvent = startupRequestEvents.length;
    const probeStartedAt = Date.now();
    const response = await page.evaluate(async (path) => {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 10_000);
      try {
        const result = await window.fetch(path, {
          method: "GET",
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        const reader = result.body?.getReader();
        let bodyBytes = 0;
        if (reader) {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bodyBytes += chunk.value?.byteLength ?? 0;
            if (bodyBytes > 262_144) {
              await reader.cancel();
              throw new Error("Startup diagnostic read exceeded the 256 KiB body bound");
            }
          }
        }
        return { url: result.url, status: result.status, body_bytes: bodyBytes };
      } finally {
        window.clearTimeout(timer);
      }
    }, cancelled.path);
    const responseUrl = new URL(response.url);
    assert.equal(responseUrl.origin, browserOrigin,
      `Startup diagnostic follow-up escaped the browser origin: ${cancelled.path}`);
    assert.equal(responseUrl.pathname, cancelled.path,
      `Startup diagnostic follow-up changed the endpoint path: ${cancelled.path}`);
    assert.equal(responseUrl.search, "",
      `Startup diagnostic follow-up unexpectedly changed the endpoint query: ${cancelled.path}`);
    assert(Number.isSafeInteger(response.body_bytes) && response.body_bytes >= 0 && response.body_bytes <= 262_144,
      `Startup diagnostic follow-up exceeded the 256 KiB response bound: ${cancelled.path}`);

    const requestEventDeadline = Date.now() + 2_000;
    let matchingEvents = [];
    do {
      matchingEvents = startupRequestEvents.slice(firstNewEvent).filter((event) =>
        event.method === "GET"
          && event.path === cancelled.path
          && event.started_phase === harnessPhase
          && event.started_elapsed_ms > cancelled.failure_elapsed_ms
          && event.resource_type === "fetch"
          && event.same_origin === true
          && event.outcome === "finished"
          && event.finished === true
          && event.response_status === response.status,
      );
      if (matchingEvents.length === 1 && matchingEvents[0].finished === true) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < requestEventDeadline);
    assert.equal(matchingEvents.length, 1,
      `Startup diagnostic follow-up did not produce one finished same-origin browser fetch: ${cancelled.path}`);
    const replacement = matchingEvents[0];
    assert(response.status >= 200 && response.status < 300,
      `Startup diagnostic follow-up returned HTTP ${response.status}: ${cancelled.path}`);
    assert(replacement.finished_elapsed_ms >= replacement.started_elapsed_ms);
    assert(probeStartedAt >= cancelled.failure_elapsed_ms + runStartedAt);

    const failureIndex = requestFailures.indexOf(cancelled.failure_message);
    assert(failureIndex >= 0,
      `Startup diagnostic cancellation was not retained as a request failure before follow-up proof: ${cancelled.path}`);
    requestFailures.splice(failureIndex, 1);
    startupUnmountCancellationProbes.push({
      classification: "startup-unmount-cancellation-followed-by-read-probe",
      cancelled_request_id: cancelled.request_id,
      probe_request_id: replacement.request_id,
      method: "GET",
      path: cancelled.path,
      cancellation_error: cancelled.error,
      cancellation_phase: cancelled.failure_phase,
      cancellation_started_elapsed_ms: cancelled.started_elapsed_ms,
      cancellation_failed_elapsed_ms: cancelled.failure_elapsed_ms,
      probe_started_elapsed_ms: replacement.started_elapsed_ms,
      probe_finished_elapsed_ms: replacement.finished_elapsed_ms,
      probe_response_status: response.status,
      probe_body_bytes: response.body_bytes,
      probe_resource_type: replacement.resource_type,
      workspace_ready: workspaceEntry.stage === "ready",
      home_overlay_visible: workspaceEntry.home_overlay_visible,
    });
  }
  return startupUnmountCancellationProbes.slice(0, startupDiagnosticPaths.size);
}

function routeUrl(path) {
  return new URL(path, browserOrigin ?? probeUrl).toString();
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function assertPositiveCount(value, name) {
  assert(Number.isSafeInteger(value) && value > 0, `${name} must be a positive safe integer`);
}

async function waitForResourceState(page, path, states) {
  await page.waitForFunction(
    ({ resourceKey, allowedStates }) => {
      const snapshot = window.__FULLMAG_CONTROL_ROOM_AUDIT__?.readViewportAuditResource?.(resourceKey);
      return allowedStates.includes(snapshot?.status);
    },
    { resourceKey: path, allowedStates: states },
    { timeout: timeoutMs },
  );
  return page.evaluate((resourceKey) =>
    window.__FULLMAG_CONTROL_ROOM_AUDIT__?.readViewportAuditResource?.(resourceKey) ?? null,
  path);
}

function invalidateResource(page, resourceKey) {
  const revision = Date.now() + ++resourceInvalidationSequence;
  return page.evaluate(({ key, nextRevision }) => {
    const audit = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
    if (!audit?.invalidateResource) throw new Error("managed audit resource invalidation hook is unavailable");
    audit.invalidateResource(key, nextRevision);
  }, { key: resourceKey, nextRevision: revision });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function withTimeout(promise, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readResource(request, path, name, sessionScopeKey = null) {
  const response = await request.get(routeUrl(path), {
    timeout: timeoutMs,
    headers: {
      accept: "application/json",
      ...(sessionScopeKey ? { "x-fullmag-session-scope": sessionScopeKey } : {}),
    },
  });
  const headers = response.headers();
  const url = response.url();
  const record = {
    url,
    status: response.status(),
    content_type: headers["content-type"] ?? null,
    contract_version: headers["x-fullmag-contract-version"] ?? null,
  };
  if (resourceResponses.length < 32) resourceResponses.push(record);
  assert.equal(response.status(), 200, `GET ${path} returned ${response.status()}`);
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`${name} did not return JSON: ${bounded(error)}`);
  }
  assert(body && typeof body === "object" && !Array.isArray(body), `${name} response must be an object`);
  return body;
}

function normalizeAirboxId(value) {
  let id = String(value ?? "").trim().toLowerCase();
  while (id.startsWith("part:") || id.startsWith("object:")) id = id.slice(id.indexOf(":") + 1);
  if (id.endsWith("_geom")) id = id.slice(0, -5);
  return new Set(["airbox", "__air__", "__airbox__"]).has(id);
}

function isAirboxPart(part) {
  return [part?.role].some((value) => ["air", "airbox"].includes(String(value ?? "").trim().toLowerCase()))
    || [part?.id, part?.object_id, part?.geometry_id].some(normalizeAirboxId);
}

function intervalCoverage(parts) {
  if (!parts.length) return { count: null, exact: false };
  const intervals = [];
  for (const part of parts) {
    const explicit = Array.isArray(part.node_indices) ? part.node_indices : [];
    const declared = safeCount(part.node_count);
    if (explicit.length > 0 && declared === explicit.length) {
      const sorted = explicit.map(safeCount);
      if (sorted.some((value) => value === null)) return { count: null, exact: false };
      sorted.sort((left, right) => left - right);
      let start = sorted[0];
      let previous = sorted[0];
      for (const index of sorted.slice(1)) {
        if (index > previous + 1) {
          intervals.push([start, previous + 1]);
          start = index;
        }
        previous = index;
      }
      intervals.push([start, previous + 1]);
      continue;
    }
    const start = safeCount(part.node_start);
    const count = safeCount(part.node_count);
    if (start === null || count === null || start > Number.MAX_SAFE_INTEGER - count) {
      return { count: null, exact: false };
    }
    if (count > 0) intervals.push([start, start + count]);
  }
  intervals.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let total = 0;
  let begin = null;
  let end = null;
  for (const [nextBegin, nextEnd] of intervals) {
    if (begin === null || end === null) {
      begin = nextBegin;
      end = nextEnd;
    } else if (nextBegin > end) {
      total += end - begin;
      begin = nextBegin;
      end = nextEnd;
    } else if (nextEnd > end) {
      end = nextEnd;
    }
  }
  if (begin !== null && end !== null) total += end - begin;
  return Number.isSafeInteger(total) ? { count: total, exact: true } : { count: null, exact: false };
}

function sumPartCount(parts, key) {
  if (!parts.length) return null;
  let total = 0;
  for (const part of parts) {
    const count = safeCount(part?.[key]);
    if (count === null || total > Number.MAX_SAFE_INTEGER - count) return null;
    total += count;
  }
  return total;
}

function aggregatePartTypeCounts(parts, manifest) {
  if (!parts.length) return { scope: "unpublished", values: {} };
  const aggregate = {};
  let complete = true;
  for (const part of parts) {
    const counts = part.element_counts_by_type;
    if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
      complete = false;
      break;
    }
    for (const [family, rawCount] of Object.entries(counts)) {
      const count = safeCount(rawCount);
      if (count === null || (aggregate[family] ?? 0) > Number.MAX_SAFE_INTEGER - count) {
        complete = false;
        break;
      }
      aggregate[family] = (aggregate[family] ?? 0) + count;
    }
    if (!complete) break;
  }
  if (complete && Object.keys(aggregate).length) return { scope: "airbox-parts", values: aggregate };
  const shared = manifest.element_counts_by_type;
  if (!shared || typeof shared !== "object" || Array.isArray(shared)) return { scope: "unpublished", values: {} };
  return { scope: "shared-domain", values: shared };
}

function readGlobalQuality(quality) {
  const value = quality?.quality;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value.global ?? null;
}

function qualityStateReadiness(resourceStatus, gateStatus = "unknown") {
  return [{
    group: "Airbox Quality Gates",
    fields: { "Quality resource": resourceStatus, "Airbox-scoped result": gateStatus },
  }];
}

function qualityPanelReadiness(panel, quality) {
  if (panel.id === "quality-gates") {
    const gates = quality?.quality?.airbox_quality_gates;
    assert(gates && gates.scope === "airbox" && gates.marker === 0 && typeof gates.source === "string" && gates.source.length > 0,
      "Universe quality API did not provide the Airbox gate values needed for the live-panel readiness check");
    return [{
      group: panel.requiredGroup,
      fields: {
        Scope: gates.scope,
        Marker: String(gates.marker),
        Source: gates.source,
      },
    }];
  }
  if (panel.id === "statistics") {
    const globalQuality = readGlobalQuality(quality);
    assert(globalQuality && typeof globalQuality === "object" && !Array.isArray(globalQuality),
      "Universe quality API omitted the global values needed for the live statistics-panel readiness check");
    const fields = {
      Scope: typeof globalQuality.label === "string" ? globalQuality.label : "Airbox endpoint scope",
      Marker: globalQuality.marker == null ? "not published" : String(globalQuality.marker),
    };
    if (typeof quality.quality?.quality_source === "string") {
      fields["Quality source"] = quality.quality.quality_source;
    }
    return [{ group: "Airbox Quality Distributions", fields }];
  }
  return [];
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uiSnapshot() {
  const root = document.querySelector('[data-inspector-owner="airbox-inspector"]');
  if (!root) return null;
  const heading = root.closest(".fm-inspector")?.querySelector(".fm-inspector__header .fm-inspector__title")?.textContent?.trim() ?? "";
  const groups = [...root.querySelectorAll('[data-slot="inspector-group"]')];
  const groupRows = groups.map((section) => {
    const group = section.querySelector('[data-slot="inspector-group-heading"] h3, [data-slot="inspector-group-header"] h3, [data-slot="inspector-group-trigger"] h3, [data-slot="inspector-group-trigger"] span')?.textContent?.trim() ?? "";
    const rows = [...section.querySelectorAll(".fm-inspector-field-row")]
      .filter((row) => row.closest('[data-slot="inspector-group"]') === section);
    const fields = Object.fromEntries(rows.map((row) => {
      const label = row.querySelector(".fm-inspector-field-row__label")?.textContent?.trim() ?? "";
      const value = row.querySelector(".fm-inspector-field-row__value")?.textContent?.trim() ?? "";
      return [label, value];
    }).filter(([label]) => label));
    const units = Object.fromEntries(rows.map((row) => {
      const label = row.querySelector(".fm-inspector-field-row__label")?.textContent?.trim() ?? "";
      const unit = row.querySelector(".fm-inspector-field-row__value small")?.textContent?.trim() ?? null;
      return [label, unit];
    }).filter(([label, unit]) => label && unit));
    return { group, fields, units };
  });
  const inspectorText = root.innerText.slice(0, 24_000);
  const kindRow = groupRows.flatMap((group) => Object.entries(group.fields)).find(([label]) => label === "Inspector kind");
  return {
    heading,
    inspectorKind: kindRow?.[1] ?? null,
    groupRows,
    text: inspectorText,
  };
}

async function readPanel(page, panel, { select = true, readiness = [] } = {}) {
  const node = page.locator(`.fm-explorer [role="treeitem"][data-node-id="${panel.nodeId}"]`).first();
  await node.waitFor({ state: "visible", timeout: timeoutMs });
  if (select && (await node.getAttribute("aria-expanded")) === "false") {
    await node.scrollIntoViewIfNeeded();
    await node.locator(".fm-explorer-tree-row__branch").click({ timeout: timeoutMs });
    await page.waitForFunction(
      (nodeId) => document.querySelector(`.fm-explorer [role="treeitem"][data-node-id="${nodeId}"]`)?.getAttribute("aria-expanded") === "true",
      panel.nodeId,
      { timeout: timeoutMs },
    );
  }
  await node.scrollIntoViewIfNeeded();
  if (select) await node.click({ timeout: timeoutMs });
  await page.waitForFunction(
    ({ nodeId, selectionKind }) => {
      const selected = document.querySelector(`.fm-explorer [role="treeitem"][data-node-id="${nodeId}"]`);
      const inspector = document.querySelector('[data-inspector-owner="airbox-inspector"]');
      return selected?.getAttribute("aria-selected") === "true"
        && inspector?.closest(".fm-inspector")?.querySelector(".fm-inspector__header .fm-inspector__title")
        && [...inspector.querySelectorAll(".fm-inspector-field-row")].some((row) =>
          row.querySelector(".fm-inspector-field-row__label")?.textContent?.trim() === "Inspector kind"
          && row.querySelector(".fm-inspector-field-row__value")?.textContent?.trim() === selectionKind);
    },
    { nodeId: panel.nodeId, selectionKind: panel.selectionKind },
    { timeout: timeoutMs },
  );
  if (readiness.length > 0) {
    try {
      await page.waitForFunction(
        ({ nodeId, selectionKind, expectedGroups }) => {
          const selected = document.querySelector(`.fm-explorer [role="treeitem"][data-node-id="${nodeId}"]`);
          const inspector = document.querySelector('[data-inspector-owner="airbox-inspector"]');
          const selectionReady = selected?.getAttribute("aria-selected") === "true"
            && [...(inspector?.querySelectorAll(".fm-inspector-field-row") ?? [])].some((row) =>
              row.querySelector(".fm-inspector-field-row__label")?.textContent?.trim() === "Inspector kind"
              && row.querySelector(".fm-inspector-field-row__value")?.textContent?.trim() === selectionKind);
          if (!selectionReady) return false;
          return expectedGroups.every(({ group, fields }) => {
            const section = [...inspector.querySelectorAll('[data-slot="inspector-group"]')].find((candidate) =>
              candidate.querySelector('[data-slot="inspector-group-heading"] h3, [data-slot="inspector-group-header"] h3, [data-slot="inspector-group-trigger"] h3, [data-slot="inspector-group-trigger"] span')?.textContent?.trim() === group);
            if (!section) return false;
            const rows = [...section.querySelectorAll(".fm-inspector-field-row")];
            return Object.entries(fields).every(([label, expected]) => {
              const expectedValues = Array.isArray(expected) ? expected : [expected];
              return rows.some((row) =>
                row.querySelector(".fm-inspector-field-row__label")?.textContent?.trim() === label
                && expectedValues.includes(row.querySelector(".fm-inspector-field-row__value")?.textContent?.trim()));
            });
          });
        },
        {
          nodeId: panel.nodeId,
          selectionKind: panel.selectionKind,
          expectedGroups: readiness,
        },
        { timeout: qualityReadinessTimeoutMs, polling: 100 },
      );
    } catch (error) {
      const expected = readiness.map(({ group, fields }) => `${group}: ${JSON.stringify(fields)}`).join("; ");
      throw new Error(`Inspector ${panel.id} did not publish API-matching live resource values within ${qualityReadinessTimeoutMs} ms (${expected}): ${diagnosticText(error?.message ?? error, 400)}`);
    }
  }
  const snapshot = await page.evaluate(uiSnapshot);
  assert(snapshot, `Inspector route ${panel.id} did not render its dedicated root`);
  assert.equal(snapshot.inspectorKind, panel.selectionKind, `Inspector kind differs for ${panel.id}`);
  const group = snapshot.groupRows.find((item) => item.group === panel.requiredGroup);
  assert(group, `Inspector route ${panel.id} is missing ${panel.requiredGroup}`);
  assert.equal(snapshot.heading, panel.expectedHeader, `Inspector route ${panel.id} did not retain its dedicated title`);
  assert(snapshot.heading && !["unknown", "inspector", "airbox inspector", "details"].includes(snapshot.heading.toLowerCase()),
    `Inspector route ${panel.id} used generic header ${snapshot.heading}`);
  assert(snapshot.text.length <= 24_000, `Inspector route ${panel.id} text exceeded its capture bound`);
  return {
    id: panel.id,
    node_id: panel.nodeId,
    selection_kind: panel.selectionKind,
    header: snapshot.heading,
    group: group.group,
    required_group: panel.requiredGroup,
    fields: group.fields,
    units: group.units,
    groups: snapshot.groupRows.map(({ group: groupName, fields, units }) => ({
      group: groupName,
      fields,
      units,
    })),
    verified: true,
  };
}

function fieldValue(panelProof, panelId, _group, label) {
  const record = panelProof.find((entry) => entry.id === panelId);
  assert(record, `Missing panel proof ${panelId}`);
  const value = record.fields[label];
  assert(typeof value === "string", `${panelId} did not publish ${label}`);
  return value;
}

function numberFromText(text) {
  const match = String(text).replaceAll(",", "").match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i);
  return match ? Number(match[0]) : null;
}

function groupFields(panelProof, panelId, groupName) {
  const record = panelProof.find((entry) => entry.id === panelId);
  assert(record, `Missing panel proof ${panelId}`);
  const group = record.groups?.find((item) => item.group === groupName);
  assert(group, `${panelId} did not publish the ${groupName} group`);
  return group.fields;
}

function groupValue(panelProof, panelId, groupName, label) {
  const fields = groupFields(panelProof, panelId, groupName);
  const value = fields[label];
  assert(typeof value === "string", `${panelId}.${groupName} did not publish ${label}`);
  return value;
}

function labelledNumber(text, label) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const numericToken = "(-?(?:\\d[\\d,]*(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?)";
  const match = String(text).match(new RegExp(`(?:^|[;,]\\s*)${escapedLabel}\\s+${numericToken}`, "i"));
  return match ? Number(match[1].replaceAll(",", "")) : null;
}

function displayTolerance(expected, significantDigits = null) {
  const magnitude = Math.abs(expected);
  if (magnitude === 0) return 0;
  if (significantDigits !== null) {
    const roundingStep = 10 ** (Math.floor(Math.log10(magnitude)) - significantDigits + 1);
    return roundingStep / 2 + Number.EPSILON * magnitude * 4;
  }
  return Math.max(Number.MIN_VALUE, magnitude * 1e-12);
}

function assertDisplayedMetricNumber(text, label, expected, description, significantDigits = null) {
  assert(typeof expected === "number" && Number.isFinite(expected), `${description} API value is not finite`);
  const actual = labelledNumber(text, label);
  const tolerance = displayTolerance(expected, significantDigits);
  assert(actual !== null && Math.abs(actual - expected) <= tolerance,
    `${description} UI value ${actual ?? "missing"} differs from API ${expected} (tolerance ${tolerance})`);
}

function assertDisplayedMetricFields(text, metric, fields, description, significantDigits = null) {
  let comparisons = 0;
  for (const [apiField, displayLabel] of fields) {
    const expected = metric?.[apiField];
    if (typeof expected !== "number" || !Number.isFinite(expected)) continue;
    assertDisplayedMetricNumber(text, displayLabel, expected, `${description}.${apiField}`, significantDigits);
    comparisons += 1;
  }
  return comparisons;
}

function assertDisplayedCount(panelProof, panelId, group, label, expected) {
  assert(Number.isSafeInteger(expected) && expected >= 0, `API did not publish ${label}`);
  const actualText = fieldValue(panelProof, panelId, group, label);
  assertDisplayedCountText(actualText, expected, `${panelId}.${label}`);
}

function assertDisplayedCountText(actualText, expected, description) {
  assert(Number.isSafeInteger(expected) && expected >= 0, `API did not publish ${description}`);
  assert.equal(numberFromText(actualText), expected, `${description} differs from API-derived count`);
}

function deriveApiComparisons({ policy, manifest, quality, report, status, panels: panelProof }) {
  const parts = Array.isArray(manifest.mesh_parts) ? manifest.mesh_parts : [];
  const airboxParts = parts.filter(isAirboxPart);
  assert(airboxParts.length > 0, "Live shared-domain manifest did not identify an Airbox carrier");
  const nodeCoverage = intervalCoverage(airboxParts);
  assert(nodeCoverage.exact && nodeCoverage.count !== null, "API Airbox carrier node coverage is not exact");
  const elementCount = sumPartCount(airboxParts, "element_count");
  const boundaryFaceCount = sumPartCount(airboxParts, "boundary_face_count");
  assert(elementCount !== null && boundaryFaceCount !== null, "API Airbox carrier counts are incomplete");
  assert(airboxParts.every((part) => Array.isArray(part.surface_faces)), "API did not publish surface-face counts for every Airbox carrier");
  const surfaceFaceCount = airboxParts.reduce((total, part) => total + part.surface_faces.length, 0);
  const byType = aggregatePartTypeCounts(airboxParts, manifest);
  const mixedFamilies = Object.entries(manifest.element_counts_by_type ?? {})
    .filter(([, count]) => safeCount(count) > 0)
    .map(([family]) => family)
    .sort();
  assert(mixedFamilies.length >= 2, "Live shared-domain manifest does not contain mixed volume element families");
  const canonical = airboxParts.find((part) => ["air", "airbox"].includes(String(part.role ?? "").trim().toLowerCase()))
    ?? airboxParts.find((part) => normalizeAirboxId(part.id));
  assert(canonical?.id, "API did not publish the canonical Airbox carrier id");

  const topologyCounts = {
    node_count: nodeCoverage.count,
    element_count: elementCount,
    boundary_face_count: boundaryFaceCount,
    surface_face_count: surfaceFaceCount,
  };
  for (const [label, count] of Object.entries(topologyCounts)) {
    const expectedLabel = {
      node_count: "Nodes (unique across carriers)",
      element_count: "Elements (all carriers)",
      boundary_face_count: "Boundary faces (all carriers)",
    }[label];
    if (expectedLabel) assertDisplayedCount(panelProof, "root", "root", expectedLabel, count);
  }
  assert.equal(fieldValue(panelProof, "root", "root", "Mesh carrier"), canonical.id);
  assertDisplayedCount(panelProof, "statistics", "statistics", "Points / nodes (unique across carriers)", nodeCoverage.count);
  assertDisplayedCount(panelProof, "statistics", "statistics", "Volume elements (all carriers)", elementCount);
  assertDisplayedCount(panelProof, "statistics", "statistics", "Boundary faces", boundaryFaceCount);
  assertDisplayedCount(panelProof, "statistics", "statistics", "Surface faces", surfaceFaceCount);
  assertDisplayedCount(panelProof, "root", "root", "Airbox carriers", airboxParts.length);
  assertDisplayedCount(panelProof, "topology", "topology", "Carrier count", airboxParts.length);
  assert.equal(fieldValue(panelProof, "statistics", "statistics", "Ownership"), "shared, not exclusive Airbox memory");
  for (const [family, count] of Object.entries(byType.values)) {
    assertDisplayedCount(
      panelProof,
      "statistics",
      "statistics",
      byType.scope === "shared-domain" ? `${family} (shared-domain)` : family,
      count,
    );
  }

  const qualityRecord = quality.quality ?? null;
  assert(qualityRecord && typeof qualityRecord === "object", "Universe quality resource did not publish quality data");
  const gates = qualityRecord.airbox_quality_gates;
  assert(gates && gates.scope === "airbox" && gates.marker === 0 && typeof gates.source === "string" && gates.source.length > 0,
    "Universe quality endpoint did not publish marker-0 Airbox-scoped quality gates");
  assert.equal(fieldValue(panelProof, "quality-gates", "quality-gates", "Scope"), gates.scope);
  assert.equal(fieldValue(panelProof, "quality-gates", "quality-gates", "Marker"), String(gates.marker));
  assert.equal(fieldValue(panelProof, "quality-gates", "quality-gates", "Source"), gates.source);
  assert.equal(fieldValue(panelProof, "quality-gates", "quality-gates", "Evidence"), "backend");
  const structuralScope = fieldValue(panelProof, "quality-gates", "quality-gates", "Scope");
  assert.equal(structuralScope, "airbox", "Quality Gates scope row is not Airbox-specific");
  const globalQuality = readGlobalQuality(quality);
  assert(globalQuality && typeof globalQuality === "object", "Universe quality resource omitted the quality statistics scope");
  const statsScope = groupValue(panelProof, "statistics", "Airbox Quality Distributions", "Scope");
  const qualityLabel = typeof globalQuality.label === "string" ? globalQuality.label : "Airbox endpoint scope";
  assert.equal(statsScope, qualityLabel, "Statistics panel quality scope differs from the API");
  const statsMarker = globalQuality.marker == null ? "not published" : String(globalQuality.marker);
  assert.equal(groupValue(panelProof, "statistics", "Airbox Quality Distributions", "Marker"), statsMarker);
  if (typeof qualityRecord.quality_source === "string") {
    assert.equal(groupValue(panelProof, "statistics", "Airbox Quality Distributions", "Quality source"), qualityRecord.quality_source);
  }
  if (globalQuality.element_count != null) {
    assertDisplayedCountText(
      groupValue(panelProof, "statistics", "Airbox Quality Distributions", "Elements in quality statistics"),
      globalQuality.element_count,
      "statistics.Elements in quality statistics",
    );
  }

  const reportRecord = report.report ?? {};
  const sharedInterfaceNodeCount = reportRecord.shared_interface_node_count;
  if (sharedInterfaceNodeCount !== undefined && sharedInterfaceNodeCount !== null) {
    assertDisplayedCountText(
      groupValue(panelProof, "statistics", "Airbox Mesh Statistics", "Shared interface nodes"),
      sharedInterfaceNodeCount,
      "statistics.Shared interface nodes",
    );
  }

  const sizeDistributionSpecs = [
    ["Equivalent tetrahedral size", "characteristic_size"],
    ["Edge length", "edge_length"],
    ["Element volume", "volume"],
  ];
  let sizeDistributionComparisons = 0;
  for (const [label, apiKey] of sizeDistributionSpecs) {
    const distribution = globalQuality[apiKey];
    if (!isRecord(distribution)) continue;
    const hasDistribution = ["min", "mean", "max", "std", "ratio"]
      .some((key) => typeof distribution[key] === "number" && Number.isFinite(distribution[key]))
      || (Array.isArray(distribution.histogram) && distribution.histogram.length > 0);
    if (!hasDistribution) continue;
    const text = groupValue(panelProof, "statistics", "Airbox Quality Distributions", label);
    const comparisons = assertDisplayedMetricFields(
      text,
      distribution,
      [["min", "min"], ["mean", "mean"], ["max", "max"]],
      `statistics.${label}`,
    );
    sizeDistributionComparisons += comparisons;
    const expectedUnit = apiKey === "volume" ? "m³" : "m";
    const actualUnit = panelProof.find((entry) => entry.id === "statistics")?.groups
      ?.find((item) => item.group === "Airbox Quality Distributions")?.units?.[label];
    assert.equal(actualUnit, expectedUnit, `Statistics unit differs for ${label}`);
  }
  assert(sizeDistributionComparisons > 0, "No displayed size-distribution min/mean/max values were compared with the quality API");

  let qualityMetricComparisons = 0;
  let percentileComparisons = 0;
  for (const [id, label] of [["sicn", "SICN"], ["gamma", "Gamma"]]) {
    const metric = globalQuality[id];
    if (!isRecord(metric)) continue;
    const hasMetric = ["min", "mean", "max", "p05"]
      .some((key) => typeof metric[key] === "number" && Number.isFinite(metric[key]))
      || (Array.isArray(metric.histogram) && metric.histogram.length > 0);
    if (!hasMetric) continue;
    const text = groupValue(panelProof, "statistics", "Airbox Quality Distributions", label);
    const comparisons = assertDisplayedMetricFields(
      text,
      metric,
      [["min", "min"], ["mean", "mean"], ["below_threshold_count", "Below target"]],
      `statistics.${label}`,
    );
    qualityMetricComparisons += comparisons;
  }

  const qualityFamilies = globalQuality.quality_by_family;
  assert(isRecord(qualityFamilies), "Universe quality scope omitted quality_by_family");
  const familyRows = Object.entries(qualityFamilies).filter(([, value]) => isRecord(value));
  assert(familyRows.length > 0, "Universe quality scope did not publish any family rows");
  for (const [family, familyRecord] of familyRows) {
    const familyGroup = `${family} quality`;
    const fields = groupFields(panelProof, "statistics", familyGroup);
    if (typeof familyRecord.cell_count === "number") {
      assertDisplayedCountText(fields["Cell count"], familyRecord.cell_count, `statistics.${familyGroup}.Cell count`);
    }
    for (const [apiKey, displayLabel] of [
      ["sicn", "SICN"],
      ["gamma", "Gamma"],
      ["mixed_topology_scaled_jacobian", "Mixed-topology scaled Jacobian"],
    ]) {
      const metric = familyRecord[apiKey];
      const text = fields[displayLabel];
      assert(typeof text === "string", `Statistics ${familyGroup} did not publish ${displayLabel}`);
      if (!isRecord(metric)) {
        assert.equal(text, "not published", `${familyGroup}.${displayLabel} should remain unpublished`);
        continue;
      }
      if (metric.status === "unavailable") {
        assert(text.startsWith("unavailable"), `${familyGroup}.${displayLabel} hid API unavailability`);
        if (typeof metric.reason === "string" && metric.reason.length > 0) {
          assert(text.includes(metric.reason.slice(0, 128)), `${familyGroup}.${displayLabel} reason differs from the API`);
        }
        continue;
      }
      const hasNumericMetric = ["min", "p05", "mean", "max", "threshold"]
        .some((key) => typeof metric[key] === "number" && Number.isFinite(metric[key]));
      const available = metric.status === "available"
        || (apiKey === "mixed_topology_scaled_jacobian" && metric.status == null && hasNumericMetric);
      if (!available) {
        assert.equal(text, "unknown", `${familyGroup}.${displayLabel} fabricated a metric value`);
        continue;
      }
      const comparisons = assertDisplayedMetricFields(
        text,
        metric,
        [["min", "min"], ["p05", "p05"], ["mean", "mean"], ["max", "max"], ["threshold", "threshold"]],
        `${familyGroup}.${displayLabel}`,
        4,
      );
      qualityMetricComparisons += comparisons;
      if (typeof metric.p05 === "number" && Number.isFinite(metric.p05)) {
        percentileComparisons += 1;
      }
    }
  }

  let gateMetricComparisons = 0;
  for (const check of Array.isArray(gates.checks) ? gates.checks : []) {
    if (!isRecord(check) || typeof check.id !== "string") continue;
    const text = fieldValue(panelProof, "quality-gates", "quality-gates", check.id);
    const expectedStatus = check.status === "pass" || check.status === "fail" ? check.status : "unknown";
    assert(text.startsWith(`${expectedStatus};`), `Quality gate ${check.id} status differs from the API`);
    if (typeof check.value === "number" && Number.isFinite(check.value)) {
      assertDisplayedMetricNumber(text, "value", check.value, `quality-gates.${check.id}.value`);
      gateMetricComparisons += 1;
    }
    if (typeof check.threshold === "number" && Number.isFinite(check.threshold)) {
      const comparisonLabel = typeof check.comparison === "string" ? check.comparison : "comparison not published";
      assertDisplayedMetricNumber(text, comparisonLabel, check.threshold, `quality-gates.${check.id}.threshold`);
      gateMetricComparisons += 1;
    }
  }
  qualityMetricComparisons += gateMetricComparisons;
  assert(qualityMetricComparisons > 0, "No available quality metrics were compared with their API values");
  assert(percentileComparisons > 0, "No available quality percentile was compared with the API");

  const policyConfig = policy.config ?? {};
  const effective = policy.effective_config ?? {};
  const parameterPolicyRevision = fieldValue(panelProof, "parameters", "parameters", "Policy revision");
  assert.equal(numberFromText(parameterPolicyRevision), policy.revision, "Parameters revision differs from the universe policy API");
  const units = [];
  for (const [field, apiKey] of [["Maximum element size", "airbox_hmax"], ["Minimum element size", "airbox_hmin"]]) {
    const value = numberFromText(panelProof.find((entry) => entry.id === "parameters")?.parameter_values?.[field]);
    const expected = policyConfig[apiKey];
    assert(typeof expected === "number" && Number.isFinite(expected), `Universe policy API omitted ${apiKey}`);
    assert(value !== null && Math.abs(value - expected) <= Math.max(1e-12, Math.abs(expected) * 1e-9),
      `Parameters ${field} differs from the SI API value`);
    const unit = panelProof.find((entry) => entry.id === "parameters")?.parameter_units?.[field];
    assert.equal(unit, "m", `${field} unit control is not SI metres`);
    units.push(unit);
  }
  for (const [label, key] of [["Effective maximum element size", "airbox_hmax"], ["Effective minimum element size", "airbox_hmin"]]) {
    const actual = numberFromText(panelProof.find((entry) => entry.id === "parameters")?.parameter_effective_fields?.[label]);
    const expected = numberFromText(effective[key]);
    assert(actual !== null && expected !== null
      && Math.abs(actual - expected) <= Math.max(1e-12, Math.abs(expected) * 1e-9),
    `Parameters ${label} differs from the effective SI API value`);
  }
  const hmax = numberFromText(fieldValue(panelProof, "mesh", "mesh", "Build target maximum element size"));
  const expectedHmax = manifest ? Number(
    ((panelProof.find((entry) => entry.id === "mesh")?.api_effective_target ?? {}).hmax)
      ?? ((panelProof.find((entry) => entry.id === "mesh")?.api_effective_target ?? {}).maximum_element_size),
  ) : NaN;
  assert(Number.isFinite(hmax) && Number.isFinite(expectedHmax)
    && Math.abs(hmax - expectedHmax) <= Math.max(1e-12, Math.abs(expectedHmax) * 1e-9),
  "Mesh overview effective maximum element size differs from the active build API");
  const meshUnits = panelProof.find((entry) => entry.id === "mesh")?.units ?? {};
  assert.equal(meshUnits["Build target maximum element size"], "m", "Mesh overview maximum element size is not labelled in SI metres");
  const topologyUnits = panelProof.find((entry) => entry.id === "topology")?.units ?? {};
  assert.equal(topologyUnits["Bounds min (full Airbox extent)"], "m", "Topology minimum bounds are not labelled in SI metres");
  assert.equal(topologyUnits["Bounds max (full Airbox extent)"], "m", "Topology maximum bounds are not labelled in SI metres");
  const bounds = airboxParts.map((part) => ({ min: part.bounds_min, max: part.bounds_max }));
  assert(bounds.every(({ min, max }) => Array.isArray(min) && min.length >= 3 && Array.isArray(max) && max.length >= 3),
    "API did not publish full Airbox bounds for every carrier");
  const apiBounds = {
    min: [0, 1, 2].map((index) => Math.min(...bounds.map((part) => part.min[index]))),
    max: [0, 1, 2].map((index) => Math.max(...bounds.map((part) => part.max[index]))),
  };
  const parseVector = (value) => String(value).split(",").map(numberFromText);
  for (const [label, expected] of [["Bounds min (full Airbox extent)", apiBounds.min], ["Bounds max (full Airbox extent)", apiBounds.max]]) {
    const actual = parseVector(fieldValue(panelProof, "topology", "topology", label));
    assert(actual.length === 3 && actual.every((value, index) => value !== null
      && Math.abs(value - expected[index]) <= Math.max(1e-15, Math.abs(expected[index]) * 1e-9)),
    `Topology ${label} differs from the published SI bounds`);
  }
  const statisticsUnits = panelProof.find((entry) => entry.id === "statistics")?.groups
    ?.find((item) => item.group === "Airbox Quality Distributions")?.units ?? {};
  for (const [label, expectedUnit] of [["Equivalent tetrahedral size", "m"], ["Edge length", "m"], ["Element volume", "m³"]]) {
    if (statisticsUnits[label] !== undefined) {
      assert.equal(statisticsUnits[label], expectedUnit, `Statistics unit differs for ${label}`);
      units.push(expectedUnit);
    }
  }
  const topologyIdentity = panelProof.find((entry) => entry.id === "topology")?.topology_identity;
  assert(topologyIdentity?.verified === true, "Airbox topology panel did not verify published FEM identity");
  assert.equal(
    fieldValue(panelProof, "topology", "topology", "Topology identity"),
    "matches current published FEM generation",
    "Topology panel did not render the current published FEM identity",
  );
  const buildIdentity = panelProof.find((entry) => entry.id === "build")?.build_identity;
  assert(buildIdentity?.verified === true, "Airbox Build panel did not match published build resources");
  return {
    airbox_carrier_count: airboxParts.length,
    canonical_carrier_id: canonical.id,
    node_count: nodeCoverage.count,
    element_count: elementCount,
    boundary_face_count: boundaryFaceCount,
    surface_face_count: surfaceFaceCount,
    element_count_scope: byType.scope,
    element_counts_by_type: byType.values,
    mixed_element_families: mixedFamilies,
    length_units: [...new Set(units)],
    length_units_verified: true,
    counts_verified: true,
    quality_scope: gates.scope,
    quality_marker: gates.marker,
    quality_source_verified: true,
    quality_status: gates.status ?? null,
    quality_check_count: Array.isArray(gates.checks) ? gates.checks.length : 0,
    quality_statistics_scope: qualityLabel,
    quality_statistics_marker: statsMarker,
    shared_interface_node_count: safeCount(sharedInterfaceNodeCount),
    size_distribution_numeric_comparisons: sizeDistributionComparisons,
    quality_metric_numeric_comparisons: qualityMetricComparisons,
    quality_percentile_comparisons: percentileComparisons,
    report_status: reportRecord.status ?? null,
    policy_revision: policy.revision,
    quality_revision: quality.revision,
    topology_revision: manifest.revision,
    active_lane_resolved: status.capabilities?.active_lane?.resolved?.discretization ?? null,
  };
}

async function panelDataSnapshot(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-inspector-owner="airbox-inspector"]');
    if (!root) return null;
    const groupByTitle = (title) => [...root.querySelectorAll('[data-slot="inspector-group"]')]
      .find((section) => [...section.querySelectorAll("h3, [data-slot='inspector-group-trigger'] span")]
        .some((heading) => heading.textContent?.trim() === title));
    const fields = (title) => {
      const group = groupByTitle(title);
      if (!group) return {};
      return Object.fromEntries([...group.querySelectorAll(".fm-inspector-field-row")].map((row) => {
        const label = row.querySelector(".fm-inspector-field-row__label")?.textContent?.trim() ?? "";
        const value = row.querySelector(".fm-inspector-field-row__value");
        return [label, value?.textContent?.trim() ?? ""];
      }).filter(([label]) => label));
    };
    return {
      parametersFields: fields("Canonical Authored Parameters"),
      parameterEffectiveFields: fields("Backend-effective Values"),
      parameterUnits: Object.fromEntries(["Maximum element size", "Minimum element size"].map((label) => [
        label,
        root.querySelector(`[aria-label="${label} unit"]`)?.value ?? null,
      ])),
      parameterValues: Object.fromEntries(["Maximum element size", "Minimum element size"].map((label) => [
        label,
        root.querySelector(`[aria-label="${label}"]`)?.value ?? null,
      ])),
      meshFields: fields("Airbox Mesh Overview"),
      topologyFields: fields("Airbox Mesh Topology"),
      buildFields: fields("Airbox Mesh Build"),
    };
  });
}

async function inspectCanvas(page) {
  const canvas = page.locator(".fm-viewport-3d canvas").first();
  await canvas.waitFor({ state: "visible", timeout: timeoutMs });
  return canvas.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const gl = element.getContext("webgl2") ?? element.getContext("webgl");
    return {
      visible: rect.width > 0 && rect.height > 0,
      width: element.width,
      height: element.height,
      context_type: gl?.constructor?.name ?? null,
      context_lost: gl?.isContextLost?.() ?? null,
      drawing_buffer_width: gl?.drawingBufferWidth ?? 0,
      drawing_buffer_height: gl?.drawingBufferHeight ?? 0,
    };
  });
}

async function expandNode(page, nodeId) {
  const node = page.locator(`.fm-explorer [role="treeitem"][data-node-id="${nodeId}"]`).first();
  await node.waitFor({ state: "visible", timeout: timeoutMs });
  if ((await node.getAttribute("aria-expanded")) === "false") {
    await node.scrollIntoViewIfNeeded();
    await node.locator(".fm-explorer-tree-row__branch").click({ timeout: timeoutMs });
    await page.waitForFunction(
      (id) => document.querySelector(`.fm-explorer [role="treeitem"][data-node-id="${id}"]`)?.getAttribute("aria-expanded") === "true",
      nodeId,
      { timeout: timeoutMs },
    );
  }
}

async function installResolvedNullStatusRoute(page) {
  const planarMonitorSettlement = await waitForPendingPlanarMonitorRequests();
  harnessPhase = "synthetic-resolved-null-status-probe";
  let preserved = false;
  await page.route(`**${statusPath}*`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const baseline = structuredClone(body);
    assert.equal(body?.capabilities?.active_lane?.authored?.discretization, "fem",
      "Live status route no longer carries authored FEM identity");
    assert.equal(body?.domain?.discretization, "fem", "Live status route no longer carries published FEM domain identity");
    body.capabilities.active_lane.resolved = null;
    const after = structuredClone(body);
    after.capabilities.active_lane.resolved = baseline.capabilities.active_lane.resolved;
    preserved = JSON.stringify(baseline) === JSON.stringify(after);
    assert(preserved, "Resolved-null probe changed status fields outside active_lane.resolved");
    statusOverrides += 1;
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
  await page.evaluate(() => {
    const audit = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
    if (!audit?.invalidateResource) throw new Error("managed audit resource invalidation hook is unavailable");
    audit.invalidateResource("session:status", Date.now());
  });
  await page.waitForFunction(() => {
    const audit = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
    const snapshot = audit?.readViewportAuditResource?.("session:status");
    return Boolean(snapshot?.status === "ready"
      && snapshot?.data?.capabilities?.active_lane?.resolved === null
      && snapshot?.data?.capabilities?.active_lane?.authored?.discretization === "fem"
      && snapshot?.data?.domain?.discretization === "fem");
  }, null, { timeout: timeoutMs });
  assert(statusOverrides > 0, "Resolved-null status probe was not exercised through the application resource layer");
  return {
    status_overrides: statusOverrides,
    other_fields_preserved: preserved,
    planar_monitor_settlement: planarMonitorSettlement,
  };
}

async function triggerStableManifestRefresh(page, expectedManifest) {
  const rootHandle = await page.locator('[data-inspector-owner="airbox-inspector"]').elementHandle();
  assert(rootHandle, "Airbox Inspector root is missing before resource refresh");
  await page.route(`**${manifestPath}*`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    refreshCount += 1;
    const response = await route.fetch();
    refreshStatus = response.status();
    const actualBody = await response.body();
    try {
      refreshBodyPreserved = JSON.stringify(JSON.parse(actualBody.toString("utf8")))
        === JSON.stringify(expectedManifest);
    } catch {
      refreshBodyPreserved = false;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({ response, body: actualBody });
  });
  await page.evaluate(() => {
    const audit = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
    if (!audit?.invalidateResource) throw new Error("managed audit resource invalidation hook is unavailable");
    audit.invalidateResource("/v2/sessions/current/meshing/meshes/shared-domain/manifest", Date.now() + 1);
  });
  const refreshDeadline = Date.now() + timeoutMs;
  while (refreshCount === 0 && Date.now() < refreshDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert(refreshCount > 0, "Manifest resource refresh did not issue a live GET");
  await page.waitForTimeout(delayMs + 100);
  const sameRoot = await page.evaluate((before) => before === document.querySelector('[data-inspector-owner="airbox-inspector"]'), rootHandle);
  await rootHandle.dispose();
  assert(sameRoot, "Airbox Inspector root remounted during manifest refresh");
  assert(refreshCount >= 1 && refreshCount <= 4, `Expected bounded manifest refresh, saw ${refreshCount} requests`);
  assert(refreshStatus >= 200 && refreshStatus < 300, `Manifest refresh returned ${refreshStatus}`);
  assert(refreshBodyPreserved, "Manifest refresh did not preserve the live API response body");
  return {
    resource_path: manifestPath,
    same_root: sameRoot,
    live_response_preserved: refreshBodyPreserved,
    status: refreshStatus,
    request_count: refreshCount,
    delay_ms: delayMs,
  };
}

async function exerciseInitialQualityLoading(page, expectedQuality) {
  const path = resourcePaths.universeQuality;
  const pattern = `**${path}*`;
  const refreshStarted = deferred();
  const releaseRefresh = deferred();
  let requestCount = 0;
  let responseStatus = null;
  let responsePreserved = false;
  let acceptingDelayedRequests = true;
  const pendingRouteHandlers = new Set();
  const routeHandlerErrors = [];
  const qualityRouteHandler = (route) => {
    const task = (async () => {
      if (!acceptingDelayedRequests || route.request().method() !== "GET") {
        return route.continue();
      }
      requestCount += 1;
      const response = await route.fetch();
      const body = await response.body();
      responseStatus = response.status();
      refreshStarted.resolve();
      await releaseRefresh.promise;
      try {
        responsePreserved = JSON.stringify(JSON.parse(body.toString("utf8")))
          === JSON.stringify(expectedQuality);
      } catch {
        responsePreserved = false;
      }
      await route.fulfill({ response, body });
    })();
    const handledTask = task.then(
      () => pendingRouteHandlers.delete(handledTask),
      (error) => {
        pendingRouteHandlers.delete(handledTask);
        routeHandlerErrors.push(error);
      },
    );
    pendingRouteHandlers.add(handledTask);
    return handledTask;
  };
  let loadingPanel;
  let loadingStatus;
  let scenarioError = null;
  let cleanupError = null;
  await page.route(pattern, qualityRouteHandler);
  try {
    const qualityPanel = panels.find((panel) => panel.id === "quality-gates");
    assert(qualityPanel, "Quality Gates panel is not configured in browser QA");
    loadingPanel = await readPanel(page, qualityPanel);
    await withTimeout(refreshStarted.promise, "First Inspector quality GET did not start");
    const pending = await waitForResourceState(page, path, ["loading"]);
    loadingStatus = pending?.status ?? null;
    loadingPanel = await readPanel(page, qualityPanel, { select: false, readiness: qualityStateReadiness("loading") });
    assert.equal(loadingPanel.fields["Quality resource"], "loading",
      "Quality Gates panel did not expose the first-load state");
    assert.equal(loadingPanel.fields["Airbox-scoped result"], "unknown",
      "Airbox quality panel showed a pass/fail result while its resource was loading");
  } catch (error) {
    scenarioError = error;
  } finally {
    releaseRefresh.resolve();
    try {
      while (pendingRouteHandlers.size > 0) {
        await withTimeout(
          Promise.all([...pendingRouteHandlers]),
          "Quality route handlers did not finish after releasing the delayed response",
        );
      }
      acceptingDelayedRequests = false;
      await page.unroute(pattern, qualityRouteHandler);
      while (pendingRouteHandlers.size > 0) {
        await withTimeout(
          Promise.all([...pendingRouteHandlers]),
          "Quality route handlers did not finish after route removal",
        );
      }
    } catch (error) {
      cleanupError = error;
    }
  }
  const failures = [
    scenarioError ? `quality loading assertion: ${scenarioError.stack ?? scenarioError}` : null,
    ...routeHandlerErrors.map((error) => `quality route handler: ${error?.stack ?? error}`),
    cleanupError ? `quality route cleanup: ${cleanupError.stack ?? cleanupError}` : null,
  ].filter(Boolean);
  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
  await waitForResourceState(page, path, ["ready"]);
  const recovered = await readPanel(page, panels.find((panel) => panel.id === "quality-gates"), {
    select: false, readiness: qualityStateReadiness("ready"),
  });
  assert.equal(recovered.fields["Quality resource"], "ready", "First live quality response did not reach the ready state");
  assert(requestCount >= 1 && requestCount <= 4, `Initial quality GET count is out of bounds: ${requestCount}`);
  assert(responseStatus >= 200 && responseStatus < 300, "Initial quality response was not successful live data");
  assert(responsePreserved, "Initial quality GET did not preserve the live API response body");
  return {
    resource_status: loadingStatus,
    panel_status: loadingPanel.fields["Quality resource"],
    gate_result: loadingPanel.fields["Airbox-scoped result"],
    live_response_preserved: responsePreserved,
    live_response_status: responseStatus,
    requests: requestCount,
    recovered_to_ready: recovered.fields["Quality resource"] === "ready",
  };
}

async function exerciseQualityReadStates(page) {
  const path = resourcePaths.universeQuality;
  const pattern = `**${path}*`;
  const livePanel = await readPanel(page, panels.find((panel) => panel.id === "quality-gates"), {
    readiness: qualityStateReadiness("ready"),
  });
  const liveSnapshot = await waitForResourceState(page, path, ["ready"]);
  const liveGateResult = livePanel.fields["Airbox-scoped result"];
  assert.equal(liveGateResult, "unknown",
    "The mixed FEM fixture must retain the live unknown result for its incomplete mixed-family quality evidence");
  assert.equal(livePanel.fields["Quality resource"], "ready", "Baseline Airbox quality resource is not live-ready");
  const liveRevision = liveSnapshot?.data?.revision;
  assert(Number.isSafeInteger(liveRevision) && liveRevision > 0, "Live quality response omitted its revision");
  const liveQuality = liveSnapshot?.data?.quality;
  const liveGates = liveQuality?.airbox_quality_gates;
  assert(liveGates && liveGates.scope === "airbox" && liveGates.marker === 0,
    "Live quality response omitted marker-0 Airbox gate provenance");

  const syntheticPassData = JSON.parse(JSON.stringify(liveSnapshot.data));
  syntheticPassData.quality.airbox_quality_gates = {
    ...syntheticPassData.quality.airbox_quality_gates,
    status: "pass",
    reason: "Synthetic browser QA fault injection; not scientific quality evidence.",
  };
  const installSyntheticPass = async () => {
    let requests = 0;
    let upstreamStatus = null;
    let revisionPreserved = false;
    await page.route(pattern, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      requests += 1;
      const response = await route.fetch();
      upstreamStatus = response.status();
      revisionPreserved = String(syntheticPassData?.revision) === String(liveRevision);
      assert.equal(upstreamStatus, 200, "Synthetic pass control did not start from a successful live response");
      assert(revisionPreserved, "Synthetic pass control does not match the live quality revision");
      await route.fulfill({ response, body: JSON.stringify(syntheticPassData) });
    });
    try {
      await invalidateResource(page, path);
      const syntheticSnapshot = await waitForResourceState(page, path, ["ready"]);
      const panel = await readPanel(page, panels.find((item) => item.id === "quality-gates"), {
        select: false, readiness: qualityStateReadiness("ready", "pass"),
      });
      assert.equal(String(syntheticSnapshot?.data?.revision), String(liveRevision),
        "Synthetic pass control changed the live quality revision");
      assert.equal(syntheticSnapshot?.data?.quality?.airbox_quality_gates?.status, "pass",
        "Synthetic pass response was not installed in the resource cache");
      assert.equal(panel.fields["Quality resource"], "ready", "Synthetic pass control did not reach ready");
      assert.equal(panel.fields["Airbox-scoped result"], "pass",
        "Nonvacuous cached-pass control did not render pass before invalidation");
    } finally {
      await page.unroute(pattern);
    }
    assert(requests >= 1 && requests <= 4, `Synthetic pass control GET count is out of bounds: ${requests}`);
    assert.equal(upstreamStatus, 200, "Synthetic pass control did not preserve a successful live response");
    assert(revisionPreserved, "Synthetic pass control was not based on the matching live revision");
    return { requests, revision: liveRevision, rendered_pass: true, revision_matches_live: true };
  };

  const syntheticPassControl = await installSyntheticPass();

  const refreshStarted = deferred();
  const releaseRefresh = deferred();
  let delayedRequests = 0;
  let delayedResponseStatus = null;
  let delayedBodyPreserved = false;
  await page.route(pattern, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    delayedRequests += 1;
    const response = await route.fetch();
    const body = await response.body();
    delayedResponseStatus = response.status();
    refreshStarted.resolve();
    await releaseRefresh.promise;
    try {
      delayedBodyPreserved = JSON.stringify(JSON.parse(body.toString("utf8")))
        === JSON.stringify(liveSnapshot.data);
    } catch {
      delayedBodyPreserved = false;
    }
    await route.fulfill({ response, body });
  });
  let loadingPanel;
  let loadingResourceStatus;
  try {
    await invalidateResource(page, path);
    await withTimeout(refreshStarted.promise, "Delayed live quality GET did not start");
    const pendingSnapshot = await waitForResourceState(page, path, ["stale", "loading", "pending"]);
    loadingResourceStatus = pendingSnapshot?.status ?? null;
    assert.equal(pendingSnapshot?.data?.quality?.airbox_quality_gates?.status, "pass",
      "Delayed refresh did not retain the synthetic cached pass needed for a nonvacuous suppression check");
    loadingPanel = await readPanel(page, panels.find((panel) => panel.id === "quality-gates"), {
      select: false, readiness: qualityStateReadiness(["stale", "loading", "pending"]),
    });
    assert(["stale", "loading", "pending"].includes(loadingPanel.fields["Quality resource"]),
      "Quality panel did not expose its delayed loading/stale state");
    assert.equal(loadingPanel.fields["Airbox-scoped result"], "unknown",
      "Airbox quality panel showed a pass/fail result while its resource was stale or loading");
  } finally {
    releaseRefresh.resolve();
    await page.unroute(pattern);
  }
  const restoredSnapshot = await waitForResourceState(page, path, ["ready"]);
  const restoredPanel = await readPanel(page, panels.find((panel) => panel.id === "quality-gates"), {
    select: false, readiness: qualityStateReadiness("ready", liveGateResult),
  });
  assert.equal(restoredSnapshot?.data?.quality?.airbox_quality_gates?.status, "unknown",
    "Delayed live response did not restore the actual unknown Airbox gate result");
  assert.equal(restoredPanel.fields["Quality resource"], "ready", "Live quality GET did not restore the ready resource");
  assert.equal(restoredPanel.fields["Airbox-scoped result"], liveGateResult,
    "Delayed live quality response changed the Airbox gate result");
  assert(delayedRequests >= 1 && delayedRequests <= 4, `Delayed quality GET count is out of bounds: ${delayedRequests}`);
  assert(delayedResponseStatus >= 200 && delayedResponseStatus < 300, "Delayed quality response was not live successful data");
  assert(delayedBodyPreserved, "Delayed quality response body was not preserved");

  const syntheticPassControlForError = await installSyntheticPass();
  let errorRequests = 0;
  await page.route(pattern, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    errorRequests += 1;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "synthetic browser QA quality-resource failure" }),
    });
  });
  syntheticQualityErrorActive = true;
  let errorPanel;
  let errorStatisticsPanel;
  let errorQualityFields;
  let errorSnapshot;
  try {
    await invalidateResource(page, path);
    errorSnapshot = await waitForResourceState(page, path, ["error"]);
    assert.equal(errorSnapshot?.status, "error", "Synthetic quality failure did not settle as a resource error");
    assert(typeof errorSnapshot?.error === "string" && errorSnapshot.error.length > 0,
      "Synthetic quality failure did not retain an observable resource error");
    assert.equal(errorSnapshot?.data?.quality?.airbox_quality_gates?.status, "pass",
      "Synthetic error did not retain the matching cached pass needed for a nonvacuous suppression check");
    const qualityPanel = panels.find((panel) => panel.id === "quality-gates");
    assert(qualityPanel, "Quality Gates panel is not configured for the cached-refresh error check");
    errorPanel = await readPanel(page, qualityPanel, {
      select: false,
      readiness: [{
        group: "Airbox Quality Gates",
        fields: {
          "Airbox-scoped result": "unknown",
          "Quality resource": ["error", "refresh error"],
        },
      }],
    });
    assert(["error", "refresh error"].includes(errorPanel.fields["Quality resource"]),
      "Quality Gates panel did not expose its failed resource state");
    assert.match(errorPanel.fields.Reason, /failed to load/i,
      "Quality Gates panel did not explain that the cached refresh failed to load");
    assert.equal(errorPanel.fields["Airbox-scoped result"], "unknown",
      "Airbox quality panel showed a pass/fail result after its quality resource failed");

    const statisticsPanel = panels.find((panel) => panel.id === "statistics");
    assert(statisticsPanel, "Statistics panel is not configured for the cached-refresh error check");
    errorStatisticsPanel = await readPanel(page, statisticsPanel, {
      readiness: [{
        group: "Airbox Quality Distributions",
        fields: { "Quality resource": "refresh error" },
      }],
    });
    const qualityDistributionFields = errorStatisticsPanel.groups.find(
      (group) => group.group === "Airbox Quality Distributions",
    )?.fields;
    assert(qualityDistributionFields, "Statistics panel omitted its Airbox quality distribution evidence");
    errorQualityFields = qualityDistributionFields;
    assert.equal(qualityDistributionFields.Scope, "Airbox endpoint scope",
      "Statistics panel retained a quality scope while the cached refresh had failed");
    assert.equal(qualityDistributionFields.Marker, "not published",
      "Statistics panel retained a quality marker while the cached refresh had failed");
    assert.equal(qualityDistributionFields["Quality source"], "not published",
      "Statistics panel retained a quality source while the cached refresh had failed");
    assert.equal(qualityDistributionFields["Elements in quality statistics"], "unknown",
      "Statistics panel retained quality element counts while the cached refresh had failed");
    assert.equal(errorQualityFields["Quality resource"], "refresh error",
      "A cached stale display was not accompanied by an explicit refresh-error signal");
  } finally {
    await page.unroute(pattern);
    await page.waitForTimeout(50);
    syntheticQualityErrorActive = false;
  }
  assert(errorRequests >= 1 && errorRequests <= 6, `Synthetic quality error GET count is out of bounds: ${errorRequests}`);
  assert(syntheticQualityHttpErrors.some((item) => item.includes("503 GET /v2/sessions/current/meshing/meshes/universe/quality")),
    "Synthetic quality failure response was not recorded separately from live API errors");

  await invalidateResource(page, path);
  const recoveredSnapshot = await waitForResourceState(page, path, ["ready"]);
  const recoveredPanel = await readPanel(page, panels.find((panel) => panel.id === "quality-gates"), {
    readiness: qualityStateReadiness("ready", liveGateResult),
  });
  assert.equal(recoveredSnapshot?.data?.quality?.airbox_quality_gates?.status, "unknown",
    "Live recovery did not restore the actual unknown Airbox gate result");
  assert.equal(recoveredPanel.fields["Quality resource"], "ready", "Live quality GET did not recover after the isolated error route was removed");
  assert.equal(recoveredPanel.fields["Airbox-scoped result"], liveGateResult,
    "Live quality result did not recover after the isolated error route was removed");
  assert.equal(String(recoveredSnapshot?.data?.revision), String(liveSnapshot?.data?.revision),
    "Quality resource revision changed during read-only synthetic browser checks");

  return {
    live_baseline: { resource_status: "ready", gate_result: liveGateResult, revision: liveRevision },
    evidence_kind: "fault-injected-ui-only-not-scientific",
    synthetic_pass_control: syntheticPassControl,
    delayed_live_get: {
      resource_status: loadingResourceStatus,
      panel_status: loadingPanel.fields["Quality resource"],
      gate_result: loadingPanel.fields["Airbox-scoped result"],
      live_response_preserved: delayedBodyPreserved,
      live_response_status: delayedResponseStatus,
      requests: delayedRequests,
      cached_synthetic_gate_status: "pass",
      restored_to_live_unknown: restoredPanel.fields["Airbox-scoped result"] === liveGateResult,
    },
    synthetic_pass_control_for_error: syntheticPassControlForError,
    synthetic_error_get: {
      http_status: 503,
      resource_status: errorSnapshot.status,
      resource_error_observed: true,
      panel_resource_status: errorPanel.fields["Quality resource"],
      panel_reason_reports_failed_load: /failed to load/i.test(errorPanel.fields.Reason),
      gate_result: errorPanel.fields["Airbox-scoped result"],
      refresh_error_visible_in_statistics: errorQualityFields["Quality resource"] === "refresh error",
      cached_quality_withheld: true,
      requests: errorRequests,
      cached_synthetic_gate_status: "pass",
      restored_to_live_unknown: recoveredPanel.fields["Airbox-scoped result"] === liveGateResult,
    },
    final_live_state: {
      resource_status: recoveredPanel.fields["Quality resource"],
      gate_result: recoveredPanel.fields["Airbox-scoped result"],
      revision_matches_live: String(recoveredSnapshot?.data?.revision) === String(liveRevision),
    },
  };
}

async function main() {
  assert.equal(process.env.CONTROL_ROOM_BROWSER_QA_SCENARIO, "airbox-inspector",
    "Airbox Inspector browser harness requires managed scenario admission");
  assert(publicUrl.startsWith("http://127.0.0.1:"), "Managed browser QA did not pin the public loopback URL");
  const playwrightVersion = require("playwright/package.json").version;
  assert.equal(playwrightVersion, expectedVersion, "Playwright package does not match the pinned browser image");
  const runnerPath = fileURLToPath(import.meta.url);
  const scriptSha256 = createHash("sha256").update(await readFile(runnerPath)).digest("hex");

  let loopbackProxy;
  let browser;
  let context;
  let page;
  let proof;
  let resultPayload;
  const workspaceEntry = {
    stage: "proxy-not-started",
    requested_path: "/workspace",
    home_overlay_visible: null,
    workspace_body_visible: false,
    explorer_visible: false,
  };
  try {
    loopbackProxy = await startBrowserQaLoopbackProxy(publicUrl, probeUrl);
    browserOrigin = loopbackProxy.origin;
    workspaceEntry.stage = "proxy-started";
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader-webgl"],
    });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
      serviceWorkers: "block",
    });
    await context.addInitScript(() => {
      window.__FULLMAG_CONFIG__ = {
        ...(window.__FULLMAG_CONFIG__ ?? {}),
        enableAuditHooks: true,
      };
    });
    page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    page.on("pageerror", (error) => collect(pageErrors, diagnosticText(error?.message ?? error)));
    page.on("console", (message) => {
      if (message.type() === "error") {
        const text = diagnosticText(message.text());
        const locationUrl = message.location()?.url;
        let isSyntheticQualityConsoleError = false;
        if (syntheticQualityErrorActive && typeof locationUrl === "string" && locationUrl) {
          try {
            isSyntheticQualityConsoleError = new URL(locationUrl).pathname === qualityPath;
          } catch {
            isSyntheticQualityConsoleError = false;
          }
        }
        if (isSyntheticQualityConsoleError) {
          collect(syntheticQualityConsoleErrors, diagnosticText(`${locationUrl}: ${text}`));
        } else {
          collect(consoleErrors, text);
        }
      }
    });
    page.on("request", (request) => {
      const startedAt = Date.now();
      requestStartedAt.set(request, startedAt);
      const path = new URL(request.url()).pathname;
      if (startupDiagnosticPaths.has(path)) {
        if (startupRequestEvents.length >= 32) {
          collect(requestFailures, "Startup diagnostic request audit exceeded its 32-request bound");
        } else {
          const requestUrl = new URL(request.url());
          const startupRequest = {
            request_id: ++startupRequestSequence,
            method: request.method(),
            path,
            resource_type: request.resourceType(),
            same_origin: requestUrl.origin === browserOrigin,
            started_phase: harnessPhase,
            started_elapsed_ms: Math.max(0, startedAt - runStartedAt),
            outcome: "pending",
            response_status: null,
            response_elapsed_ms: null,
            finished: false,
            finished_elapsed_ms: null,
            error: null,
            failure_phase: null,
            failure_elapsed_ms: null,
            failure_message: null,
          };
          startupRequestEvents.push(startupRequest);
          startupRequestByRequest.set(request, startupRequest);
        }
      }
      if (request.method() === "GET" && path === planarMonitorsPath) {
        const monitorRequest = {
          done: deferred(),
          startedAt,
          startedPhase: harnessPhase,
          settled: false,
          settledAt: null,
          outcome: null,
          status: null,
          error: null,
        };
        planarMonitorRequests.push(monitorRequest);
        planarMonitorRequestByRequest.set(request, monitorRequest);
      }
      if (path.startsWith("/v2/sessions/current/") && !["GET", "HEAD"].includes(request.method())) {
        if (request.method() === "POST" && path === visualizationClientAcksPath) {
          const acknowledgement = {
            path,
            method: request.method(),
            payload: visualizationAckPayloadMetadata(request),
            response_status: null,
            outcome: "pending",
          };
          visualizationAckByRequest.set(request, acknowledgement);
          if (visualizationClientAcknowledgements.length < 16) {
            visualizationClientAcknowledgements.push(acknowledgement);
          } else {
            collect(requestFailures, "Visualization acknowledgement evidence exceeded its 16-request bound");
          }
        } else {
          collect(mutationRequests, mutationRequestDiagnostic(request, path, harnessPhase));
        }
      }
    });
    page.on("requestfailed", (request) =>
      collectRequestFailure(request, request.failure()?.errorText ?? "failed"));
    page.on("response", (response) => {
      const startupRequest = startupRequestByRequest.get(response.request());
      if (startupRequest) {
        startupRequest.response_status = response.status();
        startupRequest.response_elapsed_ms = Math.max(0, Date.now() - runStartedAt);
      }
      const acknowledgement = visualizationAckByRequest.get(response.request());
      if (acknowledgement) {
        acknowledgement.response_status = response.status();
        acknowledgement.outcome = response.status() < 400 ? "recorded" : "http_error";
      }
      const monitorRequest = planarMonitorRequestByRequest.get(response.request());
      if (monitorRequest) {
        monitorRequest.settled = true;
        monitorRequest.settledAt = Date.now();
        monitorRequest.status = response.status();
        monitorRequest.outcome = response.status() < 400 ? "response" : "http_error";
        monitorRequest.done.resolve();
      }
      if (response.status() >= 400) {
        const item = `${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`;
        if (syntheticQualityErrorActive
          && response.status() === 503
          && response.request().method() === "GET"
          && new URL(response.url()).pathname === resourcePaths.universeQuality) {
          collect(syntheticQualityHttpErrors, item);
        } else {
          collect(httpErrors, item);
        }
      }
    });
    page.on("requestfinished", (request) => {
      const startupRequest = startupRequestByRequest.get(request);
      if (startupRequest) {
        startupRequest.finished = true;
        startupRequest.finished_elapsed_ms = Math.max(0, Date.now() - runStartedAt);
        startupRequest.outcome = "finished";
      }
    });

    workspaceEntry.stage = "navigating";
    harnessPhase = "workspace-navigation";
    const navigationResponse = await page.goto(new URL("/workspace", loopbackProxy.origin).toString(), {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    workspaceEntry.navigation_status = navigationResponse?.status() ?? null;
    workspaceEntry.current_url = safePageUrl(page.url());
    assert(navigationResponse && navigationResponse.status() < 400,
      `Workspace navigation returned HTTP ${navigationResponse?.status() ?? "no response"}`);
    workspaceEntry.stage = "page-loaded";
    const homeOverlay = page.locator('.fm-home-overlay[data-state="home-overlay"]');
    workspaceEntry.home_overlay_visible = await homeOverlay.isVisible();
    if (workspaceEntry.home_overlay_visible) {
      workspaceEntry.stage = "returning-from-home-overlay";
      await page.getByRole("button", { name: "Back to simulation", exact: true }).click();
      await homeOverlay.waitFor({ state: "hidden", timeout: timeoutMs });
      workspaceEntry.home_overlay_visible = false;
      workspaceEntry.returned_from_home_overlay = true;
    } else {
      workspaceEntry.returned_from_home_overlay = false;
    }
    workspaceEntry.stage = "waiting-for-workspace";
    await page.locator("#fm-main-content.fm-workspace-body").waitFor({ state: "visible", timeout: timeoutMs });
    workspaceEntry.workspace_body_visible = true;
    await page.locator(".fm-explorer").waitFor({ state: "visible", timeout: timeoutMs });
    workspaceEntry.explorer_visible = true;
    await page.locator("[data-node-id='model:airbox']").waitFor({ state: "visible", timeout: timeoutMs });
    await page.waitForFunction(() => Boolean(window.__FULLMAG_CONTROL_ROOM_AUDIT__?.invalidateResource), null, { timeout: timeoutMs });
    workspaceEntry.stage = "ready";
    harnessPhase = "workspace-ready";
    assert.equal(mutationRequests.length, 0,
      `Opening the workspace sent unexpected authoring/solve mutations: ${mutationRequests.join(", ")}`);

    const status = await readResource(page.request, resourcePaths.sessionStatus, "current session status");
    harnessPhase = "session-resource-validation";
    const authoredMethod = status.capabilities?.active_lane?.authored?.discretization ?? null;
    const activeLaneStatus = status.capabilities?.active_lane ?? null;
    const actualResolved = activeLaneStatus?.resolved?.discretization ?? null;
    assert.equal(authoredMethod, "fem", "Live browser session is not authored as FEM");
    assert.equal(status.domain?.discretization, "fem", "Live session does not publish FEM domain metadata");
    assertPositiveCount(status.domain?.cell_count, "published FEM cell count");
    assertPositiveCount(status.resources?.mesh_revision, "published FEM mesh revision");
    assertPositiveCount(status.resources?.topology_revision, "published FEM topology revision");
    assert.equal(status.resources?.domain_generation_id, status.domain?.generation_id,
      "Live FEM status does not bind its domain generation to the resource identity");

    const session = status.session;
    assert(typeof session?.session_id === "string" && session.session_id.length > 0, "Live status omitted the session identity");
    assert(typeof session?.session_epoch === "string" && session.session_epoch.length > 0, "Live status omitted the session epoch");
    assert(typeof session?.request_scope_epoch === "string" && session.request_scope_epoch.length > 0, "Live status omitted the API scope epoch");
    const sessionScopeKey = `session=${encodeURIComponent(session.session_id)}&epoch=${encodeURIComponent(session.session_epoch)}&request_scope_epoch=${encodeURIComponent(session.request_scope_epoch)}`;
    const [policy, manifest, quality, report, currentBuild, latestBuild] = await Promise.all([
      readResource(page.request, resourcePaths.universePolicy, "universe mesh policy", sessionScopeKey),
      readResource(page.request, resourcePaths.sharedDomainManifest, "shared-domain manifest", sessionScopeKey),
      readResource(page.request, resourcePaths.universeQuality, "universe quality", sessionScopeKey),
      readResource(page.request, resourcePaths.universeReport, "universe report", sessionScopeKey),
      readResource(page.request, resourcePaths.currentBuild, "current mesh build", sessionScopeKey),
      readResource(page.request, resourcePaths.latestSuccessfulBuild, "latest successful mesh build", sessionScopeKey),
    ]);
    assert.equal(manifest.generation_id, status.domain.generation_id, "Manifest generation differs from live FEM status");
    assert.equal(String(manifest.revision), String(status.resources.mesh_revision), "Manifest revision differs from live FEM mesh revision");
    assert.equal(manifest.revision, status.resources.mesh_revision, "Manifest revision is not the current published mesh revision");
    assert.equal(String(report.revision), String(status.resources.mesh_revision),
      "Universe report revision differs from the current published FEM mesh");
    assert.equal(manifest.topology_fingerprint?.length > 0, true, "Manifest omitted topology fingerprint");
    assert.equal(currentBuild.revision != null, true, "Current build resource omitted its revision");
    if (latestBuild.last_success != null) {
      assert.equal(typeof latestBuild.last_success, "object",
        "Published latest successful build artifact must be an object");
    }

    const canvas = await inspectCanvas(page);
    assert.equal(canvas.visible, true, "Workspace canvas is not visible");
    assert.equal(canvas.context_lost, false, "Workspace WebGL context is lost or unknown");
    assert(canvas.drawing_buffer_width > 0 && canvas.drawing_buffer_height > 0, "Workspace canvas has an empty drawing buffer");

    await expandNode(page, "model:airbox");
    await expandNode(page, "model:airbox:mesh");
    const explorerNodes = await readExplorerNodeDiagnostics(page);
    harnessPhase = "inspector-status-preparation";
    const nullResolution = activeLaneStatus?.resolved === null
      ? { status_overrides: 0, other_fields_preserved: true, planar_monitor_settlement: null }
      : await installResolvedNullStatusRoute(page);
    assert.equal(nullResolution.other_fields_preserved, true, "Resolved-null status probe changed live API fields outside the lane");
    harnessPhase = "initial-quality-loading";
    const initialQualityLoading = await exerciseInitialQualityLoading(page, quality);

    harnessPhase = "inspector-panel-proof";
    const panelProof = [];
    for (const panel of panels) {
      harnessPhase = `inspector-panel:${panel.id}`;
      panelProof.push(await readPanel(page, panel, { readiness: qualityPanelReadiness(panel, quality) }));
      const snapshot = await panelDataSnapshot(page);
      assert(snapshot, `Inspector route ${panel.id} lost its root during panel evidence capture`);
      if (panel.id === "parameters") {
        panelProof[panelProof.length - 1].parameter_units = snapshot.parameterUnits;
        panelProof[panelProof.length - 1].parameter_values = snapshot.parameterValues;
        panelProof[panelProof.length - 1].parameter_effective_fields = snapshot.parameterEffectiveFields;
      }
      if (panel.id === "mesh") {
        panelProof[panelProof.length - 1].api_effective_target = currentBuild.effective_airbox_target ?? currentBuild.last_build_summary?.effective_airbox_target ?? {};
      }
      if (panel.id === "topology") {
        const identityMatches = status.domain.generation_id === status.resources.domain_generation_id
          && status.domain.generation_id === manifest.generation_id
          && status.domain.cell_count > 0
          && status.resources.mesh_revision > 0
          && status.resources.topology_revision > 0
          && String(manifest.revision) === String(status.resources.mesh_revision);
        panelProof[panelProof.length - 1].topology_identity = { verified: identityMatches, generation_id: manifest.generation_id, revision: manifest.revision };
        assert(identityMatches, "Published FEM topology identity is incomplete");
      }
      if (panel.id === "build") {
        const buildFields = snapshot.buildFields;
        const latestSuccessfulArtifactPublished = latestBuild.last_success != null;
        const artifactState = groupValue(
          panelProof,
          "build",
          "Latest Successful Build",
          "Artifact",
        );
        const buildIdentityMatches = numberFromText(buildFields["Current build revision"]) === currentBuild.revision
          && numberFromText(buildFields["Universe report revision"]) === report.revision
          && numberFromText(buildFields["Build history resource revision"]) === latestBuild.revision
          && artifactState === (latestSuccessfulArtifactPublished ? "published" : "not published");
        panelProof[panelProof.length - 1].build_identity = { verified: buildIdentityMatches };
        panelProof[panelProof.length - 1].latest_successful_artifact_published = latestSuccessfulArtifactPublished;
        assert(buildIdentityMatches, "Airbox Build panel does not match live current/report/latest-success API resources");
      }
    }

    // Return to the root to prove its DOM node survives a real GET refresh.
    harnessPhase = "inspector-panel:root-refresh-check";
    await readPanel(page, panels[0]);
    harnessPhase = "manifest-refresh";
    const refresh = await triggerStableManifestRefresh(page, manifest);
    const comparisons = deriveApiComparisons({ policy, manifest, quality, report, status, panels: panelProof });
    harnessPhase = "quality-state-probes";
    const qualityStateProof = await exerciseQualityReadStates(page);
    const startupCancellationProof = await proveStartupUnmountCancellationFollowupReads(page, workspaceEntry);
    assert.equal(mutationRequests.length, 0, `Browser sent mutating session requests: ${mutationRequests.join(", ")}`);
    const solveMutationRequests = mutationRequests.filter((request) =>
      /(?:^|\/)solve(?:\/|$)/i.test(request.slice(request.indexOf(" ") + 1)),
    );
    assert.equal(solveMutationRequests.length, 0, `Browser sent Solve commands: ${solveMutationRequests.join(", ")}`);
    assert.equal(
      visualizationClientAcknowledgements.filter((acknowledgement) => !acknowledgement.payload.body_valid_json).length,
      0,
      "Visualization client acknowledgement did not carry valid JSON metadata",
    );
    assert.equal(pageErrors.length, 0, `Browser page errors: ${pageErrors.join(" | ")}`);
    assert.equal(consoleErrors.length, 0, `Browser console errors: ${consoleErrors.join(" | ")}`);
    assert.equal(requestFailures.length, 0, `Browser request failures: ${requestFailures.join(" | ")}`);
    assert.equal(httpErrors.length, 0, `Browser HTTP errors: ${httpErrors.join(" | ")}`);

    proof = {
      schema: proofSchema,
      script_sha256: scriptSha256,
      authored_method: authoredMethod,
      actual_resolved_discretization: actualResolved,
      published_fem_with_unresolved_runtime: true,
      unresolved_status_probe: {
        source: actualResolved === null ? "live-session-status" : "single-field-status-route-overlay",
        status_overrides: nullResolution.status_overrides,
        only_active_lane_resolved_changed: nullResolution.other_fields_preserved,
        planar_monitor_settlement: nullResolution.planar_monitor_settlement,
        domain_discretization: status.domain.discretization,
        domain_generation_id: status.domain.generation_id,
        mesh_revision: status.resources.mesh_revision,
        topology_revision: status.resources.topology_revision,
      },
      generic_unknown_header_rejected: true,
      no_authoring_mutations: true,
      no_solve_commands: solveMutationRequests.length === 0,
      visualization_client_acknowledgements: visualizationClientAcknowledgements,
      planar_monitor_requests: planarMonitorRequestEvidence(),
      canvas,
      workspace_entry: { ...workspaceEntry },
      explorer_nodes: explorerNodes,
      panels: panelProof,
      api_comparisons: comparisons,
      resource_refresh: refresh,
      initial_quality_loading: initialQualityLoading,
      synthetic_quality_fault_injection: qualityStateProof,
      startup_unmount_cancellation_probes: startupCancellationProof,
    };

    const output = {
      schema: resultSchema,
      state: "passed",
      scenario: "airbox-inspector",
      public_url: publicUrl,
      probe_url: probeUrl,
      playwright_version: playwrightVersion,
      browser_gpu_mode: browserGpuMode,
      page_errors: pageErrors.length,
      console_errors: consoleErrors.length,
      request_failures: requestFailures.length,
      http_errors: httpErrors,
      synthetic_http_errors: syntheticQualityHttpErrors,
      synthetic_console_errors: syntheticQualityConsoleErrors,
      startup_request_events: startupRequestEvidence(),
      startup_unmount_cancellation_probes: startupCancellationProof,
      resource_responses: resourceResponses,
      visualization_client_acknowledgements: visualizationClientAcknowledgements,
      planar_monitor_requests: planarMonitorRequestEvidence(),
      inspector_proof: proof,
    };
    resultPayload = output;
  } catch (error) {
    const failureDiagnostics = await collectFailurePageDiagnostics(page, workspaceEntry);
    const failure = {
      schema: resultSchema,
      state: "failed",
      scenario: "airbox-inspector",
      public_url: publicUrl,
      probe_url: probeUrl,
      playwright_version: expectedVersion,
      browser_gpu_mode: browserGpuMode,
      page_errors: pageErrors.length,
      console_errors: consoleErrors.length,
      request_failures: requestFailures.length,
      http_errors: httpErrors,
      synthetic_http_errors: syntheticQualityHttpErrors,
      synthetic_console_errors: syntheticQualityConsoleErrors,
      startup_request_events: startupRequestEvidence(),
      startup_unmount_cancellation_probes: startupUnmountCancellationProbes.slice(0, startupDiagnosticPaths.size),
      resource_responses: resourceResponses,
      visualization_client_acknowledgements: visualizationClientAcknowledgements,
      planar_monitor_requests: planarMonitorRequestEvidence(),
      error: diagnosticText(error?.stack ?? error, 2048),
      failure_diagnostics: failureDiagnostics,
      browser_route: loopbackProxy ? {
        origin: loopbackProxy.origin,
        upstream: loopbackProxy.upstream,
        proxy_failures: loopbackProxy.failures.slice(0, 8).map((failure) => diagnosticText(failure, 400)),
      } : null,
      partial_inspector_proof: proof,
    };
    resultPayload = failure;
    process.exitCode = 1;
  } finally {
    teardownStartedAt = Date.now();
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await loopbackProxy?.close().catch(() => undefined);
    browserOrigin = null;
  }
  if (!resultPayload) {
    process.exitCode = 1;
    process.stdout.write(`${JSON.stringify({
      schema: resultSchema,
      state: "failed",
      scenario: "airbox-inspector",
      error: "Browser QA ended without a result payload.",
    })}\n`);
    return;
  }
  const shutdownFindings = [
    pageErrors.length > 0 ? `${pageErrors.length} page error(s)` : null,
    consoleErrors.length > 0 ? `${consoleErrors.length} console error(s)` : null,
    requestFailures.length > 0 ? `${requestFailures.length} request failure(s)` : null,
    httpErrors.length > 0 ? `${httpErrors.length} HTTP error(s)` : null,
    loopbackProxy?.failures.length ? `${loopbackProxy.failures.length} proxy failure(s)` : null,
  ].filter(Boolean);
  if (resultPayload.state === "passed" && shutdownFindings.length > 0) {
    resultPayload.state = "failed";
    resultPayload.error = `Browser lifecycle recorded errors after scenario checks: ${shutdownFindings.join(", ")}.`;
    process.exitCode = 1;
  }
  Object.assign(resultPayload, {
    page_errors: pageErrors.length,
    page_error_messages: diagnosticSamples(pageErrors),
    console_errors: consoleErrors.length,
    console_error_messages: diagnosticSamples(consoleErrors),
    request_failures: requestFailures.length,
    request_failure_messages: diagnosticSamples(requestFailures),
    request_cancellations: requestCancellations.slice(0, 8),
    startup_request_events: startupRequestEvidence(),
    startup_unmount_cancellation_probes: startupUnmountCancellationProbes.slice(0, startupDiagnosticPaths.size),
    http_errors: httpErrors,
    browser_route: loopbackProxy ? {
      origin: loopbackProxy.origin,
      upstream: loopbackProxy.upstream,
      proxy_failures: loopbackProxy.failures.slice(0, 8).map((failure) => diagnosticText(failure, 400)),
    } : null,
  });
  process.stdout.write(`${JSON.stringify(resultPayload)}\n`);
}

await main();
