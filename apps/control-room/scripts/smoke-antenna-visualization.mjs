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
  const root = page.locator('[data-inspector-owner="object.antenna.visualization"]');
  const open = async (scenario, legacy = false) => {
    const target = new URL(url); target.searchParams.set("scenario", scenario); if (legacy) target.searchParams.set("legacy", "1");
    await page.goto(target.href);
    await root.waitFor({ state: "visible", timeout: 60000 });
  };
  const shot = async (name) => { const path = resolve(directory, `${name}.png`); await page.screenshot({ path, fullPage: true }); screenshots.push(path); };
  await open("empty");
  await root.getByText(/No antenna field-solve stage is configured/).waitFor();
  assert.equal(await root.getByRole("combobox").count(), 0);
  assert.equal(await page.locator('[data-inspector-owner="object.visualization"]').count(), 0);
  const tree = await page.evaluate(() => window.__antennaVisualizationFixture.read().tree);
  const node = tree.children.find((child) => child.id.endsWith(":visualization"));
  assert.equal(node.kind, "object.antenna.visualization");
  assert.equal(node.objectRole, "antenna");
  assert.equal(node.children?.length ?? 0, 0);
  checks.push("Antenna Explorer has a dedicated visualization node, no magnetic/debug/mode children; no fabricated results without solve");
  await shot("01-empty");
  await open("ready");
  await root.getByText("Sample 8 H/I", { exact: true }).waitFor();
  assert.ok((await root.innerText()).includes("published snapshot"));
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
  await open("ready", true);
  await root.getByText("Sample 8 H/I", { exact: true }).waitFor();
  assert.equal(await page.locator('[data-inspector-owner="object.visualization"]').count(), 0);
  checks.push("Persisted legacy object.visualization selection resolves antenna owner without mounting magnetic controls");
  await open("foreign");
  await root.getByText("source/transport mismatch", { exact: true }).waitFor();
  assert.equal(await root.getByRole("combobox", { name: "Antenna quantity" }).count(), 0);
  assert.equal((await page.evaluate(() => window.__antennaVisualizationFixture.read())).calls.filter((call) => call.range).length, 0);
  checks.push("Foreign source publication cannot expose quantities or fetch payloads");
  await shot("05-foreign-source");
  await open("malformed");
  await root.getByRole("alert").filter({ hasText: "carriers are incompatible" }).waitFor();
  assert.equal((await page.evaluate(() => window.__antennaVisualizationFixture.read())).calls.filter((call) => call.range).length, 0);
  checks.push("Incompatible sampling layout is rejected before reading numerical data");
  assert.deepEqual(errors, []);
} catch (error) { failure = error.stack ?? String(error); }
finally { if (browser) await browser.close(); }
await writeFile(resolve(directory, "antenna-visualization.json"), JSON.stringify({ passed: !failure, checks, screenshots, errors, failure, qualification: "production_UI_controlled_transport_not_solver_or_3D_field_rendering" }, null, 2));
if (failure) throw new Error(failure);
console.log(JSON.stringify({ passed: true, checks, screenshots }));
