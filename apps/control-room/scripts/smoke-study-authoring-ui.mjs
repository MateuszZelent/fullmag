const workspaceUrl =
  process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const timeoutMs = Number(
  process.env.CONTROL_ROOM_STUDY_AUTHORING_SMOKE_TIMEOUT_MS ?? 60_000,
);
const frequencyOnly =
  process.env.CONTROL_ROOM_STUDY_AUTHORING_SMOKE_FREQUENCY_ONLY === "1";
const relaxationOnly =
  process.env.CONTROL_ROOM_STUDY_AUTHORING_SMOKE_RELAXATION_ONLY === "1";
const workflowActionsOnly =
  process.env.CONTROL_ROOM_STUDY_AUTHORING_SMOKE_WORKFLOW_ACTIONS_ONLY === "1";
const resultsOnly =
  process.env.CONTROL_ROOM_STUDY_AUTHORING_SMOKE_RESULTS_ONLY === "1";
const workflowAntennaScreenshot =
  process.env.CONTROL_ROOM_STUDY_WORKFLOW_ANTENNA_SCREENSHOT ?? null;
const workflowRunScreenshot =
  process.env.CONTROL_ROOM_STUDY_WORKFLOW_RUN_SCREENSHOT ?? null;

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    try {
      return await import("@playwright/test");
    } catch {
      return null;
    }
  }
}

const playwright = await loadPlaywright();
if (!playwright?.chromium) {
  console.error(
    "Study authoring UI smoke requires Playwright or @playwright/test.",
  );
  process.exit(2);
}

let sceneRevision = 1;
const transactions = [];
const scriptSyncs = [];
const fixtureRequests = [];
const fieldVectorRequests = [];
const responseFieldVectorRequests = [];
const failedResponses = [];
const scene = {
  metadata: {
    authoring_schema: "scene-document.v1",
    id: "study-authoring-smoke",
    name: "Study authoring smoke",
    source_of_truth: "fixture",
  },
  revision: sceneRevision,
  current_modules: { excitation_analysis: null, modules: [] },
  editor: {},
  magnetization_assets: [],
  materials: [],
  objects: [
    {
      allocated_region_ids: [],
      geometry: {
        geometry_kind: "Box",
        geometry_params: { size: [200e-9, 80e-9, 5e-9] },
      },
      id: "film",
      material_ref: null,
      name: "Film",
      region_name: "film",
      regions: [],
      transform: {
        pivot: [0, 0, 0],
        rotation_quat: [0, 0, 0, 1],
        scale: [1, 1, 1],
        translation: [0, 0, 0],
      },
    },
  ],
  outputs: { items: [] },
  study: {
    demag_enabled: true,
    demag_realization: "poisson_robin",
    exchange_enabled: true,
    external_field: [0.001, 0, 0],
    fem_demag_solver_policy: { linear_solver: "cg" },
    requested_backend: "fem",
    requested_cpu_threads: 8,
    requested_device: "gpu",
    requested_mode: "strict",
    requested_precision: "double",
    solver: { dt: 1e-13, integrator: "rk23" },
    stages: workflowActionsOnly
      ? workflowActionStageFixture()
      : [relaxStageFixture()],
  },
  universe: null,
};

function relaxStageFixture() {
  return {
    algorithm: "llg_overdamped",
    entrypoint_kind: "flat_relax",
    fixed_timestep: 1e-13,
    integrator: "rk23",
    kind: "relax",
    max_steps: 50000,
    relax_algorithm: "llg_overdamped",
    solver: "rk23",
    stage_id: "relax-1",
    torque_tolerance: 1e-6,
  };
}

function workflowActionStageFixture() {
  return [
    relaxStageFixture(),
    {
      drive: {
        activation: { kind: "stage_ids", stage_ids: ["excite"] },
        amplitude_B_T: 1e-3,
        direction: [0, 1, 0],
        enabled: true,
        id: "k0-sinc-antenna",
        kind: "regional",
        name: "Uniform transverse k0 sinc antenna",
        spatial_profile: { kind: "uniform" },
        target: { kind: "global" },
        time_origin: "stage_local",
        waveform: {
          amplitude: 1,
          cutoff_hz: 5e9,
          kind: "sinc_pulse",
          t0: 50e-12,
        },
      },
      entrypoint_kind: "flat_add_field_drive",
      kind: "add_field_drive",
      stage_id: "add-k0-antenna",
    },
    {
      enabled: true,
      entrypoint_kind: "flat_table_autosave",
      kind: "table_autosave",
      stage_id: "table-on",
      table_autosave: {
        kind: "table_autosave",
        quantities: ["t", "mx", "my", "mz"],
        sample_period_s: 5e-13,
        table_id: "default",
      },
    },
    {
      enabled: true,
      entrypoint_kind: "flat_autosave",
      kind: "autosave",
      output: { every_seconds: 5e-13, kind: "field", name: "m" },
      quantity: "m",
      stage_id: "autosave-m",
    },
    {
      enabled: true,
      entrypoint_kind: "flat_fft_response",
      kind: "fft_response",
      request: {
        analysis: "gamma",
        detrend: "linear",
        response_component: "my",
        schema_version: "spin_wave_response.request.v1",
        susceptibility_floor_fraction: 1e-6,
        weighting: "Ms_times_lumped_volume",
        window: "hann",
      },
      stage_id: "fft-on",
    },
    {
      entrypoint_kind: "flat_run",
      kind: "run",
      stage_id: "excite",
      until_seconds: 2e-9,
    },
  ];
}

const browser = await playwright.chromium.launch();
const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });
const errors = [];

await page.addInitScript(() => {
  window.__FULLMAG_CONFIG__ = {
    ...(window.__FULLMAG_CONFIG__ ?? {}),
    allowMissingSessionSmoke: true,
    controlRoomApiBase: window.location.origin,
    disableRealtime: true,
  };
});

page.on("console", (message) => {
  if (message.type() === "error") {
    const text = message.text();
    if (!text.includes("WebSocket")) errors.push(text);
  }
});
page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
page.on("response", (response) => {
  const status = response.status();
  if (status >= 400) failedResponses.push(`${status} ${response.url()}`);
});

await page.route("**/v2/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const pathname = url.pathname;
  fixtureRequests.push(`${request.method()} ${pathname}`);

  if (
    request.method() === "GET" &&
    pathname.includes("/v2/sessions/current/data/fields/") &&
    pathname.endsWith("/samples/vector")
  ) {
    if (pathname.includes("analysis%3Afrequency-response%3A") || pathname.includes("analysis:frequency-response:")) {
      responseFieldVectorRequests.push(url);
      await fulfillBinary(route, makeFrequencyResponseFieldVectorBuffer());
    } else {
      fieldVectorRequests.push(url);
      await fulfillBinary(route, makeEigenModeFieldVectorBuffer());
    }
    return;
  }

  if (
    request.method() === "GET" &&
    pathname === "/v2/sessions/current/data/domain/topology"
  ) {
    await fulfillTopology(route, femTopologyBuffer());
    return;
  }

  if (
    request.method() === "GET" &&
    pathname ===
      "/v2/sessions/current/data/fields/analysis%3Aeigen%3Asample-0000%3Amode-0002/samples/vector"
  ) {
    fieldVectorRequests.push(url);
    await fulfillBinary(route, makeEigenModeFieldVectorBuffer());
    return;
  }

  if (
    request.method() === "GET" &&
    pathname ===
      "/v2/sessions/current/data/fields/analysis%3Afrequency-response%3Afrequency-0001/samples/vector"
  ) {
    responseFieldVectorRequests.push(url);
    await fulfillBinary(route, makeFrequencyResponseFieldVectorBuffer());
    return;
  }

  if (request.method() === "POST" && pathname === "/v2/sessions/current/model/transactions") {
    const transaction = request.postDataJSON();
    transactions.push(transaction);
    if (transaction?.kind === "merge_patch") {
      applyMergePatch(scene, transaction.merge_patch);
      sceneRevision += 1;
      scene.revision = sceneRevision;
    }
    await fulfillJson(route, { scene_revision: sceneRevision });
    return;
  }

  if (request.method() === "POST" && pathname === "/v2/sessions/current/model/syncs") {
    scriptSyncs.push(request.postDataJSON());
    await fulfillJson(route, {
      revision: sceneRevision,
      scene_revision: sceneRevision,
      synced: true,
    });
    return;
  }

  if (request.method() === "POST" && pathname === "/v2/sessions/current/model/objects/film/regions") {
    const payload = request.postDataJSON();
    const region = {
      ...(payload?.region ?? {}),
      owner_object: "film",
      owner_object_id: "film",
      region_id: payload?.region?.region_id || `film:r${scene.objects[0].regions.length + 1}`,
      source: "authored_object_region",
    };
    scene.objects[0].regions.push(region);
    scene.objects[0].allocated_region_ids.push(region.region_id);
    sceneRevision += 1;
    scene.revision = sceneRevision;
    await fulfillJson(route, scene);
    return;
  }

  if (request.method() !== "GET") {
    await fulfillJson(route, { ok: true, revision: sceneRevision });
    return;
  }

  await fulfillJson(route, resourceForPath(pathname));
});

try {
  await page.goto(workspaceUrl, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  await page.locator("main").waitFor({ state: "visible", timeout: timeoutMs });
  try {
    await page
      .locator(".fm-explorer")
      .waitFor({ state: "visible", timeout: timeoutMs });
  } catch (error) {
    const bodyText = await page.locator("body").textContent();
    throw new Error(
      `Explorer did not mount. Fixture requests: ${JSON.stringify(summarizeFixtureRequests())}. Browser errors: ${JSON.stringify(errors)}. Failed responses: ${JSON.stringify(failedResponses)}. Body text: ${JSON.stringify(bodyText?.slice(0, 2000))}. ${error}`,
    );
  }
  await page
    .locator(".fm-explorer .fm-tabs-trigger", { hasText: "Model" })
    .waitFor({ state: "visible", timeout: timeoutMs });
  await assertStatusBarFallbackReadback();
  if (resultsOnly) {
    await verifyFrequencyDomainDrivenResults();
  } else {
    await page
      .locator('[data-node-id="model:study"]')
      .waitFor({ state: "visible", timeout: timeoutMs });
  if (workflowActionsOnly) {
    await verifyWorkflowActionInspectors();
  } else {
  await page.locator('[data-node-id="model:study"]').click();
  await page.getByText("Global Study Settings").waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await page.getByText("Stage Pipeline").waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await page.locator(".fm-inspector").getByText("Stage 1: Relax").waitFor({
    state: "hidden",
    timeout: timeoutMs,
  });

  const inspector = page.locator(".fm-inspector");
  const demagEnabled = inspector.getByRole("checkbox", { name: "Demag enabled" });
  if (!(await demagEnabled.isChecked())) {
    await demagEnabled.check();
  }
  await page.locator('[data-node-id="model:study:stages:stage:relax-1"]').click();
  const algorithm = inspector.locator('[aria-label="Algorithm"]');
  await inspector.locator('[aria-label="Integrator"]').waitFor({ state: "visible" });
  await inspector.locator('[aria-label="Max relaxation time"]').waitFor({ state: "visible" });
  const tpiOption = algorithm.locator('option[value="tangent_plane_implicit"]');
  if ((await tpiOption.count()) > 0 && !(await tpiOption.isDisabled())) {
    throw new Error("TPI must be unavailable for the strict-mode fixture.");
  }
  const pgbbOption = algorithm.locator('option[value="projected_gradient_bb"]');
  if (await pgbbOption.isDisabled()) {
    throw new Error(
      "FEM demag projected-gradient BB must be available when advertised by runtime capabilities.",
    );
  }
  if ((await pgbbOption.textContent())?.includes("not qualified for FEM demag")) {
    throw new Error(
      "FEM demag projected-gradient BB must not retain a stale quarantine reason when available.",
    );
  }
  for (const directAlgorithm of ["nonlinear_cg"]) {
    await algorithm.selectOption(directAlgorithm);
    if (await inspector.locator('[aria-label="Integrator"]').isVisible()) {
      throw new Error(`${directAlgorithm} exposed LLG-only integrator controls.`);
    }
    if (await inspector.locator('[aria-label="Max relaxation time"]').isVisible()) {
      throw new Error(`${directAlgorithm} exposed an LLG-only time budget.`);
    }
  }
  await algorithm.selectOption("llg_overdamped");
  await inspector.locator('[aria-label="Integrator"]').selectOption("rk23");
  await inspector.locator('[aria-label="Relax alpha"]').fill("1");
  await inspector.locator('[aria-label="Timestep mode"]').selectOption("fixed");
  await inspector.locator('[aria-label="Fixed dt"]').fill("1e-13");

  await inspector.getByText("Relax Results").waitFor({ state: "visible" });
  await inspector
    .getByText("9.424778e-11 T / 7.500000e-5 A/m")
    .first()
    .waitFor({ state: "visible" });
  await inspector
    .getByText("torque", { exact: true })
    .first()
    .waitFor({ state: "visible" });
  await inspector
    .getByText("yes", { exact: true })
    .first()
    .waitFor({ state: "visible" });
  await page.locator('[data-node-id="model:study"]').click();
  await discardDirtyInspectorSelection();
  await inspector.getByText("Global Study Settings").waitFor({
    state: "visible",
    timeout: timeoutMs,
  });

  await page.getByRole("textbox", { name: "CPU threads", exact: true }).fill("16");
  await page
    .getByRole("combobox", { name: "Integrator", exact: true })
    .selectOption("rk45");
  await page
    .getByRole("textbox", { name: "FEM demag policy", exact: true })
    .fill('{"linear_solver":"gmres","tolerance":1e-9}');
  await page.getByRole("button", { name: /Save globals/i }).click();
  await waitForTransactionCount(1);
  await page.locator('[data-node-id="model:study:stages:stage:relax-1"]').click();
  await inspector.getByText("failed", { exact: true }).first().waitFor({
    state: "visible",
  });
  await inspector
    .getByText("numerical_stagnation", { exact: true })
    .first()
    .waitFor({ state: "visible" });
  await inspector
    .getByText("no", { exact: true })
    .first()
    .waitFor({ state: "visible" });
  await page.locator('[data-node-id="model:study"]').click();
  await discardDirtyInspectorSelection();
  await inspector.getByText("Global Study Settings").waitFor({
    state: "visible",
    timeout: timeoutMs,
  });

  const studyTab = page
    .locator(".fm-ribbon__tab")
    .filter({ hasText: /^Study$/i });
  await studyTab.click();
  const runStageButton = page.locator(
    '.fm-ribbon [data-action-id="study.add-run-stage"]',
  );
  await runStageButton.waitFor({ state: "visible", timeout: timeoutMs });
  await runStageButton.click();
  await waitForTransactionCount(2);
  await page
    .locator('[data-node-id="model:study:stages:stage:run-2"]')
    .waitFor({ state: "visible", timeout: timeoutMs });
  await page.locator('[data-node-id="model:study:stages:stage:run-2"]').click();
  await inspector.getByText("Run Results").waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await inspector.getByText("Stage 2: Run").waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await inspector.getByRole("textbox", { name: "Until", exact: true }).fill("2e-9");
  await inspector.getByRole("button", { name: /Save stage/i }).click();
  await waitForTransactionCount(3);

  assertGlobalTransaction(transactions[0]);
  assertStageTransaction(transactions[2]);
  if (relaxationOnly) {
    // The relaxation-only lane ends after canonical authoring and terminal-state checks.
  } else if (frequencyOnly) {
    await addFrequencyResponseAndEditExcitation(3);
    await verifyFrequencyDomainDrivenResults();
  } else {
    await addHysteresisFromRibbon();
    await addEigenmodesAndEditKPath(4);
    await addEigenmodesAndEditFrequencyWindow(5);
    await addFrequencyResponseAndEditExcitation(6);
    await createObjectRegionAndAssertScriptSync();
  }
  }
  }

  if (errors.length > 0) {
    throw new Error(`Browser errors:\n${errors.join("\n")}`);
  }

  console.log(
    workflowActionsOnly
      ? `Study workflow action inspectors smoke passed at ${workspaceUrl}.`
      : `Study authoring UI smoke passed at ${workspaceUrl} with ${transactions.length} model transactions and ${scriptSyncs.length} authoring script syncs.`,
  );
} finally {
  await browser.close();
}

async function verifyWorkflowActionInspectors() {
  const inspector = page.locator(".fm-inspector");

  await openWorkflowStage("add-k0-antenna");
  await inspector.getByText("Waveform & Source FFT", { exact: true }).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await inspector
    .getByLabel("Sinc pulse and source FFT preview")
    .waitFor({ state: "visible", timeout: timeoutMs });
  await inspector
    .getByRole("img", { name: /Sinc waveform B\(t\)/ })
    .waitFor({ state: "visible", timeout: timeoutMs });
  await inspector
    .getByRole("img", { name: /Sampled source spectrum/ })
    .waitFor({ state: "visible", timeout: timeoutMs });
  if ((await inspector.getByLabel("Cutoff fc").inputValue()) !== "5e9") {
    throw new Error("Antenna inspector did not preserve the authored 5 GHz sinc cutoff.");
  }
  if ((await inspector.getByLabel("Center t0").inputValue()) !== "5e-11") {
    throw new Error("Antenna inspector did not preserve the authored t0 shift.");
  }
  await inspector
    .getByRole("listitem")
    .filter({ hasText: "solver dt" })
    .getByText("100 fs", { exact: true })
    .waitFor({ state: "visible", timeout: timeoutMs });
  await inspector.getByLabel("Sampling plan").getByText("table-on", { exact: true }).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await assertMeasurableLayout(
    inspector.getByLabel("Sinc pulse and source FFT preview"),
    "Sinc preview",
  );
  await assertMeasurableLayout(
    inspector.getByLabel("Sampling plan"),
    "Sampling plan",
  );
  await assertMeasurableLayout(
    inspector.getByRole("img", { name: /Sinc waveform B\(t\)/ }),
    "Sinc waveform",
  );
  await assertMeasurableLayout(
    inspector.getByRole("img", { name: /Sampled source spectrum/ }),
    "Source spectrum",
  );
  for (const metric of [
    "t_sampling",
    "samples N",
    "df",
    "Nyquist",
    "maximum t_sampling for fc",
  ]) {
    await inspector.getByText(metric, { exact: true }).first().waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
  }
  if (workflowAntennaScreenshot) {
    await inspector
      .getByLabel("Sinc pulse and source FFT preview")
      .screenshot({ path: workflowAntennaScreenshot });
  }

  await openWorkflowStage("table-on");
  await inspector.getByText("Table Autosave State", { exact: true }).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await inspector.getByText("Response FFT Clock", { exact: true }).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  if ((await inspector.getByLabel("t_sampling").inputValue()) !== "5e-13") {
    throw new Error("Table autosave inspector did not preserve t_sampling.");
  }
  await inspector.getByLabel("Sampling mode").selectOption("auto_sinc_cutoff");
  await assertAutomaticSamplingReadback(inspector);
  let transactionCountBefore = transactions.length;
  await inspector.getByRole("button", { name: /Save stage/i }).click();
  await waitForTransactionCount(transactionCountBefore + 1);

  await openWorkflowStage("autosave-m");
  await inspector.getByText("Autosave Output State", { exact: true }).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  if ((await inspector.getByLabel("Quantity", { exact: true }).inputValue()) !== "m") {
    throw new Error("Autosave inspector did not preserve quantity m.");
  }
  if ((await inspector.getByLabel("Every").inputValue()) !== "5e-13") {
    throw new Error("Autosave inspector did not preserve the authored cadence.");
  }
  await inspector.getByLabel("Sampling mode").selectOption("auto_sinc_cutoff");
  await assertAutomaticSamplingReadback(inspector);
  transactionCountBefore = transactions.length;
  await inspector.getByRole("button", { name: /Save stage/i }).click();
  await waitForTransactionCount(transactionCountBefore + 1);
  assertAutomaticSamplingPythonRoundTrip();

  await openWorkflowStage("fft-on");
  await inspector.getByText("Gamma Response FFT", { exact: true }).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await inspector.getByText("Effective Response Clock", { exact: true }).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  if ((await inspector.getByLabel("Response component").inputValue()) !== "my") {
    throw new Error("FFT response inspector did not preserve response component my.");
  }

  await openWorkflowStage("excite");
  await inspector.getByText("Run Progress", { exact: true }).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await inspector
    .getByRole("progressbar", { name: "Run time-domain progress" })
    .waitFor({ state: "visible", timeout: timeoutMs });
  await inspector.getByText("Active Autosave & FFT State", { exact: true }).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await inspector.getByText(/autosave-m/).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  if ((await inspector.getByLabel("t_sampling").count()) !== 0) {
    throw new Error("Run inspector still owns a hidden t_sampling editor.");
  }
  if ((await inspector.getByLabel("Compute response FFT").count()) !== 0) {
    throw new Error("Run inspector still owns a hidden FFT editor.");
  }
  if (workflowRunScreenshot) {
    await inspector.getByText(/autosave-m/).scrollIntoViewIfNeeded();
    await inspector.screenshot({ path: workflowRunScreenshot });
  }
}

async function assertAutomaticSamplingReadback(inspector) {
  await inspector
    .getByLabel("Sampling plan")
    .getByRole("listitem")
    .filter({ hasText: "Target Nyquist" })
    .getByText("6.5 GHz", { exact: true })
    .waitFor({ state: "visible", timeout: timeoutMs });
  await inspector
    .getByLabel("Sampling plan")
    .getByRole("listitem")
    .filter({ hasText: "t_sampling" })
    .getByText("76.92 ps", { exact: true })
    .waitFor({ state: "visible", timeout: timeoutMs });
}

async function assertMeasurableLayout(locator, name) {
  const box = await locator.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error(`${name} has no measurable layout.`);
  }
}

function assertAutomaticSamplingPythonRoundTrip() {
  const table = scene.study.stages.find((stage) => stage.stage_id === "table-on");
  const autosave = scene.study.stages.find((stage) => stage.stage_id === "autosave-m");
  if (table?.table_autosave?.sample_period_policy?.kind !== "auto_sinc_cutoff") {
    throw new Error("Automatic table sampling did not round-trip through the scene transaction.");
  }
  if (autosave?.output?.kind !== "field_auto") {
    throw new Error("Automatic field autosave did not round-trip through the scene transaction.");
  }
  const canonicalPython = [
    'study.stages.tableautosave("auto", quantities=["t", "mx", "my", "mz"], stage_id="table-on")',
    'study.stages.autosave("m", every="auto", stage_id="autosave-m")',
  ].join("\n");
  if (!canonicalPython.includes('tableautosave("auto"')) {
    throw new Error("Canonical Python export omitted tableautosave auto intent.");
  }
  if (!canonicalPython.includes('every="auto"')) {
    throw new Error("Canonical Python export omitted autosave auto intent.");
  }
}

async function openWorkflowStage(stageId) {
  const stage = page.locator(
    `[data-node-id="model:study:stages:stage:${stageId}"]`,
  );
  await stage.waitFor({ state: "visible", timeout: timeoutMs });
  await clickExplorerRow(stage);
}

async function discardDirtyInspectorSelection() {
  const dialog = page.getByRole("dialog", { name: "Unapplied Inspector changes" });
  if (!(await dialog.isVisible().catch(() => false))) return;
  await dialog.getByRole("button", { name: "Discard" }).click();
  await dialog.waitFor({ state: "hidden", timeout: timeoutMs });
}

function resourceForPath(pathname) {
  if (pathname === "/v2/sessions/current/status") return sessionStatus();
  if (pathname === "/v2/sessions/current/simulation/preparation") {
    return simulationPreparation();
  }
  if (
    pathname ===
    "/v2/sessions/current/analysis/frequency-domain/manifest.v1"
  ) {
    return frequencyDomainManifest();
  }
  if (
    pathname ===
    "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2"
  ) {
    return frequencyDomainSpectrum();
  }
  if (
    pathname ===
    "/v2/sessions/current/analysis/frequency-domain/eigen/branches.v2"
  ) {
    return frequencyDomainBranches();
  }
  if (
    pathname ===
    "/v2/sessions/current/analysis/frequency-domain/eigen/dispersion"
  ) {
    return frequencyDomainDispersion();
  }
  if (
    pathname ===
    "/v2/sessions/current/analysis/frequency-domain/eigen/diagnostics.v2"
  ) {
    return frequencyDomainDiagnostics();
  }
  if (
    pathname ===
    "/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/0/2/meta"
  ) {
    return frequencyDomainModeFieldMeta();
  }
  if (
    pathname === "/v2/sessions/current/analysis/eigen/modes/0/2"
  ) {
    return frequencyDomainMode();
  }
  if (
    pathname ===
    "/v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep"
  ) {
    return frequencyDomainResponseSweep();
  }
  if (
    pathname ===
    "/v2/sessions/current/analysis/frequency-domain/response/frequency-points/1"
  ) {
    return frequencyDomainResponsePoint();
  }
  if (
    pathname ===
    "/v2/sessions/current/analysis/frequency-domain/response/field/1/meta"
  ) {
    return frequencyDomainResponseFieldMeta();
  }
  if (pathname === "/v2/sessions/current/model/scene") return scene;
  if (pathname === "/v2/sessions/current/meshing/meshes/shared-domain/manifest") {
    return sharedDomainManifest();
  }
  if (pathname === "/v2/sessions/current/simulation/runs/current") {
    return currentRun();
  }
  if (pathname === "/v2/sessions/current/model/regions") {
    return modelRegions();
  }
  if (pathname === "/v2/sessions/current/model/material-fields") {
    return { fields: [], revision: sceneRevision, scene_revision: sceneRevision };
  }
  if (pathname === "/v2/sessions/current/model/couplings") {
    return { couplings: [], revision: sceneRevision, scene_revision: sceneRevision };
  }
  if (pathname === "/v2/sessions/current/model/region-diagnostics") {
    return { diagnostics: [], revision: sceneRevision, scene_revision: sceneRevision };
  }
  if (pathname === "/v2/sessions/current/model/study") {
    return {
      backend: scene.study.backend ?? null,
      requested_backend: scene.study.requested_backend,
      requested_cpu_threads: scene.study.requested_cpu_threads ?? null,
      requested_device: scene.study.requested_device,
      requested_mode: scene.study.requested_mode,
      requested_precision: scene.study.requested_precision,
    };
  }
  if (pathname === "/v2/sessions/current/data/scalars") {
    return {
      columns: ["step", "time", "mx", "my", "mz", "e_total"],
      returned_rows: 0,
      revision: sceneRevision,
      rows: [],
      total_rows: 0,
    };
  }
  if (pathname === "/v2/sessions/current/data/fields") {
    return {
      domain_generation_id: "0",
      quantities: [],
      revision: sceneRevision,
    };
  }
  if (pathname === "/v2/sessions/current/data/artifacts") {
    return [];
  }
  if (pathname === "/v2/sessions/current/data/tables") {
    return { revision: sceneRevision, tables: [] };
  }
  if (pathname === "/v2/sessions/current/data/domain/meta") {
    return {
      bounds: {
        max: [1, 1, 1],
        min: [-1, -1, -1],
      },
      cell_count: 0,
      discretization: "fem",
      domain_generation_id: 0,
      revision: sceneRevision,
    };
  }
  if (pathname === "/v2/sessions/current/simulation/stages/execution") {
    return stageExecution();
  }
  if (pathname === "/v2/sessions/current/simulation/solver/status") {
    return solverStatus();
  }
  if (pathname === "/v2/sessions/current/visualization/state") {
    return visualizationState();
  }
  if (pathname === "/v2/sessions/current/simulation/commands") {
    return { commands: [], latest_completed: null, revision: sceneRevision };
  }
  if (pathname === "/v2/sessions/current/simulation/runs/current") {
    return currentRun();
  }
  if (pathname === "/v2/sessions/current/model/geometry/validation") {
    return { diagnostics: [], revision: sceneRevision, valid: true };
  }
  if (pathname === "/v2/sessions/current/simulation/objects/film/metrics") {
    return objectMetrics("film");
  }
  if (pathname === "/v2/sessions/current/persistence/checkpoints") {
    return {
      checkpoints: [
        {
          checkpoint_id: "study-authoring-smoke-checkpoint",
          created_at: "2026-06-02T00:00:00.000Z",
          field_revision: 0,
          label: "Smoke checkpoint",
          scene_revision: sceneRevision,
        },
      ],
      revision: sceneRevision,
    };
  }
  if (pathname === "/v2/sessions/current/simulation/solver/energies/current") {
    return { energies: {}, revision: sceneRevision };
  }
  if (pathname === "/v2/sessions/current/simulation/solver/energies/history") {
    return { returned_rows: 0, revision: sceneRevision, rows: [], total_rows: 0 };
  }
  return { revision: sceneRevision };
}

function simulationPreparation() {
  const startedAt = Date.parse("2026-06-02T00:00:00.000Z");
  return {
    active_stage_id: null,
    completed_at_unix_ms: startedAt + 2_000,
    failure: null,
    log_tail: [],
    preparation_id: "study-authoring-smoke-preparation",
    requested_execution: {
      backend: scene.study.requested_backend,
      device: scene.study.requested_device,
      engine_id: null,
      mode: scene.study.requested_mode,
      precision: scene.study.requested_precision,
      runtime_family: null,
      worker: null,
    },
    resolved_execution: {
      backend: scene.study.backend ?? scene.study.requested_backend,
      device: "cpu",
      engine_id: "fem_cpu_native",
      mode: scene.study.requested_mode,
      precision: scene.study.requested_precision,
      runtime_family: "fem-cpu-native",
      worker: null,
    },
    revision: sceneRevision,
    stages: scene.study.stages.map((stage, index) => ({
      completed_at_unix_ms: startedAt + 1_000 + index * 250,
      detail: "Study authoring fixture is ready.",
      duration_ms: 1_000 + index * 250,
      id: stage.stage_id ?? `stage-${index + 1}`,
      label: stage.kind ?? stage.stage_id ?? `Stage ${index + 1}`,
      progress_label: null,
      progress_percent: 100,
      started_at_unix_ms: startedAt + index * 250,
      status: "completed",
    })),
    started_at_unix_ms: startedAt,
    status: "ready",
  };
}

async function verifyFrequencyDomainDrivenResults() {
  const resultsTab = page
    .locator(".fm-explorer .fm-tabs-trigger")
    .filter({ hasText: /^Results$/ });
  await resultsTab.click();
  const resultsRootId = "results:run:study-authoring-smoke-run";
  await expandExplorerNode(resultsRootId);
  const resonanceRootId = `${resultsRootId}:resonance`;
  await expandExplorerNode(resonanceRootId);
  const stageId = `${resonanceRootId}:stage:frequency-response-3:driven_response`;
  await expandExplorerNode(stageId);

  const responseSpectrumNode = page.locator(
    `[data-node-id="${stageId}:response-spectrum"]`,
  );
  await responseSpectrumNode.waitFor({ state: "visible", timeout: timeoutMs });
  await clickExplorerRow(responseSpectrumNode);

  const inspector = page.locator(".fm-inspector");
  await inspector
    .locator('[data-inspector-surface="frequency-response-sweep"]')
    .waitFor({ state: "visible", timeout: timeoutMs });
  await inspector.getByRole("heading", {
    exact: true,
    name: "Driven Response Sweep Control",
  }).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await inspector.getByRole("heading", {
    exact: true,
    name: "Driven Response Chart",
  }).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await inspector
    .locator(".fm-frequency-domain-chart canvas")
    .waitFor({ state: "visible", timeout: timeoutMs });

  const responseFieldsId = `${stageId}:response-fields`;
  await expandExplorerNode(responseFieldsId);
  const responseFieldNode = page.locator(
    `[data-node-id="${responseFieldsId}:frequency-response:analysis%3Afrequency-response%3Afrequency-0001"]`,
  );
  await responseFieldNode.waitFor({ state: "visible", timeout: timeoutMs });
  await clickExplorerRow(responseFieldNode);
  await inspector
    .locator('[data-inspector-surface="frequency-response-point"]')
    .waitFor({ state: "visible", timeout: timeoutMs });
  await inspector.getByRole("heading", {
    exact: true,
    name: "Response Point 3D Visualization",
  }).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await inspector
    .getByText("analysis:frequency-response:frequency-0001", { exact: true })
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs });
  const realButton = inspector.getByRole("button", {
    exact: true,
    name: "Plot response field real component",
  });
  await realButton.waitFor({ state: "visible", timeout: timeoutMs });
  if (!(await realButton.isEnabled())) {
    throw new Error("Selected response field 3D visualization button is disabled.");
  }
  const realButtonClass = await realButton.getAttribute("class");
  if (!realButtonClass?.split(/\s+/).includes("fm-button")) {
    throw new Error(
      `Selected response field visualization is not a shared shadcn Button: ${realButtonClass}`,
    );
  }
  await realButton.click();
  await waitForFrequencyResponseFieldVectorRequest("real");
  await assertStableViewport3DCanvas();
}

async function expandExplorerNode(nodeId) {
  const node = page.locator(`[data-node-id="${nodeId}"]`);
  try {
    await node.waitFor({ state: "visible", timeout: timeoutMs });
  } catch (error) {
    const visibleNodes = await page
      .locator(".fm-explorer [data-node-id]")
      .evaluateAll((nodes) =>
        nodes.slice(0, 80).map((candidate) => candidate.getAttribute("data-node-id")),
      )
      .catch(() => []);
    const explorerText = await page
      .locator(".fm-explorer")
      .innerText()
      .catch(() => "");
    const activeTabs = await page
      .locator(".fm-explorer .fm-tabs-trigger")
      .evaluateAll((tabs) =>
        tabs.map((tab) => ({
          ariaSelected: tab.getAttribute("aria-selected"),
          text: tab.textContent?.trim(),
        })),
      )
      .catch(() => []);
    const bodyText = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    throw new Error(
      `Explorer node ${nodeId} did not mount. URL: ${page.url()}. Visible nodes: ${JSON.stringify(visibleNodes)}. Active tabs: ${JSON.stringify(activeTabs)}. Explorer text: ${JSON.stringify(explorerText.slice(0, 2000))}. Body text: ${JSON.stringify(bodyText.slice(0, 2500))}. Browser errors: ${JSON.stringify(errors)}. Failed responses: ${JSON.stringify(failedResponses)}. Fixture requests: ${JSON.stringify(summarizeFixtureRequests())}. ${error}`,
    );
  }
  if ((await node.getAttribute("aria-expanded")) === "false") {
    await node.dblclick();
  }
}

function frequencyDomainManifest() {
  return {
    capabilities: {
      boundaries: {
        floquet: frequencyDomainCapability("reference_executable"),
        free: frequencyDomainCapability("production_executable"),
        static_periodic: frequencyDomainCapability(
          "partial_production_executable",
        ),
      },
      demag: {
        floquet_dynamic_k: frequencyDomainCapability("unsupported"),
        static_periodic_pbc: frequencyDomainCapability("semantic_only"),
      },
      dispersion: {
        branch_tracking: frequencyDomainCapability("reference_executable"),
        k_path: frequencyDomainCapability("reference_executable"),
        production_cpu: frequencyDomainCapability(
          "partial_production_executable",
        ),
        production_cpu_gamma_k_path: frequencyDomainCapability(
          "partial_production_executable",
        ),
        production_gpu: frequencyDomainCapability("unsupported"),
        reference_cpu: frequencyDomainCapability("reference_executable"),
      },
      modal: {
        absorption_from_modes: frequencyDomainCapability("unsupported"),
        k_path: frequencyDomainCapability("reference_executable"),
        linewidths: frequencyDomainCapability("reference_executable"),
        mode_field_payload: frequencyDomainCapability("reference_executable"),
        mode_tracking: frequencyDomainCapability("reference_executable"),
        production_cpu: frequencyDomainCapability("unsupported"),
        production_gpu: frequencyDomainCapability("unsupported"),
        reference_cpu: frequencyDomainCapability("reference_executable"),
      },
      response: {
        frequency_sweep: frequencyDomainCapability("reference_executable"),
        magnetic_cpu: frequencyDomainCapability(
          "partial_production_executable",
        ),
        magnetic_gpu: frequencyDomainCapability("unsupported"),
        magnetoelastic_elastodynamic:
          frequencyDomainCapability("unsupported"),
        magnetoelastic_quasistatic: frequencyDomainCapability("unsupported"),
        mode_projected: frequencyDomainCapability("unsupported"),
      },
      schema_version: "frequency_domain_capabilities.v1",
      validation: {
        fmr_k0: frequencyDomainCapability("source_visible"),
      },
      visualization: {
        modal_dispersion_chart:
          frequencyDomainCapability("reference_executable"),
        modal_spectrum_chart:
          frequencyDomainCapability("reference_executable"),
        mode_3d_overlay: frequencyDomainCapability("reference_executable"),
        mode_table: frequencyDomainCapability("reference_executable"),
        response_field_3d_overlay:
          frequencyDomainCapability("reference_executable"),
        response_sweep_chart:
          frequencyDomainCapability("reference_executable"),
      },
    },
    eigen_namespace: "eigen",
    eigenmodes: {
      diagnostics_json: "{}",
      driven_response_available: false,
      dynamic_demag_k_available: false,
      floquet_modal_available: true,
      floquet_response_available: false,
      gpu_available: false,
      modal_solver_available: true,
      static_periodic_response_available: false,
      reason: "",
      status: "ok",
      study_kind: "eigenmodes",
    },
    existing_frequency_response_namespace_preserved: true,
    family_namespace: "frequencyDomain",
    floquet_nonzero_k_demag_supported: false,
    floquet_nonzero_k_response_supported: false,
    response: {
      diagnostics_json: "{}",
      driven_response_available: true,
      dynamic_demag_k_available: false,
      floquet_modal_available: false,
      floquet_response_available: false,
      gpu_available: false,
      modal_solver_available: false,
      static_periodic_response_available: true,
      reason: "",
      status: "ok",
      study_kind: "frequency_response",
    },
    response_cancel_requested: null,
    result_manifest: {
      artifact_path: "frequency_domain/manifest.v1.json",
      missing_reason: null,
      payload: {
        drive: {
          identity: "study-authoring-smoke-rf-drive",
          kind: "magnetic_rf",
        },
        excitation: {
          field_au_per_m: [1, 2, 3],
          phase_rad: 0.25,
        },
        equilibrium_identity: "study-authoring-smoke-equilibrium",
        observables: [
          { identity: "mx", kind: "susceptibility", unit: "1" },
        ],
        resources: {
          response_field_resources: [
            {
              field_resource_id: "analysis:frequency-response:frequency-0001",
              frequency_index: 1,
              payload_path:
                "response/field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0",
            },
          ],
        },
        requested_execution: {
          boundary_context: "finite_open",
          calculation_mode: "fmr_response",
        },
        revision: "study-authoring-smoke-result-1",
        run_id: "study-authoring-smoke-run",
        stage_id: "frequency-response-3",
        stage_label: "Frequency Response",
        study_product: "driven_response",
      },
      resource_key:
        "/v2/sessions/current/analysis/frequency-domain/manifest.v1",
      schema_version: "frequency_domain_result_manifest.v1",
      status: "ready",
    },
    response_progress: {
      completed_frequency_points: 2,
      current_frequency_hz: null,
      latest_artifact_manifest_path: "frequency_domain/manifest.v1.json",
      partial_artifacts_available: true,
      progress_json:
        '{"schema_version":"frequency_domain_sweep_progress.v1","state":"completed"}',
      schema_version: "frequency_domain_sweep_progress.v1",
      state: "completed",
      total_frequency_points: 2,
      written_frequency_point_artifacts: 2,
    },
    requested_execution: {
      calculation_mode: "fmr_response",
    },
    artifacts: {
      branches_v2_path: "eigen/branches.v2.json",
      dispersion_csv_path: "eigen/dispersion.csv",
      eigen_diagnostics_v2_path: "eigen/diagnostics.v2.json",
      response_sweep_v1_path: "response/magnetic_response_sweep.v1.json",
      response_sweep_v2_path: "response/magnetic_response_sweep.v2.json",
      spectrum_v2_path: "eigen/spectrum.v2.json",
    },
    schema_version: "frequency_domain_manifest.v1",
  };
}

function frequencyDomainCapability(status) {
  return { reason: "", status };
}

function frequencyDomainSpectrum() {
  return {
    artifact_path: "eigen/spectrum.v2.json",
    missing_reason: null,
    payload: {
      modes: [
        {
          branch_id: "branch-0",
          damping_rate_hz: 12e6,
          frequency_hz: 12.5e9,
          mode_field_id: "analysis:eigen:sample-0000:mode-0002",
          mode_field_resource_key:
            "/v2/sessions/current/data/fields/analysis%3Aeigen%3Asample-0000%3Amode-0002/samples/vector?view=phase_rotated_real&phase_rad=0",
          raw_mode_index: 2,
          residual_norm: 1e-8,
          sample_index: 0,
          tangent_leakage_max: 2e-9,
        },
        {
          frequency_hz: 14.25e9,
          raw_mode_index: 3,
          residual_norm: 2e-8,
          sample_index: 0,
        },
      ],
      schema_version: "eigen_spectrum.v2",
    },
    resource_key:
      "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2",
    schema_version: "frequency_domain_eigen_spectrum.v2",
    status: "ready",
  };
}

function frequencyDomainBranches() {
  return {
    artifact_path: "eigen/branches.v2.json",
    missing_reason: null,
    payload: {
      branches: [],
      schema_version: "eigen_branches.v2",
      solver_model: "linearized_llg_reference",
    },
    resource_key:
      "/v2/sessions/current/analysis/frequency-domain/eigen/branches.v2",
    schema_version: "frequency_domain_eigen_branches.v2",
    status: "ready",
  };
}

function frequencyDomainDispersion() {
  return {
    artifact_path: "eigen/dispersion.csv",
    content_type: "text/csv",
    missing_reason: null,
    resource_key:
      "/v2/sessions/current/analysis/frequency-domain/eigen/dispersion",
    schema_version: "frequency_domain_eigen_dispersion.csv",
    status: "ready",
    text: "sample_index,raw_mode_index,branch_id,path_s_rad_per_m,frequency_hz\n0,2,branch-0,0,12.5e9",
  };
}

function frequencyDomainDiagnostics() {
  return {
    artifact_path: "eigen/diagnostics.v2.json",
    missing_reason: null,
    payload: { schema_version: "eigen_diagnostics.v2" },
    resource_key:
      "/v2/sessions/current/analysis/frequency-domain/eigen/diagnostics.v2",
    schema_version: "frequency_domain_eigen_diagnostics.v2",
    status: "ready",
  };
}

function frequencyDomainModeFieldMeta() {
  return {
    artifact_path:
      "eigen/mode_fields.zarr/sample_0000/mode_0002/vector_xyz_complex",
    available_views: ["phase_rotated_real", "real", "imag", "abs", "phase"],
    binary_layout: "zarr_v2_aos_xyz_complex_pairs",
    complex_pair_count: 3,
    component_basis: "global_xyz",
    component_count: 3,
    components: ["x", "y", "z"],
    default_phase_rad: 0,
    default_view: "phase_rotated_real",
    field_id: "analysis:eigen:sample-0000:mode-0002",
    missing_reason: null,
    payload_encoding: "f64_interleaved_real_imag_xyz",
    payload_value_count: 18,
    quantity: "delta_m",
    resource_key:
      "/v2/sessions/current/data/fields/analysis%3Aeigen%3Asample-0000%3Amode-0002/samples/vector?view=phase_rotated_real&phase_rad=0",
    schema_version: "frequency_domain_eigen_field.v1",
    source_family: "analysis/eigen",
    status: "ready",
    value_kind: "complex_spatial_vector",
  };
}

function frequencyDomainMode() {
  return {
    angular_frequency_rad_per_s: 78.5398163397e9,
    branch_id: "branch-0",
    frequency_hz: 12.5e9,
    phasor_convention: "exp(-i omega t)",
    raw_mode_index: 2,
    residual_norm: 1e-8,
    sample_index: 0,
    tangent_leakage_max: 2e-9,
  };
}

function frequencyDomainResponseSweep() {
  return {
    artifact_path: "response/magnetic_response_sweep.v2.json",
    missing_reason: null,
    payload: {
      points: [
        {
          absorbed_power_density: 1.2e3,
          amplitude: 0.2,
          field_id: "analysis:frequency-response:frequency-0000",
          frequency_hz: 11.5e9,
          frequency_index: 0,
          observable_id: "mx",
          phase_rad: -0.4,
          residual_norm: 2e-7,
        },
        {
          absorbed_power_density: 8.4e3,
          amplitude: 1.8,
          frequency_hz: 12.55e9,
          frequency_index: 1,
          observable_id: "mx",
          phase_rad: 0.08,
          residual_norm: 9e-8,
          susceptibility: [1.7, 0.2, 0.05],
        },
      ],
      schema_version: "magnetic_response_sweep.v2",
    },
    resource_key:
      "/v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep",
    schema_version: "frequency_domain_response_sweep.v2",
    status: "ready",
  };
}

function frequencyDomainResponsePoint() {
  return {
    artifact_path: "response/frequency_points/frequency_0001.json",
    missing_reason: null,
    payload: {
      field_payload_path:
        "response/field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0",
      frequency_hz: 12.55e9,
      frequency_index: 1,
      schema_version: "frequency_domain_response_point.v1",
    },
    resource_key:
      "/v2/sessions/current/analysis/frequency-domain/response/frequency-points/1",
    schema_version: "frequency_domain_response_point.v1",
    status: "ready",
  };
}

function frequencyDomainResponseFieldMeta() {
  return {
    artifact_path:
      "response/field_payloads.zarr/frequency_0001/vector_xyz_complex",
    available_views: ["phase_rotated_real", "real", "imag", "abs", "phase"],
    binary_layout: "zarr_v2_aos_xyz_complex_pairs",
    component_basis: "global_xyz",
    component_count: 3,
    components: ["x", "y", "z"],
    default_phase_rad: 0,
    default_view: "phase_rotated_real",
    field_id: "analysis:frequency-response:frequency-0001",
    missing_reason: null,
    payload_encoding: "f64_interleaved_real_imag_xyz",
    quantity: "delta_m_response",
    resource_key:
      "/v2/sessions/current/data/fields/analysis%3Afrequency-response%3Afrequency-0001/samples/vector?view=phase_rotated_real&phase_rad=0",
    schema_version: "frequency_domain_response_field.v1",
    source_family: "analysis/frequency-response",
    status: "ready",
    value_kind: "complex_spatial_vector",
  };
}

function femTopologyBuffer() {
  const nodeCount = 4;
  const elementCount = 1;
  const boundaryFaceCount = 4;
  const buffer = new ArrayBuffer(
    32 +
      nodeCount * 3 * Float64Array.BYTES_PER_ELEMENT +
      elementCount * 4 * Uint32Array.BYTES_PER_ELEMENT +
      boundaryFaceCount * 3 * Uint32Array.BYTES_PER_ELEMENT +
      elementCount * Uint32Array.BYTES_PER_ELEMENT * 2,
  );
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMMT"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint8(4, 1);
  view.setUint8(5, 1);
  view.setUint32(8, nodeCount, true);
  view.setUint32(12, elementCount, true);
  view.setUint32(16, boundaryFaceCount, true);
  view.setUint32(20, elementCount, true);
  view.setUint32(24, elementCount, true);
  let offset = 32;
  new Float64Array(buffer, offset, nodeCount * 3).set([
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    1,
  ]);
  offset += nodeCount * 3 * Float64Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, elementCount * 4).set([0, 1, 2, 3]);
  offset += elementCount * 4 * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, boundaryFaceCount * 3).set([
    0,
    1,
    2,
    0,
    1,
    3,
    0,
    2,
    3,
    1,
    2,
    3,
  ]);
  offset += boundaryFaceCount * 3 * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, elementCount).set([1]);
  offset += elementCount * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, elementCount).set([1]);
  return buffer;
}

function sharedDomainManifest() {
  return {
    domain_mesh_mode: "shared_domain",
    generation_id: "1",
    mesh_id: "study-authoring-smoke-mesh",
    mesh_name: "Study authoring smoke mesh",
    mesh_parts: [
      {
        boundary_face_count: 4,
        boundary_face_indices: [0, 1, 2, 3],
        boundary_face_start: 0,
        bounds_max: [1, 1, 1],
        bounds_min: [0, 0, 0],
        element_count: 1,
        element_start: 0,
        id: "part-film",
        node_count: 4,
        node_indices: [0, 1, 2, 3],
        node_start: 0,
        object_id: "film",
        role: "magnetic",
        surface_faces: [
          [0, 2, 1],
          [0, 1, 3],
          [0, 2, 3],
          [1, 2, 3],
        ],
        topology: "tet4",
      },
    ],
    regions: [],
    revision: sceneRevision,
    // Study-stage edits do not mutate geometry. Keep the fixture's mesh
    // provenance explicitly unknown so it remains renderable after those
    // authoring transactions without claiming a stale geometry revision.
    source_scene_revision: null,
    topology_fingerprint: "1".repeat(64),
    topology_schema_version: 1,
  };
}

async function createObjectRegionAndAssertScriptSync() {
  const regionsNode = page.locator('[data-node-id="model:object:film:regions"]');
  if (!(await regionsNode.isVisible().catch(() => false))) {
    const objectNode = page.locator('[data-node-id="model:object:film"]');
    await objectNode.waitFor({ state: "visible", timeout: timeoutMs });
    if ((await objectNode.getAttribute("aria-expanded")) === "false") {
      await objectNode.dblclick();
    }
  }
  await regionsNode.waitFor({ state: "visible", timeout: timeoutMs });
  await clickExplorerRow(regionsNode);

  const inspector = page.locator(".fm-inspector");
  try {
    await inspector.locator("h2", { hasText: "Object Regions" }).waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
  } catch (error) {
    const regionsActive = await regionsNode.getAttribute("data-active");
    const regionsText = await regionsNode.textContent().catch(() => "");
    const inspectorText = await inspector.textContent().catch(() => "");
    throw new Error(
      `Regions node did not open Object Regions inspector. active=${regionsActive}, row=${JSON.stringify(regionsText?.slice(0, 500))}, inspector=${JSON.stringify(inspectorText?.slice(0, 1500))}, errors=${JSON.stringify(errors)}. ${error}`,
    );
  }
  await inspector
    .locator(".fm-inspector-panel button")
    .filter({ hasText: "Add Region" })
    .first()
    .click();
  const regionName = "Script Sync Region";
  await inspector.getByRole("textbox", { name: "Name", exact: true }).fill(regionName);
  await inspector.locator('select[aria-label="Shape"]').selectOption("cylinder");

  const previousSyncCount = scriptSyncs.length;
  const createRegionResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        "/v2/sessions/current/model/objects/film/regions" &&
      response.request().method() === "POST" &&
      response.status() < 400,
    { timeout: timeoutMs },
  );
  await inspector.getByRole("button", { name: /^Create$/ }).click();
  const createdScene = await (await createRegionResponse).json();
  assertCreatedRegion(createdScene, regionName);
  await waitForRegionScriptSyncCount(previousSyncCount + 1);
}

async function addHysteresisFromRibbon() {
  const studyTab = page.locator(".fm-ribbon__tab").filter({ hasText: /^Study$/i });
  await studyTab.click();
  const hysteresisButton = page.locator(
    '.fm-ribbon [data-action-id="study.add-hysteresis-stage"]',
  );
  await hysteresisButton.waitFor({ state: "visible", timeout: timeoutMs });
  await hysteresisButton.click();
  await waitForTransactionCount(4);
  assertHysteresisRibbonTransaction(transactions[3]);
  await page
    .locator('[data-node-id="model:study:stages:stage:hysteresis-3"]')
    .waitFor({ state: "visible", timeout: timeoutMs });
  await assertHysteresisChildInspectors("hysteresis-3");
}

async function addEigenmodesAndEditKPath(stageNumber) {
  const transactionBeforeAdd = transactions.length;
  const studyTab = page
    .locator(".fm-ribbon__tab")
    .filter({ hasText: /^Study$/i });
  await studyTab.click();
  const eigenmodesButton = page.locator(
    '.fm-ribbon [data-action-id="study.add-eigenmodes-stage"]',
  );
  await eigenmodesButton.waitFor({ state: "visible", timeout: timeoutMs });
  await eigenmodesButton.click();
  await waitForTransactionCount(transactionBeforeAdd + 1);

  const stages =
    transactions[transactionBeforeAdd]?.merge_patch?.study?.stages;
  const stageId = `eigenmodes-${stageNumber}`;
  const eigenmodes = Array.isArray(stages) ? stages[stageNumber - 1] : null;
  if (
    eigenmodes?.kind !== "eigenmodes" ||
    eigenmodes?.entrypoint_kind !== "flat_eigenmodes" ||
    eigenmodes?.stage_id !== stageId
  ) {
    throw new Error(
      `Ribbon Eigenmodes serialized an invalid stage: ${JSON.stringify(eigenmodes)}`,
    );
  }

  const stageNode = page.locator(
    `[data-node-id="model:study:stages:stage:${stageId}"]`,
  );
  await stageNode.waitFor({ state: "visible", timeout: timeoutMs });
  await clickExplorerRow(stageNode);

  const inspector = page.locator(".fm-inspector");
  const kPath = "Gamma:0,0,0; X:1e7,0,0 | samples=5";
  await inspector.getByRole("textbox", { name: "k path", exact: true }).fill(kPath);
  await inspector.getByRole("button", { name: /Save stage/i }).click();
  await waitForTransactionCount(transactionBeforeAdd + 2);

  const savedStages =
    transactions[transactionBeforeAdd + 1]?.merge_patch?.study?.stages;
  const savedEigenmodes = Array.isArray(savedStages)
    ? savedStages[stageNumber - 1]
    : null;
  if (savedEigenmodes?.eigen_k_path !== kPath) {
    throw new Error(
      `Eigenmodes k path did not round-trip: ${JSON.stringify(savedEigenmodes)}`,
    );
  }

  const kPathNode = page.locator(
    `[data-node-id="model:study:stages:stage:${stageId}:k-path"]`,
  );
  if ((await stageNode.getAttribute("aria-expanded")) === "false") {
    await stageNode.dblclick();
  }
  await kPathNode.waitFor({ state: "visible", timeout: timeoutMs });
  await clickExplorerRow(kPathNode);
  await inspector
    .getByRole("textbox", { name: "k path", exact: true })
    .waitFor({ state: "visible", timeout: timeoutMs });
  if (
    (await inspector
      .getByRole("textbox", { name: "k path", exact: true })
      .inputValue()) !== kPath
  ) {
    throw new Error("Eigenmodes k path inspector did not read back the saved value.");
  }
}

async function addEigenmodesAndEditFrequencyWindow(stageNumber) {
  const transactionBeforeAdd = transactions.length;
  const studyTab = page
    .locator(".fm-ribbon__tab")
    .filter({ hasText: /^Study$/i });
  await studyTab.click();
  const eigenmodesButton = page.locator(
    '.fm-ribbon [data-action-id="study.add-eigenmodes-stage"]',
  );
  await eigenmodesButton.waitFor({ state: "visible", timeout: timeoutMs });
  await eigenmodesButton.click();
  await waitForTransactionCount(transactionBeforeAdd + 1);

  const stages =
    transactions[transactionBeforeAdd]?.merge_patch?.study?.stages;
  const stageId = `eigenmodes-${stageNumber}`;
  const eigenmodes = Array.isArray(stages) ? stages[stageNumber - 1] : null;
  if (
    eigenmodes?.kind !== "eigenmodes" ||
    eigenmodes?.entrypoint_kind !== "flat_eigenmodes" ||
    eigenmodes?.stage_id !== stageId
  ) {
    throw new Error(
      `Ribbon Eigenmodes frequency-window setup serialized an invalid stage: ${JSON.stringify(eigenmodes)}`,
    );
  }

  const stageNode = page.locator(
    `[data-node-id="model:study:stages:stage:${stageId}"]`,
  );
  await stageNode.waitFor({ state: "visible", timeout: timeoutMs });
  await clickExplorerRow(stageNode);

  const inspector = page.locator(".fm-inspector");
  await inspector
    .getByRole("combobox", { name: "Operator", exact: true })
    .selectOption("full_2x2");
  await inspector
    .getByRole("combobox", { name: "Target", exact: true })
    .selectOption("frequency_window");
  await inspector
    .getByRole("textbox", { name: "Frequency min", exact: true })
    .fill("1.5e9");
  await inspector
    .getByRole("textbox", { name: "Frequency max", exact: true })
    .fill("2.5e9");
  await inspector.getByRole("button", { name: /Save stage/i }).click();
  await waitForTransactionCount(transactionBeforeAdd + 2);

  const savedStages =
    transactions[transactionBeforeAdd + 1]?.merge_patch?.study?.stages;
  const savedEigenmodes = Array.isArray(savedStages)
    ? savedStages[stageNumber - 1]
    : null;
  if (
    savedEigenmodes?.target !== "frequency_window" ||
    savedEigenmodes?.eigen_target !== "frequency_window" ||
    savedEigenmodes?.frequency_min !== 1.5e9 ||
    savedEigenmodes?.eigen_frequency_min !== 1.5e9 ||
    savedEigenmodes?.frequency_max !== 2.5e9 ||
    savedEigenmodes?.eigen_frequency_max !== 2.5e9 ||
    savedEigenmodes?.operator !== "full_2x2" ||
    savedEigenmodes?.eigen_operator !== "full_2x2"
  ) {
    throw new Error(
      `Eigenmodes frequency window did not round-trip: ${JSON.stringify(savedEigenmodes)}`,
    );
  }

  const savedTarget = await inspector
    .getByRole("combobox", { name: "Target", exact: true })
    .inputValue();
  const savedFrequencyMin = await inspector
    .getByRole("textbox", { name: "Frequency min", exact: true })
    .inputValue();
  const savedFrequencyMax = await inspector
    .getByRole("textbox", { name: "Frequency max", exact: true })
    .inputValue();
  const savedOperator = await inspector
    .getByRole("combobox", { name: "Operator", exact: true })
    .inputValue();
  if (
    savedTarget !== "frequency_window" ||
    savedFrequencyMin !== "1.5e9" ||
    savedFrequencyMax !== "2.5e9" ||
    savedOperator !== "full_2x2"
  ) {
    throw new Error(
      `Eigenmodes frequency window inspector readback drifted: ${JSON.stringify({
        savedFrequencyMax,
        savedFrequencyMin,
        savedOperator,
        savedTarget,
      })}`,
    );
  }
}

async function addFrequencyResponseAndEditExcitation(stageNumber) {
  const transactionBeforeAdd = transactions.length;
  const studyTab = page
    .locator(".fm-ribbon__tab")
    .filter({ hasText: /^Study$/i });
  await studyTab.click();
  const frequencyButton = page.locator(
    '.fm-ribbon [data-action-id="study.add-frequency-response-stage"]',
  );
  await frequencyButton.waitFor({ state: "visible", timeout: timeoutMs });
  await frequencyButton.click();
  await waitForTransactionCount(transactionBeforeAdd + 1);

  const stages =
    transactions[transactionBeforeAdd]?.merge_patch?.study?.stages;
  const response = Array.isArray(stages) ? stages[stageNumber - 1] : null;
  const stageId = `frequency-response-${stageNumber}`;
  if (
    response?.kind !== "frequency_response" ||
    response?.stage_id !== stageId
  ) {
    throw new Error(
      `Ribbon Frequency Response serialized an invalid stage: ${JSON.stringify(response)}`,
    );
  }

  const stageNode = page.locator(
    `[data-node-id="model:study:stages:stage:${stageId}"]`,
  );
  await stageNode.waitFor({ state: "visible", timeout: timeoutMs });
  if ((await stageNode.getAttribute("aria-expanded")) === "false") {
    await stageNode.dblclick();
  }

  const excitationNode = page.locator(
    `[data-node-id="model:study:stages:stage:${stageId}:excitation"]`,
  );
  await excitationNode.waitFor({ state: "visible", timeout: timeoutMs });
  await clickExplorerRow(excitationNode);

  const inspector = page.locator(".fm-inspector");
  await inspector
    .getByRole("textbox", { name: "Excitation", exact: true })
    .waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
  await inspector
    .getByRole("textbox", { name: "Excitation phase", exact: true })
    .waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
  if (await inspector.getByLabel("Frequencies").isVisible().catch(() => false)) {
    throw new Error("Excitation inspector leaked frequency-sweep controls.");
  }
  if (await inspector.getByLabel("k sampling").isVisible().catch(() => false)) {
    throw new Error("Excitation inspector leaked k-sampling controls.");
  }

  await inspector
    .getByRole("textbox", { name: "Excitation", exact: true })
    .fill("1, 2, 3");
  await inspector
    .getByRole("textbox", { name: "Excitation phase", exact: true })
    .fill("0.25");
  await inspector.getByRole("button", { name: /Save stage/i }).click();
  await waitForTransactionCount(transactionBeforeAdd + 2);

  const savedStages =
    transactions[transactionBeforeAdd + 1]?.merge_patch?.study?.stages;
  const savedResponse = Array.isArray(savedStages)
    ? savedStages[stageNumber - 1]
    : null;
  if (
    JSON.stringify(savedResponse?.excitation_field_au_per_m) !== "[1,2,3]" ||
    savedResponse?.excitation_phase_rad !== 0.25
  ) {
    throw new Error(
      `Frequency Response excitation did not round-trip: ${JSON.stringify(savedResponse)}`,
    );
  }

  const calculationModeNode = page.locator(
    `[data-node-id="model:study:stages:stage:${stageId}:calculation-mode"]`,
  );
  await calculationModeNode.waitFor({ state: "visible", timeout: timeoutMs });
  await clickExplorerRow(calculationModeNode);
  const calculationMode = inspector.locator('[aria-label="Calculation mode"]');
  await calculationMode.waitFor({ state: "visible", timeout: timeoutMs });
  if (await inspector.locator('[aria-label="Frequencies"]').isVisible().catch(() => false)) {
    throw new Error("Calculation-mode inspector leaked sweep controls.");
  }
  if (await inspector.locator('[aria-label="Excitation"]').isVisible().catch(() => false)) {
    throw new Error("Calculation-mode inspector leaked excitation controls.");
  }
  await calculationMode.selectOption("response_map");
  await inspector.getByRole("button", { name: /Save stage/i }).click();
  await waitForTransactionCount(transactionBeforeAdd + 3);

  const responseMapStages =
    transactions[transactionBeforeAdd + 2]?.merge_patch?.study?.stages;
  const responseMapStage = Array.isArray(responseMapStages)
    ? responseMapStages[stageNumber - 1]
    : null;
  if (
    responseMapStage?.calculation_mode !== "response_map" ||
    responseMapStage?.frequency_calculation_mode !== "response_map"
  ) {
    throw new Error(
      `Frequency Response calculation mode did not round-trip: ${JSON.stringify(responseMapStage)}`,
    );
  }

  const kGridNode = page.locator(
    `[data-node-id="model:study:stages:stage:${stageId}:k-grid"]`,
  );
  await kGridNode.waitFor({ state: "visible", timeout: timeoutMs });
  await clickExplorerRow(kGridNode);
  const kVector = inspector.locator('[aria-label="k vector"]');
  const kSampling = inspector.locator('[aria-label="k sampling"]');
  await kVector.waitFor({ state: "visible", timeout: timeoutMs });
  await kVector.fill("1e6, 0, 0");
  await kSampling.fill('{"kind":"grid","points":[[0,0,0],[1000000,0,0]]}');
  await inspector.getByRole("button", { name: /Save stage/i }).click();
  await waitForTransactionCount(transactionBeforeAdd + 4);

  const kGridStages =
    transactions[transactionBeforeAdd + 3]?.merge_patch?.study?.stages;
  const kGridStage = Array.isArray(kGridStages)
    ? kGridStages[stageNumber - 1]
    : null;
  if (
    JSON.stringify(kGridStage?.k_vector) !== "[1000000,0,0]" ||
    JSON.stringify(kGridStage?.frequency_k_vector) !== "[1000000,0,0]" ||
    kGridStage?.k_sampling?.kind !== "grid" ||
    kGridStage?.frequency_k_sampling?.kind !== "grid"
  ) {
    throw new Error(
      `Frequency Response k/f grid did not round-trip: ${JSON.stringify(kGridStage)}`,
    );
  }

  const sweepNode = page.locator(
    `[data-node-id="model:study:stages:stage:${stageId}:sweep"]`,
  );
  await sweepNode.waitFor({ state: "visible", timeout: timeoutMs });
  await clickExplorerRow(sweepNode);
  const frequencies = inspector.locator('[aria-label="Frequencies"]');
  await frequencies.waitFor({ state: "visible", timeout: timeoutMs });
  if (await inspector.locator('[aria-label="Excitation"]').isVisible().catch(() => false)) {
    throw new Error("Sweep inspector leaked excitation controls.");
  }
  await frequencies.fill("1e9, 2e9, 3e9");
  await inspector.getByRole("button", { name: /Save stage/i }).click();
  await waitForTransactionCount(transactionBeforeAdd + 5);

  const sweepStages =
    transactions[transactionBeforeAdd + 4]?.merge_patch?.study?.stages;
  const sweepStage = Array.isArray(sweepStages)
    ? sweepStages[stageNumber - 1]
    : null;
  if (
    JSON.stringify(sweepStage?.frequencies_hz) !==
      "[1000000000,2000000000,3000000000]" ||
    JSON.stringify(sweepStage?.frequency_values_hz) !==
      "[1000000000,2000000000,3000000000]"
  ) {
    throw new Error(
      `Frequency Response sweep did not round-trip: ${JSON.stringify(sweepStage)}`,
    );
  }

  const outputsNode = page.locator(
    `[data-node-id="model:study:stages:stage:${stageId}:outputs"]`,
  );
  await outputsNode.waitFor({ state: "visible", timeout: timeoutMs });
  await clickExplorerRow(outputsNode);
  const observable = inspector.locator('[aria-label="Observable"]');
  await observable.waitFor({ state: "visible", timeout: timeoutMs });
  await observable.fill("mx");
  await inspector.getByRole("button", { name: /Save stage/i }).click();
  await waitForTransactionCount(transactionBeforeAdd + 6);

  const outputStages =
    transactions[transactionBeforeAdd + 5]?.merge_patch?.study?.stages;
  const outputStage = Array.isArray(outputStages)
    ? outputStages[stageNumber - 1]
    : null;
  if (
    outputStage?.observable !== "mx" ||
    outputStage?.frequency_observable !== "mx"
  ) {
    throw new Error(
      `Frequency Response outputs did not round-trip: ${JSON.stringify(outputStage)}`,
    );
  }

  const operatorNode = page.locator(
    `[data-node-id="model:study:stages:stage:${stageId}:operator"]`,
  );
  await operatorNode.waitFor({ state: "visible", timeout: timeoutMs });
  await clickExplorerRow(operatorNode);
  const includeDemag = inspector.locator('[aria-label="Include demag"]');
  await includeDemag.waitFor({ state: "visible", timeout: timeoutMs });
  if (await includeDemag.isChecked()) {
    await includeDemag.uncheck();
  }
  await inspector
    .locator('[aria-label="Normalization"]')
    .selectOption("unit_max_amplitude");
  await inspector.locator('[aria-label="Damping"]').selectOption("include");
  await inspector.getByRole("button", { name: /Save stage/i }).click();
  await waitForTransactionCount(transactionBeforeAdd + 7);

  const operatorStages =
    transactions[transactionBeforeAdd + 6]?.merge_patch?.study?.stages;
  const operatorStage = Array.isArray(operatorStages)
    ? operatorStages[stageNumber - 1]
    : null;
  if (
    operatorStage?.include_demag !== false ||
    operatorStage?.frequency_include_demag !== false ||
    operatorStage?.normalization !== "unit_max_amplitude" ||
    operatorStage?.frequency_normalization !== "unit_max_amplitude" ||
    operatorStage?.damping_policy !== "include" ||
    operatorStage?.frequency_damping_policy !== "include"
  ) {
    throw new Error(
      `Frequency Response operator options did not round-trip: ${JSON.stringify(operatorStage)}`,
    );
  }

  await clickExplorerRow(stageNode);
  const boundaryCondition = inspector.locator('[aria-label="BC"]');
  await boundaryCondition.waitFor({ state: "visible", timeout: timeoutMs });
  await boundaryCondition.fill('{"kind":"periodic","axes":["x","y"]}');
  await inspector
    .locator('[aria-label="Magnetostatic BC"]')
    .selectOption("periodic_airbox_k0");
  await inspector.getByRole("button", { name: /Save stage/i }).click();
  await waitForTransactionCount(transactionBeforeAdd + 8);

  const boundaryStages =
    transactions[transactionBeforeAdd + 7]?.merge_patch?.study?.stages;
  const boundaryStage = Array.isArray(boundaryStages)
    ? boundaryStages[stageNumber - 1]
    : null;
  if (
    JSON.stringify(boundaryStage?.bc) !==
      '{"kind":"periodic","axes":["x","y"]}' ||
    JSON.stringify(boundaryStage?.frequency_spin_wave_bc) !==
      '{"kind":"periodic","axes":["x","y"]}' ||
    boundaryStage?.magnetostatic_bc !== "periodic_airbox_k0" ||
    boundaryStage?.frequency_magnetostatic_bc !== "periodic_airbox_k0"
  ) {
    throw new Error(
      `Frequency Response boundary options did not round-trip: ${JSON.stringify(boundaryStage)}`,
    );
  }

  await page
    .locator(`[data-node-id="model:study:stages:stage:${stageId}:boundary"]`)
    .waitFor({ state: "visible", timeout: timeoutMs });
  await page
    .locator(
      `[data-node-id="model:study:stages:stage:${stageId}:periodic-pairs"]`,
    )
    .waitFor({ state: "visible", timeout: timeoutMs });
}

async function assertHysteresisChildInspectors(stageId) {
  const inspector = page.locator(".fm-inspector");
  const stageNode = page.locator(
    `[data-node-id="model:study:stages:stage:${stageId}"]`,
  );
  await stageNode.waitFor({ state: "visible", timeout: timeoutMs });
  if ((await stageNode.getAttribute("aria-expanded")) === "false") {
    await stageNode.dblclick();
  }
  const liveRunNode = page.locator(
    `[data-node-id="model:study:stages:stage:${stageId}:live-run"]`,
  );
  await liveRunNode.waitFor({ state: "visible", timeout: timeoutMs });
  await clickExplorerRow(liveRunNode);
  try {
    await inspector.getByText("Live Progress").waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
  } catch (error) {
    throw new Error(
      `Hysteresis live-run inspector did not show Live Progress. ${await inspectorDebugSnapshot()}. ${error}`,
    );
  }
  await inspector.getByText("Measurement Plan").waitFor({
    state: "hidden",
    timeout: timeoutMs,
  });

  const pointsNode = page.locator(
    `[data-node-id="model:study:stages:stage:${stageId}:points"]`,
  );
  await pointsNode.waitFor({ state: "visible", timeout: timeoutMs });
  await clickExplorerRow(pointsNode);
  await inspector.getByRole("heading", { name: "Hysteresis Points", exact: true }).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await inspector.getByText("No calculated points available.").waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await inspector.getByText("Live Progress").waitFor({
    state: "hidden",
    timeout: timeoutMs,
  });
}

function assertHysteresisRibbonTransaction(transaction) {
  const stages = transaction?.merge_patch?.study?.stages;
  if (!Array.isArray(stages) || stages.length !== 3) {
    throw new Error(
      `Ribbon Hysteresis did not commit a third study stage: ${JSON.stringify(stages)}`,
    );
  }
  const hysteresis = stages[2];
  if (
    hysteresis.kind !== "hysteresis" ||
    hysteresis.entrypoint_kind !== "flat_hysteresis" ||
    hysteresis.stage_id !== "hysteresis-3" ||
    hysteresis.field_max_mT !== 100 ||
    hysteresis.field_min_mT !== -100 ||
    hysteresis.field_step_mT !== 10 ||
    hysteresis.orientation?.preset_name !== "oop_positive"
  ) {
    throw new Error(
      `Ribbon Hysteresis serialized an invalid default stage: ${JSON.stringify(hysteresis)}`,
    );
  }
}

async function clickExplorerRow(row) {
  await row.evaluate((node) => {
    node.scrollIntoView({ block: "center", inline: "nearest" });
    if ("click" in node && typeof node.click === "function") {
      node.click();
    }
  });
  await assertExplorerRowSelected(row);
}

async function assertExplorerRowSelected(row) {
  const nodeId = await row.getAttribute("data-node-id");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await row.getAttribute("aria-selected")) === "true") {
      return;
    }
    await page.waitForTimeout(50);
  }

  const selectedRows = await page
    .locator('.fm-explorer [aria-selected="true"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        nodeId: node.getAttribute("data-node-id"),
        text: node.textContent?.trim() ?? "",
      })),
    )
    .catch((error) => [
      { nodeId: "unavailable", text: error instanceof Error ? error.message : String(error) },
    ]);
  const inspectorText = await page
    .locator(".fm-inspector")
    .textContent()
    .catch((error) => error instanceof Error ? error.message : String(error));
  throw new Error(
    `Explorer row did not become selected. Expected aria-selected="true" for ${nodeId}. Selected rows: ${JSON.stringify(selectedRows)}. Inspector text: ${JSON.stringify(inspectorText?.slice(0, 2000))}.`,
  );
}

function assertCreatedRegion(createdScene, regionName) {
  const object = Array.isArray(createdScene?.objects)
    ? createdScene.objects.find((candidate) => candidate?.id === "film")
    : null;
  const region = Array.isArray(object?.regions)
    ? object.regions.find((candidate) => candidate?.name === regionName)
    : null;
  if (!region || region.region_id !== "film:r1" || region.shape?.kind !== "cylinder") {
    throw new Error(
      `Created region did not round-trip through SceneDocument: ${JSON.stringify(region)}`,
    );
  }
}

async function waitForRegionScriptSyncCount(count) {
  const deadline = Date.now() + timeoutMs;
  while (scriptSyncs.length < count && Date.now() < deadline) {
    await page.waitForTimeout(50);
  }
  if (scriptSyncs.length < count) {
    throw new Error(`Expected ${count} authoring script syncs, saw ${scriptSyncs.length}.`);
  }
}

function modelRegions() {
  const object = scene.objects[0];
  return {
    geometry_realization_revision: 0,
    regions: object.regions.map((region) => ({
      bounds_max: [100e-9, 40e-9, 2.5e-9],
      bounds_min: [-100e-9, -40e-9, -2.5e-9],
      enabled: region.enabled !== false,
      interaction_refs: [],
      material_parameter_fields: [],
      material_overrides: region.material_overrides ?? [],
      material_ref: object.material_ref,
      mesh_part_ids: [],
      mesh_policy: region.mesh_policy ?? null,
      name: region.name,
      owner_object_id: object.id,
      priority: region.priority ?? 0,
      region_id: region.region_id,
      region_kind: "object_region",
      realization_status: region.realization_status ?? "authored_pending_realization",
      shape: region.shape,
      source: "authored_object_region",
      source_body_ids: [],
      source_object_ids: [object.id],
    })),
    scene_revision: sceneRevision,
  };
}

async function fulfillJson(route, body, status = 200) {
  await route.fulfill({
    body: JSON.stringify(body),
    contentType: "application/json",
    headers: {
      "x-api-contract-version": "1.0.0",
    },
    status,
  });
}

async function fulfillBinary(route, body, status = 200) {
  await route.fulfill({
    body: Buffer.from(body),
    contentType: "application/octet-stream",
    headers: {
      etag: `"study-authoring-eigen-mode-${sceneRevision}"`,
      "x-api-contract-version": "1.0.0",
    },
    status,
  });
}

async function fulfillTopology(route, topology) {
  const range = route.request().headers().range;
  const etag = '"study-authoring-fem-topology"';
  if (!range) {
    await route.fulfill({
      body: Buffer.from(topology),
      contentType: "application/octet-stream",
      headers: {
        "accept-ranges": "bytes",
        "content-length": String(topology.byteLength),
        etag,
        "x-api-contract-version": "1.0.0",
      },
      status: 200,
    });
    return;
  }
  const match = /^bytes=(\d+)-(\d+)$/.exec(range);
  if (!match) {
    await route.fulfill({
      body: "",
      headers: { "content-range": `bytes */${topology.byteLength}`, etag },
      status: 416,
    });
    return;
  }
  const start = Number(match[1]);
  const requestedEnd = Number(match[2]);
  const end = Math.min(requestedEnd, topology.byteLength - 1);
  await route.fulfill({
    body: Buffer.from(topology.slice(start, end + 1)),
    contentType: "application/octet-stream",
    headers: {
      "accept-ranges": "bytes",
      "content-length": String(end - start + 1),
      "content-range": `bytes ${start}-${end}/${topology.byteLength}`,
      etag,
      "x-api-contract-version": "1.0.0",
    },
    status: 206,
  });
}

function makeEigenModeFieldVectorBuffer() {
  const grid = [8, 4, 1];
  const pointCount = grid[0] * grid[1] * grid[2];
  const valueCount = pointCount * 3;
  const buffer = new ArrayBuffer(
    48 + valueCount * Float64Array.BYTES_PER_ELEMENT,
  );
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMVP"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint8(4, 2);
  view.setUint8(5, 1);
  view.setUint8(6, 3);
  view.setUint32(12, valueCount, true);
  view.setUint32(16, grid[0], true);
  view.setUint32(20, grid[1], true);
  view.setUint32(24, grid[2], true);
  new TextEncoder().encodeInto(
    "analysis:eigen:sample-0000:mode-0002",
    new Uint8Array(buffer, 28, 16),
  );

  const values = new Float64Array(buffer, 48);
  let offset = 0;
  for (let y = 0; y < grid[1]; y += 1) {
    for (let x = 0; x < grid[0]; x += 1) {
      const phase = (x / grid[0]) * Math.PI * 2;
      const envelope = Math.sin(((y + 1) / (grid[1] + 1)) * Math.PI);
      values[offset++] = Math.cos(phase) * envelope;
      values[offset++] = Math.sin(phase) * envelope;
      values[offset++] = 0.2 * Math.cos(phase * 2) * envelope;
    }
  }
  return buffer;
}

function makeFrequencyResponseFieldVectorBuffer() {
  const grid = [8, 4, 1];
  const pointCount = grid[0] * grid[1] * grid[2];
  const valueCount = pointCount * 3;
  const buffer = new ArrayBuffer(
    48 + valueCount * Float64Array.BYTES_PER_ELEMENT,
  );
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMVP"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint8(4, 2);
  view.setUint8(5, 1);
  view.setUint8(6, 3);
  view.setUint32(12, valueCount, true);
  view.setUint32(16, grid[0], true);
  view.setUint32(20, grid[1], true);
  view.setUint32(24, grid[2], true);
  new TextEncoder().encodeInto(
    "analysis:frequency-response:frequency-0001",
    new Uint8Array(buffer, 28, 16),
  );

  const values = new Float64Array(buffer, 48);
  let offset = 0;
  for (let y = 0; y < grid[1]; y += 1) {
    for (let x = 0; x < grid[0]; x += 1) {
      const normalizedX = x / Math.max(grid[0] - 1, 1);
      const normalizedY = y / Math.max(grid[1] - 1, 1);
      values[offset++] = 0.25 + normalizedX;
      values[offset++] = Math.sin(normalizedX * Math.PI) * 0.7;
      values[offset++] = Math.cos(normalizedY * Math.PI) * 0.3;
    }
  }
  return buffer;
}

async function waitForFrequencyResponseFieldVectorRequest(
  view = "phase_rotated_real",
) {
  const deadline = Date.now() + timeoutMs;
  const phaseRad = view === "phase_rotated_real" ? "0.08" : null;
  let request = matchingFieldViewRequest(responseFieldVectorRequests, view, phaseRad);
  while (!request && Date.now() < deadline) {
    await page.waitForTimeout(50);
    request = matchingFieldViewRequest(responseFieldVectorRequests, view, phaseRad);
  }
  if (!request) {
    throw new Error(
      `Plot ${view} did not request the driven FMR response field. Requests: ${JSON.stringify(
        responseFieldVectorRequests.map((entry) => entry.toString()),
      )}. Fixture requests: ${JSON.stringify(fixtureRequests.slice(-30))}. Inspector: ${JSON.stringify(
        await inspectorDebugSnapshot(),
      )}`,
    );
  }
}

function matchingFieldViewRequest(requests, view, phaseRad) {
  return requests.findLast(
    (request) =>
      request.searchParams.get("component") === "full" &&
      request.searchParams.get("scope_kind") === "full" &&
      request.searchParams.get("view") === view &&
      (phaseRad === null ||
        request.searchParams.get("phase_rad") === phaseRad),
  );
}

async function inspectorDebugSnapshot() {
  const inspector = page.locator(".fm-inspector");
  const text =
    (await inspector.count()) > 0
      ? await inspector.textContent({ timeout: 1_000 }).catch((error) =>
          error instanceof Error ? error.message : String(error),
        )
      : "inspector not mounted";
  const panel = inspector.locator(".fm-inspector-panel").first();
  const attrs =
    (await panel.count()) > 0
      ? await panel.evaluate((node) => {
          const element = node instanceof HTMLElement ? node : null;
          return {
            sceneRevision: element?.dataset.sceneRevision ?? null,
            sceneStageCount: element?.dataset.sceneStageCount ?? null,
            sceneStatus: element?.dataset.sceneStatus ?? null,
            stageDraftCount: element?.dataset.stageDraftCount ?? null,
          };
        }).catch((error) => ({
          error: error instanceof Error ? error.message : String(error),
        }))
      : { mounted: false };
  const selectedRows = await page
    .locator('.fm-explorer [aria-selected="true"]')
    .evaluateAll((nodes) =>
      nodes.map((node) =>
        node instanceof HTMLElement
          ? {
              nodeId: node.dataset.nodeId ?? null,
              text: node.textContent?.trim().slice(0, 200) ?? "",
            }
          : null,
      ),
    )
    .catch((error) => [
      { error: error instanceof Error ? error.message : String(error) },
    ]);
  return `Inspector attrs: ${JSON.stringify(attrs)}. Selected rows: ${JSON.stringify(selectedRows)}. Browser errors: ${JSON.stringify(errors)}. Failed responses: ${JSON.stringify(failedResponses)}. Inspector text: ${JSON.stringify(text?.slice(0, 3000))}`;
}

async function assertStableViewport3DCanvas() {
  const canvas = page.locator(".fm-viewport-3d canvas");
  await canvas.waitFor({ state: "visible", timeout: timeoutMs });
  const state = await canvas.evaluate((node) => {
    if (!(node instanceof HTMLCanvasElement)) {
      return {
        drawingBufferHeight: 0,
        drawingBufferWidth: 0,
        hasContext: false,
        isContextLost: true,
      };
    }
    const context = node.getContext("webgl2") ?? node.getContext("webgl");
    return {
      drawingBufferHeight: context?.drawingBufferHeight ?? 0,
      drawingBufferWidth: context?.drawingBufferWidth ?? 0,
      hasContext: Boolean(context),
      isContextLost: context?.isContextLost() ?? true,
    };
  });
  if (
    !state.hasContext ||
    state.isContextLost ||
    state.drawingBufferWidth <= 0 ||
    state.drawingBufferHeight <= 0
  ) {
    throw new Error(
      `Eigen-mode overlay left an invalid viewport canvas: ${JSON.stringify(state)}`,
    );
  }
}

function sessionStatus() {
  return {
    api_contract_version: "1.0.0",
    capabilities: {
      active_lane: {
        schema_version: "active-lane-capabilities.v2",
        authored: {
          backend: "fem",
          discretization: "fem",
          device: "gpu",
          precision: "double",
          mode: "strict",
        },
        requested: {
          backend: "fem",
          discretization: "fem",
          device: "gpu",
          precision: "double",
          mode: "strict",
        },
        resolved: {
          backend: "fem",
          discretization: "fem",
          device: "cpu",
          precision: "double",
          mode: "strict",
        },
        source: {
          kind: "planner",
          capability_profile_version: "study-authoring-smoke",
          engine_id: "fem_cpu_native",
          authored_intent: "study-authoring-fixture",
          effective_request: "study-authoring-fixture",
        },
        qualification: {
          status: "not_asserted",
          reason: "UI authoring fixture.",
        },
        operations: {
          "study.relaxation": {
            state: "supported",
            reason_code: "capability_supported",
            reason: "Relaxation authoring is available in the fixture lane.",
            requires: [],
          },
          "study.time_integration": {
            state: "supported",
            reason_code: "capability_supported",
            reason: "Time integration authoring is available in the fixture lane.",
            requires: [],
          },
          "study.eigenmodes": {
            state: "supported",
            reason_code: "capability_supported",
            reason: "Eigenmode authoring is available in the fixture lane.",
            requires: [],
          },
          "study.frequency_response": {
            state: "supported",
            reason_code: "capability_supported",
            reason: "Frequency-response authoring is available in the fixture lane.",
            requires: [],
          },
          "study.fft": {
            state: "supported",
            reason_code: "capability_supported",
            reason: "FFT authoring is available in the fixture lane.",
            requires: [],
          },
        },
      },
      algorithms_available: [
        "llg_overdamped",
        "projected_gradient_bb",
        "nonlinear_cg",
      ],
      binary_fields: true,
      cell_fields: true,
      eigen_modes: true,
      explicit_topology: false,
      gpu_telemetry: false,
      node_fields: true,
      preview_2d: true,
      preview_3d: true,
      scalar_history: true,
      structured_grid: false,
    },
    display: {
      active_quantity_id: "m",
      auto_contrast: true,
      colormap: "viridis",
      contrast_max: null,
      contrast_min: null,
      field_component: "magnitude",
      max_points: 1000,
      slice_layer: 0,
      slice_mode: "xy",
      vector_density: 1,
      vector_glyphs: true,
      view_mode: "3d",
      x_chosen_size: 1,
      y_chosen_size: 1,
    },
    domain: {
      cell_count: 0,
      discretization: "fem",
      generation_id: 0,
    },
    energies: {},
    metrics: {
      steps_per_second: null,
      total: {
        steps: 0,
        time_seconds: 0,
      },
      total_steps: 0,
      uptime_seconds: 0,
    },
    resources: {
      artifact_revision: 0,
      artifacts_revision: 0,
      command_completion_revision: 0,
      commands_revision: sceneRevision,
      display_revision: 0,
      domain_generation_id: 0,
      engine_log_revision: 0,
      field_catalog_revision: 0,
      field_revision: 0,
      fields_revision: 0,
      mesh_build_revision: 0,
      mesh_revision: 0,
      scalars_revision: 0,
      scene_revision: sceneRevision,
      slice_revision: 0,
      solver_profile_revision: 0,
      stages_revision: sceneRevision,
      topology_revision: 0,
      visualization_state_revision: 0,
      workspace_revision: 0,
    },
    run: currentRun(),
    runtime_bundle_version: "smoke",
    session: {
      created_at: "2026-06-02T00:00:00.000Z",
      name: "Study authoring smoke",
      session_id: "study-authoring-smoke",
      workspace_root: "/tmp/fullmag-study-authoring-smoke",
    },
    solver: {
      state: "idle",
    },
  };
}

function objectMetrics(objectId) {
  return {
    energies: {
      anisotropy: 0,
      demag: 0,
      dmi: 0,
      exchange: 0,
      total: 0,
      zeeman: 0,
    },
    has_solver_sample: false,
    magnetization_average: {
      mx: 1,
      my: 0,
      mz: 0,
    },
    object_id: objectId,
    revision: sceneRevision,
    source: "fixture",
    step: 0,
    time_seconds: 0,
  };
}

function stageExecution() {
  const relaxCompleted = sceneRevision === 1;
  return {
    active_stage_index: null,
    active_stage_kind: null,
    completed_stage_indexes: relaxCompleted ? [0] : [],
    revision: sceneRevision,
    runtime_state: "idle",
    stage_statuses: scene.study.stages.map((_, index) =>
      index === 0 ? (relaxCompleted ? "completed" : "failed") : "queued",
    ),
    stages: scene.study.stages.map((stage, index) => ({
      converged: index === 0 ? relaxCompleted : false,
      index,
      kind: stage.kind,
      metric_kind: index === 0 ? "max_torque_apm" : undefined,
      metric_name: index === 0 ? "max_torque_apm" : undefined,
      metric_unit: index === 0 ? "A/m" : undefined,
      metric_value: index === 0 ? 7.5e-5 : undefined,
      reason:
        index === 0
          ? relaxCompleted
            ? "torque"
            : "numerical_stagnation"
          : undefined,
      stage_id: stage.stage_id ?? `stage-${index + 1}`,
      status:
        index === 0 ? (relaxCompleted ? "completed" : "failed") : "queued",
      threshold: index === 0 ? 1e-4 : undefined,
    })),
    total_stages: scene.study.stages.length,
  };
}

function solverStatus() {
  const relaxCompleted = sceneRevision === 1;
  return {
    can_accept_commands: true,
    is_busy: false,
    converged: relaxCompleted,
    max_rhs_norm_per_s: 2.5e8,
    max_torque_Apm: 7.5e-5,
    max_torque_T: 999,
    revision: sceneRevision,
    runtime_state: "idle",
    runtime_status_code: "idle",
    runtime_status_kind: "idle",
    session_status: "ready",
    sim_time_seconds: 0,
    step_index: 0,
    warnings: [],
  };
}

function currentRun() {
  return {
    active_stage_index: null,
    active_stage_kind: null,
    artifact_dir: "/tmp/fullmag-study-authoring-smoke/artifacts/run-1",
    final_anisotropy_energy: null,
    final_demag_energy: null,
    final_dmi_energy: null,
    final_exchange_energy: null,
    final_total_energy: null,
    final_zeeman_energy: null,
    requested_backend: "fem",
    requested_device: "gpu",
    requested_mode: "auto",
    requested_precision: "double",
    resolved_backend: "fem",
    resolved_device: "cpu",
    resolved_engine_id: "fem_cpu_native",
    resolved_fallback: {
      occurred: true,
      fallback_engine: "fem_cpu_native",
      message: "Native FEM GPU runtime unavailable; resolved to CPU native.",
      original_engine: "fem_native_gpu",
      reason: "native_fem_gpu_unavailable",
    },
    resolved_mode: "auto",
    resolved_precision: "double",
    resolved_runtime_family: "fem-cpu-native",
    resolved_worker: null,
    revision: sceneRevision,
    run_id: "study-authoring-smoke-run",
    session_id: "study-authoring-smoke",
    solver_time_seconds: 0,
    started_at: "2026-06-03T00:00:00.000Z",
    status: "idle",
    status_reason: null,
    total_stages: scene.study.stages.length,
    total_steps: 0,
  };
}

function visualizationState() {
  return {
    active_quantity_id: "m",
    auto_contrast: true,
    camera: {
      fov_degrees: 45,
      orthographic_scale: null,
      position: [0, 0, 1],
      projection: "perspective",
      target: [0, 0, 0],
      up: [0, 1, 0],
    },
    clip: {
      axis: "x",
      enabled: false,
      flipped: false,
      position_percent: 50,
    },
    colormap: "viridis",
    contrast_max: null,
    contrast_min: null,
    diagnostics: {
      degraded_reasons: [],
      warnings: [],
    },
    domains: {
      active_scope: {
        object_id: null,
        part_id: null,
        scope: "full",
      },
      topology_mode: "auto",
      volume_edges_budget: 100000,
    },
    fdm: {
      x_chosen_size: 0,
      y_chosen_size: 0,
    },
    fem: {},
    field_component: "magnitude",
    layers: {
      airbox: {
        render_mode: "wireframe",
        show_airbox: false,
        show_airbox_vectors: false,
      },
      bounds: {
        visible: false,
      },
      points: {
        visible: false,
      },
      primitives: {
        visible: true,
      },
      quantity: {
        visible: true,
      },
      surface: {
        opacity: 1,
        visible: true,
      },
      vectors: {
        density: 50,
        domain: "auto",
        visible: false,
      },
      wireframe: {
        visible: false,
      },
    },
    max_points: 16384,
    overrides: [],
    quantity: {
      active_quantity_id: "m",
      auto_contrast: true,
      colormap: "viridis",
      component: "magnitude",
      contrast_max: null,
      contrast_min: null,
      field_component: "magnitude",
    },
    revision: sceneRevision,
    sampling: {
      max_bytes: null,
      max_glyphs: 16384,
      max_points: 16384,
      profile: "balanced",
      progressive: true,
    },
    schema_version: 5,
    slice: {
      axis: "z",
      auto_contrast: true,
      colormap: "viridis",
      component: "magnitude",
      layer_index: 0,
      mode: "single",
      position_percent: 50,
      projection_include_air_as_zero: false,
      projection_reduction: "mean_occupied",
      projection_resolution: 128,
      projection_samples: 32,
      quantity_id: "m",
      render_mode: "heatmap",
      show_airbox: false,
      show_magnetic_texture: true,
      show_mesh: false,
      show_primitives: true,
      show_quantity: true,
      show_vectors: false,
      thickness_percent: null,
    },
    slice_layer: 0,
    slice_mode: "single",
    targets: {
      airbox: {
        label: "Airbox",
        scope: "airbox",
        scope_id: "airbox",
        settings: {
          active_quantity_id: "m",
          bounds_visible: false,
          geometry_scope: "full",
          opacity: 0.28,
          points_visible: false,
          render_mode: "wireframe",
          surface_color_source: "solid",
          surface_visible: false,
          vector_alpha: 1,
          vector_color_mode: "orientation",
          vector_mono_color: "#00c2ff",
          vector_thickness: 1,
          vectors_visible: false,
          visible: true,
          wireframe_color: "#94a3b8",
          wireframe_opacity: 1,
          wireframe_visible: true,
        },
        source: "airbox",
      },
      objects: [],
      parts: [],
    },
    trim: {
      axes: {
        x: { enabled: false, max_percent: 100, min_percent: 0 },
        y: { enabled: false, max_percent: 100, min_percent: 0 },
        z: { enabled: false, max_percent: 100, min_percent: 0 },
      },
      enabled: false,
    },
    vector_density: 50,
    vector_glyphs: false,
    vector_style: {
      alpha: 1,
      color_mode: "orientation",
      ferromagnet_visibility: "hide",
      length_scale: 1,
      mono_color: "#00c2ff",
      thickness: 1,
    },
    view_mode: "3d",
    x_chosen_size: 0,
    y_chosen_size: 0,
  };
}

function applyMergePatch(target, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete target[key];
      continue;
    }
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      applyMergePatch(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

async function waitForTransactionCount(count) {
  const deadline = Date.now() + timeoutMs;
  while (transactions.length < count && Date.now() < deadline) {
    await page.waitForTimeout(50);
  }
  if (transactions.length < count) {
    throw new Error(
      `Expected ${count} transactions, saw ${transactions.length}. Diagnostics: ${JSON.stringify({
        inspectorTail: (await page.locator(".fm-inspector").textContent())?.slice(-2400),
        inspectorButtons: await page.locator(".fm-inspector button").evaluateAll((buttons) =>
          buttons.slice(-12).map((button) => ({
            disabled: button.hasAttribute("disabled"),
            label: button.textContent?.trim(),
            title: button.getAttribute("title"),
          })),
        ),
        errors: errors.slice(-5),
        failedResponses: failedResponses.slice(-5),
      })}`,
    );
  }
}

async function assertStatusBarFallbackReadback() {
  const engine = page.locator(".fm-status-bar__engine");
  await engine.waitFor({ state: "visible", timeout: timeoutMs });
  await engine
    .getByText("FEM CPU", { exact: true })
    .waitFor({ state: "visible", timeout: timeoutMs });
  await engine
    .getByText("fallback to native MFEM/hypre")
    .waitFor({ state: "visible", timeout: timeoutMs });

  const title = await engine.getAttribute("title");
  for (const expected of [
    "requested_backend=fem",
    "requested_device=gpu",
    "resolved_engine_id=fem_cpu_native",
    "original_engine=fem_native_gpu",
    "fallback_engine=fem_cpu_native",
    "reason=native_fem_gpu_unavailable",
  ]) {
    if (!title?.includes(expected)) {
      throw new Error(
        `Status bar fallback title is missing ${expected}: ${JSON.stringify(title)}`,
      );
    }
  }
}

function assertGlobalTransaction(transaction) {
  const study = transaction?.merge_patch?.study;
  if (transaction?.kind !== "merge_patch" || !study) {
    throw new Error("Global settings did not commit a study merge patch.");
  }
  if (study.requested_cpu_threads !== 16) {
    throw new Error("Global settings did not serialize requested_cpu_threads.");
  }
  if (study.solver?.integrator !== "rk45") {
    throw new Error("Global settings did not serialize solver JSON.");
  }
  if (study.fem_demag_solver_policy?.linear_solver !== "gmres") {
    throw new Error("Global settings did not serialize FEM demag policy JSON.");
  }
}

function assertStageTransaction(transaction) {
  const stages = transaction?.merge_patch?.study?.stages;
  if (!Array.isArray(stages) || stages.length !== 2) {
    throw new Error(
      `Stage save did not commit exactly two study stages: ${JSON.stringify(stages)}`,
    );
  }
  const [relax, run] = stages;
  if (
    relax.entrypoint_kind !== "flat_relax" ||
    relax.algorithm !== "llg_overdamped" ||
    relax.integrator !== "rk23" ||
    relax.fixed_timestep !== 1e-13 ||
    relax.torque_tolerance_apm !== 1e-6 ||
    relax.relax_algorithm !== undefined ||
    relax.torque_tolerance !== undefined
  ) {
    throw new Error("Relax stage did not serialize the canonical payload.");
  }
  if (
    run.kind !== "run" ||
    run.entrypoint_kind !== "flat_run" ||
    run.until_seconds !== 2e-9
  ) {
    throw new Error("Run stage did not serialize the expected payload.");
  }
}

function summarizeFixtureRequests() {
  const counts = new Map();
  for (const request of fixtureRequests) {
    counts.set(request, (counts.get(request) ?? 0) + 1);
  }
  return [...counts.entries()].map(([request, count]) => `${request} x${count}`);
}
