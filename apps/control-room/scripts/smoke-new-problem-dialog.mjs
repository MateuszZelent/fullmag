import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const REPORT_SCHEMA = "fullmag_new_problem_browser_smoke_v2";
const workspaceUrl = process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:3258/new-problem-verification";
const storageRoot = process.env.FULLMAG_PROJECT_STORAGE_ROOT;
const reportDirectoryValue = process.env.FULLMAG_NEW_PROBLEM_REPORT_DIR;
const screenshotDirectoryValue = process.env.FULLMAG_NEW_PROBLEM_SCREENSHOT_DIR;
const timeoutMs = Number(process.env.FULLMAG_NEW_PROBLEM_SMOKE_TIMEOUT_MS ?? 60_000);
let checks = [];

function managedDirectory(value, label) {
  if (!storageRoot || !isAbsolute(storageRoot) || !value || !isAbsolute(value)) {
    throw new Error(`Managed absolute storage paths are required for ${label}.`);
  }
  const target = resolve(value);
  const remainder = relative(resolve(storageRoot), target);
  if (!remainder || remainder === ".." || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
    throw new Error(`${label} must be a descendant of managed project storage.`);
  }
  return target;
}

const reportDirectory = managedDirectory(reportDirectoryValue, "browser reports");
const screenshotDirectory = managedDirectory(screenshotDirectoryValue, "screenshots");
const reportPath = resolve(reportDirectory, "new-problem-browser.json");
const screenshotPaths = {
  desktopLight: resolve(screenshotDirectory, "new-problem-desktop-light.png"),
  desktopDark: resolve(screenshotDirectory, "new-problem-desktop-dark.png"),
  narrow: resolve(screenshotDirectory, "new-problem-narrow.png"),
};

function check(condition, name, detail) {
  assert.ok(condition, detail ? `${name}: ${detail}` : name);
  checks.push({ name, status: "passed", ...(detail ? { detail } : {}) });
}

function same(actual, expected, name) {
  assert.deepEqual(actual, expected, name);
  checks.push({ name, status: "passed" });
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

async function readFixture(page) {
  return await page.evaluate(() => {
    if (!window.__newSimulationFixture) throw new Error("New simulation fixture API is not installed.");
    return window.__newSimulationFixture.read();
  });
}

async function assertNoHorizontalOverflow(page) {
  const dimensions = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return {
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      dialogClientWidth: dialog?.clientWidth ?? 0,
      dialogScrollWidth: dialog?.scrollWidth ?? 0,
    };
  });
  check(dimensions.documentWidth <= dimensions.viewportWidth + 1, "no page horizontal overflow", JSON.stringify(dimensions));
  check(dimensions.dialogScrollWidth <= dimensions.dialogClientWidth + 1, "no dialog horizontal overflow", JSON.stringify(dimensions));
  return dimensions;
}

async function saveScreenshot(page, name, path) {
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  return { name, path };
}

async function main() {
  await mkdir(reportDirectory, { recursive: true });
  await mkdir(screenshotDirectory, { recursive: true });
  const startedAt = new Date().toISOString();
  const channel = process.env.FULLMAG_NEW_PROBLEM_BROWSER_CHANNEL;
  const pageErrors = [];
  const consoleErrors = [];
  const screenshots = [];
  let browser = null;
  let page = null;
  let failure = null;
  let lastDimensions = null;

  try {
    const playwright = await loadPlaywright();
    if (!playwright?.chromium) {
      throw new Error("New simulation browser smoke requires Playwright or @playwright/test.");
    }
    if (channel && !["chrome", "msedge"].includes(channel)) {
      throw new Error(`Unsupported new simulation browser channel: ${channel}`);
    }

    browser = await playwright.chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
    page = await browser.newPage({ acceptDownloads: false, viewport: { height: 900, width: 1280 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
        consoleErrors.push(message.text());
      }
    });

    const url = new URL(workspaceUrl);
    url.searchParams.set("storageError", "1");
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.locator('[data-new-problem-fixture="true"]').waitFor({ state: "visible", timeout: timeoutMs });
    const dialog = page.getByRole("dialog", { name: "New simulation", exact: true });
    await dialog.waitFor({ state: "visible", timeout: timeoutMs });
    await page.waitForFunction(() => Boolean(window.__newSimulationFixture), undefined, { timeout: timeoutMs });

    await dialog.getByText("Unable to load storage settings.", { exact: false }).waitFor({ state: "visible", timeout: timeoutMs });
    check((await readFixture(page)).storageReads === 1, "production resource hook reports the controlled defaults GET failure");
    await dialog.getByRole("button", { name: "Try again", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector("#fm-new-problem-output")?.value === "C:\\fullmag\\fixture-results",
      undefined,
      { timeout: timeoutMs },
    );
    check((await readFixture(page)).storageReads === 2, "resource-hook retry loads typed storage defaults");

    const nameInput = dialog.getByLabel("Simulation name", { exact: true });
    const outputInput = dialog.getByLabel("Results directory", { exact: true });
    const folderInput = dialog.getByLabel("Project folder", { exact: true });
    const tempInput = dialog.getByLabel("Temporary directory", { exact: true });
    const createButton = dialog.getByRole("button", { name: "Create simulation", exact: true });
    const fdm = dialog.getByRole("radio", { name: "FDM", exact: true });
    const fem = dialog.getByRole("radio", { name: "FEM", exact: true });
    const hdf5 = dialog.getByRole("radio", { name: "HDF5", exact: true });

    check(/^Simulation \d{4}-\d{2}-\d{2} \d{6}$/.test(await nameInput.inputValue()), "automatic simulation name includes a timestamp");
    check(/^simulation_\d{4}-\d{2}-\d{2}_\d{6}$/.test(await folderInput.inputValue()), "suggested project folder has a slug and timestamp");
    same(await outputInput.inputValue(), "C:\\fullmag\\fixture-results", "resource-backed results parent is shown");
    same(await tempInput.inputValue(), "C:\\fullmag\\fixture-temp", "resource-backed temporary parent is shown");
    check(await fdm.getAttribute("aria-checked") === "true", "FDM is the default discretization");
    check(await hdf5.isDisabled(), "unsupported HDF5 format is disabled");
    check(await dialog.getByText("HDF5 output is unavailable in this runtime fixture.", { exact: true }).isVisible(), "HDF5 disablement explains the missing capability");
    check(await dialog.getByRole("button", { name: "Browse results directory", exact: true }).count() === 0, "browser fixture does not pretend to provide a native directory picker");
    await dialog.locator(".fm-new-problem__body").evaluate((node) => { node.scrollTop = 0; });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    screenshots.push(await saveScreenshot(page, "desktop-light", screenshotPaths.desktopLight));
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    screenshots.push(await saveScreenshot(page, "desktop-dark", screenshotPaths.desktopDark));

    await dialog.locator("summary").click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    lastDimensions = await assertNoHorizontalOverflow(page);
    screenshots.push(await saveScreenshot(page, "narrow", screenshotPaths.narrow));
    await dialog.locator(".fm-new-problem__body").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    const footerBox = await dialog.locator(".fm-new-problem__footer").boundingBox();
    check(Boolean(footerBox && footerBox.y >= 0 && footerBox.y + footerBox.height <= 844), "dialog footer remains visible after narrow-layout scroll");
    check(await dialog.getByRole("button", { name: "Create simulation", exact: true }).isVisible(), "submit stays visible at the end of a narrow scroll");

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

    await page.evaluate(() => {
      window.__newSimulationFixture?.refreshStorageDefaults({ temp_parent: null });
    });
    await page.waitForFunction(() => window.__newSimulationFixture?.read().storageReads === 3, undefined, { timeout: timeoutMs });
    same(await tempInput.inputValue(), "C:\\fullmag\\fixture-results\\.fullmag-tmp", "empty temporary parent falls back to a private child of the results parent");

    await nameInput.focus();
    await nameInput.press("Tab");
    check(await page.evaluate(() => document.activeElement?.getAttribute("data-value")) === "fdm", "keyboard tab order reaches selected discretization");
    await page.keyboard.press("ArrowRight");
    check(await fem.getAttribute("aria-checked") === "true", "arrow navigation selects FEM");
    await page.keyboard.press("ArrowLeft");
    check(await fdm.getAttribute("aria-checked") === "true", "arrow navigation returns to FDM");

    await dialog.getByRole("combobox", { name: "Remove temporary files", exact: true }).click();
    await page.getByRole("option", { name: "After every run", exact: true }).click();
    await dialog.getByRole("combobox", { name: "If a destination already exists", exact: true }).click();
    await page.getByRole("option", { name: "Stop if destination exists", exact: true }).click();
    same(await dialog.getByRole("combobox", { name: "Remove temporary files", exact: true }).innerText(), "After every run", "cleanup selection maps to its policy");
    same(await dialog.getByRole("combobox", { name: "If a destination already exists", exact: true }).innerText(), "Stop if destination exists", "existing-output selection maps to its policy");

    await nameInput.fill("");
    check(await createButton.isDisabled(), "empty simulation name blocks creation");
    await nameInput.fill("Browser proof trial");
    await outputInput.fill("relative/output");
    check(await outputInput.getAttribute("aria-invalid") === "true", "relative results path is marked invalid");
    check(await createButton.isDisabled(), "invalid results path blocks creation");
    await outputInput.fill("C:\\fullmag\\user-results");
    await folderInput.fill("../bad");
    check(await folderInput.getAttribute("aria-invalid") === "true", "unsafe project folder is marked invalid");
    check(await createButton.isDisabled(), "invalid project folder blocks creation");
    await folderInput.fill("browser-proof-session");
    await tempInput.fill("C:\\fullmag\\user-temp");
    check(await createButton.isEnabled(), "valid edited storage settings enable creation");

    const outputDraftBeforeRefresh = await outputInput.inputValue();
    await page.evaluate(() => {
      window.__newSimulationFixture?.refreshStorageDefaults({
        output_parent: "C:\\fullmag\\server-refreshed-results",
        temp_parent: "C:\\fullmag\\server-refreshed-temp",
      });
    });
    await page.waitForFunction(() => window.__newSimulationFixture?.read().storageReads === 4, undefined, { timeout: timeoutMs });
    same(await outputInput.inputValue(), outputDraftBeforeRefresh, "resource invalidation does not overwrite edited output-path draft");
    same(await nameInput.inputValue(), "Browser proof trial", "resource invalidation does not overwrite edited simulation name");
    same(await folderInput.inputValue(), "browser-proof-session", "resource invalidation does not overwrite edited project-folder draft");
    check(await dialog.getByLabel("Use these storage settings for new simulations", { exact: true }).isChecked(), "remember-storage preference defaults on");

    await fem.click();
    await page.evaluate(() => window.__newSimulationFixture?.setNextSessionOutcome("pending"));
    await nameInput.press("Enter");
    await page.waitForFunction(() => window.__newSimulationFixture?.read().pendingSession === true, undefined, { timeout: timeoutMs });
    let state = await readFixture(page);
    check(state.sessions.length === 1 && state.sessions[0]?.outcome === "pending", "Enter submits the real form once and awaits API acknowledgement");
    same(state.storageSaves.length, 0, "remembered defaults are not saved before session acknowledgement");
    await page.evaluate(() => window.__newSimulationFixture?.acknowledgeNextSession());
    await page.waitForFunction(() => window.__newSimulationFixture?.read().storageSaves.length === 1, undefined, { timeout: timeoutMs });
    state = await readFixture(page);
    const acceptedRequest = state.sessions[0]?.request;
    check(acceptedRequest?.backend === "fem", "FEM selection reaches the typed session request");
    check(acceptedRequest?.device === "cpu" && acceptedRequest?.precision === "double", "new simulation includes CPU/double defaults");
    check(acceptedRequest?.replace_current === false, "new session does not replace an absent current session");
    same(acceptedRequest?.output_storage, {
      output_dir: "C:\\fullmag\\user-results\\browser-proof-session\\results.zarr",
      temp_dir: "C:\\fullmag\\user-temp",
      data_format: "zarr",
      cleanup: "always",
      existing_output: "error",
    }, "session POST carries output directory, temp parent, format and policies");
    same(state.storageSaves[0], {
      output_parent: "C:\\fullmag\\user-results",
      temp_parent: "C:\\fullmag\\user-temp",
      data_format: "zarr",
      cleanup: "always",
      existing_output: "error",
    }, "storage defaults are saved only after successful session ACK");
    same(state.historyClears, 1, "accepted session clears the authoring history once");
    await dialog.waitFor({ state: "hidden", timeout: timeoutMs });

    await page.locator("[data-new-problem-open-empty]").click();
    const retryDialog = page.getByRole("dialog", { name: "New simulation", exact: true });
    await retryDialog.waitFor({ state: "visible", timeout: timeoutMs });
    const retryName = retryDialog.getByLabel("Simulation name", { exact: true });
    const retainedName = await retryName.inputValue();
    await page.evaluate(() => window.__newSimulationFixture?.setNextSessionOutcome("failure"));
    await retryName.press("Enter");
    await retryDialog.getByRole("alert").filter({ hasText: "Fixture session create failed." }).waitFor({ state: "visible", timeout: timeoutMs });
    same(await retryName.inputValue(), retainedName, "failed session POST retains the form name");
    state = await readFixture(page);
    check(state.sessions.length === 2 && state.sessions[1]?.outcome === "failure", "failed session create is recorded once");
    same(state.storageSaves.length, 1, "failed session POST does not save storage defaults");
    await page.waitForTimeout(350);
    same((await readFixture(page)).sessions.length, 2, "failed POST is not retried automatically");
    await retryDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await retryDialog.waitFor({ state: "hidden", timeout: timeoutMs });

    await page.locator("[data-new-problem-open-empty]").click();
    const saveFailureDialog = page.getByRole("dialog", { name: "New simulation", exact: true });
    await saveFailureDialog.waitFor({ state: "visible", timeout: timeoutMs });
    await page.evaluate(() => window.__newSimulationFixture?.failNextStorageSave());
    await saveFailureDialog.getByLabel("Simulation name", { exact: true }).press("Enter");
    await saveFailureDialog.getByRole("alert").filter({ hasText: "The simulation was created." }).waitFor({ state: "visible", timeout: timeoutMs });
    check(await saveFailureDialog.getByRole("button", { name: "Close", exact: true }).isVisible(), "post-ACK storage-save failure offers Close");
    check(await saveFailureDialog.getByRole("button", { name: "Create simulation", exact: true }).isDisabled(), "post-ACK storage-save failure disables duplicate submission");
    state = await readFixture(page);
    check(state.sessions.length === 3 && state.storageSaves.length === 2, "storage-save failure follows one acknowledged session POST");
    same(state.historyClears, 2, "accepted session clears history once even when saving settings fails");
    await page.waitForTimeout(350);
    same((await readFixture(page)).sessions.length, 3, "post-ACK storage-save failure never retries the session POST");
    await saveFailureDialog.getByRole("button", { name: "Close", exact: true }).click();
    await saveFailureDialog.waitFor({ state: "hidden", timeout: timeoutMs });

    await page.locator("[data-new-problem-open-replacement]").click();
    const replacementDialog = page.getByRole("dialog", { name: "New simulation", exact: true });
    await replacementDialog.waitFor({ state: "visible", timeout: timeoutMs });
    const replacementConfirm = replacementDialog.getByLabel("Replace the active simulation and its unsaved project changes.", { exact: true });
    const replacementCreate = replacementDialog.getByRole("button", { name: "Create simulation", exact: true });
    check(await replacementCreate.isDisabled(), "replacement requires explicit confirmation");
    await replacementConfirm.check();
    check(await replacementCreate.isEnabled(), "replacement confirmation enables submit");
    await replacementCreate.click();
    await page.waitForFunction(() => window.__newSimulationFixture?.read().sessions.length === 4, undefined, { timeout: timeoutMs });
    state = await readFixture(page);
    check(state.sessions[3]?.request.replace_current === true, "replacement confirmation reaches the session request");
    check(state.sessions[3]?.request.backend === "fdm", "replacement form defaults to FDM");
    await replacementDialog.waitFor({ state: "hidden", timeout: timeoutMs });

    check((await readFixture(page)).unexpectedRequests.length === 0, "fixture API observed no unexpected endpoint requests");
    check(pageErrors.length === 0, "browser reported no uncaught page errors", pageErrors.join(" | "));
    check(consoleErrors.length === 0, "browser reported no console errors", consoleErrors.join(" | "));
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    checks.push({ name: "smoke execution", status: "failed", detail: failure });
  }

  if (page) {
    try {
      if (await page.getByRole("dialog").count()) {
        lastDimensions = await assertNoHorizontalOverflow(page);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failure = failure ? `${failure}; final geometry: ${message}` : `final geometry: ${message}`;
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
    schema: REPORT_SCHEMA,
    state: failure ? "failed" : "passed",
    fixture_only: true,
    actual_backend_runtime: false,
    qualification: "fixture_only_not_backend_runtime_or_science",
    unit_tests: "not_compiled_not_run",
    url: workspaceUrl,
    browser_channel: channel ?? "playwright_chromium",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    checks,
    passed_checks: checks.filter((entry) => entry.status === "passed").length,
    total_checks: checks.length,
    screenshots,
    last_dimensions: lastDimensions,
    page_errors: pageErrors,
    console_errors: consoleErrors,
    error: failure,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (failure) {
    console.error(JSON.stringify({ report: reportPath, state: "failed", error: failure }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ report: reportPath, state: "passed", checks: checks.length }, null, 2));
  }
}

checks = [];
await main();