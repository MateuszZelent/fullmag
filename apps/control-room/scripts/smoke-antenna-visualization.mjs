import assert from "node:assert/strict";
import { verifyAntennaGlyphCardinality } from "./lib/antenna-glyph-cardinality-browser-checks.mjs";
import { verifyAntennaClipping } from "./lib/antenna-clipping-browser-checks.mjs";
import { verifyClosedLoopVectorDisplay } from "./lib/closed-loop-vector-browser-checks.mjs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const url = process.env.CONTROL_ROOM_URL;
const storage = process.env.FULLMAG_PROJECT_STORAGE_ROOT;
const output = process.env.FULLMAG_ANTENNA_VISUALIZATION_REPORT_DIR;
if (!url || !storage || !output || !isAbsolute(storage) || !isAbsolute(output)) throw new Error("Managed fixture/storage paths are required");
const inside = (root, target) => { const suffix = relative(root, target); return Boolean(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); };
const directory = resolve(output);
if (!inside(await realpath(storage), await realpath(dirname(directory)))) throw new Error("Fixture output escaped storage");
await mkdir(directory, { recursive: true });
if (!inside(await realpath(storage), await realpath(directory))) throw new Error("Fixture output escaped storage");
let browser, failure;
const checks = [], screenshots = [], errors = [];
try {
  let playwright;
  try { playwright = await import("playwright"); } catch { playwright = await import("@playwright/test"); }
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.FULLMAG_ANTENNA_VISUALIZATION_BROWSER_CHANNEL ? { channel: process.env.FULLMAG_ANTENNA_VISUALIZATION_BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 1050, height: 1050 } });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && /Shader Error|VALIDATE_STATUS|Error compiling|Encountered two children with the same key/.test(message.text())) errors.push(message.text()); });
  const root = page.locator('[data-inspector-owner="object.antenna.visualization"]');
  const open = async (scenario, legacy = false) => {
    const target = new URL(url); target.searchParams.set("scenario", scenario); if (legacy) target.searchParams.set("legacy", "1");
    await page.goto(target.href);
    // This profile qualifies the explicitly selected basis/legacy-inspection representation.
    // The canonical raw V/J/H representation is covered by artifact-field-overlay-browser.
    await page.getByRole("combobox", { name: "Result representation", exact: true }).selectOption("basis");
    await root.waitFor({ state: "visible", timeout: 60000 });
  };
  const shot = async (name, viewportOnly = false, selector = null) => { const path = resolve(directory, `${name}.png`); if (selector) await page.locator(selector).screenshot({ path }); else if (viewportOnly) await page.locator("[data-antenna-field-viewport]").screenshot({ path }); else await page.screenshot({ path, fullPage: true }); screenshots.push(path); };
  const sharedTemplate = async (ready = false) => {
    // A stable Inspector mounts before its asynchronous publication metadata arrives.
    if (ready) await page.waitForFunction(() => document.querySelector('[data-inspector-owner="object.antenna.visualization"] button[aria-label="Toggle Points"]')?.matches(":enabled"));
    assert.equal(await root.locator('[data-slot="object-visualization-overview"]').count(), 1);
    assert.equal(await root.getByRole("radiogroup", { name: "Render mode", exact: true }).count(), 1);
    for (const enabled of await Promise.all(["Surface", "Wireframe"].map((label) => root.getByRole("button", { name: `Toggle ${label}`, exact: true }).isEnabled()))) assert.equal(enabled, false);
    for (const enabled of await Promise.all(["Points", "Vectors"].map((label) => root.getByRole("button", { name: `Toggle ${label}`, exact: true }).isEnabled()))) assert.equal(enabled, ready);
    for (const enabled of await Promise.all(["Carrier", "Color source", "Vector component"].map((label) => root.getByRole("combobox", { name: label, exact: true }).isEnabled()))) assert.equal(enabled, false);
    assert.equal(await root.getByRole("combobox", { name: "Component", exact: true }).isEnabled(), ready);
    assert.equal(await root.getByRole("textbox", { name: "Color minimum", exact: true }).isEnabled(), ready);
    assert.equal(await root.getByRole("checkbox", { name: "Show vectors", exact: true }).isEnabled(), ready);
    assert.equal(await root.getByRole("combobox", { name: "Vector occlusion", exact: true }).isEnabled(), ready);
    assert.equal(await root.getByRole("combobox", { name: "Vector width", exact: true }).isEnabled(), ready);
    assert.equal(await root.getByRole("combobox", { name: "Glyph length", exact: true }).isEnabled(), ready);
    assert.equal(await root.getByRole("radio", { name: "Vectors", exact: true }).isEnabled(), ready);
    assert.ok((await root.innerText()).includes("conductor primitive is never recolored"));
  };
  checks.push(...await verifyAntennaGlyphCardinality({ page, root, open, shot }));
  checks.push(...await verifyAntennaClipping({ page, root, open, shot }));
  await open("camera-unavailable");
  await root.getByRole("button", { name: /Camera & View/ }).click();
  for (const label of ["Fit scene", "Reset camera", "Camera parameters"]) {
    assert.equal(await root.getByRole("button", { name: label, exact: true }).isEnabled(), false);
  }
  checks.push("Missing shared viewport commands keep all antenna camera buttons disabled; no local camera fallback");
  await open("empty");
  await sharedTemplate();
  await root.getByRole("button", { name: /Camera & View/ }).click();
  const cameraBefore = await page.evaluate(() => window.__antennaVisualizationFixture.read());
  const cameraInspector = await root.elementHandle();
  await root.getByRole("button", { name: "Fit scene", exact: true }).click();
  await page.waitForFunction(before => window.__antennaVisualizationFixture.read().viewport.fitRevision === before + 1, cameraBefore.viewport.fitRevision);
  await root.getByRole("button", { name: "Camera parameters", exact: true }).click();
  await page.waitForFunction(() => window.__antennaVisualizationFixture.read().viewport.widgets.cameraDialogOpen);
  await root.getByRole("button", { name: "Reset camera", exact: true }).click();
  const cameraAfter = await page.evaluate(() => window.__antennaVisualizationFixture.read());
  assert.notDeepEqual(cameraAfter.camera.camera.position, cameraBefore.camera.camera.position);
  assert.deepEqual(cameraAfter.camera.camera.position, cameraAfter.viewport.camera.position);
  assert.equal(await cameraInspector.evaluate(element => element === document.querySelector('[data-inspector-owner="object.antenna.visualization"]')), true);
  assert.equal(cameraAfter.calls.length, cameraBefore.calls.length);
  await shot("camera-shared-commands");
  checks.push("Antenna Camera & View dispatches actual shared viewport manifest commands: fit revision, camera parameters widget and reset of the shared camera registry; stable Inspector and zero field requests. Fixture does not qualify full viewport camera binding.");
  await root.getByRole("button", { name: /Camera & View/ }).click();
  await root.getByRole("button", { name: "Source", exact: true }).click();
  await root.getByText(/No antenna field-solve stage is configured/).waitFor();
  assert.equal(await root.getByRole("combobox", { name: "Antenna quantity", exact: true }).isEnabled(), false);
  assert.equal(await page.locator('[data-inspector-owner="object.visualization"]').count(), 0);
  const tree = await page.evaluate(() => window.__antennaVisualizationFixture.read().tree);
  const node = tree.children.find((child) => child.id.endsWith(":visualization"));
  assert.equal(node.kind, "object.antenna.visualization");
  assert.equal(node.objectRole, "antenna");
  assert.deepEqual((node.children ?? []).map(({ id, kind, label, parentId, objectId }) => ({ id, kind, label, parentId, objectId })), [{
    id: `${node.id}:debug`, kind: "object.visualization.debug", label: "Debug", parentId: node.id, objectId: node.objectId,
  }]);
  checks.push("Antenna Explorer has a dedicated visualization node and observation-only Debug child with the same owner; no magnetic/mode children or fabricated results without solve");
  await shot("01-empty");
  for (const scenario of ["basis-output-ref", "basis-duplicate-output", "basis-duplicate-port"]) {
    await open(scenario);
    await page.waitForFunction(() => document.querySelector('[data-inspector-owner="object.antenna.visualization"]')?.textContent.includes("identity mismatch"));
    assert.equal(await root.getByRole("combobox", { name: "Antenna quantity", exact: true }).isEnabled(), false);
    assert.equal((await page.evaluate(() => window.__antennaVisualizationFixture.read())).calls.filter(call => call.range).length, 0);
    const rejected = await page.evaluate(() => window.__antennaFieldCanvas());
    assert.equal(rejected.sampleCount, 0); assert.equal(rejected.lost, false); assert.ok(rejected.width > 0 && rejected.height > 0);
    checks.push(`${scenario}: inconsistent or ambiguous published basis rejected before binary reads; healthy empty canvas`);
  }
  await open("ready");
  await sharedTemplate(true);
  await root.getByText("Sample 8 H/I", { exact: true }).waitFor();
  assert.ok((await root.innerText()).includes("Published snapshot"));
  await root.getByRole("button", { name: "Diagnostics", exact: true }).click();
  assert.ok((await root.innerText()).includes("current-input equivalence is not certified"));
  assert.ok((await root.innerText()).includes("A/m/A"));
  await shot("02-oersted");
  for (const [label, sample, unit] of [["Electric potential V/I", "Sample 8 V/I", "V/A"], ["Current density J/I", "Sample 8 J/I", "A/m^2/A"]]) {
    await root.getByRole("combobox", { name: "Antenna quantity" }).click();
    await page.getByRole("option", { name: `${label} [${unit}]`, exact: true }).click();
    await root.getByText(sample, { exact: true }).waitFor();
    assert.ok((await root.innerText()).includes("Conductor: antenna"));
    await shot(sample.endsWith("V/I") ? "03-potential" : "04-current-density");
  }
  const evidence = await page.evaluate(() => window.__antennaVisualizationFixture.read());
  const payloads = evidence.calls.filter((call) => call.range);
  for (const call of payloads) {
    assert.equal(call.range, call.path.endsWith("electric_potential_per_ampere") ? "bytes=0-63" : "bytes=0-191");
    assert.ok(call.scope.includes("antenna-viz-fixture"));
  }
  assert.ok(payloads.some((call) => call.path.endsWith("conductor_positions")));
  assert.ok(payloads.some((call) => call.path.endsWith("sample_positions")));
  assert.deepEqual(evidence.unexpected, []);
  const before = evidence.calls.length;
  await page.waitForTimeout(500);
  assert.equal((await page.evaluate(() => window.__antennaVisualizationFixture.read())).calls.length, before);
  checks.push("V/I, J/I, H/I use compatible scalar/vector SI carriers, bounded byte ranges, session scope and verified ETags; no idle requests");
  await root.getByRole("button", { name: "Toggle Points", exact: true }).click();
  await page.waitForFunction(() => window.__antennaFieldCanvas?.().pointCount === 10);
  assert.equal(await page.locator('[data-antenna-field-viewport] canvas').isVisible(), true);
  let canvas = await page.evaluate(() => window.__antennaFieldCanvas());
  assert.equal(canvas.lost, false); assert.ok(canvas.width > 0 && canvas.height > 0);
  await shot("06-real-current-density-points");
  await root.getByRole("button", { name: "Toggle Vectors", exact: true }).click();
  await page.waitForFunction(() => window.__antennaFieldCanvas?.().glyphCount === 10);
  await shot("07-real-current-density-vectors");
  await root.getByRole("combobox", { name: "Component", exact: true }).selectOption("z");
  await root.getByText("Rendered samples", { exact: true }).waitFor();
  await root.getByRole("combobox", { name: "Antenna quantity" }).click();
  await page.getByRole("option", { name: "Electric potential V/I [V/A]", exact: true }).click();
  await page.waitForFunction(() => window.__antennaFieldCanvas?.().pointCount === 10 && window.__antennaFieldCanvas?.().glyphCount === 0);
  assert.equal(await root.getByRole("button", { name: "Toggle Vectors", exact: true }).isEnabled(), false);
  await shot("08-real-potential-scalars");
  const fullPayloads = (await page.evaluate(() => window.__antennaVisualizationFixture.read())).calls.filter((call) => call.range === "bytes=0-239" || call.range === "bytes=0-79");
  assert.ok(fullPayloads.length >= 3);
  assert.ok(fullPayloads.every((call) => !call.path.includes("/magnetization") && !call.path.endsWith("/m")));
  await page.evaluate(() => window.__antennaVisualizationFixture.selectOther());
  await page.waitForFunction(() => window.__antennaFieldCanvas?.().sampleCount === 0);
  checks.push("Unified production layer renders all 10 immutable samples and full Cartesian glyphs; scalar V disables glyphs; owner switch removes overlay immediately; visible non-lost WebGL buffer");
  await open("ready", true);
  await root.getByText("Sample 8 H/I", { exact: true }).waitFor();
  assert.equal(await page.locator('[data-inspector-owner="object.visualization"]').count(), 0);
  checks.push("Persisted legacy object.visualization selection resolves antenna owner without mounting magnetic controls");
  await open("foreign");
  await root.getByText("source/transport mismatch", { exact: true }).first().waitFor();
  assert.equal(await root.getByRole("combobox", { name: "Antenna quantity" }).isEnabled(), false);
  assert.equal((await page.evaluate(() => window.__antennaVisualizationFixture.read())).calls.filter((call) => call.range).length, 0);
  checks.push("Foreign source publication cannot expose quantities or fetch payloads");
  await shot("05-foreign-source");
  await open("malformed");
  await root.getByRole("alert").filter({ hasText: "carriers are incompatible" }).waitFor();
  assert.equal((await page.evaluate(() => window.__antennaVisualizationFixture.read())).calls.filter((call) => call.range).length, 0);
  checks.push("Incompatible sampling layout is rejected before reading numerical data");
  for (const scenario of ["cardinality", "etag", "short", "nonfinite"]) {
    await open(scenario);
    await root.getByRole("button", { name: "Toggle Points", exact: true }).click();
    await root.getByText(/unavailable:/).waitFor();
    const rejected = await page.evaluate(() => ({ canvas: window.__antennaFieldCanvas(), calls: window.__antennaVisualizationFixture.read().calls }));
    assert.equal(rejected.canvas.sampleCount, 0);
    assert.equal(rejected.canvas.lost, false);
    if (scenario === "cardinality") assert.equal(rejected.calls.filter((call) => call.range).length, 0);
  }
  checks.push("Cardinality mismatch blocks reads; wrong strong ETag, truncated payload and non-finite values never render");
  await open("multiport");
  assert.equal(await root.getByRole("button", { name: "Toggle Points", exact: true }).isEnabled(), false);
  await root.getByRole("combobox", { name: "Port mode", exact: true }).selectOption("port-two");
  await root.getByRole("button", { name: "Toggle Points", exact: true }).click();
  await page.waitForFunction(() => window.__antennaFieldCanvas?.().sampleCount === 10);
  assert.ok((await page.evaluate(() => window.__antennaVisualizationFixture.read())).calls.some((call) => call.path.endsWith("magnetic_field_per_ampere") && call.range === "bytes=0-239" && call.port === "port-two"));
  checks.push("Multiport full-field renderer requires an explicit selected port; it never assumes bases[0]");
  await open("inspection");
  await root.getByRole("button", { name: "Toggle Points", exact: true }).waitFor();
  await root.getByRole("button", { name: "Toggle Points", exact: true }).click();
  await page.waitForFunction(() => window.__antennaFieldCanvas?.().pointCount === 10);
  await root.getByRole("button", { name: "Toggle Vectors", exact: true }).click();
  await page.waitForFunction(() => window.__antennaFieldCanvas?.().glyphCount === 10);
  assert.ok((await root.innerText()).includes("Raw recorded drive Inspection Oersted field H [A/m], inspection only"));
  assert.ok((await root.innerText()).includes("NOT VERIFIED"));
  await shot("09-inspection-raw-H");
  const rawCalls = (await page.evaluate(() => window.__antennaVisualizationFixture.read())).calls;
  assert.equal(rawCalls.filter((call) => call.range && !call.path.includes("external-lead-inspection/payloads/")).length, 0);
  assert.ok(rawCalls.some((call) => call.path.endsWith("magnetic_field")));
  const rawBefore = rawCalls.length;
  await page.waitForTimeout(500);
  assert.equal((await page.evaluate(() => window.__antennaVisualizationFixture.read())).calls.length, rawBefore);
  checks.push("Inspection raw H renders actual samples/glyphs in A/m through digest-scoped ETag-verified resources, never as reusable H/I or LLG drive; no idle requests");
  assert.equal(await root.getByRole("button", { name: "Toggle Surface", exact: true }).isEnabled(), false);
  assert.equal(await root.getByRole("button", { name: "Toggle Wireframe", exact: true }).isEnabled(), false);
  const chooseRawV = async () => {
    await root.getByRole("combobox", { name: "Antenna quantity", exact: true }).click();
    await page.getByRole("option", { name: "Electric potential V [V]", exact: true }).click();
  };
  await root.getByRole("combobox", { name: "Antenna quantity", exact: true }).click();
  assert.equal(await page.getByRole("option", { name: "Current density J [A/m^2]", exact: true }).count(), 0);
  await page.keyboard.press("Escape");
  await chooseRawV();
  await page.waitForFunction(() => window.__antennaFieldCanvas?.().quantity === "device_potential" && window.__antennaFieldCanvas?.().pointCount === 10);
  assert.equal(await root.getByRole("button", { name: "Toggle Vectors", exact: true }).isEnabled(), false);
  assert.equal(await root.getByRole("button", { name: "Toggle Surface", exact: true }).isEnabled(), true);
  assert.equal(await root.getByRole("button", { name: "Toggle Wireframe", exact: true }).isEnabled(), true);
  await root.getByRole("button", { name: "Toggle Surface", exact: true }).click();
  await page.waitForFunction(() => window.__antennaFieldCanvas?.().surfaceTriangles === 12);
  await root.getByRole("button", { name: "Toggle Wireframe", exact: true }).click();
  await page.waitForFunction(() => window.__antennaFieldCanvas?.().wireframeEdges === 18);
  canvas = await page.evaluate(() => window.__antennaFieldCanvas());
  assert.equal(canvas.normalization, "raw_authored_current");
  assert.equal(canvas.quantity, "device_potential"); assert.equal(canvas.glyphCount, 0);
  assert.equal(canvas.lost, false); assert.ok(canvas.width > 0 && canvas.height > 0);
  assert.ok(Number.isFinite(canvas.colorMinimum) && Number.isFinite(canvas.colorMaximum) && canvas.colorMinimum >= 0 && canvas.colorMaximum <= 1);
  assert.ok((await root.innerText()).includes("Raw recorded drive Electric potential V [V], inspection only"));
  const beforeVRange = await page.evaluate(() => window.__antennaVisualizationFixture.read().calls.length);
  await root.getByRole("textbox", { name: "Color minimum", exact: true }).fill("-1");
  await root.getByRole("textbox", { name: "Color maximum", exact: true }).fill("1");
  await root.getByRole("button", { name: "Apply color range", exact: true }).click();
  await page.waitForFunction(previous => {
    const state = window.__antennaFieldCanvas?.();
    return state?.rangeMinimum === -1 && state.rangeMaximum === 1 && JSON.stringify(state.pointColors) !== JSON.stringify(previous) && JSON.stringify(state.pointColors) === JSON.stringify(state.surfaceColors);
  }, canvas.pointColors);
  const manualV = await page.evaluate(() => window.__antennaFieldCanvas());
  assert.equal(manualV.surfaceUuid, canvas.surfaceUuid); assert.equal(manualV.pointsUuid, canvas.pointsUuid);
  assert.deepEqual([manualV.minimum, manualV.maximum], [canvas.minimum, canvas.maximum]);
  for (const index of [1, 2, 3]) assert.deepEqual(manualV.pointColors.slice(index * 3, index * 3 + 3), manualV.pointColors.slice(0, 3));
  for (const index of [6, 7, 8]) assert.deepEqual(manualV.pointColors.slice(index * 3, index * 3 + 3), manualV.pointColors.slice(27, 30));
  const actionGap = await root.locator(".fm-antenna-color-range__actions button").evaluateAll(buttons => buttons[1].getBoundingClientRect().left - buttons[0].getBoundingClientRect().right);
  assert.ok(actionGap >= 4, `Color action buttons touch: ${actionGap}`);
  assert.equal(await root.getByRole("combobox", { name: "Vector occlusion", exact: true }).isEnabled(), false);
  await shot("manual-color-range-device-potential");
  await root.getByRole("button", { name: "Reset color range to Auto", exact: true }).click();
  await page.waitForFunction(previous => JSON.stringify(window.__antennaFieldCanvas?.().pointColors) === JSON.stringify(previous), canvas.pointColors);
  assert.equal(await page.evaluate(() => window.__antennaVisualizationFixture.read().calls.length), beforeVRange);
  checks.push("Raw V manual SI range changes identical nodal point/surface RGB, clamps both endpoints, preserves geometry/data stats, restores Auto colors without any reads");
  await root.getByRole("radio", { name: "Shaded + Wireframe", exact: true }).click();
  await page.waitForFunction(() => window.__antennaFieldCanvas?.().pointCount === 0 && window.__antennaFieldCanvas?.().surfaceTriangles === 12 && window.__antennaFieldCanvas?.().wireframeEdges === 18);
  await shot("10-inspection-raw-V-device-Tet4");
  const vCalls = (await page.evaluate(() => window.__antennaVisualizationFixture.read())).calls;
  for (const [kind, range] of [["device_positions", "bytes=0-239"], ["device_potential", "bytes=0-79"], ["device_topology", "bytes=0-63"]]) assert.ok(vCalls.some((call) => call.path.endsWith(kind) && call.range === range));
  const vBefore = vCalls.length;
  await page.waitForTimeout(500);
  assert.equal((await page.evaluate(() => window.__antennaVisualizationFixture.read())).calls.length, vBefore);
  await page.evaluate(() => window.__antennaVisualizationFixture.selectOther());
  await page.waitForFunction(() => window.__antennaFieldCanvas?.().sampleCount === 0 && window.__antennaFieldCanvas?.().surfaceTriangles === 0 && window.__antennaFieldCanvas?.().wireframeEdges === 0);
  checks.push("Raw V [V] renders genuine retained device Tet4 exterior (12 triangles / 18 edges), accepts odd tetrahedron order, shares finite nodal colors, supports actual shared Shaded/Wireframe/Points controls, clears on owner switch and makes no idle requests; no fake J or H surface");
  for (const scenario of ["inspection-foreign", "inspection-digest"]) {
    await open(scenario);
    await root.getByText(/display metadata does not match its immutable inspection owner/).first().waitFor();
    assert.equal(await root.getByRole("combobox", { name: "Antenna quantity", exact: true }).isEnabled(), false);
    assert.equal((await page.evaluate(() => window.__antennaVisualizationFixture.read())).calls.filter((call) => call.range).length, 0);
    assert.equal((await page.evaluate(() => window.__antennaFieldCanvas())).sampleCount, 0);
  }
  checks.push("Foreign raw display owner and mismatched display digest reject metadata before any heavy payload read");
  for (const scenario of ["inspection-layout", "inspection-size", "inspection-corrupt", "inspection-etag", "inspection-short", "inspection-nonfinite", "inspection-degenerate", "inspection-index", "inspection-duplicate-cell"]) {
    await open(scenario);
    await chooseRawV();
    await root.getByRole("button", { name: "Toggle Surface", exact: true }).click();
    await root.getByText(/unavailable:/).waitFor();
    const rejected = await page.evaluate(() => ({ canvas: window.__antennaFieldCanvas(), calls: window.__antennaVisualizationFixture.read().calls }));
    assert.equal(rejected.canvas.sampleCount, 0); assert.equal(rejected.canvas.surfaceTriangles, 0); assert.equal(rejected.canvas.wireframeEdges, 0);
    assert.equal(rejected.canvas.lost, false); assert.ok(rejected.canvas.width > 0 && rejected.canvas.height > 0);
    if (scenario === "inspection-layout" || scenario === "inspection-size") assert.equal(rejected.calls.filter((call) => call.range).length, 0);
  }
  checks.push("Raw V rejects wrong authored vertex layout, oversized data, corrupt bytes despite correct ETag, wrong ETag, short payload, non-finite V, degenerate Tet4, invalid indices and duplicate cells; no false scientific surface");
  await open("inspection-extreme");
  await chooseRawV();
  await root.getByRole("button", { name: "Toggle Surface", exact: true }).click();
  await page.waitForFunction(() => window.__antennaFieldCanvas?.().surfaceTriangles === 12);
  canvas = await page.evaluate(() => window.__antennaFieldCanvas());
  assert.ok(Number.isFinite(canvas.colorMinimum) && Number.isFinite(canvas.colorMaximum) && canvas.colorMinimum >= 0 && canvas.colorMaximum <= 1);
  checks.push("Opposite-sign finite nodal V at +/-1e308 retains finite normalized colors without range subtraction overflow");
  const chooseRawJ = async () => {
    await root.getByRole("combobox", { name: "Antenna quantity", exact: true }).click();
    await page.getByRole("option", { name: "Current density J [A/m^2]", exact: true }).click();
  };
  await open("inspection-current");
  const inspectorRoot = await root.elementHandle();
  await chooseRawJ();
  await root.getByRole("button", { name: "Toggle Surface", exact: true }).click();
  await page.waitForFunction(() => window.__antennaFieldCanvas?.().currentVertices === 16 && window.__antennaFieldCanvas?.().surfaceTriangles === 12);
  await root.getByRole("button", { name: "Toggle Wireframe", exact: true }).click();
  await root.getByRole("button", { name: "Toggle Points", exact: true }).click();
  await root.getByRole("button", { name: "Toggle Vectors", exact: true }).click();
  await page.waitForFunction(() => window.__antennaFieldCanvas?.().pointCount === 4 && window.__antennaFieldCanvas?.().glyphCount === 4 && window.__antennaFieldCanvas?.().wireframeEdges === 18);
  canvas = await page.evaluate(() => window.__antennaFieldCanvas());
  assert.equal(canvas.quantity, "current_density"); assert.equal(canvas.normalization, "raw_authored_current");
  assert.equal(canvas.lost, false); assert.ok(canvas.width > 0 && canvas.height > 0);
  assert.equal(canvas.currentMaterial, "FullmagAntennaOwnedCurrentSurface"); assert.equal(canvas.paletteTextures, 1);
  assert.equal(canvas.minimum, 0); assert.ok(Number.isFinite(canvas.maximum) && canvas.maximum > 0);
  assert.ok((await root.innerText()).includes("NOT VERIFIED"));
  const resources = (state) => [state.surfaceUuid, state.wireUuid, state.pointsUuid, state.materialUuid, state.paletteUuid];
  const currentResources = resources(canvas);
  assert.ok(currentResources.every(Boolean));
  await shot("11-inspection-raw-J-owned-Tet4");
  for (const component of ["x", "y", "z", "magnitude"]) {
    await root.getByRole("combobox", { name: "Component", exact: true }).selectOption(component);
    await page.waitForFunction((expected) => window.__antennaFieldCanvas?.().currentComponent === expected, component === "magnitude" ? 0 : { x: 1, y: 2, z: 3 }[component]);
    const state = await page.evaluate(() => window.__antennaFieldCanvas());
    assert.equal(state.surfaceTriangles, 12); assert.equal(state.currentVertices, 16); assert.equal(state.glyphCount, 4);
    assert.equal(state.paletteTextures, 1); assert.equal(state.lost, false);
    assert.deepEqual(resources(state), currentResources);
    assert.ok(Number.isFinite(state.minimum) && Number.isFinite(state.maximum));
  }
  await root.getByRole("combobox", { name: "Point / vector palette", exact: true }).selectOption("coolwarm");
  await page.waitForTimeout(150);
  assert.deepEqual(resources(await page.evaluate(() => window.__antennaFieldCanvas())), currentResources);
  await shot("12-inspection-raw-J-coolwarm");
  assert.equal(await root.evaluate((element, previous) => element === previous, inspectorRoot), true);
  for (const [pass, count] of [["Surface", "surfaceTriangles"], ["Wireframe", "wireframeEdges"], ["Points", "pointCount"], ["Vectors", "glyphCount"]]) {
    await root.getByRole("button", { name: `Toggle ${pass}`, exact: true }).click();
    await page.waitForFunction((key) => window.__antennaFieldCanvas?.()[key] === 0, count);
    await root.getByRole("button", { name: `Toggle ${pass}`, exact: true }).click();
    await page.waitForFunction((key) => window.__antennaFieldCanvas?.()[key] > 0, count);
    assert.deepEqual(resources(await page.evaluate(() => window.__antennaFieldCanvas())), currentResources);
  }
  const jCalls = (await page.evaluate(() => window.__antennaVisualizationFixture.read())).calls;
  for (const [kind, range] of [["current_center_positions", "bytes=0-95"], ["current_center_density", "bytes=0-95"], ["current_trace_positions", "bytes=0-383"], ["current_trace_density", "bytes=0-383"], ["device_positions", "bytes=0-239"], ["device_topology", "bytes=0-63"]]) {
    assert.ok(jCalls.some((call) => call.path.endsWith(kind) && call.range === range));
  }
  assert.ok(jCalls.every((call) => !call.range || call.path.includes("external-lead-inspection/payloads/")));
  await page.waitForTimeout(500);
  assert.equal((await page.evaluate(() => window.__antennaVisualizationFixture.read())).calls.length, jCalls.length);
  await page.evaluate(() => window.__antennaVisualizationFixture.selectOther());
  await page.waitForFunction(() => window.__antennaFieldCanvas?.().sampleCount === 0 && window.__antennaFieldCanvas?.().paletteTextures === 0);
  checks.push("Raw owned J: 4 cell-center samples/glyphs, 16 cell-local vectors, 12 exterior faces/18 edges; shared SI range, both palettes, stable geometry/material/LUT UUIDs and Inspector, bounded scoped binary reads, no idle reads, texture cleanup and healthy visible WebGL; legacy v1 never offers J");
  await open("inspection-current-cancellation"); await chooseRawJ();
  await root.getByRole("button", { name: "Toggle Surface", exact: true }).click();
  await page.waitForFunction(() => window.__antennaFieldCanvas?.().currentVertices === 16 && window.__antennaFieldCanvas?.().surfaceTriangles === 12);
  const cancellation = await page.evaluate(() => window.__antennaFieldPixel([-5e-7 / 3, -1e-7 / 3, 1e-7 / 3]));
  // Correct |interpolated J| is near zero (purple); interpolated vertex norms are nonzero (green).
  assert.ok(cancellation[0] > 30 && cancellation[1] < 45 && cancellation[2] > 50 && cancellation[3] === 255, `Wrong GPU cancellation color: ${cancellation}`);
  const nonzero = await page.evaluate(() => window.__antennaFieldPixel([-1.15e-7, -0.9e-7, 0.1e-7]));
  assert.ok(nonzero[1] > cancellation[1] + 50, `No magnitude contrast: zero=${cancellation}, nonzero=${nonzero}`);
  await shot("13-inspection-raw-J-vector-cancellation");
  checks.push(`GPU readback proves magnitude after vector interpolation at an affine cancellation (RGBA ${cancellation}), not interpolated vertex norms; nonzero reference RGBA ${nonzero}`);
  for (const scenario of ["inspection-current-unit", "inspection-current-generation"]) {
    await open(scenario);
    await root.getByText(/display metadata does not match its immutable inspection owner/).first().waitFor();
    assert.equal(await root.getByRole("combobox", { name: "Antenna quantity", exact: true }).isEnabled(), false);
    assert.equal((await page.evaluate(() => window.__antennaVisualizationFixture.read())).calls.filter((call) => call.range).length, 0);
  }
  for (const scenario of ["inspection-current-position", "inspection-current-nonfinite"]) {
    await open(scenario); await chooseRawJ();
    await root.getByRole("button", { name: "Toggle Surface", exact: true }).click();
    await root.getByText(/unavailable:/).waitFor();
    const rejected = await page.evaluate(() => window.__antennaFieldCanvas());
    assert.equal(rejected.sampleCount, 0); assert.equal(rejected.surfaceTriangles, 0); assert.equal(rejected.paletteTextures, 0); assert.equal(rejected.lost, false);
  }
  checks.push("J rejects mixed archive generations and wrong SI before reads; correctly hashed but foreign trace coordinates or nonfinite J never produce a scientific surface");
  await open("inspection-closed");
  await page.waitForFunction(() => document.querySelector('button[aria-label="Toggle Points"]')?.matches(":enabled"));
  const closedCases = [
    ["device_potential", "Electric potential V [V]", 4, -2, 4],
    ["electric_potential_per_ampere", "Inspection potential V/Ic [V/A]", 4, -2, 1],
    ["current_density", "Current density J [A/m^2]", 1, 8e7, 1e8],
    ["current_density_per_ampere", "Inspection current J/Ic [1/m^2]", 1, -5e7, -4e7],
    ["magnetic_field", "Inspection Oersted field H [A/m]", 4, -100, 70],
    ["magnetic_field_per_ampere", "Inspection Oersted field H/Ic [1/m]", 4, -35, 50],
  ];
  for (const [quantity, label, count, minimum, maximum] of closedCases) {
    await root.getByRole("combobox", { name: "Antenna quantity", exact: true }).click();
    await page.getByRole("option", { name: label, exact: true }).click();
    const points = root.getByRole("button", { name: "Toggle Points", exact: true });
    if (await points.getAttribute("aria-pressed") !== "true") await points.click();
    if (!quantity.includes("potential")) await root.getByRole("combobox", { name: "Component", exact: true }).selectOption("x");
    await page.waitForFunction(([q, n]) => window.__antennaFieldCanvas?.().quantity === q && window.__antennaFieldCanvas?.().pointCount === n, [quantity, count]);
    await root.getByRole("button", { name: "Toggle Surface", exact: true }).click();
    await page.waitForFunction(() => window.__antennaFieldCanvas?.().surfaceTriangles === 4);
    const rendered = await page.evaluate(() => window.__antennaFieldCanvas());
    assert.equal(rendered.lost, false); assert.ok(rendered.width > 0 && rendered.height > 0);
    assert.equal(rendered.minimum, minimum); assert.equal(rendered.maximum, maximum);
    assert.equal(rendered.normalization, quantity.endsWith("_per_ampere") ? "per_ampere" : "raw_authored_current");
    assert.ok((await root.innerText()).includes("NOT VERIFIED"));
    assert.ok((await root.innerText()).includes("not a reusable basis, source FFT or LLG drive"));
  }
  assert.deepEqual((await page.evaluate(() => window.__antennaVisualizationFixture.read())).unexpected, []);
  await shot("15-closed-loop-signed-H-sampling-Tet4");
  await page.evaluate(() => window.__antennaVisualizationFixture.selectOther());
  await page.waitForFunction(() => window.__antennaFieldCanvas?.().sampleCount === 0);
  checks.push("Closed-loop controlled V/J/H raw and signed per-A use retained stable-u64 device and independent H sampling Tet4 carriers, correct ranges and units; not basis/FFT/LLG qualified; owner switch removes overlay");
  checks.push(...await verifyClosedLoopVectorDisplay({ page, root, open, shot }));
  await open("inspection-closed-foreign");
  await page.waitForTimeout(500);
  assert.equal(await root.getByRole("combobox", { name: "Antenna quantity", exact: true }).isEnabled(), false);
  assert.equal((await page.evaluate(() => window.__antennaVisualizationFixture.read())).calls.filter((call) => call.range).length, 0);
  checks.push("Closed-loop record with foreign run identity is refused before binary reads");
  await open("tensor-table");
  const matrices = page.getByRole("table", { name: /Flow-major tensor sample/ });
  await matrices.first().getByRole("cell", { name: "Q_zz", exact: true }).waitFor();
  assert.equal(await matrices.count(), 2);
  for (const label of ["Q_xx", "Q_xy", "Q_xz", "Q_yx", "Q_yy", "Q_yz", "Q_zx", "Q_zy", "Q_zz"]) assert.equal(await matrices.first().getByRole("cell", { name: label, exact: true }).count(), 1);
  for (const axis of ["X", "Y", "Z"]) { assert.equal(await matrices.first().getByRole("columnheader", { name: `Spin ${axis}`, exact: true }).count(), 1); assert.equal(await matrices.first().getByRole("rowheader", { name: `Flow ${axis}`, exact: true }).count(), 1); }
  assert.deepEqual(await matrices.nth(0).locator("tbody td").allTextContents(), ["1", "-2", "3", "-4", "5", "-6", "7", "-8", "9"]);
  assert.deepEqual(await matrices.nth(1).locator("tbody td").allTextContents(), ["-10", "11", "-12", "13", "-14", "15", "-16", "17", "-18"]);
  assert.equal((await matrices.nth(0).locator("tfoot td").innerText()).trim(), "16.8819 fixture-unit");
  assert.equal((await matrices.nth(1).locator("tfoot td").innerText()).trim(), "42.7083 fixture-unit");
  assert.ok((await matrices.nth(0).locator("caption").innerText()).includes("node 7"));
  assert.ok((await matrices.nth(1).locator("caption").innerText()).includes("node 19"));
  assert.deepEqual((await page.evaluate(() => window.__antennaVisualizationFixture.read())).unexpected, []);
  const tensorRegion = page.getByRole("region", { name: "Tensor field sample matrices" });
  await tensorRegion.scrollIntoViewIfNeeded();
  const tensorShot = resolve(directory, "14-tensor-nine-components.png");
  await tensorRegion.screenshot({ path: tensorShot }); screenshots.push(tensorShot);
  checks.push("Actual debug table renders two complete3x3flow-major matrices, all nine values, Frobenius and provider unit through canonical quantity resource; synthetic UI only");
  await page.addInitScript(() => {
    window.__dataPreviewClipboard = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { window.__dataPreviewClipboard.push(text); } } });
  });
  await open("tensor-data-preview");
  const preview = page.getByRole("dialog", { name: "Data Preview", exact: true });
  await preview.waitFor({ state: "visible" });
  const previewQuantity = preview.getByRole("combobox", { name: "Quantity", exact: true });
  const previewComponent = preview.getByRole("combobox", { name: "Component", exact: true });
  const previewReads = async () => (await page.evaluate(() => window.__antennaVisualizationFixture.read())).calls.filter(call => call.path.endsWith("/samples/vector"));
  const previewRows = async () => preview.locator("tbody tr").evaluateAll(rows => rows.map(row => row.lastElementChild.textContent.trim()));
  const waitPreview = async (shape, rows) => {
    await page.waitForFunction(([expectedShape, expectedRows]) => {
      const dialog = document.querySelector('[role="dialog"][aria-label="Data Preview"]');
      return dialog?.textContent.includes(expectedShape) && JSON.stringify([...dialog.querySelectorAll("tbody tr")].map(row => row.lastElementChild.textContent.trim())) === JSON.stringify(expectedRows);
    }, [shape, rows]);
    assert.deepEqual(await previewRows(), rows);
  };
  const copyPreview = async () => {
    const before = (await previewReads()).length;
    await preview.getByRole("button", { name: "Copy data preview log", exact: true }).click();
    const copied = await page.evaluate(() => window.__dataPreviewClipboard.at(-1));
    assert.ok(copied.includes("Component: full\n"));
    assert.equal((await previewReads()).length, before);
    return copied;
  };
  await waitPreview("2 points x 3", ["2  3  4", "-5  6  7"]);
  await previewQuantity.selectOption("spin_current_tensor");
  await waitPreview("2 points x 9", ["1  -2  3  -4  5  -6  7  -8  9", "-10  11  -12  13  -14  15  -16  17  -18"]);
  for (const label of ["Q_xx", "Q_xy", "Q_xz", "Q_yx", "Q_yy", "Q_yz", "Q_zx", "Q_zy", "Q_zz"]) assert.equal(await previewComponent.getByRole("option", { name: label, exact: true }).count(), 1);
  const tensorReads = await previewReads();
  assert.ok(tensorReads.some(call => call.decodedQuantityId === "spin_current_tensor" && call.component === "full"));
  await previewComponent.selectOption("c0");
  await waitPreview("2 points x 1", ["1", "-10"]);
  assert.equal((await previewReads()).length, tensorReads.length);
  await previewQuantity.selectOption("m");
  await waitPreview("2 points x 3", ["2  3  4", "-5  6  7"]);
  assert.equal(await previewComponent.inputValue(), "full");
  assert.ok((await copyPreview()).includes("Quantity: m\n"));
  await previewComponent.selectOption("x");
  await waitPreview("2 points x 1", ["2", "-5"]);
  await previewQuantity.selectOption("spin_current_tensor");
  await waitPreview("2 points x 9", ["1  -2  3  -4  5  -6  7  -8  9", "-10  11  -12  13  -14  15  -16  17  -18"]);
  assert.equal(await previewComponent.inputValue(), "full");
  const tensorCopy = await copyPreview();
  assert.ok(tensorCopy.includes("Quantity: spin_current_tensor\n")); assert.ok(tensorCopy.includes("Shape: 2 points x 9\n"));
  const previewFinal = await page.evaluate(() => window.__antennaVisualizationFixture.read());
  assert.deepEqual(previewFinal.unexpected, []);
  assert.ok(previewFinal.calls.every(call => call.method === "GET"));
  assert.deepEqual((await previewReads()).map(call => [call.decodedQuantityId, call.component, call.maxSamples]), [["m", "full", "17"], ["spin_current_tensor", "full", "17"], ["m", "full", "17"], ["m", "x", "17"], ["spin_current_tensor", "full", "17"]]);
  const previewShot = resolve(directory, "16-tensor-data-preview-dialog.png");
  await preview.screenshot({ path: previewShot }); screenshots.push(previewShot);
  checks.push("Actual DataPreviewDialog through production API/hooks and FMVPv5 full quantity identity: all nine tensor values/labels, local c0 with zero requests, c0->vector and x->tensor resolve full with accurate copied metadata; GET-only max17, clipboard captured in memory");
  assert.deepEqual(errors, []);
} catch (error) { failure = error.stack ?? String(error); }
finally { if (browser) await browser.close(); }
await writeFile(resolve(directory, "antenna-visualization.json"), JSON.stringify({ passed: !failure, checks, screenshots, errors, failure, qualification: "production_basis_legacy_inspection_and_data_preview_controlled_transport_not_canonical_raw_or_solver_qualification" }, null, 2));
if (failure) throw new Error(failure);
console.log(JSON.stringify({ passed: true, checks, screenshots }));
