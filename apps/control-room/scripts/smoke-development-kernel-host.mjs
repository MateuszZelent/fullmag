import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const FIXTURE_SCHEMA = "fullmag.development-kernel-host.browser-fixture.v1";
const OLD_API_PIN = "11111111-1111-4111-8111-111111111111";
const NEW_API_PIN = "22222222-2222-4222-8222-222222222222";
const configuredUrl = new URL(
  process.env.CONTROL_ROOM_URL ?? "http://localhost:3252/development-kernel-host",
);
configuredUrl.searchParams.set("fullmag_api_instance", OLD_API_PIN);
const workspaceUrl = configuredUrl.href;
const storageRoot = process.env.FULLMAG_PROJECT_STORAGE_ROOT;
const configuredReportDirectory = process.env.FULLMAG_PROJECT_DOCUMENT_REPORT_DIR;
if (!storageRoot || !isAbsolute(storageRoot)
  || !configuredReportDirectory || !isAbsolute(configuredReportDirectory)) {
  throw new Error("Managed absolute storage and development kernel report paths are required.");
}
const reportDirectory = resolve(configuredReportDirectory);
const reportRelative = relative(resolve(storageRoot), reportDirectory);
if (!reportRelative || reportRelative === ".." || reportRelative.startsWith(`..${sep}`)
  || isAbsolute(reportRelative)) {
  throw new Error("Development kernel reports must be descendants of managed storage.");
}
const reportPath = resolve(reportDirectory, "development-kernel-host.json");
const screenshotPath = resolve(reportDirectory, "development-kernel-host.png");
const timeoutMs = Number(process.env.FULLMAG_PROJECT_DOCUMENT_SMOKE_TIMEOUT_MS ?? 60_000);

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
  let failureDiagnostics = null;

  try {
    const playwright = await loadPlaywright();
    if (!playwright?.chromium) {
      throw new Error("Development kernel host smoke requires Playwright or @playwright/test.");
    }
    if (channel && !["chrome", "msedge"].includes(channel)) {
      throw new Error(`Unsupported development kernel browser channel: ${channel}`);
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
    await page.locator('[data-development-kernel-host-fixture="true"]')
      .waitFor({ state: "visible", timeout: timeoutMs });
    await page.waitForFunction(
      () => typeof window.__developmentKernelHostFixture?.read === "function",
      undefined,
      { timeout: timeoutMs },
    );
    await page.waitForFunction(
      () => typeof window.__developmentKernelHostChecks === "function",
      undefined,
      { timeout: timeoutMs },
    );
    await page.waitForFunction(
      ({ oldPin }) => {
        const fixture = window.__developmentKernelHostFixture;
        if (!fixture) return false;
        const snapshot = fixture.read();
        return snapshot.apiInstance === oldPin
          && snapshot.resourceStatus === "stale"
          && snapshot.resourceMarker === "seeded-old-resource"
          && fixture.networkSnapshot().oldHealthRequestCount > 0;
      },
      { oldPin: OLD_API_PIN },
      { timeout: timeoutMs },
    );

    await page.evaluate(() => window.__developmentKernelHostFixture.releaseOldHealth());
    await page.waitForFunction(
      ({ oldHealthMarker }) => {
        const snapshot = window.__developmentKernelHostFixture?.read();
        return snapshot?.resourceMarker === oldHealthMarker
          && snapshot.selectorValue === `ready:${oldHealthMarker}`;
      },
      { oldHealthMarker: "old-client-health" },
      { timeout: timeoutMs },
    );

    const draft = page.locator("[data-workspace-draft]");
    await draft.fill("browser-local-draft");
    const beforeCapture = await page.evaluate(() => window.__developmentKernelHostFixture.read());
    assertCondition(beforeCapture.apiInstance === OLD_API_PIN, "Initial kernel did not retain its URL pin.");
    assertCondition(beforeCapture.resourceMarker === "old-client-health", "Old client resource did not settle before capture.");

    const capture = await page.evaluate(async () => window.__developmentKernelHostFixture.capture());
    assertCondition(capture.session_id === null && capture.session_epoch === 0,
      "Empty workspace capture did not retain the exact null-session epoch.");
    const oldCacheBeforeHandoff = await page.evaluate(() =>
      window.__developmentKernelHostBridge?.oldCacheMarkerAtCapture ?? null);
    assertCondition(oldCacheBeforeHandoff === "old-client-health",
      "Old scoped resource cache did not contain the settled client response before handoff.");
    await page.waitForFunction(() => {
      const snapshot = window.__developmentKernelHostFixture?.read();
      return snapshot?.paused === true && snapshot.boundaryInert === true;
    }, undefined, { timeout: timeoutMs });

    try {
      await draft.click({ timeout: 1_000 });
      await page.keyboard.type("-blocked");
    } catch {
      // Inert input can reject the click; the fixture also checks input events and value.
    }
    const pausedInput = await page.evaluate(() =>
      window.__developmentKernelHostFixture.recordPausedInputAttempt());
    assertCondition(pausedInput.inert && pausedInput.draftPreserved
      && pausedInput.inputBlocked && pausedInput.mountRetained,
    "Paused input changed or unmounted the workspace draft.");

    const pausedApi = await page.evaluate(async () =>
      window.__developmentKernelHostFixture.exercisePaused());
    assertCondition(pausedApi.commandStatus === "failed"
      && pausedApi.apiErrorCode === "DEVELOPMENT_TRANSPORT_PAUSED"
      && pausedApi.noNetworkRequest && pausedApi.wasPaused,
    "Command or ordinary API traffic escaped the paused transport boundary.");

    const hydrated = await page.evaluate(async () =>
      window.__developmentKernelHostFixture.hydrate());
    assertCondition(hydrated.apiInstance === NEW_API_PIN && hydrated.generation === beforeCapture.generation + 1,
      "Replacement kernel did not mount at the next provider generation.");
    assertCondition(hydrated.mountId !== beforeCapture.mountId && !hydrated.paused,
      "Replacement did not remount and release the input boundary after acknowledgement.");
    assertCondition(hydrated.publicationError === null, "Replacement passive-effect publication reported an error.");
    assertCondition(new URL(workspaceUrl).searchParams.get("fullmag_api_instance") === OLD_API_PIN,
      "Smoke input URL did not carry its original API pin.");
    await page.waitForFunction(
      ({ newPin }) => {
        const fixture = window.__developmentKernelHostFixture;
        return fixture?.networkSnapshot().newHealthRequestCount > 0
          && fixture.read().apiInstance === newPin;
      },
      { newPin: NEW_API_PIN },
      { timeout: timeoutMs },
    );
    await page.waitForFunction(
      () => Boolean(window.__developmentKernelHostBridge?.replacementPauseEvidence),
      undefined,
      { timeout: timeoutMs },
    );
    const replacementPause = await page.evaluate(() =>
      window.__developmentKernelHostBridge?.replacementPauseEvidence ?? null);
    assertCondition(replacementPause?.commandStatus === "failed"
      && replacementPause.apiErrorCode === "DEVELOPMENT_TRANSPORT_PAUSED"
      && replacementPause.noNetworkRequest && replacementPause.wasPaused,
    "Fresh replacement command or API read escaped its pre-acknowledgement pause.");
    const newScopeBeforeResolve = await page.evaluate(() => window.__developmentKernelHostFixture.read());
    assertCondition(newScopeBeforeResolve.resourceMarker === null
      && newScopeBeforeResolve.selectorValue !== "ready:old-client-health"
      && newScopeBeforeResolve.oldCacheMarker === null
      && newScopeBeforeResolve.newCacheMarker === null,
    "Fresh resource hooks observed the old client's cached health data.");
    assertCondition(new URL(page.url()).searchParams.get("fullmag_api_instance") === NEW_API_PIN,
      "Passive-effect acknowledgement did not replace the navigation pin.");

    await page.evaluate(() => window.__developmentKernelHostFixture.releaseLease());
    const retired = await page.evaluate(async () =>
      window.__developmentKernelHostFixture.probeOldTransportRetirement());
    assertCondition(retired.code === "DEVELOPMENT_TRANSPORT_RETIRED" && retired.networkUnchanged,
      "The old API client was not retired after idempotent lease release.");

    await page.evaluate(() => window.__developmentKernelHostFixture.releaseNewHealth());
    await page.waitForFunction(() => {
      const snapshot = window.__developmentKernelHostFixture?.read();
      return snapshot?.resourceMarker === "new-client-health"
        && snapshot.selectorValue === "ready:new-client-health"
        && snapshot.oldCacheMarker === null
        && snapshot.newCacheMarker === "new-client-health";
    }, undefined, { timeout: timeoutMs });

    result = await page.evaluate(async () => {
      const checks = window.__developmentKernelHostChecks;
      if (typeof checks !== "function") {
        throw new Error("Development kernel host checks are not installed.");
      }
      return checks();
    });
    assertCondition(result && typeof result === "object", "Fixture returned no report.");
    assertCondition(result.schema === FIXTURE_SCHEMA, "Fixture returned the wrong schema.");
    assertCondition(result.fixture_only === true, "Fixture did not identify itself as fixture-only.");
    assertCondition(result.actual_backend_runtime === false,
      "Fixture incorrectly claimed backend runtime coverage.");
    assertCondition(result.status === "passed", "Development kernel host checks failed.");
    assertCondition(result.total_checks > 0 && result.passed_checks === result.total_checks,
      "Development kernel host did not pass every check.");
    assertCondition(result.evidence?.captured_session_id === null
      && result.evidence?.captured_session_epoch === 0,
    "Fixture report did not retain the empty session identity.");
    assertCondition(pageErrors.length === 0, `Browser page errors: ${pageErrors.join(" | ")}`);
    assertCondition(consoleErrors.length === 0,
      `Browser console errors: ${consoleErrors.join(" | ")}`);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    if (page) {
      try {
        failureDiagnostics = await page.evaluate(async () => {
          const fixture = window.__developmentKernelHostFixture;
          const bridge = window.__developmentKernelHostBridge;
          if (!fixture || !bridge) {
            return { fixture_available: Boolean(fixture), bridge_available: Boolean(bridge) };
          }
          let snapshot = null;
          let fixtureChecks = null;
          let snapshotError = null;
          try { snapshot = fixture.read(); }
          catch (readError) { snapshotError = readError instanceof Error ? readError.message : String(readError); }
          try { fixtureChecks = await fixture.checks(); }
          catch (checkError) { snapshotError = checkError instanceof Error ? checkError.message : String(checkError); }
          return {
            snapshot,
            network: fixture.networkSnapshot(),
            checks: fixtureChecks,
            lifecycle: {
              old_scope: bridge.oldScope,
              old_cache_marker_before_handoff: bridge.oldCacheMarkerAtCapture,
              hydrate_snapshot: bridge.hydrateResult,
              layout_restoration: bridge.layoutRestorationEvidence,
              current_layout: bridge.activeKernel?.layout.get() ?? null,
              captured_identity: bridge.captured
                ? { session_id: bridge.captured.sessionId, session_epoch: bridge.captured.sessionEpoch }
                : null,
              capture_result: bridge.captureResult,
              paused_input: bridge.pausedInputEvidence,
              paused_api: bridge.pausedApiEvidence,
              replacement_pause: bridge.replacementPauseEvidence,
              hydrated: bridge.hydrated,
              released: bridge.released,
              retired_transport_code: bridge.retiredTransportCode,
            },
            snapshot_error: snapshotError,
          };
        });
      } catch (diagnosticError) {
        const message = diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError);
        failureDiagnostics = { capture_error: message };
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
    schema: "fullmag_development_kernel_host_browser_fixture_v1",
    fixture_schema: FIXTURE_SCHEMA,
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
    failure_diagnostics: failureDiagnostics,
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
