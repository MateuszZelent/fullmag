import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const url = new URL(process.env.CONTROL_ROOM_URL ?? "http://localhost:3254/development-restart-action");
url.searchParams.set("fullmag_api_instance", "11111111-1111-4111-8111-111111111111");
const storageRoot = process.env.FULLMAG_PROJECT_STORAGE_ROOT;
const reportDirectory = process.env.FULLMAG_DEVELOPMENT_RESTART_ACTION_REPORT_DIR;
if (!storageRoot || !isAbsolute(storageRoot) || !reportDirectory || !isAbsolute(reportDirectory)) {
  throw new Error("Managed absolute storage and restart action report paths are required.");
}
const reportRoot = resolve(reportDirectory);
const descendant = relative(resolve(storageRoot), reportRoot);
if (!descendant || descendant === ".." || descendant.startsWith(`..${sep}`) || isAbsolute(descendant)) {
  throw new Error("Restart action reports must stay below managed storage.");
}
const reportPath = resolve(reportRoot, "development-restart-action.json");
const screenshotPath = resolve(reportRoot, "development-restart-action.png");

async function loadPlaywright() {
  try { return await import("playwright"); }
  catch { return await import("@playwright/test"); }
}

async function main() {
  const checks = [];
  const pageErrors = [];
  const consoleErrors = [];
  const evidence = {};
  let browser;
  let page;
  let failure;
  const startedAt = new Date().toISOString();
  const check = (name, assertion) => {
    assertion();
    checks.push({ name, status: "passed" });
  };
  try {
    const { chromium } = await loadPlaywright();
    const channel = process.env.FULLMAG_DEVELOPMENT_RESTART_ACTION_BROWSER_CHANNEL;
    if (channel && !["chrome", "msedge"].includes(channel)) throw new Error("Unsupported browser channel");
    browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: false });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) consoleErrors.push(message.text());
    });
    page.setDefaultTimeout(60_000);
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.locator("[data-development-restart-action-fixture]").waitFor({ state: "visible" });
    await page.waitForFunction(() => window.__developmentRestartActionFixture?.read().pin !== null);
    const banner = page.locator("[data-development-backend-state]");
    await banner.waitFor({ state: "visible" });
    const unavailableButtonCount = await page.getByRole("button", { name: "Restart backend", exact: true }).count();
    const unavailable = await page.evaluate(() => window.__developmentRestartActionFixture.read());
    check("unavailable capability cannot submit", () => {
      assert.equal(unavailableButtonCount, 0);
      assert.equal(unavailable.posts.length, 0);
    });

    await page.evaluate(() => window.__developmentRestartActionFixture.setMode("ready"));
    const restartButton = page.getByRole("button", { name: "Restart backend", exact: true });
    await restartButton.waitFor({ state: "visible" });
    const readyEnabled = await restartButton.isEnabled();
    const ready = await page.evaluate(() => window.__developmentRestartActionFixture.read());
    check("ready build waits for an explicit click", () => {
      assert.equal(readyEnabled, true);
      assert.equal(ready.posts.length, 0);
    });

    await page.evaluate(() => window.__developmentRestartActionFixture.beginHeldRefresh());
    await page.waitForFunction(() => window.__developmentRestartActionFixture.read().heldReads > 0);
    await restartButton.waitFor({ state: "hidden" });
    const stale = await page.evaluate(() => window.__developmentRestartActionFixture.read());
    check("stale resource suppresses the restart action", () => { assert.equal(stale.posts.length, 0); });
    await page.evaluate(() => window.__developmentRestartActionFixture.releaseHeldRefresh());
    await restartButton.waitFor({ state: "visible" });

    await page.evaluate(() => window.__developmentRestartActionFixture.setPendingForm(true));
    await restartButton.click();
    await page.waitForFunction(() => window.__developmentRestartActionFixture.read().action?.state === "failed");
    const dirtyForm = await page.evaluate(() => window.__developmentRestartActionFixture.read());
    check("guarded capture never applies or discards pending Inspector changes", () => {
      assert.equal(dirtyForm.posts.length, 0);
      assert.equal(dirtyForm.action.requestId, null);
      assert.equal(dirtyForm.paused, false);
      assert.equal(dirtyForm.formApplyCalls, 0);
      assert.equal(dirtyForm.formResetCalls, 0);
    });
    await page.evaluate(() => window.__developmentRestartActionFixture.setPendingForm(false));
    await restartButton.waitFor({ state: "visible" });

    const draft = page.getByRole("textbox", { name: "Local workspace input" });
    await draft.fill("retained while waiting");
    await restartButton.click();
    await page.waitForFunction(() => window.__developmentRestartActionFixture.read().action?.state === "unknown");
    const unknown = await page.evaluate(() => window.__developmentRestartActionFixture.read());
    const retainedDraft = await draft.inputValue();
    evidence.unknown = unknown;
    check("lost acknowledgement retains one intent and protects the workspace", () => {
      assert.equal(unknown.posts.length, 1);
      assert.equal(unknown.paused, true);
      assert.equal(unknown.boundaryInert, true);
      assert.equal(unknown.action.requestId, unknown.posts[0].requestId);
      assert.equal(retainedDraft, "retained while waiting");
    });

    const reconcileButton = page.getByRole("button", { name: "Check restart", exact: true });
    await reconcileButton.click();
    await page.waitForFunction(() => window.__developmentRestartActionFixture.read().action?.state === "pending");
    const pending = await page.evaluate(() => window.__developmentRestartActionFixture.read());
    check("pending reconciliation reads the same request and private token", () => {
      assert.equal(pending.posts.length, 1);
      assert.equal(pending.statusReads.length, 1);
      assert.equal(pending.statusReads[0].requestId, unknown.posts[0].requestId);
      assert.equal(pending.statusReads[0].tokenMatches, true);
    });

    await page.evaluate(() => window.__developmentRestartActionFixture.remountBanner());
    await reconcileButton.waitFor({ state: "visible" });
    const remounted = await page.evaluate(() => window.__developmentRestartActionFixture.read());
    check("banner remount preserves the existing controller", () => {
      assert.equal(remounted.sameService, true);
      assert.equal(remounted.action.state, "pending");
      assert.equal(remounted.action.requestId, unknown.posts[0].requestId);
      assert.equal(remounted.posts.length, 1);
    });

    await page.evaluate(() => window.__developmentRestartActionFixture.allowReady());
    await reconcileButton.click();
    await page.waitForFunction(() => {
      const current = window.__developmentRestartActionFixture.read();
      return current.action?.state === "restored" && current.generation === 1 && !current.paused;
    });
    const restored = await page.evaluate(() => window.__developmentRestartActionFixture.read());
    evidence.firstRestored = restored;
    check("real provider publishes fresh owners and navigation before restored", () => {
      assert.equal(restored.pin, "22222222-2222-4222-8222-222222222222");
      assert.equal(restored.navigationPin, restored.pin);
      assert.equal(restored.emptyDocument, true);
      assert.equal(restored.publicationError, null);
      assert.equal(restored.sameService, true);
      assert.equal(restored.originalKernelRetained, false);
      assert.equal(restored.posts.length, 1);
    });
    await restartButton.waitFor({ state: "hidden" });
    const retired = await page.evaluate(() => window.__developmentRestartActionFixture.probeRetiredTransport());
    check("old ordinary transport stays retired without network traffic", () => {
      assert.equal(retired.code, "DEVELOPMENT_TRANSPORT_RETIRED");
      assert.equal(retired.noNetwork, true);
    });

    await page.evaluate(() => window.__developmentRestartActionFixture.setMode("ready", 2));
    await restartButton.waitFor({ state: "visible" });
    await restartButton.click();
    await page.waitForFunction(() => window.__developmentRestartActionFixture.read().action?.state === "unknown");
    await page.evaluate(() => window.__developmentRestartActionFixture.allowReady());
    await reconcileButton.click();
    await page.waitForFunction(() => {
      const current = window.__developmentRestartActionFixture.read();
      return current.action?.state === "restored" && current.generation === 2 && !current.paused;
    });
    const second = await page.evaluate(() => window.__developmentRestartActionFixture.read());
    evidence.secondRestored = second;
    check("a different source permits a second explicit intent on the persistent service", () => {
      assert.equal(second.posts.length, 2);
      assert.notEqual(second.posts[0].requestId, second.posts[1].requestId);
      assert.equal(second.pin, "33333333-3333-4333-8333-333333333333");
      assert.equal(second.navigationPin, second.pin);
      assert.equal(second.sameService, true);
      assert.equal(second.statusReads.length, 3);
      assert.equal(second.statusReads.every((item) => item.tokenMatches), true);
      assert.equal(second.statusReads[2].requestId, second.posts[1].requestId);
      assert.deepEqual(second.unexpected, []);
    });
    await restartButton.waitFor({ state: "hidden" });

    await page.evaluate(() => window.__developmentRestartActionFixture.setMode("ready", 3));
    await restartButton.waitFor({ state: "visible" });
    await page.evaluate(() => window.__developmentRestartActionFixture.armPreIntentCleanupFault());
    await restartButton.click();
    await page.waitForFunction(() => {
      const current = window.__developmentRestartActionFixture.read();
      return current.action?.state === "failed" && !current.action.busy;
    });
    const cleanupUnknown = await page.evaluate(() => window.__developmentRestartActionFixture.read());
    await restartButton.waitFor({ state: "hidden" });
    await page.evaluate(() => window.__developmentRestartActionFixture.clearCleanupFault());
    await page.evaluate(() => window.__developmentRestartActionFixture.probeBlockedStart());
    const deniedRetry = await page.evaluate(() => window.__developmentRestartActionFixture.read());
    evidence.preIntentCleanup = { before: cleanupUnknown, after: deniedRetry };
    check("unconfirmed real forms cleanup remains ineligible even after Host resume", () => {
      assert.equal(cleanupUnknown.paused, false);
      assert.equal(cleanupUnknown.action.requestId, null);
      assert.equal(cleanupUnknown.action.captureCleanup, "unconfirmed");
      assert.equal(cleanupUnknown.guardedCaptureReads, 3);
      assert.equal(cleanupUnknown.posts.length, 2);
      assert.equal(deniedRetry.posts.length, 2);
      assert.equal(deniedRetry.requests.length, cleanupUnknown.requests.length);
      assert.equal(deniedRetry.action.captureCleanup, "unconfirmed");
    });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    check("no page, console or unhandled API errors", () => {
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(consoleErrors, []);
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    checks.push({ name: "browser execution", status: "failed", detail: failure });
    if (page) {
      try { evidence.failure = await page.evaluate(() => window.__developmentRestartActionFixture?.read() ?? null); }
      catch { /* Diagnostic collection does not replace the primary failure. */ }
      try { await page.screenshot({ path: screenshotPath, fullPage: true }); } catch { /* Best effort. */ }
    }
  } finally {
    await browser?.close();
    await mkdir(reportRoot, { recursive: true });
    await writeFile(reportPath, `${JSON.stringify({
      schema: "fullmag.development-restart-action.browser-fixture.v1",
      state: failure ? "failed" : "passed", started_at: startedAt, finished_at: new Date().toISOString(),
      fixture_only: true, actual_backend_runtime: false, native_consumer: false, nonempty_document: false,
      actual_provider_banner_controller_and_typed_client: true,
      checks, passed_checks: checks.filter((item) => item.status === "passed").length,
      total_checks: checks.length, evidence, page_errors: pageErrors, console_errors: consoleErrors,
      ...(failure ? { error: failure } : {}),
    }, null, 2)}\n`);
  }
  console.log(JSON.stringify({ report: reportPath, state: failure ? "failed" : "passed", checks: checks.length }));
  if (failure) process.exitCode = 1;
}

await mkdir(reportRoot, { recursive: true });
await main();
