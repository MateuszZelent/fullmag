import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const url = process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:3252/antenna-external-lead-inspection";
const storage = process.env.FULLMAG_PROJECT_STORAGE_ROOT;
const output = process.env.FULLMAG_ANTENNA_INSPECTION_REPORT_DIR;
if (!storage || !output || !isAbsolute(storage) || !isAbsolute(output)) throw new Error("Managed absolute storage/report paths are required");
const descendant = (root, path) => {
  const suffix = relative(root, path);
  return Boolean(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
};
const reportDirectory = resolve(output);
const realStorage = await realpath(storage);
if (!descendant(resolve(storage), reportDirectory) || !descendant(realStorage, await realpath(dirname(reportDirectory)))) throw new Error("Reports must remain inside managed storage");
await mkdir(reportDirectory, { recursive: true });
if (!descendant(realStorage, await realpath(reportDirectory))) throw new Error("Report directory escaped managed storage");
const reportPath = resolve(reportDirectory, "antenna-external-lead-inspection.json");
const screenshots = [];
const checks = [];
const pageErrors = [];
const consoleErrors = [];
const timeout = 60_000;
const startedAt = new Date().toISOString();
let browser;
let page;
let failure = null;
let requestEvidence = null;

try {
  let playwright;
  try { playwright = await import("playwright"); }
  catch { playwright = await import("@playwright/test"); }
  const channel = process.env.FULLMAG_ANTENNA_INSPECTION_BROWSER_CHANNEL;
  if (channel && !["chrome", "msedge"].includes(channel)) throw new Error("Unsupported managed browser channel");
  browser = await playwright.chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, acceptDownloads: false });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) consoleErrors.push(message.text()); });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  await page.waitForFunction(() => Boolean(window.__antennaInspectionFixture), undefined, { timeout });
  const root = page.getByTestId("antenna-external-lead-inspection");
  const preview = page.getByTestId("antenna-inspection-sample-preview");
  const read = () => page.evaluate(() => window.__antennaInspectionFixture.read());
  const state = async (expected) => {
    await page.waitForFunction((value) => document.querySelector('[data-testid="antenna-external-lead-inspection"]')?.getAttribute("data-state") === value, expected, { timeout });
  };
  const screenshot = async (name) => {
    const path = resolve(reportDirectory, `${name}.png`);
    await page.screenshot({ path, fullPage: true });
    screenshots.push(path);
  };
  const samplesReady = async () => {
    await state("inspection_only");
    await page.waitForFunction(() => document.querySelector('[data-testid="antenna-inspection-sample-preview"]')?.getAttribute("data-preview-state") === "ready", undefined, { timeout });
    await preview.getByText("Sample 8 H", { exact: true }).waitFor({ state: "visible", timeout });
    assert.equal(await preview.locator(".fm-antenna-field-preview__sample").count(), 8);
  };

  await state("loading");
  await page.waitForFunction(() => window.__antennaInspectionFixture.read().pending > 0, undefined, { timeout });
  assert.equal(await preview.count(), 0, "Unresolved metadata displayed a ready sample preview");
  await screenshot("01-loading");
  await page.evaluate(() => window.__antennaInspectionFixture.release());
  await samplesReady();
  assert.ok((await root.innerText()).includes("NOT VERIFIED"));
  assert.ok((await root.innerText()).includes("external_electrode_truncation"));
  assert.ok((await preview.innerText()).includes("8 of 32"));
  assert.ok((await preview.innerText()).includes("A/m"));
  assert.equal((await preview.innerText()).includes("A/m/A"), false);
  const initial = await read();
  const payloads = initial.calls.filter((call) => call.status === 206);
  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads.map((call) => call.path.split("/").at(-1)).sort(), ["magnetic_field", "sample_positions"]);
  for (const call of payloads) {
    assert.equal(call.range, "bytes=0-191");
    assert.equal(call.digest, `sha256:${"a".repeat(64)}`);
    assert.ok(call.scope.includes(`request_scope_epoch=${encodeURIComponent(initial.requestScopeEpoch)}`));
    assert.ok(call.path.includes("runtime-stage-009"));
  }
  assert.equal(initial.unexpected.length, 0);
  checks.push({ name: "loading is honest; exact runtime mapping loads only two digest/scoped bounded SI carriers", passed: true, requests: initial.calls.length });
  await screenshot("02-success");

  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="antenna-external-lead-inspection"]');
    const scroll = document.querySelector('[data-testid="antenna-fixture-scroll"]');
    const trigger = root.querySelector('[data-slot="inspector-group-trigger"]');
    const marker = document.querySelector('[data-testid="antenna-fixture-focus"]');
    trigger.focus({ preventScroll: true });
    scroll.scrollTop = scroll.scrollHeight;
    if (scroll.scrollTop <= 0) throw new Error("Actual production panel does not overflow; bottom-scroll proof is inconclusive");
    const controls = [trigger, marker];
    const baseline = controls.map((element) => ({ element, disabled: element.disabled, opacity: getComputedStyle(element).opacity }));
    const proof = { root, trigger, scroll, scrollTop: scroll.scrollTop, baseline, rootChanged: 0, disabledChanges: 0, opacityChanges: 0, activeOpacityAnimations: 0, maxScrollDelta: 0 };
    const sample = () => {
      if (document.querySelector('[data-testid="antenna-external-lead-inspection"]') !== root) proof.rootChanged += 1;
      proof.maxScrollDelta = Math.max(proof.maxScrollDelta, Math.abs(scroll.scrollTop - proof.scrollTop));
      for (const entry of baseline) {
        if (entry.element.disabled !== entry.disabled) proof.disabledChanges += 1;
        if (getComputedStyle(entry.element).opacity !== entry.opacity) proof.opacityChanges += 1;
      }
      proof.activeOpacityAnimations += root.getAnimations({ subtree: true }).filter((animation) => (animation.playState === "running" || animation.pending) && animation.effect?.getKeyframes().some((frame) => "opacity" in frame)).length;
    };
    const observer = new MutationObserver(sample);
    observer.observe(root, { attributes: true, childList: true, subtree: true });
    window.__antennaInspectionStability = { proof, sample, observer };
    sample();
  });
  const beforeRefresh = await read();
  await screenshot("03-refresh-before");
  await page.evaluate(() => window.__antennaInspectionFixture.refresh());
  await page.waitForFunction(() => window.__antennaInspectionFixture.read().pending > 0, undefined, { timeout });
  await state("loading");
  assert.equal(await preview.getAttribute("data-preview-state"), "loading", "Refresh presented stale numerical samples as ready");
  await page.evaluate(() => window.__antennaInspectionStability.sample());
  await screenshot("04-refresh-pending");
  await page.evaluate(() => window.__antennaInspectionFixture.release());
  await samplesReady();
  const stability = await page.evaluate(() => {
    const { proof, sample, observer } = window.__antennaInspectionStability;
    sample(); observer.disconnect();
    return {
      rootChanged: proof.rootChanged, disabledChanges: proof.disabledChanges, opacityChanges: proof.opacityChanges,
      activeOpacityAnimations: proof.activeOpacityAnimations, focusPreserved: document.activeElement === proof.trigger,
      scrollDelta: Math.abs(proof.scroll.scrollTop - proof.scrollTop), maxScrollDelta: proof.maxScrollDelta,
    };
  });
  assert.deepEqual(stability, { rootChanged: 0, disabledChanges: 0, opacityChanges: 0, activeOpacityAnimations: 0, focusPreserved: true, scrollDelta: 0, maxScrollDelta: 0 });
  const afterRefresh = await read();
  assert.ok(afterRefresh.calls.length - beforeRefresh.calls.length <= 18, "Refresh exceeded the bounded request budget");
  assert.ok(afterRefresh.renderCommits - beforeRefresh.renderCommits <= 40, "Refresh exceeded the bounded render budget");
  checks.push({ name: "resource invalidation preserves Inspector root, focus, scroll and unrelated controls", passed: true, ...stability, requests: afterRefresh.calls.length - beforeRefresh.calls.length, renders: afterRefresh.renderCommits - beforeRefresh.renderCommits });
  await screenshot("05-refresh-after");
  await page.waitForTimeout(250);
  const idle = await read();
  assert.equal(idle.calls.length, afterRefresh.calls.length, "Inspector fetched while idle");
  assert.equal(idle.renderCommits, afterRefresh.renderCommits, "Inspector rendered while idle");
  checks.push({ name: "settled Inspector remains idle without polling", passed: true });

  for (const [scenario, expected] of [
    ["failed", "failed"], ["cancelled", "cancelled"], ["mismatch", "identity_mismatch"],
    ["multiple", "ambiguous"], ["stale_owner", "identity_mismatch"], ["stale_metadata", "identity_mismatch"],
    ["unavailable", "unavailable"], ["error", "error"],
  ]) {
    const before = await read();
    await page.evaluate((value) => window.__antennaInspectionFixture.setScenario(value), scenario);
    await state(expected);
    assert.equal(await preview.count(), 0, `${scenario} retained numerical preview`);
    const result = await read();
    const scenarioCalls = result.calls.slice(before.calls.length);
    assert.equal(scenarioCalls.filter((call) => call.status === 206).length, 0, `${scenario} served a numerical payload`);
    assert.equal(result.unexpected.length, 0, `${scenario} issued an unexpected read`);
    assert.ok(scenarioCalls.length <= 18, `${scenario} exceeded its request bound`);
    if (["multiple", "unavailable", "stale_owner"].includes(scenario)) {
      assert.equal(scenarioCalls.filter((call) => call.status === 200 && call.path.endsWith("/external-lead-inspection")).length, 0, `${scenario} auto-selected an inspection`);
    }
    checks.push({ name: `${scenario} fails closed without qualified/automatic payload reads`, passed: true, requests: scenarioCalls.length });
    await screenshot(`case-${scenario}`);
  }

  // Exercise the shared Radix selector through real keyboard interaction;
  // identical visible labels must never serve as execution identity.
  await page.evaluate(() => window.__antennaInspectionFixture.setScenario("multiple"));
  await state("ambiguous");
  const executionSelect = page.getByRole("combobox", { name: "Inspection execution" });
  await executionSelect.waitFor({ state: "visible", timeout });
  assert.equal(await executionSelect.getAttribute("data-testid"), "antenna-inspection-execution-select");
  const multipleBefore = await read();
  await page.evaluate(() => {
    window.__antennaInspectionSelectionRoot = document.querySelector('[data-testid="antenna-external-lead-inspection"]');
  });
  const choose = async (stageId) => {
    await executionSelect.focus();
    await executionSelect.press("Space");
    await page.getByRole("listbox").waitFor({ state: "visible", timeout });
    const options = page.getByRole("option");
    assert.equal(await options.count(), 2, "Only exact mapped executions may appear as options");
    for (const id of ["runtime-stage-009", "duplicate-stage-010"]) {
      assert.match(await options.filter({ hasText: id }).innerText(), /completed/);
    }
    await page.keyboard.press(stageId === "duplicate-stage-010" ? "End" : "Home");
    // Radix schedules keyboard focus movement; commit only after the exact
    // intended option owns focus, not while the previously focused item does.
    await page.waitForFunction((id) => {
      const option = [...document.querySelectorAll('[role="option"]')]
        .find((element) => element.textContent.includes(id));
      return option && document.activeElement === option;
    }, stageId, { timeout });
    await page.keyboard.press("Enter");
    await page.waitForFunction((id) => document.querySelector('[data-testid="antenna-inspection-execution-select"]')?.textContent.includes(id), stageId, { timeout });
    await samplesReady();
    assert.ok((await executionSelect.innerText()).includes(stageId));
    assert.equal(await page.evaluate(() => document.querySelector('[data-testid="antenna-external-lead-inspection"]') === window.__antennaInspectionSelectionRoot), true, "Selecting execution remounted the Inspector");
    const sample = await preview.locator(".fm-antenna-field-preview__sample").first().innerText();
    const expected = stageId === "duplicate-stage-010" ? "(1.001e+3, 1.002e+3, 1.003e+3)" : "(1.000e+0, 2.000e+0, 3.000e+0)";
    assert.ok(sample.includes(expected), `Selected ${stageId} displayed a different execution's raw field`);
  };
  const assertChosenReads = (calls, stageId) => {
    const selectedReads = calls.filter((call) => call.path.includes("/external-lead-inspection"));
    assert.ok(selectedReads.length > 0, "Selection did not produce inspection read evidence");
    for (const call of selectedReads) assert.ok(call.path.includes(`/${stageId}/`), `Selection read a foreign runtime stage: ${call.path}`);
    for (const call of selectedReads.filter((entry) => entry.status === 206)) {
      assert.equal(call.digest, `sha256:${(stageId === "duplicate-stage-010" ? "c" : "a").repeat(64)}`);
      assert.equal(call.range, "bytes=0-191");
    }
  };
  await choose("duplicate-stage-010");
  const secondSelected = await read();
  assertChosenReads(secondSelected.calls.slice(multipleBefore.calls.length), "duplicate-stage-010");
  await screenshot("selection-second");
  await choose("runtime-stage-009");
  const firstSelected = await read();
  assertChosenReads(firstSelected.calls.slice(secondSelected.calls.length), "runtime-stage-009");
  checks.push({ name: "keyboard selection resolves exact runtime IDs and separate digest/raw-H carriers without remount", passed: true });
  await screenshot("selection-first");

  await page.evaluate(() => window.__antennaInspectionFixture.refresh());
  await page.waitForFunction(() => window.__antennaInspectionFixture.read().pending > 0, undefined, { timeout });
  await state("loading");
  assert.ok((await executionSelect.innerText()).includes("runtime-stage-009"), "Same-owner revision refresh discarded explicit execution selection");
  await page.evaluate(() => window.__antennaInspectionFixture.release());
  await samplesReady();
  assert.ok((await executionSelect.innerText()).includes("runtime-stage-009"));
  const selectionRefresh = await read();
  assertChosenReads(selectionRefresh.calls.slice(firstSelected.calls.length), "runtime-stage-009");
  checks.push({ name: "explicit selection survives same-owner and same-run resource revision refresh", passed: true });

  await choose("duplicate-stage-010");
  await page.evaluate(() => window.__antennaInspectionFixture.holdStage("duplicate-stage-010"));
  await page.waitForFunction(() => window.__antennaInspectionFixture.read().pending > 0, undefined, { timeout });
  await state("loading");
  const heldSecond = await read();
  await choose("runtime-stage-009");
  const switchedFirst = await read();
  assertChosenReads(switchedFirst.calls.slice(heldSecond.calls.length), "runtime-stage-009");
  assert.ok(switchedFirst.pending > 0, "Delayed old-selection request disappeared before the stale-response check");
  await page.evaluate(() => window.__antennaInspectionFixture.releaseStage("duplicate-stage-010"));
  await page.waitForFunction(() => window.__antennaInspectionFixture.read().pending === 0, undefined, { timeout });
  await page.waitForTimeout(150);
  await samplesReady();
  assert.ok((await executionSelect.innerText()).includes("runtime-stage-009"));
  assert.ok((await preview.locator(".fm-antenna-field-preview__sample").first().innerText()).includes("(1.000e+0, 2.000e+0, 3.000e+0)"));
  const releasedSecond = await read();
  assert.equal(releasedSecond.calls.filter((call) => call.status === 206).length, switchedFirst.calls.filter((call) => call.status === 206).length, "Delayed former selection triggered new numerical payload reads");
  checks.push({ name: "delayed metadata from former selection cannot replace chosen result even when transport ignores abort", passed: true });
  await screenshot("selection-stale-response-rejected");

  const beforeNewRun = await read();
  await page.evaluate(() => window.__antennaInspectionFixture.nextRun());
  await page.waitForFunction(() => {
    const record = window.__antennaInspectionFixture.read();
    return record.calls.some((call) => call.path.endsWith("/stages/execution") && call.revision === record.revision);
  }, undefined, { timeout });
  await state("ambiguous");
  assert.equal(await preview.count(), 0, "New run retained old-run numerical preview");
  const newRun = await read();
  assert.equal(newRun.requestScopeEpoch, beforeNewRun.requestScopeEpoch, "Run invalidation fixture incorrectly changed session incarnation");
  assert.notEqual(newRun.runId, beforeNewRun.runId);
  assert.equal(newRun.calls.slice(beforeNewRun.calls.length).filter((call) => call.path.includes("/external-lead-inspection")).length, 0, "New run automatically reused former execution choice");
  await page.evaluate(() => window.__antennaInspectionFixture.previousRun());
  await page.waitForFunction(() => {
    const record = window.__antennaInspectionFixture.read();
    return record.calls.some((call) => call.path.endsWith("/stages/execution") && call.revision === record.revision);
  }, undefined, { timeout });
  await state("ambiguous");
  const priorRun = await read();
  assert.equal(priorRun.runId, beforeNewRun.runId);
  assert.equal(priorRun.calls.slice(newRun.calls.length).filter((call) => call.path.includes("/external-lead-inspection")).length, 0, "Run round-trip resurrected a cleared execution choice");
  checks.push({ name: "same-incarnation run changes invalidate explicit selection; returning to old run does not resurrect it", passed: true });
  await screenshot("selection-new-run-cleared");

  await choose("duplicate-stage-010");
  await page.evaluate(() => {
    const main = document.querySelector('[data-antenna-inspection-fixture]');
    main.style.width = "360px"; main.style.padding = "16px"; main.style.boxSizing = "border-box";
    const scroll = document.querySelector('[data-testid="antenna-fixture-scroll"]');
    scroll.style.padding = "8px"; scroll.scrollTop = 0;
  });
  const narrow = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="antenna-external-lead-inspection"]');
    const scroll = document.querySelector('[data-testid="antenna-fixture-scroll"]');
    const select = document.querySelector('[data-testid="antenna-inspection-execution-select"]');
    return { panelWidth: root.getBoundingClientRect().width, horizontalOverflow: scroll.scrollWidth - scroll.clientWidth, selectorWidth: select.getBoundingClientRect().width, selectorFontPx: Number.parseFloat(getComputedStyle(select).fontSize) };
  });
  assert.ok(narrow.panelWidth >= 250 && narrow.panelWidth <= 340, "Readability fixture did not constrain the real Inspector width");
  assert.ok(narrow.horizontalOverflow <= 1, "Narrow Inspector content overflows horizontally");
  assert.ok(narrow.selectorWidth <= narrow.panelWidth && narrow.selectorFontPx >= 10, "Narrow execution selector is unreadable or exceeds Inspector bounds");
  await screenshot("selection-narrow-inspector");
  await executionSelect.click();
  await page.getByRole("listbox").waitFor({ state: "visible", timeout });
  await page.waitForFunction(() => {
    const listbox = document.querySelector('[role="listbox"]');
    return listbox && getComputedStyle(listbox).opacity === "1" &&
      listbox.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running" && !animation.pending);
  }, undefined, { timeout });
  const narrowOptions = await page.getByRole("option").evaluateAll((options) => options.map((option) => ({ text: option.textContent, overflow: option.scrollWidth - option.clientWidth, fontPx: Number.parseFloat(getComputedStyle(option).fontSize) })));
  assert.equal(narrowOptions.length, 2);
  for (const option of narrowOptions) { assert.ok(option.overflow <= 1); assert.ok(option.fontPx >= 10); }
  await screenshot("selection-narrow-options");
  await page.keyboard.press("Escape");
  checks.push({ name: "narrow Inspector and shared dropdown retain readable exact execution identities without horizontal overflow", passed: true, ...narrow, options: narrowOptions });
  const final = await read();
  assert.ok(final.calls.length <= 100, "Inspection workflow exceeded its total request budget");
  assert.ok(final.renderCommits <= 500, "Inspection workflow exceeded its total render budget");
  requestEvidence = final;
  assert.equal(final.unexpected.length, 0);
  assert.equal(pageErrors.length, 0, pageErrors.join(" | "));
  assert.equal(consoleErrors.length, 0, consoleErrors.join(" | "));
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  if (page) {
    try { requestEvidence = await page.evaluate(() => window.__antennaInspectionFixture?.read() ?? null); } catch { /* Preserve the original failure when the page is unavailable. */ }
    try { const path = resolve(reportDirectory, "failure.png"); await page.screenshot({ path, fullPage: true }); screenshots.push(path); }
    catch (screenshotError) { failure += `; screenshot: ${String(screenshotError)}`; }
  }
} finally {
  if (browser) { try { await browser.close(); } catch (error) { failure = `${failure ?? ""}; browser cleanup: ${String(error)}`; } }
}
const report = {
  schema: "fullmag_antenna_inspection_browser_fixture_v1", state: failure ? "failed" : "passed",
  qualification: "fixture_only_not_backend_runtime_or_science", fixture_only: true, actual_backend_runtime: false,
  production_hooks: true, production_resource_layer: true, transport: "controlled_ControlRoomApi_GET_responses",
  unit_tests: "not_compiled_not_run", url, started_at: startedAt, finished_at: new Date().toISOString(),
  checks, screenshots, request_evidence: requestEvidence, page_errors: pageErrors, console_errors: consoleErrors, error: failure,
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ report: reportPath, state: report.state, checks: checks.length, error: failure }));
process.exitCode = failure ? 1 : 0;
