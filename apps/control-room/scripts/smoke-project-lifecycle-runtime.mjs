import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isForbiddenRuntimeMutation } from "./project-lifecycle-request-policy.mjs";

const workspaceUrl = process.env.CONTROL_ROOM_URL ?? "http://localhost:3104/workspace";
const sessionMode = process.env.CONTROL_ROOM_PROJECT_SESSION_MODE ?? "active";
const browserChannel = process.env.CONTROL_ROOM_PROJECT_BROWSER_CHANNEL;
let apiBase = process.env.CONTROL_ROOM_API_BASE;
const outputDir = resolve(
  process.cwd(),
  process.env.CONTROL_ROOM_PROJECT_RUNTIME_REPORT_DIR ?? ".fullmag/reports/project-lifecycle-runtime-browser",
);

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

async function readDownload(download) {
  const stream = await download.createReadStream();
  assert(stream, "browser download did not expose a readable stream");
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function waitForStatus(page, status, expected) {
  await status.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(
    ({ selector, expectedText }) => document.querySelector(selector)?.textContent?.trim() === expectedText,
    { selector: "[data-project-document-state]", expectedText: expected },
    { timeout: 30_000 },
  );
}

async function clickFileCommand(page, label) {
  await page.getByRole("button", { name: "File", exact: true }).click();
  // Radix includes the keyboard shortcut in the accessible name (for example
  // `New ProjectCtrl+Shift+N`), so match the command label as a prefix.
  const command = page.getByRole("menuitem", { name: label }).last();
  await command.waitFor({ state: "visible", timeout: 10_000 });
  assert(!(await command.isDisabled()), `${label} must be enabled in the active workspace.`);
  await command.click();
}

const requests = [];
const currentSessionRequests = [];
const currentSessionWebSocketRequests = [];
const forbiddenRuntimeRequests = [];
const consoleErrors = [];
const pageErrors = [];
const httpErrors = [];
const screenshots = [];
const expectedIdle404MaxCounts = new Map([
  ["/v2/sessions/current/simulation/preparation", 2],
  ["/v2/sessions/current/simulation/runs/current", 1],
]);
const reportPath = resolve(outputDir, "report.json");
let browser;
let state = "running";
let phase = "playwright_setup";
let failedPhase = null;
let stack = null;
let firstDownloadName = null;
let secondDownloadName = null;
let archiveBytes = null;
let byteRoundtrip = null;
let closeProject = null;

function recordFailure(error, failurePhase = phase) {
  state = "failed";
  failedPhase ??= failurePhase;
  const errorStack = error instanceof Error ? error.stack ?? error.message : String(error);
  stack = stack ? stack + "\n\n" + failurePhase + ":\n" + errorStack : errorStack;
}

function isCurrentSessionPath(path) {
  return path === "/v2/sessions/current" || path.startsWith("/v2/sessions/current/");
}

function buildReport() {
  return {
    state,
    phase,
    failed_phase: failedPhase,
    stack,
    scope: sessionMode === "absent" ? "browser-project-lifecycle-without-runtime-session" : "browser-project-lifecycle-runtime",
    session_mode: sessionMode,
    browser_channel: browserChannel ?? "playwright_chromium",
    screenshots,
    workspace_url: workspaceUrl,
    api_base: apiBase ?? null,
    first_download: firstDownloadName,
    second_download: secondDownloadName,
    archive_bytes: archiveBytes,
    byte_roundtrip: byteRoundtrip,
    close_project: closeProject,
    current_session_requests: currentSessionRequests,
    current_session_websocket_requests: currentSessionWebSocketRequests,
    forbidden_runtime_requests: forbiddenRuntimeRequests,
    expected_idle_404_max_counts: Object.fromEntries(expectedIdle404MaxCounts),
    http_errors: httpErrors,
    page_errors: pageErrors,
    console_errors: consoleErrors,
    requests,
    project_persistence_requests: requests.filter((request) => request.includes("persistence/projects")),
  };
}

try {
  phase = "input_validation";
  assert(
    sessionMode === "active" || sessionMode === "absent",
    `CONTROL_ROOM_PROJECT_SESSION_MODE must be "active" or "absent"; received ${JSON.stringify(sessionMode)}.`,
  );

  if (apiBase === undefined) apiBase = new URL(workspaceUrl).origin;
  apiBase = apiBase.replace(/\/$/, "");

  phase = "playwright_setup";
  await mkdir(outputDir, { recursive: true });
  const playwright = await loadPlaywright();
  assert(playwright?.chromium, "Project runtime lifecycle smoke requires Playwright or @playwright/test.");

  phase = "browser_launch";
  browser = await playwright.chromium.launch({ headless: true, ...(browserChannel ? { channel: browserChannel } : {}) });
  const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1600, height: 900 } });

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  page.on("dialog", async (dialog) => {
    if (dialog.type() === "prompt") {
      await dialog.accept("Untitled project");
      return;
    }
    await dialog.accept();
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    requests.push(method + " " + path);
    if (isCurrentSessionPath(path)) {
      currentSessionRequests.push(method + " " + path);
    }
    if (isForbiddenRuntimeMutation(method, path, sessionMode)) {
      forbiddenRuntimeRequests.push(method + " " + path);
    }
  });
  page.on("websocket", (websocket) => {
    const path = new URL(websocket.url()).pathname;
    if (isCurrentSessionPath(path)) currentSessionWebSocketRequests.push(path);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      const url = new URL(response.url());
      httpErrors.push({ method: response.request().method(), path: url.pathname, status: response.status() });
    }
  });

  await page.addInitScript((controlRoomApiBase) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      allowMissingSessionSmoke: false,
      controlRoomApiBase,
      disableRealtime: false,
    };
  }, apiBase);

  phase = "workspace_load";
  await page.goto(workspaceUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const status = page.locator("[data-project-document-state]").first();
  await status.waitFor({ state: "visible", timeout: 30_000 });
  if (sessionMode === "active") {
    // Wait for the session-only Save Project quick action before exercising
    // persistence against the real API.
    await page.getByRole("button", { name: "Save Project", exact: true }).waitFor({
      state: "visible",
      timeout: 30_000,
    });
  } else {
    await page.locator('[data-state="no-session"]').first().waitFor({
      state: "visible",
      timeout: 30_000,
    });
    assert(
      !(await page.getByRole("button", { name: "Save Project", exact: true }).first().isVisible()),
      "The session-only Save Project quick action must not appear before New in absent-session mode.",
    );
  }

  phase = "new_project";
  await clickFileCommand(page, "New Project");
  await waitForStatus(page, status, "Untitled project · unsaved");
  if (sessionMode === "absent") {
    await page.locator('[data-project-workspace-session-state="no-session"]').waitFor({
      state: "visible",
      timeout: 30_000,
    });
    assert(
      (await page.locator(".fm-simulation-startup").count()) === 0,
      "Simulation preparation status must not mount without a runtime session.",
    );
    assert(
      (await page.locator("canvas").count()) === 0,
      "A runtime canvas must not mount without a runtime session.",
    );
  }

  phase = "first_save";
  const newProjectScreenshot = resolve(outputDir, "new-project.png");
  await page.screenshot({ path: newProjectScreenshot, fullPage: true });
  screenshots.push(newProjectScreenshot);
  const firstDownloadPromise = page.waitForEvent("download");
  await clickFileCommand(page, "Save Project");
  const firstDownload = await firstDownloadPromise;
  firstDownloadName = firstDownload.suggestedFilename();
  const firstBytes = await readDownload(firstDownload);
  archiveBytes = firstBytes.length;
  assert(firstBytes.length > 4, `New project download is unexpectedly short: ${firstBytes.length}`);
  assert(firstDownloadName === "untitled-project.fms", `Unexpected New project filename: ${firstDownloadName}`);

  phase = "open_project";
  const fileChooserPromise = page.waitForEvent("filechooser");
  await clickFileCommand(page, "Open Project");
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: "roundtrip.fms",
    mimeType: "application/zip",
    buffer: firstBytes,
  });
  await waitForStatus(page, status, "Untitled project");

  phase = "second_save";
  const secondDownloadPromise = page.waitForEvent("download");
  await clickFileCommand(page, "Save Project");
  const secondDownload = await secondDownloadPromise;
  secondDownloadName = secondDownload.suggestedFilename();
  const secondBytes = await readDownload(secondDownload);
  byteRoundtrip = secondBytes.equals(firstBytes);
  assert(byteRoundtrip, "Browser Open/Save changed the archive bytes.");
  assert(secondDownloadName === "roundtrip.fms", `Unexpected Open project filename: ${secondDownloadName}`);
  const reopenedScreenshot = resolve(outputDir, "reopened-project.png");
  await page.screenshot({ path: reopenedScreenshot, fullPage: true });
  screenshots.push(reopenedScreenshot);

  phase = "close_project";
  await clickFileCommand(page, "Close Project");
  await waitForStatus(page, status, "No project");
  closeProject = "verified";
  if (sessionMode === "absent") {
    await page.locator('[data-state="no-session"]').first().waitFor({
      state: "visible",
      timeout: 30_000,
    });
    assert(
      !(await page.getByRole("button", { name: "Save Project", exact: true }).first().isVisible()),
      "Closing the project must return to no-session authoring without the session-only Save Project action.",
    );
    assert(
      (await page.locator(".fm-simulation-startup").count()) === 0,
      "Simulation preparation status must remain absent after Close.",
    );
    assert(
      (await page.locator("canvas").count()) === 0,
      "A runtime canvas must remain absent after Close.",
    );
  }

  if (sessionMode === "absent") {
    assert(
      currentSessionRequests.length === 0,
      `No-session project lifecycle called current-session HTTP routes: ${JSON.stringify(currentSessionRequests)}`,
    );
    assert(
      currentSessionWebSocketRequests.length === 0,
      `No-session project lifecycle opened a current-session WebSocket: ${JSON.stringify(currentSessionWebSocketRequests)}`,
    );
  }

  const closedScreenshot = resolve(outputDir, "closed-project.png");
  await page.screenshot({ path: closedScreenshot, fullPage: true });
  screenshots.push(closedScreenshot);

  assert(
    forbiddenRuntimeRequests.length === 0,
    `Project lifecycle invoked runtime/solver routes: ${JSON.stringify(forbiddenRuntimeRequests)}`,
  );
  const idle404Counts = new Map();
  const unexpectedHttpErrors = [];
  for (const error of httpErrors) {
    const maxCount =
      error.status === 404 ? expectedIdle404MaxCounts.get(error.path) : undefined;
    if (maxCount === undefined) {
      unexpectedHttpErrors.push(error);
      continue;
    }
    const count = (idle404Counts.get(error.path) ?? 0) + 1;
    idle404Counts.set(error.path, count);
    if (count > maxCount) unexpectedHttpErrors.push(error);
  }
  assert(unexpectedHttpErrors.length === 0, `Unexpected browser HTTP errors: ${JSON.stringify(unexpectedHttpErrors)}`);
  const unexpectedConsoleErrors = consoleErrors.filter(
    (message) =>
      !/favicon|409 Conflict|404/i.test(message),
  );
  assert(unexpectedConsoleErrors.length === 0, `Unexpected browser errors: ${JSON.stringify(unexpectedConsoleErrors)}`);
  assert(pageErrors.length === 0, `Unexpected page errors: ${JSON.stringify(pageErrors)}`);

  state = "passed";
  phase = "complete";
} catch (error) {
  recordFailure(error);
  console.error("Project runtime lifecycle smoke failed during " + failedPhase + ": " + stack);
} finally {
  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      recordFailure(error, "browser_cleanup");
      console.error(
        "Project runtime lifecycle browser cleanup failed: " +
          (error instanceof Error ? error.stack : error),
      );
    }
  }
  if (state === "passed" && pageErrors.length > 0) {
    recordFailure(new Error(`Unexpected page errors: ${JSON.stringify(pageErrors)}`), "page_errors");
  }

  phase = state === "passed" ? "complete" : failedPhase;
  try {
    await mkdir(outputDir, { recursive: true });
    await writeFile(reportPath, JSON.stringify(buildReport(), null, 2) + "\n", "utf8");
  } catch (error) {
    recordFailure(error, "report_write");
    console.error(
      "Project runtime lifecycle report could not be written to " +
        reportPath +
        ": " +
        (error instanceof Error ? error.stack : error),
    );
  }
  console.log(JSON.stringify(buildReport(), null, 2));
  if (state !== "passed") process.exitCode = 1;
}
