import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const url = process.env.CONTROL_ROOM_URL;
const storage = process.env.FULLMAG_PROJECT_STORAGE_ROOT;
const output = process.env.FULLMAG_ARTIFACT_FIELD_OVERLAY_REPORT_DIR;
if (!url || !storage || !output || !isAbsolute(storage) || !isAbsolute(output)) throw new Error("Managed artifact fixture URL/storage/output are required");
const inside = (root, target) => { const suffix = relative(root, target); return Boolean(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); };
const directory = resolve(output);
if (!inside(await realpath(storage), await realpath(dirname(directory)))) throw new Error("Artifact fixture output escaped storage");
await mkdir(directory, { recursive: true });
if (!inside(await realpath(storage), await realpath(directory))) throw new Error("Artifact fixture output escaped storage");
const checks = [], screenshots = [], errors = [];
let browser, failure, page;
try {
  let playwright;
  try { playwright = await import("playwright"); } catch { playwright = await import("@playwright/test"); }
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.FULLMAG_ARTIFACT_FIELD_OVERLAY_BROWSER_CHANNEL ? { channel: process.env.FULLMAG_ARTIFACT_FIELD_OVERLAY_BROWSER_CHANNEL } : {}) });
  page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" || /THREE.Color: Unknown color/.test(message.text())) errors.push(message.text()); });
  await page.addInitScript(() => {
    window.__artifactWorkerDelayMs = 0; window.__artifactDelayedWorkerMessages = 0;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) { super(url, options); this.glyph = options?.name === "fullmag-viewport3d-vector-glyph-build"; this.wrapped = new Map(); this.timers = new Set(); }
      addEventListener(type, listener, options) {
        if (!this.glyph || type !== "message") return super.addEventListener(type, listener, options);
        const receive = event => {
          const deliver = () => typeof listener === "function" ? listener.call(this, event) : listener.handleEvent(event);
          if (!window.__artifactWorkerDelayMs) return deliver();
          window.__artifactDelayedWorkerMessages++;
          const timer = setTimeout(() => { this.timers.delete(timer); deliver(); }, window.__artifactWorkerDelayMs); this.timers.add(timer);
        };
        this.wrapped.set(listener, receive); return super.addEventListener(type, receive, options);
      }
      removeEventListener(type, listener, options) { const receive = this.wrapped?.get(listener) ?? listener; this.wrapped?.delete(listener); return super.removeEventListener(type, receive, options); }
      terminate() { for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); return super.terminate(); }
    };
  });
  await page.goto(url);
  const read = () => page.evaluate(() => ({ state: window.__artifactOverlayFixture?.read(), canvas: window.__artifactOverlayCanvas?.() }));
  const ready = async q => {
    await page.waitForFunction(quantity => { const state = window.__artifactOverlayFixture?.read(); return state?.model && state.quantity === quantity; }, q, { timeout: 60000 });
    await page.waitForFunction(q => { const canvas = window.__artifactOverlayCanvas?.(); return canvas?.groups === 1 && canvas.surfaceTriangles === (q === "J_charge" ? 6 : 4); }, q);
    const result = await read();
    assert.equal(await page.locator("[data-artifact-field-viewport] canvas").isVisible(), true);
    assert.equal(result.canvas.lost, false); assert.ok(result.canvas.width > 0 && result.canvas.height > 0);
    assert.equal(result.state.historical, true); assert.equal(result.state.error, null); assert.deepEqual(result.state.unexpected, []);
    const fieldLabel = page.locator("[data-artifact-field-hud] [data-quantity-id]");
    assert.equal(await fieldLabel.getAttribute("data-quantity-id"), q);
    assert.equal(await fieldLabel.getAttribute("data-field-state"), "ready");
    assert.equal(await fieldLabel.textContent(), `${q} [${result.state.unit}]`);
    assert.equal(await page.locator('[data-probe="vectors-only"] span').getAttribute("data-field-state"), "data-ready");
    assert.equal(await page.locator('[data-probe="intent-only"] span').getAttribute("data-field-state"), "no-data");
    const payloadLabel = page.locator('[data-probe="payload"] span');
    assert.equal(await payloadLabel.getAttribute("data-field-state"), "data-ready");
    assert.equal(await payloadLabel.textContent(), q);
    const differentQuantity = page.locator('[data-probe="different-quantity"] span');
    assert.equal(await differentQuantity.getAttribute("data-field-state"), "no-data");
    assert.equal(await differentQuantity.textContent(), "m · no field data");
    assert.equal(await page.locator('[data-probe="absent"] span').getAttribute("data-field-state"), "no-data");
    return result;
  };
  const screenshot = async name => { const path = resolve(directory, `${name}.png`); await page.screenshot({ path, fullPage: true }); screenshots.push(path); };
  const assertSolid = async (quantity, before) => {
    const legends = await page.getByRole("complementary", { name: /Color range:/ }).count();
    await page.getByRole("button", { name: "Toggle fixture solid surface", exact: true }).click();
    await page.waitForFunction(() => window.__artifactOverlayCanvas?.().surfacePresentation.some(surface => surface.mode === "solid"));
    const solid = await read();
    assert.deepEqual(solid.canvas.surfacePresentation, [{ mode: "solid", color: "12ab34" }]);
    assert.equal(await page.getByRole("complementary", { name: /Color range:/ }).count(), legends - 1);
    assert.deepEqual(solid.canvas.geometryIds, before.canvas.geometryIds);
    assert.equal(solid.state.calls.filter(call => call.binary).length, before.state.calls.filter(call => call.binary).length);
    await page.getByRole("button", { name: "Toggle fixture solid surface", exact: true }).click();
    await page.waitForFunction(() => window.__artifactOverlayCanvas?.().surfacePresentation.some(surface => surface.mode === "field"));
    assert.equal(await page.getByRole("complementary", { name: /Color range:/ }).count(), legends);
    checks.push(`${quantity} solid honors the custom color with retained x mode, hides only its surface legend and preserves geometry/binary reads`);
  };
  const h = await ready("H_ant");
  assert.equal(h.state.unit, "A/m"); assert.equal(h.state.count, 5); assert.equal(h.state.triangles, 4); assert.deepEqual(h.state.values, [1, 0, 0, -4, 0]);
  assert.equal(h.state.minimum, -4); assert.equal(h.state.maximum, 1);
  await screenshot("01-historical-H");
  checks.push("Production facade/hooks and FMVP6/FMMT2 codecs render historical H on its separate five-node Tet4 carrier with an interior sample; live WebGL context and nonzero buffer");
  await assertSolid("H_ant", h);
  await page.getByLabel("Fixture quantity", { exact: true }).selectOption("J_charge");
  const j = await ready("J_charge");
  assert.equal(j.state.unit, "A/m^2"); assert.equal(j.state.count, 8); assert.equal(j.state.triangles, 6);
  assert.deepEqual(j.state.values, [1, 0, 0, -4, 10, 0, 0, -40]);
  assert.equal(j.state.minimum, -40); assert.equal(j.state.maximum, 10);
  assert.ok(j.state.calls.some(call => call.binary && call.carrier?.endsWith(":tet4_cell_local_nodes")));
  assert.notDeepEqual(j.canvas.geometryIds, h.canvas.geometryIds);
  await screenshot("02-cell-local-J-exterior");
  checks.push("J retains eight cell-local samples, exact stable IDs above 2^53 and different shared-vertex traces; only six exterior faces, no nodal averaging or shared internal face");
  await assertSolid("J_charge", j);
  const carrierBinaries = j.state.calls.filter(call => call.binary).length;
  let previousMaterials = j.canvas.auxiliaryMaterials;
  assert.equal(previousMaterials.length, 2);
  for (const [opacity, palette] of [[.45, "magma"], [1, "viridis"], [.45, "magma"], [1, "viridis"]]) {
    await page.getByRole("button", { name: "Toggle fixture presentation", exact: true }).click();
    await page.waitForFunction(expected => { const c = window.__artifactOverlayCanvas?.(); return c?.surfaceOpacity === expected.opacity && c.paletteName === expected.palette; }, { opacity, palette });
    const updated = await read();
    assert.deepEqual(updated.canvas.geometryIds, j.canvas.geometryIds);
    assert.deepEqual(updated.canvas.materialIds, j.canvas.materialIds);
    assert.deepEqual(updated.canvas.paletteIds, j.canvas.paletteIds);
    assert.deepEqual(updated.state.values, j.state.values);
    assert.equal(updated.state.calls.filter(call => call.binary).length, carrierBinaries);
    assert.equal(updated.canvas.lost, false);
    assert.deepEqual(updated.canvas.auxiliaryMaterials.map(m => m.id), previousMaterials.map(m => m.id));
    for (let i = 0; i < previousMaterials.length; i++) {
      assert.equal(updated.canvas.auxiliaryMaterials[i].opacity, opacity);
      assert.equal(updated.canvas.auxiliaryMaterials[i].transparent, opacity < 1);
      assert.ok(updated.canvas.auxiliaryMaterials[i].version > previousMaterials[i].version);
    }
    previousMaterials = updated.canvas.auxiliaryMaterials;
  }
  checks.push("Repeated palette and opacity changes preserve geometry/material/texture identities, recompile point/wire transparency variants, retain raw J and avoid binary reload");
  const surfaceLegend = page.getByRole("complementary", { name: /Color range:.*J/ });
  assert.equal(await surfaceLegend.count(), 1); assert.ok((await surfaceLegend.innerText()).includes("Historical surface"));
  assert.ok((await surfaceLegend.innerText()).includes("A/m"));
  await page.getByRole("button", { name: "Toggle fixture vectors", exact: true }).click();
  await page.waitForFunction(() => window.__artifactOverlayFixture?.read().glyphCount === 8 && (window.__artifactOverlayCanvas?.().glyphInstances ?? 0) >= 8);
  assert.equal((await read()).canvas.surfaceTriangles, 6);
  assert.deepEqual((await read()).canvas.glyphCounts.sort((a,b)=>a-b), [8,8]);
  assert.equal(await page.getByRole("complementary", { name: /Color range:/ }).count(), 2);
  await screenshot("02b-cell-local-J-vectors");
  checks.push("Actual vector glyphs retain all eight local J samples; separate shared colorbars identify signed surface and vector magnitude in SI units");
  const binaries = j.state.calls.filter(call => call.binary).length;
  await page.waitForTimeout(400);
  assert.equal((await read()).state.calls.filter(call => call.binary).length, binaries);
  await page.waitForTimeout(300);
  const idleFrame = (await read()).canvas.frame;
  await page.waitForTimeout(300);
  assert.equal((await read()).canvas.frame, idleFrame);
  checks.push("Settled J display performs zero idle binary reads or renderer frames");
  await page.getByLabel("Fixture quantity", { exact: true }).selectOption("H_ant");
  const restored = await ready("H_ant"); assert.deepEqual(restored.state.values, h.state.values);
  assert.deepEqual(restored.canvas.glyphCounts.sort((a,b)=>a-b), [5,5]);
  await screenshot("03-H-restored");
  checks.push("H to J to H preserves execution owner while replacing quantity-specific carrier pins; transport rejects stale pins");
  const hBinaryReads = restored.state.calls.filter(call => call.binary).length;
  for (const [budget, glyphs] of [[2, 2], [0, 0], [1200, 5]]) {
    const delayedBefore = await page.evaluate(() => window.__artifactDelayedWorkerMessages);
    if (budget === 2) await page.evaluate(() => { window.__artifactWorkerDelayMs = 1200; });
    await page.getByLabel("Fixture glyph budget", { exact: true }).fill(String(budget));
    if (budget === 2) {
      await page.waitForFunction(before => window.__artifactDelayedWorkerMessages > before, delayedBefore);
      await page.waitForFunction(() => window.__artifactOverlayFixture?.read().glyphCount === 2 && window.__artifactOverlayCanvas?.().glyphInstances === 0);
      const waiting = await read(); assert.equal(waiting.state.model, true); assert.equal(waiting.canvas.surfaceTriangles, 4);
      checks.push("Delayed real glyph worker cannot expose old five-sample transforms with the new two-sample colors; the complete surface remains visible");
      await page.evaluate(() => { window.__artifactWorkerDelayMs = 0; });
    }
    await page.waitForFunction(glyphs => window.__artifactOverlayFixture?.read().glyphCount === glyphs && (window.__artifactOverlayCanvas?.().glyphCounts.every(count => count === glyphs) ?? false), glyphs);
    const limited = await ready("H_ant");
    assert.equal(limited.state.count, 5); assert.equal(limited.state.triangles, 4); assert.equal(limited.state.pointCount, 5);
    assert.deepEqual(limited.canvas.geometryIds, restored.canvas.geometryIds); assert.deepEqual(limited.canvas.materialIds, restored.canvas.materialIds);
    assert.equal(limited.state.calls.filter(call => call.binary).length, hBinaryReads);
    assert.equal(await page.getByRole("complementary", { name: /Color range:/ }).count(), glyphs ? 2 : 1);
  }
  checks.push("Production controller glyph budgets 2/0/full preserve the complete H surface, five raw samples, scale, geometry/material identity and binary reads; zero budget hides only glyphs and their legend");
  const fullPoints = await read();
  assert.ok(fullPoints.canvas.pointBufferIds.length > 0 && fullPoints.canvas.pointBufferIds.every(id => /^\d+$/.test(id)));
  await page.getByLabel("Fixture geometry scope", { exact: true }).selectOption("surface");
  await page.waitForFunction(() => window.__artifactOverlayFixture?.read().glyphCount === 4 && window.__artifactOverlayCanvas?.().pointCounts[0] === 4);
  const surfaceScope = await ready("H_ant");
  assert.equal(surfaceScope.state.availableGlyphCount, 4); assert.equal(surfaceScope.state.pointCount, 4);
  assert.deepEqual(surfaceScope.state.values, restored.state.values); assert.deepEqual(surfaceScope.canvas.geometryIds, fullPoints.canvas.geometryIds);
  assert.deepEqual(surfaceScope.canvas.pointBufferIds, fullPoints.canvas.pointBufferIds);
  assert.equal(surfaceScope.state.calls.filter(call => call.binary).length, hBinaryReads);
  await screenshot("03a-owned-boundary-scope");
  await page.getByLabel("Fixture geometry scope", { exact: true }).selectOption("full");
  await page.waitForFunction(() => window.__artifactOverlayFixture?.read().glyphCount === 5 && window.__artifactOverlayCanvas?.().pointCounts[0] === 5);
  assert.deepEqual((await read()).canvas.pointBufferIds, fullPoints.canvas.pointBufferIds);
  checks.push("Surface scope excludes the actual interior H sample from points and glyphs; full restores it without replacing geometry, index buffers, physical values or carrier reads");
  await page.getByLabel("Fixture quantity", { exact: true }).selectOption("V_electric");
  const potential = await ready("V_electric");
  assert.equal(potential.state.unit, "V"); assert.equal(potential.state.count, 4);
  assert.deepEqual(potential.state.values, [-2, 0, 1, 4]); assert.equal(potential.state.minimum, -2); assert.equal(potential.state.maximum, 4);
  await page.waitForFunction(() => window.__artifactOverlayCanvas?.().glyphInstances === 0);
  assert.equal(potential.state.glyphCount, 0);
  assert.equal(await page.getByRole("complementary", { name: /Color range:/ }).count(), 1);
  assert.ok((await page.getByRole("complementary", { name: /Color range:/ }).innerText()).includes("V_electric"));
  assert.ok(potential.state.calls.some(call => call.binary && call.carrier?.endsWith(":source_nodes")));
  assert.equal(potential.canvas.scalarSurface.normalized[0], 0);
  assert.equal(potential.canvas.scalarSurface.normalized[3], 1);
  assert.ok(Math.abs(potential.canvas.scalarSurface.normalized[1] - 1/3) < 1e-7);
  await page.getByRole("button", { name: "Toggle fixture presentation", exact: true }).click();
  await page.waitForFunction(() => window.__artifactOverlayCanvas?.().scalarSurface?.opacity === .45);
  const translucentPotential = await read();
  assert.deepEqual(translucentPotential.canvas.geometryIds, potential.canvas.geometryIds);
  assert.equal(translucentPotential.canvas.scalarSurface.materialId, potential.canvas.scalarSurface.materialId);
  assert.notEqual(translucentPotential.canvas.scalarSurface.paletteId, potential.canvas.scalarSurface.paletteId);
  await assertSolid("V_electric", translucentPotential);
  await page.getByRole("button", { name: "Toggle fixture presentation", exact: true }).click();
  await page.waitForFunction(() => window.__artifactOverlayCanvas?.().scalarSurface?.opacity === 1);
  await screenshot("03b-signed-potential");
  checks.push("Signed source-node V uses the shared scalar surface shader, retains negative volts and source carrier, and renders no glyphs despite previous vector settings");
  await page.getByLabel("Fixture quantity", { exact: true }).selectOption("H_ant");
  const afterPotential = await ready("H_ant"); assert.deepEqual(afterPotential.state.values, h.state.values);
  await page.waitForFunction(() => window.__artifactOverlayCanvas?.().glyphInstances === 10);
  await page.getByLabel("Fixture live lane", { exact: true }).check();
  await page.waitForFunction(() => { const state = window.__artifactOverlayFixture?.read(); return state && !state.model && !state.historical; });
  await page.waitForFunction(() => window.__artifactOverlayCanvas?.().groups === 0);
  const live = await read(), liveBinaries = live.state.calls.filter(call => call.binary).length;
  await page.waitForTimeout(300);
  assert.equal((await read()).state.calls.filter(call => call.binary).length, liveBinaries);
  checks.push("Live solver capability lane is not adopted as historical inspection and produces no historical binary reads");
  await page.getByLabel("Fixture quantity", { exact: true }).selectOption("J_charge");
  await page.waitForFunction(() => { const state=window.__artifactOverlayFixture?.read(); return state?.quantity === "J_charge" && !state.model && !state.historical; });
  assert.equal((await read()).canvas.groups, 0);
  assert.equal((await read()).state.calls.filter(call => call.binary).length, liveBinaries);
  checks.push("Live J_charge also stays outside historical routing without extra binary reads");
  await page.getByLabel("Fixture quantity", { exact: true }).selectOption("V_electric");
  await page.waitForFunction(() => { const state = window.__artifactOverlayFixture?.read(); return state?.quantity === "V_electric" && !state.model && !state.historical; });
  assert.equal((await read()).canvas.groups, 0);
  assert.equal((await read()).state.calls.filter(call => call.binary).length, liveBinaries);
  checks.push("Live V_electric remains outside historical inspection without carrier reads");
  await page.getByLabel("Fixture quantity", { exact: true }).selectOption("H_ant");
  await page.getByLabel("Fixture live lane", { exact: true }).uncheck(); await ready("H_ant");
  await page.getByRole("button", { name: "Select foreign owner", exact: true }).click();
  await page.waitForFunction(() => { const state = window.__artifactOverlayFixture?.read(); return state && !state.model && Boolean(state.error); });
  await page.waitForFunction(() => window.__artifactOverlayCanvas?.().groups === 0);
  const cleared = await read();
  assert.equal(cleared.state.resources.geometries, 0); assert.equal(cleared.state.resources.materials, 0); assert.equal(cleared.state.resources.textures, 0);
  await screenshot("04-foreign-owner-cleared");
  checks.push("Foreign immutable run selection refuses nearest-result fallback, removes the old scene group and releases geometry/material/texture ownership");
  await page.getByRole("button", { name: "Clear owner selection", exact: true }).click();
  const final = await ready("H_ant"); assert.deepEqual(final.state.unexpected, []);
  const controls = page.getByRole("complementary", { name: "Shared inspection controls", exact: true });
  await controls.getByRole("button", { name: /Surface Coloring/ }).click();
  await controls.getByRole("button", { name: /^Vectors/ }).click();
  const rangeLabels = controls.locator('[aria-label^="Scalar color range:"]');
  await page.waitForFunction(() => document.querySelectorAll('aside[aria-label="Shared inspection controls"] [aria-label^="Scalar color range:"]').length === 2);
  const initialLabels = await rangeLabels.evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label")));
  const beforeLegends = await read();
  const surfaceLegendSwitch = controls.getByRole("switch", { name: "Add colorbar to viewport", exact: true });
  await surfaceLegendSwitch.uncheck();
  await page.waitForFunction(() => document.querySelectorAll('[aria-label^="Color range:"]').length === 0);
  assert.equal((await read()).state.model, true);
  await surfaceLegendSwitch.check();
  await page.waitForFunction(() => document.querySelectorAll('[aria-label^="Color range:"]').length === 2);
  assert.deepEqual((await read()).canvas.geometryIds, beforeLegends.canvas.geometryIds);
  assert.equal((await read()).state.calls.filter(call => call.binary).length, beforeLegends.state.calls.filter(call => call.binary).length);
  checks.push("Actual shared viewport-colorbar switch hides and restores both H legends through the production controller without replacing geometry or loading binaries");
  assert.ok(initialLabels.some(label => label.includes("-4") && label.includes("1")));
  assert.ok(initialLabels.some(label => label.includes("0") && label.includes("4")));
  await page.getByLabel("Fixture geometry scope", { exact: true }).selectOption("surface");
  await page.waitForFunction(() => window.__artifactOverlayFixture?.read().glyphCount === 4 && window.__artifactOverlayCanvas?.().glyphCounts.every(count => count === 4));
  const anchored = await read();
  const liftButton = controls.getByRole("button", { name: "Lift above surface", exact: true });
  await liftButton.click();
  await page.waitForFunction(before => {
    const state = window.__artifactOverlayFixture?.read(), matrices = window.__artifactOverlayCanvas?.().glyphMatrices;
    return state?.surfaceOffsetDistance > 0 && matrices?.length === before.length && matrices.every((matrix, mesh) => matrix.length === before[mesh].length && matrix.some((value, i) => i % 16 >= 12 && i % 16 <= 14 && Math.abs(value - before[mesh][i]) > 1e-5));
  }, anchored.canvas.glyphMatrices);
  const lifted = await read();
  assert.equal(await controls.getByText("Display offset; field sample positions unchanged", { exact: true }).isVisible(), true);
  assert.deepEqual(lifted.state.values, anchored.state.values); assert.deepEqual(lifted.canvas.glyphColors, anchored.canvas.glyphColors);
  assert.deepEqual(lifted.canvas.geometryIds, anchored.canvas.geometryIds); assert.deepEqual(lifted.canvas.pointBufferIds, anchored.canvas.pointBufferIds);
  for (let mesh = 0; mesh < anchored.canvas.glyphMatrices.length; mesh++) for (let i = 0; i < anchored.canvas.glyphMatrices[mesh].length; i++) if (i % 16 < 12 || i % 16 === 15) assert.ok(Math.abs(lifted.canvas.glyphMatrices[mesh][i] - anchored.canvas.glyphMatrices[mesh][i]) < 1e-6);
  assert.equal(lifted.state.calls.filter(call => call.binary).length, anchored.state.calls.filter(call => call.binary).length);
  const gap = controls.getByRole("slider", { name: "Extra surface gap", exact: true });
  await gap.focus(); await gap.press("End");
  await page.waitForFunction(distance => window.__artifactOverlayFixture?.read().surfaceOffsetDistance > distance, lifted.state.surfaceOffsetDistance);
  assert.equal(await gap.getAttribute("aria-valuenow"), "1");
  await gap.press("Home");
  await page.waitForFunction(distance => Math.abs(window.__artifactOverlayFixture?.read().surfaceOffsetDistance - distance) < 1e-12, lifted.state.surfaceOffsetDistance);
  await screenshot("07-owned-surface-lift");
  await liftButton.click();
  await page.waitForFunction(before => {
    const state = window.__artifactOverlayFixture?.read(), matrices = window.__artifactOverlayCanvas?.().glyphMatrices;
    return state?.surfaceOffsetDistance === 0 && matrices?.length === before.length && matrices.every((matrix, mesh) => matrix.length === before[mesh].length && matrix.every((value, i) => Math.abs(value - before[mesh][i]) < 1e-6));
  }, anchored.canvas.glyphMatrices);
  await page.getByLabel("Fixture geometry scope", { exact: true }).selectOption("full");
  await page.waitForFunction(() => window.__artifactOverlayFixture?.read().glyphCount === 5 && window.__artifactOverlayCanvas?.().glyphCounts.every(count => count === 5));
  checks.push("Actual shared surface-lift button and keyboard gap control translate GPU glyph anchors only; orientation, size, colors, raw samples, point/surface geometry and binary reads remain unchanged, and disabling restores original transforms");
  const rawSurface = await read();
  const projectionControl = controls.getByRole("combobox", { name: "Projection", exact: true });
  await projectionControl.selectOption("surface_faces");
  await page.waitForFunction(() => window.__artifactOverlayCanvas?.().surfaceVertexCounts.every(count => count === 12));
  const faceSurface = await read();
  await page.waitForFunction(() => {
    const ranges = [...document.querySelectorAll('aside[aria-label="Shared inspection controls"] [aria-label^="Scalar color range:"]')].map(node => node.getAttribute("aria-label"));
    return ranges.some(label => label.includes("-1.333") && label.includes("0.3333"));
  });
  const projectedInspectorLabels = await rangeLabels.evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label")));
  assert.ok(projectedInspectorLabels.some(label => label.includes("0") && label.includes("4")));

  assert.equal(faceSurface.canvas.lost, false); assert.ok(faceSurface.canvas.width > 0 && faceSurface.canvas.height > 0);
  assert.deepEqual(faceSurface.state.values, rawSurface.state.values);
  assert.deepEqual(faceSurface.canvas.pointBufferIds, rawSurface.canvas.pointBufferIds);
  assert.deepEqual(faceSurface.canvas.materialIds, rawSurface.canvas.materialIds);
  assert.deepEqual(faceSurface.canvas.glyphMatrices, rawSurface.canvas.glyphMatrices);
  assert.equal(faceSurface.state.calls.filter(call => call.binary).length, rawSurface.state.calls.filter(call => call.binary).length);
  await screenshot("08-owned-face-projection");
  await projectionControl.selectOption("raw_nodal");
  await page.waitForFunction(() => window.__artifactOverlayCanvas?.().surfaceVertexCounts.every(count => count === 5));
  await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('aside[aria-label="Shared inspection controls"] [aria-label^="Scalar color range:"]')].map(node => node.getAttribute("aria-label"))) === JSON.stringify(expected), initialLabels);
  checks.push("Historical Inspector surface scale follows the owned projection and restores raw bounds; the independent vector range remains unchanged");
  checks.push("Shared face projection expands only the owned H surface, preserves point buffers, vector transforms, raw values and materials, and restores raw nodal display without binary reads");
  await page.evaluate(() => { window.__sharedRangeOwnerRoot = document.querySelector('aside[aria-label="Shared inspection controls"]'); });
  const beforeForeignScale = await read();
  for (const mode of ["foreign", "live"]) {
    await page.evaluate(mode => window.__artifactOverlayFixture.replaceSurfaceRangeOwner(mode), mode);
    await page.waitForFunction(() => document.querySelectorAll('aside[aria-label="Shared inspection controls"] [aria-label^="Scalar color range:"]').length === 1);
    assert.equal(await page.evaluate(() => window.__sharedRangeOwnerRoot === document.querySelector('aside[aria-label="Shared inspection controls"]')), true);
    assert.equal(await controls.getByText(/9999/).count(), 0);
    await page.evaluate(() => window.__artifactOverlayFixture.replaceSurfaceRangeOwner("restore"));
    await page.waitForFunction(() => document.querySelectorAll('aside[aria-label="Shared inspection controls"] [aria-label^="Scalar color range:"]').length === 2);
  }
  assert.deepEqual(await rangeLabels.evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label"))), initialLabels);
  assert.equal((await read()).state.calls.length, beforeForeignScale.state.calls.length);
  checks.push("Foreign-owner and unpinned live ranges are rejected by the actual historical Inspector without raw fallback, remount or network reads; exact owner restores the scale");
  const ownerReads = final.state.calls.filter(call => call.component !== "full" && call.path.endsWith("/meta"));
  for (const q of ["H_ant", "J_charge", "V_electric"]) {
    const reads = ownerReads.filter(call => call.path.includes(q)); assert.ok(reads.length > 0, q);
    assert.ok(reads.every(call => call.stage === "execution-inspect" && call.carrier && call.revision), q);
  }
  checks.push("Shared surface and vector controls request H/J/V ranges with the selected runtime stage, carrier and revision; surface component and vector norm remain distinct");
  await page.evaluate(() => { window.__sharedControlsRoot = document.querySelector('aside[aria-label="Shared inspection controls"]'); });
  for (const name of ["Return foreign range owner", "Return malformed range owner"]) {
    const before = await read();
    await controls.getByRole("button", { name, exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('aside[aria-label="Shared inspection controls"] [aria-label^="Scalar color range:"]').length === 0);
    await page.waitForFunction(() => [...document.querySelectorAll('aside[aria-label="Shared inspection controls"] [role="alert"]')].filter(node => node.textContent.includes("immutable inspection")).length === 2);
    assert.equal(await page.evaluate(() => window.__sharedControlsRoot === document.querySelector('aside[aria-label="Shared inspection controls"]')), true);
    const after = await read(); assert.equal(after.state.model, true); assert.equal(after.state.calls.filter(call => call.binary).length, before.state.calls.filter(call => call.binary).length);
    assert.ok(after.state.calls.length - before.state.calls.length <= 2);
    assert.equal(after.canvas.lost, false);
    checks.push(`${name}: controlled error replaces both ranges, no cached/live fallback, Inspector remount or binary reload`);
  }
  await screenshot("05-shared-controls-rejected-metadata");
  await controls.getByRole("button", { name: "Restore valid range owner", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('aside[aria-label="Shared inspection controls"] [aria-label^="Scalar color range:"]').length === 2);
  assert.deepEqual(await rangeLabels.evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label"))), initialLabels);
  await screenshot("06-shared-controls-owned-ranges");
  const settled = await read(); await page.waitForTimeout(300);
  assert.equal((await read()).state.calls.length, settled.state.calls.length);
  assert.deepEqual((await read()).state.unexpected, []); assert.deepEqual(errors, []);
  checks.push("Valid owner restores both exact ranges and controls remain idle without repeat requests");
  const dedicatedCallStart = (await read()).state.calls.length;
  await page.getByRole("button", { name: "Mount dedicated antenna Inspector", exact: true }).click();
  const dedicated = page.getByRole("complementary", { name: "Dedicated antenna Inspector", exact: true });
  await dedicated.locator('[data-inspector-owner="object.antenna.visualization"]').waitFor();
  const quantitySource = dedicated.getByRole("combobox", { name: "Quantity Source", exact: true });
  await quantitySource.waitFor();
  await ready("H_ant");
  assert.equal(await dedicated.getByRole("combobox", { name: "Result representation", exact: true }).inputValue(), "inspection");
  const forbidden = calls => calls.filter(call => /antenna|\/mesh\/|shared-domain|membership|multilayer|\/domain\/(?!topology$)/.test(call.path) || (call.path.endsWith("/domain/topology") && !call.carrier));
  assert.deepEqual(forbidden((await read()).state.calls), []);
  checks.push("Actual dedicated AntennaVisualizationPanel mounts the shared Inspector in raw SI mode with genuine Kernel controllers and no legacy or magnetic-resource requests");
  for (const quantity of ["H_ant", "J_charge", "V_electric"]) {
    await page.waitForFunction(() => window.__artifactDedicatedFixture && !window.__artifactDedicatedFixture.read().pending);
    if (await quantitySource.inputValue() !== quantity) await quantitySource.selectOption(quantity);
    const field = await ready(quantity);
    assert.equal(field.state.unit, quantity === "V_electric" ? "V" : quantity === "J_charge" ? "A/m^2" : "A/m");
    assert.equal(field.canvas.lost, false); assert.ok(field.canvas.width > 0 && field.canvas.height > 0);
    assert.equal(await dedicated.getByRole("combobox", { name: "Result representation", exact: true }).inputValue(), "inspection");
    const geometryGroup = dedicated.getByRole("button", { name: /^Geometry Scope/ });
    if (await geometryGroup.count() && !await dedicated.getByRole("radiogroup", { name: "Geometry scope", exact: true }).isVisible()) await geometryGroup.click();
    const scope = dedicated.getByRole("radiogroup", { name: "Geometry scope", exact: true });
    if (await scope.isVisible()) {
      await scope.getByRole("radio", { name: "Surface", exact: true }).click();
      await page.waitForFunction(() => window.__artifactOverlayFixture?.read().scope === "surface");
      await scope.getByRole("radio", { name: "Full", exact: true }).click();
      await page.waitForFunction(() => window.__artifactOverlayFixture?.read().scope === "full");
    }
    if (quantity === "V_electric") assert.equal(await dedicated.getByRole("button", { name: /^Vectors/ }).count(), 0);
    else {
      const surfaceSection = dedicated.getByRole("button", { name: /^Surface Coloring/ });
      const projection = dedicated.getByRole("combobox", { name: "Projection", exact: true });
      if (!await projection.isVisible()) await surfaceSection.click();
      await projection.selectOption("raw_nodal");
    }
    assert.deepEqual(forbidden((await read()).state.calls), []);
  }
  const catalogPaths = ["/v2/sessions/current/data/fields", "/v2/sessions/current/data/quantities"];
  const catalogReads = (await read()).state.calls.filter(call => catalogPaths.includes(call.path));
  for (const path of catalogPaths) assert.ok(catalogReads.some(call => call.path === path && call.stage === "execution-inspect"), path);
  assert.ok((await read()).state.calls.slice(dedicatedCallStart).filter(call => catalogPaths.includes(call.path)).every(call => call.stage === "execution-inspect"), "Dedicated historical Inspector never requests the live catalog");
  checks.push("Overlay and dedicated Inspector load fields and quantities with exact execution stage; historical selection never falls back to an unscoped live catalog");
  checks.push("Actual dedicated shared groups select H/J/V with canonical units, raw projection and available full/surface scopes; scalar V exposes no vector controls and WebGL remains live");
  await quantitySource.selectOption("H_ant"); await ready("H_ant");
  await page.waitForFunction(() => window.__artifactDedicatedFixture && !window.__artifactDedicatedFixture.read().pending);
  const vectorToggle = dedicated.getByRole("button", { name: "Toggle vector field arrows", exact: true });
  if (await vectorToggle.getAttribute("aria-pressed") !== "true") await vectorToggle.click();
  const vectorSection = dedicated.getByRole("button", { name: /^Vectors/ });
  const arrowBudget = dedicated.getByRole("slider", { name: "Arrow budget", exact: true });
  if (!await arrowBudget.isVisible()) await vectorSection.click();
  await arrowBudget.focus(); await arrowBudget.press("End");
  const waitCounts = async (available, adopted) => page.waitForFunction(({ available, adopted }) => {
    const root = document.querySelector('aside[aria-label="Dedicated antenna Inspector"]');
    const rows = [...root.querySelectorAll('.fm-inspector-field-row')];
    const value = label => rows.find(row => row.querySelector('.fm-inspector-field-row__label')?.textContent === label)?.querySelector('.fm-inspector-field-row__value')?.textContent;
    return value("Decoded field samples") === "5" && value("Available vector anchors") === `${available} samples` && value("Adopted arrows") === String(adopted);
  }, { available, adopted });
  await waitCounts(5, 5);
  const ownedScope = dedicated.getByRole("radiogroup", { name: "Geometry scope", exact: true });
  await ownedScope.getByRole("radio", { name: "Surface", exact: true }).click(); await waitCounts(4, 4);
  await ownedScope.getByRole("radio", { name: "Full", exact: true }).click(); await waitCounts(5, 5);
  await page.waitForFunction(() => window.__artifactDedicatedFixture && !window.__artifactDedicatedFixture.read().pending);
  await page.waitForFunction(() => {
    const root = document.querySelector('aside[aria-label="Dedicated antenna Inspector"]');
    return root.textContent.includes("Historical snapshot") && !root.textContent.includes("Materializing");
  });
  const actualCounts = await read(); assert.ok(actualCounts.canvas.glyphCounts.every(count => count === 5));
  checks.push("Actual dedicated Inspector reports five decoded H samples, exact full/surface anchors 5/4 and actual GPU-adopted arrows 5/4; historical readiness never becomes live Materializing");
  const surface = dedicated.getByRole("combobox", { name: "Color source", exact: true });
  if (!await surface.isVisible()) await dedicated.getByRole("button", { name: /^Surface Coloring/ }).click();
  const opacity = dedicated.getByRole("slider", { name: "Surface opacity", exact: true });
  await opacity.waitFor();
  const draft = dedicated.getByRole("textbox", { name: "Dedicated unrelated draft", exact: true });
  await draft.fill("retained during real ACK");
  await page.evaluate(() => {
    const root = document.querySelector('[data-antenna-visualization-root]');
    const scroll = document.querySelector('[data-testid="dedicated-inspector-scroll"]');
    window.__dedicatedRoot = root;
    window.__dedicatedUnrelated = [...root.querySelectorAll('button,input,select,[role="switch"],[role="slider"]')].filter(node => node.getAttribute("aria-label") !== "Surface opacity").map(node => ({ node, disabled: node.disabled ?? false, ariaDisabled: node.getAttribute("aria-disabled"), opacity: getComputedStyle(node).opacity }));
    scroll.scrollTop = 160;
    window.__artifactDedicatedFixture.holdWrites();
  });
  const beforeWrite = await page.evaluate(() => window.__artifactDedicatedFixture.read());
  assert.equal(beforeWrite.pending, false, "Pending/ACK stability starts only after prior scope transactions settle");
  const beforeMutation = await read();
  await opacity.focus(); await opacity.press("ArrowLeft");
  await page.waitForFunction(() => window.__artifactDedicatedFixture?.read().pendingWrites === 1);
  await draft.focus();
  await page.evaluate(() => { const scroll = document.querySelector('[data-testid="dedicated-inspector-scroll"]'); scroll.scrollTop = 160; window.__dedicatedScroll = scroll.scrollTop; });
  const assertStable = async () => {
    const state = await page.evaluate(() => {
      const root = document.querySelector('[data-antenna-visualization-root]'), scroll = document.querySelector('[data-testid="dedicated-inspector-scroll"]');
      return { root: root === window.__dedicatedRoot, focused: document.activeElement?.getAttribute("aria-label"), scroll: scroll.scrollTop, expectedScroll: window.__dedicatedScroll,
        changed: window.__dedicatedUnrelated.filter(row => !row.node.isConnected || (row.node.disabled ?? false) !== row.disabled || row.node.getAttribute("aria-disabled") !== row.ariaDisabled || getComputedStyle(row.node).opacity !== row.opacity).map(row => ({ label: row.node.getAttribute("aria-label") ?? row.node.textContent, connected: row.node.isConnected, beforeDisabled: row.disabled, disabled: row.node.disabled ?? false, beforeAriaDisabled: row.ariaDisabled, ariaDisabled: row.node.getAttribute("aria-disabled"), beforeOpacity: row.opacity, opacity: getComputedStyle(row.node).opacity })),
        opacityAnimations: root.getAnimations({ subtree: true }).filter(animation => animation.effect?.getKeyframes().some(frame => Object.hasOwn(frame, "opacity"))).length };
    });
    assert.equal(state.root, true); assert.equal(state.focused, "Dedicated unrelated draft"); assert.equal(state.scroll, state.expectedScroll);
    assert.deepEqual(state.changed, []); assert.equal(state.opacityAnimations, 0); assert.equal(await draft.inputValue(), "retained during real ACK");
    const frame = await read(); assert.equal(frame.canvas.lost, false); assert.ok(frame.canvas.width > 0 && frame.canvas.height > 0);
    assert.deepEqual(frame.canvas.geometryIds, beforeMutation.canvas.geometryIds);
    assert.equal(frame.state.calls.filter(call => call.binary).length, beforeMutation.state.calls.filter(call => call.binary).length);
  };
  await assertStable();
  await page.evaluate(() => window.__artifactDedicatedFixture.releaseWrites());
  await page.waitForFunction(revision => window.__artifactDedicatedFixture?.read().revision > revision, beforeWrite.revision);
  await page.waitForFunction(() => window.__artifactDedicatedFixture && !window.__artifactDedicatedFixture.read().pending);
  await page.waitForTimeout(250);
  await assertStable();
  const afterWrite = await page.evaluate(() => window.__artifactDedicatedFixture.read());
  assert.equal(afterWrite.writes, beforeWrite.writes + 1);
  assert.ok(afterWrite.renders - beforeWrite.renders <= 30);
  assert.ok((await read()).state.calls.length - beforeMutation.state.calls.length <= 5);
  assert.deepEqual(forbidden((await read()).state.calls), []);
  await screenshot("09-full-dedicated-inspector-ack");
  checks.push("Genuine VisualizationRegistrySyncController PATCH pending/ACK preserves the dedicated Inspector root, unrelated controls, focus, scroll and draft with no opacity animation, geometry replacement or binary reload and bounded requests/renders");
  for (const mode of ["wrong-stage", "wrong-run"]) {
    const beforeWrongCatalog = await read();
    await page.evaluate(mode => window.__artifactDedicatedFixture.setCatalogMode(mode), mode);
    await page.waitForFunction(() => {
      const state = window.__artifactOverlayFixture?.read();
      return state && !state.model && Boolean(state.error);
    });
    await page.waitForFunction(() => window.__artifactOverlayCanvas?.().groups === 0);
    const rejectedLabel = page.locator("[data-artifact-field-hud] [data-quantity-id]");
    assert.equal(await rejectedLabel.getAttribute("data-field-state"), "unavailable");
    assert.equal(await rejectedLabel.textContent(), "m · unavailable");
    assert.ok(await rejectedLabel.getAttribute("title"));
    const rejectedCatalog = await read();
    assert.equal(rejectedCatalog.state.calls.filter(call => call.binary).length, beforeWrongCatalog.state.calls.filter(call => call.binary).length);
    assert.ok(rejectedCatalog.state.calls.slice(beforeWrongCatalog.state.calls.length).filter(call => catalogPaths.includes(call.path)).every(call => call.stage === "execution-inspect"));
    await page.evaluate(() => window.__artifactDedicatedFixture.setCatalogMode("valid"));
    await ready("H_ant");
    checks.push(`${mode} carrier in the scoped field catalog removes the historical model without binary fetch or live fallback; restoring the exact execution catalog recovers WebGL rendering`);
  }
  const firstExecution = await ready("H_ant");
  await page.evaluate(() => window.__artifactDedicatedFixture.enableSecondExecution());
  const executionSelect = page.getByRole("combobox", { name: "Antenna inspection execution" });
  await executionSelect.click();
  const secondOption = page.getByRole("option", { name: "inspect-second · execution-inspect-second · completed", exact: true });
  await secondOption.waitFor({ state: "visible" });
  const beforeSecondSelection = await read();
  await secondOption.click();
  await page.waitForFunction(() => window.__artifactOverlayFixture?.read().values[0] === 7);
  const secondExecution = await ready("H_ant");
  assert.deepEqual(secondExecution.state.values, firstExecution.state.values.map(value => value * 7));
  const secondCalls = secondExecution.state.calls.slice(beforeSecondSelection.state.calls.length);
  assert.ok(catalogPaths.every(path => secondCalls.some(call => call.path === path && call.stage === "execution-inspect-second")));
  assert.ok(secondCalls.some(call => call.binary));
  assert.ok(secondCalls.filter(call => call.binary).every(call => call.stage === "execution-inspect-second" && call.carrier.includes("2".repeat(64))), JSON.stringify(secondCalls.filter(call => call.binary)));
  assert.notDeepEqual(secondExecution.canvas.geometryIds, firstExecution.canvas.geometryIds);
  await screenshot("10-second-execution");
  await executionSelect.click();
  await page.getByRole("option", { name: "inspect · execution-inspect · completed", exact: true }).click();
  await page.waitForFunction(() => window.__artifactOverlayFixture?.read().values[0] === 1);
  const restoredExecution = await ready("H_ant");
  assert.deepEqual(restoredExecution.state.values, firstExecution.state.values);
  assert.ok(restoredExecution.state.calls.slice(secondExecution.state.calls.length).filter(call => call.binary).every(call => call.stage === "execution-inspect" && call.carrier.includes("b".repeat(64))));
  checks.push("Actual Inspector execution selector switches between two valid scoped catalogs and distinct carrier binaries/values, then restores the first execution without cross-owner samples; WebGL remains live");
  assert.deepEqual((await read()).state.unexpected, []); assert.deepEqual(errors, []);
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
  if (page) {
    await page.screenshot({ path: resolve(directory, "failure.png"), fullPage: true }).catch(() => {});
    await writeFile(resolve(directory, "failure-state.json"), JSON.stringify({ text: await page.locator("body").innerText().catch(() => "unavailable"), fixture: await page.evaluate(() => window.__artifactDedicatedFixture?.read()).catch(() => null) }, null, 2));
  }
}
finally {
  await browser?.close();
  await writeFile(resolve(directory, "artifact-field-overlay.json"), JSON.stringify({ schema_version: "fullmag_artifact_field_overlay_browser_v1", status: failure ? "failed" : "passed", scope: "controlled production frontend transport fixture; no solver or actual HTTP/CAS qualification", checks, screenshots, errors, failure: failure?.stack ?? null }, null, 2));
}
if (failure) throw failure;
console.log(JSON.stringify({ status: "passed", checks: checks.length, screenshots: screenshots.length, errors: errors.length }));
