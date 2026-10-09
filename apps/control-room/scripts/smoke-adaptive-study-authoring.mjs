import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const API_INSTANCE = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "adaptive-study-browser-fixture";
const SESSION_EPOCH = "adaptive-study-epoch";
const REQUEST_SCOPE_EPOCH = "adaptive-study-request-scope";
const SCENE_PATH = "/v2/sessions/current/model/scene";
const TRANSACTIONS_PATH = "/v2/sessions/current/model/transactions";
const PREPARATION_PATH = "/v2/sessions/current/simulation/preparation";
const EVENTS_PATH = "/v2/sessions/current/events/ws";
const API_INSTANCE_HEADER = "x-fullmag-api-instance";
const API_CONTRACT_VERSION_HEADER = "x-api-contract-version";
const workspaceUrl = process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:3100/workspace";
const reportDirectory = process.env.CONTROL_ROOM_INSPECTOR_REPORT_DIR;

if (!reportDirectory || !isAbsolute(reportDirectory)) {
  throw new Error("An absolute Inspector report directory is required.");
}

const reportRoot = resolve(reportDirectory);
const reportPath = resolve(reportRoot, "study-adaptive-authoring.json");

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    return await import("@playwright/test");
  }
}

function clone(value) {
  return structuredClone(value);
}

function makeScene(stage, revision) {
  return {
    revision,
    scene_revision: revision,
    objects: [
      {
        geometry: {
          geometry_kind: "Box",
          geometry_params: { size: [200e-9, 80e-9, 5e-9] },
        },
        id: "adaptive-film",
        magnetization_ref: null,
        material_ref: null,
        name: "Adaptive fixture film",
        region_name: "adaptive-film",
        regions: [],
        role: "magnet",
        physics_stack: [],
        tags: ["mesh:ready"],
        transform: {
          pivot: [0, 0, 0],
          rotation_quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
          translation: [0, 0, 0],
        },
      },
    ],
    materials: [],
    outputs: { items: [] },
    study: {
      demag_enabled: true,
      demag_realization: "auto",
      exchange_enabled: true,
      external_field: [0, 0, 0],
      fem_demag_solver_policy: null,
      parallel_execution: {
        mode: "serial",
        max_cpu_percent: 80,
        max_memory_percent: 80,
        memory_reserve_bytes: 0,
        max_workers: null,
        threads_per_worker: 1,
      },
      requested_backend: "fem",
      requested_cpu_threads: 4,
      requested_device: "cpu",
      requested_mode: "strict",
      requested_precision: "double",
      solver: {},
      stages: stage === null ? [] : [clone(stage)],
    },
    universe: {
      id: "universe",
      name: "Universe",
      size: [1e-6, 1e-6, 1e-6],
    },
  };
}

function makeActiveLaneCapabilities() {
  const supportedOperation = (reason) => ({
    reason,
    reason_code: "capability_supported",
    requires: ["discretization:fem", "device:cpu"],
    state: "supported",
  });
  const identity = {
    backend: "fem",
    discretization: "fem",
    device: "cpu",
    mode: "strict",
    precision: "double",
  };
  return {
    authored: { ...identity },
    operations: {
      "study.eigenmodes": supportedOperation(
        "The browser fixture admits the explicit FEM CPU Eigen authoring path.",
      ),
      "study.relaxation": supportedOperation(
        "The browser fixture admits the explicit FEM CPU Relax authoring path.",
      ),
      "study.time_integration": supportedOperation(
        "The browser fixture admits explicit FEM CPU time integration authoring.",
      ),
    },
    qualification: {
      reason: "This fixture checks UI authoring admission only; scientific qualification is not asserted.",
      status: "not_asserted",
    },
    requested: { ...identity },
    resolved: { ...identity },
    schema_version: "active-lane-capabilities.v2",
    source: {
      authored_intent: "problem_ir.runtime_selection",
      capability_profile_version: "adaptive-study-authoring-browser",
      effective_request: "session.runtime_resolution",
      engine_id: "fem_cpu_reference",
      kind: "fixture",
    },
  };
}

function makeStatus(revision) {
  return {
    api_contract_version: "1.0.0",
    capabilities: {
      active_lane: makeActiveLaneCapabilities(),
      algorithms_available: ["llg_overdamped"],
      binary_fields: false,
      cell_fields: false,
      eigen_modes: false,
      explicit_topology: false,
      gpu_telemetry: false,
      node_fields: false,
      preview_2d: false,
      preview_3d: false,
      scalar_history: false,
      structured_grid: false,
    },
    display: {
      active_quantity_id: "m",
      field_component: "magnitude",
      view_mode: "3d",
      vector_glyphs: false,
    },
    domain: {
      cell_count: 1,
      discretization: "fem",
      generation_id: 1,
    },
    energies: {},
    lifecycle: {
      commandability: "allowed",
      connectivity: "connected",
      session_resource: "active",
      solver: "idle",
    },
    metrics: {
      steps_per_second: null,
      total: { steps: 0, time_seconds: 0 },
      total_steps: 0,
      uptime_seconds: 1,
    },
    resources: {
      artifact_revision: 0,
      artifacts_revision: 0,
      command_completion_revision: 0,
      commands_revision: revision,
      display_revision: 0,
      domain_generation_id: 1,
      engine_log_revision: 0,
      field_catalog_revision: 0,
      field_revision: 0,
      fields_revision: 0,
      mesh_build_revision: 0,
      mesh_revision: 0,
      mode_composition_revision: 0,
      region_coefficients_revision: 0,
      region_initial_state_revision: 0,
      region_membership_revision: 0,
      region_topology_revision: 0,
      scalars_revision: 0,
      scene_revision: revision,
      // The idle fixture publishes no preparation document; revision zero
      // makes the optional preparation resource unavailable by contract.
      simulation_preparation_revision: 0,
      solver_profile_revision: 0,
      stages_revision: revision,
      topology_revision: 0,
      visualization_state_revision: 0,
      workspace_revision: 0,
    },
    run: null,
    runtime_bundle_version: "study-adaptive-authoring-browser-fixture",
    session: {
      created_at: "2026-10-09T00:00:00.000Z",
      name: "Adaptive Study browser fixture",
      request_scope_epoch: REQUEST_SCOPE_EPOCH,
      session_epoch: SESSION_EPOCH,
      session_id: SESSION_ID,
      workspace_root: "fixture://adaptive-study-authoring",
    },
    solver: { state: "idle" },
  };
}

async function fulfillJson(route, body, status = 200) {
  return route.fulfill({
    status,
    headers: {
      "content-type": "application/json",
      [API_INSTANCE_HEADER]: API_INSTANCE,
      [API_CONTRACT_VERSION_HEADER]: "1.0.0",
    },
    body: JSON.stringify(body),
  });
}

function makeFixture(stage) {
  return {
    scene: makeScene(stage, 1),
    requests: [],
    mutations: [],
    sceneReadRevisions: [],
    statusSnapshots: [],
    unknownGets: [],
    unknownMutations: [],
  };
}

async function openStudyInspector(browser, { id, stage, realtime = false }) {
  const fixture = makeFixture(stage);
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
  });
  const page = await context.newPage();
  const pageErrors = [];
  let resolveRealtimeSocket;
  const realtimeSocketReady = new Promise((resolveReady) => {
    resolveRealtimeSocket = resolveReady;
  });

  page.on("pageerror", (error) => {
    pageErrors.push(error.stack ?? error.message);
  });

  let targetUrl;
  try {
    targetUrl = new URL(workspaceUrl);
  } catch {
    throw new Error("CONTROL_ROOM_URL must be a valid workspace URL.");
  }
  targetUrl.searchParams.set("fullmag_api_instance", API_INSTANCE);
  if (realtime) targetUrl.searchParams.set("inspectorRealtimeFixture", "1");

  await page.addInitScript(
    (config) => {
      window.__FULLMAG_CONFIG__ = {
        ...(window.__FULLMAG_CONFIG__ ?? {}),
        controlRoomApiBase: config.controlRoomApiBase,
        disableRealtime: config.disableRealtime,
        enableDiagnosticRecorder: true,
      };
    },
    {
      controlRoomApiBase: targetUrl.origin,
      disableRealtime: !realtime,
    },
  );

  if (realtime) {
    await page.routeWebSocket(
      (url) => new URL(url).pathname === EVENTS_PATH,
      (websocket) => {
        assert(
          websocket.protocols().includes("fullmag.live.v1"),
          "The realtime fixture did not negotiate fullmag.live.v1.",
        );
        resolveRealtimeSocket(websocket);
      },
    );
  }

  await page.route("**/v2/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    let body = null;
    if (method === "POST" || method === "PATCH" || method === "PUT") {
      try {
        body = request.postDataJSON();
      } catch {
        body = null;
      }
    }
    fixture.requests.push({
      body: clone(body),
      method,
      path,
      sessionScope: request.headers()["x-fullmag-session-scope"] ?? null,
    });

    if (method === "OPTIONS") {
      return route.fulfill({ status: 204 });
    }
    if (method === "GET" && path === "/v2/sessions") {
      return fulfillJson(route, {
        schema_version: "2.0.0",
        sessions: [
          {
            current: true,
            name: "Adaptive Study browser fixture",
            session_id: SESSION_ID,
            status: "active",
          },
        ],
      });
    }
    if (method === "GET" && path === "/v2/platform/health") {
      return fulfillJson(route, {
        active_session: true,
        api_contract_version: "1.0.0",
        status: "ok",
        uptime_seconds: 1,
      });
    }
    if (method === "GET" && path === "/v2/sessions/current/status") {
      const status = makeStatus(fixture.scene.revision);
      fixture.statusSnapshots.push({
        request_scope_epoch: status.session.request_scope_epoch,
        session_epoch: status.session.session_epoch,
        session_id: status.session.session_id,
        simulation_preparation_revision:
          status.resources.simulation_preparation_revision,
        solver_state: status.solver.state,
      });
      return fulfillJson(route, status);
    }
    if (method === "GET" && path === SCENE_PATH) {
      fixture.sceneReadRevisions.push(fixture.scene.revision);
      return fulfillJson(route, clone(fixture.scene));
    }
    if (method === "POST" && path === TRANSACTIONS_PATH) {
      fixture.mutations.push(clone(body));
      if (
        !body ||
        body.kind !== "merge_patch" ||
        body.base_revision !== fixture.scene.revision ||
        !body.merge_patch ||
        typeof body.merge_patch !== "object"
      ) {
        return fulfillJson(
          route,
          { code: "fixture_scene_revision_conflict", message: "The scene changed." },
          409,
        );
      }
      const studyPatch = body.merge_patch.study ?? {};
      fixture.scene = {
        ...fixture.scene,
        revision: fixture.scene.revision + 1,
        scene_revision: fixture.scene.revision + 1,
        study: { ...fixture.scene.study, ...clone(studyPatch) },
      };
      return fulfillJson(route, {
        committed_scene: clone(fixture.scene),
        scene_revision: fixture.scene.revision,
        transaction_kind: body.kind,
      });
    }
    if (method !== "GET") {
      fixture.unknownMutations.push(method + " " + path);
      return fulfillJson(
        route,
        { code: "fixture_mutation_not_available", message: "Unexpected fixture mutation." },
        405,
      );
    }
    fixture.unknownGets.push(path);
    return fulfillJson(
      route,
      { code: "fixture_resource_not_available", message: "Resource omitted by this bounded fixture." },
      404,
    );
  });

  await page.goto(targetUrl.href, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  await page.locator(".fm-inspector").waitFor({
    state: "visible",
    timeout: 60_000,
  });

  const modelTab = page
    .locator(".fm-explorer .fm-tabs-trigger")
    .filter({ hasText: /^Model$/ });
  if (
    (await modelTab.count()) > 0 &&
    (await modelTab.getAttribute("aria-selected")) !== "true"
  ) {
    await modelTab.click();
  }
  const studyNode = page.locator('[data-node-id="model:study"]').first();
  await studyNode.waitFor({ state: "visible", timeout: 60_000 });
  await studyNode.click();

  const inspector = page.locator(".fm-inspector").first();
  await inspector
    .getByRole("heading", { name: "Global Study Settings", exact: true })
    .waitFor({ state: "visible", timeout: 60_000 });
  await page.locator(".fm-simulation-startup").waitFor({
    state: "detached",
    timeout: 30_000,
  });
  assert.equal(
    await page.locator(".fm-simulation-startup").count(),
    0,
    "The real session-status and startup-readiness resources did not clear the startup overlay.",
  );
  assert(
    fixture.requests.some(
      (request) => request.method === "GET" && request.path === "/v2/sessions",
    ),
    "The production session-collection readiness resource was not read.",
  );
  assert(
    fixture.requests.some(
      (request) => request.method === "GET" && request.path === "/v2/sessions/current/status",
    ),
    "The production status readiness resource was not read.",
  );
  assert(
    fixture.requests.some(
      (request) => request.method === "GET" && request.path === SCENE_PATH,
    ),
    "The production canonical scene resource was not read.",
  );
  assert.equal(fixture.statusSnapshots.at(-1)?.session_id, SESSION_ID);
  assert.equal(fixture.statusSnapshots.at(-1)?.session_epoch, SESSION_EPOCH);
  assert.equal(
    fixture.statusSnapshots.at(-1)?.request_scope_epoch,
    REQUEST_SCOPE_EPOCH,
  );
  assert.equal(
    fixture.statusSnapshots.at(-1)?.simulation_preparation_revision,
    0,
  );
  assert.equal(fixture.statusSnapshots.at(-1)?.solver_state, "idle");
  assert.equal(
    fixture.requests.some(
      (request) => request.method === "GET" && request.path === PREPARATION_PATH,
    ),
    false,
    "An idle session with preparation revision 0 must not request an unadvertised preparation resource.",
  );

  return {
    context,
    fixture,
    id,
    inspector,
    page,
    pageErrors,
    realtimeSocketReady,
  };
}

async function prepareAdaptiveDraft(scenario) {
  const mode = scenario.page.getByRole("combobox", {
    name: "Independent k points",
    exact: true,
  });
  const maxCpu = scenario.page.getByLabel("Maximum CPU target (%)");
  await mode.selectOption("adaptive");
  await maxCpu.fill("73");
  return { mode, maxCpu };
}

function visibleValidationText(page) {
  return page.locator(".fm-inspector-validation-list li").allTextContents();
}

async function waitForRealtimeSocket(scenario) {
  let timeoutId = null;
  try {
    return await Promise.race([
      scenario.realtimeSocketReady,
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Study Inspector realtime fixture did not connect.")),
          30_000,
        );
      }),
    ]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

async function runRejectedCase(browser, testCase) {
  const scenario = await openStudyInspector(browser, {
    id: testCase.id,
    stage: testCase.stage,
  });
  try {
    const panelHandle = await scenario.inspector.elementHandle();
    const { mode } = await prepareAdaptiveDraft(scenario);
    const validation = scenario.page.locator(".fm-inspector-validation-list li");
    await validation.first().waitFor({ state: "visible", timeout: 15_000 });
    const messages = await visibleValidationText(scenario.page);
    assert(
      messages.some((message) => message.includes(testCase.expected)),
      testCase.id + " did not show the expected adaptive workflow rejection: " + messages.join(" | "),
    );
    assert.equal(await mode.inputValue(), "adaptive");
    assert.equal(
      await scenario.page.getByRole("button", { name: "Save globals", exact: true }).isDisabled(),
      true,
      testCase.id + " left Save globals enabled for an unsupported workflow.",
    );
    assert.equal(
      await scenario.page.evaluate(
        (panel) => panel.isConnected && document.querySelector(".fm-inspector") === panel,
        panelHandle,
      ),
      true,
      testCase.id + " replaced the mounted Inspector while showing its rejection.",
    );
    assert.equal(scenario.fixture.mutations.length, 0);
    assert.deepEqual(scenario.fixture.unknownMutations, []);
    assert.deepEqual(scenario.pageErrors, []);
    return {
      id: testCase.id,
      messages,
      mutation_count: scenario.fixture.mutations.length,
      save_disabled: true,
      visible_rejection: true,
    };
  } finally {
    await scenario.context.close();
  }
}

async function runLegalSaveCase(browser, testCase) {
  const scenario = await openStudyInspector(browser, {
    id: testCase.id,
    stage: testCase.stage,
  });
  try {
    const { mode } = await prepareAdaptiveDraft(scenario);
    const validation = scenario.page.locator(".fm-inspector-validation-list li");
    assert.equal(
      await validation.count(),
      0,
      testCase.id + " unexpectedly rejected a supported CPU workflow: " +
        (await visibleValidationText(scenario.page)).join(" | "),
    );
    assert.equal(await mode.inputValue(), "adaptive");
    const save = scenario.page.getByRole("button", {
      name: "Save globals",
      exact: true,
    });
    assert.equal(await save.isEnabled(), true);

    const responsePromise = scenario.page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === TRANSACTIONS_PATH,
      { timeout: 30_000 },
    );
    await save.click();
    const response = await responsePromise;
    assert.equal(response.status(), 200);
    assert.equal(scenario.fixture.mutations.length, 1);

    const transaction = scenario.fixture.mutations[0];
    assert.equal(transaction.kind, "merge_patch");
    assert.equal(transaction.base_revision, 1);
    assert.equal(
      scenario.fixture.requests.filter(
        (request) => request.method === "POST" && request.path === TRANSACTIONS_PATH,
      ).length,
      1,
    );
    assert.equal(
      transaction.merge_patch.study.parallel_execution.mode,
      "adaptive",
    );
    assert.equal(transaction.merge_patch.study.requested_device, "cpu");
    assert.equal("stages" in transaction.merge_patch.study, false);
    assert.equal(scenario.fixture.scene.revision, 2);
    assert.deepEqual(scenario.fixture.unknownMutations, []);
    assert.deepEqual(scenario.pageErrors, []);

    return {
      id: testCase.id,
      base_revision: transaction.base_revision,
      mutation_count: scenario.fixture.mutations.length,
      parallel_mode: transaction.merge_patch.study.parallel_execution.mode,
      requested_device: transaction.merge_patch.study.requested_device,
      response_status: response.status(),
    };
  } finally {
    await scenario.context.close();
  }
}

async function runStaleSceneCase(browser) {
  const scenario = await openStudyInspector(browser, {
    id: "fresh-scene-stage-revalidation",
    stage: { kind: "relax", stage_id: "stage-relax" },
    realtime: true,
  });
  try {
    const panelHandle = await scenario.inspector.elementHandle();
    const { mode, maxCpu } = await prepareAdaptiveDraft(scenario);
    const save = scenario.page.getByRole("button", {
      name: "Save globals",
      exact: true,
    });
    assert.equal(await save.isEnabled(), true);
    assert.equal((await visibleValidationText(scenario.page)).length, 0);

    const maxCpuHandle = await maxCpu.elementHandle();
    await maxCpu.focus();
    const priorOpacity = await maxCpu.evaluate(
      (input) => getComputedStyle(input).opacity,
    );

    await new Promise((resolveReady) => setTimeout(resolveReady, 150));
    const freshSceneResponsePromise = scenario.page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === SCENE_PATH &&
        scenario.fixture.sceneReadRevisions.includes(2),
      { timeout: 30_000 },
    );

    scenario.fixture.scene = makeScene(
      { kind: "run", stage_id: "stage-run" },
      2,
    );
    const socket = await waitForRealtimeSocket(scenario);
    socket.send(JSON.stringify({
      contract_version: "1.0.0",
      payload: { request_scope_epoch: REQUEST_SCOPE_EPOCH },
      run_id: null,
      seq: 1,
      session_id: SESSION_ID,
      type: "hello",
    }));
    socket.send(JSON.stringify({
      contract_version: "1.0.0",
      payload: {
        changes: [
          {
            recommended_fetch: SCENE_PATH,
            resource: "model",
            resource_id: "scene",
            revision: 2,
          },
        ],
      },
      run_id: null,
      seq: 2,
      session_id: SESSION_ID,
      type: "resource.batch_changed",
    }));

    const freshSceneResponse = await freshSceneResponsePromise;
    assert.equal(freshSceneResponse.status(), 200);
    const freshScene = await freshSceneResponse.json();
    assert.equal(freshScene.revision, 2);
    assert.equal(freshScene.study.stages[0].kind, "run");

    await scenario.page.waitForFunction(
      () =>
        [...document.querySelectorAll(".fm-inspector-validation-list li")]
          .some((item) => item.textContent?.includes("unavailable for run stages")),
      undefined,
      { timeout: 15_000 },
    );

    const validationMessages = await visibleValidationText(scenario.page);
    assert(
      validationMessages.some((message) => message.includes("unavailable for run stages")),
      "Fresh run stage was not used to revalidate the existing adaptive draft.",
    );
    assert.equal(await mode.inputValue(), "adaptive");
    assert.equal(await maxCpu.inputValue(), "73");
    assert.equal(await maxCpu.isEnabled(), true);
    assert.equal(
      await maxCpu.evaluate((input) => getComputedStyle(input).opacity),
      priorOpacity,
    );
    assert.equal(await maxCpu.evaluate((input) => document.activeElement === input), true);
    assert.equal(
      await scenario.page.evaluate(
        (panel) => panel.isConnected && document.querySelector(".fm-inspector") === panel,
        panelHandle,
      ),
      true,
      "Fresh validation replaced the mounted Study Inspector.",
    );
    assert.equal(
      await scenario.page.evaluate(
        (input) => input.isConnected && document.querySelector(".fm-inspector input[aria-label=\"Maximum CPU target (%)\"]") === input,
        maxCpuHandle,
      ),
      true,
      "Fresh validation replaced the edited CPU target input.",
    );
    assert.equal(await save.isDisabled(), true);
    assert.equal(scenario.fixture.mutations.length, 0);
    assert.deepEqual(scenario.fixture.unknownMutations, []);
    assert.deepEqual(scenario.pageErrors, []);

    return {
      fresh_revision: freshScene.revision,
      preserved_cpu_target: await maxCpu.inputValue(),
      preserved_parallel_mode: await mode.inputValue(),
      rejection_visible: true,
      save_disabled_after_fresh_read: true,
      mutation_count: scenario.fixture.mutations.length,
      inspector_root_preserved: true,
      focused_draft_input_preserved: true,
    };
  } finally {
    await scenario.context.close();
  }
}

async function main() {
  const playwright = await loadPlaywright();
  if (!playwright?.chromium) {
    throw new Error("Adaptive Study browser smoke requires Playwright or @playwright/test.");
  }

  await mkdir(reportRoot, { recursive: true });
  const browser = await playwright.chromium.launch({ headless: true });
  const rejectedCases = [
    {
      id: "frequency-response",
      stage: { kind: "frequency_response", stage_id: "stage-frequency-response" },
      expected: "unavailable for frequency_response stages",
    },
    {
      id: "run",
      stage: { kind: "run", stage_id: "stage-run" },
      expected: "unavailable for run stages",
    },
    {
      id: "unknown-stage",
      stage: { kind: "future_solver_stage", stage_id: "stage-unknown" },
      expected: "canonical, known stage types",
    },
    {
      id: "malformed-eigen-bias",
      stage: {
        kind: "eigenmodes",
        stage_id: "stage-eigen-malformed-bias",
        eigen_bias_field_sweep: { samples_a_per_m: [] },
      },
      expected: "malformed bias-field continuation samples",
    },
    {
      id: "malformed-raw-device",
      stage: { kind: "change_device", stage_id: "stage-device-invalid", device: 7 },
      expected: "explicit, valid device transition",
    },
  ];
  const legalCases = [
    {
      id: "relax-cpu",
      stage: { kind: "relax", stage_id: "stage-relax" },
    },
    {
      id: "eigen-k-path-cpu",
      stage: {
        eigen_count: 3,
        eigen_frequency_max: 2.5e9,
        eigen_frequency_min: 1.5e9,
        eigen_k_path: "G:0,0,0; X:1e7,0,0; G:0,0,0 | samples=2,2",
        eigen_operator: "full_2x2",
        eigen_target: "frequency_window",
        kind: "eigenmodes",
        stage_id: "stage-eigen-path",
      },
    },
  ];

  try {
    const rejected = [];
    for (const testCase of rejectedCases) {
      rejected.push(await runRejectedCase(browser, testCase));
    }
    const legal = [];
    for (const testCase of legalCases) {
      legal.push(await runLegalSaveCase(browser, testCase));
    }
    const stale = await runStaleSceneCase(browser);
    const report = {
      schema: "fullmag_study_adaptive_authoring_browser_v1",
      fixture_only: true,
      route: "/workspace",
      rejected,
      legal,
      stale_scene: stale,
      execution: "hosted-browser-required",
    };
    await writeFile(
      reportPath,
      JSON.stringify(report, null, 2) + "\n",
      { encoding: "utf8", flag: "wx" },
    );
    console.log(
      "Study adaptive authoring browser regression passed; report: " + reportPath,
    );
  } finally {
    await browser.close();
  }
}

await main();
