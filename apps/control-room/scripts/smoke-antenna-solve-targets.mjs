import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const url = process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:3256/antenna-solve-targets";
const storage = process.env.FULLMAG_PROJECT_STORAGE_ROOT;
const output = process.env.FULLMAG_ANTENNA_SOLVE_TARGETS_REPORT_DIR;
if (!storage || !output || !isAbsolute(storage) || !isAbsolute(output)) throw new Error("Managed absolute storage/report paths are required");
const inside = (root, path) => { const suffix = relative(root, path); return Boolean(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); };
const reportDirectory = resolve(output), realStorage = await realpath(storage);
if (!inside(resolve(storage), reportDirectory) || !inside(realStorage, await realpath(dirname(reportDirectory)))) throw new Error("Report directory escaped managed storage");
await mkdir(reportDirectory, { recursive: true });
if (!inside(realStorage, await realpath(reportDirectory))) throw new Error("Report directory escaped real managed storage");
const checks = [], screenshots = [], pageErrors = [], consoleErrors = [], workflows = [];
let browser, page, failure = null;
const startedAt = new Date().toISOString(), timeout = 30_000;
const objectKey = JSON.stringify(["object", "immutable-waveguide"]), regionKey = JSON.stringify(["region", "immutable-waveguide", "core"]);
try {
  let playwright;
  try { playwright = await import("playwright"); } catch { playwright = await import("@playwright/test"); }
  const channel = process.env.FULLMAG_ANTENNA_SOLVE_TARGETS_BROWSER_CHANNEL;
  if (channel && !["chrome", "msedge"].includes(channel)) throw new Error("Unsupported browser channel");
  browser = await playwright.chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  page = await browser.newPage({ viewport: { width: 1300, height: 950 } });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) consoleErrors.push(message.text()); });
  const editor = page.getByTestId("solve-editor"), select = editor.getByRole("combobox", { name: "Add field-solve target", exact: true });
  const button = (name) => editor.getByRole("button", { name, exact: true });
  const click = (name) => button(name).evaluate((element) => element.click());
  const read = () => page.evaluate(() => window.__antennaSolveTargetsFixture.read());
  const writes = (state) => state.calls.filter((call) => call.method === "POST");
  const wait = (predicate) => page.waitForFunction(predicate, undefined, { timeout });
  const screenshot = async (name) => { const path = resolve(reportDirectory, `${name}.png`); await page.screenshot({ path, fullPage: true }); screenshots.push(path); };
  const ready = async () => { await select.waitFor({ timeout }); await page.waitForFunction(() => !document.querySelector('[data-testid="solve-editor"] select')?.disabled, undefined, { timeout }); };
  const boot = async () => { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }); await wait(() => Boolean(window.__antennaSolveTargetsFixture)); await ready(); };
  const add = async (value) => { await select.selectOption(value); await click("Add target"); };
  const apply = async () => { await button("Apply field-solve targets").waitFor(); assert.equal(await button("Apply field-solve targets").isDisabled(), false); await click("Apply field-solve targets"); await wait(() => window.__antennaSolveTargetsFixture.read().pending === 1); };
  const release = async () => { await page.evaluate(() => window.__antennaSolveTargetsFixture.release()); await wait(() => window.__antennaSolveTargetsFixture.read().pending === 0); };
  const budget = async (label) => {
    const final = await read();
    assert.equal(final.unexpected.length, 0, JSON.stringify(final.unexpected));
    assert.ok(final.calls.length <= 45, `${label}: unbounded requests ${final.calls.length}`);
    assert.ok(final.renders <= 120, `${label}: unbounded renders ${final.renders}`);
    for (const call of final.calls.filter((call) => call.path.endsWith("/model/scene") || call.method === "POST")) assert.ok(call.scope?.includes("request_scope_epoch=") && call.scope.includes("epoch="), "Missing confirmed scope");
    workflows.push({ label, ...final });
  };

  await boot();
  await add(objectKey);
  await select.selectOption(regionKey);
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="solve-editor"] [data-slot="inspector-group"]');
    const input = root.querySelector("select"), scroll = document.querySelector('[data-testid="solve-scroll"]');
    scroll.scrollTop = 100; input.focus({ preventScroll: true });
    if (scroll.scrollTop < 50) throw new Error("Fixture lacks actual scroll overflow");
    const controls = [input, document.querySelector('[data-testid="solve-unrelated"]')];
    const proof = { root, input, scroll, scrollTop: scroll.scrollTop, controls: controls.map((element) => ({ element, disabled: element.disabled, opacity: getComputedStyle(element).opacity })), rootChanges: 0, controlChanges: 0, disabledChanges: 0, opacityChanges: 0, opacityAnimations: 0, maxScrollDelta: 0 };
    const sample = () => {
      if (document.querySelector('[data-testid="solve-editor"] [data-slot="inspector-group"]') !== root) proof.rootChanges++;
      proof.maxScrollDelta = Math.max(proof.maxScrollDelta, Math.abs(scroll.scrollTop - proof.scrollTop));
      for (const saved of proof.controls) {
        if (!saved.element.isConnected) proof.controlChanges++;
        if (saved.element.disabled !== saved.disabled) proof.disabledChanges++;
        if (getComputedStyle(saved.element).opacity !== saved.opacity) proof.opacityChanges++;
      }
      proof.opacityAnimations += root.getAnimations({ subtree: true }).filter((animation) => (animation.playState === "running" || animation.pending) && animation.effect?.getKeyframes().some((frame) => "opacity" in frame)).length;
    };
    const observer = new MutationObserver(sample); observer.observe(root, { subtree: true, attributes: true, childList: true });
    window.__solveStability = { proof, sample, observer }; sample();
  });
  await screenshot("01-before-apply");
  const before = await read();
  await apply();
  assert.equal(await select.isDisabled(), false);
  assert.equal(await button("Revert targets").isDisabled(), true);
  const pending = await read();
  assert.equal(writes(pending).length, 1);
  assert.equal(writes(pending)[0].body.base_revision, 1);
  assert.deepEqual(Object.keys(writes(pending)[0].body.merge_patch), ["antenna_field_solve_stages"]);
  assert.deepEqual(writes(pending)[0].body.merge_patch.antenna_field_solve_stages[0].target_refs, [{ kind: "global" }, { kind: "object", object_id: "immutable-waveguide" }]);
  await click("Add target");
  await screenshot("02-pending-newer-region-draft");
  await release();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="solve-editor"] button')].some((button) => button.textContent === "Apply field-solve targets" && !button.disabled), undefined, { timeout });
  assert.equal(await editor.getByRole("button", { name: /^Remove field-solve target/ }).count(), 3);
  assert.equal(await select.inputValue(), regionKey);
  assert.equal(await button("Rebase targets").count(), 0);
  const proof = await page.evaluate(() => {
    const { proof, sample, observer } = window.__solveStability; sample(); observer.disconnect();
    return { rootChanges: proof.rootChanges, controlChanges: proof.controlChanges, disabledChanges: proof.disabledChanges, opacityChanges: proof.opacityChanges, opacityAnimations: proof.opacityAnimations, focus: document.activeElement === proof.input, maxScrollDelta: proof.maxScrollDelta };
  });
  assert.deepEqual(proof, { rootChanges: 0, controlChanges: 0, disabledChanges: 0, opacityChanges: 0, opacityAnimations: 0, focus: true, maxScrollDelta: 0 });
  const after = await read();
  assert.ok(after.calls.length - before.calls.length <= 12);
  assert.ok(after.renders - before.renders <= 45);
  checks.push({ name: "delayed ACK retains newer region draft, root/focus/scroll and unrelated controls", passed: true, proof, requests: after.calls.length - before.calls.length, renders: after.renders - before.renders });
  await screenshot("03-ack-retained-newer-draft");
  await apply();
  const second = writes(await read())[1];
  assert.equal(second.body.base_revision, 2);
  assert.deepEqual(second.body.merge_patch.antenna_field_solve_stages[0].target_refs[2], { kind: "region", object_id: "immutable-waveguide", region_id: "core" });
  await release();
  await wait(() => document.querySelector('[data-testid="solve-dirty"]')?.textContent === "false");
  await budget("two explicit writes preserve region and ACK revision");

  await boot(); await add(regionKey);
  await page.evaluate(() => window.__antennaSolveTargetsFixture.conflict());
  await button("Rebase targets").waitFor({ timeout });
  assert.equal(await button("Apply field-solve targets").isDisabled(), true);
  assert.equal(writes(await read()).length, 0);
  await screenshot("04-explicit-conflict");
  await click("Rebase targets"); await apply();
  assert.equal(writes(await read())[0].body.base_revision, 2);
  await release();
  await wait(() => document.querySelector('[data-testid="solve-dirty"]')?.textContent === "false");
  checks.push({ name: "external scene revision blocks writes until explicit rebase", passed: true });
  await budget("conflict and explicit rebase");

  await boot(); await add(objectKey); await apply();
  await page.evaluate(() => window.__antennaSolveTargetsFixture.resetHistory());
  const resetBefore = await read();
  await release();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="solve-editor"] button')].some((button) => button.textContent === "Apply field-solve targets" && !button.disabled), undefined, { timeout });
  const resetAfter = await read();
  assert.equal(resetAfter.canUndo, false); assert.equal(resetAfter.invalidations, resetBefore.invalidations);
  assert.equal(await page.getByTestId("solve-dirty").textContent(), "true");
  assert.equal(await editor.getByText(/Field-solve targets committed/).count(), 0);
  await click("Revert targets");
  await wait(() => document.querySelector('[data-testid="solve-dirty"]')?.textContent === "false");
  checks.push({ name: "history reset fences late ACK publication and retains dirty draft until explicit revert", passed: true });
  await budget("history reset and explicit draft reset");

  await boot(); await add(objectKey); await apply();
  await page.evaluate(() => window.__antennaSolveTargetsFixture.switchSession("B"));
  await page.getByTestId("solve-owner").filter({ hasText: "session-B" }).waitFor({ timeout }); await ready();
  await page.evaluate(() => window.__antennaSolveTargetsFixture.switchSession("A"));
  await page.getByTestId("solve-owner").filter({ hasText: "session-A" }).waitFor({ timeout }); await ready();
  await add(regionKey);
  const abaBefore = await read();
  await release(); await page.waitForTimeout(350);
  const abaAfter = await read();
  assert.equal(abaAfter.canUndo, false); assert.equal(abaAfter.invalidations, abaBefore.invalidations);
  assert.equal(await editor.getByRole("button", { name: /^Remove field-solve target/ }).count(), 2);
  assert.equal(await select.inputValue(), regionKey);
  assert.equal(await page.getByTestId("solve-dirty").textContent(), "true");
  assert.equal(await editor.getByText(/Field-solve targets committed/).count(), 0);
  checks.push({ name: "session A→B→A fences old owner token despite identical returned session identity", passed: true });
  await screenshot("05-aba-stale-ack-retained-current-draft");
  await budget("session ABA");
  const idle = await read(); await page.waitForTimeout(600); const settled = await read();
  assert.equal(settled.calls.length, idle.calls.length); assert.equal(settled.renders, idle.renders);
  assert.equal(pageErrors.length, 0, pageErrors.join(" | ")); assert.equal(consoleErrors.length, 0, consoleErrors.join(" | "));
  checks.push({ name: "settled fixture has bounded requests/renders and no polling or runtime errors", passed: true });
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  if (page) {
    try { workflows.push({ label: "failure", ...(await page.evaluate(() => window.__antennaSolveTargetsFixture?.read() ?? {})) }); } catch { /* Preserve original failure. */ }
    try { const path = resolve(reportDirectory, "failure.png"); await page.screenshot({ path, fullPage: true }); screenshots.push(path); } catch { /* Preserve original failure. */ }
  }
} finally { if (browser) await browser.close(); }
const report = { schema: "fullmag_antenna_solve_targets_browser_fixture_v1", state: failure ? "failed" : "passed", qualification: "actual_production_component_controlled_transport_not_backend_runtime_or_science", unit_tests: "not_compiled_not_run", url, startedAt, finishedAt: new Date().toISOString(), checks, screenshots, workflows, pageErrors, consoleErrors, error: failure };
const reportPath = resolve(reportDirectory, "antenna-solve-targets.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ report: reportPath, state: report.state, checks: checks.length, error: failure }));
process.exitCode = failure ? 1 : 0;
