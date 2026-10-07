import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const url = new URL(process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:3256/study-execution-profile");
url.searchParams.set("fullmag_api_instance", "11111111-1111-4111-8111-111111111111");
const storageRoot = process.env.FULLMAG_PROJECT_STORAGE_ROOT;
const reportDirectory = process.env.FULLMAG_STUDY_EXECUTION_PROFILE_REPORT_DIR;
if (!storageRoot || !isAbsolute(storageRoot) || !reportDirectory || !isAbsolute(reportDirectory)) {
  throw new Error("Managed absolute storage and Study execution profile report paths are required.");
}
const reportRoot = resolve(reportDirectory);
const reportRelative = relative(resolve(storageRoot), reportRoot);
if (!reportRelative || reportRelative === ".." || reportRelative.startsWith(`..${sep}`) || isAbsolute(reportRelative)) {
  throw new Error("Study execution profile reports must stay below managed storage.");
}
const reportPath = resolve(reportRoot, "study-execution-profile.json");
const screenshots = {
  dark: resolve(reportRoot, "study-execution-profile-dark.png"),
  light: resolve(reportRoot, "study-execution-profile-light.png"),
};

async function loadPlaywright() {
  try { return await import("playwright"); }
  catch { return await import("@playwright/test"); }
}

const profileKey = (id, version) => JSON.stringify([id, version]);

async function main() {
  const checks = [];
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
    const channel = process.env.FULLMAG_STUDY_EXECUTION_PROFILE_BROWSER_CHANNEL;
    if (channel && !["chrome", "msedge"].includes(channel)) throw new Error("Unsupported browser channel");
    browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
    page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    // Keep the fixture's realtime channel open without inventing runtime events.
    // HTTP resources below remain the sole controlled source of canonical state.
    await page.routeWebSocket("**/v2/sessions/current/events/ws*", () => {});
    page.setDefaultTimeout(30_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) consoleErrors.push(message.text());
    });
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.locator("[data-study-execution-profile-fixture]").waitFor({ state: "visible" });
    const profileSelect = page.getByRole("combobox", { name: "Immutable profile version", exact: true });
    const apply = page.getByRole("button", { name: "Apply execution profile", exact: true });
    await profileSelect.waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const fixture = window.__studyExecutionProfileFixture;
      const select = document.querySelector("[data-study-execution-profile] select");
      return fixture?.read().api_instance === "11111111-1111-4111-8111-111111111111" &&
        [...(select?.options ?? [])].some((option) => option.textContent?.includes("exec:catalog-advanced · 7"));
    });

    const first = await page.evaluate(() => window.__studyExecutionProfileFixture.read());
    await check("real Study profile section loads its catalogue through the pinned API facade", async () => {
      assert.equal(first.current_session_id, "fixture-study-session-one");
      assert.deepEqual(first.scene.study.execution_layers.length, 2);
      assert.equal(first.requests.some((request) => request.path === "/v2/platform/compute/profiles"), true);
      assert.equal(first.requests.every((request) => request.pin === "11111111-1111-4111-8111-111111111111"), true);
      assert.equal(first.requests.some((request) => /preview|study-plan/i.test(request.path)), false);
    });

    await profileSelect.selectOption(profileKey("exec:catalog-advanced", "7"));
    await page.getByRole("textbox", { name: "CPU threads override", exact: true }).fill("16");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    const cancelled = await page.evaluate(() => window.__studyExecutionProfileFixture.read());
    await check("Cancel discards the local profile draft without a scene transaction", () => {
      assert.equal(cancelled.transactions.length, 0);
      assert.equal(cancelled.scene.study.execution_profile.profile_id, "exec:session-one");
      assert.equal(cancelled.scene.study.execution_layers[1].request.resources.cpu.threads, 8);
    });

    await profileSelect.selectOption(profileKey("exec:catalog-advanced", "7"));
    await page.getByRole("textbox", { name: "CPU threads override", exact: true }).fill("16");
    await page.locator('[data-study-profile-edit-session="dirty"]').waitFor({ state: "visible" });
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
    await page.getByRole("button", { name: "Apply registered Inspector changes", exact: true }).click();
    await page.waitForFunction(() => window.__studyExecutionProfileFixture.read().transactions.some((item) => item.outcome === "committed"));
    const applied = await page.evaluate(() => window.__studyExecutionProfileFixture.read());
    await check("registered Apply assigns the exact immutable version and preserves advanced layers", () => {
      const transaction = applied.transactions[0];
      assert.equal(transaction.outcome, "committed");
      assert.equal(transaction.body.kind, "assign_study_execution");
      assert.equal(transaction.baseRevision, 1);
      assert.equal(transaction.body.execution_profile.profile_id, "exec:catalog-advanced");
      assert.equal(transaction.body.execution_profile.version, "7");
      assert.deepEqual(transaction.body.execution_profile.defaults.resources.gpu, {
        selector: "allow_list", device_uuids: ["GPU-study-fixture-1"], devices_per_task: 1, vram_per_device_bytes: 8_589_934_592,
      });
      assert.deepEqual(transaction.body.execution_profile.defaults.resources.ram, { reservation_bytes: 17_179_869_184 });
      assert.deepEqual(transaction.body.execution_profile.defaults.resources.scratch, { reservation_bytes: 2_147_483_648 });
      assert.deepEqual(transaction.body.execution_layers[0], applied.scene.study.execution_layers[0]);
      assert.deepEqual(transaction.body.execution_layers[0], {
        origin: { kind: "script", location: "fixture/script.py:study" },
        request: {
          backend: "fem",
          resources: {
            target: { kind: "local" },
            cpu: { core_policy: "logical", affinity: "numa", numa_node: 3, native_threads: "auto", blas_threads: 6 },
            gpu: { selector: "required", device_uuids: ["GPU-script-fixture"], devices_per_task: 1, vram_per_device_bytes: 4_294_967_296 },
            ram: { reservation_bytes: 4_294_967_296 },
            scratch: { reservation_bytes: 1_073_741_824 },
            parallelism: { kind: "single_process" }, placement: "throughput",
          },
        },
      });
      assert.deepEqual(transaction.body.execution_layers[1], {
        origin: { kind: "study", location: "Existing Study override" },
        request: {
          device: "cpu",
          resources: { cpu: { threads: 16, core_policy: "physical_first", affinity: "compact", numa_node: 1, native_threads: "auto", blas_threads: 4 } },
        },
      });
      assert.equal(applied.history.canUndo, true);
      assert.equal(applied.history.undoLabel, "Assign Study execution profile");
      assert.equal(applied.scene.study.execution_profile.profile_id, "exec:catalog-advanced");
    });

    await check("bound profile disables Change device in the empty pipeline editor", async () => {
      assert.equal(await page.getByRole("button", { name: "Change device", exact: true }).isDisabled(), true);
    });

    await profileSelect.selectOption(profileKey("exec:conflict-target", "3"));
    await page.getByRole("button", { name: "Arm scene revision conflict", exact: true }).click();
    await apply.click();
    await page.getByText("This draft uses an older scene revision. Cancel to reload the latest scene before making another profile change.", { exact: true }).waitFor({ state: "visible" });
    await check("revision conflict preserves the selected draft and blocks stale Apply", async () => {
      const conflicted = await page.evaluate(() => window.__studyExecutionProfileFixture.read());
      assert.equal(conflicted.transactions[1].outcome, "conflict");
      assert.equal(conflicted.transactions[1].baseRevision, 2);
      assert.equal(await profileSelect.inputValue(), profileKey("exec:conflict-target", "3"));
      assert.equal(await apply.isDisabled(), true);
    });

    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.waitForFunction((expected) => {
      const select = [...document.querySelectorAll("select")].find((item) => item.labels?.[0]?.textContent?.includes("Immutable profile version"));
      return select?.value === expected;
    }, profileKey("exec:catalog-advanced", "7"));
    await profileSelect.selectOption(profileKey("exec:catalog-alternate", "2"));
    await page.locator('[data-study-profile-edit-session="dirty"]').waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Switch fixture session", exact: true }).click();
    await page.waitForFunction(() => window.__studyExecutionProfileFixture.read().current_session_id === "fixture-study-session-two");
    await page.waitForFunction((expected) => {
      const select = [...document.querySelectorAll("select")].find((item) => item.labels?.[0]?.textContent?.includes("Immutable profile version"));
      return select?.value === expected && document.querySelector('[data-study-profile-edit-session="clean"]') !== null;
    }, profileKey("exec:session-two", "1"));
    const switched = await page.evaluate(() => window.__studyExecutionProfileFixture.read());
    await check("session scope change discards the old draft and loads the new scene profile", () => {
      assert.equal(switched.current_session_id, "fixture-study-session-two");
      assert.equal(switched.scene.study.execution_profile.profile_id, "exec:session-two");
      assert.equal(switched.scene.study.stages[0].kind, "change_device");
      assert.equal(switched.transactions.length, 2);
    });

    await page.getByText("A Change device stage cannot be combined with an execution profile. Remove that stage or clear the profile before applying.", { exact: true }).waitFor({ state: "visible" });
    await check("bound profile exposes an existing-stage conflict and blocks assignment", async () => {
      assert.equal(await apply.isDisabled(), true);
    });

    const selectNone = async () => profileSelect.selectOption("__legacy__");
    await selectNone();
    await apply.click();
    await page.waitForFunction(() => window.__studyExecutionProfileFixture.read().transactions.length === 3);
    await profileSelect.selectOption(profileKey("exec:catalog-alternate", "2"));
    await check("an existing Change device stage blocks attaching a new profile", async () => {
      const before = await page.evaluate(() => window.__studyExecutionProfileFixture.read());
      assert.equal(before.transactions[2].body.kind, "merge_patch");
      assert.deepEqual(before.transactions[2].body.merge_patch.study, { execution_profile: null, execution_layers: null });
      assert.equal(await apply.isDisabled(), true);
      assert.equal(before.transactions.length, 3);
    });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    const finalState = await page.evaluate(() => window.__studyExecutionProfileFixture.read());
    await check("fixture performs no preview or solver operation", () => {
      assert.equal(finalState.requests.some((request) => /preview|study-plan/i.test(request.path)), false);
      assert.equal(finalState.transactions.some((item) => !["assign_study_execution", "merge_patch"].includes(item.body.kind)), false);
      assert.equal(finalState.unhandled.some((request) => request.startsWith("POST ")), false);
      assert.equal(pageErrors.length, 0);
      assert.deepEqual(consoleErrors, []);
    });
  } catch (error) {
    failure = error instanceof Error ? error.stack ?? error.message : String(error);
  } finally {
    await mkdir(reportRoot, { recursive: true });
    if (page && failure) {
      try { await page.screenshot({ path: screenshots.dark, fullPage: true, animations: "disabled" }); } catch { /* Preserve the original failure. */ }
    }
    await browser?.close();
  }

  const report = {
    schema: "fullmag_study_execution_profile_browser_fixture_v1",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    status: failure ? "failed" : "passed",
    fixture_only: true,
    backend_runtime_started: false,
    solver_started: false,
    api_instance: "11111111-1111-4111-8111-111111111111",
    browser_channel: process.env.FULLMAG_STUDY_EXECUTION_PROFILE_BROWSER_CHANNEL ?? "bundled chromium",
    checks,
    page_errors: pageErrors,
    console_errors: consoleErrors,
    screenshots: failure ? [screenshots.dark] : [screenshots.dark, screenshots.light],
    failure: failure ?? null,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (failure) throw new Error(`${failure}\nStudy execution profile browser report: ${reportPath}`);
  console.log(`Study execution profile browser fixture passed; report: ${reportPath}`);
}

await main();
