const workspaceUrl =
  process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const timeoutMs = Number(
  process.env.CONTROL_ROOM_STUDY_AUTHORING_SMOKE_TIMEOUT_MS ?? 60_000,
);

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
    .locator('[data-node-id="model:study:stage:run-2"]')
    .waitFor({ state: "visible", timeout: timeoutMs });
  await page.locator('[data-node-id="model:study:stage:run-2"]').click();
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
  await createObjectRegionAndAssertScriptSync();

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

async function clickExplorerRow(row) {
  await row.evaluate((node) => {
    node.scrollIntoView({ block: "center", inline: "nearest" });
    if ("click" in node && typeof node.click === "function") {
      node.click();
    }
  });
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

function sessionStatus() {
  return {
    api_contract_version: "1.0.0",
    capabilities: {
      algorithms_available: [],
      binary_fields: false,
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
