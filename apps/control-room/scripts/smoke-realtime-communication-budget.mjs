import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createQuantitySwitchAckProofRecorder } from "../src/kernel/visualization/quantitySwitchAckProofCore.js";

const apiBase = (
  process.env.CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_RUNTIME_HTTP_BASE ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:8081"
).replace(/\/$/, "");
const workspaceUrl =
  process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const warmupMs = numericEnv("CONTROL_ROOM_COMMUNICATION_WARMUP_MS", 10_000);
const windowMs = numericEnv("CONTROL_ROOM_COMMUNICATION_WINDOW_MS", 60_000);
const timeoutMs = numericEnv("CONTROL_ROOM_COMMUNICATION_TIMEOUT_MS", 120_000);
const maxSessionHttpPerMinute = numericEnv(
  "CONTROL_ROOM_COMMUNICATION_MAX_SESSION_HTTP_PER_MIN",
  30,
);
const maxFieldVectorHttpPerMinute = numericEnv(
  "CONTROL_ROOM_COMMUNICATION_MAX_FIELD_VECTOR_HTTP_PER_MIN",
  45,
);
const maxFieldSampleWsPerMinute = numericEnv(
  "CONTROL_ROOM_COMMUNICATION_MAX_FIELD_SAMPLE_WS_PER_MIN",
  45,
);
const maxScalarSampleWsPerMinute = numericEnv(
  "CONTROL_ROOM_COMMUNICATION_MAX_SCALAR_SAMPLE_WS_PER_MIN",
  360,
);
const maxTopologyHttpPerMinute = numericEnv(
  "CONTROL_ROOM_COMMUNICATION_MAX_TOPOLOGY_HTTP_PER_MIN",
  0,
);
const requireFullmagWebsocket =
  process.env.CONTROL_ROOM_COMMUNICATION_REQUIRE_FULLMAG_WS !== "0";

const FULLMAG_WS_PATH = "/v2/sessions/current/events/ws";
const SESSION_RESOURCE_PREFIX = "/v2/sessions/current/";
const VISUALIZATION_ACK_PATH = "/v2/sessions/current/visualization/client-acks";
const FIELD_VECTOR_PATTERN = /^\/v2\/sessions\/current\/data\/fields\/[^/]+\/samples\/vector/;
const TOPOLOGY_PATHS = new Set([
  "/v2/sessions/current/data/domain/topology",
  "/v2/sessions/current/meshing/meshes/shared-domain/topology",
]);

async function main() {
  const playwright = await loadPlaywright();
  if (!playwright?.chromium) {
    throw new Error(
      "Realtime communication budget smoke requires Playwright or @playwright/test.",
    );
  }

  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });
  const httpEvents = [];
  const quantityAckEvents = [];
  const wsFrames = [];
  let sawFullmagWebsocket = false;

  await page.addInitScript((baseUrl) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      controlRoomApiBase: baseUrl,
    };
  }, apiBase);

  page.on("request", (request) => {
    const path = currentSessionPath(request.url());
    if (!path) return;
    httpEvents.push({
      direction: "tx",
      method: request.method(),
      path,
      timestamp: Date.now(),
    });
    if (pathWithoutQuery(path) === VISUALIZATION_ACK_PATH && request.method() === "POST") {
      const body = safelyParseJson(request.postData());
      quantityAckEvents.push({ body, raw: request.postData() });
    }
  });
  page.on("response", (response) => {
    const path = currentSessionPath(response.url());
    if (!path) return;
    httpEvents.push({
      direction: "rx",
      method: response.request().method(),
      path,
      status: response.status(),
      timestamp: Date.now(),
    });
  });
  page.on("websocket", (websocket) => {
    if (pathnameFromUrl(websocket.url()) !== FULLMAG_WS_PATH) {
      return;
    }
    sawFullmagWebsocket = true;
    websocket.on("framereceived", (frame) => {
      const parsedFrame = websocketFrameFromPayload(frame.payload);
      wsFrames.push({
        bytes: String(frame.payload).length,
        fieldSamples: parsedFrame.fieldSamples,
        timestamp: Date.now(),
        type: parsedFrame.type,
      });
    });
  });

  try {
    await page.goto(workspaceUrl, {
      timeout: timeoutMs,
      waitUntil: "domcontentloaded",
    });
    await page.locator("main").waitFor({ state: "visible", timeout: timeoutMs });
    await page.waitForTimeout(warmupMs);

    httpEvents.length = 0;
    quantityAckEvents.length = 0;
    wsFrames.length = 0;
    const start = Date.now();
    await page.waitForTimeout(windowMs);
    const durationMs = Date.now() - start;
    const summary = summarize({
      durationMs,
      httpEvents,
      sawFullmagWebsocket,
      wsFrames,
    });
    const failures = validateSummary(summary);
    const quantityProof = buildQuantitySwitchAckProof({
      acknowledgements: quantityAckEvents,
      expectations: quantityProofExpectationsFromEnv(),
      requests: httpEvents,
    });
    writeQuantitySwitchAckProofArtifact(quantityProof);
    failures.push(...quantityProof.failures);
    console.log(`Realtime communication metrics: ${JSON.stringify(summary)}`);
    if (failures.length > 0) {
      throw new Error(
        "Realtime communication budget failed:\n" + failures.join("\n"),
      );
    }
    console.log(`Realtime communication budget smoke passed at ${workspaceUrl}.`);
  } finally {
    await browser.close();
  }
}

export function buildQuantitySwitchAckProof({ acknowledgements, expectations, requests }) {
  const recorder = createQuantitySwitchAckProofRecorder();
  const canonicalExpectations = expectations.map((entry) => ({
    carrierKey: `${entry.viewportId}\u0000${entry.resourceKey}`,
    revision: entry.revision,
    styleOnly: entry.styleOnly,
  }));
  for (const request of requests) {
    if (request.direction !== "tx") continue;
    const carrierKey = `${expectations.find((entry) => entry.resourceKey === request.path)?.viewportId ?? "unexpected"}\u0000${request.path}`;
    recorder.recordRequest({ carrierKey, method: request.method, resourceKey: carrierKey, unexpected: request.method === "GET" && FIELD_VECTOR_PATTERN.test(pathWithoutQuery(request.path)) && !expectations.some((entry) => entry.resourceKey === request.path) });
  }
  for (const event of acknowledgements) {
    const body = event.body ?? event;
    const viewportId = body?.viewport_id ?? body?.viewportId;
    const matching = expectations.find((entry) => entry.viewportId === viewportId && entry.revision === body?.revision);
    recorder.recordAcknowledgement({
      carrierKey: matching ? `${matching.viewportId}\u0000${matching.resourceKey}` : "malformed",
      malformed: !body || !Number.isInteger(body.revision) || typeof viewportId !== "string" || typeof body.status !== "string",
      revision: body?.revision ?? -1,
      status: body?.status,
    });
  }
  const failures = recorder.validate(canonicalExpectations);
  return {
    schemaVersion: 1,
    provenance: { apiBase, script: "smoke-realtime-communication-budget.mjs", workspaceUrl },
    raw: { acknowledgements, requests },
    expectations,
    failures,
    result: failures.length === 0 ? "pass" : "fail",
  };
}

export function writeQuantitySwitchAckProofArtifact(proof, artifactPath = process.env.CONTROL_ROOM_QUANTITY_ACK_PROOF_ARTIFACT ?? "artifacts/quantity-switch-ack-proof.json") {
  const destination = resolve(artifactPath);
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  renameSync(temporary, destination);
  return destination;
}

function quantityProofExpectationsFromEnv() {
  const parsed = safelyParseJson(process.env.CONTROL_ROOM_QUANTITY_ACK_PROOF_EXPECTATIONS);
  if (!Array.isArray(parsed) || parsed.length === 0) return [];
  return parsed.every((entry) => entry && typeof entry.resourceKey === "string" && typeof entry.viewportId === "string" && Number.isInteger(entry.revision)) ? parsed : [];
}

function safelyParseJson(value) {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { return null; }
}

function summarize({ durationMs, httpEvents, sawFullmagWebsocket, wsFrames }) {
  const durationMinutes = durationMs / 60_000;
  const httpTx = httpEvents.filter((event) => event.direction === "tx");
  const httpRx = httpEvents.filter((event) => event.direction === "rx");
  const fieldVectorHttpTx = httpTx.filter((event) =>
    FIELD_VECTOR_PATTERN.test(event.path),
  );
  const topologyHttpTx = httpTx.filter((event) =>
    TOPOLOGY_PATHS.has(pathWithoutQuery(event.path)),
  );
  const scalarSamples = wsFrames.filter((frame) => frame.type === "scalar.sample");
  const fieldSampleWs = wsFrames.filter((frame) => frame.fieldSamples);

  return {
    durationMs,
    fieldVectorHttpTxCount: fieldVectorHttpTx.length,
    fieldVectorHttpTxPerMinute: rate(fieldVectorHttpTx.length, durationMinutes),
    fieldSampleWsCount: fieldSampleWs.length,
    fieldSampleWsPerMinute: rate(fieldSampleWs.length, durationMinutes),
    fullmagWsRxCount: wsFrames.length,
    fullmagWsRxPerMinute: rate(wsFrames.length, durationMinutes),
    httpRxByStatus: countBy(httpRx, (event) => String(event.status ?? "unknown")),
    httpRxCount: httpRx.length,
    httpTxByPath: countBy(httpTx, (event) => event.path),
    httpTxCount: httpTx.length,
    httpTxPerMinute: rate(httpTx.length, durationMinutes),
    scalarSampleWsCount: scalarSamples.length,
    scalarSampleWsPerMinute: rate(scalarSamples.length, durationMinutes),
    sawFullmagWebsocket,
    topologyHttpTxCount: topologyHttpTx.length,
    topologyHttpTxPerMinute: rate(topologyHttpTx.length, durationMinutes),
    wsByType: countBy(wsFrames, (frame) => frame.type),
    wsBytes: wsFrames.reduce((total, frame) => total + frame.bytes, 0),
  };
}

function validateSummary(summary) {
  const failures = [];
  if (requireFullmagWebsocket && !summary.sawFullmagWebsocket) {
    failures.push("Fullmag websocket was not observed during the smoke.");
  }
  if (summary.httpTxPerMinute > maxSessionHttpPerMinute) {
    failures.push(
      `HTTP session traffic ${summary.httpTxPerMinute}/min exceeds ${maxSessionHttpPerMinute}/min.`,
    );
  }
  if (summary.scalarSampleWsPerMinute > maxScalarSampleWsPerMinute) {
    failures.push(
      `scalar.sample websocket telemetry ${summary.scalarSampleWsPerMinute}/min exceeds ${maxScalarSampleWsPerMinute}/min.`,
    );
  }
  if (summary.fieldVectorHttpTxPerMinute > maxFieldVectorHttpPerMinute) {
    failures.push(
      `field-vector HTTP traffic ${summary.fieldVectorHttpTxPerMinute}/min exceeds ${maxFieldVectorHttpPerMinute}/min.`,
    );
  }
  if (summary.fieldSampleWsPerMinute > maxFieldSampleWsPerMinute) {
    failures.push(
      `fields:samples websocket invalidations ${summary.fieldSampleWsPerMinute}/min exceeds ${maxFieldSampleWsPerMinute}/min.`,
    );
  }
  if (summary.topologyHttpTxPerMinute > maxTopologyHttpPerMinute) {
    failures.push(
      `topology HTTP traffic ${summary.topologyHttpTxPerMinute}/min exceeds ${maxTopologyHttpPerMinute}/min.`,
    );
  }
  return failures;
}

function currentSessionPath(url) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== apiBase) return null;
    if (!parsed.pathname.startsWith(SESSION_RESOURCE_PREFIX)) return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

function pathnameFromUrl(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function pathWithoutQuery(path) {
  return path.split("?")[0] ?? path;
}

function websocketFrameFromPayload(payload) {
  try {
    const parsed = JSON.parse(String(payload));
    const type = typeof parsed?.type === "string" ? parsed.type : "unknown";
    const changes = Array.isArray(parsed?.payload?.changes)
      ? parsed.payload.changes
      : [];
    const fieldSamples = changes.some(
      (change) =>
        change?.resource === "fields" &&
        change?.resource_id === "samples",
    );
    return { fieldSamples, type };
  } catch {
    return { fieldSamples: false, type: "unknown" };
  }
}

function countBy(items, keyFn) {
  const result = {};
  for (const item of items) {
    const key = keyFn(item);
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

function rate(count, durationMinutes) {
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) return 0;
  return Number((count / durationMinutes).toFixed(2));
}

function numericEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
