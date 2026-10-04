import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const workspaceUrl = process.env.CONTROL_ROOM_URL ?? "http://localhost:3104/workspace";
const apiBase = (process.env.CONTROL_ROOM_API_BASE ?? new URL(workspaceUrl).origin).replace(/\/$/, "");
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

const playwright = await loadPlaywright();
if (!playwright?.chromium) {
  console.error("Project runtime lifecycle smoke requires Playwright or @playwright/test.");
  process.exit(2);
}

await mkdir(outputDir, { recursive: true });
const browser = await playwright.chromium.launch({ headless: true });
const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1600, height: 900 } });
const requests = [];
const forbiddenRuntimeRequests = [];
const consoleErrors = [];
const httpErrors = [];
const expectedIdle404MaxCounts = new Map([
  ["/v2/sessions/current/simulation/preparation", 2],
  ["/v2/sessions/current/simulation/runs/current", 1],
]);
const reportPath = resolve(outputDir, "report.json");

page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(error.stack ?? error.message));
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
  requests.push(`${method} ${path}`);
  if (
    method !== "GET" &&
    (path.includes("/simulation/") ||
      path.includes("/preparation") ||
      path.includes("/meshing/") ||
      path.includes("/restore") ||
      path.includes("/compute") ||
      path.includes("/model/"))
  ) {
    forbiddenRuntimeRequests.push(`${method} ${path}`);
  }
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

try {
  await page.goto(workspaceUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const status = page.locator("[data-project-document-state]").first();
  await status.waitFor({ state: "visible", timeout: 30_000 });
  // The shell first renders its no-session header while the session collection
  // hydrates. Wait for the session-only Save Project quick action before
  // exercising persistence against the real API.
  await page.getByRole("button", { name: "Save Project", exact: true }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await clickFileCommand(page, "New Project");
  await waitForStatus(page, status, "Untitled project · unsaved");

  const firstDownloadPromise = page.waitForEvent("download");
  await clickFileCommand(page, "Save Project");
  const firstDownload = await firstDownloadPromise;
  const firstBytes = await readDownload(firstDownload);
  assert(firstBytes.length > 4, `New project download is unexpectedly short: ${firstBytes.length}`);
  assert(firstDownload.suggestedFilename() === "untitled-project.fms", `Unexpected New project filename: ${firstDownload.suggestedFilename()}`);

  const fileChooserPromise = page.waitForEvent("filechooser");
  await clickFileCommand(page, "Open Project");
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: "roundtrip.fms",
    mimeType: "application/zip",
    buffer: firstBytes,
  });
  await waitForStatus(page, status, "Untitled project");

  const secondDownloadPromise = page.waitForEvent("download");
  await clickFileCommand(page, "Save Project");
  const secondDownload = await secondDownloadPromise;
  const secondBytes = await readDownload(secondDownload);
  assert(secondBytes.equals(firstBytes), "Browser Open/Save changed the archive bytes.");
  assert(secondDownload.suggestedFilename() === "roundtrip.fms", `Unexpected Open project filename: ${secondDownload.suggestedFilename()}`);

  await clickFileCommand(page, "Close Project");
  await waitForStatus(page, status, "No project");

  assert(forbiddenRuntimeRequests.length === 0, `Project lifecycle invoked runtime/solver routes: ${JSON.stringify(forbiddenRuntimeRequests)}`);
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

  const report = {
    state: "passed",
    scope: "browser-project-lifecycle-runtime",
    workspace_url: workspaceUrl,
    api_base: apiBase,
    first_download: firstDownload.suggestedFilename(),
    second_download: secondDownload.suggestedFilename(),
    archive_bytes: firstBytes.length,
    byte_roundtrip: true,
    close_project: "verified",
    forbidden_runtime_requests: forbiddenRuntimeRequests,
    expected_idle_404_max_counts: Object.fromEntries(expectedIdle404MaxCounts),
    http_errors: httpErrors,
    console_errors: consoleErrors,
    requests: requests.filter((request) => request.includes("persistence/projects")),
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
