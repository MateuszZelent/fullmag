import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
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
const checks = [], screenshots = [], evidence = [], pageErrors = [], consoleErrors = [], downloads = [];
let browser, page, failure = null;
const startedAt = new Date().toISOString();
async function installNativeSpectrumWriter(page, blockFirstWrite = false) {
  await page.evaluate(async block => {
    const root = await navigator.storage.getDirectory();
    const name = `fullmag-spectrum-check-${crypto.randomUUID()}.json`;
    const handle = await root.getFileHandle(name, { create: true });
    if (block) { const initial = await handle.createWritable(); await initial.write("previous complete file"); await initial.close(); }
    const state = window.__spectrumNative = { root, name, handle, writes: 0, closed: 0, aborted: 0, reject: null, activated: false, filename: null };
    window.showSaveFilePicker = async options => {
      state.activated = navigator.userActivation.isActive;
      state.filename = options.suggestedName;
      return { createWritable: async () => {
        const writer = await handle.createWritable();
        return {
          async write(chunk) { await writer.write(chunk); state.writes++; if (block && state.writes === 1) await new Promise((_resolve, reject) => { state.reject = reject; }); },
          async close() { await writer.close(); state.closed++; },
          async abort(reason) { try { await writer.abort(reason); } finally { state.aborted++; state.reject?.(reason ?? new DOMException("Aborted", "AbortError")); } },
        };
      } };
    };
  }, blockFirstWrite);
}

try {
  let playwright;
  try { playwright = await import("playwright"); } catch { playwright = await import("@playwright/test"); }
  const channel = process.env.FULLMAG_ANTENNA_SOURCE_SPECTRUM_BROWSER_CHANNEL;
  if (channel && !["chrome", "msedge"].includes(channel)) throw new Error("Unsupported managed channel");
  browser = await playwright.chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined, writable: true, configurable: true });
    window.__spectrumDigestGate = { hold: false, pending: [], completed: 0 };
    const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = (...args) => nativeDigest(...args).then(result => {
      const gate = window.__spectrumDigestGate;
      if (!gate.hold) return result;
      return new Promise(resolve => gate.pending.push(() => { gate.completed++; resolve(result); }));
    });
    window.__spectrumDecodeReads = 0;
    const readFloat64 = DataView.prototype.getFloat64;
    DataView.prototype.getFloat64 = function (...args) {
      window.__spectrumDecodeReads++;
      return Reflect.apply(readFloat64, this, args);
    };
  });
  page.on("download", download => downloads.push(download.suggestedFilename()));
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  const readyScenarios = ["ready-equilibrium-stage", "ready-equilibrium-artifact", "ready-equilibrium-legacy", "ready-nonuniform", "ready", "ready-tied-peak", "ready-vector", "ready-unitary", "ready-large"];
  const equilibriumFailures = ["stale-equilibrium-stage", "stale-equilibrium-output", "stale-equilibrium-asset", "stale-equilibrium-id", "stale-equilibrium-digest", "stale-equilibrium-legacy", "missing-equilibrium-binding", "unrequested-equilibrium", "legacy-equilibrium-metadata", "foreign-equilibrium-schema"];
  const malformedMetadata = ["oversized-grid", "wrong-layout", "wrong-unit", "wrong-scalar", "wrong-count", "wrong-summary-count", "unsafe-grid", "wrong-sha"];
  const gridFailures = new Set(["stale-nonuniform"]);
  const malformedBytes = ["wrong-nonuniform-body", "truncated-payload", "nonfinite-payload", "inconsistent-power", "wrong-etag", "oversized-body", "oversized-stream"];
  const readyScenarioSet = new Set(readyScenarios);
  const malformedMetadataSet = new Set(malformedMetadata);
  const malformedBytesSet = new Set(malformedBytes);
  const binaryDiagnostics = {
    "wrong-nonuniform-body": "nonuniform k-grid payload differs from the authored axes",
    "truncated-payload": "power count 3 ≠ manifest 4",
    "nonfinite-payload": "amplitude payload contains a non-finite value",
    "inconsistent-power": "power payload disagrees with complex amplitudes at k-grid cell 0",
    "wrong-etag": "antenna payload revision does not match selected manifest",
    "oversized-body": "byte budget",
    "oversized-stream": "byte budget",
  };
  for (const scenario of [...readyScenarios, ...equilibriumFailures, ...gridFailures, "missing-nonuniform", "stale-window", "missing-window", "foreign-digest", "foreign-request", "foreign-catalog", "missing-catalog", "invalid-authoring", ...malformedMetadata, ...malformedBytes]) {
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
    if (gridFailures.has(scenario)) await page.locator('section[aria-label="Antenna source spectrum payload"]').getByRole("alert").waitFor({ timeout: 60_000 });
    const before = await page.evaluate(() => window.__antennaSpectrumFixture.read());
    const sectionCount = await page.locator('section[aria-label="Antenna source spectrum payload"]').count();
    const payloads = before.calls.filter((call) => call.path.includes("/payloads/"));
    const text = await page.locator("main").textContent();
    const gridCells = await page.getByRole("gridcell").count();
    const ready = readyScenarioSet.has(scenario), bytesFailure = malformedBytesSet.has(scenario);
    if (equilibriumFailures.includes(scenario)) assert.ok(text.includes("configuration mismatch — recompute spectrum"), "Equilibrium identity must match before binary reads");
    if (scenario === "missing-nonuniform") assert.ok(text.includes("nonuniform_spatial_fft requires a finite nonuniform k-grid"));
    if (scenario === "stale-window" || scenario === "missing-window") assert.ok(text.includes("configuration mismatch — recompute spectrum"), "Valid request must reject historical or absent window provenance");
    if (!ready) assert.equal(await page.getByRole("button", { name: "Export full spectrum (JSON)", exact: true }).count(), 0);
    if (bytesFailure) assert.ok(text.includes(binaryDiagnostics[scenario]), `${scenario} did not report the intended rejection: ${text}`);
    if (ready) {
      const payloadBox = await page.locator('section[aria-label="Antenna source spectrum payload"]').boundingBox();
      assert.ok(payloadBox && payloadBox.y < 450, "The source chart must precede long configuration/provenance details");
      const gridBox = await page.getByRole("grid").boundingBox();
      assert.ok(gridBox && Math.abs(gridBox.x + gridBox.width / 2 - payloadBox.x - payloadBox.width / 2) < 2, "The bounded source map must remain centered in the Inspector");
      assert.equal(await page.getByRole("button", { name: /Configuration and provenance/ }).getAttribute("aria-expanded"), "false");
      const unit = scenario === "ready-unitary" ? "(A/m/A)^2" : "(A*m/A)^2";
      const transverse = scenario.startsWith("ready-equilibrium-");
      const vector = transverse || scenario === "ready-vector";
      if (transverse) {
        const componentEditor = page.getByRole("combobox", { name: "Component", exact: true });
        assert.equal(await componentEditor.inputValue(), "transverse", "Editor must preserve the authored transverse component instead of displaying x");
        assert.equal(await componentEditor.locator("option:checked").textContent(), "Transverse (equilibrium projection)");
      }
      const component = transverse ? "H transverse (x, y, z)" : scenario === "ready-vector" ? "H vector (x, y, z)" : "H_x";
      assert.equal(await page.getByRole("heading", { name: `Source FFT · |H̃|² · ${component}`, exact: true }).count(), 1);
      assert.ok(text.includes("squared field magnitude, not watts"), "The field spectrum must not be presented as electrical power");
      assert.ok(text.includes(`${scenario === "ready-unitary" ? "Unitary discrete" : "Integral SI"} normalization`), "Chart must name the verified normalization");
      assert.ok((await page.getByRole("group", { name: "Selected source spectrum sample", exact: true }).innerText()).includes(component), "Selected sample lost component identity");
      assert.ok(text.includes(transverse ? "|H\u22a5_x|² + |H\u22a5_y|² + |H\u22a5_z|²" : scenario === "ready-vector" ? "|H_x|² + |H_y|² + |H_z|²" : "|H_x|²"), "Power expression must match the manifest components");
      assert.ok(text.includes(`Peak ${scenario === "ready-tied-peak" ? "9.000e+0" : vector ? "4.800e+1" : scenario === "ready-large" ? "1.897e+7" : "1.600e+1"} ${unit}`), "Peak power or normalization unit differs from controlled complex amplitudes");
      assert.ok((await page.getByRole("gridcell").first().getAttribute("aria-label"))?.includes(unit), "Scientific cell tooltip lost power SI unit");
      assert.ok((await page.getByRole("group", { name: "Source spectrum color scale" }).innerText()).includes(unit), "Color scale lost its physical power unit");
      const actionGroup = page.getByRole("group", { name: "Source spectrum actions", exact: true });
      assert.equal(await actionGroup.getByRole("button").count(), 5);
      const exportBox = await actionGroup.getByRole("button", { name: "Export full spectrum (JSON)", exact: true }).boundingBox();
      const peakBox = await actionGroup.getByRole("button", { name: "Inspect peak", exact: true }).boundingBox();
      assert.ok(exportBox && peakBox, "Export and peak inspection must remain available in the shared toolbar");
      const grid = page.getByRole("grid");
      const gridCellCount = await grid.getByRole("gridcell").count();
      await actionGroup.getByRole("button", { name: "Zoom in", exact: true }).click();
      assert.ok((await grid.getAttribute("style"))?.includes("scale(2)"), "Zoom in must enlarge the source map");
      assert.equal(await grid.getByRole("gridcell").count(), gridCellCount, "Zoom must not add cells or expand the data payload");
      await actionGroup.getByRole("button", { name: "Zoom out", exact: true }).click();
      assert.equal(await grid.evaluate(element => element.style.transform), "", "Zoom out must return to the unscaled map");
      await actionGroup.getByRole("button", { name: "Zoom in", exact: true }).click();
      await actionGroup.getByRole("button", { name: "Reset zoom", exact: true }).click();
      assert.equal(await grid.evaluate(element => element.style.transform), "", "Reset zoom must restore the full map");
      const cutCharts = page.locator("svg.fm-antenna-spectrum__cut-chart");
      assert.equal(await cutCharts.count(), 2, "The selected k point must produce u and v cut lines");
      for (const chart of await cutCharts.all()) {
        const label = await chart.getAttribute("aria-label");
        assert.ok(label?.includes("x-axis k_") && label.includes("rad/m"), "Each cut must name its physical wave-vector axis and unit");
        assert.ok(label.includes("y-axis squared field magnitude") && label.includes("linear scale"), "Each cut must identify squared-field magnitude and its scale");
        assert.ok(await chart.locator("path.fm-antenna-spectrum__cut-line").getAttribute("d"), "Each cut must render its sampled line");
      }
      if (scenario === "ready") {
        await page.getByRole("radio", { name: "Log", exact: true }).click();
        assert.ok((await page.getByRole("group", { name: "Source spectrum color scale" }).innerText()).includes("Logarithmic squared-field scale"));
        assert.ok((await cutCharts.first().getAttribute("aria-label"))?.includes("log scale"), "Cut axes must follow the selected log scale");
        await page.getByRole("radio", { name: "Linear", exact: true }).click();
      }
      const exportReads = await page.evaluate(() => window.__spectrumDecodeReads);
      const downloadEvent = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export full spectrum (JSON)", exact: true }).click();
      const download = await downloadEvent;
      assert.equal(download.suggestedFilename(), "antenna-spectrum-fft.json");
      const exportPath = resolve(directory, `${scenario}-export.json`);
      await download.saveAs(exportPath);
      const exported = JSON.parse(await readFile(exportPath, "utf8"));
      assert.equal(exported.export_schema, "fullmag_source_spectrum_export.v1");
      const manifest = exported.manifest, data = exported.data;
      assert.equal(manifest.output_id, "fft"); assert.equal(manifest.request_id, "request");
      assert.equal(manifest.content_digest, "fft-digest"); assert.equal(manifest.solution_content_digest, "basis-digest");
      assert.equal(manifest.wave_vector_unit, "rad/m"); assert.equal(manifest.payloads.power.unit, unit);
      assert.equal(manifest.normalization, scenario === "ready-unitary" ? "unitary_discrete" : "integral_si");
      assert.equal(data.k_u_rad_per_m.length, manifest.k_u_count);
      assert.equal(data.k_v_rad_per_m.length, manifest.k_v_count);
      assert.deepEqual(data.k_u_rad_per_m, scenario === "ready-large" ? Array.from({ length: 65 }, (_, i) => i - 32) : [-1, 1]);
      assert.deepEqual(data.k_v_rad_per_m, scenario === "ready-large" ? Array.from({ length: 67 }, (_, i) => i - 33) : [-1, 1]);
      assert.equal(data.power.length, manifest.power_count);
      assert.equal(data.amplitudes_re_im.length, manifest.amplitude_count * 2);
      const count = scenario === "ready-large" ? 65 * 67 : 4;
      assert.equal(data.power.length, count, "Export must preserve every original sample, including those hidden by pooling");
      for (let i = 0; i < count; i++) {
        const amplitude = scenario === "ready-tied-peak" ? [1, 3, 3, 2][i] : i + 1;
        assert.equal(data.power[i], amplitude ** 2 * (vector ? 3 : 1));
        for (let component = 0; component < manifest.component_labels.length; component++) {
          assert.equal(data.amplitudes_re_im[2 * (component * count + i)], amplitude);
          assert.equal(data.amplitudes_re_im[2 * (component * count + i) + 1], 0);
        }
      }
      assert.equal(await page.evaluate(() => window.__spectrumDecodeReads), exportReads);
      assert.equal((await page.evaluate(() => window.__antennaSpectrumFixture.read())).calls.length, before.calls.length);
      checks.push({ name: `${scenario}: downloaded full-resolution JSON preserves all amplitudes, power, SI metadata and provenance without requests/decoding`, passed: true, exportPath });
      if (scenario === "ready") {
        await page.evaluate(() => { window.__spectrumCreateURL = URL.createObjectURL; URL.createObjectURL = () => { throw new Error("Controlled download rejection"); }; });
        await page.getByRole("button", { name: "Export full spectrum (JSON)", exact: true }).click();
        await page.getByRole("alert").filter({ hasText: "Spectrum export failed. Try again." }).waitFor();
        await page.evaluate(() => { URL.createObjectURL = window.__spectrumCreateURL; });
        assert.equal(await page.getByRole("gridcell").count(), 4);
        const retryEvent = page.waitForEvent("download");
        await page.getByRole("button", { name: "Export full spectrum (JSON)", exact: true }).click();
        const retry = await retryEvent;
        const retryPath = resolve(directory, "ready-retry-export.json");
        await retry.saveAs(retryPath);
        assert.deepEqual(JSON.parse(await readFile(retryPath, "utf8")).data, data);
        assert.equal(await page.getByRole("alert").filter({ hasText: "Spectrum export failed. Try again." }).count(), 0);
        checks.push({ name: "Download failure exposes an accessible error; retry downloads identical data and clears it", passed: true });
        const countBeforeStream = downloads.length;
        await page.evaluate(() => {
          const state = window.__spectrumWriter = { chunks: [], active: 0, maximum: 0, closed: 0, aborted: 0, activated: false, filename: null };
          window.showSaveFilePicker = async options => {
            state.activated = navigator.userActivation.isActive;
            state.filename = options.suggestedName;
            return { createWritable: async () => ({
              async write(chunk) { state.active++; state.maximum = Math.max(state.maximum, state.active); await new Promise(resolve => setTimeout(resolve, 0)); state.chunks.push(chunk); state.active--; },
              async close() { state.closed++; }, async abort() { state.aborted++; },
            }) };
          };
        });
        await page.getByRole("button", { name: "Export full spectrum (JSON)", exact: true }).click();
        await page.waitForFunction(() => window.__spectrumWriter.closed === 1);
        const stream = await page.evaluate(() => window.__spectrumWriter);
        assert.equal(stream.activated, true); assert.equal(stream.filename, "antenna-spectrum-fft.json");
        assert.equal(stream.maximum, 1); assert.equal(stream.aborted, 0);
        assert.deepEqual(JSON.parse(stream.chunks.join("")), exported); assert.equal(downloads.length, countBeforeStream);
        await page.evaluate(() => { window.showSaveFilePicker = async () => { throw new DOMException("Canceled", "AbortError"); }; });
        await page.getByRole("button", { name: "Export full spectrum (JSON)", exact: true }).click();
        await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "Export full spectrum (JSON)" && !button.disabled));
        assert.equal(await page.getByRole("alert").filter({ hasText: "Spectrum export failed. Try again." }).count(), 0);
        assert.equal(downloads.length, countBeforeStream);
        await page.evaluate(() => { window.showSaveFilePicker = async () => ({ createWritable: async () => { throw new DOMException("Controlled write rejection", "AbortError"); } }); });
        await page.getByRole("button", { name: "Export full spectrum (JSON)", exact: true }).click();
        await page.getByRole("alert").filter({ hasText: "Spectrum export failed. Try again." }).waitFor();
        assert.equal(downloads.length, countBeforeStream);
        await installNativeSpectrumWriter(page);
        await page.getByRole("button", { name: "Export full spectrum (JSON)", exact: true }).click();
        await page.waitForFunction(() => window.__spectrumNative.closed === 1);
        const native = await page.evaluate(async () => {
          const state = window.__spectrumNative;
          const text = await (await state.handle.getFile()).text();
          await state.root.removeEntry(state.name);
          return { text, activated: state.activated, filename: state.filename, writes: state.writes, aborted: state.aborted };
        });
        assert.deepEqual(JSON.parse(native.text), exported); assert.equal(native.activated, true);
        assert.equal(native.filename, "antenna-spectrum-fft.json"); assert.ok(native.writes > 1); assert.equal(native.aborted, 0);
        assert.equal(downloads.length, countBeforeStream);
        checks.push({ name: "Real browser filesystem writer commits an exact full JSON file; owned temporary file removed after read", passed: true });
        await page.evaluate(() => { window.showSaveFilePicker = undefined; });
        checks.push({ name: "Streaming sink receives exact full JSON with click activation and serialized writes; picker cancellation is quiet while write AbortError is visible", passed: true });

      }
      const decodeReads = await page.evaluate(() => window.__spectrumDecodeReads);
      const peakButton = page.getByRole("button", { name: "Inspect peak", exact: true });
      await peakButton.focus();
      await page.keyboard.press("Enter");
      const peakCell = page.getByRole("gridcell").nth(scenario === "ready-large" ? 4095 : scenario === "ready-tied-peak" ? 1 : 3);
      assert.equal(await peakCell.evaluate(cell => document.activeElement === cell), true, "Inspect peak must focus the exact maximum representative");
      assert.equal(await peakCell.getAttribute("aria-selected"), "true");
      assert.equal(await page.getByRole("grid").locator('[role="gridcell"][tabindex="0"]').count(), 1);
      const sample = await page.getByRole("group", { name: "Selected source spectrum sample" }).innerText();
      assert.ok(sample.includes(unit));
      if (scenario === "ready-tied-peak") assert.ok(sample.includes("k_u 1.000e+0 rad/m") && sample.includes("k_v -1.000e+0 rad/m") && sample.includes("9.000e+0"));
      assert.equal(await page.evaluate(() => window.__spectrumDecodeReads), decodeReads);
      assert.equal((await page.evaluate(() => window.__antennaSpectrumFixture.read())).calls.length, before.calls.length);
      checks.push({ name: `${scenario}: peak action focuses the exact maximum, preserves one grid tab stop and avoids decoding/requests`, passed: true });
    }
    if (scenario === "ready-large") {
      const grid = page.getByRole("grid");
      assert.equal(await grid.getAttribute("aria-rowcount"), "64"); assert.equal(await grid.getAttribute("aria-colcount"), "64");
      await grid.getByRole("gridcell").first().focus(); await page.keyboard.press("Control+End");
      const sample = await page.getByRole("group", { name: "Selected source spectrum sample" }).innerText();
      assert.ok(sample.includes("Bin maximum") && sample.includes("3.200e+1 rad/m") && sample.includes("3.300e+1 rad/m") && sample.includes("1.897e+7"));
      assert.ok(text.includes("max-pooled") && text.includes("sample indices, not k-distance"));
      assert.ok(text.includes("k_u range: -3.200e+1") && text.includes("k_v range: -3.300e+1"));
      const payloadScreenshot = resolve(directory, "ready-large-payload.png");
      await page.locator('section[aria-label="Antenna source spectrum payload"]').screenshot({ path: payloadScreenshot }); screenshots.push(payloadScreenshot);
      checks.push({ name: "65×67 source grid stays within 4096 DOM cells and preserves the exact global peak and SI coordinates through max pooling and keyboard inspection", passed: true });
    }
    if (scenario === "oversized-grid") assert.ok(text.includes("64 MiB interactive display budget"), "The large manifest must be refused before binary reads");
    if (scenario === "ready") {
      const decodeReads = await page.evaluate(() => window.__spectrumDecodeReads);
      assert.ok(decodeReads > 0, "The counter must observe actual float64 payload decoding");
      for (const version of [1, 2, 3]) {
        await page.getByRole("button", { name: "Rerender Inspector", exact: true }).click();
        await page.waitForFunction(version => document.querySelector('output[aria-label="Fixture render version"]')?.textContent === String(version), version);
        const reads = await page.evaluate(() => window.__spectrumDecodeReads);
        assert.equal(reads, decodeReads, "Unrelated Inspector renders must not decode the binary spectrum again");
      }
      assert.equal((await page.evaluate(() => window.__antennaSpectrumFixture.read())).calls.length, before.calls.length);
      checks.push({ name: "Three unrelated production Inspector renders reuse decoded spectrum data without binary reads or resource requests", passed: true, decodeReads });
      const grid = page.getByRole("grid");
      const cutMarkers = page.locator(".fm-antenna-spectrum__cut-selected");
      assert.equal(await cutMarkers.count(), 2, "Each cut must mark the selected k-grid sample");
      const markerPositionsBefore = await cutMarkers.evaluateAll((markers) => markers.map((marker) => [marker.getAttribute("cx"), marker.getAttribute("cy")]));
      await page.evaluate(() => { window.__spectrumKeyboardGrid = document.querySelector('[role="grid"]'); });
      const mouseCell = grid.getByRole("gridcell").nth(1);
      await mouseCell.click();
      assert.equal(await mouseCell.getAttribute("aria-selected"), "true");
      assert.equal(await mouseCell.evaluate(cell => getComputedStyle(cell).outlineWidth), "2px");
      const markerPositionsAfter = await cutMarkers.evaluateAll((markers) => markers.map((marker) => [marker.getAttribute("cx"), marker.getAttribute("cy")]));
      assert.notDeepEqual(markerPositionsAfter, markerPositionsBefore, "Moving the selected cursor must update both cut markers");
      assert.ok((await page.getByRole("group", { name: "Selected source spectrum sample" }).innerText()).includes("4.000e+0"));
      await grid.getByRole("gridcell").first().focus();
      const focusedIndex = () => page.evaluate(() => document.activeElement?.getAttribute("data-spectrum-cell-index"));
      await page.keyboard.press("ArrowRight");
      assert.equal(await focusedIndex(), "1", "ArrowRight must inspect the next column");
      await page.keyboard.press("ArrowDown");
      assert.equal(await focusedIndex(), "3", "ArrowDown must preserve the column");
      await page.keyboard.press("Control+Home");
      assert.equal(await focusedIndex(), "0", "Ctrl+Home must reach the first sample");
      await page.keyboard.press("Control+End");
      assert.equal(await focusedIndex(), "3", "Ctrl+End must reach the last sample");
      assert.equal(await grid.locator('[role="gridcell"][tabindex="0"]').count(), 1, "The grid must have one tab stop");
      assert.ok((await page.getByRole("group", { name: "Selected source spectrum sample" }).innerText()).includes("|H̃|²"));
      assert.equal(await page.evaluate(() => document.querySelector('[role="grid"]') === window.__spectrumKeyboardGrid), true);
      const afterKeyboard = await page.evaluate(() => window.__antennaSpectrumFixture.read());
      assert.equal(afterKeyboard.calls.length, before.calls.length, "Keyboard inspection must not refetch payloads");
      checks.push({ name: "Mouse and keyboard preserve grid DOM, show a selected-cell outline, use one tab stop, expose sample SI values and make no requests", passed: true });
    }
    const passed = ready ? payloads.length === 4 && sectionCount === 1 && gridCells === (scenario === "ready-large" ? 4096 : 4)
      : bytesFailure ? payloads.length > 0 && payloads.length <= 4 && gridCells === 0 && text.includes("FFT payload")
        : payloads.length === 0 && gridCells === 0 && (malformedMetadataSet.has(scenario) ? text.includes("Antenna spectrum") : gridFailures.has(scenario) ? sectionCount === 1 && text.includes("FFT configuration unavailable") : sectionCount === 0);
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
      assert.equal(await page.getByRole("button", { name: "Export full spectrum (JSON)", exact: true }).count(), 0);
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
      const downloadCount = downloads.length;
      if (fail) await installNativeSpectrumWriter(page, true);
      if (fail) {
        await page.getByRole("button", { name: "Export full spectrum (JSON)", exact: true }).click();
        await page.waitForFunction(() => window.__spectrumNative.writes === 1);
      }
      await page.evaluate(() => {
        window.__antennaSpectrumFixture.refresh("power");
      });
      await page.waitForFunction(() => window.__antennaSpectrumFixture.read().pending === 1, undefined, { timeout: 60_000 });
      await page.waitForFunction(() => !document.querySelector('[role="gridcell"]'), undefined, { timeout: 60_000 });
      assert.equal(await page.getByRole("button", { name: "Export full spectrum (JSON)", exact: true }).count(), 0);
      await page.waitForTimeout(100);
      assert.equal(downloads.length, downloadCount, "Invalidation must abort an in-flight export before any download");
      if (fail) {
        await page.waitForFunction(() => window.__spectrumNative.aborted >= 1);
        const nativeAbort = await page.evaluate(async () => {
          const state = window.__spectrumNative;
          const text = await (await state.handle.getFile()).text();
          await state.root.removeEntry(state.name); window.showSaveFilePicker = undefined;
          return { text, closed: state.closed, aborted: state.aborted };
        });
        assert.equal(nativeAbort.text, "previous complete file"); assert.equal(nativeAbort.closed, 0);
        checks.push({ name: "Resource invalidation aborts a real pending file write and preserves the previous complete file", passed: true });
      }

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
  {
    const location = new URL(url); location.searchParams.set("scenario", "ready");
    await page.goto(location.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByRole("grid").waitFor({ timeout: 60_000 });
    const baseline = await page.evaluate(() => window.__antennaSpectrumFixture.read());
    const runtimeCalls = value => value.calls.filter(call => call.path !== "/v2/sessions/current/model/scene");
    await page.evaluate(() => window.__antennaSpectrumFixture.rebindSource(true));
    await page.getByText("The selected antenna resource or its source binding changed, is missing or is ambiguous. Select the resource again in Explorer.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("gridcell").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Export full spectrum (JSON)", exact: true }).count(), 0);
    assert.equal(await page.getByText("Immutable resource ID", { exact: true }).count(), 0);
    const foreign = await page.evaluate(() => window.__antennaSpectrumFixture.read());
    assert.deepEqual(runtimeCalls(foreign), runtimeCalls(baseline), "A stale source selection must not fetch the foreign owner's runtime");
    await page.evaluate(() => window.__antennaSpectrumFixture.rebindSource(false));
    await page.getByRole("grid").waitFor({ timeout: 60_000 });
    const restored = await page.evaluate(() => window.__antennaSpectrumFixture.read());
    const rereads = restored.calls.slice(foreign.calls.length).filter(call => call.path !== "/v2/sessions/current/model/scene");
    const initialDataReads = baseline.calls.filter(call => call.path.startsWith("/v2/sessions/current/data/antenna/"));
    assert.equal(rereads.length, 6, "Restoring the owner permits one metadata/catalog read and four released payloads");
    assert.deepEqual(rereads.map(call => call.path).sort(), initialDataReads.map(call => call.path).sort());
    assert.ok(rereads.every(call => call.scope === initialDataReads[0].scope));
    await page.waitForTimeout(300);
    assert.equal((await page.evaluate(() => window.__antennaSpectrumFixture.read())).calls.length, restored.calls.length);
    checks.push({ name: "Source ownership change blocks stale Inspector fields and editors; restoring the owner revalidates six scoped resources without polling", passed: true });
  }
  {
    const location = new URL(url); location.searchParams.set("scenario", "ready");
    for (const field of ["component", "normalization", "window", "sampling", "target", "grid", "equilibrium"]) {
      location.searchParams.set("scenario", field === "equilibrium" ? "ready-equilibrium-stage" : field === "grid" ? "ready-nonuniform" : field === "window" ? "ready-large" : "ready");
      await page.goto(location.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByRole("grid").waitFor({ timeout: 60_000 });
      await page.evaluate(() => { window.__spectrumConfigurationRoot = document.querySelector(".fm-inspector-panel"); });
      const before = await page.evaluate(() => window.__antennaSpectrumFixture.read());
      const binaryReads = value => value.calls.filter(call => call.path.includes("/payloads/")).length;
      await page.evaluate(field => window.__antennaSpectrumFixture.changeRequest(field), field);
      if (field === "grid") await page.getByRole("alert").filter({ hasText: "Nonuniform k-grid differs" }).waitFor();
      else await page.locator('[data-slot="inspector-group-content"]:visible').getByText("configuration mismatch — recompute spectrum", { exact: true }).waitFor();
      assert.equal(await page.getByRole("gridcell").count(), 0);
      assert.equal(await page.getByRole("button", { name: "Export full spectrum (JSON)", exact: true }).count(), 0);
      const changed = await page.evaluate(() => window.__antennaSpectrumFixture.read());
      assert.equal(binaryReads(changed), binaryReads(before), "Changed FFT configuration must not fetch historical payloads");
      assert.equal(await page.evaluate(() => window.__spectrumConfigurationRoot === document.querySelector(".fm-inspector-panel")), true);
      if (field === "window") {
        const screenshot = resolve(directory, "changed-window-stale.png");
        await page.screenshot({ path: screenshot, fullPage: true }); screenshots.push(screenshot);
      }
      await page.evaluate(field => window.__antennaSpectrumFixture.changeRequest(field, true), field);
      await page.getByRole("grid").waitFor({ timeout: 60_000 });
      const restored = await page.evaluate(() => window.__antennaSpectrumFixture.read());
      assert.ok(binaryReads(restored) - binaryReads(changed) <= 4, "Restoring exact FFT configuration permits only four released payloads");
      await page.waitForTimeout(150);
      assert.equal((await page.evaluate(() => window.__antennaSpectrumFixture.read())).calls.length, restored.calls.length);
      checks.push({ name: `${field}: changed FFT configuration hides historical samples/export with no binary reads; exact restoration recovers the chart without polling`, passed: true });
    }
  }
  {
    const location = new URL(url); location.searchParams.set("scenario", "ready-nonuniform");
    await page.goto(location.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByRole("grid").waitFor();
    const reads = () => page.evaluate(() => window.__antennaSpectrumFixture.read().calls.filter(call => call.path.includes("/payloads/")).length);
    const baseline = await reads();
    await page.evaluate(() => {
      window.__spectrumDigestGate.hold = true;
      window.__antennaSpectrumFixture.changeRequest("grid");
    });
    await page.waitForFunction(() => window.__spectrumDigestGate.pending.length === 2);
    await page.evaluate(() => window.__antennaSpectrumFixture.changeRequest("grid", true));
    await page.waitForFunction(() => window.__spectrumDigestGate.pending.length === 4);
    assert.equal(await page.getByRole("gridcell").count(), 0);
    assert.equal(await reads(), baseline);
    // New valid axes finish first; the older mismatch must never replace them.
    await page.evaluate(() => window.__spectrumDigestGate.pending.splice(2, 2).forEach(release => release()));
    await page.getByRole("grid").waitFor();
    const restoredReads = await reads();
    await page.evaluate(() => window.__spectrumDigestGate.pending.splice(0).forEach(release => release()));
    await page.waitForTimeout(200);
    assert.equal(await page.getByRole("gridcell").count(), 4);
    assert.equal(await page.getByRole("alert").filter({ hasText: "Nonuniform k-grid differs" }).count(), 0);
    assert.equal(await reads(), restoredReads);
    assert.ok(restoredReads - baseline <= 4);
    checks.push({ name: "Out-of-order SHA completion cannot replace the restored nonuniform chart or trigger extra binary reads", passed: true });
  }
  {
    const location = new URL(url); location.searchParams.set("scenario", "ready-complex-vector");
    await page.goto(location.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const table = page.getByRole("table", { name: "Complex source amplitudes at selected sample", exact: true });
    await table.waitFor();
    const cells = page.getByRole("gridcell");
    const rows = () => table.locator("tbody tr").evaluateAll(rows => rows.map(row => [...row.querySelectorAll("th, td")].map(cell => cell.textContent)));
    const before = await page.evaluate(() => ({ reads: window.__spectrumDecodeReads, calls: window.__antennaSpectrumFixture.read().calls.length }));
    assert.equal(await table.getByRole("columnheader", { name: "Amplitude [A*m/A]", exact: true }).count(), 1);
    assert.equal(await table.getByRole("columnheader", { name: "Phase [rad]", exact: true }).count(), 1);
    await cells.first().focus();
    assert.deepEqual(await rows(), [
      ["H_x", "0.000e+0", "0.000e+0", "0.000e+0", "undefined (zero amplitude)"],
      ["H_y", "1.000e+0", "0.000e+0", "1.000e+0", "0.0000"],
      ["H_z", "-1.000e+0", "0.000e+0", "1.000e+0", "3.1416"],
    ]);
    await page.keyboard.press("ArrowRight");
    assert.deepEqual(await rows(), [
      ["H_x", "0.000e+0", "2.000e+0", "2.000e+0", "1.5708"],
      ["H_y", "0.000e+0", "-2.000e+0", "2.000e+0", "-1.5708"],
      ["H_z", "2.000e+0", "0.000e+0", "2.000e+0", "0.0000"],
    ]);
    await page.keyboard.press("ArrowDown");
    assert.deepEqual(await rows(), [
      ["H_x", "3.000e+0", "4.000e+0", "5.000e+0", "0.9273"],
      ["H_y", "-4.000e+0", "3.000e+0", "5.000e+0", "2.4981"],
      ["H_z", "-3.000e+0", "-4.000e+0", "5.000e+0", "-2.2143"],
    ]);
    assert.equal(await cells.nth(3).getAttribute("aria-selected"), "true");
    assert.deepEqual(await page.evaluate(() => ({ reads: window.__spectrumDecodeReads, calls: window.__antennaSpectrumFixture.read().calls.length })), before);
    const screenshot = resolve(directory, "complex-amplitudes-phase.png");
    await table.screenshot({ path: screenshot }); screenshots.push(screenshot);
    await page.setViewportSize({ width: 480, height: 1000 });
    const narrowShot = resolve(directory, "complex-amplitudes-narrow.png");
    await page.screenshot({ path: narrowShot, fullPage: true }); screenshots.push(narrowShot);
    const bounds = await table.evaluate(table => { const owner = table.parentElement; return { scrollable: owner.scrollWidth > owner.clientWidth, contained: owner.getBoundingClientRect().right <= window.innerWidth }; });
    assert.equal(bounds.contained, true);
    assert.deepEqual(await page.evaluate(() => window.__antennaSpectrumFixture.read().unexpected), []);
    await page.setViewportSize({ width: 1280, height: 1000 });
    checks.push({ name: "Complex vector sample: component-major Re/Im, amplitudes, signed phase and undefined zero phase; keyboard selection needs no transport or decoding; narrow table stays contained", passed: true });
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
