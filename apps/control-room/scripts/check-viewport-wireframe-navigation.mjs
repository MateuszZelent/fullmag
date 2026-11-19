import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { installViewportReadOnlyReplica, prepareViewportOrientationProof } from "./lib/viewport-read-only-replica.mjs";

const url = process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:8080/workspace";
const apiBase = process.env.FULLMAG_RENDER_READ_ONLY_API_BASE;
const modes = (process.env.FULLMAG_NAVIGATION_MODES ?? "scientific,presentation").split(",");
const directory = resolve(process.env.CONTROL_ROOM_AUDIT_ARTIFACTS_DIR ?? ".artifacts/wireframe-navigation");
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ headless: true });
const cases = [];
let failure = null;

function wireframeFixture(state, scope) {
  prepareViewportOrientationProof(state);
  for (const group of [state.targets?.objects, state.targets?.parts]) {
    for (const target of group ?? []) {
      target.settings.wireframe_visible = true;
      target.settings.wireframe_geometry_scope = scope;
      if (target.override) target.override.display = { ...target.override.display,
        wireframe: { ...target.override.display?.wireframe, visible: true }, wireframe_geometry_scope: scope };
    }
  }
  for (const override of state.overrides ?? []) {
    if (override.scope === "object" || override.scope === "part") {
      override.display = { ...override.display, wireframe: { ...override.display?.wireframe, visible: true }, wireframe_geometry_scope: scope };
    }
  }
  return state;
}

async function checkScope(scope, mode) {
  const page = await browser.newPage({ viewport: { width: 1668, height: 1000 }, colorScheme: "dark" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const replica = await installViewportReadOnlyReplica(page, { apiBase,
    transformVisualizationState: (state) => wireframeFixture(state, scope) });
  await page.addInitScript(() => {
    window.__FULLMAG_CONFIG__ = { disableRealtime: true, enableAuditHooks: true };
    window.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__ = { publishes: 0, scans: 0, viewportFrames: 0 };
    localStorage.setItem("fullmag.control-room.theme", "dark");
  });
  const readWireframes = () => page.evaluate(() => window.__FULLMAG_READ_VIEWPORT_3D_LIGHTING__?.().presentation?.wireframes ?? []);
  const canvas = page.locator(".fm-viewport-3d canvas");
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180_000 });
    await canvas.waitFor({ state: "visible", timeout: 180_000 });
    if (mode === "presentation") {
      await page.getByRole("button", { name: "View settings", exact: true }).click();
      await page.getByRole("radio", { name: "Presentation", exact: true }).click();
      await page.waitForFunction(() => {
        const audit = window.__FULLMAG_READ_VIEWPORT_3D_LIGHTING__?.().presentation;
        return audit?.environmentReady && audit.fieldMaterials.length > 0 && audit.fieldMaterials.every((material) => material.kind === "presentation");
      }, undefined, { timeout: 180_000 });
    }
    await page.waitForFunction(() => {
      const wires = window.__FULLMAG_READ_VIEWPORT_3D_LIGHTING__?.().presentation?.wireframes;
      return wires?.length > 0 && wires.every((wire) => wire.interactionGeometry && wire.indices > 0);
    }, undefined, { timeout: 180_000 });
    await page.waitForTimeout(1000);
    const before = await readWireframes();
    assert.ok(before.every((wire) => wire.geometry === wire.fullGeometry));
    const gl = await canvas.evaluate((element) => {
      const context = element.getContext("webgl2") ?? element.getContext("webgl");
      const extension = context.getExtension("WEBGL_debug_renderer_info");
      return { lost: context.isContextLost(), width: context.drawingBufferWidth, height: context.drawingBufferHeight,
        renderer: extension ? context.getParameter(extension.UNMASKED_RENDERER_WEBGL) : "unknown" };
    });
    assert.equal(gl.lost, false);
    assert.ok(gl.width > 0 && gl.height > 0);
    await canvas.screenshot({ path: resolve(directory, `${mode}-${scope}-rest.png`) });
    const trials = [];
    for (const interval of [250, 330]) {
      await page.evaluate(() => window.__FULLMAG_VIEWPORT3D_CAMERA_AUDIT__.clear());
      const samples = await canvas.evaluate(async (element, gap) => {
        const box = element.getBoundingClientRect();
        const frames = [];
        for (let index = 0; index < 5; index++) {
          element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true,
            clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, deltaY: -35 }));
          await new Promise(requestAnimationFrame);
          frames.push({ time: performance.now(),
            wires: window.__FULLMAG_READ_VIEWPORT_3D_LIGHTING__?.().presentation?.wireframes ?? [] });
          if (index < 4) await new Promise((done) => setTimeout(done, gap));
        }
        return frames;
      }, interval);
      assert.ok(samples.some((sample) => sample.wires.some((wire) => wire.geometry === wire.interactionGeometry)));
      assert.ok(samples.every((sample) => sample.wires.every((wire) => wire.indices <= 24_000)));
      await page.waitForFunction(() => {
        const commits = window.__FULLMAG_VIEWPORT3D_CAMERA_AUDIT__.snapshot().filter((sample) => sample.reason === "commit" && sample.liveCamera);
        const wires = window.__FULLMAG_READ_VIEWPORT_3D_LIGHTING__?.().presentation?.wireframes ?? [];
        return commits.length > 0 && wires.every((wire) => wire.geometry === wire.fullGeometry);
      }, undefined, { timeout: 30_000 });
      const trajectory = await page.evaluate(() => window.__FULLMAG_VIEWPORT3D_CAMERA_AUDIT__.snapshot());
      const commits = trajectory.filter((sample) => sample.reason === "commit" && sample.liveCamera);
      const changes = trajectory.filter((sample) => sample.reason === "change" && sample.liveCamera);
      assert.equal(commits.length, 1, `Expected one final pose commit for wheel impulses ${interval} ms apart`);
      const scale = changes.map((sample) => sample.liveCamera.orthographicScale).filter((value) => value !== null);
      assert.ok(scale.every((value, index) => index === 0 || value <= scale[index - 1] * (1 + 1e-7)), "Orthographic zoom reversed during the gesture");
      const restored = await readWireframes();
      assert.deepEqual(restored.map((wire) => [wire.geometry, wire.indices]), before.map((wire) => [wire.geometry, wire.indices]));
      trials.push({ interval, samples, commits, changeCount: changes.length });
    }
    await page.waitForTimeout(1200);
    const idleStart = await page.evaluate(() => window.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__.viewportFrames);
    await page.waitForTimeout(600);
    const idleFrames = await page.evaluate((start) => window.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__.viewportFrames - start, idleStart);
    assert.ok(idleFrames <= 1, `Idle viewport kept drawing: ${idleFrames} frames`);
    assert.deepEqual(errors, []);
    return { mode, scope, gl, before, after: await readWireframes(), trials, idleFrames,
      deniedMutations: replica.deniedMutations, errors };
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await page.close();
  }
}

try {
  for (const mode of modes) {
    assert.ok(["scientific", "presentation"].includes(mode));
    for (const scope of ["surface", "full"]) {
      cases.push(await checkScope(scope, mode));
      console.log(`wireframe-navigation: ${mode} ${scope} passed`);
    }
  }
} catch (error) {
  failure = error.message;
  console.error(failure);
  process.exitCode = 1;
} finally {
  await writeFile(resolve(directory, "proof.json"), JSON.stringify({ state: failure ? "failed" : "passed",
    qualification: "read-only-renderer-proof-not-hardware-fps-or-science", readOnlyReplica: Boolean(apiBase), failure, cases }, null, 2));
  await browser.close();
}
