import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const REPORT_SCHEMA = "fullmag.development-run-outcome-handoff.browser-fixture.v1";
const workspaceUrl =
  process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:3253/development-run-outcome-handoff";
const storageRoot = process.env.FULLMAG_PROJECT_STORAGE_ROOT;
const configuredReportDirectory = process.env.FULLMAG_DEVELOPMENT_RUN_OUTCOME_REPORT_DIR;
if (!storageRoot || !isAbsolute(storageRoot) || !configuredReportDirectory || !isAbsolute(configuredReportDirectory)) {
  throw new Error("Managed absolute storage and development run outcome report paths are required.");
}

const reportDirectory = resolve(configuredReportDirectory);
const reportRelative = relative(resolve(storageRoot), reportDirectory);
if (!reportRelative || reportRelative === ".." || reportRelative.startsWith(`..${sep}`) || isAbsolute(reportRelative)) {
  throw new Error("Development run outcome reports must be descendants of managed storage.");
}

const reportPath = resolve(reportDirectory, "development-run-outcome-handoff.json");
const screenshotPath = resolve(reportDirectory, "development-run-outcome-handoff.png");
const timeoutMs = Number(
  process.env.FULLMAG_DEVELOPMENT_RUN_OUTCOME_SMOKE_TIMEOUT_MS ?? 60_000,
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
  const channel = process.env.FULLMAG_DEVELOPMENT_RUN_OUTCOME_BROWSER_CHANNEL;
  const pageErrors = [];
  const consoleErrors = [];
  let browser = null;
  let page = null;
  let result = null;
  let fixtureDiagnostics = null;
  let failure = null;

  try {
    const playwright = await loadPlaywright();
    if (!playwright?.chromium) {
      throw new Error("Development run outcome handoff smoke requires Playwright or @playwright/test.");
    }
    if (channel && !["chrome", "msedge"].includes(channel)) {
      throw new Error(`Unsupported development run outcome browser channel: ${channel}`);
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

    await page.goto(workspaceUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page
      .locator('[data-development-run-outcome-handoff-fixture="true"]')
      .waitFor({ state: "visible", timeout: timeoutMs });
    await page.waitForFunction(
      () => typeof window.__developmentRunOutcomeHandoffChecks === "function",
      undefined,
      { timeout: timeoutMs },
    );
    result = await page.evaluate(async () => {
      const checks = window.__developmentRunOutcomeHandoffChecks;
      if (typeof checks !== "function") {
        throw new Error("Development run outcome handoff checks are not installed.");
      }
      return await checks();
    });
    fixtureDiagnostics = result?.diagnostics ?? null;

    assertCondition(result && typeof result === "object", "Fixture returned no report.");
    assertCondition(result.schema === REPORT_SCHEMA, "Fixture returned the wrong report schema.");
    assertCondition(result.fixture_only === true, "Fixture did not identify itself as fixture-only.");
    assertCondition(
      typeof result.timing_instrumentation === "string"
        && result.timing_instrumentation.includes("delegates to the original method"),
      "Fixture did not identify its observational timing instrumentation.",
    );
    assertCondition(
      result.actual_backend_runtime === false,
      "Fixture incorrectly claimed backend runtime coverage.",
    );
    assertCondition(result.status === "passed", `Fixture checks failed: ${result.error ?? "unknown error"}`);
    assertCondition(
      result.total_checks > 0 && result.passed_checks === result.total_checks,
      "Development run outcome handoff did not pass every check.",
    );
    assertCondition(pageErrors.length === 0, `Browser page errors: ${pageErrors.join(" | ")}`);
    assertCondition(consoleErrors.length === 0, `Browser console errors: ${consoleErrors.join(" | ")}`);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    if (page && fixtureDiagnostics === null) {
      try {
        fixtureDiagnostics = await page.evaluate(() =>
          window.__developmentRunOutcomeHandoffDiagnostics?.() ?? null,
        );
      } catch {
        fixtureDiagnostics = null;
      }
    }
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
    schema: "fullmag_development_run_outcome_browser_report_v1",
    fixture_schema: REPORT_SCHEMA,
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
    timing_instrumentation:
      result?.timing_instrumentation ?? fixtureDiagnostics?.timing_instrumentation ?? null,
    fixture_diagnostics: fixtureDiagnostics,
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
