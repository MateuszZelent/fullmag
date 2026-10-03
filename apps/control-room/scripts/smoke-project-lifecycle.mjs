import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const workspaceUrl = process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const outputDir = resolve(
  process.cwd(),
  process.env.CONTROL_ROOM_PROJECT_REPORT_DIR ?? ".fullmag/reports/project-lifecycle-browser",
);
const archiveBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const archiveBase64 = archiveBytes.toString("base64");

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

async function openFileMenuItem(page, label) {
  await page.getByRole("button", { name: "File", exact: true }).click();
  // Radix includes the shortcut in the accessible name (`Save ProjectCtrl+S`),
  // so the label is matched as a prefix rather than exactly.
  const item = page.getByRole("menuitem", { name: new RegExp(`^${label}`) }).last();
  await item.waitFor({ state: "visible", timeout: 10_000 });
  return item;
}

async function fileMenuItemDisabled(page, label) {
  const item = await openFileMenuItem(page, label);
  const disabled = (await item.getAttribute("data-disabled")) !== null
    || (await item.getAttribute("aria-disabled")) === "true";
  await page.keyboard.press("Escape");
  return disabled;
}

async function clickFileCommand(page, label) {
  const item = await openFileMenuItem(page, label);
  await item.click();
}

const playwright = await loadPlaywright();
if (!playwright?.chromium) {
  console.error("Project lifecycle smoke requires Playwright or @playwright/test.");
  process.exit(2);
}

await mkdir(outputDir, { recursive: true });
const browser = await playwright.chromium.launch({ headless: true });
const page = await browser.newPage({ acceptDownloads: true });
// File > New Project asks for a name; accepting the default keeps the download name stable.
page.on("dialog", (dialog) => dialog.accept(dialog.defaultValue()));
const requests = [];
const forbiddenRuntimeRequests = [];
let openedArchiveBase64 = archiveBase64;

await page.addInitScript((apiBase) => {
  window.__FULLMAG_CONFIG__ = {
    ...(window.__FULLMAG_CONFIG__ ?? {}),
    allowMissingSessionSmoke: true,
    controlRoomApiBase: apiBase,
    disableRealtime: true,
  };
}, new URL(workspaceUrl).origin);

await page.route("**/v2/**", async (route) => {
  const request = route.request();
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

  if (method === "GET" && path === "/v2/sessions") {
    await fulfillJson(route, {
      schema_version: "2.0.0",
      sessions: [],
    });
    return;
  }

  if (method === "POST" && path === "/v2/persistence/projects") {
    const body = JSON.parse(request.postData() ?? "{}");
    await fulfillJson(route, projectResource({
      dirty: true,
      name: String(body.name ?? "Untitled project"),
    }), 201);
    return;
  }

  if (method === "POST" && path === "/v2/persistence/projects/open") {
    const body = JSON.parse(request.postData() ?? "{}");
    openedArchiveBase64 = String(body.archive_base64 ?? archiveBase64);
    await fulfillJson(route, projectResource({
      archive_base64: openedArchiveBase64,
      dirty: false,
      name: "Roundtrip project",
    }));
    return;
  }

  await fulfillJson(route, { error: { code: "project_lifecycle_smoke_unhandled", path } }, 404);
});

try {
  await page.goto(workspaceUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

  const status = page.locator('[data-project-document-state]').first();
  const startScreen = page.locator('[data-slot-id="start-screen"]');
  await startScreen.locator('[data-command-id="start.new-fdm"]').waitFor({ state: "visible", timeout: 30_000 });
  for (const commandId of ["start.new-fdm", "start.new-fem", "start.templates", "start.import"]) {
    const tile = startScreen.locator(`[data-command-id="${commandId}"]`);
    assert((await tile.count()) === 1, `Start screen launch tile ${commandId} is missing.`);
  }
  assert(
    (await startScreen.getByRole("button", { name: /save project/i }).count()) === 0,
    "The start screen must not offer Save Project without a session.",
  );
  assert(
    await fileMenuItemDisabled(page, "Save Project"),
    "Save Project must be disabled before New Project.",
  );

  await clickFileCommand(page, "New Project");
  await waitForStatus(page, status, "Untitled project · unsaved");
  assert(
    !(await fileMenuItemDisabled(page, "Save Project")),
    "Save Project did not enable after New Project.",
  );

  const firstDownloadPromise = page.waitForEvent("download");
  await clickFileCommand(page, "Save Project");
  const firstDownload = await firstDownloadPromise;
  assert(
    firstDownload.suggestedFilename() === "untitled-project.fms",
    `Unexpected New project download name: ${firstDownload.suggestedFilename()}`,
  );

  const fileChooserPromise = page.waitForEvent("filechooser");
  await startScreen.locator('[data-command-id="start.browse"]').click({ timeout: 10_000 });
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: "roundtrip.fms",
    mimeType: "application/zip",
    buffer: archiveBytes,
  });
  await waitForStatus(page, status, "Roundtrip project");
  assert(openedArchiveBase64 === archiveBase64, "Open did not transport the selected archive bytes.");

  const secondDownloadPromise = page.waitForEvent("download");
  await clickFileCommand(page, "Save Project");
  const secondDownload = await secondDownloadPromise;
  assert(
    secondDownload.suggestedFilename() === "roundtrip.fms",
    `Unexpected Open project download name: ${secondDownload.suggestedFilename()}`,
  );
  const fileMenu = page.getByRole("button", { name: "File", exact: true });
  await fileMenu.click();
  const closeProject = page.getByRole("menuitem", {
    name: "Close Project",
  });
  const closeProjectCount = await closeProject.count();
  const closeProjectDisabled = closeProjectCount > 0 ? await closeProject.isDisabled() : null;
  assert(
    closeProjectCount === 1 && !closeProjectDisabled,
    `Close Project must be available after Open (count=${closeProjectCount}, disabled=${closeProjectDisabled}, status=${await status.textContent()}, menus=${await page.locator('[role="menu"]').allTextContents()}).`,
  );
  await closeProject.click();
  await waitForStatus(page, status, "No project");
  assert(
    forbiddenRuntimeRequests.length === 0,
    `Project lifecycle invoked runtime/solver routes: ${JSON.stringify(forbiddenRuntimeRequests)}`,
  );

  console.log(JSON.stringify({
    first_download: firstDownload.suggestedFilename(),
    close_project: "verified",
    forbidden_runtime_requests: forbiddenRuntimeRequests,
    open_archive_bytes: archiveBytes.length,
    project_lifecycle: "verified; new/open/save/close without runtime",
    requests: requests.filter((request) => request.includes("persistence/projects")),
    second_download: secondDownload.suggestedFilename(),
  }, null, 2));
} finally {
  await browser.close();
}

function projectResource({
  archive_base64 = archiveBase64,
  dirty,
  name,
}) {
  return {
    archive_base64,
    dirty,
    durability: "memory_only",
    migration: {
      can_write: true,
      migrated: false,
      preserved_paths: [],
      source_schema: "fullmag.project.v1",
      target_schema: "fullmag.project.v1",
      warnings: [],
    },
    mode: { kind: "read_write" },
    name,
    persisted_revision: 0,
    project_id: "project-browser-lifecycle",
    revision: 0,
    schema_version: "fullmag.project.v1",
    source_hash: "sha256:browser-lifecycle",
  };
}

async function fulfillJson(route, body, status = 200) {
  await route.fulfill({
    body: JSON.stringify(body),
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": "*",
      "x-api-contract-version": "1.0.0",
    },
    status,
  });
}

async function waitForStatus(page, locator, expected) {
  await locator.waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForFunction(
    (value) => document.querySelector('[data-project-document-state]')?.textContent?.trim() === value,
    expected,
    { timeout: 10_000 },
  );
}
