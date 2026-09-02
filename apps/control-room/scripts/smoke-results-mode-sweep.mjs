import assert from "node:assert/strict";

const workspaceUrl = process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const apiBase = (
  process.env.CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL ??
  "http://localhost:8081"
).replace(/\/$/, "");
const timeoutMs = Number(process.env.CONTROL_ROOM_RESULTS_MODE_SWEEP_TIMEOUT_MS ?? 30_000);
const fixtureMode = process.env.CONTROL_ROOM_RESULTS_MODE_SWEEP_FIXTURE === "1";
const runId = "results-mode-sweep-fixture-run";

async function main() {
  const playwright = await loadPlaywright();
  if (!playwright?.chromium) {
    throw new Error("Results mode sweep smoke requires Playwright or @playwright/test.");
  }
  if (!fixtureMode) {
    throw new Error(
      "Results mode sweep smoke requires CONTROL_ROOM_RESULTS_MODE_SWEEP_FIXTURE=1; live/WebGL proof is NOT VERIFIED.",
    );
  }

  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { height: 1000, width: 1440 } });
  const errors = [];
  await page.addInitScript(({ baseUrl }) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      allowMissingSessionSmoke: true,
      controlRoomApiBase: baseUrl,
      disableRealtime: true,
    };
  }, { baseUrl: apiBase });
  await installResultsFixtureRoutes(page);
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));

  try {
    await page.goto(workspaceUrl, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
    await page.locator("main").waitFor({ state: "visible", timeout: timeoutMs });
    await openResults(page);
    const manifestProof = await verifyTypedDatasetManifest(page);
    const selectionProof = await verifyResultSelectionLifecycle(page);
    const legacyProof = await verifyLegacyAnalysisItems(page);
    const responsiveProof = await verifyThemesAndZoom(page);
    assert.equal(errors.length, 0, `Browser errors: ${errors.join(" | ")}`);

    console.log(`Results mode sweep proof: ${JSON.stringify({
      fixture: fixtureMode,
      manifest: manifestProof,
      selection: selectionProof,
      legacyItems: legacyProof,
      responsive: responsiveProof,
      webgl: {
        status: "NOT VERIFIED",
        checks: ["isContextLost", "drawingBufferWidth", "drawingBufferHeight"],
        reason: "fixture route has no real runtime/WebGL infrastructure",
      },
    })}`);
    console.log("Results mode sweep smoke passed in fixture mode.");
  } finally {
    await browser.close();
  }
}

async function openResults(page) {
  const tab = page.locator(".fm-ribbon__tab").filter({ hasText: /^Results$/ });
  await tab.click();
  await page.waitForFunction(
    () => document.querySelector(".fm-ribbon__tab[aria-selected='true']")?.textContent?.trim() === "Results",
    { timeout: timeoutMs },
  );
  await page.locator(".fm-results-navigator").waitFor({ state: "visible", timeout: timeoutMs });
}

async function verifyTypedDatasetManifest(page) {
  const root = page.locator(".fm-results-navigator");
  const browser = root.locator("section[aria-label='Result datasets']");
  await browser.waitFor({ state: "visible", timeout: timeoutMs });
  const datasetRows = browser.locator("nav[aria-label='Result datasets'] button[data-result-row='true']");
  const timeDomainDataset = page.getByRole("button", { name: /Time-domain spectrum fixture/ });
  await timeDomainDataset.waitFor({ state: "visible", timeout: timeoutMs });
  assert.equal(await datasetRows.count(), 2, "Fixture must expose two typed datasets.");
  const status = await timeDomainDataset.getAttribute("data-status");
  assert.equal(status, "partial", "Legacy fixture dataset must remain partial.");
  await browser.locator("header .fm-results-dataset-browser__eyebrow").waitFor({ state: "visible" });
  const browserText = await browser.innerText();
  assert.match(browserText, /legacy/i, "Legacy qualification is not visible in Results.");
  assert.match(browserText, /partial/i, "Partial status is not visible in Results.");
  assert.match(
    browserText,
    /time_domain_spectrum|dynamic_structure_factor|partial/i,
    "typed dataset manifest or partial status is not visible.",
  );
  return {
    datasetCount: await datasetRows.count(),
    manifestVisible: true,
    status,
  };
}

async function verifyResultSelectionLifecycle(page) {
  const firstItem = page.getByRole("button", { name: /legacy:gamma:peak:0/ }).first();
  await firstItem.waitFor({ state: "visible", timeout: timeoutMs });
  await firstItem.focus();
  await firstItem.press("Enter");
  await page.waitForFunction(
    () => document.querySelector("section[aria-label='Result items'] button[aria-current='true']") !== null,
    { timeout: timeoutMs },
  );
  const oldItemId = "legacy:gamma:peak:0";
  const selectedBeforeSample = await selectedResultItemId(page);
  assert.equal(selectedBeforeSample, oldItemId, "Keyboard activation did not select the peak item.");

  await page.getByRole("button", { name: /sample:1/ }).first().click();
  await page.waitForFunction(
    () => document.querySelector("section[aria-label='Result items'] button")?.textContent?.includes("legacy:gamma:peak:1"),
    { timeout: timeoutMs },
  );
  await assertNoStaleResultContext(page, oldItemId);

  await page.getByRole("button", { name: /Dynamic structure factor fixture/ }).click();
  await page.waitForFunction(
    () => document.querySelector(".fm-results-dataset-browser__eyebrow")?.textContent === "dynamic_structure_factor",
    { timeout: timeoutMs },
  );
  await assertNoStaleResultContext(page, oldItemId);
  const dsfItem = page.getByRole("button", { name: /legacy:dsf:0:0/ }).first();
  await dsfItem.waitFor({ state: "visible", timeout: timeoutMs });
  await dsfItem.focus();
  await dsfItem.press("Space");
  await page.waitForFunction(
    () => document.querySelector("section[aria-label='Result items'] button[aria-current='true']")?.textContent?.includes("legacy:dsf:0:0"),
    { timeout: timeoutMs },
  );
  const selectedAfterDataset = await selectedResultItemId(page);
  assert.equal(selectedAfterDataset, "legacy:dsf:0:0", "Keyboard activation did not select the DSF item.");
  return {
    datasetSwitchClearsOldSelection: true,
    keyboardActivation: true,
    sampleSwitchClearsOldSelection: true,
    selectedDsfItem: selectedAfterDataset,
  };
}

async function selectedResultItemId(page) {
  const selected = page.locator("section[aria-label='Result items'] button[aria-current='true']");
  return (await selected.count()) > 0
    ? (await selected.first().innerText()).match(/legacy:[^\s]+/)?.[0] ?? null
    : null;
}

async function assertNoStaleResultContext(page, oldItemId) {
  const stale = await page.locator("[aria-current='true']").evaluateAll((elements, itemId) =>
    elements.some((element) => element.textContent?.includes(itemId)), oldItemId);
  assert.equal(stale, false, `Stale selection remained for ${oldItemId}.`);
  const staleOverlay = await page.locator(
    ".fm-analysis-overlay-context-notice, [data-active-analysis-field='true']",
  ).evaluateAll((elements, itemId) =>
    elements.some((element) => element.textContent?.includes(itemId)), oldItemId);
  assert.equal(staleOverlay, false, `Stale overlay remained for ${oldItemId}.`);
}

async function verifyLegacyAnalysisItems(page) {
  await page.getByRole("button", { name: /Time-domain spectrum fixture/ }).click();
  await page.getByRole("button", { name: "Open in Analysis" }).click();
  await page.locator("[data-slot-id='viewport-main'][data-active-module-id='analysis-plots']").waitFor({ state: "attached", timeout: timeoutMs });
  await page.locator(".fm-analysis-plots").waitFor({ state: "visible", timeout: timeoutMs });
  await chooseAnalysisSubview(page, "Temporal FFT");
  const peak = page.locator("[data-result-item-id='legacy:gamma:peak:0']");
  await peak.waitFor({ state: "visible", timeout: timeoutMs });
  assert.equal(await peak.getAttribute("data-result-item-id"), "legacy:gamma:peak:0");
  await peak.focus();
  await peak.press("Enter");
  await page.waitForFunction(
    () => document.querySelector(".fm-analysis-plots__subchart--result-projection")?.textContent?.includes("legacy:gamma:peak:0"),
    { timeout: timeoutMs },
  );

  await page.locator(".fm-ribbon__tab").filter({ hasText: /^Results$/ }).click();
  await page.locator(".fm-results-navigator").waitFor({ state: "visible", timeout: timeoutMs });
  await page.getByRole("button", { name: /Dynamic structure factor fixture/ }).click();
  await page.getByRole("button", { name: "Open in Analysis" }).click();
  await page.locator(".fm-analysis-plots").waitFor({ state: "visible", timeout: timeoutMs });
  await chooseAnalysisSubview(page, "S(k,f)");
  const cell = page.locator("[data-result-item-id='legacy:dsf:0:0']");
  await cell.waitFor({ state: "visible", timeout: timeoutMs });
  assert.equal(await cell.getAttribute("data-result-item-id"), "legacy:dsf:0:0");
  await cell.focus();
  await cell.press("Space");
  await page.waitForFunction(
    () => document.querySelector(".fm-analysis-plots__subchart--result-projection")?.textContent?.includes("legacy:dsf:0:0"),
    { timeout: timeoutMs },
  );
  return { dsf: "legacy:dsf:0:0", peak: "legacy:gamma:peak:0", keyboardActivation: true };
}

async function chooseAnalysisSubview(page, label) {
  const trigger = page.getByRole("combobox", { name: "Dynamics subview" });
  await trigger.click();
  await page.getByRole("option", { name: label, exact: true }).click();
}

async function verifyThemesAndZoom(page) {
  await page.locator(".fm-ribbon__tab").filter({ hasText: /^Results$/ }).click();
  await page.locator(".fm-results-navigator").waitFor({ state: "visible", timeout: timeoutMs });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ height: 1000, width: 1280 });
  const themes = {};
  for (const [name, value] of [["Mocha", "dark"], ["Latte", "light"]]) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, value);
    themes[name] = await page.evaluate((theme) => ({
      applied: document.documentElement.dataset.theme === theme,
      rootFitsViewport: document.documentElement.scrollWidth <= window.innerWidth + 1,
      token: getComputedStyle(document.documentElement).getPropertyValue("--fm-bg-app").trim(),
    }), value);
    assert.equal(themes[name].applied, true, `${name} theme was not applied.`);
    assert.ok(themes[name].token, `${name} theme did not expose a design token.`);
  }
  await page.evaluate(() => { document.body.style.zoom = "200%"; });
  const zoom = await page.evaluate(() => ({
    documentFitsZoomedViewport: document.documentElement.scrollWidth <= window.innerWidth * 2 + 1,
    rootFitsZoomedViewport: (document.querySelector(".fm-results-navigator")?.getBoundingClientRect().right ?? Infinity) <= window.innerWidth * 2 + 1,
  }));
  assert.equal(zoom.documentFitsZoomedViewport, true, "Results UI overflows beyond the 200% zoom viewport.");
  assert.equal(zoom.rootFitsZoomedViewport, true, "Results root is clipped at 200% zoom.");
  const reducedMotion = await page.locator(".fm-results-navigator").evaluate((root) => {
    const styles = [root, ...root.querySelectorAll("*")].map((element) => getComputedStyle(element));
    const durationsInMs = styles.flatMap((style) => [style.animationDuration, style.transitionDuration])
      .flatMap((value) => value.split(",").map((duration) => {
        const trimmed = duration.trim();
        if (trimmed.endsWith("ms")) return Number.parseFloat(trimmed);
        if (trimmed.endsWith("s")) return Number.parseFloat(trimmed) * 1_000;
        return 0;
      }))
      .filter(Number.isFinite);
    return {
      mediaMatches: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      maxDurationMs: Math.max(0, ...durationsInMs),
    };
  });
  assert.equal(reducedMotion.mediaMatches, true, "Reduced-motion media emulation was not applied.");
  assert.ok(reducedMotion.maxDurationMs <= 1, "Results controls retain a non-reduced animation or transition.");
  await page.evaluate(() => { document.body.style.zoom = ""; });
  return { themes, zoom200: zoom, reducedMotion };
}

async function installResultsFixtureRoutes(page) {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "x-api-contract-version",
    "x-api-contract-version": "1.0.0",
  };
  await page.route("**/v2/sessions/current/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "GET") {
      await route.fulfill({ body: "", headers: cors, status: 204 });
      return;
    }
    const response = fixtureResponse(url);
    await route.fulfill(response
      ? { body: JSON.stringify(response), contentType: "application/json", headers: cors, status: 200 }
      : { body: "", headers: cors, status: 204 });
  });
}

function fixtureResponse(url) {
  if (url.pathname === "/v2/sessions/current/status") {
    return { run: { run_id: runId, status: "completed" }, resources: {}, session: { session_id: runId } };
  }
  if (url.pathname === "/v2/sessions/current/simulation/runs/current") {
    return {
      artifact_dir: "/fixture/results-mode-sweep",
      requested_backend: "cpu",
      requested_device: "cpu",
      requested_mode: "run",
      requested_precision: "double",
      revision: 1,
      run_id: runId,
      session_id: runId,
      started_at: "2026-09-02T00:00:00Z",
      status: "completed",
      total_steps: 4,
    };
  }
  if (url.pathname === `/v2/sessions/current/analysis/results/runs/${runId}/datasets`) {
    return {
      items: datasetSummaries(),
      revision: "catalog-1",
      run_id: runId,
      schema_version: "analysis.results.v1",
      status: "partial",
      total_count: 2,
    };
  }
  if (url.pathname === "/v2/sessions/current/analysis/spin-wave/gamma.v1") return gamma();
  if (url.pathname === "/v2/sessions/current/analysis/spin-wave/dynamic-structure-factor.v1") return dsf();
  const datasetMatch = url.pathname.match(new RegExp(`/datasets/([^/]+)(?:/(.*))?$`));
  if (!datasetMatch || !url.pathname.includes(`/runs/${runId}/datasets/`)) return null;
  const datasetId = datasetMatch[1];
  const tail = datasetMatch[2] ?? "";
  if (tail === "") return manifest(datasetId);
  if (tail === "samples") return samples(datasetId);
  if (tail === "items") return items(datasetId, url.searchParams.get("sample_id"));
  if (tail.startsWith("axes/") && tail.endsWith("/values")) return axisValues(datasetId, tail.split("/")[1]);
  if (tail.startsWith("projections/")) return projection(datasetId, tail.slice("projections/".length));
  return null;
}

function datasetSummaries() {
  return [
    summary("time-domain-spectrum", "Time-domain spectrum fixture", "time_domain_spectrum"),
    summary("dynamic-structure-factor", "Dynamic structure factor fixture", "dynamic_structure_factor"),
  ];
}

function summary(datasetId, title, productKind) {
  return {
    dataset_id: datasetId, dataset_revision: "1", item_count: 2, manifest_resource_key: `/fixture/${datasetId}/manifest`, product_kind: productKind,
    run_id: runId, sample_count: 2, stage_id: "stage:analysis", status: statusFacets(), title,
  };
}

function manifest(datasetId) {
  const productKind = datasetId === "dynamic-structure-factor" ? "dynamic_structure_factor" : "time_domain_spectrum";
  const projectionId = productKind === "dynamic_structure_factor" ? "dsf" : "spectral-features";
  return {
    axes: [], capabilities: { branch_tracking: false, comparison: false, export: false, fields: false, item_paging: true, live_partial_results: false, result_meshes: false, sample_paging: true, server_filtering: false, server_sorting: false },
    dataset_id: datasetId, dataset_revision: "1", default_cursor: {}, description: "Fixture-backed typed Results manifest", item_index_resource: `/fixture/${datasetId}/items`, item_kinds: [productKind === "dynamic_structure_factor" ? "dsf_point" : "spectral_feature"], product_kind: productKind,
    projections: [{ kind: "line", projection_id: projectionId, resource_key: `/fixture/${datasetId}/projections/${projectionId}`, selectable: true, title: productKind === "dynamic_structure_factor" ? "S(k,f)" : "Spectral features" }],
    provenance: { legacy_schema: "legacy.fixture.v1", sampling_clock: "uniform dt=1e-12 s", window: "hann", normalization: "fixture normalization" }, run_id: runId, sample_index_resource: `/fixture/${datasetId}/samples`, schema_version: "analysis.results.v1", source_artifacts: [{ artifact: "legacy-fixture", relation: "source", revision: "1" }], stage_id: "stage:analysis", status: statusFacets(), title: datasetId === "dynamic-structure-factor" ? "Dynamic structure factor fixture" : "Time-domain spectrum fixture", topology_policy: "not applicable", units_policy: "SI",
  };
}

function samples(datasetId) {
  return { dataset_id: datasetId, dataset_revision: "1", items: [0, 1].map((sampleIndex) => ({ coordinates: [{ axis_id: "sample", label: `sample:${sampleIndex}`, token: String(sampleIndex) }], item_count: 1, items_resource: `/fixture/${datasetId}/items`, sample_id: `${datasetId}:sample:${sampleIndex}`, sample_index: sampleIndex, source_revision: "1", status: statusFacets() })), limit: 50, run_id: runId, schema_version: "analysis.results.v1", total_count: 2 };
}

function items(datasetId, sampleId) {
  const index = sampleId?.endsWith(":1") ? 1 : 0;
  const itemId = datasetId === "dynamic-structure-factor" ? `legacy:dsf:${index}:${index}` : `legacy:gamma:peak:${index}`;
  return { dataset_id: datasetId, dataset_revision: "1", items: [{ detail_resource: `/fixture/${datasetId}/items/${itemId}`, display_index: index, frequency_hz: (index + 1) * 12.5e9, item_id: itemId, item_kind: datasetId === "dynamic-structure-factor" ? "dsf_point" : "spectral_feature", quality: { qualification: "legacy" }, relations: [], sample_id: `${datasetId}:sample:${index}`, source_revision: "1", status: statusFacets(), wavevector_kf: datasetId === "dynamic-structure-factor" ? [index * 1e6, 0, 0] : null }], limit: 50, run_id: runId, schema_version: "analysis.results.v1", total_count: 1 };
}

function projection(datasetId, projectionId) {
  const dsf = datasetId === "dynamic-structure-factor";
  const itemIds = dsf ? ["legacy:dsf:0:0", "legacy:dsf:1:1"] : ["legacy:gamma:peak:0", "legacy:gamma:peak:1"];
  return { axis_labels: { x: dsf ? "frequency [Hz]" : "frequency [Hz]", y: "power [1]" }, axis_mapping: { x: "frequency", y: "power" }, axis_units: { x: "Hz", y: "1" }, dataset_id: datasetId, dataset_revision: "1", fixed_coordinates: [], projection_id: projectionId, projection_revision: "1", run_id: runId, schema_version: "analysis.results.v1", selection_index: itemIds.map((itemId, ordinal) => ({ item_id: itemId, ordinal, sample_id: `${datasetId}:sample:${ordinal}` })), series: [{ label: dsf ? "S(k,f)" : "Spectral features", points: itemIds.map((itemId, ordinal) => ({ item_id: itemId, ordinal, sample_id: `${datasetId}:sample:${ordinal}`, status: "partial", value: ordinal + 1, x: (ordinal + 1) * 12.5e9, y: ordinal + 1 })), series_id: "fixture" }], status: statusFacets() };
}

function axisValues(datasetId, axisId) {
  return { axis_id: axisId, dataset_id: datasetId, dataset_revision: "1", limit: 50, run_id: runId, schema_version: "analysis.results.v1", total_count: 0, values: [] };
}

function gamma() {
  return { detrend: "mean", frequency_hz: [0, 12.5e9], frequency_unit: "Hz", normalization: "fixture", nyquist_hz: 5e11, peaks: [{ frequency_hz: 12.5e9, index: 0, power: 1 }], primary_response_psd: [0, 1], reference_m0: 1, reference_m0_secondary: 1, response_component: "x", response_psd: [0, 1], response_spectrum_imag: [0, 1], response_spectrum_real: [0, 1], response_trace: [0, 1], schema_version: "legacy.gamma.fixture.v1", secondary_response_psd: [0, 1], secondary_response_spectrum_imag: [0, 1], secondary_response_spectrum_real: [0, 1], secondary_response_trace: [0, 1], source_psd: [0, 1], source_spectrum_imag: [0, 1], source_spectrum_real: [0, 1], source_trace: [0, 1], source_unit: "A/m", susceptibility_abs: [0, 1], susceptibility_unit: "1", time_s: [0, 1e-12], time_unit: "s", trace_unit: "1", transverse_components: ["x", "y"], weighting: "moment", window: "hann", window_power_sum: 1, window_values: [1, 1] };
}

function dsf() {
  return { artifact_ref: "legacy.dsf.fixture", bounded: false, component: "x", excluded_absorber_ranges_m: [], frequency_count: 2, frequency_hz: [0, 12.5e9], frequency_unit: "Hz", invalid_probe_mask: [false, false], k_rad_per_m: [0, 1e6], mesh_probe_signature: "fixture", normalization: "fixture", original_frequency_count: 2, original_wavevector_count: 2, phase_convention: "fixture", power: [1, 2, 3, 4], propagation_axis: "x", schema_version: "legacy.dsf.fixture.v1", source_observable: "H_drive", source_power: [1, 1, 1, 1], source_spectrum_imag: [0, 0, 0, 0], source_spectrum_real: [1, 1, 1, 1], source_unit: "A/m", spatial_window: [1, 1], spatial_window_power_sum: 2, spectrum_imag: [0, 0, 0, 0], spectrum_real: [1, 2, 3, 4], temporal_window: [1, 1], temporal_window_power_sum: 2, time_s: [0, 1e-12], wavevector_count: 2, wavevector_unit: "rad/m", x_m: [0, 1e-9] };
}

function statusFacets() {
  return { completeness: "partial", execution: "completed", qualification: "legacy", resource: "partial", reason_code: "legacy_artifact" };
}

async function loadPlaywright() {
  try { return await import("playwright"); } catch { return await import("@playwright/test"); }
}

main().catch((error) => {
  console.error(`Results mode sweep smoke failed: ${error.stack ?? error.message}`);
  process.exit(1);
});
