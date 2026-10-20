import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const storage = process.env.FULLMAG_PROJECT_STORAGE_ROOT;
const output = process.env.FULLMAG_PRIMITIVE_COLOR_REPORT_DIR;
if (!storage || !output || !isAbsolute(storage) || !isAbsolute(output)) throw new Error("Managed absolute storage/report paths are required");
const descendant = (root, path) => { const suffix = relative(root, path); return Boolean(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); };
const directory = resolve(output), realStorage = await realpath(storage);
if (!descendant(resolve(storage), directory) || !descendant(realStorage, await realpath(dirname(directory)))) throw new Error("Report path escaped managed storage");
await mkdir(directory, { recursive: true });
if (!descendant(realStorage, await realpath(directory))) throw new Error("Report directory escaped managed storage");
const checks = [], screenshots = [], errors = [];
let browser, page, failure = null, evidence = null;
const timeout = 60_000;
try {
  let playwright;
  try { playwright = await import("playwright"); } catch { playwright = await import("@playwright/test"); }
  const channel = process.env.FULLMAG_PRIMITIVE_COLOR_BROWSER_CHANNEL;
  if (channel && !["chrome", "msedge"].includes(channel)) throw new Error("Unsupported browser channel");
  browser = await playwright.chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  page = await browser.newPage({ viewport: { width: 1360, height: 1400 } });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:3257/primitive-color-inspector", { waitUntil: "domcontentloaded", timeout });
  await page.waitForFunction(() => Boolean(window.__primitiveColorFixture), undefined, { timeout });
  const panel = page.getByTestId("primitive-inspector");
  const screenshot = async name => { const path = resolve(directory, `${name}.png`); await page.screenshot({ path, fullPage: true }); screenshots.push(path); };
  const read = () => page.evaluate(() => window.__primitiveColorFixture.read());
  await panel.getByRole("textbox", { name: "Primitive color", exact: true }).waitFor({ timeout });
  assert.ok(!(await panel.innerText()).includes("Average m"));
  assert.ok(!(await panel.innerText()).includes("Energies"));
  assert.ok(!(await read()).calls.some(call => call.path.includes("/metrics")), "Unmagnetized conductor fetched magnetic metrics");
  await page.getByTestId("primitive-unrelated").fill("retained local draft");
  await panel.getByRole("textbox", { name: "Name", exact: true }).fill("Unsaved antenna name");
  await screenshot("01-object-before");

  for (const [lane, label, color, property] of [
    ["object", "Primitive color", "#d4af37", "primitiveMonoColor"],
    ["object", "Frame color", "#123456", "wireframeColor"],
    ["airbox", "Wireframe color value", "#abcdef", "wireframeColor"],
  ]) {
    if (lane === "airbox") await page.getByRole("button", { name: "Airbox fixture", exact: true }).click();
    const input = panel.getByRole("textbox", { name: label, exact: true });
    await input.waitFor({ timeout });
    await page.getByTestId("primitive-unrelated").evaluate(element => element.focus({ preventScroll: true }));
    await page.evaluate(label => {
      const root = document.querySelector('[data-testid="primitive-inspector"] .fm-inspector-panel');
      const scroll = document.querySelector('[data-testid="primitive-scroll"]');
      scroll.scrollTop = 70;
      if (scroll.scrollTop !== 70) throw new Error("Fixture has no actual scroll overflow");
      const focus = document.activeElement;
      const changedFieldLabels = new Set(label.endsWith(" value") ? [label, label.replace(/ value$/, " picker")] : [label]);
      const changedInputs = new Set([...root.querySelectorAll("input")].filter(element => changedFieldLabels.has(element.getAttribute("aria-label"))));
      const controls = [...root.querySelectorAll("input,textarea,select,button"), document.querySelector('[data-testid="primitive-unrelated"]')].filter(element => !changedInputs.has(element)).map(element => ({ element, disabled: element.disabled, opacity: getComputedStyle(element).opacity }));
      const opacityElements = new Set([root]);
      for (const { element } of controls) {
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          opacityElements.add(ancestor);
        }
      }
      const ancestorOpacities = [...opacityElements].map(element => ({ element, opacity: getComputedStyle(element).opacity }));
      const proof = { rootChanges: 0, controlChanges: 0, disabledChanges: 0, opacityChanges: 0, opacityAnimations: 0, scrollDelta: 0, focusLost: 0 };
      const sample = () => {
        if (document.querySelector('[data-testid="primitive-inspector"] .fm-inspector-panel') !== root) proof.rootChanges++;
        if (document.activeElement !== focus) proof.focusLost++;
        proof.scrollDelta = Math.max(proof.scrollDelta, Math.abs(scroll.scrollTop - 70));
        for (const item of controls) {
          if (!item.element.isConnected) proof.controlChanges++;
          if (item.element.disabled !== item.disabled) proof.disabledChanges++;
          if (getComputedStyle(item.element).opacity !== item.opacity) proof.opacityChanges++;
        }
        for (const item of ancestorOpacities) {
          if (getComputedStyle(item.element).opacity !== item.opacity) proof.opacityChanges++;
        }
        proof.opacityAnimations += root.getAnimations({ subtree: true }).filter(animation => (animation.playState === "running" || animation.pending) && animation.effect?.getKeyframes().some(frame => "opacity" in frame)).length;
      };
      const observer = new MutationObserver(sample); observer.observe(root, { subtree: true, attributes: true, childList: true });
      const timer = setInterval(sample, 16);
      window.__primitiveStability = { proof, sample, observer, timer };
      sample();
    }, label);
    const before = await read();
    await page.evaluate(() => window.__primitiveColorFixture.invalidate());
    await page.waitForFunction(() => window.__primitiveColorFixture.read().pending > 0, undefined, { timeout });
    await input.evaluate((element, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true }));
    }, color);
    if (property === "wireframeColor") {
      await page.waitForFunction(() => window.__primitiveColorFixture.read().pendingWrites === 1, undefined, { timeout });
    }
    if (property === "primitiveMonoColor") await page.waitForFunction(({ color }) => window.__primitiveColorFixture.read().settings.primitiveMonoColor === color, { color }, { timeout });
    assert.equal(await input.inputValue(), color, "Edited textbox must display the chosen color before ACK/refetch");
    await screenshot(`${lane}-${property}-pending-refetch`);
    if (property === "wireframeColor") await page.evaluate(() => window.__primitiveColorFixture.releaseWrites());
    await page.evaluate(() => window.__primitiveColorFixture.release());
    await page.waitForFunction(({ lane, property, color }) => window.__primitiveColorFixture.read()[lane === "object" ? "settings" : "airboxSettings"][property] === color, { lane, property, color }, { timeout });
    await page.waitForFunction(() => window.__primitiveColorFixture.read().pending === 0, undefined, { timeout });
    await page.waitForTimeout(700);
    const stability = await page.evaluate(() => {
      const monitor = window.__primitiveStability; monitor.sample(); monitor.observer.disconnect(); clearInterval(monitor.timer);
      return { ...monitor.proof, unrelatedDraft: document.querySelector('[data-testid="primitive-unrelated"]').value };
    });
    assert.deepEqual(stability, { rootChanges: 0, controlChanges: 0, disabledChanges: 0, opacityChanges: 0, opacityAnimations: 0, scrollDelta: 0, focusLost: 0, unrelatedDraft: "retained local draft" });
    const after = await read();
    assert.equal(await input.inputValue(), color, "Edited textbox must retain its color after ACK/refetch");
    assert.equal(after[lane === "object" ? "settings" : "airboxSettings"][property], color);
    const newWrites = after.calls.slice(before.calls.length).filter(call => call.method !== "GET");
    assert.equal(newWrites.length, property === "primitiveMonoColor" ? 0 : 1, "Primitive preference is local; frame color requires exactly one canonical server ACK");
    if (newWrites.length) assert.ok(newWrites[0].body.overrides.some(override => override.style?.wireframe_color === color));
    assert.deepEqual(after.unexpected, []);
    assert.ok(after.renders - before.renders < 30, "Unbounded panel rerenders");
    assert.ok(after.calls.length - before.calls.length <= 8, "Unbounded resource refresh");
    if (lane === "object") assert.equal(await panel.getByRole("textbox", { name: "Name", exact: true }).inputValue(), "Unsaved antenna name");
    checks.push({ name: `${lane} ${property}: ${property === "primitiveMonoColor" ? "local completion" : "server ACK"} + held/released refetch`, passed: true, stability, writes: newWrites, renderDelta: after.renders - before.renders, requestDelta: after.calls.length - before.calls.length });
    await screenshot(`${lane}-${property}-after-refetch`);
  }
  await page.getByRole("button", { name: "Object fixture", exact: true }).click();
  await panel.getByRole("textbox", { name: "Primitive color", exact: true }).waitFor({ timeout });
  await page.evaluate(() => window.__primitiveColorFixture.solid(true));
  await page.waitForFunction(() => document.querySelector('[data-testid="primitive-inspector"]')?.textContent.includes("solid-shader"), undefined, { timeout });
  assert.ok((await panel.textContent()).includes("#bbaadd"));
  assert.equal((await read()).settings.primitiveMonoColor, "#d4af37");
  assert.equal(await panel.getByRole("textbox", { name: "Primitive color", exact: true }).inputValue(), "#d4af37");
  await page.evaluate(() => window.__primitiveColorFixture.solid(false));
  await page.waitForFunction(() => document.querySelector('[data-testid="primitive-inspector"]')?.textContent.includes("Preview color sourceprimitive"), undefined, { timeout });
  assert.ok((await panel.textContent()).includes("#d4af37"));
  assert.equal(await panel.getByRole("textbox", { name: "Primitive color", exact: true }).inputValue(), "#d4af37");
  checks.push({ name: "solid shader override takes precedence without erasing local primitive preference", passed: true });
  await screenshot("08-solid-override-cleared");
  const footer = page.getByRole("status", { name: "Live telemetry", exact: true });
  const energyLabels = ["Energy", "Exchange", "Demag", "Zeeman", "Anisotropy", "DMI"];
  const metric = label => footer.locator(".fm-footer-telemetry__metric").filter({ has: page.locator(".fm-footer-telemetry__metric-label span", { hasText: new RegExp(`^${label}$`) }) });
  const expectMetric = async (label, value, source) => {
    const item = metric(label);
    await page.waitForFunction(({ label, value, source }) => {
      const root = document.querySelector('[aria-label="Live telemetry"]');
      const item = [...root.querySelectorAll(".fm-footer-telemetry__metric")].find(node => node.querySelector(".fm-footer-telemetry__metric-label span")?.textContent === label);
      return item?.querySelector(".fm-footer-telemetry__metric-value > span")?.textContent === value && item.title.endsWith(`\n${source}`);
    }, { label, value, source }, { timeout });
    assert.equal(await item.count(), 1);
  };
  await footer.waitFor({ timeout });
  await page.evaluate(() => window.__primitiveColorFixture.telemetry("empty"));
  for (const label of energyLabels) await expectMetric(label, "—", "No energy sample");
  assert.ok(!(await read()).calls.some(call => call.path.includes("/metrics")), "Standalone antenna fetched magnetic metrics");
  checks.push({ name: "standalone antenna: six absent energies stay unavailable and no magnetic metric request", passed: true });
  const visibleEnergies = await footer.evaluate(root => {
    const grid = root.querySelector(".fm-footer-telemetry__metrics-grid").getBoundingClientRect();
    return [...root.querySelectorAll('[data-group="energy"]')].filter(node => {
      const box = node.getBoundingClientRect();
      return box.height > 0 && box.top >= grid.top && box.bottom <= grid.bottom + 1 && box.right <= grid.right;
    }).length;
  });
  assert.equal(visibleEnergies, 6, "All energy values must be visible in the allocated telemetry panel");
  await screenshot("09-footer-no-sample");

  await page.evaluate(() => window.__primitiveColorFixture.telemetry("partial"));
  await expectMetric("Energy", "0.000000e+0", "Live scalar sample");
  await expectMetric("Demag", "2", "Session summary");
  await expectMetric("Zeeman", "0.000000e+0", "Session summary");
  for (const label of ["Exchange", "Anisotropy", "DMI"]) await expectMetric(label, "—", "No energy sample");
  await expectMetric("avg mx", "0.250000", "Live scalar sample");
  checks.push({ name: "partial scalar row: real zeros preserved and independent summary/missing provenance", passed: true });
  await screenshot("10-footer-partial-sources");

  await page.evaluate(() => window.__primitiveColorFixture.telemetry("mixed"));
  await expectMetric("avg mx", "0.250000", "Live scalar sample");
  assert.ok(!(await read()).calls.some(call => call.path.includes("/metrics")), "Selecting antenna in mixed scene fetched object metrics");
  await page.evaluate(() => window.__primitiveColorFixture.telemetry("magnetic"));
  await expectMetric("Exchange", "4", "Object: explicit-magnetic");
  await expectMetric("Energy", "0.000000e+0", "Live scalar sample");
  await expectMetric("Demag", "2", "Session summary");
  await expectMetric("DMI", "—", "No energy sample");
  await expectMetric("avg mx", "0.250000", "Live scalar sample");
  assert.equal((await read()).calls.filter(call => call.path.includes("/metrics")).length, 1, "Only configured magnetic object may fetch scoped metrics");
  await screenshot("11-footer-magnetic-scope");
  await page.evaluate(() => window.__primitiveColorFixture.telemetry("placeholder"));
  for (const label of energyLabels) await expectMetric(label, "—", "No energy sample");
  await page.evaluate(() => window.__primitiveColorFixture.telemetry("zero"));
  for (const label of energyLabels) await expectMetric(label, "0.000000e+0", "Object: explicit-magnetic");
  checks.push({ name: "object placeholder zeros unavailable; actual finite zero solver sample preserved", passed: true });
  await page.evaluate(() => window.__primitiveColorFixture.telemetry("global"));
  for (const label of energyLabels) await expectMetric(label, "0.000000e+0", "Session summary (object resource)");
  assert.ok(!(await footer.innerText()).includes("Object: explicit-magnetic"), "Global row copied to object resource claimed object provenance");
  checks.push({ name: "global energy row transported by object resource retains session scope", passed: true });
  const beforeAntenna = (await read()).calls.length;
  await page.evaluate(() => window.__primitiveColorFixture.telemetry("antenna"));
  await expectMetric("Exchange", "—", "No energy sample");
  await expectMetric("avg mx", "0.250000", "Live scalar sample");
  assert.ok(!(await read()).calls.slice(beforeAntenna).some(call => call.path.includes("/metrics")), "Returning to antenna fetched object metrics");
  checks.push({ name: "mixed scene: global magnetization remains global, scoped energies drop on return to antenna", passed: true });
  await screenshot("12-footer-return-to-antenna");
  evidence = await read();
  assert.deepEqual(errors, []);
  assert.deepEqual(evidence.unexpected, []);
} catch (error) {
  failure = { message: error.message, stack: error.stack };
  if (page) { const path = resolve(directory, "failure.png"); await page.screenshot({ path, fullPage: true }).catch(() => {}); screenshots.push(path); evidence = await page.evaluate(() => window.__primitiveColorFixture?.read()).catch(() => null); }
} finally {
  await browser?.close();
  await writeFile(resolve(directory, "primitive-color-inspector.json"), JSON.stringify({ schema: "fullmag_primitive_color_inspector_browser_fixture_v1", state: failure ? "failed" : "passed", qualification: "controlled_inspector_fixture_not_solver_or_webgl", primitive_local_frame_server_ack: true, checks, screenshots, errors, evidence, failure }, null, 2) + "\n");
}
if (failure) throw new Error(failure.message);
console.log(JSON.stringify({ check: "primitive-color-inspector", groups: checks.length, passed: true }));
