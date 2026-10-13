import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const url = process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:3263/antenna-port-diagnostics";
const storage = process.env.FULLMAG_PROJECT_STORAGE_ROOT;
const output = process.env.FULLMAG_ANTENNA_PORT_DIAGNOSTICS_REPORT_DIR;
if (!storage || !output || !isAbsolute(storage) || !isAbsolute(output)) throw new Error("Managed absolute storage/report paths are required");
const inside = (root, path) => { const suffix = relative(root, path); return Boolean(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); };
const reportDirectory = resolve(output), realStorage = await realpath(storage);
if (!inside(resolve(storage), reportDirectory) || !inside(realStorage, await realpath(dirname(reportDirectory)))) throw new Error("Report directory escaped managed storage");
await mkdir(reportDirectory, { recursive: true });
if (!inside(realStorage, await realpath(reportDirectory))) throw new Error("Report directory escaped real managed storage");
const checks = [], screenshots = [], pageErrors = [], consoleErrors = [];
let browser, page, failure = null;
const startedAt = new Date().toISOString();
try {
  const playwright = await import("playwright");
  const channel = process.env.FULLMAG_ANTENNA_PORT_DIAGNOSTICS_BROWSER_CHANNEL;
  if (channel && !["chrome", "msedge"].includes(channel)) throw new Error("Unsupported browser channel");
  browser = await playwright.chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) consoleErrors.push(message.text()); });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.__antennaPortDiagnosticsFixture), undefined, { timeout: 30_000 });
  const inspector = page.getByTestId("port-inspector");
  const validation = inspector.locator(".fm-inspector-field-row").filter({ has: page.locator(".fm-inspector-field-row__label", { hasText: /^Validation$/ }) }).locator(".fm-inspector-field-row__value");
  const selectCase = async (name, expected, revision) => {
    await page.evaluate((value) => window.__antennaPortDiagnosticsFixture.select(value), name);
    await page.waitForFunction((value) => document.querySelector('[data-testid="scene-revision"]')?.textContent === String(value), revision, { timeout: 30_000 });
    assert.equal(await page.getByTestId("explorer-port-status").textContent(), expected);
    const message = await validation.textContent();
    if (expected === "warning") {
      assert.ok(message && message !== "ready" && message !== "valid authoring references", `${name}: invalid references advertised valid`);
      assert.match(await page.getByTestId("explorer-port-badge").textContent(), /invalid/);
    } else {
      assert.equal(message, "valid authoring references", `${name}: legal namespace rejected: ${message}`);
      assert.match(await page.getByTestId("explorer-port-badge").textContent(), /authoring/);
    }
    checks.push({ name, status: expected, message, passed: true });
  };
  await page.waitForFunction(() => document.querySelector('[data-testid="explorer-port-status"]')?.textContent === "warning");
  await page.getByTestId("port-unrelated").fill("retained local draft");
  await page.getByTestId("port-unrelated").focus();
  await page.evaluate(() => {
    window.__portRoot = document.querySelector('[data-testid="port-inspector"] [data-slot="inspector-group"]');
  });
  const screenshot = async (name) => { const path = resolve(reportDirectory, `${name}.png`); await page.screenshot({ path, fullPage: true }); screenshots.push(path); };
  await screenshot("01-missing-transport");
  for (const [index, [name, expected]] of [
    ["boundaries", "ready"], ["missing_terminal", "warning"], ["wrong_object", "warning"],
    ["observations", "ready"], ["preparation", "ready"], ["source_precedence", "warning"],
    ["missing_drive", "warning"], ["ambiguous_transport", "warning"],
  ].entries()) await selectCase(name, expected, index + 2);
  await screenshot("02-ambiguous-transport");
  assert.equal(await page.getByTestId("port-unrelated").inputValue(), "retained local draft");
  const stable = await page.evaluate(() => ({
    root: document.querySelector('[data-testid="port-inspector"] [data-slot="inspector-group"]') === window.__portRoot,
    focus: document.activeElement === document.querySelector('[data-testid="port-unrelated"]'),
    disabled: document.querySelector('[data-testid="port-unrelated"]').disabled,
    opacityAnimations: document.querySelector('[data-testid="port-inspector"]').getAnimations({ subtree: true }).filter((animation) => (animation.playState === "running" || animation.pending) && animation.effect?.getKeyframes().some((frame) => "opacity" in frame)).length,
  }));
  assert.deepEqual(stable, { root: true, focus: true, disabled: false, opacityAnimations: 0 });
  const before = await page.evaluate(() => window.__antennaPortDiagnosticsFixture.read());
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => window.__antennaPortDiagnosticsFixture.read());
  assert.deepEqual(after, before, "Settled diagnostics poll or redraw while idle");
  assert.deepEqual(after.unexpected, []);
  assert.ok(after.calls.length <= 40 && after.renders <= 100, JSON.stringify(after));
  assert.ok(after.calls.every((call) => call.startsWith("GET ")), "Read-only diagnostics mutated authoring");
  assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []);
  checks.push({ name: "stable inspector, unrelated draft/focus, bounded read-only requests, idle", passed: true, stable, counters: after });
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  if (page) {
    try { const path = resolve(reportDirectory, "failure.png"); await page.screenshot({ path, fullPage: true }); screenshots.push(path); } catch { /* Preserve original failure. */ }
  }
} finally { if (browser) await browser.close(); }
const report = { schema: "fullmag_antenna_port_diagnostics_browser_fixture_v1", state: failure ? "failed" : "passed",
  qualification: "production_reference_diagnostics_controlled_HTTP_not_backend_runtime_or_science",
  unit_tests: "not_compiled_not_run", url, startedAt, finishedAt: new Date().toISOString(),
  checks, screenshots, pageErrors, consoleErrors, error: failure };
const reportPath = resolve(reportDirectory, "antenna-port-diagnostics.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ report: reportPath, state: report.state, checks: checks.length, error: failure }));
process.exitCode = failure ? 1 : 0;
