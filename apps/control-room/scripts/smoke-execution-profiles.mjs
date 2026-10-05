import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const url = new URL(process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:3255/execution-profiles");
url.searchParams.set("fullmag_api_instance", "11111111-1111-4111-8111-111111111111");
const storageRoot = process.env.FULLMAG_PROJECT_STORAGE_ROOT;
const reportDirectory = process.env.FULLMAG_EXECUTION_PROFILES_REPORT_DIR;
if (!storageRoot || !isAbsolute(storageRoot) || !reportDirectory || !isAbsolute(reportDirectory)) {
  throw new Error("Managed absolute storage and execution-profiles report paths are required.");
}
const reportRoot = resolve(reportDirectory);
const reportRelative = relative(resolve(storageRoot), reportRoot);
if (!reportRelative || reportRelative === ".." || reportRelative.startsWith(`..${sep}`) || isAbsolute(reportRelative)) {
  throw new Error("Execution-profiles reports must stay below managed storage.");
}
const reportPath = resolve(reportRoot, "execution-profiles.json");
const screenshots = {
  dark: resolve(reportRoot, "execution-profiles-dark.png"),
  light: resolve(reportRoot, "execution-profiles-light.png"),
};

async function loadPlaywright() {
  try { return await import("playwright"); }
  catch { return await import("@playwright/test"); }
}

async function main() {
  const checks = [];
  const evidence = {};
  const pageErrors = [];
  const consoleErrors = [];
  let browser;
  let page;
  let failure;
  const startedAt = new Date().toISOString();
  const check = async (name, assertion) => {
    await assertion();
    checks.push({ name, status: "passed" });
  };

  try {
    const { chromium } = await loadPlaywright();
    const channel = process.env.FULLMAG_EXECUTION_PROFILES_BROWSER_CHANNEL;
    if (channel && !["chrome", "msedge"].includes(channel)) throw new Error("Unsupported browser channel");
    browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(30_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) consoleErrors.push(message.text());
    });
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.locator("[data-execution-profiles-fixture]").waitFor({ state: "visible" });
    const create = page.getByRole("button", { name: "Create profile", exact: true });
    await create.waitFor({ state: "visible" });
    await page.waitForFunction(() => window.__executionProfilesFixture?.read().api_instance === "11111111-1111-4111-8111-111111111111");
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Create profile");
      return !!button && !button.disabled;
    });

    const empty = await page.evaluate(() => window.__executionProfilesFixture.read());
    const createEnabled = await create.isEnabled();
    await check("empty catalog is loaded through the real API facade and resource hook", () => {
      assert.equal(empty.records.length, 0);
      assert.equal(empty.fixture_only, true);
      assert.equal(empty.requests.some((request) => request.path === "/v2/platform/compute/profiles"), true);
      assert.equal(createEnabled, true);
    });

    await create.click();
    await page.getByLabel("Profile ID").fill("exec:cancelled");
    await page.getByLabel("Version").fill("1");
    const showTheme = async (theme) => {
      await page.evaluate(async (nextTheme) => {
        document.documentElement.dataset.theme = nextTheme;
        document.documentElement.style.colorScheme = nextTheme;
        await document.fonts.ready;
        await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
      }, theme);
    };
    await showTheme("dark");
    await page.screenshot({ path: screenshots.dark, fullPage: true, animations: "disabled" });
    await showTheme("light");
    await page.screenshot({ path: screenshots.light, fullPage: true, animations: "disabled" });
    await showTheme("dark");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    const cancelled = await page.evaluate(() => window.__executionProfilesFixture.read());
    const cancelledFormCount = await page.locator("form").count();
    await check("cancel leaves the catalogue unchanged", () => {
      assert.equal(cancelled.posts.length, 0);
      assert.equal(cancelledFormCount, 0);
    });

    await create.click();
    await page.getByLabel("Profile ID").fill("exec:inherited");
    await page.getByLabel("Version").fill("1");
    await page.getByRole("button", { name: "Apply profile", exact: true }).click();
    await page.getByText("Published exec:inherited · 1.", { exact: true }).waitFor({ state: "visible" });
    const inherited = await page.evaluate(() => window.__executionProfilesFixture.read());
    await check("inherited CPU and device values remain absent", () => {
      assert.deepEqual(inherited.posts[0].request.profile.defaults, {});
      assert.equal(inherited.posts[0].request.profile.defaults.resources, undefined);
    });

    await create.click();
    await page.getByLabel("Profile ID").fill("exec:auto-inherited");
    await page.getByLabel("Version").fill("1");
    await page.getByRole("combobox", { name: "Device" }).click();
    await page.getByRole("option", { name: "Auto", exact: true }).click();
    await page.getByLabel("CPU threads per task").fill("auto");
    await page.getByRole("button", { name: "Apply profile", exact: true }).click();
    await page.getByText("Published exec:auto-inherited · 1.", { exact: true }).waitFor({ state: "visible" });
    const explicitAuto = await page.evaluate(() => window.__executionProfilesFixture.read());
    const firstRequest = explicitAuto.posts[1].request;
    await check("explicit Auto is serialized distinctly from inherited omission", () => {
      assert.deepEqual(firstRequest.profile.defaults, {
        device: "auto", resources: { cpu: { threads: "auto" } },
      });
      assert.equal(Object.hasOwn(firstRequest.profile.defaults, "backend"), false);
      assert.equal(explicitAuto.records.length, 2);
    });

    await page.evaluate(() => window.__executionProfilesFixture.seedAdvancedProfile());
    await page.getByRole("button", { name: "Refresh profiles", exact: true }).click();
    const advancedButton = page.getByRole("button", { name: "New version of exec:advanced-fixture 1", exact: true });
    await advancedButton.waitFor({ state: "visible" });
    await advancedButton.click();
    await page.getByLabel("Version").fill("2");
    await page.getByRole("button", { name: "Apply profile", exact: true }).click();
    await page.getByText("Published exec:advanced-fixture · 2.", { exact: true }).waitFor({ state: "visible" });
    const advanced = await page.evaluate(() => window.__executionProfilesFixture.read());
    const advancedRequest = advanced.posts[2].request.profile;
    await check("new version preserves advanced GPU, memory, topology and placement fields", () => {
      assert.deepEqual(advancedRequest.defaults.resources.gpu, {
        selector: "allow_list", device_uuids: ["GPU-fixture-uuid-1"], devices_per_task: 1, vram_per_device_bytes: 8589934592,
      });
      assert.deepEqual(advancedRequest.defaults.resources.ram, { reservation_bytes: 17179869184 });
      assert.deepEqual(advancedRequest.defaults.resources.scratch, { reservation_bytes: 2147483648 });
      assert.deepEqual(advancedRequest.defaults.resources.parallelism, { kind: "single_process" });
      assert.equal(advancedRequest.defaults.resources.placement, "pinned");
      assert.equal(advancedRequest.version, "2");
    });

    await create.click();
    await page.getByLabel("Profile ID").fill("exec:conflict");
    await page.getByLabel("Version").fill("1");
    await page.evaluate(() => window.__executionProfilesFixture.armNextFault("conflict"));
    await page.getByRole("button", { name: "Apply profile", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Profile catalogue changed" }).waitFor({ state: "visible" });
    await check("409 keeps the draft and requires refresh before retry", async () => {
      assert.equal(await page.getByLabel("Profile ID").inputValue(), "exec:conflict");
      assert.equal(await page.getByLabel("Version").inputValue(), "1");
      assert.equal(await page.getByRole("button", { name: "Apply profile", exact: true }).isDisabled(), true);
    });
    await page.getByRole("button", { name: "Refresh profiles", exact: true }).click();
    await page.getByRole("button", { name: "Apply profile", exact: true }).waitFor({ state: "visible" });
    await page.waitForFunction(() => !window.__executionProfilesFixture.read().unexpected.length);
    await page.getByRole("button", { name: "Apply profile", exact: true }).click();
    await page.getByText("Published exec:conflict · 1.", { exact: true }).waitFor({ state: "visible" });
    const conflict = await page.evaluate(() => window.__executionProfilesFixture.read());
    await check("refresh and retry publishes the retained conflict draft", () => {
      assert.equal(conflict.posts[3].outcome, "conflict");
      assert.equal(conflict.posts[4].request.profile.profile_id, "exec:conflict");
      assert.equal(conflict.posts[4].request.expected_revision, conflict.revision - 1);
    });

    await create.click();
    await page.getByLabel("Profile ID").fill("exec:lost-ack");
    await page.getByLabel("Version").fill("1");
    await page.evaluate(() => window.__executionProfilesFixture.armNextFault("lost_ack"));
    await page.getByRole("button", { name: "Apply profile", exact: true }).click();
    await page.getByText("Published exec:lost-ack · 1.", { exact: true }).waitFor({ state: "visible" });
    const lostAck = await page.evaluate(() => window.__executionProfilesFixture.read());
    const lostIntent = lostAck.posts[5].request.client_intent_id;
    await check("lost acknowledgement reconciles the committed client intent once", () => {
      assert.equal(lostAck.posts[5].outcome, "lost_ack");
      assert.equal(lostAck.publication_lookups.includes(lostIntent), true);
      assert.equal(lostAck.records.filter((record) => record.client_intent_id === lostIntent).length, 1);
      assert.equal(lostAck.posts.filter((post) => post.request.client_intent_id === lostIntent).length, 1);
    });

    await create.click();
    await page.getByLabel("Profile ID").fill("exec:unknown-outcome");
    await page.getByLabel("Version").fill("1");
    await page.evaluate(() => window.__executionProfilesFixture.armNextFault("unknown"));
    await page.getByRole("button", { name: "Apply profile", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Publication is not confirmed" }).waitFor({ state: "visible" });
    const beforeRetry = await page.evaluate(() => window.__executionProfilesFixture.read());
    const locked = await page.getByLabel("Profile ID").isDisabled();
    await check("unknown outcome locks editable fields and offers a same-intent retry", async () => {
      assert.equal(locked, true);
      assert.equal(beforeRetry.posts[6].outcome, "unknown");
      assert.equal(await page.getByRole("button", { name: "Retry same publication", exact: true }).isEnabled(), true);
    });
    await page.getByRole("button", { name: "Retry same publication", exact: true }).click();
    await page.getByText("Published exec:unknown-outcome · 1.", { exact: true }).waitFor({ state: "visible" });
    const retried = await page.evaluate(() => window.__executionProfilesFixture.read());
    await check("retry reuses the exact intent and payload", () => {
      assert.deepEqual(retried.posts[7].request, retried.posts[6].request);
      assert.equal(retried.records.filter((record) => record.client_intent_id === retried.posts[6].request.client_intent_id).length, 1);
    });

    await create.click();
    await page.getByLabel("Profile ID").fill("exec:stale-catalog");
    await page.getByLabel("Version").fill("1");
    await page.evaluate(() => window.__executionProfilesFixture.failNextCatalogReads(12));
    await page.getByRole("button", { name: "Refresh profiles", exact: true }).click();
    await page.getByText("Showing the last catalogue reading. Refresh before publishing.", { exact: true }).waitFor({ state: "visible" });
    const staleApplyDisabled = await page.getByRole("button", { name: "Apply profile", exact: true }).isDisabled();
    const staleProfileId = await page.getByLabel("Profile ID").inputValue();
    await check("unavailable refresh keeps stale data visible and disables Apply", () => {
      assert.equal(staleApplyDisabled, true);
      assert.equal(staleProfileId, "exec:stale-catalog");
    });
    await page.evaluate(() => window.__executionProfilesFixture.restoreCatalog());
    await page.getByRole("button", { name: "Refresh profiles", exact: true }).click();
    await page.getByRole("button", { name: "Apply profile", exact: true }).waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Apply profile");
      return !!button && !button.disabled;
    });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    await page.setViewportSize({ width: 360, height: 800 });
    const narrow = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    await check("narrow layout has no horizontal overflow", () => {
      assert.equal(narrow.document <= narrow.viewport && narrow.body <= narrow.viewport, true);
    });
    evidence.narrow_layout = narrow;

    const finalState = await page.evaluate(() => window.__executionProfilesFixture.read());
    evidence.fixture = finalState;
    await check("fixture uses only the profile, session and health API paths", () => {
      assert.deepEqual(finalState.unexpected, []);
      assert.equal(finalState.records.length, 7);
    });
    await check("no page or console errors", () => {
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(consoleErrors, []);
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    checks.push({ name: "browser execution", status: "failed", detail: failure });
    if (page) {
      try { evidence.fixture = await page.evaluate(() => window.__executionProfilesFixture?.read() ?? null); }
      catch { /* Keep the original failure as the primary evidence. */ }
      for (const screenshot of Object.values(screenshots)) {
        try { await page.screenshot({ path: screenshot, fullPage: true }); } catch { /* Best effort. */ }
      }
    }
  } finally {
    await browser?.close();
    await mkdir(reportRoot, { recursive: true });
    await writeFile(reportPath, `${JSON.stringify({
      schema: "fullmag.execution-profiles.browser-fixture.v1",
      state: failure ? "failed" : "passed",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      fixture_only: true,
      actual_backend_runtime: false,
      solver_started: false,
      screenshots,
      checks,
      passed_checks: checks.filter((item) => item.status === "passed").length,
      total_checks: checks.length,
      evidence,
      page_errors: pageErrors,
      console_errors: consoleErrors,
      ...(failure ? { error: failure } : {}),
    }, null, 2)}\n`);
  }
  console.log(JSON.stringify({ report: reportPath, state: failure ? "failed" : "passed", checks: checks.length }));
  if (failure) process.exitCode = 1;
}

await mkdir(reportRoot, { recursive: true });
await main();
