import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { choose } from "./lib/viewport-appearance-browser-qa.mjs";

const require = createRequire(import.meta.url);
const playwrightRequire = createRequire(require.resolve("playwright/package.json"));
const { PNG } = playwrightRequire("playwright-core/lib/utilsBundle");
const url = process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:8080/workspace";
const apiBase = process.env.FULLMAG_RENDER_READ_ONLY_API_BASE;
assert.ok(apiBase, "Figure QA requires an explicit read-only API data source");
const directory = resolve(process.env.CONTROL_ROOM_AUDIT_ARTIFACTS_DIR ?? ".artifacts/figure-quality");
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ headless: true });
const cases = [];
let failure = null;

function changedPixels(a, b) {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 12) changed++;
  }
  return changed;
}

async function checkMode(mode) {
  const page = await browser.newPage({ viewport: { width: 1668, height: 1000 }, deviceScaleFactor: 1, colorScheme: "dark" });
  const errors = [], deniedMutations = [], frames = {};
  const responses = new Map();
  let tearingDown = false;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("403 (Forbidden)")) errors.push(message.text());
  });
  // Freeze reads by range and session scope. No browser mutation reaches the real session.
  await page.route("**/v2/**", async (route) => {
    try {
      const request = route.request(), parsed = new URL(request.url());
      if (request.method() !== "GET") {
        deniedMutations.push({ method: request.method(), path: parsed.pathname });
        return await route.fulfill({ status: 403, body: "Read-only Figure renderer verification" });
      }
      const resource = parsed.pathname + parsed.search;
      const key = `${resource}|range=${request.headers().range ?? ""}|scope=${request.headers()["x-fullmag-session-scope"] ?? ""}`;
      if (!responses.has(key)) {
        const response = await page.request.get(new URL(resource, apiBase).href, { headers: request.headers(), timeout: 120_000 });
        let body = await response.body();
        if (parsed.pathname.endsWith("/visualization/state") && response.ok()) {
          const state = JSON.parse(body);
          // A display-only camera fixture; field values and selected quantities are unchanged.
          state.camera = { ...state.camera, position: [-3.730710e-6, -2.863532e-6, 3.654640e-6], target: [0, 0, 0], orthographic_scale: 7.5e-6 };
          body = Buffer.from(JSON.stringify(state));
        }
        const headers = { ...response.headers() };
        delete headers["content-length"];
        delete headers["content-encoding"];
        responses.set(key, { status: response.status(), headers, body });
      }
      return await route.fulfill(responses.get(key));
    } catch (error) {
      if (tearingDown && /Route is already handled|Target page, context or browser has been closed/.test(error.message)) return;
      throw error;
    }
  });
  await page.addInitScript(() => {
    window.__FULLMAG_CONFIG__ = { disableRealtime: true, enableAuditHooks: true };
    window.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__ = { publishes: 0, scans: 0, viewportFrames: 0 };
    localStorage.setItem("fullmag.control-room.theme", "dark");
  });
  const canvas = page.locator(".fm-viewport-3d canvas");
  async function toggle(id, enabled) {
    const control = page.locator(id);
    if ((await control.getAttribute("aria-checked")) !== String(enabled)) await control.click();
    assert.equal(await control.getAttribute("aria-checked"), String(enabled));
  }
  async function capture(name) {
    assert.equal(await canvas.isVisible(), true);
    const frame = await canvas.evaluate((element) => {
      const gl = element.getContext("webgl2") ?? element.getContext("webgl");
      const rect = element.getBoundingClientRect();
      return { lost: gl?.isContextLost(), width: gl?.drawingBufferWidth, height: gl?.drawingBufferHeight, cssWidth: rect.width, cssHeight: rect.height, devicePixelRatio };
    });
    assert.equal(frame.lost, false);
    assert.ok(frame.width > 0 && frame.height > 0);
    const bytes = await canvas.screenshot({ type: "png", timeout: 120_000 });
    await writeFile(resolve(directory, `${mode}-${name}.png`), bytes);
    frames[name] = frame;
    return PNG.sync.read(bytes);
  }
  async function quality(label, ratio) {
    await choose(page, "Quality profile", label, "fm-view-quality", 20_000);
    await page.waitForFunction((expected) => {
      const c = document.querySelector(".fm-viewport-3d canvas");
      const size = c?.getBoundingClientRect();
      return c && Math.abs(c.width - size.width * expected) < 2 && Math.abs(c.height - size.height * expected) < 2;
    }, ratio, { timeout: 30_000 });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  }
  async function assertFigureEffects() {
    await page.getByRole("tab", { name: "Quality", exact: true }).click();
    assert.equal(await page.locator("#fm-viewport-3d-effect-ambient-occlusion").getAttribute("aria-checked"), "true");
    assert.equal(await page.locator("#fm-view-shadows").getAttribute("aria-checked"), "true");
    await page.waitForFunction(() => {
      const audit = window.__FULLMAG_READ_VIEWPORT_3D_LIGHTING__?.();
      return audit?.presentation.environmentReady && audit.presentation.pbrMaterials.length + audit.presentation.fieldMaterials.length > 0;
    }, undefined, { timeout: 120_000 });
    assert.match(await page.locator(".fm-viewport-3d-settings__status").filter({ hasText: /^Ambient occlusion:/ }).textContent(), /, effective/);
  }
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180_000 });
    await canvas.waitFor({ state: "visible", timeout: 120_000 });
    await page.waitForFunction(() => {
      const audit = window.__FULLMAG_READ_VIEWPORT_3D_LIGHTING__?.();
      return audit && audit.litPrimitiveMeshCount + audit.otherSurfaceMeshCount > 0;
    }, undefined, { timeout: 120_000 });
    const originalCanvas = await canvas.elementHandle();
    await page.getByRole("button", { name: "View settings", exact: true }).click();
    await choose(page, "Visualization mode", mode === "scientific" ? "Scientific" : "Presentation", undefined, 20_000);
    if (mode === "presentation") {
      await choose(page, "Geometry appearance", "Flat", "fm-view-lighting", 20_000);
      await page.getByRole("tab", { name: "Quality", exact: true }).click();
      await toggle("#fm-view-shadows", false);
    }
    await quality("Standard", 1);
    await toggle("#fm-viewport-3d-effect-ambient-occlusion", false);
    const standard = await capture("standard");
    await quality("Figure", 2);
    if (mode === "presentation") await assertFigureEffects();
    else assert.equal(await page.locator("#fm-viewport-3d-effect-ambient-occlusion").getAttribute("aria-checked"), "false");
    const figure = await capture("figure");
    const difference = changedPixels(standard, figure);
    assert.ok(difference > 100, `Figure did not visibly change the image at DPR1: ${difference}`);
    assert.equal(await page.evaluate((node) => node === document.querySelector(".fm-viewport-3d canvas"), originalCanvas), true);

    if (mode === "scientific") {
      await choose(page, "Visualization mode", "Presentation", undefined, 20_000);
      await assertFigureEffects();
    }
    const effectOn = await capture("effects-on");
    await toggle("#fm-viewport-3d-effect-ambient-occlusion", false);
    await toggle("#fm-view-shadows", false);
    const effectOff = await capture("effects-off");
    const effectsDifference = changedPixels(effectOn, effectOff);
    assert.ok(effectsDifference > 100, `Figure shadows/AO did not affect the actual pixels: ${effectsDifference}`);
    if (mode === "scientific") await choose(page, "Visualization mode", "Scientific", undefined, 20_000);
    await quality("Standard", 1);
    const restored = await capture("standard-restored");
    if (mode === "scientific") assert.ok(changedPixels(standard, restored) < 50, "Scientific image did not restore after Figure/Presentation");
    await page.waitForTimeout(1200);
    const idleStart = await page.evaluate(() => window.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__.viewportFrames);
    await page.waitForTimeout(600);
    const idleFrames = await page.evaluate((start) => window.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__.viewportFrames - start, idleStart);
    assert.ok(idleFrames <= 1, `Viewport kept rendering while idle: ${idleFrames}`);
    const audit = await page.evaluate(() => window.__FULLMAG_READ_VIEWPORT_3D_LIGHTING__?.());
    assert.deepEqual(errors, []);
    return { mode, frames, difference, effectsDifference, idleFrames, renderedSource: audit?.presentation.fieldMaterials.length ? "field surface" : "solid geometry", errors, deniedMutations };
  } catch (error) {
    await page.screenshot({ path: resolve(directory, `${mode}-failure.png`), timeout: 120_000 }).catch(() => {});
    throw error;
  } finally {
    tearingDown = true;
    await page.unrouteAll({ behavior: "wait" });
    await page.close();
  }
}

try {
  for (const mode of ["scientific", "presentation"]) {
    const result = await checkMode(mode);
    cases.push(result);
    console.log(JSON.stringify({ mode, difference: result.difference, effectsDifference: result.effectsDifference, frames: result.frames, idleFrames: result.idleFrames }));
  }
} catch (error) {
  failure = error.message;
  console.error(failure);
  process.exitCode = 1;
} finally {
  await writeFile(resolve(directory, "proof.json"), JSON.stringify({ state: failure ? "failed" : "passed", qualification: "read-only browser renderer proof, not solver physics or hardware FPS", failure, cases }, null, 2));
  await browser.close();
}
