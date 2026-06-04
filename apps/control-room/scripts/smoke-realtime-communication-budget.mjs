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
      wsFrames.push({
        bytes: String(frame.payload).length,
        timestamp: Date.now(),
        type: messageTypeFromPayload(frame.payload),
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

  return {
    durationMs,
    fieldVectorHttpTxCount: fieldVectorHttpTx.length,
    fieldVectorHttpTxPerMinute: rate(fieldVectorHttpTx.length, durationMinutes),
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

function messageTypeFromPayload(payload) {
  try {
    const parsed = JSON.parse(String(payload));
    return typeof parsed?.type === "string" ? parsed.type : "unknown";
  } catch {
    return "unknown";
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
