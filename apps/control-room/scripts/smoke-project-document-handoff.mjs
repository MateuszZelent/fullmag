import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const HANDOFF_SCHEMA = "fullmag.project-document-development-handoff.v1";
const workspaceUrl =
  process.env.CONTROL_ROOM_URL ?? "http://localhost:3251/project-document-handoff";
const storageRoot = process.env.FULLMAG_PROJECT_STORAGE_ROOT;
const configuredReportDirectory = process.env.FULLMAG_PROJECT_DOCUMENT_REPORT_DIR;
if (!storageRoot || !isAbsolute(storageRoot) || !configuredReportDirectory || !isAbsolute(configuredReportDirectory)) {
  throw new Error("Managed absolute storage and project document report paths are required.");
}
const reportDirectory = resolve(configuredReportDirectory);
const reportRelative = relative(resolve(storageRoot), reportDirectory);
if (!reportRelative || reportRelative === ".." || reportRelative.startsWith(`..${sep}`) || isAbsolute(reportRelative)) {
  throw new Error("Project document reports must be descendants of managed storage.");
}
const reportPath = resolve(reportDirectory, "project-document-handoff.json");
const screenshotPath = resolve(reportDirectory, "project-document-handoff.png");
const timeoutMs = Number(
  process.env.FULLMAG_PROJECT_DOCUMENT_SMOKE_TIMEOUT_MS ?? 60_000,
);

function assertCondition(condition, message) {
  assert.ok(condition, message);
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

async function writeReport(report) {
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function main() {
  await mkdir(reportDirectory, { recursive: true });
  const startedAt = new Date().toISOString();
  const channel = process.env.FULLMAG_PROJECT_DOCUMENT_BROWSER_CHANNEL;
  const pageErrors = [];
  const consoleErrors = [];
  let browser = null;
  let page = null;
  let result = null;
  let failure = null;

  try {
    const playwright = await loadPlaywright();
    if (!playwright?.chromium) {
      throw new Error(
        "Project document handoff smoke requires Playwright or @playwright/test.",
      );
    }
    if (channel && !["chrome", "msedge"].includes(channel)) {
      throw new Error(`Unsupported project document browser channel: ${channel}`);
    }

    browser = await playwright.chromium.launch({
      headless: true,
      ...(channel ? { channel } : {}),
    });
    page = await browser.newPage({
      acceptDownloads: false,
      viewport: { height: 900, width: 1280 },
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
        consoleErrors.push(message.text());
      }
    });

    await page.goto(workspaceUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await page
      .locator('[data-project-document-handoff-fixture="true"]')
      .waitFor({ state: "visible", timeout: timeoutMs });
    await page.waitForFunction(
      () => typeof window.__projectDocumentHandoffChecks === "function",
      undefined,
      { timeout: timeoutMs },
    );
    result = await page.evaluate(async () => {
      const checks = window.__projectDocumentHandoffChecks;
      if (typeof checks !== "function") {
        throw new Error("Project document handoff checks are not installed.");
      }
      return await checks();
    });

    assertCondition(result && typeof result === "object", "Fixture returned no report.");
    assertCondition(result.schema === HANDOFF_SCHEMA, "Fixture returned the wrong handoff schema.");
    assertCondition(result.fixture_only === true, "Fixture did not identify itself as fixture-only.");
    assertCondition(
      result.actual_backend_runtime === false,
      "Fixture incorrectly claimed backend runtime coverage.",
    );
    assertCondition(result.status === "passed", "Project document handoff checks failed.");
    assertCondition(
      result.total_checks > 0 && result.passed_checks === result.total_checks,
      "Project document handoff did not pass every check.",
    );
    await page.locator("[data-new-problem-open]").click();
    const dialog = page.getByRole("dialog", { name: "New Problem", exact: true });
    await dialog.waitFor({ state: "visible" });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => window.__newProblemFixture.read()),
      { apiCalls: 0, historyClears: 0, dirty: true }, "Cancelling New Problem changed draft/history");
    await page.locator("[data-new-problem-open]").click();
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await dialog.getByRole("alert").waitFor({ state: "visible" });
    assert.deepEqual(await page.evaluate(() => window.__newProblemFixture.read()),
      { apiCalls: 0, historyClears: 0, dirty: true }, "Dirty draft reached session replacement");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator("[data-new-problem-clean]").click();
    await page.locator("[data-new-problem-open]").click();
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await page.waitForFunction(() => window.__newProblemFixture.read().apiCalls === 1);
    await page.keyboard.press("Escape");
    assertCondition(await dialog.isVisible(), "Pending session create allowed the modal to close");
    await page.evaluate(() => window.__newProblemFixture.failRequest());
    await dialog.getByRole("alert").waitFor({ state: "visible" });
    assert.deepEqual(await page.evaluate(() => window.__newProblemFixture.read()),
      { apiCalls: 1, historyClears: 0, dirty: false }, "Failed session create cleared history or retried");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    result.checks.push({ name: "production New Problem modal preserves drafts on Cancel and failure and stays open while pending", status: "passed" });
    result.total_checks += 1;
    result.passed_checks += 1;
    assertCondition(pageErrors.length === 0, `Browser page errors: ${pageErrors.join(" | ")}`);
    assertCondition(
      consoleErrors.length === 0,
      `Browser console errors: ${consoleErrors.join(" | ")}`,
    );
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  if (page) {
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failure = failure ? `${failure}; screenshot: ${message}` : `screenshot: ${message}`;
    }
  }
  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failure = failure ? `${failure}; browser close: ${message}` : `browser close: ${message}`;
    }
  }

  const report = {
    schema: "fullmag_project_document_browser_fixture_v1",
    handoff_schema: HANDOFF_SCHEMA,
    state: failure ? "failed" : "passed",
    qualification: "fixture_only_not_backend_runtime_or_science",
    unit_tests: "not_compiled_not_run",
    fixture_only: true,
    actual_backend_runtime: false,
    url: workspaceUrl,
    browser_channel: channel ?? "playwright_chromium",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    page_errors: pageErrors,
    console_errors: consoleErrors,
    screenshot: screenshotPath,
    result,
    error: failure,
  };
  await writeReport(report);

  if (failure) {
    console.error(JSON.stringify({ report: reportPath, state: "failed", error: failure }, null, 2));
    return 1;
  }
  console.log(JSON.stringify({ report: reportPath, screenshot: screenshotPath, state: "passed" }, null, 2));
  return 0;
}

process.exitCode = await main();
