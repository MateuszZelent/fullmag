import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const url = process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:3253/antenna-microstrip-stations";
const storage = process.env.FULLMAG_PROJECT_STORAGE_ROOT;
const output = process.env.FULLMAG_ANTENNA_STATIONS_REPORT_DIR;
if (!storage || !output || !isAbsolute(storage) || !isAbsolute(output)) throw new Error("Managed absolute storage/report paths are required");
const descendant = (root, path) => { const suffix = relative(root, path); return Boolean(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); };
const reportDirectory = resolve(output);
const realStorage = await realpath(storage);
if (!descendant(resolve(storage), reportDirectory) || !descendant(realStorage, await realpath(dirname(reportDirectory)))) throw new Error("Reports must remain inside managed storage");
await mkdir(reportDirectory, { recursive: true });
if (!descendant(realStorage, await realpath(reportDirectory))) throw new Error("Report directory escaped managed storage");
const reportPath = resolve(process.env.FULLMAG_ANTENNA_STATIONS_REPORT ?? resolve(reportDirectory, "antenna-microstrip-stations.json"));
if (!descendant(reportDirectory, reportPath)) throw new Error("Report file must remain inside the managed report directory");
const checks = [], screenshots = [], pageErrors = [], consoleErrors = [];
const timeout = 60_000;
const interpolatedWidth = (40e-9 + 20e-9) / 2;
const startedAt = new Date().toISOString();
let browser, page, failure = null, requestEvidence = null;

try {
  let playwright;
  try { playwright = await import("playwright"); } catch { playwright = await import("@playwright/test"); }
  const channel = process.env.FULLMAG_ANTENNA_STATIONS_BROWSER_CHANNEL;
  if (channel && !["chrome", "msedge"].includes(channel)) throw new Error("Unsupported managed browser channel");
  browser = await playwright.chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  for (const layout of ["microstrip", "cpw"]) {
  const layoutUrl = new URL(url);
  if (layout === "cpw") layoutUrl.searchParams.set("layout", "cpw");
  page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, acceptDownloads: false });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) consoleErrors.push(message.text()); });
  await page.goto(layoutUrl.href, { waitUntil: "domcontentloaded", timeout });
  await page.waitForFunction(() => Boolean(window.__antennaStationsFixture), undefined, { timeout });
  const editor = page.getByTestId("antenna-stations-editor");
  const read = () => page.evaluate(() => window.__antennaStationsFixture.read());
  const ready = async () => { await page.waitForFunction(() => document.querySelector('[data-testid="antenna-stations-editor"]')?.getAttribute("data-resource-status") === "ready", undefined, { timeout }); };
  const screenshot = async (name) => { const path = resolve(reportDirectory, `${layout}-${name}.png`); await page.screenshot({ path, fullPage: true }); screenshots.push(path); };
  const clickWithoutFocus = async (label) => editor.getByRole("button", { name: label, exact: true }).evaluate((button) => button.click());
  const values = () => editor.locator(".fm-microstrip-station").evaluateAll((rows) => rows.map((row) => [...row.querySelectorAll("input")].map((input) => input.value)));
  const expectValues = async (expected) => assert.deepEqual((await values()).map(([s, width]) => [Number(s), Number(width)]), expected);
  await ready();
  const originalParams = (await read()).scene.objects[0].geometry.geometry_params;
  assert.equal(await editor.locator(".fm-microstrip-station").first().locator("input").count(), layout === "cpw" ? 6 : 2);
  await expectValues([[0, 40e-9], [0.25, 30e-9], [0.75, 20e-9], [1, 10e-9]]);
  assert.equal(await editor.getByRole("button", { name: "Save conductor authoring", exact: true }).isDisabled(), true);
  await screenshot("01-before-remove");
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="antenna-stations-editor"] [data-slot="inspector-group"]');
    const rows = [...root.querySelectorAll(".fm-microstrip-station")];
    const row = rows[2], position = row.querySelectorAll("input")[0], width = row.querySelectorAll("input")[1];
    width.focus({ preventScroll: true }); width.setSelectionRange(1, 3);
    window.__antennaStationRetained = { root, row, position, width, first: rows[0], last: rows[3], start: width.selectionStart, end: width.selectionEnd };
  });
  await clickWithoutFocus("Remove station 2");
  await expectValues([[0, 40e-9], [0.75, 20e-9], [1, 10e-9]]);
  const removed = await page.evaluate(() => {
    const proof = window.__antennaStationRetained;
    const rows = [...document.querySelectorAll('[data-testid="antenna-stations-editor"] .fm-microstrip-station')];
    return { root: document.querySelector('[data-testid="antenna-stations-editor"] [data-slot="inspector-group"]') === proof.root, row: rows[1] === proof.row, position: rows[1].querySelectorAll("input")[0] === proof.position, width: rows[1].querySelectorAll("input")[1] === proof.width, first: rows[0] === proof.first, last: rows[2] === proof.last, focus: document.activeElement === proof.width, selection: [proof.width.selectionStart, proof.width.selectionEnd], initialSelection: [proof.start, proof.end] };
  });
  assert.equal(removed.row, true, "Removing the previous interior station replaced the surviving later row DOM identity");
  for (const field of ["root", "position", "width", "first", "last", "focus"]) assert.equal(removed[field], true, `Removal did not preserve ${field}`);
  assert.deepEqual(removed.selection, removed.initialSelection, "Removal changed active input selection range");
  checks.push({ name: "removal preserves the focused surviving row/input identities and selection, not merely values", passed: true, evidence: removed });
  await screenshot("02-after-remove");
  await clickWithoutFocus("Add station");
  await expectValues([[0, 40e-9], [0.375, interpolatedWidth], [0.75, 20e-9], [1, 10e-9]]);
  const inserted = await page.evaluate(() => {
    const proof = window.__antennaStationRetained;
    const rows = [...document.querySelectorAll('[data-testid="antenna-stations-editor"] .fm-microstrip-station')];
    return { row: rows[2] === proof.row, position: rows[2].querySelectorAll("input")[0] === proof.position, width: rows[2].querySelectorAll("input")[1] === proof.width, first: rows[0] === proof.first, last: rows[3] === proof.last, focus: document.activeElement === proof.width, selection: [proof.width.selectionStart, proof.width.selectionEnd] };
  });
  for (const field of ["row", "position", "width", "first", "last", "focus"]) assert.equal(inserted[field], true, `Insertion did not preserve ${field}`);
  assert.deepEqual(inserted.selection, removed.initialSelection);
  checks.push({ name: "insertion retains surviving identities and inserts correct interpolated controlled values", passed: true, evidence: inserted });
  await screenshot("03-after-insert");

  const retainedWidth = editor.getByRole("textbox", { name: "Station 3 signal width", exact: true });
  await retainedWidth.fill("18e-9");
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="antenna-stations-editor"] [data-slot="inspector-group"]');
    const scroll = document.querySelector('[data-testid="antenna-stations-scroll"]');
    const focus = window.__antennaStationRetained.width;
    focus.focus({ preventScroll: true }); focus.setSelectionRange(1, 3);
    scroll.scrollTop += focus.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 100;
    if (scroll.scrollTop < 50) throw new Error("Actual panel lacks scroll overflow; scroll proof is inconclusive");
    const controls = [...root.querySelectorAll("input"), root.querySelector('[data-slot="inspector-group-trigger"]'), ...[...root.querySelectorAll("button")].filter((button) => button.textContent === "Add station" || button.textContent?.startsWith("Remove station")), document.querySelector('[data-testid="antenna-stations-unrelated"]')];
    const proof = { root, scroll, scrollTop: scroll.scrollTop, focus, controls: controls.map((element) => ({ element, disabled: element.disabled, opacity: getComputedStyle(element).opacity })), rootChanged: 0, controlIdentityChanges: 0, disabledChanges: 0, opacityChanges: 0, activeOpacityAnimations: 0, maxScrollDelta: 0 };
    const sample = () => {
      if (document.querySelector('[data-testid="antenna-stations-editor"] [data-slot="inspector-group"]') !== root) proof.rootChanged += 1;
      proof.maxScrollDelta = Math.max(proof.maxScrollDelta, Math.abs(scroll.scrollTop - proof.scrollTop));
      for (const entry of proof.controls) {
        if (!entry.element.isConnected) proof.controlIdentityChanges += 1;
        if (entry.element.disabled !== entry.disabled) proof.disabledChanges += 1;
        if (getComputedStyle(entry.element).opacity !== entry.opacity) proof.opacityChanges += 1;
      }
      proof.activeOpacityAnimations += root.getAnimations({ subtree: true }).filter((animation) => (animation.playState === "running" || animation.pending) && animation.effect?.getKeyframes().some((frame) => "opacity" in frame)).length;
    };
    const observer = new MutationObserver(sample); observer.observe(root, { subtree: true, attributes: true, childList: true });
    window.__antennaStationStability = { proof, sample, observer }; sample();
  });
  const beforeWrite = await read();
  await screenshot("04-save-before");
  await clickWithoutFocus("Save conductor authoring");
  await page.waitForFunction(() => window.__antennaStationsFixture.read().pendingWrites === 1, undefined, { timeout });
  const pending = await read();
  const writes = pending.calls.filter((call) => call.method === "POST");
  assert.equal(writes.length, 1);
  assert.ok(writes[0].path.endsWith("/model/transactions"));
  assert.deepEqual(Object.keys(writes[0].body).sort(), ["base_revision", "geometry", "kind", "object_id"]);
  assert.equal(writes[0].body.kind, "patch_object_geometry");
  assert.equal(writes[0].body.base_revision, beforeWrite.revision);
  const submittedStations = writes[0].body.geometry.geometry_params.stations;
  const extraFields = ["left_gap_m", "right_gap_m", "left_ground_width_m", "right_ground_width_m"];
  const expectedStations = [{ s: 0, signal_width_m: 40e-9 }, { s: 0.375, signal_width_m: interpolatedWidth }, { s: 0.75, signal_width_m: 18e-9 }, { s: 1, signal_width_m: 10e-9 }];
  if (layout === "cpw") {
    for (let index = 0; index < expectedStations.length; index++) {
      for (const field of extraFields) expectedStations[index][field] = index === 1
        ? (originalParams.stations[0][field] + originalParams.stations[2][field]) / 2 : originalParams.stations[index][field];
    }
  }
  assert.deepEqual(submittedStations, expectedStations);
  for (const station of submittedStations) assert.deepEqual(Object.keys(station).sort(), ["s", "signal_width_m", ...(layout === "cpw" ? extraFields : [])].sort(), "UI-local row IDs leaked to canonical geometry JSON");
  assert.deepEqual({ ...writes[0].body.geometry.geometry_params, stations: [] }, { ...originalParams, stations: [] }, "Station edit changed unrelated physical parameters");
  assert.equal(await retainedWidth.isDisabled(), false);
  assert.equal(await editor.getByRole("button", { name: "Add station", exact: true }).isDisabled(), false);
  assert.equal(await editor.getByRole("button", { name: "Save conductor authoring", exact: true }).isDisabled(), true);
  await screenshot("05-save-pending");
  // Keep typing in the same controlled input while the submitted transaction is held.
  await retainedWidth.fill("17e-9");
  await retainedWidth.evaluate((input) => { input.setSelectionRange(1, 3); });
  await page.evaluate(() => window.__antennaStationsFixture.releaseWrite());
  await page.waitForFunction(() => window.__antennaStationsFixture.read().pendingWrites === 0 && document.querySelector('[data-testid="antenna-stations-editor"]')?.getAttribute("data-scene-revision") === "2", undefined, { timeout });
  await ready();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="antenna-stations-editor"] button')].some((button) => button.textContent === "Save conductor authoring" && !button.disabled), undefined, { timeout });
  assert.equal(await retainedWidth.inputValue(), "17e-9", "ACK overwrote the newer in-flight edit");
  assert.equal((await editor.innerText()).includes("Conductor geometry changed on the server"), false, "Own ACK produced a spurious geometry conflict");
  const committed = await read();
  assert.equal(committed.scene.objects[0].geometry.geometry_params.stations[2].signal_width_m, 18e-9);
  // A full committed_scene is published to the observed scoped cache. Do not
  // require a redundant GET for that same revision; explicit refresh is below.
  assert.equal(committed.calls.filter((call) => call.method === "GET" && call.path.endsWith("/model/scene")).length, beforeWrite.calls.filter((call) => call.method === "GET" && call.path.endsWith("/model/scene")).length, "Full scene ACK caused a redundant read of the already-published revision");
  for (const family of ["/model/scene", "/model/geometry/validation", "/model/geometry/diagnostics", "/model/readiness"]) assert.ok(committed.invalidations.some((entry) => entry.resourceKey.endsWith(family) && entry.revision === 2), `Missing canonical geometry dependent invalidation ${family}`);
  const stability = await page.evaluate(() => {
    const { proof, sample, observer } = window.__antennaStationStability; sample(); observer.disconnect();
    return { rootChanged: proof.rootChanged, controlIdentityChanges: proof.controlIdentityChanges, disabledChanges: proof.disabledChanges, opacityChanges: proof.opacityChanges, activeOpacityAnimations: proof.activeOpacityAnimations, focusPreserved: document.activeElement === proof.focus, selection: [proof.focus.selectionStart, proof.focus.selectionEnd], scrollDelta: Math.abs(proof.scroll.scrollTop - proof.scrollTop), maxScrollDelta: proof.maxScrollDelta };
  });
  assert.deepEqual(stability, { rootChanged: 0, controlIdentityChanges: 0, disabledChanges: 0, opacityChanges: 0, activeOpacityAnimations: 0, focusPreserved: true, selection: [1, 3], scrollDelta: 0, maxScrollDelta: 0 });
  assert.ok(committed.calls.length - beforeWrite.calls.length <= 12);
  assert.ok(committed.renderCommits - beforeWrite.renderCommits <= 45);
  checks.push({ name: "typed held geometry transaction excludes local IDs, ACK preserves pending edits and stable panel/controls/focus/scroll", passed: true, stability, requests: committed.calls.length - beforeWrite.calls.length, renders: committed.renderCommits - beforeWrite.renderCommits });
  await screenshot("06-save-ack-newer-draft");

  await clickWithoutFocus("Save conductor authoring");
  await page.waitForFunction(() => window.__antennaStationsFixture.read().pendingWrites === 1, undefined, { timeout });
  await page.evaluate(() => window.__antennaStationsFixture.releaseWrite());
  await page.waitForFunction(() => document.querySelector('[data-testid="antenna-stations-editor"]')?.getAttribute("data-scene-revision") === "3", undefined, { timeout });
  await ready();
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-testid="antenna-stations-editor"] button')].some((button) => button.textContent === "Revert draft"), undefined, { timeout });
  await expectValues([[0, 40e-9], [0.375, interpolatedWidth], [0.75, 17e-9], [1, 10e-9]]);
  assert.equal(await editor.getByRole("button", { name: "Save conductor authoring", exact: true }).isDisabled(), true);
  await retainedWidth.fill("17e-9");
  assert.equal(await editor.getByRole("button", { name: "Save conductor authoring", exact: true }).isDisabled(), true, "Numerically equivalent formatting created a redundant dirty transaction");
  assert.equal((await read()).calls.filter((call) => call.method === "POST").length, 2);
  checks.push({ name: "numeric-equivalent formatting stays clean without a redundant save or request", passed: true });
  assert.equal(await page.evaluate(() => window.__antennaStationRetained.width === document.querySelectorAll('[data-testid="antenna-stations-editor"] .fm-microstrip-station')[2].querySelectorAll("input")[1]), true, "Clean ACK replaced the surviving input");
  const followup = await read();
  assert.equal(followup.calls.filter((call) => call.method === "POST").length, 2);
  assert.equal(followup.scene.objects[0].geometry.geometry_params.stations[2].signal_width_m, 17e-9);
  checks.push({ name: "explicit follow-up save uses acknowledged revision and commits retained edit as a clean stable draft", passed: true });
  await screenshot("07-followup-clean");

  await retainedWidth.fill("16e-9");
  await clickWithoutFocus("Revert draft");
  await expectValues([[0, 40e-9], [0.375, interpolatedWidth], [0.75, 17e-9], [1, 10e-9]]);
  assert.equal(await editor.getByRole("button", { name: "Save conductor authoring", exact: true }).isDisabled(), true);
  checks.push({ name: "explicit revert restores acknowledged canonical station values without an implicit transaction", passed: true });
  await screenshot("08-revert");
  await retainedWidth.fill("15e-9");
  await retainedWidth.evaluate((input) => { input.focus({ preventScroll: true }); input.setSelectionRange(1, 3); });
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="antenna-stations-editor"] [data-slot="inspector-group"]');
    const input = document.querySelectorAll('[data-testid="antenna-stations-editor"] .fm-microstrip-station')[2].querySelectorAll("input")[1];
    const scroll = document.querySelector('[data-testid="antenna-stations-scroll"]'); scroll.scrollTop = 100;
    window.__antennaStationRefresh = { root, input, scroll, scrollTop: scroll.scrollTop };
  });
  const beforeRefresh = await read();
  await screenshot("09-unrelated-refresh-before");
  await page.evaluate(() => window.__antennaStationsFixture.refreshUnrelated());
  await page.waitForFunction(() => window.__antennaStationsFixture.read().pendingSceneReads > 0, undefined, { timeout });
  assert.equal(await retainedWidth.inputValue(), "15e-9");
  assert.equal(await retainedWidth.isDisabled(), false);
  await screenshot("10-unrelated-refresh-pending");
  await page.evaluate(() => window.__antennaStationsFixture.releaseScene());
  await page.waitForFunction(() => document.querySelector('[data-testid="antenna-stations-editor"]')?.getAttribute("data-scene-revision") === "4", undefined, { timeout });
  await ready();
  assert.equal(await retainedWidth.inputValue(), "15e-9");
  assert.equal((await editor.innerText()).includes("Conductor geometry changed on the server"), false);
  const refreshProof = await page.evaluate(() => {
    const proof = window.__antennaStationRefresh;
    return { root: document.querySelector('[data-testid="antenna-stations-editor"] [data-slot="inspector-group"]') === proof.root, input: document.querySelectorAll('[data-testid="antenna-stations-editor"] .fm-microstrip-station')[2].querySelectorAll("input")[1] === proof.input, focus: document.activeElement === proof.input, selection: [proof.input.selectionStart, proof.input.selectionEnd], scrollDelta: Math.abs(proof.scroll.scrollTop - proof.scrollTop), opacityAnimations: proof.root.getAnimations({ subtree: true }).filter((animation) => (animation.playState === "running" || animation.pending) && animation.effect?.getKeyframes().some((frame) => "opacity" in frame)).length };
  });
  assert.deepEqual(refreshProof, { root: true, input: true, focus: true, selection: [1, 3], scrollDelta: 0, opacityAnimations: 0 });
  const refreshed = await read();
  assert.ok(refreshed.calls.length - beforeRefresh.calls.length <= 6);
  assert.ok(refreshed.renderCommits - beforeRefresh.renderCommits <= 25);
  assert.equal(refreshed.calls.filter((call) => call.method === "POST").length, 2);
  checks.push({ name: "unrelated server refresh preserves dirty controlled draft, root/input/focus/selection/scroll without false conflict", passed: true, evidence: refreshProof });
  await screenshot("11-unrelated-refresh-after");

  await clickWithoutFocus("Revert draft");
  await editor.getByRole("textbox", { name: "Station 3 position", exact: true }).fill("0.8");
  await clickWithoutFocus("Save conductor authoring");
  await page.waitForFunction(() => window.__antennaStationsFixture.read().pendingWrites === 1, undefined, { timeout });
  await page.evaluate(() => window.__antennaStationsFixture.releaseWrite());
  await page.waitForFunction(() => document.querySelector('[data-testid="antenna-stations-editor"]')?.getAttribute("data-scene-revision") === "5", undefined, { timeout });
  await ready();
  await expectValues([[0, 40e-9], [0.375, interpolatedWidth], [0.8, 17e-9], [1, 10e-9]]);
  assert.equal(await editor.getByRole("button", { name: "Save conductor authoring", exact: true }).isDisabled(), true);
  await page.evaluate(() => {
    const row = document.querySelectorAll('[data-testid="antenna-stations-editor"] .fm-microstrip-station')[2];
    const input = row.querySelectorAll("input")[1];
    input.focus({ preventScroll: true }); input.setSelectionRange(1, 3);
    window.__antennaStationMoved = { row, input };
  });
  await screenshot("12-moved-station-before-server-insert");
  await page.evaluate(() => window.__antennaStationsFixture.insertFormerPosition());
  await page.waitForFunction(() => document.querySelector('[data-testid="antenna-stations-editor"]')?.getAttribute("data-scene-revision") === "6", undefined, { timeout });
  await ready();
  await expectValues([[0, 40e-9], [0.375, interpolatedWidth], [0.75, 19e-9], [0.8, 17e-9], [1, 10e-9]]);
  const movedProof = await page.evaluate(() => {
    const proof = window.__antennaStationMoved;
    const rows = [...document.querySelectorAll('[data-testid="antenna-stations-editor"] .fm-microstrip-station')];
    return { retainedRow: rows[3] === proof.row, retainedInput: rows[3].querySelectorAll("input")[1] === proof.input, separateNewRow: rows[2] !== proof.row, focus: document.activeElement === proof.input, selection: [proof.input.selectionStart, proof.input.selectionEnd] };
  });
  assert.deepEqual(movedProof, { retainedRow: true, retainedInput: true, separateNewRow: true, focus: true, selection: [1, 3] });
  assert.equal(await editor.getByRole("button", { name: "Save conductor authoring", exact: true }).isDisabled(), true, "Clean external geometry update retained obsolete local values");
  checks.push({ name: "server insertion at a moved station's former position cannot collide with its retained DOM identity", passed: true, evidence: movedProof });
  await screenshot("13-moved-station-after-server-insert");
  if (layout === "cpw") {
    const gap = editor.getByRole("textbox", { name: "Station 4 left gap", exact: true });
    await gap.fill("25e-9");
    await clickWithoutFocus("Save conductor authoring");
    await page.waitForFunction(() => window.__antennaStationsFixture.read().pendingWrites === 1, undefined, { timeout });
    const submitted = (await read()).calls.filter((call) => call.method === "POST").at(-1).body.geometry.geometry_params.stations[3];
    assert.equal(submitted.left_gap_m, 25e-9);
    await gap.fill("27e-9");
    await page.evaluate(() => window.__antennaStationsFixture.releaseWrite());
    await page.waitForFunction(() => document.querySelector('[data-testid="antenna-stations-editor"]')?.getAttribute("data-scene-revision") === "7", undefined, { timeout });
    await ready();
    assert.equal(await gap.inputValue(), "27e-9");
    assert.equal((await read()).scene.objects[0].geometry.geometry_params.stations[3].left_gap_m, 25e-9);
    assert.equal((await editor.innerText()).includes("Conductor geometry changed on the server"), false);
    checks.push({ name: "CPW independent gap transaction preserves the newer in-flight gap draft", passed: true });
    await screenshot("14-cpw-gap-ack");
  }
  const beforeIdle = await read();
  await page.waitForTimeout(300);
  const final = await read();
  assert.equal(final.calls.length, beforeIdle.calls.length, "Settled editor fetched while idle");
  assert.equal(final.renderCommits, beforeIdle.renderCommits, "Settled editor rendered while idle");
  assert.ok(final.calls.length <= 45);
  assert.ok(final.renderCommits <= 180);
  assert.equal(final.unexpected.length, 0);
  for (const call of final.calls.filter((entry) => entry.path.endsWith("/model/scene") || entry.method === "POST")) {
    assert.ok(call.scope?.includes("session-antenna-stations-fixture") && call.scope.includes("request_scope_epoch="), "Scene GET or transaction POST omitted the confirmed scoped owner");
  }
  assert.equal(pageErrors.length, 0, pageErrors.join(" | "));
  assert.equal(consoleErrors.length, 0, consoleErrors.join(" | "));
  checks.push({ name: "bounded workflow and settled idle have no polling, implicit mutation or runtime/console errors", passed: true, requests: final.calls.length, renders: final.renderCommits });
  // Execute the actual registered creator against the same typed, controlled transport.
  await page.getByTestId("antenna-stations-scroll").evaluate((element) => { element.style.height = "auto"; element.style.overflow = "visible"; });
  for (const createLayout of [layout === "cpw" ? "microstrip" : "cpw", layout]) {
  const beforeCreation = await read();
  await page.evaluate((kind) => {
    window.__antennaCreatedResult = null;
    window.__antennaStationsFixture.createAntenna(kind).then((result) => { window.__antennaCreatedResult = result; });
  }, createLayout);
  await page.waitForFunction(() => window.__antennaStationsFixture.read().pendingWrites === 1, undefined, { timeout });
  const creationPending = await read();
  const creationRequest = creationPending.calls.filter((call) => call.method === "POST").at(-1).body;
  assert.equal(creationRequest.kind, "merge_patch");
  assert.equal(creationRequest.base_revision, beforeCreation.revision);
  assert.deepEqual(creationRequest.merge_patch.objects.slice(0, -1), beforeCreation.scene.objects);
  for (const key of ["current_transports", "antenna_port_modes", "antenna_field_solve_stages"]) {
    assert.deepEqual(creationRequest.merge_patch[key].slice(0, -1), beforeCreation.scene[key] ?? [], `Creator lost existing ${key}`);
  }
  const created = creationRequest.merge_patch.objects.at(-1);
  const transport = creationRequest.merge_patch.current_transports.at(-1);
  const port = creationRequest.merge_patch.antenna_port_modes.at(-1);
  const solve = creationRequest.merge_patch.antenna_field_solve_stages.at(-1);
  const ids = createLayout === "cpw" ? ["signal", "ground_left", "ground_right"] : ["signal", "return"];
  assert.equal(created.geometry.geometry_kind, createLayout === "cpw" ? "CPWAntennaLayout" : "MicrostripAntennaLayout");
  assert.deepEqual(created.geometry.geometry_params.conductors.map((part) => part.id), ids);
  assert.equal(created.magnetization_ref, null);
  assert.deepEqual(created.physics_stack, []);
  assert.equal(transport.name, `${created.id}:current`);
  assert.equal(transport.boundaries.length, ids.length * 2 + 1);
  assert.equal(port.source_object_id, created.id);
  assert.equal(port.current_transport_id, transport.name);
  assert.deepEqual(port.branches.map((branch) => branch.signed_weight), createLayout === "cpw" ? [1, -0.5, -0.5] : [1, -1]);
  for (const branch of port.branches) {
    for (const [key, face] of [["inlet_terminal_ref", "min"], ["outlet_terminal_ref", "max"]]) {
      const boundary = transport.boundaries.find((entry) => entry.id === branch[key]);
      assert.ok(boundary);
      assert.equal(boundary.surfaces[0].object_id, created.id);
      assert.equal(boundary.surfaces[0].surface_id, `antenna_terminal:${branch.id}:local_u_${face}`);
    }
  }
  assert.equal(solve.source_object_id, created.id);
  assert.deepEqual(solve.target_refs, [{ kind: "global" }], "Creator must retain the canonical global sampling target, not an invalid empty executable stage");
  assert.equal(transport.conservative_current_view, undefined, "Creator must not fabricate solved current");
  assert.equal(creationPending.scene.objects.length, beforeCreation.scene.objects.length, "Pending creation was applied before ACK");
  await page.evaluate(() => window.__antennaStationsFixture.releaseWrite());
  await page.waitForFunction(() => window.__antennaCreatedResult?.status === "completed", undefined, { timeout });
  await ready();
  const afterCreation = await read();
  assert.equal(afterCreation.scene.objects.at(-1).id, created.id);
  assert.equal(afterCreation.revision, beforeCreation.revision + 1);
  assert.equal(afterCreation.calls.filter((call) => call.method === "POST").length, beforeCreation.calls.filter((call) => call.method === "POST").length + 1);
  assert.equal(afterCreation.unexpected.length, 0);
  const details = page.getByTestId("antenna-created-details");
  await page.waitForFunction((id) => document.querySelector('[data-testid="antenna-created-details"]')?.getAttribute("data-object-id") === id, created.id, { timeout });
  const createdDetailsText = await details.innerText();
  assert.ok(createdDetailsText.includes(created.geometry.geometry_kind));
  if (createLayout === "cpw") {
    for (const label of ["Part IDs", "Layout conductivity", "Charge conductivity", "Authored mesh policy"]) assert.ok(createdDetailsText.includes(label));
    for (const id of ids) assert.ok(createdDetailsText.includes(id));
    assert.ok(!createdDetailsText.includes("Return width"));
    const clipped = await details.locator(".fm-inspector-field-row__value").evaluateAll((values) => values.filter((value) => value.scrollWidth > value.clientWidth + 1).length);
    assert.equal(clipped, 0, "CPW conductor summary clips scientific values");
  } else {
    assert.ok(createdDetailsText.includes("Part IDs") && createdDetailsText.includes("Layout conductivity"));
    assert.ok(!createdDetailsText.includes("Return width"));
  }
  await details.scrollIntoViewIfNeeded();
  await screenshot(`15-created-${createLayout}-details`);
  assert.equal(pageErrors.length, 0, pageErrors.join(" | "));
  assert.equal(consoleErrors.length, 0, consoleErrors.join(" | "));
  checks.push({ name: `${createLayout} production creator preserves existing inventory and commits one complete conductor/terminal/current/port draft only after ACK`, passed: true });
  }
  const afterCreation = await read();
  requestEvidence = { ...(requestEvidence ?? {}), [layout]: afterCreation };
  layoutUrl.searchParams.set("inspector", "geometry");
  await page.goto(layoutUrl.href, { waitUntil: "domcontentloaded", timeout });
  const geometryPanel = page.locator('[data-inspector-owner="object.antenna.geometry"]');
  await geometryPanel.getByRole("textbox", { name: "Station 1 signal width", exact: true }).waitFor({ timeout });
  assert.ok((await geometryPanel.innerText()).includes(layout === "cpw" ? "two coplanar return strips" : "not an antenna bounding box"));
  assert.ok(!(await geometryPanel.innerText()).includes("Average m"));
  assert.equal(await geometryPanel.getByRole("combobox", { name: "Placement side", exact: true }).count(), 1);
  assert.equal((await read()).unexpected.length, 0);
  await screenshot("16-geometry-inspector");
  assert.equal(pageErrors.length, 0, pageErrors.join(" | "));
  checks.push({ name: `${layout} Explorer Geometry routes to its dedicated layout and placement inspector`, passed: true });
  await page.evaluate(() => window.__antennaStationsFixture.selectComposition("fixture-microstrip-conductor"));
  const composition = page.getByTestId("antenna-composition-summary");
  await composition.waitFor({ timeout });
  for (const name of ["Conductor", "Ports", "Field solves", "Projections", "Current drives", "Source spectra", "Regional field drive"]) {
    assert.equal(await composition.getByRole("heading", { name, exact: true }).count(), 1);
  }
  assert.ok((await composition.innerText()).includes("Configured resources do not establish a completed solve"));
  assert.equal(await composition.getByRole("textbox").count(), 0, "Composition must navigate to dedicated editors instead of duplicating authoring");
  await screenshot("16a-composition-inspector");
  await composition.getByRole("button", { name: "Open Conductor", exact: true }).click();
  await page.getByRole("heading", { name: "Antenna conductor", exact: true }).waitFor({ timeout });
  assert.equal((await page.evaluate(() => window.__antennaStationsFixture.readSelection())).kind, "object.antenna.conductor");
  await page.evaluate(() => window.__antennaStationsFixture.selectComposition("fixture-microstrip-conductor"));
  await composition.getByRole("button", { name: "Open Regional field drive", exact: true }).click();
  assert.equal((await page.evaluate(() => window.__antennaStationsFixture.readSelection())).kind, "object.antenna.regional");
  await composition.waitFor({ state: "detached", timeout });
  assert.equal(await page.getByTestId("antenna-composition-summary").count(), 0);
  await page.evaluate(() => window.__antennaStationsFixture.selectComposition("fixture-microstrip-conductor"));
  await composition.getByRole("button", { name: "Open Geometry", exact: true }).click();
  await geometryPanel.getByRole("textbox", { name: "Station 1 signal width", exact: true }).waitFor({ timeout });
  checks.push({ name: `${layout} selectable composition has six distinct workflow groups and canonical Conductor, Regional and Geometry routes`, passed: true });
  const dimensionField = (name) => geometryPanel.getByRole("textbox", { name, exact: true });
  const saveDimensions = () => geometryPanel.getByRole("button", { name: "Save conductor authoring", exact: true }).evaluate((button) => button.click());
  const dimensionBefore = await read();
  const dimensionParams = dimensionBefore.scene.objects[0].geometry.geometry_params;
  assert.equal(Number(await dimensionField("Conductor length").inputValue()), 1e-6);
  assert.equal(Number(await dimensionField("Conductor thickness").inputValue()), 10e-9);
  assert.equal(await dimensionField("Return width").count(), layout === "microstrip" ? 1 : 0);
  await dimensionField("Conductor length").fill("-1");
  await saveDimensions();
  await geometryPanel.getByRole("alert").filter({ hasText: "Conductor length must be finite and positive in m." }).waitFor({ timeout });
  assert.equal((await read()).calls.filter((call) => call.method === "POST").length, 0);
  await dimensionField("Conductor length").fill("2e-6");
  await dimensionField("Conductor thickness").fill("20e-9");
  if (layout === "microstrip") {
    await dimensionField("Return width").fill("650e-9");
    await dimensionField("Return offset").fill("0");
  }
  await dimensionField("Conductor thickness").scrollIntoViewIfNeeded();
  await dimensionField("Conductor thickness").focus();
  await page.evaluate(() => {
    const root = document.querySelector('[data-inspector-owner="object.antenna.geometry"]');
    const input = [...root.querySelectorAll("input")].find((input) => input === document.activeElement);
    window.__antennaDimensionProof = { root, input, scroll: document.querySelector('[data-testid="antenna-stations-scroll"]'), unrelated: document.querySelector('[data-testid="antenna-stations-unrelated"]') };
    window.__antennaDimensionProof.scrollTop = window.__antennaDimensionProof.scroll.scrollTop;
  });
  await saveDimensions();
  await page.waitForFunction(() => window.__antennaStationsFixture.read().pendingWrites === 1, undefined, { timeout });
  const dimensionPending = await read();
  const submittedDimensions = dimensionPending.calls.filter((call) => call.method === "POST").at(-1).body;
  assert.equal(submittedDimensions.kind, "patch_object_geometry");
  assert.equal(submittedDimensions.object_id, dimensionBefore.scene.objects[0].id);
  assert.equal(submittedDimensions.base_revision, dimensionBefore.revision);
  const expectedParams = { ...dimensionParams, length_m: 2e-6, thickness_m: 20e-9,
    ...(layout === "microstrip" ? { return_width_m: 650e-9, return_offset_m: 0 } : {}) };
  assert.deepEqual(submittedDimensions.geometry.geometry_params, expectedParams);
  assert.equal(await dimensionField("Conductor thickness").isEnabled(), true);
  assert.equal(await geometryPanel.getByRole("textbox", { name: "Station 1 signal width", exact: true }).isEnabled(), true);
  assert.equal(await geometryPanel.getByRole("combobox", { name: "Placement side", exact: true }).isEnabled(), true);
  await dimensionField("Conductor thickness").fill("25e-9");
  await page.evaluate(() => window.__antennaStationsFixture.releaseWrite());
  await page.waitForFunction((revision) => window.__antennaStationsFixture.read().pendingWrites === 0
    && document.querySelector('[data-testid="antenna-stations-editor"]')?.getAttribute("data-scene-revision") === String(revision), dimensionBefore.revision + 1, { timeout });
  await ready();
  assert.equal(await dimensionField("Conductor thickness").inputValue(), "25e-9", "Dimension ACK erased a newer edit");
  const dimensionProof = await page.evaluate(() => {
    const p = window.__antennaDimensionProof;
    return { root: p.root === document.querySelector('[data-inspector-owner="object.antenna.geometry"]'), input: p.input.isConnected,
      focus: document.activeElement === p.input, scrollDelta: Math.abs(p.scroll.scrollTop - p.scrollTop), unrelated: p.unrelated.isConnected && !p.unrelated.disabled,
      opacityAnimations: p.root.getAnimations({ subtree: true }).filter((animation) => (animation.playState === "running" || animation.pending) && animation.effect?.getKeyframes().some((frame) => "opacity" in frame)).length };
  });
  assert.deepEqual(dimensionProof, { root: true, input: true, focus: true, scrollDelta: 0, unrelated: true, opacityAnimations: 0 });
  checks.push({ name: `${layout} SI dimensions reject invalid input and preserve complete geometry, IDs, pending edits, focus and scroll through ACK`, passed: true, evidence: dimensionProof });
  await saveDimensions();
  await page.waitForFunction(() => window.__antennaStationsFixture.read().pendingWrites === 1, undefined, { timeout });
  await page.evaluate(() => window.__antennaStationsFixture.releaseWrite());
  await geometryPanel.getByRole("button", { name: "Revert draft", exact: true }).waitFor({ state: "hidden", timeout });
  assert.equal((await read()).scene.objects[0].geometry.geometry_params.thickness_m, 25e-9);
  await dimensionField("Conductor length").fill("3e-6");
  await page.evaluate(() => window.__antennaStationsFixture.resizeLengthOnServer(4e-6));
  await geometryPanel.getByRole("alert").filter({ hasText: "Conductor geometry changed on the server" }).waitFor({ timeout });
  assert.equal(await dimensionField("Conductor length").inputValue(), "3e-6");
  assert.equal(await geometryPanel.getByRole("button", { name: "Save conductor authoring", exact: true }).isDisabled(), true);
  await geometryPanel.getByRole("button", { name: "Rebase draft", exact: true }).evaluate((button) => button.click());
  const rebaseRevision = (await read()).revision;
  await saveDimensions();
  await page.waitForFunction(() => window.__antennaStationsFixture.read().pendingWrites === 1, undefined, { timeout });
  assert.equal((await read()).calls.filter((call) => call.method === "POST").at(-1).body.base_revision, rebaseRevision);
  await page.evaluate(() => window.__antennaStationsFixture.releaseWrite());
  await geometryPanel.getByRole("button", { name: "Revert draft", exact: true }).waitFor({ state: "hidden", timeout });
  assert.equal((await read()).scene.objects[0].geometry.geometry_params.length_m, 3e-6);
  await dimensionField("Conductor length").fill("5e-6");
  await geometryPanel.getByRole("button", { name: "Revert draft", exact: true }).evaluate((button) => button.click());
  assert.equal(Number(await dimensionField("Conductor length").inputValue()), 3e-6);
  assert.equal((await read()).calls.filter((call) => call.method === "POST").length, 3);
  assert.equal((await read()).unexpected.length, 0);
  checks.push({ name: `${layout} dimension conflict retains the draft, explicit rebase uses current revision, and revert creates no transaction`, passed: true });
  await screenshot("17-geometry-dimensions-committed");
  requestEvidence = { ...(requestEvidence ?? {}), [layout]: await read() };

  const conductorUrl = new URL(layoutUrl); conductorUrl.searchParams.set("inspector", "conductor");
  await page.goto(conductorUrl.href, { waitUntil: "domcontentloaded", timeout }); await ready();
  const conductor = page.locator('[data-inspector-owner="object.antenna.conductor"]'); await conductor.waitFor({ timeout });
  const conductorText = await conductor.innerText();
  assert.ok(conductorText.includes("Layout conductivity") && conductorText.includes("58 MS/m"));
  assert.ok(conductorText.includes("Charge conductivity") && conductorText.includes("32 MS/m") && conductorText.includes("41 MS/m"));
  assert.ok(conductorText.includes("explicit-charge") && conductorText.includes("ohmic_poisson"));
  for (const name of ["Conductor length", "Conductor thickness", "Station 1 signal width", "Return width"]) {
    assert.equal(await conductor.getByRole("textbox", { name, exact: true }).count(), 0, "Conductor must not duplicate geometry editors");
  }
  assert.equal(await conductor.getByRole("combobox", { name: "Placement side", exact: true }).count(), 0, "Placement belongs to Geometry");
  assert.ok(!conductorText.includes("Station 1") && !conductorText.includes("Return width"));
  await screenshot("18-conductor-materials");
  const navigationBefore = await read();
  const conductorSelection = await page.evaluate(() => window.__antennaStationsFixture.readSelection());
  for (const name of ["Open Geometry", "Open Mesh Policy"]) {
    // Exercise the click-time guard before React can disable the stale button.
    const race = await page.evaluate((buttonName) => {
      const button = [...document.querySelectorAll('[data-inspector-owner="object.antenna.conductor"] button')].find(item => item.textContent === buttonName);
      if (!button || button.disabled) throw new Error("Expected an enabled conductor navigation button");
      window.__antennaStationsFixture.refreshUnrelated();
      button.click();
      return window.__antennaStationsFixture.readSelection();
    }, name);
    assert.deepEqual(race, conductorSelection, `${name} must reject invalidation before React rerenders`);
    await page.waitForFunction(() => window.__antennaStationsFixture.read().pendingSceneReads > 0, undefined, { timeout });
    for (const target of ["Open Geometry", "Open Mesh Policy"]) {
      assert.equal(await conductor.getByRole("button", { name: target, exact: true }).isDisabled(), true, `${target} must remain unavailable during a held scene GET`);
    }
    assert.ok((await conductor.innerText()).includes("The conductor resource changed or is unavailable."));
    assert.deepEqual(await page.evaluate(() => window.__antennaStationsFixture.readSelection()), conductorSelection);
    assert.equal((await read()).calls.filter(call => call.method === "POST").length, navigationBefore.calls.filter(call => call.method === "POST").length);
    await page.evaluate(() => window.__antennaStationsFixture.releaseScene());
    await ready();
    assert.equal(await conductor.getByRole("button", { name, exact: true }).isEnabled(), true);
  }
  checks.push({ name: `${layout} conductor Geometry and Mesh navigation reject invalidated scene revisions before render and during held GET without changing selection or writing`, passed: true });
  await conductor.getByRole("button", { name: "Open Geometry", exact: true }).click();
  const routedGeometry = page.locator('[data-inspector-owner="object.antenna.geometry"]'); await routedGeometry.waitFor({ timeout });
  assert.equal(await routedGeometry.getByRole("textbox", { name: "Conductor length", exact: true }).count(), 1);
  assert.ok(!(await routedGeometry.innerText()).includes("Charge conductivity"));
  const selection = await page.evaluate(() => window.__antennaStationsFixture.readSelection());
  assert.equal(selection.kind, "object.antenna.geometry"); assert.equal(selection.ref.objectId, "fixture-microstrip-conductor");
  assert.equal(selection.nodeId, "model:object:fixture-microstrip-conductor:geometry");
  assert.equal((await read()).calls.filter(call => call.method === "POST").length, navigationBefore.calls.filter(call => call.method === "POST").length);
  assert.deepEqual((await read()).unexpected, []);
  await screenshot("19-conductor-to-geometry");
  checks.push({ name: `${layout} dedicated Conductor separates authored layout conductivity from explicit charge materials and navigates to Geometry without duplicate editors or writes`, passed: true });

  await page.goto(conductorUrl.href, { waitUntil: "domcontentloaded", timeout }); await ready();
  await conductor.getByRole("button", { name: "Open Mesh Policy", exact: true }).click();
  const meshSelection = await page.evaluate(() => window.__antennaStationsFixture.readSelection());
  assert.equal(meshSelection.kind, "object.mesh");
  assert.equal(meshSelection.ref.objectId, "fixture-microstrip-conductor");
  assert.equal(meshSelection.nodeId, "model:object:fixture-microstrip-conductor:mesh");
  assert.deepEqual((await read()).unexpected, []);
  checks.push({ name: `${layout} conductor Mesh Policy navigation resolves the canonical Explorer route after the scene is ready`, passed: true });

  for (const [charge, message] of [["none", "No explicit current module is assigned to this object."], ["empty", "No explicit charge-material assignment for this object."]]) {
    const missingUrl = new URL(conductorUrl); missingUrl.searchParams.set("charge", charge);
    await page.goto(missingUrl.href, { waitUntil: "domcontentloaded", timeout }); await ready();
    const missing = page.locator('[data-inspector-owner="object.antenna.conductor"]'); await missing.waitFor({ timeout });
    const text = await missing.innerText();
    assert.ok(text.includes(message) && text.includes("58 MS/m"));
    assert.ok(!text.includes("Charge conductivity"), "Missing charge materials must not fall back to layout conductivity");
    assert.deepEqual((await read()).unexpected, []);
    checks.push({ name: `${layout} Conductor explicitly reports ${charge === "none" ? "missing current module" : "missing charge materials"} without conductivity fallback`, passed: true });
  }
  if (layout === "microstrip") {
    const circuitUrl = new URL(layoutUrl); circuitUrl.searchParams.set("inspector", "geometry");
    await page.goto(circuitUrl.href, { waitUntil: "domcontentloaded", timeout }); await ready();
    await page.evaluate(() => { window.__circuitCreation = window.__antennaStationsFixture.createAntenna("microstrip"); });
    await page.waitForFunction(() => window.__antennaStationsFixture.read().pendingWrites === 1, undefined, { timeout });
    await page.evaluate(() => window.__antennaStationsFixture.releaseWrite());
    await page.evaluate(() => window.__circuitCreation); await ready();
    const originalScene = (await read()).scene;
    const owner = originalScene.objects.at(-1), ownerId = owner.id;
    await page.evaluate(id => window.__antennaStationsFixture.selectGeometry(id), ownerId);
    const circuitPanel = page.locator('[data-inspector-owner="object.antenna.geometry"]');
    const field = name => circuitPanel.getByRole("textbox", { name, exact: true });
    const save = () => circuitPanel.getByRole("button", { name: "Save conductor authoring", exact: true }).evaluate(button => button.click());
    await circuitPanel.getByRole("checkbox", { name: "Full 3D conducting circuit", exact: true }).check();
    for (const end of ["inlet", "outlet"]) {
      for (const [suffix, value] of [["length", "2e-7"], ["width", "1e-7"], ["center v", "0"], ["part ID", ` ${end}-bridge `], ["conductivity", "3e7"]]) {
        await field(`${end} bridge ${suffix}`).fill(value);
      }
    }
    await field("Inlet source-cut potential jump").fill("0");
    const beforeCircuit = await read(); await save();
    await circuitPanel.getByRole("alert").filter({ hasText: "must be non-zero" }).waitFor({ timeout });
    assert.equal((await read()).calls.filter(call => call.method === "POST").length, beforeCircuit.calls.filter(call => call.method === "POST").length);
    checks.push({ name: "Full circuit rejects zero source voltage before dispatching any transaction", passed: true });
    await field("Inlet source-cut potential jump").fill("0.25");
    await field("Inlet source-cut potential jump").evaluate(input => { window.__circuitRetainedInput = input; window.__circuitRetainedRoot = input.closest('[data-inspector-owner]'); });
    await save();
    await page.waitForFunction(() => window.__antennaStationsFixture.read().pendingWrites === 1, undefined, { timeout });
    const submitted = (await read()).calls.filter(call => call.method === "POST").at(-1).body;
    assert.equal(submitted.kind, "merge_patch"); assert.equal(submitted.base_revision, beforeCircuit.revision);
    const patch = submitted.merge_patch, patchedOwner = patch.objects.find(object => object.id === ownerId);
    const current = patch.current_transports.find(current => current.domain.some(ref => ref.object_id === ownerId));
    const port = patch.antenna_port_modes.find(port => port.source_object_id === ownerId);
    const cut = current.structured_current_closure.source_cuts[0];
    assert.equal(patchedOwner.geometry.geometry_params.return_width_m, owner.geometry.geometry_params.return_width_m);
    assert.deepEqual(patchedOwner.geometry.geometry_params.stations, owner.geometry.geometry_params.stations);
    assert.equal(patchedOwner.geometry.geometry_params.loop.enabled, true);
    assert.equal(current.gauge, "zero_mean"); assert.deepEqual(current.boundaries, []);
    assert.equal(current.materials.length, 4); assert.equal(cut.drive.potential_jump_V, 0.25);
    assert.equal(cut.region.region_id, "inlet-bridge"); assert.equal(port.schema_version, "antenna_port_mode.v3");
    assert.equal(port.normalization.source_cut_ref, cut.source_cut_id);
    assert.deepEqual(patch.objects.find(object => object.id !== ownerId), originalScene.objects[0]);
    await field("Inlet source-cut potential jump").fill("-0.3");
    await page.evaluate(() => window.__antennaStationsFixture.releaseWrite());
    await page.waitForFunction(revision => window.__antennaStationsFixture.read().pendingWrites === 0
      && document.querySelector('[data-testid="antenna-stations-editor"]')?.getAttribute("data-scene-revision") === String(revision), beforeCircuit.revision + 1, { timeout }); await ready();
    assert.equal(await field("Inlet source-cut potential jump").inputValue(), "-0.3");
    assert.equal(await page.evaluate(() => window.__circuitRetainedInput.isConnected && window.__circuitRetainedRoot === document.querySelector('[data-inspector-owner="object.antenna.geometry"]')), true);
    assert.equal(await circuitPanel.getByRole("checkbox", { name: "Full 3D conducting circuit", exact: true }).isDisabled(), true);
    assert.ok(!(await circuitPanel.innerText()).includes("Conductor geometry changed on the server"));
    await screenshot("20-circuit-ack-newer-voltage");
    checks.push({ name: "Canonical creator to Geometry authors bridges, materials, voltage cut and port normalization atomically; ACK retains newer voltage and panel identity", passed: true });
    await save(); await page.waitForFunction(() => window.__antennaStationsFixture.read().pendingWrites === 1, undefined, { timeout });
    const second = (await read()).calls.filter(call => call.method === "POST").at(-1).body.merge_patch.current_transports.find(current => current.domain.some(ref => ref.object_id === ownerId));
    assert.equal(second.structured_current_closure.source_cuts[0].source_cut_id, cut.source_cut_id);
    assert.equal(second.structured_current_closure.source_cuts[0].drive.potential_jump_V, -0.3);
    await page.evaluate(() => window.__antennaStationsFixture.releaseWrite());
    await circuitPanel.getByRole("button", { name: "Revert draft", exact: true }).waitFor({ state: "hidden", timeout });
    assert.deepEqual((await read()).unexpected, []);
    await screenshot("21-circuit-committed");
    checks.push({ name: "Subsequent circuit voltage edit preserves source identity without reopening the committed loop", passed: true });
    await page.getByTestId("antenna-stations-scroll").evaluate(scroll => { scroll.style.width = "320px"; scroll.style.maxWidth = "100%"; });
    for (const name of ["Voltage source", "Inlet connection", "Outlet connection"]) assert.equal(await circuitPanel.getByRole("group", { name, exact: true }).count(), 1);
    const narrow = await circuitPanel.evaluate(panel => {
      const groups = [...panel.querySelectorAll(".fm-antenna-circuit-part")];
      return { groups: groups.length, overflow: groups.filter(group => group.scrollWidth > group.clientWidth + 1).length,
        inputs: groups.flatMap(group => [...group.querySelectorAll("input")]).length,
        clippedLabels: groups.flatMap(group => [...group.querySelectorAll("label")]).filter(label => label.scrollWidth > label.clientWidth + 1).length };
    });
    assert.deepEqual(narrow, { groups: 3, overflow: 0, inputs: 11, clippedLabels: 0 });
    await circuitPanel.getByRole("group", { name: "Voltage source", exact: true }).scrollIntoViewIfNeeded();
    await screenshot("23-circuit-narrow-groups");
    checks.push({ name: "320 px circuit Inspector separates voltage source, inlet and outlet with accessible groups and no horizontal overflow", passed: true });
    await field("Inlet source-cut potential jump").fill("0.4");
    await page.evaluate(() => window.__antennaStationsFixture.corruptNextCircuitAck());
    await save(); await page.waitForFunction(() => window.__antennaStationsFixture.read().pendingWrites === 1, undefined, { timeout });
    await field("Inlet source-cut potential jump").fill("0.5");
    await page.evaluate(() => window.__antennaStationsFixture.releaseWrite());
    await circuitPanel.getByRole("alert").filter({ hasText: "Circuit ACK omitted or changed the submitted source-cut port" }).waitFor({ timeout });
    assert.equal(await field("Inlet source-cut potential jump").inputValue(), "0.5");
    assert.ok(!(await circuitPanel.innerText()).includes("Conductor authoring committed."));
    assert.equal(await page.evaluate(() => window.__circuitRetainedInput.isConnected && window.__circuitRetainedRoot === document.querySelector('[data-inspector-owner="object.antenna.geometry"]')), true);
    assert.deepEqual((await read()).unexpected, []);
    await circuitPanel.getByRole("alert").filter({ hasText: "Circuit ACK omitted or changed the submitted source-cut port" }).scrollIntoViewIfNeeded();
    await screenshot("22-circuit-rejected-partial-ack");
    checks.push({ name: "Partial circuit ACK without port normalization is refused before success/cache publication and preserves newer voltage and panel", passed: true });
  }
  if (layout === "microstrip") {
    const studyUrl = new URL(layoutUrl); studyUrl.searchParams.set("inspector", "geometry"); studyUrl.searchParams.set("study", "1");
    await page.goto(studyUrl.href, { waitUntil: "domcontentloaded", timeout }); await ready();
    await page.evaluate(() => { window.__studyCreation = window.__antennaStationsFixture.createAntenna("microstrip"); });
    await page.waitForFunction(() => window.__antennaStationsFixture.read().pendingWrites === 1, undefined, { timeout });
    await page.evaluate(() => window.__antennaStationsFixture.releaseWrite()); await page.evaluate(() => window.__studyCreation); await ready();
    const created = (await read()).scene.objects.at(-1), sourceId = created.id;
    const solve = (await read()).scene.antenna_field_solve_stages.find(stage => stage.source_object_id === sourceId);
    await page.evaluate(id => window.__antennaStationsFixture.selectGeometry(id), sourceId);
    const add = page.getByRole("button", { name: "Add Field Solve to Study", exact: true });
    assert.equal((await read()).scene.scene.id, "restored-authoring-model");
    assert.equal(await add.isEnabled(), true, "A restored model ID must not be mistaken for the session ID");
    const previousScope = page.getByRole("checkbox", { name: "Use previous-session scene scope", exact: true });
    const beforeForeignAdd = (await read()).calls.filter(call => call.method === "POST").length;
    await previousScope.check(); assert.equal(await add.isDisabled(), true);
    assert.equal((await read()).calls.filter(call => call.method === "POST").length, beforeForeignAdd);
    await previousScope.uncheck(); assert.equal(await add.isEnabled(), true);
    await add.click(); await page.waitForFunction(() => window.__antennaStationsFixture.read().pendingWrites === 1, undefined, { timeout });
    const before = await read(), transaction = before.calls.filter(call => call.method === "POST").at(-1).body;
    assert.deepEqual(Object.keys(transaction.merge_patch), ["study"]);
    assert.equal(transaction.merge_patch.study.stages.length, 1);
    assert.equal(transaction.merge_patch.study.stages[0].kind, "antenna_field_solve");
    assert.equal(transaction.merge_patch.study.stages[0].stage_id, solve.id);
    assert.equal(await add.isDisabled(), true);
    await page.evaluate(() => window.__antennaStationsFixture.releaseWrite()); await ready();
    const open = page.getByRole("button", { name: "Open Study stage", exact: true }); await open.waitFor({ timeout });
    assert.equal(await add.isDisabled(), true, "An existing Study reference must not permit duplicate add");
    const beforeNavigation = await read();
    await previousScope.check(); assert.equal(await open.isDisabled(), true);
    await previousScope.uncheck(); assert.equal(await open.isEnabled(), true);
    checks.push({ name: "Restored model with independent scene ID permits Add/Open only under its confirmed full session scope; a previous-session scope disables both without writes", passed: true });
    await open.scrollIntoViewIfNeeded(); await screenshot("24-study-reference-ready");
    await open.click();
    const selected = await page.evaluate(() => window.__antennaStationsFixture.readSelection());
    assert.equal(selected.kind, "study.stage.antenna_field_solve");
    assert.equal(selected.objectId, null, "Study navigation must clear the previous source object");
    assert.equal(selected.ref.stageId, solve.id); assert.equal(selected.ref.stageIndex, 0);
    assert.deepEqual(selected.ref, await page.evaluate(id => window.__antennaStationsFixture.studyNodeRef(id), solve.id));
    assert.equal((await read()).calls.filter(call => call.method === "POST").length, beforeNavigation.calls.filter(call => call.method === "POST").length);
    assert.deepEqual((await read()).unexpected, []);
    checks.push({ name: "Actual command registry adds one antenna-only Study reference; duplicate add is disabled and navigation matches the canonical Explorer selection without starting execution", passed: true });
    const placementUrl = new URL(layoutUrl); placementUrl.searchParams.set("inspector", "geometry"); placementUrl.searchParams.set("placement", "1");
    await page.goto(placementUrl.href, { waitUntil: "domcontentloaded", timeout }); await ready();
    await page.evaluate(() => window.__antennaStationsFixture.selectGeometry("fixture-microstrip-conductor"));
    const placementPanel = page.locator('[data-inspector-owner="object.antenna.geometry"]');
    await placementPanel.getByRole("combobox", { name: "Placement target", exact: true }).selectOption("placement-target");
    const place = placementPanel.getByRole("button", { name: "Apply antenna placement", exact: true });
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "Apply antenna placement" && !button.disabled), undefined, { timeout });
    const beforePlacement = await read(); await place.click();
    await page.waitForFunction(() => window.__antennaStationsFixture.read().pendingWrites === 1, undefined, { timeout });
    const placementRequest = (await read()).calls.filter(call => call.method === "POST").at(-1).body;
    assert.equal(placementRequest.kind, "commit_object_transform"); assert.equal(placementRequest.object_id, "fixture-microstrip-conductor");
    assert.equal(placementRequest.base_revision, beforePlacement.revision);
    assert.deepEqual(placementRequest.transform.translation.slice(0, 2), [0, 0]); assert.ok(placementRequest.transform.translation[2] > 0);
    await page.evaluate(() => window.__antennaStationsFixture.releaseWrite()); await ready();
    await placementPanel.getByRole("alert").filter({ hasText: "Whole antenna translation committed" }).waitFor({ timeout });
    const afterPlacement = await read();
    assert.equal(afterPlacement.scene.scene.id, "restored-authoring-model");
    assert.deepEqual(afterPlacement.scene.objects[0].transform.translation, placementRequest.transform.translation);
    assert.deepEqual(afterPlacement.scene.objects[0].geometry, beforePlacement.scene.objects[0].geometry);
    assert.deepEqual(afterPlacement.scene.objects[1], beforePlacement.scene.objects[1]);
    assert.equal(afterPlacement.calls.filter(call => call.method === "POST").length, beforePlacement.calls.filter(call => call.method === "POST").length + 1);
    assert.deepEqual(afterPlacement.unexpected, []); await screenshot("25-restored-placement-committed");
    placementUrl.searchParams.set("placement_missing_id", "1");
    await page.goto(placementUrl.href, { waitUntil: "domcontentloaded", timeout }); await ready();
    await page.evaluate(() => window.__antennaStationsFixture.selectGeometry("fixture-microstrip-conductor"));
    await placementPanel.getByRole("combobox", { name: "Placement target", exact: true }).selectOption("placement-target");
    assert.equal(await place.isDisabled(), true); assert.equal((await read()).calls.filter(call => call.method === "POST").length, 0);
    checks.push({ name: "Restored model placement writes only the whole antenna translation with matching model ACK; missing model identity refuses the write", passed: true });
  }
  await page.close();
  page = null;
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  if (page) {
    try { requestEvidence = await page.evaluate(() => window.__antennaStationsFixture?.read() ?? null); } catch { /* Preserve the original failure. */ }
    try { const path = resolve(reportDirectory, "failure.png"); await page.screenshot({ path, fullPage: true }); screenshots.push(path); } catch (error) { failure += `; screenshot: ${String(error)}`; }
  }
} finally {
  if (browser) { try { await browser.close(); } catch (error) { failure = `${failure ?? ""}; browser cleanup: ${String(error)}`; } }
}
const report = { schema: "fullmag_antenna_microstrip_stations_browser_fixture_v1", state: failure ? "failed" : "passed", qualification: "fixture_only_not_backend_runtime_or_science", fixture_only: true, actual_backend_runtime: false, production_editor: true, production_hooks: true, production_resource_layer: true, transport: "controlled_ControlRoomApi_GET_and_authoring_transaction_responses", unit_tests: "not_compiled_not_run", url, started_at: startedAt, finished_at: new Date().toISOString(), checks, screenshots, request_evidence: requestEvidence, page_errors: pageErrors, console_errors: consoleErrors, error: failure };
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ report: reportPath, state: report.state, checks: checks.length, error: failure }));
process.exitCode = failure ? 1 : 0;
