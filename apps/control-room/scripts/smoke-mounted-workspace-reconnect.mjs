import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const workspaceUrl = process.env.CONTROL_ROOM_URL ?? "http://localhost:3104/workspace";
const outputDir = resolve(
  process.cwd(),
  process.env.CONTROL_ROOM_RECONNECT_REPORT_DIR ?? ".fullmag/reports/mounted-workspace-reconnect",
);
const realtimePath = "/v2/sessions/current/events/ws";
const expectedIdle404MaxCounts = new Map([
  ["/v2/sessions/current/simulation/preparation", 8],
  ["/v2/sessions/current/simulation/runs/current", 8],
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

function parseMessage(message) {
  if (typeof message === "string") {
    try {
      return JSON.parse(message);
    } catch {
      return null;
    }
  }
  return null;
}

function waitForEvent(eventName, timeoutMs = 30_000) {
  let timer;
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  timer = setTimeout(() => {
    rejectPromise(new Error(`timed out waiting for ${eventName}`));
  }, timeoutMs);
  return {
    promise,
    resolve(value) {
      clearTimeout(timer);
      resolvePromise(value);
    },
  };
}

const playwright = await loadPlaywright();
if (!playwright?.chromium) {
  console.error("Mounted workspace reconnect smoke requires Playwright or @playwright/test.");
  process.exit(2);
}

await mkdir(outputDir, { recursive: true });
const reportPath = resolve(outputDir, "report.json");
const browser = await playwright.chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const consoleErrors = [];
const httpErrors = [];
const sockets = [];
const firstHello = waitForEvent("first realtime hello");
const reconnectHello = waitForEvent("reconnected realtime hello");
let droppedFirstSocket = false;

page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(error.stack ?? error.message));
page.on("response", (response) => {
  if (response.status() >= 400) {
    const url = new URL(response.url());
    httpErrors.push({ method: response.request().method(), path: url.pathname, status: response.status() });
  }
});

await page.routeWebSocket((url) => url.pathname === realtimePath, (websocket) => {
  const server = websocket.connectToServer();
  const dropThisSocket = !droppedFirstSocket;
  const record = {
    url: websocket.url(),
    protocols: websocket.protocols(),
    dropped: dropThisSocket,
    close: null,
    hello: null,
  };
  sockets.push(record);

  websocket.onMessage((message) => {
    server.send(message);
  });
  server.onMessage((message) => {
    websocket.send(message);
    const parsed = parseMessage(message);
    if (parsed?.type !== "hello" || record.hello) return;
    record.hello = parsed;
    if (dropThisSocket) {
      droppedFirstSocket = true;
      firstHello.resolve(parsed);
      setTimeout(() => {
        void websocket.close({ code: 1000, reason: "controlled mounted workspace smoke" });
      }, 50);
      return;
    }
    reconnectHello.resolve(parsed);
  });
  server.onClose((code, reason) => {
    record.close = { code: code ?? null, reason: reason ?? null };
  });
});

try {
  await page.goto(workspaceUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByRole("button", { name: "Save Project", exact: true }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
  const mainContent = page.locator("#fm-main-content").first();
  await mainContent.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelector("#fm-main-content")?.classList.contains("fm-workspace-body"),
    { timeout: 30_000 },
  );
  const mainHandle = await mainContent.elementHandle();
  assert(mainHandle, "mounted workspace did not expose a stable main element");
  const canvasHandle = await page.locator("canvas").first().elementHandle();
  assert(canvasHandle, "mounted workspace did not expose a viewport canvas");
  const canvasBefore = await page.locator("canvas").first().evaluate((canvas) => ({
    width: canvas.width,
    height: canvas.height,
    contextLost: typeof canvas.getContext === "function" &&
      Boolean(canvas.getContext("webgl2")?.isContextLost?.()),
  }));
  assert(canvasBefore.width > 0 && canvasBefore.height > 0, "viewport canvas drawing buffer is empty before reconnect");
  assert(!canvasBefore.contextLost, "viewport WebGL context is lost before reconnect");

  const first = await firstHello.promise;
  const reconnected = await reconnectHello.promise;
  await page.waitForTimeout(500);

  const mainNodeSame = await mainHandle.evaluate(
    (element) => element === document.querySelector("#fm-main-content"),
  );
  const canvasNodeSame = await canvasHandle.evaluate(
    (element) => element === document.querySelector("canvas"),
  );
  const canvasAfter = await page.locator("canvas").first().evaluate((canvas) => ({
    width: canvas.width,
    height: canvas.height,
    contextLost: typeof canvas.getContext === "function" &&
      Boolean(canvas.getContext("webgl2")?.isContextLost?.()),
  }));
  const workspaceState = await mainContent.getAttribute("data-state");
  const reconnectUrl = sockets.find((socket) => !socket.dropped)?.url ?? "";
  const reconnectAfterSeq = new URL(reconnectUrl || workspaceUrl).searchParams.get("after_seq");

  assert(sockets.length >= 2, `expected a reconnect socket, observed ${sockets.length}`);
  assert(first.session_id && first.session_id === reconnected.session_id, "reconnect changed the session identity");
  assert(reconnectAfterSeq === String(first.seq), `reconnect did not carry after_seq=${first.seq}`);
  assert(mainNodeSame, "workspace main DOM node was remounted after reconnect");
  assert(canvasNodeSame, "viewport canvas DOM node was remounted after reconnect");
  assert(canvasAfter.width > 0 && canvasAfter.height > 0, "viewport canvas drawing buffer is empty after reconnect");
  assert(!canvasAfter.contextLost, "viewport WebGL context is lost after reconnect");
  assert(workspaceState !== "session-error" && workspaceState !== "no-session", "workspace left the active session after reconnect");

  const idle404Counts = new Map();
  const unexpectedHttpErrors = [];
  for (const error of httpErrors) {
    const maxCount = error.status === 404 ? expectedIdle404MaxCounts.get(error.path) : undefined;
    if (maxCount === undefined) {
      unexpectedHttpErrors.push(error);
      continue;
    }
    const count = (idle404Counts.get(error.path) ?? 0) + 1;
    idle404Counts.set(error.path, count);
    if (count > maxCount) unexpectedHttpErrors.push(error);
  }
  assert(unexpectedHttpErrors.length === 0, `unexpected browser HTTP errors: ${JSON.stringify(unexpectedHttpErrors)}`);
  const unexpectedConsoleErrors = consoleErrors.filter(
    (message) => !/favicon|409 Conflict|404/i.test(message),
  );
  assert(unexpectedConsoleErrors.length === 0, `unexpected browser errors: ${JSON.stringify(unexpectedConsoleErrors)}`);

  const report = {
    state: "passed",
    scope: "browser-mounted-workspace-reconnect",
    workspace_url: workspaceUrl,
    realtime_path: realtimePath,
    socket_count: sockets.length,
    first_hello: {
      session_id: first.session_id,
      seq: first.seq,
      current_seq: first.payload?.current_seq ?? null,
    },
    reconnect_hello: {
      session_id: reconnected.session_id,
      seq: reconnected.seq,
      current_seq: reconnected.payload?.current_seq ?? null,
      after_seq: reconnectAfterSeq,
    },
    same_session: first.session_id === reconnected.session_id,
    mounted_workspace_node_same: mainNodeSame,
    mounted_canvas_node_same: canvasNodeSame,
    canvas_before: canvasBefore,
    canvas_after: canvasAfter,
    workspace_state_after_reconnect: workspaceState,
    expected_idle_404_max_counts: Object.fromEntries(expectedIdle404MaxCounts),
    http_errors: httpErrors,
    console_errors: consoleErrors,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
