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

const playwright = await loadPlaywright();
if (!playwright?.chromium) {
  console.error("Project lifecycle smoke requires Playwright or @playwright/test.");
  process.exit(2);
}

await mkdir(outputDir, { recursive: true });
const browser = await playwright.chromium.launch({ headless: true });
const page = await browser.newPage({ acceptDownloads: true });
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
  const newProject = page.getByRole("button", { name: "New project", exact: true });
  const openProject = page.getByRole("button", { name: "Open project", exact: true });
  const saveProject = page.getByRole("button", { name: "Save project", exact: true });
  await newProject.waitFor({ state: "visible", timeout: 30_000 });
  assert(await saveProject.isDisabled(), "Save project must be disabled before New project.");

  await newProject.click();
  await waitForStatus(page, status, "Untitled project · unsaved");
  assert(!(await saveProject.isDisabled()), "Save project did not enable after New project.");

  const firstDownloadPromise = page.waitForEvent("download");
  await saveProject.click();
  const firstDownload = await firstDownloadPromise;
  assert(
    firstDownload.suggestedFilename() === "untitled-project.fms",
    `Unexpected New project download name: ${firstDownload.suggestedFilename()}`,
  );

  const fileChooserPromise = page.waitForEvent("filechooser");
  await openProject.click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: "roundtrip.fms",
    mimeType: "application/zip",
    buffer: archiveBytes,
  });
  await waitForStatus(page, status, "Roundtrip project");
  assert(openedArchiveBase64 === archiveBase64, "Open did not transport the selected archive bytes.");

  const secondDownloadPromise = page.waitForEvent("download");
  await saveProject.click();
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
