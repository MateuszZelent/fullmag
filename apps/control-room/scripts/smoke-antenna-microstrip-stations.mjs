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
  assert.equal(await editor.getByRole("button", { name: "Save width stations", exact: true }).isDisabled(), true);
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
  await clickWithoutFocus("Save width stations");
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
  assert.equal(await editor.getByRole("button", { name: "Save width stations", exact: true }).isDisabled(), true);
  await screenshot("05-save-pending");
  // Keep typing in the same controlled input while the submitted transaction is held.
  await retainedWidth.fill("17e-9");
  await retainedWidth.evaluate((input) => { input.setSelectionRange(1, 3); });
  await page.evaluate(() => window.__antennaStationsFixture.releaseWrite());
  await page.waitForFunction(() => window.__antennaStationsFixture.read().pendingWrites === 0 && document.querySelector('[data-testid="antenna-stations-editor"]')?.getAttribute("data-scene-revision") === "2", undefined, { timeout });
  await ready();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="antenna-stations-editor"] button')].some((button) => button.textContent === "Save width stations" && !button.disabled), undefined, { timeout });
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

  await clickWithoutFocus("Save width stations");
  await page.waitForFunction(() => window.__antennaStationsFixture.read().pendingWrites === 1, undefined, { timeout });
  await page.evaluate(() => window.__antennaStationsFixture.releaseWrite());
  await page.waitForFunction(() => document.querySelector('[data-testid="antenna-stations-editor"]')?.getAttribute("data-scene-revision") === "3", undefined, { timeout });
  await ready();
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-testid="antenna-stations-editor"] button')].some((button) => button.textContent === "Revert draft"), undefined, { timeout });
  await expectValues([[0, 40e-9], [0.375, interpolatedWidth], [0.75, 17e-9], [1, 10e-9]]);
  assert.equal(await editor.getByRole("button", { name: "Save width stations", exact: true }).isDisabled(), true);
  await retainedWidth.fill("17e-9");
  assert.equal(await editor.getByRole("button", { name: "Save width stations", exact: true }).isDisabled(), true, "Numerically equivalent formatting created a redundant dirty transaction");
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
  assert.equal(await editor.getByRole("button", { name: "Save width stations", exact: true }).isDisabled(), true);
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
  await clickWithoutFocus("Save width stations");
  await page.waitForFunction(() => window.__antennaStationsFixture.read().pendingWrites === 1, undefined, { timeout });
  await page.evaluate(() => window.__antennaStationsFixture.releaseWrite());
  await page.waitForFunction(() => document.querySelector('[data-testid="antenna-stations-editor"]')?.getAttribute("data-scene-revision") === "5", undefined, { timeout });
  await ready();
  await expectValues([[0, 40e-9], [0.375, interpolatedWidth], [0.8, 17e-9], [1, 10e-9]]);
  assert.equal(await editor.getByRole("button", { name: "Save width stations", exact: true }).isDisabled(), true);
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
  assert.equal(await editor.getByRole("button", { name: "Save width stations", exact: true }).isDisabled(), true, "Clean external geometry update retained obsolete local values");
  checks.push({ name: "server insertion at a moved station's former position cannot collide with its retained DOM identity", passed: true, evidence: movedProof });
  await screenshot("13-moved-station-after-server-insert");
  if (layout === "cpw") {
    const gap = editor.getByRole("textbox", { name: "Station 4 left gap", exact: true });
    await gap.fill("25e-9");
    await clickWithoutFocus("Save width stations");
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
  assert.ok((await details.innerText()).includes(created.geometry.geometry_kind));
  if (createLayout === "cpw") {
    for (const label of ["1 · Signal width", "1 · Left gap", "1 · Right gap", "1 · Left ground", "1 · Right ground"]) assert.ok((await details.innerText()).includes(label));
    assert.ok(!(await details.innerText()).includes("Return width"));
    const clipped = await details.locator(".fm-inspector-field-row__value").evaluateAll((values) => values.filter((value) => value.scrollWidth > value.clientWidth + 1).length);
    assert.equal(clipped, 0, "CPW conductor summary clips scientific values");
  } else assert.ok((await details.innerText()).includes("Return width"));
  await details.scrollIntoViewIfNeeded();
  await screenshot(`15-created-${createLayout}-details`);
  assert.equal(pageErrors.length, 0, pageErrors.join(" | "));
  assert.equal(consoleErrors.length, 0, consoleErrors.join(" | "));
  checks.push({ name: `${createLayout} production creator preserves existing inventory and commits one complete conductor/terminal/current/port draft only after ACK`, passed: true });
  }
  const afterCreation = await read();
  requestEvidence = { ...(requestEvidence ?? {}), [layout]: afterCreation };
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
