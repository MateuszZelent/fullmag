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
  const terminal = name => editor.getByRole("combobox", { name, exact: true });
  const button = (name) => editor.getByRole("button", { name, exact: true });
  const click = (name) => button(name).evaluate((element) => element.click());
  const read = () => page.evaluate(() => window.__antennaPortEditorFixture.read());
  const writes = (value) => value.calls.filter((call) => call.method === "POST");
  const wait = (predicate) => page.waitForFunction(predicate, undefined, { timeout });
  const boot = async (scenario = "", creator = false) => { const location = new URL(url); if (creator) location.searchParams.set("creator", "1"); if (scenario) location.searchParams.set("scenario", scenario); await page.goto(location.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await wait(() => Boolean(window.__antennaPortEditorFixture)); await field(creator ? "New port ID" : "Branch 1 ID").waitFor({ timeout });
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

  for (const scenario of ["malformed-source", "structured-v3"]) {
    await boot(scenario);
    const inlet = terminal("Branch 1 inlet terminal");
    assert.equal(await inlet.inputValue(), "signal-in");
    assert.equal(await inlet.locator('option[value="signal-in"]').isDisabled(), true);
    assert.equal(await inlet.locator("option:not([disabled])").count(), 0, "Unavailable observations must never borrow valid boundary IDs");
    assert.ok((await editor.innerText()).includes("No selectable terminal inventory"));
    assert.equal(writes(await read()).length, 0);
    if (scenario === "malformed-source") {
      await field("Branch 1 ID").fill("invalid-source-draft");
      assert.equal(await button("Apply port").isDisabled(), true);
    }
    checks.push({ name: `${scenario}: selected reference is preserved without borrowing boundary terminals`, passed: true });
    await screenshot(scenario);
  }
  await boot();
  const original = await read(), unrelated = original.scene.antenna_port_modes[1];
  await field("Branch 1 signed weight").fill("0");
  assert.equal(await button("Apply port").isDisabled(), true);
  assert.equal(writes(await read()).length, 0);
  await field("Branch 1 signed weight").fill("1");
  const inlet = terminal("Branch 1 inlet terminal");
  assert.equal(await inlet.inputValue(), "signal-in");
  assert.equal(await inlet.locator('option[value="missing"]').count(), 0);
  assert.equal(await inlet.locator('option[value="return2-in"]').textContent(), "return2-in · Return");
  await inlet.selectOption("return2-in");
  assert.equal(await button("Apply port").isDisabled(), true);
  await inlet.selectOption("signal-in");
  const outlet = terminal("Branch 2 outlet terminal");
  await outlet.selectOption("return2-out");
  assert.equal(await button("Apply port").isDisabled(), false);
  await outlet.selectOption("return-out");
  checks.push({ name: "Terminal pickers list existing IDs with object labels; mismatched conductor endpoints block writes", passed: true });
  await click("Add branch");
  assert.equal(await field("Branch 3 ID").inputValue(), "");
  assert.equal(await terminal("Branch 3 inlet terminal").inputValue(), "");
  assert.equal(await field("Branch 3 signed weight").inputValue(), "");
  assert.equal(await button("Apply port").isDisabled(), true);
  await click("Remove port branch 3");
  await field("Current transport").fill("missing-transport");
  assert.equal(await button("Apply port").isDisabled(), true);
  assert.equal(await inlet.inputValue(), "signal-in", "Missing inventory must not rewrite the draft");
  assert.equal(await inlet.locator('option[value="signal-in"]').isDisabled(), true);
  assert.ok((await inlet.locator('option[value="signal-in"]').textContent()).includes("unavailable"));
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
  await terminal("Branch 3 inlet terminal").selectOption("return2-in");
  await terminal("Branch 3 outlet terminal").selectOption("return2-out");
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

  for (const malformed of ["normalization", "scene_revision", "scene_id"]) {
    await boot(); await field("Branch 1 ID").fill("bad-ack-draft");
    await page.evaluate((kind) => window.__antennaPortEditorFixture.malformedNext(kind), malformed); await apply(); await release();
    await button("Rebase port").waitFor({ timeout });
    assert.equal(await field("Branch 1 ID").inputValue(), "bad-ack-draft");
    assert.equal(await page.getByTestId("port-dirty").textContent(), "true");
    assert.equal((await read()).canUndo, false);
    assert.equal(await button("Apply port").isDisabled(), true);
    checks.push({ name: `malformed ${malformed} ACK rejected before history publication`, passed: true }); await budget(`malformed ACK ${malformed}`);
  }

  await boot("prepared-v3");
  const preparedInlet = terminal("Branch 1 inlet terminal");
  assert.equal(await preparedInlet.locator('option[value="signal-in"]').isDisabled(), false);
  assert.equal(await preparedInlet.locator('option[value="return2-in"]').count(), 0, "v3 pickers must use actual source observations, never unrelated boundary IDs");
  assert.equal(await preparedInlet.locator("option:not([disabled])").count(), 4);
  await field("Branch 1 ID").fill("v3-submitted-draft");
  await page.getByTestId("port-unrelated").fill("v3-unrelated-draft");
  await page.evaluate(() => {
    window.__antennaPortEditorFixture.watchSceneCache();
    window.__antennaPortEditorFixture.malformedNext("source_cut");
    const root = document.querySelector('[data-testid="port-editor"] [data-slot="inspector-group"]');
    const input = root.querySelectorAll("input")[1], scroll = document.querySelector('[data-testid="port-scroll"]');
    const unrelated = document.querySelector('[data-testid="port-unrelated"]');
    scroll.scrollTop = 70; input.focus({ preventScroll: true });
    const proof = { root, input, scroll, top: scroll.scrollTop, rootChanges: 0, controlChanges: 0,
      disabledChanges: 0, opacityChanges: 0, opacityAnimations: 0,
      controls: [input, unrelated].map(element => ({ element, disabled: element.disabled, opacity: getComputedStyle(element).opacity })) };
    const sample = () => {
      if (document.querySelector('[data-testid="port-editor"] [data-slot="inspector-group"]') !== root) proof.rootChanges++;
      for (const saved of proof.controls) {
        if (!saved.element.isConnected) proof.controlChanges++;
        if (saved.element.disabled !== saved.disabled) proof.disabledChanges++;
        if (getComputedStyle(saved.element).opacity !== saved.opacity) proof.opacityChanges++;
      }
      proof.opacityAnimations += root.getAnimations({ subtree: true }).filter(animation => (animation.playState === "running" || animation.pending) && animation.effect?.getKeyframes().some(frame => "opacity" in frame)).length;
    };
    const observer = new MutationObserver(sample);
    observer.observe(root, { subtree: true, attributes: true, childList: true }); observer.observe(unrelated, { attributes: true });
    window.__v3BadAckStable = { proof, sample, observer }; sample();
  });
  await apply();
  await field("Branch 1 ID").fill("v3-newer-draft");
  await page.evaluate(() => { const { proof } = window.__v3BadAckStable; proof.scroll.scrollTop = proof.top; proof.input.focus({ preventScroll: true }); });
  await release();
  await button("Rebase port").waitFor({ timeout });
  await editor.getByText(/Port ACK omitted or changed the submitted scene/).waitFor({ timeout });
  assert.equal(await field("Branch 1 ID").inputValue(), "v3-newer-draft");
  assert.equal(await page.getByTestId("port-unrelated").inputValue(), "v3-unrelated-draft");
  assert.equal(await page.getByTestId("port-dirty").textContent(), "true");
  assert.equal(await button("Apply port").isDisabled(), true);
  await wait(() => window.__antennaPortEditorFixture.read().sceneCacheTrace.some(observation => observation.revision === 2));
  const v3BadAckState = await read();
  assert.equal(writes(v3BadAckState).length, 1, "Bad ACK must never cause an implicit retry");
  assert.equal(v3BadAckState.canUndo, false, "Rejected normalization must not enter history");
  assert.ok(v3BadAckState.sceneCacheTrace.length > 0);
  for (const observation of v3BadAckState.sceneCacheTrace) {
    assert.equal(observation.sourceCutRef, "cut", "Rejected port normalization must never be published to the scene cache");
    assert.equal(observation.transportCutRef, "cut", "Rejected source binding must never be published to the scene cache");
  }
  const v3BadAckStable = await page.evaluate(() => {
    const { proof, sample, observer } = window.__v3BadAckStable; sample(); observer.disconnect();
    window.__antennaPortEditorFixture.stopWatchingSceneCache();
    return { root: document.querySelector('[data-testid="port-editor"] [data-slot="inspector-group"]') === proof.root,
      input: proof.input.isConnected && proof.root.querySelectorAll("input")[1] === proof.input,
      focus: document.activeElement === proof.input, scroll: proof.scroll.scrollTop === proof.top,
      rootChanges: proof.rootChanges, controlChanges: proof.controlChanges, disabledChanges: proof.disabledChanges,
      opacityChanges: proof.opacityChanges, opacityAnimations: proof.opacityAnimations };
  });
  assert.deepEqual(v3BadAckStable, { root: true, input: true, focus: true, scroll: true, rootChanges: 0,
    controlChanges: 0, disabledChanges: 0, opacityChanges: 0, opacityAnimations: 0 });
  checks.push({ name: "Prepared v3 rejects a changed source-cut ACK before history/cache publication while preserving newer draft, focus and scroll", passed: true, stable: v3BadAckStable });
  await screenshot("v3-source-cut-bad-ack"); await budget("prepared v3 source-cut ACK refusal");

  await boot(); await field("Branch 1 ID").fill("history-draft"); await apply();
  await page.evaluate(() => window.__antennaPortEditorFixture.resetHistory()); const fenced = await read();
  await release(); await page.waitForTimeout(350); const reset = await read();
  assert.equal(reset.canUndo, false); assert.equal(reset.invalidations, fenced.invalidations);
  assert.equal(await field("Branch 1 ID").inputValue(), "history-draft");
  assert.equal(await page.getByTestId("port-dirty").textContent(), "true");
  checks.push({ name: "history generation fences stale ACK", passed: true }); await budget("history reset");

  await boot(); await field("Branch 1 ID").fill("old-owner-draft"); await apply();
  await page.evaluate(() => window.__antennaPortEditorFixture.switchSession("B"));
  await page.getByTestId("port-owner").filter({ hasText: "restored-model-B" }).waitFor({ timeout });
  await page.evaluate(() => window.__antennaPortEditorFixture.switchSession("A"));
  await page.getByTestId("port-owner").filter({ hasText: "restored-model-A" }).waitFor({ timeout });
  await field("Branch 1 ID").fill("new-owner-draft"); const abaBefore = await read();
  await release(); await page.waitForTimeout(350); const abaAfter = await read();
  assert.equal(abaAfter.invalidations, abaBefore.invalidations); assert.equal(abaAfter.canUndo, false);
  assert.equal(await field("Branch 1 ID").inputValue(), "new-owner-draft");
  checks.push({ name: "session ABA fences old owner despite same IDs", passed: true }); await budget("session ABA");
  const composer = editor.getByTestId("antenna-port-composer");
  const newField = name => composer.getByRole("textbox", { name, exact: true });
  const newSelect = name => composer.getByRole("combobox", { name, exact: true });
  const newButton = name => composer.getByRole("button", { name, exact: true });
  const fillPort = async (id = "created-port") => {
    await newField("New port ID").fill(id);
    await newSelect("New port transport").selectOption("transport");
    for (const [index, branch, inlet, outlet, weight] of [[1, "signal", "signal-in", "signal-out", "1"], [2, "return", "return-in", "return-out", "-1"]]) {
      await newField(`New port branch ${index} ID`).fill(branch);
      await newSelect(`New port branch ${index} inlet terminal`).selectOption(inlet);
      await newSelect(`New port branch ${index} outlet terminal`).selectOption(outlet);
      await newField(`New port branch ${index} signed weight`).fill(weight);
    }
  };
  const createPort = async () => { assert.equal(await newButton("Create port").isEnabled(), true); await newButton("Create port").evaluate(button => button.click()); await wait(() => window.__antennaPortEditorFixture.read().pending === 1); };

  await boot("", true);
  const material = field("Layout conductor conductivity");
  await material.fill("59000000");
  await wait(() => document.querySelector('[data-testid="port-global-valid"]')?.textContent === "true");
  await newField("New port ID").fill("creator-draft");
  await wait(() => document.querySelector('[data-testid="port-global-valid"]')?.textContent === "false");
  assert.ok((await page.getByTestId("port-global-reason").innerText()).includes("each edited form"));
  await newButton("Discard new port draft").click();
  assert.equal(await material.inputValue(), "59000000");
  await wait(() => document.querySelector('[data-testid="port-global-valid"]')?.textContent === "true");
  await page.getByRole("button", { name: "Discard conductor changes", exact: true }).click();
  assert.equal(await material.inputValue(), "58000000");
  assert.equal(writes(await read()).length, 0);
  checks.push({ name: "Material and new-port drafts share one global guard without hiding or discarding each other", passed: true });

  await fillPort(); await material.fill("59000000");
  const creatorBefore = await read();
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="antenna-port-composer"]');
    const input = root.querySelector("input"), material = document.querySelector('[data-testid="port-editor"] input');
    const scroll = document.querySelector('[data-testid="port-scroll"]');
    input.focus({ preventScroll: true });
    const proof = { root, input, scroll, scrollTop: scroll.scrollTop, material, disabled: material.disabled, opacity: getComputedStyle(material).opacity,
      rootChanges: 0, disabledChanges: 0, opacityChanges: 0, opacityAnimations: 0 };
    const sample = () => {
      if (root !== document.querySelector('[data-testid="antenna-port-composer"]')) proof.rootChanges++;
      if (material.disabled !== proof.disabled) proof.disabledChanges++;
      if (getComputedStyle(material).opacity !== proof.opacity) proof.opacityChanges++;
      proof.opacityAnimations += root.getAnimations({ subtree: true }).filter(animation => (animation.playState === "running" || animation.pending) && animation.effect?.getKeyframes().some(frame => "opacity" in frame)).length;
    };
    const observer = new MutationObserver(sample); observer.observe(root, { subtree: true, childList: true, attributes: true }); observer.observe(material, { attributes: true });
    window.__portCreatorStability = { proof, sample, observer };
  });
  await screenshot("creator-before"); await createPort();
  const submittedPorts = writes(await read())[0].body.merge_patch.antenna_port_modes;
  assert.deepEqual(submittedPorts.slice(0, -1), creatorBefore.scene.antenna_port_modes);
  assert.equal(submittedPorts.at(-1).id, "created-port");
  assert.equal(submittedPorts.at(-1).normalization_current_a, 1);
  await newField("New port ID").fill("newer-port-draft");
  await page.evaluate(() => { const { proof } = window.__portCreatorStability; proof.scroll.scrollTop = proof.scrollTop; proof.input.focus({ preventScroll: true }); });
  await release();
  await wait(() => [...document.querySelectorAll('[data-testid="antenna-port-composer"] button')].some(button => button.textContent === "Create port" && !button.disabled));
  assert.equal(await newField("New port ID").inputValue(), "newer-port-draft");
  assert.equal(await material.inputValue(), "59000000");
  const created = await read();
  assert.equal(created.canUndo, true);
  assert.deepEqual(created.scene.objects, creatorBefore.scene.objects);
  assert.deepEqual(created.scene.current_transports, creatorBefore.scene.current_transports);
  assert.equal(created.scene.antenna_port_modes.length, creatorBefore.scene.antenna_port_modes.length + 1);
  const creatorProof = await page.evaluate(() => { const { proof, sample, observer } = window.__portCreatorStability; sample(); observer.disconnect(); return {
    rootChanges: proof.rootChanges, disabledChanges: proof.disabledChanges, opacityChanges: proof.opacityChanges, opacityAnimations: proof.opacityAnimations,
    focus: document.activeElement === proof.input, scroll: proof.scroll.scrollTop === proof.scrollTop,
  }; });
  assert.deepEqual(creatorProof, { rootChanges: 0, disabledChanges: 0, opacityChanges: 0, opacityAnimations: 0, focus: true, scroll: true });
  assert.equal(await page.getByTestId("port-global-valid").textContent(), "false");
  checks.push({ name: "Create port appends only the new port; held ACK preserves newer creator/material drafts, root, focus, scroll and unrelated control state", passed: true, creatorProof });
  await screenshot("creator-ack"); await budget("creator ACK and aggregate guard");

  for (const malformed of ["normalization", "scene_revision", "scene_id"]) {
    await boot("", true); await fillPort();
    await page.evaluate(kind => window.__antennaPortEditorFixture.malformedNext(kind), malformed);
    await createPort(); await release();
    await newButton("Rebase new port draft explicitly").waitFor({ timeout });
    assert.equal((await read()).canUndo, false);
    assert.equal(await newField("New port ID").inputValue(), "created-port");
    assert.equal(await composer.getByText(/Port 'created-port' committed/).count(), 0);
    checks.push({ name: `creator malformed ${malformed} ACK is rejected before history/publication`, passed: true });
    await budget(`creator malformed ${malformed}`);
  }

  await boot("", true); await fillPort();
  await page.evaluate(() => window.__antennaPortEditorFixture.conflict());
  await newButton("Rebase new port draft explicitly").waitFor({ timeout });
  assert.equal(await newButton("Create port").isDisabled(), true);
  await newButton("Rebase new port draft explicitly").click();
  await createPort(); assert.equal(writes(await read())[0].body.base_revision, 2); await release();
  await wait(() => document.querySelector('[data-testid="port-dirty"]')?.textContent === "false");
  checks.push({ name: "Creator external revision requires explicit rebase and writes the current base", passed: true });

  await boot("structured-v3", true);
  await newField("New port ID").fill("refused-closed-loop-port");
  await newSelect("New port transport").selectOption("transport");
  assert.equal(await newButton("Create port").isDisabled(), true);
  assert.ok((await composer.innerText()).includes("Closed-loop sources require their explicit v3 port"));
  assert.equal(writes(await read()).length, 0);
  checks.push({ name: "Creator refuses an additional closed-loop port without source/cut fallback or writes", passed: true });
  await screenshot("creator-closed-loop-refused");

  await boot("", true); await fillPort("old-owner-port"); await createPort();
  await page.evaluate(() => window.__antennaPortEditorFixture.switchSession("B"));
  await page.getByTestId("port-owner").filter({ hasText: "restored-model-B" }).waitFor({ timeout });
  await page.evaluate(() => window.__antennaPortEditorFixture.switchSession("A"));
  await page.getByTestId("port-owner").filter({ hasText: "restored-model-A" }).waitFor({ timeout });
  await newField("New port ID").fill("current-owner-draft");
  const creatorAbaBefore = await read(); await release(); await page.waitForTimeout(350);
  const creatorAbaAfter = await read();
  assert.equal(creatorAbaAfter.canUndo, false); assert.equal(creatorAbaAfter.invalidations, creatorAbaBefore.invalidations);
  assert.equal(await newField("New port ID").inputValue(), "current-owner-draft");
  assert.equal(await composer.getByText(/old-owner-port.*committed/).count(), 0);
  checks.push({ name: "Creator session ABA fences old ACK and preserves the new owner's draft", passed: true });
  await budget("creator session ABA");
  await boot("composed-port-dependent");
  assert.equal(await button("Apply port").count(), 1, "The composed Inspector must expose exactly one port editor");
  assert.equal(await editor.getByText("Edit antenna port", { exact: true }).count(), 0, "The generic branch form must not duplicate the inventory editor");
  assert.equal(await button("Remove port (no cascade)").isDisabled(), true);
  assert.ok((await editor.innerText()).includes("dependent-solve"));
  assert.equal(writes(await read()).length, 0);
  checks.push({ name: "Composed port Inspector has one editor and blocks removal of a referenced port", passed: true });
  await screenshot("composed-port-dependent");

  await boot("composed-port");
  assert.equal(await button("Apply port").count(), 1);
  const composedUnrelated = (await read()).scene.antenna_port_modes[1];
  await terminal("Branch 2 outlet terminal").selectOption("return2-out");
  assert.equal(await page.getByTestId("port-global-discard").isDisabled(), false);
  await page.getByTestId("port-global-discard").evaluate(element => element.click());
  await wait(() => document.querySelector('[data-testid="port-dirty"]')?.textContent === "false");
  assert.equal(await terminal("Branch 2 outlet terminal").inputValue(), "return-out", "Global Discard must belong to the inventory editor");
  await terminal("Branch 2 outlet terminal").selectOption("return2-out");
  assert.equal(await button("Remove port (no cascade)").isDisabled(), true, "A port draft must block concurrent removal");
  await terminal("Branch 2 outlet terminal").evaluate(input => {
    const root = document.querySelector('[data-testid="port-editor"] > .fm-inspector-panel'), scroll = document.querySelector('[data-testid="port-scroll"]');
    const unrelated = document.querySelector('[data-testid="port-unrelated"]');
    scroll.scrollTop = 100; input.focus({ preventScroll: true });
    const proof = { root, input, scroll, top: scroll.scrollTop, changes: 0,
      controls: [input, unrelated].map(element => ({ element, disabled: element.disabled, opacity: getComputedStyle(element).opacity })) };
    const sample = () => {
      if (!root.isConnected || document.querySelector('[data-testid="port-editor"] .fm-inspector-panel') !== root) proof.changes++;
      for (const saved of proof.controls) if (!saved.element.isConnected || saved.element.disabled !== saved.disabled || getComputedStyle(saved.element).opacity !== saved.opacity) proof.changes++;
      if (root.getAnimations({ subtree: true }).some(animation => (animation.playState === "running" || animation.pending) && animation.effect?.getKeyframes().some(frame => "opacity" in frame))) proof.changes++;
    };
    const observer = new MutationObserver(sample); observer.observe(root, { subtree: true, childList: true, attributes: true }); observer.observe(unrelated, { attributes: true });
    window.__composedPortStable = { proof, sample, observer }; sample();
  });
  assert.equal(await page.getByTestId("port-global-apply").isDisabled(), false);
  await page.getByTestId("port-global-apply").evaluate(element => element.click());
  await wait(() => window.__antennaPortEditorFixture.read().pending === 1);
  assert.equal(await button("Remove port (no cascade)").isDisabled(), true, "A pending port mutation must block removal");
  await field("Branch 1 ID").fill("composed-newer-draft");
  await page.evaluate(() => { const { proof } = window.__composedPortStable; proof.scroll.scrollTop = proof.top; proof.input.focus({ preventScroll: true }); });
  await release();
  await wait(() => ![...document.querySelectorAll('[data-testid="port-editor"] button')].find(button => button.textContent === "Apply port")?.disabled);
  assert.equal(await field("Branch 1 ID").inputValue(), "composed-newer-draft");
  const composedStable = await page.evaluate(() => { const { proof, sample, observer } = window.__composedPortStable; sample(); observer.disconnect(); return { changes: proof.changes, focus: document.activeElement === proof.input, scroll: proof.scroll.scrollTop === proof.top }; });
  assert.deepEqual(composedStable, { changes: 0, focus: true, scroll: true });
  await page.getByTestId("port-global-discard").evaluate(element => element.click());
  await wait(() => document.querySelector('[data-testid="port-dirty"]')?.textContent === "false");
  assert.equal(await field("Branch 1 ID").inputValue(), "signal");
  checks.push({ name: "Composed port owns global Apply/Discard and preserves root, focus, scroll and newer draft through pending/ACK", passed: true, composedStable });
  await wait(() => window.__antennaPortEditorFixture.read().scene.antenna_port_modes[0].branches[1].outlet_terminal_ref === "return2-out");
  assert.equal(await terminal("Branch 2 outlet terminal").inputValue(), "return2-out");
  assert.equal(await button("Remove port (no cascade)").isDisabled(), false);
  await screenshot("composed-port-single-editor");
  await click("Remove port (no cascade)");
  await wait(() => window.__antennaPortEditorFixture.read().pending === 1);
  await release();
  await wait(() => !window.__antennaPortEditorFixture.read().scene.antenna_port_modes.some(port => port.id === "antenna-port"));
  assert.deepEqual((await read()).scene.antenna_port_modes, [composedUnrelated]);
  checks.push({ name: "Composed port edits through terminal inventory and removes only the unreferenced port", passed: true });
  await budget("composed port");

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
