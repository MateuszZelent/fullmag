const workspaceUrl =
  process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const timeoutMs = Number(
  process.env.CONTROL_ROOM_STUDY_AUTHORING_SMOKE_TIMEOUT_MS ?? 60_000,
);
const frequencyOnly =
  process.env.CONTROL_ROOM_STUDY_AUTHORING_SMOKE_FREQUENCY_ONLY === "1";

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
    solver: { integrator: "rk23" },
    stages: [
      {
        algorithm: "llg_overdamped",
        entrypoint_kind: "flat_relax",
        fixed_timestep: "",
        integrator: "rk23",
        kind: "relax",
        max_steps: 50000,
        relax_algorithm: "llg_overdamped",
        solver: "rk23",
        stage_id: "relax-1",
        torque_tolerance: 1e-6,
      },
    ],
  },
  universe: null,
};

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
page.on("pageerror", (error) => errors.push(error.message));
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
  await page
    .locator('[data-node-id="model:study"]')
    .waitFor({ state: "visible", timeout: timeoutMs });
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

  await page.getByLabel("CPU threads").fill("16");
  await page
    .getByRole("textbox", { name: "Solver" })
    .fill('{"integrator":"rk45"}');
  await page
    .getByLabel("FEM demag policy")
    .fill('{"linear_solver":"gmres","tolerance":1e-9}');
  await page.getByRole("button", { name: /Save globals/i }).click();
  await waitForTransactionCount(1);

  const inspector = page.locator(".fm-inspector");
  await inspector
    .getByTestId("study-stage-authoring-toolbar")
    .getByRole("button", { name: /^Run$/i })
    .click();
  try {
    await inspector.getByRole("button", { name: /Save stages/i }).click();
  } catch (error) {
    const inspectorText = await inspector.textContent();
    const toolbarText = await inspector
      .getByTestId("study-stage-authoring-toolbar")
      .textContent()
      .catch((toolbarError) =>
        toolbarError instanceof Error ? toolbarError.message : String(toolbarError),
      );
    throw new Error(
      `Save stages button was not available after adding Run. Toolbar text: ${JSON.stringify(toolbarText)}. Inspector text: ${JSON.stringify(inspectorText?.slice(0, 3000))}. ${error}`,
    );
  }
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
  await inspector.getByLabel("Until").fill("2e-9");
  await inspector.getByRole("button", { name: /Save stage/i }).click();
  await waitForTransactionCount(3);

  assertGlobalTransaction(transactions[0]);
  assertStageTransaction(transactions[2]);
  if (frequencyOnly) {
    await addFrequencyResponseAndEditExcitation(3);
    await verifyFrequencyDomainModalResults();
    await verifyFrequencyDomainResponseResults();
  } else {
    await addHysteresisFromRibbon();
    await addEigenmodesAndEditKPath(4);
    await addEigenmodesAndEditFrequencyWindow(5);
    await addFrequencyResponseAndEditExcitation(6);
    await createObjectRegionAndAssertScriptSync();
  }

  if (errors.length > 0) {
    throw new Error(`Browser errors:\n${errors.join("\n")}`);
  }

  console.log(
    `Study authoring UI smoke passed at ${workspaceUrl} with ${transactions.length} model transactions and ${scriptSyncs.length} authoring script syncs.`,
  );
} finally {
  await browser.close();
}

function resourceForPath(pathname) {
  if (pathname === "/v2/sessions/current/status") return sessionStatus();
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

async function verifyFrequencyDomainModalResults() {
  const resultsTab = page
    .locator(".fm-explorer .fm-tabs-trigger")
    .filter({ hasText: /^Results$/ });
  await resultsTab.click();
  await expandExplorerNode("results:root");
  await expandExplorerNode("results:frequency-domain");
  await expandExplorerNode("results:frequency-domain:fmr");

  const modalSpectrumNode = page.locator(
    '[data-node-id="results:frequency-domain:fmr:modal-spectrum"]',
  );
  await modalSpectrumNode.waitFor({ state: "visible", timeout: timeoutMs });
  await clickExplorerRow(modalSpectrumNode);

  const inspector = page.locator(".fm-inspector");
  await inspector
    .locator('[data-inspector-surface="fmr-modal-spectrum"]')
    .waitFor({ state: "visible", timeout: timeoutMs });
  await inspector.getByRole("heading", {
    exact: true,
    name: "FMR Modal Spectrum Control",
  }).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await inspector.getByRole("heading", {
    exact: true,
    name: "FMR Modal Spectrum Chart",
  }).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await inspector
    .locator(".fm-frequency-domain-chart canvas")
    .waitFor({ state: "visible", timeout: timeoutMs });

  const modeButton = inspector.getByRole("button", {
    name: "Select mode 2 at 12.5 GHz",
  });
  await modeButton.waitFor({ state: "visible", timeout: timeoutMs });
  await modeButton.click();

  await inspector
    .locator('[data-inspector-surface="eigen-mode"]')
    .waitFor({ state: "visible", timeout: timeoutMs });
  await inspector.getByRole("heading", {
    exact: true,
    name: "Eigen Mode Control",
  }).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await inspector.getByRole("heading", {
    exact: true,
    name: "Eigen Mode 3D Visualization",
  }).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await inspector
    .getByText("analysis:eigen:sample-0000:mode-0002", { exact: true })
    .first()
    .waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
  const plotButton = inspector.getByRole("button", {
    exact: true,
    name: "Plot selected eigen mode with phase-rotated real display",
  });
  await plotButton.waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  if (!(await plotButton.isEnabled())) {
    throw new Error("Selected eigen mode 3D visualization button is disabled.");
  }
  const plotButtonClass = await plotButton.getAttribute("class");
  if (!plotButtonClass?.split(/\s+/).includes("fm-button")) {
    throw new Error(
      `Selected eigen mode visualization is not a shared shadcn Button: ${plotButtonClass}`,
    );
  }
  await plotButton.click();
  await waitForEigenModeFieldVectorRequest();
  await assertStableViewport3DCanvas();

  const imagButton = inspector.getByRole("button", {
    exact: true,
    name: "Plot selected eigen mode imaginary component",
  });
  await imagButton.waitFor({ state: "visible", timeout: timeoutMs });
  if (!(await imagButton.isEnabled())) {
    throw new Error("Selected eigen mode Imag visualization button is disabled.");
  }
  await imagButton.click();
  await waitForEigenModeFieldVectorRequest("imag");
  await assertStableViewport3DCanvas();
}

async function verifyFrequencyDomainResponseResults() {
  await expandExplorerNode("results:frequency-domain:fmr");
  const responseSweepNode = page.locator(
    '[data-node-id="results:frequency-domain:fmr:response-sweep"]',
  );
  await responseSweepNode.waitFor({ state: "visible", timeout: timeoutMs });
  await clickExplorerRow(responseSweepNode);

  const inspector = page.locator(".fm-inspector");
  await inspector
    .locator('[data-inspector-surface="fmr-response-sweep"]')
    .waitFor({ state: "visible", timeout: timeoutMs });
  await inspector.locator("h2", {
    hasText: "FMR Response Sweep",
  }).waitFor({ state: "visible", timeout: timeoutMs });
  await inspector
    .locator(".fm-frequency-domain-chart canvas")
    .waitFor({ state: "visible", timeout: timeoutMs });

  const responseCard = inspector
    .locator('article.fm-frequency-domain-response-card[data-status="ready"]')
    .filter({ hasText: "12.55 GHz" });
  await responseCard.waitFor({ state: "visible", timeout: timeoutMs });
  const plotButton = responseCard.getByRole("button", {
    exact: true,
    name: "Plot 3D",
  });
  await plotButton.waitFor({ state: "visible", timeout: timeoutMs });
  if (!(await plotButton.isEnabled())) {
    throw new Error("FMR response field 3D visualization button is disabled.");
  }
  const plotButtonClass = await plotButton.getAttribute("class");
  if (!plotButtonClass?.split(/\s+/).includes("fm-button")) {
    throw new Error(
      `FMR response field visualization is not a shared shadcn Button: ${plotButtonClass}`,
    );
  }
  await plotButton.click();
  await waitForFrequencyResponseFieldVectorRequest();
  await assertStableViewport3DCanvas();

  const inspectButton = responseCard.getByRole("button", {
    exact: true,
    name: "Inspect",
  });
  await inspectButton.waitFor({ state: "visible", timeout: timeoutMs });
  await inspectButton.click();
  await inspector
    .locator('[data-inspector-surface="frequency-response-point"]')
    .waitFor({ state: "visible", timeout: timeoutMs });
  const realButton = inspector.getByRole("button", {
    exact: true,
    name: "Plot response field real component",
  });
  await realButton.waitFor({ state: "visible", timeout: timeoutMs });
  if (!(await realButton.isEnabled())) {
    throw new Error("Selected response point Real visualization button is disabled.");
  }
  await realButton.click();
  await waitForFrequencyResponseFieldVectorRequest("real");
  await assertStableViewport3DCanvas();
}

async function expandExplorerNode(nodeId) {
  const node = page.locator(`[data-node-id="${nodeId}"]`);
  await node.waitFor({ state: "visible", timeout: timeoutMs });
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
  await inspector.getByLabel("Name").fill(regionName);
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
  await inspector.getByLabel("k path", { exact: true }).fill(kPath);
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
  await inspector.getByText(kPath, { exact: true }).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
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
    .getByLabel("Operator", { exact: true })
    .selectOption("full_2x2");
  await inspector
    .getByLabel("Target", { exact: true })
    .selectOption("frequency_window");
  await inspector.getByLabel("Frequency min", { exact: true }).fill("1.5e9");
  await inspector.getByLabel("Frequency max", { exact: true }).fill("2.5e9");
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
    .getByLabel("Target", { exact: true })
    .inputValue();
  const savedFrequencyMin = await inspector
    .getByLabel("Frequency min", { exact: true })
    .inputValue();
  const savedFrequencyMax = await inspector
    .getByLabel("Frequency max", { exact: true })
    .inputValue();
  const savedOperator = await inspector
    .getByLabel("Operator", { exact: true })
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
  await inspector.getByLabel("Excitation", { exact: true }).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await inspector.getByLabel("Excitation phase", { exact: true }).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  if (await inspector.getByLabel("Frequencies").isVisible().catch(() => false)) {
    throw new Error("Excitation inspector leaked frequency-sweep controls.");
  }
  if (await inspector.getByLabel("k sampling").isVisible().catch(() => false)) {
    throw new Error("Excitation inspector leaked k-sampling controls.");
  }

  await inspector.getByLabel("Excitation", { exact: true }).fill("1, 2, 3");
  await inspector
    .getByLabel("Excitation phase", { exact: true })
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
  await inspector.getByLabel("Calculation mode", { exact: true }).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  if (await inspector.getByLabel("Frequencies").isVisible().catch(() => false)) {
    throw new Error("Calculation-mode inspector leaked sweep controls.");
  }
  if (await inspector.getByLabel("Excitation").isVisible().catch(() => false)) {
    throw new Error("Calculation-mode inspector leaked excitation controls.");
  }
  await inspector
    .getByLabel("Calculation mode", { exact: true })
    .selectOption("response_map");
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
  await inspector.getByText("Hysteresis Points").waitFor({
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

async function waitForEigenModeFieldVectorRequest(
  view = "phase_rotated_real",
) {
  const deadline = Date.now() + timeoutMs;
  const phaseRad = view === "phase_rotated_real" ? "0" : null;
  let request = matchingFieldViewRequest(fieldVectorRequests, view, phaseRad);
  while (!request && Date.now() < deadline) {
    await page.waitForTimeout(50);
    request = matchingFieldViewRequest(fieldVectorRequests, view, phaseRad);
  }
  if (!request) {
    throw new Error(
      `Plot selected eigen mode ${view} display did not request the eigen-mode field.`,
    );
  }
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
      `Plot ${view} did not request the driven FMR response field.`,
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
      algorithms_available: [],
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
    run: null,
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
  return {
    active_stage_index: null,
    active_stage_kind: null,
    completed_stage_indexes: [],
    revision: sceneRevision,
    runtime_state: "idle",
    stage_statuses: scene.study.stages.map(() => "queued"),
    stages: scene.study.stages.map((stage, index) => ({
      index,
      kind: stage.kind,
      stage_id: stage.stage_id ?? `stage-${index + 1}`,
      status: "queued",
    })),
    total_stages: scene.study.stages.length,
  };
}

function solverStatus() {
  return {
    can_accept_commands: true,
    is_busy: false,
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
    throw new Error(`Expected ${count} transactions, saw ${transactions.length}.`);
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
    relax.integrator !== "rk23" ||
    relax.fixed_timestep !== ""
  ) {
    throw new Error("Relax stage did not serialize script-builder aliases.");
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
