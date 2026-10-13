import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const url = process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:3265/antenna-source-spectrum";
const storage = process.env.FULLMAG_PROJECT_STORAGE_ROOT;
const output = process.env.FULLMAG_ANTENNA_SOURCE_SPECTRUM_REPORT_DIR;
if (!storage || !output || !isAbsolute(storage) || !isAbsolute(output)) throw new Error("Managed absolute storage/report paths are required");
const inside = (root, path) => { const suffix = relative(root, path); return Boolean(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); };
const directory = resolve(output), realStorage = await realpath(storage);
if (!inside(resolve(storage), directory) || !inside(realStorage, await realpath(dirname(directory)))) throw new Error("Report must remain inside managed storage");
await mkdir(directory, { recursive: true });
if (!inside(realStorage, await realpath(directory))) throw new Error("Report escaped storage");
const reportPath = resolve(process.env.FULLMAG_ANTENNA_SOURCE_SPECTRUM_REPORT ?? resolve(directory, "antenna-source-spectrum.json"));
if (!inside(directory, reportPath)) throw new Error("Report file escaped directory");
const checks = [], screenshots = [], evidence = [], pageErrors = [], consoleErrors = [];
let browser, page, failure = null;
const startedAt = new Date().toISOString();
try {
  let playwright;
  try { playwright = await import("playwright"); } catch { playwright = await import("@playwright/test"); }
  const channel = process.env.FULLMAG_ANTENNA_SOURCE_SPECTRUM_BROWSER_CHANNEL;
  if (channel && !["chrome", "msedge"].includes(channel)) throw new Error("Unsupported managed channel");
  browser = await playwright.chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  const readyScenarios = ["ready", "ready-vector", "ready-unitary"];
  const malformedMetadata = ["wrong-layout", "wrong-unit", "wrong-scalar", "wrong-count", "wrong-summary-count", "unsafe-grid", "wrong-sha"];
  const malformedBytes = ["truncated-payload", "nonfinite-payload", "inconsistent-power", "wrong-etag", "oversized-body", "oversized-stream"];
  const readyScenarioSet = new Set(readyScenarios);
  const malformedMetadataSet = new Set(malformedMetadata);
  const malformedBytesSet = new Set(malformedBytes);
  const binaryDiagnostics = {
    "truncated-payload": "power count 3 ≠ manifest 4",
    "nonfinite-payload": "amplitude payload contains a non-finite value",
    "inconsistent-power": "power payload disagrees with complex amplitudes at k-grid cell 0",
    "wrong-etag": "antenna payload revision does not match selected manifest",
    "oversized-body": "byte budget",
    "oversized-stream": "byte budget",
  };
  for (const scenario of [...readyScenarios, "foreign-digest", "foreign-request", "foreign-catalog", "missing-catalog", "invalid-authoring", ...malformedMetadata, ...malformedBytes]) {
    const location = new URL(url); location.searchParams.set("scenario", scenario);
    await page.goto(location.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction(() => window.__antennaSpectrumFixture?.read().calls.some((call) => call.path.endsWith("/output-catalog")) && window.__antennaSpectrumFixture.read().calls.some((call) => call.path.endsWith("/source-spectra/fft")), undefined, { timeout: 60_000 });
    if (malformedMetadataSet.has(scenario)) {
      await page.waitForFunction(() => document.querySelector("main")?.textContent.includes("Antenna spectrum"), undefined, { timeout: 60_000 });
    } else if (!readyScenarioSet.has(scenario) && !malformedBytesSet.has(scenario)) {
      await page.waitForTimeout(500);
    }
    if (readyScenarioSet.has(scenario)) await page.getByRole("grid").waitFor({ timeout: 60_000 });
    if (malformedBytesSet.has(scenario)) await page.locator('section[aria-label="Antenna source spectrum payload"]').getByRole("alert").waitFor({ timeout: 60_000 });
    const before = await page.evaluate(() => window.__antennaSpectrumFixture.read());
    const sectionCount = await page.locator('section[aria-label="Antenna source spectrum payload"]').count();
    const payloads = before.calls.filter((call) => call.path.includes("/payloads/"));
    const text = await page.locator("main").textContent();
    const gridCells = await page.getByRole("gridcell").count();
    const ready = readyScenarioSet.has(scenario), bytesFailure = malformedBytesSet.has(scenario);
    if (bytesFailure) assert.ok(text.includes(binaryDiagnostics[scenario]), `${scenario} did not report the intended rejection: ${text}`);
    if (ready) {
      const unit = scenario === "ready-unitary" ? "(A/m/A)^2" : "(A*m/A)^2";
      assert.ok(text.includes(`Peak ${scenario === "ready-vector" ? "4.800e+1" : "1.600e+1"} ${unit}`), "Peak power or normalization unit differs from controlled complex amplitudes");
      assert.ok((await page.getByRole("gridcell").first().getAttribute("aria-label"))?.includes(unit), "Scientific cell tooltip lost power SI unit");
    }
    const passed = ready ? payloads.length === 4 && sectionCount === 1 && gridCells === 4
      : bytesFailure ? payloads.length > 0 && payloads.length <= 4 && gridCells === 0 && text.includes("FFT payload")
        : payloads.length === 0 && gridCells === 0 && (malformedMetadataSet.has(scenario) ? text.includes("Antenna spectrum") : sectionCount === 0);
    checks.push({ name: `${scenario}: ${ready ? "matched metadata renders four scoped carriers" : bytesFailure ? "refuses corrupt binary grid" : "refuses binary reads and payload view"}`, passed, payloadRequests: payloads.length, sectionCount, gridCells });
    if (scenario === "oversized-body" || scenario === "oversized-stream") assert.ok(text.includes("byte budget"), "Oversized response was not rejected by transport before decoding");
    if (scenario === "oversized-stream") assert.equal(before.streamCancelled, true, "Over-budget stream was not cancelled");
    const screenshot = resolve(directory, `${scenario}.png`); await page.screenshot({ path: screenshot, fullPage: true }); screenshots.push(screenshot);
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => window.__antennaSpectrumFixture.read());
    assert.equal(after.calls.length, before.calls.length, `${scenario} polls while settled`);
    assert.deepEqual(before.unexpected, []);
    assert.ok(before.calls.length <= 15);
    assert.ok(payloads.every((call) => Boolean(call.scope)), "Binary reads must be scoped");
    if (scenario === "invalid-authoring") assert.ok(text.includes("transverse spectrum requires equilibrium_ref"), "Negative fixture did not reach authoring validation");
    evidence.push({ ...before, panelText: text });
  }
  for (const kind of ["metadata", "catalog"]) {
    const location = new URL(url); location.searchParams.set("scenario", "ready");
    await page.goto(location.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByRole("grid").waitFor({ timeout: 60_000 });
    await page.evaluate(() => { window.__spectrumRetainedRoot = document.querySelector(".fm-inspector-panel"); });
    for (const fail of [false, true]) {
      const baseline = await page.evaluate(() => window.__antennaSpectrumFixture.read());
      await page.evaluate((kind) => window.__antennaSpectrumFixture.refresh(kind), kind);
      await page.waitForFunction(() => window.__antennaSpectrumFixture.read().pending === 1, undefined, { timeout: 60_000 });
      await page.waitForTimeout(200);
      const inspect = async (phase) => {
        const current = await page.evaluate(() => window.__antennaSpectrumFixture.read());
        const sectionCount = await page.locator('section[aria-label="Antenna source spectrum payload"]').count();
        const rootStable = await page.evaluate(() => window.__spectrumRetainedRoot === document.querySelector(".fm-inspector-panel"));
        const payloadRequests = current.calls.filter((call) => call.path.includes("/payloads/")).length;
        const panelText = await page.locator("main").textContent();
        const diagnosticVisible = phase !== "refresh-error" || panelText.includes(current.snapshots[kind].error);
        const passed = sectionCount === 0 && rootStable && diagnosticVisible && payloadRequests === baseline.calls.filter((call) => call.path.includes("/payloads/")).length;
        assert.equal(current.snapshots[kind].hasData, true, "Refresh fixture did not retain last-good production data");
        checks.push({ name: `${kind} ${phase}: retained data is not a current FFT view`, passed, sectionCount, rootStable, diagnosticVisible, payloadRequests, snapshot: current.snapshots[kind] });
        evidence.push({ ...current, phase: `${kind}-${phase}`, panelText });
        const screenshot = resolve(directory, `${kind}-${phase}.png`); await page.screenshot({ path: screenshot, fullPage: true }); screenshots.push(screenshot);
      };
      await inspect(fail ? "pending-before-error" : "pending");
      await page.evaluate((fail) => window.__antennaSpectrumFixture.release(fail), fail);
      await page.waitForFunction(() => window.__antennaSpectrumFixture.read().pending === 0, undefined, { timeout: 60_000 });
      if (fail) {
        await page.waitForFunction((kind) => window.__antennaSpectrumFixture.read().snapshots[kind].status === "error" && Boolean(window.__antennaSpectrumFixture.read().snapshots[kind].error), kind, { timeout: 60_000 });
        await inspect("refresh-error");
      } else {
        await page.waitForFunction((kind) => window.__antennaSpectrumFixture.read().snapshots[kind].status === "ready", kind, { timeout: 60_000 });
        await page.waitForFunction(() => document.querySelector("main")?.textContent.includes("Runtime resultready"), undefined, { timeout: 60_000 });
        await page.getByRole("grid").waitFor({ timeout: 60_000 });
        const rootStable = await page.evaluate(() => window.__spectrumRetainedRoot === document.querySelector(".fm-inspector-panel"));
        const restored = await page.evaluate(() => window.__antennaSpectrumFixture.read());
        const confirmedPayloadReads = restored.calls.filter((call) => call.path.includes("/payloads/")).length - baseline.calls.filter((call) => call.path.includes("/payloads/")).length;
        checks.push({ name: `${kind}: confirmed refresh restores FFT`, passed: rootStable && await page.getByRole("gridcell").count() === 4 && confirmedPayloadReads >= 0 && confirmedPayloadReads <= 4, rootStable, confirmedPayloadReads });
      }
    }
    const beforeIdle = await page.evaluate(() => window.__antennaSpectrumFixture.read());
    await page.waitForTimeout(300);
    const afterIdle = await page.evaluate(() => window.__antennaSpectrumFixture.read());
    assert.equal(afterIdle.calls.length, beforeIdle.calls.length, `${kind} refresh error polls while settled`);
    assert.deepEqual(afterIdle.unexpected, []);
    assert.ok(afterIdle.calls.length <= 18);
  }
  {
    const location = new URL(url); location.searchParams.set("scenario", "ready");
    await page.goto(location.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByRole("grid").waitFor({ timeout: 60_000 });
    await page.evaluate(() => { window.__spectrumRetainedRoot = document.querySelector(".fm-inspector-panel"); });
    const baseline = await page.evaluate(() => window.__antennaSpectrumFixture.read());
    const otherCalls = (value) => value.calls.filter((call) => !call.path.endsWith("/payloads/power"));
    assert.equal(await page.evaluate(() => Boolean(window.__spectrumRetainedRoot)), true, "Inspector root is missing");
    for (const fail of [true, false]) {
      const before = await page.evaluate(() => window.__antennaSpectrumFixture.read());
      await page.evaluate(() => window.__antennaSpectrumFixture.refresh("power"));
      await page.waitForFunction(() => window.__antennaSpectrumFixture.read().pending === 1, undefined, { timeout: 60_000 });
      await page.waitForFunction(() => !document.querySelector('[role="gridcell"]'), undefined, { timeout: 60_000 });
      const pending = await page.evaluate(() => window.__antennaSpectrumFixture.read());
      assert.equal(pending.snapshots.power.hasData, true, "Power refresh must retain the last-good cache");
      assert.equal(pending.calls.length, before.calls.length + 1, "Power refresh must issue exactly one GET");
      assert.deepEqual(otherCalls(pending), otherCalls(baseline), "Power refresh reread unrelated resources");
      if (!fail) {
        assert.equal(pending.snapshots.power.status, "stale");
        assert.equal(pending.snapshots.power.error, "Fixture refresh rejected");
        await page.locator('section[aria-label="Antenna source spectrum payload"]').getByRole("alert").waitFor({ timeout: 60_000 });
        const pendingText = await page.locator("main").textContent();
        assert.ok(pendingText.includes("FFT payload unavailable: Fixture refresh rejected"));
        assert.ok(!pendingText.includes("Loading binary FFT payloads"), "Retained refresh failure was replaced by loading");
      }
      const rootStable = await page.evaluate(() => window.__spectrumRetainedRoot === document.querySelector(".fm-inspector-panel"));
      checks.push({ name: `power pending before ${fail ? "error" : "ACK"}: no current grid`, passed: rootStable && await page.getByRole("gridcell").count() === 0, rootStable });
      await page.evaluate((fail) => window.__antennaSpectrumFixture.release(fail), fail);
      await page.waitForFunction((fail) => {
        const value = window.__antennaSpectrumFixture.read();
        return value.pending === 0 && value.snapshots.power.status === (fail ? "error" : "ready");
      }, fail, { timeout: 60_000 });
      if (fail) {
        await page.locator('section[aria-label="Antenna source spectrum payload"]').getByRole("alert").waitFor({ timeout: 60_000 });
        assert.ok((await page.locator("main").textContent()).includes("FFT payload unavailable: Fixture refresh rejected"), "Retained power error lost its diagnostic");
        assert.equal(await page.getByRole("gridcell").count(), 0);
      } else {
        await page.getByRole("grid").waitFor({ timeout: 60_000 });
        assert.equal(await page.getByRole("gridcell").count(), 4);
      }
      const settled = await page.evaluate(() => window.__antennaSpectrumFixture.read());
      assert.equal(settled.calls.length, before.calls.length + 1);
      assert.deepEqual(otherCalls(settled), otherCalls(baseline));
      assert.equal(settled.snapshots.metadata.status, "ready");
      assert.equal(settled.snapshots.catalog.status, "ready");
      assert.equal(settled.snapshots.power.hasData, true);
      assert.deepEqual(settled.unexpected, []);
      const settledRootStable = await page.evaluate(() => window.__spectrumRetainedRoot === document.querySelector(".fm-inspector-panel"));
      checks.push({ name: `power ${fail ? "error diagnostic" : "ACK restores grid"}`, passed: settledRootStable, rootStable: settledRootStable });
      evidence.push({ ...settled, phase: fail ? "power-error" : "power-ACK", panelText: await page.locator("main").textContent() });
      const screenshot = resolve(directory, `power-${fail ? "error" : "ACK"}.png`); await page.screenshot({ path: screenshot, fullPage: true }); screenshots.push(screenshot);
      await page.waitForTimeout(300);
      assert.equal((await page.evaluate(() => window.__antennaSpectrumFixture.read())).calls.length, settled.calls.length, "Power refresh polls while settled");
    }
    assert.ok((await page.evaluate(() => window.__antennaSpectrumFixture.read())).calls.length <= 15);
  }
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  assert.ok(checks.every((check) => check.passed), "Unconfirmed or invalid source FFT mounted/read binary payloads");
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  if (page) { try { const path = resolve(directory, "failure.png"); await page.screenshot({ path, fullPage: true }); screenshots.push(path); } catch { /* Preserve original failure. */ } }
} finally {
  if (browser) { try { await browser.close(); } catch (error) { failure = `${failure ?? ""}; cleanup: ${String(error)}`; } }
}
const report = { schema: "fullmag_antenna_source_spectrum_browser_fixture_v1", state: failure ? "failed" : "passed", qualification: "fixture_only_not_backend_runtime_or_science", actual_backend_runtime: false, production_hooks: true, unit_tests: "not_compiled_not_run", started_at: startedAt, finished_at: new Date().toISOString(), checks, screenshots, evidence, page_errors: pageErrors, console_errors: consoleErrors, error: failure };
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ report: reportPath, state: report.state, checks: checks.length, error: failure }));
process.exitCode = failure ? 1 : 0;
