import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const url = process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:3264/antenna-port-editor";
const storage = process.env.FULLMAG_PROJECT_STORAGE_ROOT, output = process.env.FULLMAG_ANTENNA_PORT_EDITOR_REPORT_DIR;
if (!storage || !output || !isAbsolute(storage) || !isAbsolute(output)) throw new Error("Managed absolute paths are required");
const inside = (root, path) => { const suffix = relative(root, path); return Boolean(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); };
const reportDirectory = resolve(output), realStorage = await realpath(storage);
if (!inside(resolve(storage), reportDirectory) || !inside(realStorage, await realpath(dirname(reportDirectory)))) throw new Error("Report escaped managed storage");
await mkdir(reportDirectory, { recursive: true });
if (!inside(realStorage, await realpath(reportDirectory))) throw new Error("Report escaped real managed storage");
const checks = [], screenshots = [], workflows = [], pageErrors = [], consoleErrors = [];
let browser, page, failure = null;
const startedAt = new Date().toISOString(), timeout = 30_000;
try {
  const playwright = await import("playwright"), channel = process.env.FULLMAG_ANTENNA_PORT_EDITOR_BROWSER_CHANNEL;
  if (channel && !["chrome", "msedge"].includes(channel)) throw new Error("Unsupported browser channel");
  browser = await playwright.chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  page = await browser.newPage({ viewport: { width: 1300, height: 950 } });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) consoleErrors.push(message.text()); });
  const editor = page.getByTestId("port-editor"), field = (name) => editor.getByRole("textbox", { name, exact: true });
  const button = (name) => editor.getByRole("button", { name, exact: true });
  const click = (name) => button(name).evaluate((element) => element.click());
  const read = () => page.evaluate(() => window.__antennaPortEditorFixture.read());
  const writes = (value) => value.calls.filter((call) => call.method === "POST");
  const wait = (predicate) => page.waitForFunction(predicate, undefined, { timeout });
  const boot = async () => { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await wait(() => Boolean(window.__antennaPortEditorFixture)); await field("Branch 1 ID").waitFor({ timeout });
    await wait(() => [...document.querySelectorAll('[data-testid="port-editor"] input')].some((input) => !input.disabled)); };
  const apply = async () => { assert.equal(await button("Apply port").isDisabled(), false); await click("Apply port");
    await wait(() => window.__antennaPortEditorFixture.read().pending === 1); };
  const release = async () => { await page.evaluate(() => window.__antennaPortEditorFixture.release());
    await wait(() => window.__antennaPortEditorFixture.read().pending === 0); };
  const screenshot = async (name) => { const path = resolve(reportDirectory, `${name}.png`); await page.screenshot({ path, fullPage: true }); screenshots.push(path); };
  const budget = async (label) => { const value = await read(); assert.deepEqual(value.unexpected, []);
    assert.ok(value.calls.length <= 45 && value.renders <= 140, `${label}: request/render budget exceeded`);
    for (const call of value.calls.filter((call) => call.method === "POST" || call.path.endsWith("/model/scene"))) assert.ok(call.scope?.includes("request_scope_epoch="), "Missing confirmed scope");
    workflows.push({ label, ...value }); };

  await boot();
  const original = await read(), unrelated = original.scene.antenna_port_modes[1];
  await field("Branch 1 signed weight").fill("0");
  assert.equal(await button("Apply port").isDisabled(), true);
  assert.equal(writes(await read()).length, 0);
  await field("Branch 1 signed weight").fill("1");
  await field("Branch 1 inlet terminal").fill("missing");
  assert.equal(await button("Apply port").isDisabled(), true);
  await field("Branch 1 inlet terminal").fill("signal-in");
  await click("Add branch");
  assert.equal(await field("Branch 3 ID").inputValue(), "");
  assert.equal(await field("Branch 3 inlet terminal").inputValue(), "");
  assert.equal(await field("Branch 3 signed weight").inputValue(), "");
  assert.equal(await button("Apply port").isDisabled(), true);
  await click("Remove port branch 3");
  await field("Current transport").fill("missing-transport");
  assert.equal(await button("Apply port").isDisabled(), true);
  await field("Current transport").fill("alternative");
  checks.push({ name: "invalid weights/missing terminals/explicit empty branch block writes", passed: true });

  await field("Branch 1 ID").fill("edited-signal");
  await page.getByTestId("port-unrelated").fill("retained draft");
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="port-editor"] [data-slot="inspector-group"]');
    const input = root.querySelectorAll("input")[1], scroll = document.querySelector('[data-testid="port-scroll"]');
    scroll.scrollTop = 70; input.focus({ preventScroll: true });
    const unrelated = document.querySelector('[data-testid="port-unrelated"]');
    const proof = { root, input, scroll, scrollTop: scroll.scrollTop,
      disabled: input.disabled, opacity: getComputedStyle(input).opacity,
      controls: [input, unrelated].map((element) => ({ element, disabled: element.disabled, opacity: getComputedStyle(element).opacity })),
      rootChanges: 0, controlChanges: 0, disabledChanges: 0, opacityChanges: 0, opacityAnimations: 0 };
    const sample = () => {
      if (document.querySelector('[data-testid="port-editor"] [data-slot="inspector-group"]') !== root) proof.rootChanges++;
      for (const saved of proof.controls) {
        if (!saved.element.isConnected) proof.controlChanges++;
        if (saved.element.disabled !== saved.disabled) proof.disabledChanges++;
        if (getComputedStyle(saved.element).opacity !== saved.opacity) proof.opacityChanges++;
      }
      proof.opacityAnimations += root.getAnimations({ subtree: true }).filter((animation) => (animation.playState === "running" || animation.pending) && animation.effect?.getKeyframes().some((frame) => "opacity" in frame)).length;
    };
    const observer = new MutationObserver(sample);
    observer.observe(root, { subtree: true, attributes: true, childList: true });
    observer.observe(unrelated, { attributes: true });
    window.__portEditorStable = { ...proof, proof, sample, observer }; sample();
  });
  await screenshot("01-before-apply"); await apply();
  const pending = writes(await read())[0];
  assert.equal(pending.body.base_revision, 1);
  assert.deepEqual(Object.keys(pending.body.merge_patch), ["antenna_port_modes"]);
  assert.deepEqual(pending.body.merge_patch.antenna_port_modes[1], unrelated);
  assert.equal(pending.body.merge_patch.antenna_port_modes[0].source_object_id, "antenna-source");
  assert.equal(pending.body.merge_patch.antenna_port_modes[0].normalization_current_a, 1);
  assert.equal(pending.body.merge_patch.antenna_port_modes[0].current_transport_id, "alternative");
  assert.equal(await field("Branch 1 ID").isDisabled(), false);
  await field("Branch 1 ID").fill("newer-signal");
  // Restore focus without scrolling after Playwright's fill; measure pending/ACK, not test navigation.
  await page.evaluate(() => { const saved = window.__portEditorStable; saved.scroll.scrollTop = saved.scrollTop; saved.input.focus({ preventScroll: true }); });
  await screenshot("02-pending-newer-draft"); await release();
  await wait(() => [...document.querySelectorAll('[data-testid="port-editor"] button')].some((button) => button.textContent === "Apply port" && !button.disabled));
  assert.equal(await field("Branch 1 ID").inputValue(), "newer-signal");
  assert.equal(await page.getByTestId("port-dirty").textContent(), "true");
  const stable = await page.evaluate(() => { const saved = window.__portEditorStable; saved.sample(); saved.observer.disconnect(); return {
    root: document.querySelector('[data-testid="port-editor"] [data-slot="inspector-group"]') === saved.root,
    input: saved.input.isConnected, focus: document.activeElement === saved.input,
    disabled: saved.input.disabled === saved.disabled, opacity: getComputedStyle(saved.input).opacity === saved.opacity,
    scroll: saved.scroll.scrollTop === saved.scrollTop,
    animations: saved.root.getAnimations({ subtree: true }).filter((animation) => (animation.playState === "running" || animation.pending) && animation.effect?.getKeyframes().some((frame) => "opacity" in frame)).length,
    rootChanges: saved.proof.rootChanges, controlChanges: saved.proof.controlChanges,
    disabledChanges: saved.proof.disabledChanges, opacityChanges: saved.proof.opacityChanges, opacityAnimations: saved.proof.opacityAnimations,
  }; });
  assert.deepEqual(stable, { root: true, input: true, focus: true, disabled: true, opacity: true, scroll: true, animations: 0,
    rootChanges: 0, controlChanges: 0, disabledChanges: 0, opacityChanges: 0, opacityAnimations: 0 });
  assert.equal(await page.getByTestId("port-unrelated").inputValue(), "retained draft");
  await apply(); assert.equal(writes(await read())[1].body.base_revision, 2); await release();
  await wait(() => document.querySelector('[data-testid="port-dirty"]')?.textContent === "false");
  const committed = await read(); assert.equal(committed.scene.antenna_port_modes[0].branches[0].id, "newer-signal");
  assert.deepEqual(committed.scene.antenna_port_modes[1], unrelated); assert.equal(committed.canUndo, true);
  checks.push({ name: "exact merge patch, immutable identities, newer draft survives delayed ACK and history records write", passed: true, stable });
  await screenshot("03-committed"); await budget("delayed ACK");

  await boot();
  const beforeBranches = await read();
  await field("Branch 2 signed weight").fill("-0.5"); await click("Add branch");
  await field("Branch 3 ID").fill("return2");
  await field("Branch 3 inlet terminal").fill("return2-in");
  await field("Branch 3 outlet terminal").fill("return2-out");
  await field("Branch 3 signed weight").fill("-0.5"); await apply();
  const addedWrite = writes(await read())[0].body;
  assert.equal(addedWrite.base_revision, 1);
  assert.deepEqual(Object.keys(addedWrite.merge_patch), ["antenna_port_modes"]);
  assert.deepEqual(addedWrite.merge_patch.antenna_port_modes[0].branches.map((branch) => branch.signed_weight), [1, -0.5, -0.5]);
  assert.deepEqual(addedWrite.merge_patch.antenna_port_modes[1], beforeBranches.scene.antenna_port_modes[1]);
  await release(); await wait(() => document.querySelector('[data-testid="port-dirty"]')?.textContent === "false");
  assert.deepEqual((await read()).scene.current_transports, beforeBranches.scene.current_transports);
  // Edit the new branch after its ACK to verify originalId rebinding, not only a one-shot addition.
  await field("Branch 3 ID").fill("renamed-return2"); await apply(); await release();
  await wait(() => document.querySelector('[data-testid="port-dirty"]')?.textContent === "false");
  assert.equal((await read()).scene.antenna_port_modes[0].branches[2].id, "renamed-return2");
  await click("Remove port branch 3"); await field("Branch 2 signed weight").fill("-1"); await apply();
  const removedWrite = writes(await read())[2].body;
  assert.equal(removedWrite.base_revision, 3);
  assert.deepEqual(removedWrite.merge_patch.antenna_port_modes[0].branches, beforeBranches.scene.antenna_port_modes[0].branches);
  await release(); await wait(() => document.querySelector('[data-testid="port-dirty"]')?.textContent === "false");
  assert.deepEqual((await read()).scene.current_transports, beforeBranches.scene.current_transports);
  assert.equal((await read()).canUndo, true);
  checks.push({ name: "explicit branch addition, acknowledged rename and removal preserve transport and unrelated port", passed: true });
  await budget("branch addition and removal");

  await boot(); await field("Branch 1 ID").fill("local-rename");
  await page.evaluate(() => window.__antennaPortEditorFixture.conflict("remote-rename"));
  await button("Rebase port").waitFor({ timeout }); await click("Rebase port");
  await editor.getByText("Original branch 'signal' changed or is ambiguous. Revert and edit the current port.", { exact: true }).waitFor({ timeout });
  assert.equal(await field("Branch 1 ID").inputValue(), "local-rename");
  assert.equal(await button("Apply port").isDisabled(), true); assert.equal(writes(await read()).length, 0);
  await click("Revert port");
  assert.equal(await field("Branch 1 ID").inputValue(), "remote-rename");
  assert.equal(await page.getByTestId("port-dirty").textContent(), "false");
  checks.push({ name: "remote branch identity change cannot be resurrected by explicit rebase", passed: true });
  await budget("remote branch identity");

  await boot(); await field("Branch 1 ID").fill("conflict-draft");
  await page.evaluate(() => window.__antennaPortEditorFixture.conflict());
  await button("Rebase port").waitFor({ timeout });
  assert.equal(await button("Apply port").isDisabled(), true); assert.equal(writes(await read()).length, 0);
  await click("Rebase port"); await apply(); assert.equal(writes(await read())[0].body.base_revision, 2);
  await release(); await wait(() => document.querySelector('[data-testid="port-dirty"]')?.textContent === "false");
  checks.push({ name: "external scene revision needs explicit rebase", passed: true }); await budget("revision conflict");

  await boot(); await field("Branch 1 ID").fill("rejected-draft");
  await page.evaluate(() => window.__antennaPortEditorFixture.rejectNext()); await click("Apply port");
  await button("Rebase port").waitFor({ timeout });
  assert.equal(await field("Branch 1 ID").inputValue(), "rejected-draft");
  assert.equal(await button("Apply port").isDisabled(), true); assert.equal(writes(await read()).length, 1);
  await click("Rebase port"); await apply(); await release();
  await wait(() => document.querySelector('[data-testid="port-dirty"]')?.textContent === "false");
  checks.push({ name: "HTTP409 preserves draft without implicit retry", passed: true }); await budget("HTTP409");

  for (const malformed of ["normalization", "scene_revision"]) {
    await boot(); await field("Branch 1 ID").fill("bad-ack-draft");
    await page.evaluate((kind) => window.__antennaPortEditorFixture.malformedNext(kind), malformed); await apply(); await release();
    await button("Rebase port").waitFor({ timeout });
    assert.equal(await field("Branch 1 ID").inputValue(), "bad-ack-draft");
    assert.equal(await page.getByTestId("port-dirty").textContent(), "true");
    assert.equal((await read()).canUndo, false);
    assert.equal(await button("Apply port").isDisabled(), true);
    checks.push({ name: `malformed ${malformed} ACK rejected before history publication`, passed: true }); await budget(`malformed ACK ${malformed}`);
  }

  await boot(); await field("Branch 1 ID").fill("history-draft"); await apply();
  await page.evaluate(() => window.__antennaPortEditorFixture.resetHistory()); const fenced = await read();
  await release(); await page.waitForTimeout(350); const reset = await read();
  assert.equal(reset.canUndo, false); assert.equal(reset.invalidations, fenced.invalidations);
  assert.equal(await field("Branch 1 ID").inputValue(), "history-draft");
  assert.equal(await page.getByTestId("port-dirty").textContent(), "true");
  checks.push({ name: "history generation fences stale ACK", passed: true }); await budget("history reset");

  await boot(); await field("Branch 1 ID").fill("old-owner-draft"); await apply();
  await page.evaluate(() => window.__antennaPortEditorFixture.switchSession("B"));
  await page.getByTestId("port-owner").filter({ hasText: "session-B" }).waitFor({ timeout });
  await page.evaluate(() => window.__antennaPortEditorFixture.switchSession("A"));
  await page.getByTestId("port-owner").filter({ hasText: "session-A" }).waitFor({ timeout });
  await field("Branch 1 ID").fill("new-owner-draft"); const abaBefore = await read();
  await release(); await page.waitForTimeout(350); const abaAfter = await read();
  assert.equal(abaAfter.invalidations, abaBefore.invalidations); assert.equal(abaAfter.canUndo, false);
  assert.equal(await field("Branch 1 ID").inputValue(), "new-owner-draft");
  checks.push({ name: "session ABA fences old owner despite same IDs", passed: true }); await budget("session ABA");
  const beforeIdle = await read(); await page.waitForTimeout(700); const afterIdle = await read();
  assert.equal(afterIdle.calls.length, beforeIdle.calls.length); assert.equal(afterIdle.renders, beforeIdle.renders);
  assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []);
  checks.push({ name: "bounded requests/renders and settled idle", passed: true });
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  if (page) {
    try { workflows.push({ label: "failure", ...(await page.evaluate(() => window.__antennaPortEditorFixture?.read() ?? {})) }); } catch { /* Preserve original failure. */ }
    try { const path = resolve(reportDirectory, "failure.png"); await page.screenshot({ path, fullPage: true }); screenshots.push(path); } catch { /* Preserve original failure. */ }
  }
} finally { if (browser) await browser.close(); }
const report = { schema: "fullmag_antenna_port_editor_browser_fixture_v1", state: failure ? "failed" : "passed",
  qualification: "production_authoring_controlled_HTTP_not_backend_runtime_or_science", unit_tests: "not_compiled_not_run",
  url, startedAt, finishedAt: new Date().toISOString(), checks, screenshots, workflows, pageErrors, consoleErrors, error: failure };
const reportPath = resolve(reportDirectory, "antenna-port-editor.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ report: reportPath, state: report.state, checks: checks.length, error: failure }));
process.exitCode = failure ? 1 : 0;
