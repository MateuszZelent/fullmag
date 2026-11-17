import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const playwrightRequire = createRequire(require.resolve("playwright/package.json"));
const { PNG } = playwrightRequire("playwright-core/lib/utilsBundle");
const url = process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:8080/workspace";
const readOnlyApi = process.env.FULLMAG_RENDER_READ_ONLY_API_BASE;
const orientationProof = process.env.FULLMAG_RENDER_ORIENTATION_PROOF === "1";
const directory = resolve(process.env.CONTROL_ROOM_AUDIT_ARTIFACTS_DIR ?? ".artifacts/field-presentation");
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1668, height: 1000 }, colorScheme: "dark" });
const errors = [], deniedMutations = [], frames = {}, audit = {};
const ui = {};
const responses = new Map();
let failure = null;
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("403 (Forbidden)")) errors.push(message.text());
});

// The browser uses current production renderer code but cannot author into its data source.
await page.route("**/v2/**", async (route) => {
  const request = route.request();
  const parsed = new URL(request.url());
  if (request.method() !== "GET") {
    deniedMutations.push({ method: request.method(), path: parsed.pathname });
    return route.fulfill({ status: 403, body: "Read-only renderer verification" });
  }
  if (!readOnlyApi) return route.continue();
  const resource = parsed.pathname + parsed.search;
  // Topology and field resources use HTTP byte ranges. Each range is a distinct response.
  const key = `${resource}|range=${request.headers().range ?? ""}|scope=${request.headers()["x-fullmag-session-scope"] ?? ""}`;
  if (!responses.has(key)) {
    const response = await page.request.get(new URL(resource, readOnlyApi).href, { headers: request.headers(), timeout: 120_000 });
    let body = await response.body();
    if (orientationProof && parsed.pathname.endsWith("/visualization/state") && response.ok()) {
      const state = JSON.parse(body);
      for (const target of state.targets?.objects ?? []) {
        target.settings.active_quantity_id = "m";
        target.settings.surface_color_source = "orientation";
        if (target.override) {
          target.override.quantity = { active_quantity_id: "m" };
          target.override.style = { ...target.override.style, surface_color_source: "orientation" };
        }
      }
      for (const override of state.overrides ?? []) {
        if (override.scope !== "object") continue;
        override.quantity = { active_quantity_id: "m" };
        override.style = { ...override.style, surface_color_source: "orientation" };
      }
      // Display-only fixture: choose +X orientation and a repeatable camera without changing field values.
      state.camera = { ...state.camera, position: [-3.730710e-6, -2.863532e-6, 3.654640e-6],
        target: [0, 0, 0], orthographic_scale: 7.5e-6 };
      body = Buffer.from(JSON.stringify(state));
    }
    const headers = { ...response.headers() };
    delete headers["content-length"];
    delete headers["content-encoding"];
    responses.set(key, { status: response.status(), headers, body });
  }
  return route.fulfill(responses.get(key));
});
await page.addInitScript(() => {
  window.__FULLMAG_CONFIG__ = { disableRealtime: true, enableAuditHooks: true };
  localStorage.setItem("fullmag.control-room.theme", "dark");
});
const canvas = page.locator(".fm-viewport-3d canvas");
const readAudit = () => page.evaluate(() => window.__FULLMAG_READ_VIEWPORT_3D_LIGHTING__?.());
const waitMode = (mode) => page.waitForFunction((expected) => {
  const fields = window.__FULLMAG_READ_VIEWPORT_3D_LIGHTING__?.().presentation?.fieldMaterials;
  return fields?.length > 0 && fields.every((material) => material.kind === expected);
}, mode, { timeout: 180_000 });
async function chooseMode(mode) {
  await page.getByRole("radio", { name: mode === "presentation" ? "Presentation" : "Scientific", exact: true }).click();
  await waitMode(mode);
}
async function capture(name) {
  assert.equal(await canvas.isVisible(), true);
  const context = await canvas.evaluate((element) => {
    const gl = element.getContext("webgl2") ?? element.getContext("webgl");
    return { lost: gl?.isContextLost(), width: gl?.drawingBufferWidth, height: gl?.drawingBufferHeight };
  });
  assert.equal(context.lost, false);
  assert.ok(context.width > 0 && context.height > 0);
  const bytes = await canvas.screenshot({ type: "png", timeout: 120_000 });
  await writeFile(resolve(directory, `${name}.png`), bytes);
  const image = PNG.sync.read(bytes), red = [];
  for (let y = Math.floor(image.height * 0.15); y < image.height * 0.8; y++) {
    for (let x = Math.floor(image.width * 0.2); x < image.width * 0.8; x++) {
      const offset = (y * image.width + x) * 4;
      const [r, g, b] = image.data.subarray(offset, offset + 3);
      if (r > 55 && r > g * 2 && r > b * 2) red.push(r);
    }
  }
  red.sort((a, b) => a - b);
  frames[name] = { ...context, redPixels: red.length, redP05: red[Math.floor(red.length * 0.05)], redP95: red[Math.floor(red.length * 0.95)] };
  audit[name] = await readAudit();
  return image;
}
function changedPixels(a, b) {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 12) changed++;
  }
  return changed;
}
try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await canvas.waitFor({ state: "visible", timeout: 180_000 });
  await waitMode("scientific");
  console.log("field-presentation: scientific field surface ready");
  await page.getByRole("button", { name: "View settings", exact: true }).click();
  await page.getByRole("tab", { name: "Quality", exact: true }).click();
  const modeGroup = page.getByRole("radiogroup", { name: "Visualization mode", exact: true });
  assert.equal(await modeGroup.count(), 1);
  assert.equal(await modeGroup.getByRole("radio").count(), 2);
  assert.equal(await page.getByRole("radio", { name: "Presentation", exact: true }).isVisible(), true);
  const quality = await page.getByRole("combobox", { name: "Quality profile", exact: true }).textContent();
  const scientific = await capture("scientific");
  await page.getByRole("radio", { name: "Scientific", exact: true }).focus();
  await page.getByRole("radio", { name: "Scientific", exact: true }).press("ArrowRight");
  await waitMode("presentation");
  assert.equal(await page.getByRole("radio", { name: "Presentation", exact: true }).getAttribute("aria-checked"), "true");
  assert.equal(await page.getByRole("combobox", { name: "Quality profile", exact: true }).textContent(), quality);
  ui.modeVisibleInQuality = true;
  ui.keyboardModeSelection = true;
  ui.qualityUnchanged = quality;
  await page.locator(".fm-viewport-3d-settings").screenshot({ path: resolve(directory, "inspector-quality-mode.png"), animations: "disabled" });
  console.log("field-presentation: PBR field surface ready");
  const presentation = await capture("presentation");
  assert.equal(audit.presentation.presentation.environmentReady, true);
  assert.ok(audit.presentation.presentation.fieldMaterials.every((material) => material.normals > 0 && material.castShadow && material.receiveShadow));
  assert.deepEqual(audit.presentation.presentation.fieldMaterials.map((material) => material.geometry), audit.scientific.presentation.fieldMaterials.map((material) => material.geometry));
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  assert.equal(await page.getByRole("radiogroup", { name: "Visualization mode", exact: true }).count(), 1);
  assert.equal(await page.getByRole("radio", { name: "Presentation", exact: true }).getAttribute("aria-checked"), "true");
  await page.getByRole("button", { name: "Advanced light direction", exact: true }).click();
  await page.locator("#fm-view-light-azimuth-number").fill("95");
  await page.locator("#fm-view-light-azimuth-number").press("Enter");
  const rotated = await capture("presentation-light-rotated");
  const lightDifference = changedPixels(presentation, rotated);
  assert.ok(lightDifference > 1000, `Light direction did not change enough pixels: ${lightDifference}`);
  await chooseMode("scientific");
  const restored = await capture("scientific-restored");
  assert.equal(audit["scientific-restored"].presentation.environmentReady, false);
  assert.deepEqual(audit["scientific-restored"].presentation.fieldMaterials.map((material) => material.geometry), audit.scientific.presentation.fieldMaterials.map((material) => material.geometry));
  assert.ok(changedPixels(scientific, restored) < 50, "Scientific colors changed after a Presentation round trip");
  if (orientationProof) {
    assert.ok(frames.scientific.redPixels > 2000 && frames.presentation.redPixels > 2000, "The orientation-colored model was not visible");
    const before = frames.scientific.redP95 - frames.scientific.redP05;
    const after = frames.presentation.redP95 - frames.presentation.redP05;
    assert.ok(after > before + 20, `Presentation did not reveal shape in a uniform red field: ${before} -> ${after}`);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ state: "passed", frames, lightDifference, report: directory }));
} catch (error) {
  failure = error.message;
  audit.failed = await readAudit().catch(() => null);
  await page.screenshot({ path: resolve(directory, "failure.png"), timeout: 120_000 }).catch(() => {});
  console.error(failure);
  process.exitCode = 1;
} finally {
  await writeFile(resolve(directory, "proof.json"), JSON.stringify({ state: failure ? "failed" : "passed", qualification: "browser-renderer-only", orientationProof, readOnlyReplica: Boolean(readOnlyApi), failure, errors, deniedMutations, frames, audit, ui }, null, 2));
  await page.unrouteAll({ behavior: "wait" });
  await browser.close();
}
