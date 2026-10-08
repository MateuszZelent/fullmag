import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const storage = process.env.FULLMAG_PROJECT_STORAGE_ROOT, output = process.env.FULLMAG_ANTENNA_CPW_VIEWPORT_REPORT_DIR;
if (!storage || !output || !isAbsolute(storage) || !isAbsolute(output)) throw new Error("Managed absolute storage/report paths required");
const descendant = (root, path) => { const suffix = relative(root, path); return Boolean(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); };
const directory = resolve(output), realStorage = await realpath(storage);
if (!descendant(resolve(storage), directory) || !descendant(realStorage, await realpath(dirname(directory)))) throw new Error("Report path escaped storage");
await mkdir(directory, { recursive: true });
if (!descendant(realStorage, await realpath(directory))) throw new Error("Report junction escaped storage");
let browser, page, failure = null;
const errors = [], checks = [], screenshots = [], evidence = [];
const close = (a, b) => assert.ok(Math.abs(a - b) < 5e-14, `${a} != ${b}`);
try {
  let playwright;
  try { playwright = await import("playwright"); } catch { playwright = await import("@playwright/test"); }
  const channel = process.env.FULLMAG_ANTENNA_CPW_VIEWPORT_BROWSER_CHANNEL;
  if (channel && !["chrome", "msedge"].includes(channel)) throw new Error("Unsupported browser channel");
  browser = await playwright.chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" || /Context Lost/.test(message.text())) errors.push(message.text()); });
  await page.goto(process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:3260/antenna-cpw-viewport", { waitUntil: "domcontentloaded", timeout: 60_000 });
  const read = () => page.evaluate(() => window.__antennaCpwViewport.read());
  const wait = (predicate) => page.waitForFunction(predicate, undefined, { timeout: 60_000 });
  const nextFrame = (frames) => page.waitForFunction((previous) => window.__antennaCpwViewport.read().frames > previous, frames, { timeout: 60_000 });
  const shot = async (name) => { const path = resolve(directory, `${name}.png`); await page.screenshot({ path, fullPage: true }); screenshots.push(path); };
  await wait(() => window.__antennaCpwViewport?.read().meshes.length === 2);
  assert.equal(await page.locator("canvas").count(), 1);
  assert.equal(await page.locator("canvas").isVisible(), true);
  for (const side of ["above", "below"]) {
    const before = await read();
    await page.getByRole("button", { name: side === "above" ? "Above sample" : "Below sample", exact: true }).click();
    await wait(() => window.__antennaCpwViewport.read().meshes.length === 2);
    if (before.side !== side) await nextFrame(before.frames);
    await page.waitForTimeout(300);
    const state = await read();
    assert.equal(state.side, side);
    assert.equal(state.contextLost, false);
    assert.ok(state.width > 0 && state.height > 0);
    const antenna = state.meshes.find((mesh) => mesh.id === "cpw-preview-source"), target = state.meshes.find((mesh) => mesh.id === "waveguide-preview-target");
    assert.ok(antenna && target);
    assert.equal(antenna.vertices, 72);
    assert.equal(antenna.indices, 396);
    assert.deepEqual(antenna.parts.map((part) => part.id), ["signal-custom", "ground-left-custom", "ground-right-custom"]);
    assert.equal(antenna.color, state.expectedGold);
    close(side === "above" ? antenna.min[2] - target.max[2] : target.min[2] - antenna.max[2], 200e-9);
    const pixels = await page.evaluate(() => window.__antennaCpwViewport.pixels());
    assert.ok(pixels.gold > 200, `Unreadable or absent gold CPW: ${pixels.gold} pixels`);
    await shot(`cpw-${side}`);
    const frames = state.frames;
    await page.waitForTimeout(600);
    assert.equal((await read()).frames, frames, "Idle canvas rendered additional frames");
    evidence.push({ state, pixels }); checks.push(`${side}: WebGL, three conductor lofts, gold pixels, clearance and idle`);
  }
  const beforeInvalid = await read();
  await page.getByRole("button", { name: "Toggle invalid CPW", exact: true }).click();
  await wait(() => window.__antennaCpwViewport.read().invalid && window.__antennaCpwViewport.read().meshes.length === 1);
  await nextFrame(beforeInvalid.frames);
  const invalid = await read();
  assert.equal(invalid.meshes[0].id, "waveguide-preview-target");
  assert.ok(invalid.diagnostics.some((diagnostic) => diagnostic.objectId === "cpw-preview-source" && diagnostic.message.includes("left_gap_m")));
  const withoutAntenna = await page.evaluate(() => window.__antennaCpwViewport.pixels());
  assert.ok(withoutAntenna.gold < Math.min(...evidence.map((item) => item.pixels.gold)) / 4, "Gold pixel proof must disappear with the antenna, not come from sample/background");
  evidence.push({ invalid, withoutAntenna });
  await shot("cpw-invalid-no-box"); checks.push("invalid CPW omitted with diagnostics and no box fallback");
  await page.getByRole("button", { name: "Toggle invalid CPW", exact: true }).click();
  await wait(() => !window.__antennaCpwViewport.read().invalid && window.__antennaCpwViewport.read().meshes.length === 2);
  await nextFrame(invalid.frames);
  const baseline = (await read()).geometries;
  for (let iteration = 0; iteration < 3; iteration++) {
    const beforeUnmount = await read();
    await page.getByRole("button", { name: "Toggle layer", exact: true }).click();
    await wait(() => !window.__antennaCpwViewport.read().mounted && window.__antennaCpwViewport.read().geometries === 0 && window.__antennaCpwViewport.read().meshes.length === 0);
    await nextFrame(beforeUnmount.frames);
    assert.equal((await read()).contextLost, false);
    const beforeRemount = await read();
    await page.getByRole("button", { name: "Toggle layer", exact: true }).click();
    await wait(() => window.__antennaCpwViewport.read().mounted && window.__antennaCpwViewport.read().meshes.length === 2);
    await nextFrame(beforeRemount.frames);
    const remounted = await read();
    assert.equal(remounted.geometries, baseline);
    assert.equal(remounted.contextLost, false);
    evidence.push({ iteration, unmounted: beforeRemount, remounted });
  }
  checks.push("three layer mount/unmount cycles release tracked geometry with active WebGL");
  await shot("cpw-restored");
  assert.deepEqual(errors, []);
} catch (error) {
  failure = { message: error.message, stack: error.stack };
  if (page) await shotFailure();
} finally {
  await browser?.close();
  await writeFile(resolve(directory, "antenna-cpw-viewport.json"), JSON.stringify({ schema: "fullmag_antenna_cpw_viewport_browser_fixture_v1", state: failure ? "failed" : "passed", qualification: "production_primitive_layer_fixture_not_api_solver_or_science", checks, screenshots, evidence, errors, failure }, null, 2) + "\n");
}
async function shotFailure() { const path = resolve(directory, "failure.png"); await page.screenshot({ path, fullPage: true }).catch(() => {}); screenshots.push(path); }
if (failure) throw new Error(failure.message);
console.log(JSON.stringify({ check: "antenna-cpw-viewport", passed: true, groups: checks.length }));
