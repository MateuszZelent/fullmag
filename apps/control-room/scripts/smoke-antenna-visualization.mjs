import assert from "node:assert/strict";
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
  page.on("console", (message) => { if (message.type() === "error" && /Shader Error|VALIDATE_STATUS|Error compiling/.test(message.text())) errors.push(message.text()); });
  const root = page.locator('[data-inspector-owner="object.antenna.visualization"]');
  const open = async (scenario, legacy = false) => {
    const target = new URL(url); target.searchParams.set("scenario", scenario); if (legacy) target.searchParams.set("legacy", "1");
    await page.goto(target.href);
    await root.waitFor({ state: "visible", timeout: 60000 });
  };
  const shot = async (name) => { const path = resolve(directory, `${name}.png`); await page.screenshot({ path, fullPage: true }); screenshots.push(path); };
  const sharedTemplate = async (ready = false) => {
    // A stable Inspector mounts before its asynchronous publication metadata arrives.
    if (ready) await page.waitForFunction(() => document.querySelector('[data-inspector-owner="object.antenna.visualization"] button[aria-label="Toggle Points"]')?.matches(":enabled"));
    assert.equal(await root.locator('[data-slot="object-visualization-overview"]').count(), 1);
    assert.equal(await root.getByRole("radiogroup", { name: "Render mode", exact: true }).count(), 1);
    for (const enabled of await Promise.all(["Surface", "Wireframe"].map((label) => root.getByRole("button", { name: `Toggle ${label}`, exact: true }).isEnabled()))) assert.equal(enabled, false);
    for (const enabled of await Promise.all(["Points", "Vectors"].map((label) => root.getByRole("button", { name: `Toggle ${label}`, exact: true }).isEnabled()))) assert.equal(enabled, ready);
    for (const enabled of await Promise.all(["Carrier", "Color source", "Color range", "Vector component"].map((label) => root.getByRole("combobox", { name: label, exact: true }).isEnabled()))) assert.equal(enabled, false);
    assert.equal(await root.getByRole("combobox", { name: "Component", exact: true }).isEnabled(), ready);
    assert.equal(await root.getByRole("checkbox", { name: "Show vectors", exact: true }).isEnabled(), ready);
    assert.ok((await root.innerText()).includes("conductor primitive is never recolored"));
  };
  await open("empty");
  await sharedTemplate();
  await root.getByRole("button", { name: "Source", exact: true }).click();
  await root.getByText(/No antenna field-solve stage is configured/).waitFor();
  assert.equal(await root.getByRole("combobox", { name: "Antenna quantity", exact: true }).isEnabled(), false);
  assert.equal(await page.locator('[data-inspector-owner="object.visualization"]').count(), 0);
  const tree = await page.evaluate(() => window.__antennaVisualizationFixture.read().tree);
  const node = tree.children.find((child) => child.id.endsWith(":visualization"));
  assert.equal(node.kind, "object.antenna.visualization");
  assert.equal(node.objectRole, "antenna");
  assert.equal(node.children?.length ?? 0, 0);
  checks.push("Antenna Explorer has a dedicated visualization node, no magnetic/debug/mode children; no fabricated results without solve");
  await shot("01-empty");
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
  assert.ok((await root.innerText()).includes("Raw authored-current H [A/m], inspection only"));
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
  assert.ok((await root.innerText()).includes("Raw authored-current V [V], inspection only"));
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
  assert.deepEqual(errors, []);
} catch (error) { failure = error.stack ?? String(error); }
finally { if (browser) await browser.close(); }
await writeFile(resolve(directory, "antenna-visualization.json"), JSON.stringify({ passed: !failure, checks, screenshots, errors, failure, qualification: "production_UI_and_unified_3D_layers_controlled_transport_not_solver_qualification" }, null, 2));
if (failure) throw new Error(failure);
console.log(JSON.stringify({ passed: true, checks, screenshots }));
