import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const workspaceUrl =
  process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:3107/workspace";
const timeoutMs = Number(
  process.env.CONTROL_ROOM_SIMULATION_PREPARATION_SMOKE_TIMEOUT_MS ?? 30_000,
);
const failureDialogOnly =
  process.env.CONTROL_ROOM_SIMULATION_PREPARATION_FAILURE_ONLY === "1";
const evidenceDir = resolve(
  process.cwd(),
  process.env.CONTROL_ROOM_SIMULATION_PREPARATION_EVIDENCE_DIR ??
    "../../.superpowers/sdd/evidence",
);
const representativeScreenshot = resolve(
  evidenceDir,
  "task-7-simulation-preparation-representative.png",
);
const narrowScreenshot = resolve(
  evidenceDir,
  "task-7-simulation-preparation-narrow.png",
);
const failureCollapsedScreenshot = resolve(
  evidenceDir,
  "simulation-preparation-failure-collapsed.png",
);
const failureExpandedScreenshot = resolve(
  evidenceDir,
  "simulation-preparation-failure-expanded.png",
);
const preparationPath = "/v2/sessions/current/simulation/preparation";
const eventsPath = "/v2/sessions/current/events/ws";
const stageDefinitions = [
  ["runtime_startup", "Runtime startup"],
  ["script_materialization", "Script materialization"],
  ["validation", "Validation"],
  ["planning", "Planning execution"],
  ["domain_preparation", "Domain preparation"],
  ["meshing", "Meshing"],
  ["mesh_postprocessing", "Mesh postprocessing"],
  ["solver_initialization", "Solver initialization"],
  ["ready", "Ready"],
];
const baseTime = Date.parse("2026-07-19T12:00:00.000Z");
const diagnosticEntryLimit = 12;
const diagnosticTextLimit = 400;
const diagnosticUrlLimit = 600;
const diagnosticBodyLimit = 2_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function boundedDiagnosticText(value, limit = diagnosticTextLimit) {
  const text = String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function boundedDiagnosticUrl(value) {
  return boundedDiagnosticText(value, diagnosticUrlLimit);
}

function createBoundedDiagnosticCollector(formatEntry) {
  const entries = [];
  let dropped = 0;

  return {
    record(value) {
      if (entries.length >= diagnosticEntryLimit) {
        dropped += 1;
        return;
      }
      entries.push(formatEntry(value));
    },
    snapshot() {
      return { dropped, entries: [...entries] };
    },
  };
}

function assertBoundedDiagnosticCollectorContract() {
  const collector = createBoundedDiagnosticCollector((value) =>
    boundedDiagnosticText(value),
  );
  for (let index = 0; index < diagnosticEntryLimit + 2; index += 1) {
    collector.record("x".repeat(diagnosticTextLimit + index));
  }
  const snapshot = collector.snapshot();
  assert(
    snapshot.entries.length === diagnosticEntryLimit,
    "Diagnostic collector did not retain a fixed number of entries.",
  );
  assert(
    snapshot.dropped === 2,
    "Diagnostic collector did not count dropped entries.",
  );
  assert(
    snapshot.entries.every((entry) => entry.length <= diagnosticTextLimit),
    "Diagnostic collector retained an unbounded entry.",
  );
}

if (process.env.CONTROL_ROOM_SIMULATION_PREPARATION_ASSERT_BOUNDS === "1") {
  assertBoundedDiagnosticCollectorContract();
  console.log("bounded-diagnostic-collector-contract");
  process.exit(0);
}

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

function fixtureHeaders(extra = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-expose-headers":
      "x-api-contract-version,etag,x-request-id",
    "x-api-contract-version": "1.0.0",
    ...extra,
  };
}

async function fulfillJson(route, body, status = 200) {
  await route.fulfill({
    body: JSON.stringify(body),
    headers: fixtureHeaders({ "content-type": "application/json" }),
    status,
  });
}

function stageFixture(
  id,
  status,
  {
    detail = `${stageDefinitions.find(([stageId]) => stageId === id)?.[1]} pending.`,
    durationMs = null,
    progressLabel = null,
    progressPercent = null,
  } = {},
) {
  return {
    completed_at_unix_ms: status === "completed" ? baseTime + 1_000 : null,
    detail,
    duration_ms: durationMs,
    id,
    label: stageDefinitions.find(([stageId]) => stageId === id)?.[1] ?? id,
    progress_label: progressLabel,
    progress_percent: progressPercent,
    started_at_unix_ms: null,
    status,
  };
}

function preparationFixture(kind) {
  const common = {
    preparation_id:
      kind === "failed"
        ? "simulation-preparation-smoke-failure"
        : "simulation-preparation-smoke-success",
    requested_execution: {
      backend: "fem",
      device: "gpu",
      engine_id: null,
      mode: "strict",
      precision: "double",
      runtime_family: null,
      worker: null,
    },
    resolved_execution: {
      backend: "fem",
      device: "gpu",
      engine_id: "native-fem-gpu",
      mode: "strict",
      precision: "double",
      runtime_family: null,
      worker: null,
    },
    started_at_unix_ms: baseTime,
  };

  if (kind === "planning") {
    return {
      ...common,
      active_stage_id: "planning",
      completed_at_unix_ms: null,
      failure: null,
      log_tail: [
        {
          level: "info",
          message: "Resolving backend capabilities",
          stage_id: "planning",
          timestamp_unix_ms: baseTime + 545,
        },
      ],
      revision: 1,
      stages: stageDefinitions.map(([id], index) =>
        stageFixture(id, index < 3 ? "completed" : index === 3 ? "active" : "pending", {
          detail:
            id === "planning"
              ? "Resolving execution plan and backend capabilities."
              : undefined,
          durationMs:
            id === "runtime_startup"
              ? 180
              : id === "script_materialization"
                ? 320
                : id === "validation"
                  ? 45
                  : id === "planning"
                    ? 2_100
                    : null,
        }),
      ),
      status: "running",
    };
  }

  if (kind === "meshing") {
    return {
      ...common,
      active_stage_id: "meshing",
      completed_at_unix_ms: null,
      failure: null,
      log_tail: [
        {
          level: "info",
          message: "Optimizing element quality",
          stage_id: "meshing",
          timestamp_unix_ms: baseTime + 18_700,
        },
      ],
      revision: 2,
      stages: stageDefinitions.map(([id], index) =>
        stageFixture(id, index < 5 ? "completed" : index === 5 ? "active" : "pending", {
          detail: id === "meshing" ? "Optimizing element quality" : undefined,
          durationMs: id === "meshing" ? 16_200 : index < 5 ? 500 + index * 100 : null,
          progressLabel:
            id === "meshing" ? "142580 / 226318 elements" : null,
          progressPercent: id === "meshing" ? 63 : null,
        }),
      ),
      status: "running",
    };
  }

  if (kind === "meshing-recovered") {
    return {
      ...common,
      active_stage_id: "meshing",
      completed_at_unix_ms: null,
      failure: null,
      log_tail: [
        {
          level: "info",
          message: "Status-pointer refresh recovered current mesh progress",
          stage_id: "meshing",
          timestamp_unix_ms: baseTime + 19_500,
        },
      ],
      revision: 3,
      stages: stageDefinitions.map(([id], index) =>
        stageFixture(id, index < 5 ? "completed" : index === 5 ? "active" : "pending", {
          detail:
            id === "meshing"
              ? "Recovered through authoritative HTTP status-pointer refresh"
              : undefined,
          durationMs: id === "meshing" ? 17_000 : index < 5 ? 500 + index * 100 : null,
          progressLabel: id === "meshing" ? "200000 / 226318 elements" : null,
          progressPercent: id === "meshing" ? 78 : null,
        }),
      ),
      status: "running",
    };
  }

  if (kind === "failed") {
    return {
      ...common,
      active_stage_id: null,
      completed_at_unix_ms: baseTime + 22_000,
      failure: {
        diagnostics_correlation_id: "prep-smoke-3",
        detail:
          "fem_mixed_p1_runtime_scope_rejected: failed_predicates=[gpu_dmi_kernel_not_mixed_p1]; fallback=none",
        error_code: "solver_initialization_failed",
        stage_id: "solver_initialization",
        summary: "GPU runtime initialization failed.",
      },
      log_tail: [
        {
          level: "error",
          message: "GPU runtime initialization failed",
          stage_id: "solver_initialization",
          timestamp_unix_ms: baseTime + 22_000,
        },
      ],
      revision: 5,
      stages: stageDefinitions.map(([id], index) =>
        stageFixture(id, index < 7 ? "completed" : index === 7 ? "failed" : "pending", {
          detail:
            id === "solver_initialization"
              ? "GPU runtime initialization failed."
              : undefined,
          durationMs: id === "solver_initialization" ? 740 : index < 7 ? 600 : null,
        }),
      ),
      status: "failed",
    };
  }

  return {
    ...common,
    active_stage_id: null,
    completed_at_unix_ms: baseTime + 24_000,
    failure: null,
    log_tail: [
      {
        level: "info",
        message: "Simulation ready",
        stage_id: "ready",
        timestamp_unix_ms: baseTime + 24_000,
      },
    ],
    revision: 4,
    stages: stageDefinitions.map(([id]) => stageFixture(id, "completed", { durationMs: 800 })),
    status: "ready",
  };
}

function statusFixture(preparationRevision) {
  return {
    api_contract_version: "1.0.0",
    capabilities: {
      algorithms_available: [],
      binary_fields: true,
      cell_fields: true,
      eigen_modes: false,
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
      max_points: 1_000,
      slice_layer: 0,
      slice_mode: "xy",
      vector_density: 1,
      vector_glyphs: true,
      view_mode: "3d",
      x_chosen_size: 1,
      y_chosen_size: 1,
    },
    domain: { cell_count: 0, discretization: "fem", generation_id: 0 },
    energies: {},
    metrics: { steps_per_second: null, total_steps: 0, uptime_seconds: 0 },
    resources: {
      artifact_revision: 0,
      artifacts_revision: 0,
      command_completion_revision: 0,
      commands_revision: 0,
      display_revision: 0,
      domain_generation_id: "0",
      engine_log_revision: 0,
      field_catalog_revision: 0,
      field_revision: 0,
      fields_revision: 0,
      mesh_build_revision: 0,
      mesh_revision: 0,
      region_coefficients_revision: 0,
      region_initial_state_revision: 0,
      region_membership_revision: 0,
      region_topology_revision: 0,
      scalars_revision: 0,
      scene_revision: 0,
      simulation_preparation_revision: preparationRevision,
      slice_revision: 0,
      solver_profile_revision: 0,
      stages_revision: 0,
      topology_revision: 0,
      visualization_state_revision: 0,
      workspace_revision: 0,
    },
    run: null,
    runtime_bundle_version: "simulation-preparation-smoke",
    session: {
      created_at: "2026-07-19T12:00:00.000Z",
      name: "Simulation preparation smoke",
      session_id: "simulation-preparation-smoke",
      workspace_root: "/tmp/fullmag-simulation-preparation-smoke",
    },
    solver: { state: "bootstrapping" },
  };
}

function visualizationStateFixture() {
  return {
    active_quantity_id: "m",
    auto_contrast: true,
    camera: {
      position: [3, 2, 2],
      projection: "perspective",
      target: [0, 0, 0],
      up: [0, 0, 1],
    },
    clip: { enabled: false, normal_axis: "z", offset: 0 },
    colormap: "viridis",
    contrast_max: null,
    contrast_min: null,
    diagnostics: { warnings: [] },
    domains: { active_scope_id: null, active_scope_kind: "domain" },
    fdm: { x_chosen_size: 1, y_chosen_size: 1 },
    fem: { topology_mode: "surface", volume_edges_budget: 0 },
    field_component: "magnitude",
    layers: {
      bounds: { visible: true },
      points: { visible: false },
      quantity_overlay: { visible: true },
      surface: { opacity: 0.94, visible: true },
      vectors: { density: 2, domain: "full_domain", visible: false },
      wireframe: { visible: true },
    },
    max_points: 120_000,
    overrides: [],
    quantity: {
      active_quantity_id: "m",
      auto_contrast: true,
      colormap: "viridis",
      contrast_max: null,
      contrast_min: null,
      field_component: "magnitude",
    },
    revision: 1,
    sampling: { max_glyphs: 192, max_points: 120_000 },
    schema_version: 1,
    slice: { layer: 0, mode: "xy" },
    slice_layer: 0,
    slice_mode: "xy",
    trim: { enabled: false, max: [1, 1, 1], min: [0, 0, 0] },
    vector_density: 2,
    vector_glyphs: false,
    vector_style: {
      alpha: 1,
      color_mode: "orientation",
      ferromagnet_visibility: "ghost",
      length_scale: 1,
      mono_color: "#89b4fa",
      thickness: 1.4,
    },
    view_mode: "3d",
    x_chosen_size: 1,
    y_chosen_size: 1,
  };
}

const playwright = await loadPlaywright();
if (!playwright?.chromium) {
  console.error("Simulation preparation smoke requires local Playwright.");
  process.exit(2);
}

await mkdir(evidenceDir, { recursive: true });
const browser = await playwright.chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { height: 900, width: 1_440 } });
await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
  origin: new URL(workspaceUrl).origin,
});
const consoleErrors = createBoundedDiagnosticCollector((message) =>
  boundedDiagnosticText(message),
);
const failedResponses = createBoundedDiagnosticCollector(({ status, url }) => ({
  status,
  url: boundedDiagnosticUrl(url),
}));
const networkFailures = createBoundedDiagnosticCollector(({ reason, url }) => ({
  reason: boundedDiagnosticText(reason),
  url: boundedDiagnosticUrl(url),
}));
const pageErrors = createBoundedDiagnosticCollector((message) =>
  boundedDiagnosticText(message),
);
let currentPreparation = preparationFixture(
  failureDialogOnly ? "failed" : "planning",
);
let holdPreparation = !failureDialogOnly;
let lastServedPreparationId = null;
let pendingPreparationRoute = null;
let preparationRequestCount = 0;
let preparationRevision = failureDialogOnly ? 5 : 1;
let socketRoute = null;
let socketConnectionCount = 0;
let sequence = 1;
const realtimeServerEvents = [];
const retiredPreparationIds = new Set();
const terminalSnapshotsByPreparationId = new Map();

function assertLegalPreparationSnapshot(snapshot) {
  if (snapshot.status === "failed" || snapshot.status === "ready") {
    assert(
      snapshot.active_stage_id === null,
      `Terminal preparation ${snapshot.preparation_id} retained an active stage.`,
    );
  }

  if (
    lastServedPreparationId !== null &&
    lastServedPreparationId !== snapshot.preparation_id
  ) {
    retiredPreparationIds.add(lastServedPreparationId);
  }
  assert(
    !retiredPreparationIds.has(snapshot.preparation_id),
    `Preparation ${snapshot.preparation_id} resumed after another lifecycle started.`,
  );

  const terminalSnapshot = terminalSnapshotsByPreparationId.get(
    snapshot.preparation_id,
  );
  assert(
    terminalSnapshot === undefined || terminalSnapshot === JSON.stringify(snapshot),
    `Terminal preparation ${snapshot.preparation_id} changed state.`,
  );
  if (snapshot.status === "failed" || snapshot.status === "ready") {
    terminalSnapshotsByPreparationId.set(
      snapshot.preparation_id,
      JSON.stringify(snapshot),
    );
  }
  lastServedPreparationId = snapshot.preparation_id;
}

async function fulfillPreparation(route) {
  assertLegalPreparationSnapshot(currentPreparation);
  await fulfillJson(route, currentPreparation);
}

await page.addInitScript(() => {
  window.__FULLMAG_CONFIG__ = {
    ...(window.__FULLMAG_CONFIG__ ?? {}),
    controlRoomApiBase: window.location.origin,
    disableRealtime: false,
  };
});

page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.record(message.text());
});
page.on("pageerror", (error) => {
  pageErrors.record(error.stack ?? error.message);
});
page.on("requestfailed", (request) => {
  networkFailures.record({
    reason: request.failure()?.errorText ?? "unknown",
    url: request.url(),
  });
});
page.on("response", (response) => {
  if (response.status() >= 400) {
    failedResponses.record({ status: response.status(), url: response.url() });
  }
});

await page.routeWebSocket(`**${eventsPath}*`, (route) => {
  assert(
    route.protocols().includes("fullmag.live.v1"),
    "Realtime connection omitted fullmag.live.v1.",
  );
  socketConnectionCount += 1;
  socketRoute = route;
});

await page.route("**/v2/**", async (route) => {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname === "/v2/sessions") {
    await fulfillJson(route, {
      schema_version: "2.0.0",
      sessions: [
        {
          current: true,
          name: "Simulation preparation smoke",
          session_id: "simulation-preparation-smoke",
          status: "active",
        },
      ],
    });
    return;
  }
  if (pathname === "/v2/sessions/current/status") {
    await fulfillJson(route, statusFixture(preparationRevision));
    return;
  }
  if (pathname === "/v2/sessions/current/model/readiness") {
    await fulfillJson(route, {
      blockers: [],
      capabilities: {
        move: { available: true },
        rotate: { available: true },
        scale: { available: true },
      },
      checks: [],
      ready_to_export: true,
      ready_to_run: false,
      scene_revision: 0,
    });
    return;
  }
  if (pathname === "/v2/sessions/current/visualization/state") {
    await fulfillJson(route, visualizationStateFixture());
    return;
  }
  if (pathname === preparationPath) {
    preparationRequestCount += 1;
    if (holdPreparation) {
      pendingPreparationRoute = route;
      return;
    }
    await fulfillPreparation(route);
    return;
  }
  if (pathname === "/v2/sessions/current/model/geometry/validation") {
    await fulfillJson(route, {
      diagnostics: [],
      revision: preparationRevision,
      valid: true,
    });
    return;
  }
  if (pathname === "/v2/sessions/current/simulation/solver/status") {
    await fulfillJson(route, {
      can_accept_commands: true,
      converged: false,
      is_busy: false,
      max_rhs_norm_per_s: null,
      max_torque_Apm: null,
      max_torque_T: null,
      revision: preparationRevision,
      runtime_state: "idle",
      runtime_status_code: "idle",
      runtime_status_kind: "idle",
      session_status: "ready",
      sim_time_seconds: 0,
      step_index: 0,
      warnings: [],
    });
    return;
  }
  await fulfillJson(
    route,
    { code: "fixture_unavailable", message: `No fixture for ${pathname}` },
    404,
  );
});

function sendRealtimeServerEvent(event) {
  assert(socketRoute, "Realtime socket is not connected.");
  realtimeServerEvents.push(event);
  socketRoute.send(JSON.stringify(event));
}

function sendPreparationInvalidation(revision) {
  sendRealtimeServerEvent({
    contract_version: "1.0.0",
    payload: {
      changes: [
        {
          recommended_fetch: preparationPath,
          resource: "simulation",
          resource_id: "preparation",
          revision,
        },
      ],
    },
    seq: ++sequence,
    type: "resource.batch_changed",
  });
}

function preparationRealtimeChanges() {
  return realtimeServerEvents.flatMap((event) => {
    if (event.type !== "resource.batch_changed") return [];
    return Array.isArray(event.payload?.changes) ? event.payload.changes : [];
  });
}

async function assertViewportBlocked(state) {
  assert(
    (await page.locator('[data-slot-id="viewport-main"]').count()) === 0,
    `Viewport rendered during ${state} preparation.`,
  );
}

function assertBoundingBoxInViewport(box, label) {
  const viewport = page.viewportSize();
  assert(viewport, "Smoke page has no configured viewport.");
  assert(box, `${label} has no bounding box.`);
  assert(
    box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height,
    `${label} escaped the ${viewport.width}x${viewport.height} viewport: ${JSON.stringify(box)}`,
  );
}

async function assertFailureDialogFocus(failureDialog, checkpoint) {
  assert(
    await failureDialog.evaluate((dialog) => dialog.contains(document.activeElement)),
    `Active element left the failure dialog after ${checkpoint}.`,
  );
}

async function assertExpandedFailureDialogGeometry(failureDialog) {
  assertBoundingBoxInViewport(
    await failureDialog.boundingBox(),
    "Expanded failure dialog",
  );
  const footerButtons = failureDialog.getByRole("button");
  const buttonCount = await footerButtons.count();
  assert(buttonCount >= 3, "Failure dialog footer lost an action button.");
  for (let index = 0; index < buttonCount; index += 1) {
    const button = footerButtons.nth(index);
    assert(
      await button.isVisible(),
      `Failure dialog footer button ${index + 1} is not visible after expansion.`,
    );
    assertBoundingBoxInViewport(
      await button.boundingBox(),
      `Failure dialog footer button ${index + 1}`,
    );
  }
}

async function assertReducedMotionFailureDialogStable(failureDialog) {
  const before = await failureDialog.boundingBox();
  try {
    await page.waitForTimeout(100);
    const after = await failureDialog.boundingBox();
    assert(
      before &&
        after &&
        ["x", "y", "width", "height"].every(
          (key) => Math.abs(before[key] - after[key]) < 1,
        ),
      `Failure dialog moved while reduced motion was enabled: ${JSON.stringify({ after, before })}`,
    );
    await assertFailureDialogFocus(failureDialog, "reduced-motion check");
  } finally {
    await page.emulateMedia({ reducedMotion: "no-preference" });
  }
}

function assertNoRecordedDiagnostics(collector, label) {
  const snapshot = collector.snapshot();
  assert(
    snapshot.entries.length === 0 && snapshot.dropped === 0,
    `${label}: ${JSON.stringify(snapshot)}`,
  );
}

async function boundedFailureSnapshot(error) {
  return {
    bodyText: boundedDiagnosticText(
      await page.locator("body").innerText().catch(() => ""),
      diagnosticBodyLimit,
    ),
    consoleErrors: consoleErrors.snapshot(),
    error: boundedDiagnosticText(error?.stack ?? error?.message ?? error),
    failedResponses: failedResponses.snapshot(),
    networkFailures: networkFailures.snapshot(),
    pageErrors: pageErrors.snapshot(),
    preparationRequestCount,
    socketConnectionCount,
    url: boundedDiagnosticUrl(page.url()),
  };
}

if (failureDialogOnly) {
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(workspaceUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await page
      .locator(".fm-simulation-startup__title")
      .getByText("Simulation preparation failed", { exact: true })
      .waitFor();
    const failureDialog = page.getByRole("dialog");
    await failureDialog.waitFor();
    await assertFailureDialogFocus(failureDialog, "auto-open");
    await assertReducedMotionFailureDialogStable(failureDialog);
    await failureDialog.getByText("What happened", { exact: true }).waitFor();
    await failureDialog.getByText("How to fix", { exact: true }).waitFor();
    await failureDialog
      .getByText("Technical diagnostics", { exact: true })
      .waitFor();
    await failureDialog
      .getByText("DMI is unavailable on the FEM mixed-P1 GPU lane", {
        exact: true,
      })
      .waitFor();
    await failureDialog
      .getByText("gpu_dmi_kernel_not_mixed_p1", { exact: true })
      .waitFor();
    const fullReport = failureDialog.locator(
      ".fm-simulation-preparation-failure-dialog__full-report",
    );
    assert(
      (await fullReport.getAttribute("open")) === null,
      "Full diagnostic report was not collapsed by default.",
    );
    await failureDialog.screenshot({ path: failureCollapsedScreenshot });
    await fullReport.getByText("Full diagnostic report", { exact: true }).click();
    assert(
      (await fullReport.getAttribute("open")) !== null,
      "Full diagnostic report did not expand from its native summary control.",
    );
    await assertFailureDialogFocus(failureDialog, "summary click");
    await assertExpandedFailureDialogGeometry(failureDialog);
    await failureDialog.getByRole("button", { name: "Close" }).waitFor();
    await failureDialog.screenshot({ path: failureExpandedScreenshot });
    await failureDialog
      .getByRole("button", { name: "Copy full diagnostic report" })
      .click();
    await failureDialog
      .getByRole("status")
      .getByText("Diagnostic report copied to clipboard.", { exact: true })
      .waitFor();
    await assertFailureDialogFocus(failureDialog, "copy click");
    await assertViewportBlocked("failed");
    assertNoRecordedDiagnostics(networkFailures, "Failure-dialog smoke received network failures");
    assertNoRecordedDiagnostics(failedResponses, "Failure-dialog smoke received failed HTTP responses");
    assertNoRecordedDiagnostics(consoleErrors, "Failure-dialog smoke emitted console errors");
    assertNoRecordedDiagnostics(pageErrors, "Failure-dialog smoke emitted page errors");
    console.log(
      JSON.stringify(
        {
          assertions: [
            "failure-dialog-auto-open",
            "known-predicate-action",
            "full-report-collapsed",
            "full-report-expanded",
            "dialog-geometry-in-viewport",
            "dialog-focus-trapped",
            "dialog-reduced-motion-stable",
            "copy-full-report",
            "viewport-blocked",
            "network-failures-none",
            "console-errors-none",
            "page-errors-none",
            "http-errors-none",
          ],
          screenshots: [failureCollapsedScreenshot, failureExpandedScreenshot],
          workspaceUrl,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(JSON.stringify(await boundedFailureSnapshot(error), null, 2));
    throw error;
  } finally {
    await browser.close();
  }
  process.exit(0);
}

try {
  await page.goto(workspaceUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.locator('.fm-simulation-startup[data-state="connecting"]').waitFor();
  await page
    .getByText("Starting the runtime workspace.", { exact: true })
    .waitFor();
  assert(
    (await page.getByRole("heading", { name: "Preparing simulation" }).textContent()) ===
      "Preparing simulation",
    "Connecting title drifted.",
  );
  assert(
    (await page.locator(".fm-simulation-startup__detail").textContent()) ===
      "Starting the runtime workspace.",
    "Connecting detail drifted.",
  );
  await assertViewportBlocked("connecting");

  const socketDeadline = Date.now() + timeoutMs;
  while (!socketRoute && Date.now() < socketDeadline) {
    await page.waitForTimeout(10);
  }
  assert(socketRoute, "Realtime socket did not connect before the smoke timeout.");
  sendRealtimeServerEvent({
    payload: {
      communication_policy: { status_refresh_ms: 50, ws_reconnect_ms: 10_000 },
    },
    seq: sequence,
    type: "hello",
  });

  assert(pendingPreparationRoute, "Initial preparation request was not held.");
  holdPreparation = false;
  await fulfillPreparation(pendingPreparationRoute);
  pendingPreparationRoute = null;
  await page.getByRole("heading", { name: "Planning execution" }).waitFor();
  const progress = page.getByRole("progressbar", {
    name: "Simulation preparation progress",
  });
  assert((await progress.getAttribute("aria-valuenow")) === null, "Planning invented a percent.");
  assert(
    (await progress.getAttribute("aria-valuetext")) ===
      "Planning execution in progress",
    "Planning progress semantics drifted.",
  );
  assert(
    JSON.stringify(
      await page.locator(".fm-simulation-startup__stage-title").allTextContents(),
    ) === JSON.stringify(stageDefinitions.map(([, label]) => label)),
    "Canonical preparation stage ordering drifted.",
  );
  assert(
    (await page.locator('.fm-simulation-startup__stage-title-row time').nth(3).textContent()) ===
      "2.1s",
    "Planning stage time is not 2.1s.",
  );
  assert(
    (await page.locator(".fm-simulation-startup__log-message").textContent()) ===
      "Resolving backend capabilities",
    "Planning log text drifted.",
  );
  assert(
    (await page.locator(".fm-simulation-startup__log-entry time").textContent()) ===
      "12:00:00.545",
    "Planning log timestamp drifted.",
  );
  assert(
    (await page.locator('[role="log"]').getAttribute("aria-live")) === "off",
    "Preparation log became a live announcement region.",
  );
  await assertViewportBlocked("planning");
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert(
    (await page
      .locator(".fm-simulation-startup__progress .fm-progress__indicator")
      .evaluate((element) => getComputedStyle(element).animationName)) === "none",
    "Reduced motion did not disable continuous progress animation.",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });

  currentPreparation = preparationFixture("meshing");
  preparationRevision = 2;
  sendPreparationInvalidation(2);
  await page.getByText("142580 / 226318 elements", { exact: true }).waitFor();
  assert((await progress.getAttribute("aria-valuenow")) === "63", "Meshing progress is not 63%.");
  assert(
    (await progress.getAttribute("aria-valuetext")) ===
      "63 percent, 142580 / 226318 elements",
    "Meshing progress value text drifted.",
  );
  assert(
    (await page.locator('.fm-simulation-startup__stage-title-row time').nth(5).textContent()) ===
      "16.2s",
    "Meshing stage time is not 16.2s.",
  );
  assert(
    (await page.locator(".fm-simulation-startup__log-entry time").textContent()) ===
      "12:00:18.700",
    "Meshing log timestamp drifted.",
  );
  assert(
    (await page.locator(".fm-simulation-startup__execution dd").allTextContents()).join("|") ===
      "fem · gpu · double · strict|fem · gpu · double · strict · native-fem-gpu",
    "Requested/resolved execution text drifted.",
  );
  await assertViewportBlocked("meshing");
  const representativeTimelineBox = await page
    .locator(".fm-simulation-startup__timeline")
    .boundingBox();
  const representativeLogBox = await page
    .locator(".fm-simulation-startup__log")
    .boundingBox();
  assert(
    representativeTimelineBox &&
      representativeLogBox &&
      representativeTimelineBox.y === representativeLogBox.y &&
      representativeTimelineBox.x + representativeTimelineBox.width <
        representativeLogBox.x,
    "Representative option-A panels are not side by side.",
  );
  await page.screenshot({ path: representativeScreenshot });

  await page.setViewportSize({ height: 1_000, width: 700 });
  const panelBox = await page.locator(".fm-simulation-startup__panel").boundingBox();
  const timelineBox = await page.locator(".fm-simulation-startup__timeline").boundingBox();
  const logBox = await page.locator(".fm-simulation-startup__log").boundingBox();
  assert(panelBox && timelineBox && logBox, "Narrow option-A geometry is missing.");
  assert(logBox.y >= timelineBox.y + timelineBox.height, "Narrow layout did not stack.");
  assert(panelBox.width <= 676.5, "Narrow panel overflows the viewport.");
  const narrowStageGeometry = await page
    .locator(".fm-simulation-startup__stages li")
    .evaluateAll((items) => ({
      list: items[0]
        ? (() => {
            const list = items[0].parentElement;
            const style = list ? getComputedStyle(list) : null;
            return {
              alignContent: style?.alignContent ?? null,
              clientHeight: list?.clientHeight ?? null,
              gridAutoRows: style?.gridAutoRows ?? null,
              gridTemplateRows: style?.gridTemplateRows ?? null,
              scrollHeight: list?.scrollHeight ?? null,
            };
          })()
        : null,
      rows: items.map((item, index) => {
        const next = items[index + 1];
        const copy = item.querySelector(".fm-simulation-startup__stage-copy");
        const itemRect = item.getBoundingClientRect();
        const copyRect = copy?.getBoundingClientRect();
        const nextRect = next?.getBoundingClientRect();
        return {
          copyBottom: copyRect?.bottom ?? null,
          copyHeight: copyRect?.height ?? null,
          itemBottom: itemRect.bottom,
          itemHeight: itemRect.height,
          itemTop: itemRect.top,
          nextTop: nextRect?.top ?? null,
        };
      }),
    }));
  const narrowStagesDoNotOverlap = narrowStageGeometry.rows.every(
    (row) => row.nextTop === null || row.copyBottom === null || row.copyBottom <= row.nextTop,
  );
  assert(
    narrowStagesDoNotOverlap,
    `Narrow preparation stage rows overlap: ${JSON.stringify(narrowStageGeometry)}`,
  );
  await page.screenshot({ path: narrowScreenshot });
  await page.setViewportSize({ height: 900, width: 1_440 });

  const disconnectedSocket = socketRoute;
  socketRoute = null;
  await disconnectedSocket.close({
    code: 1012,
    reason: "simulation preparation smoke reconnect",
  });
  await page.getByText("Reconnecting…", { exact: true }).waitFor();
  await page.getByText("Displayed progress may be out of date.", { exact: true }).waitFor();
  await page.getByText("142580 / 226318 elements", { exact: true }).waitFor();
  assert(
    (await progress.getAttribute("aria-valuenow")) === "63",
    "Transport failure did not retain the revision-2 meshing snapshot.",
  );
  await assertViewportBlocked("stale");

  const preparationRequestsBeforePointerRecovery = preparationRequestCount;
  currentPreparation = preparationFixture("meshing-recovered");
  preparationRevision = 3;
  await page.getByText("200000 / 226318 elements", { exact: true }).waitFor();
  assert(
    preparationRequestCount > preparationRequestsBeforePointerRecovery,
    "Status pointer advance did not trigger a preparation HTTP refresh.",
  );
  assert(
    socketConnectionCount === 1,
    "WebSocket reconnected before status-pointer HTTP recovery completed.",
  );
  assert(
    (await progress.getAttribute("aria-valuenow")) === "78",
    "Status-pointer HTTP recovery did not publish revision-3 progress.",
  );
  await page.getByText("Reconnecting…", { exact: true }).waitFor();
  await page.getByText("Displayed progress may be out of date.", { exact: true }).waitFor();
  await assertViewportBlocked("status-pointer-recovered-stale");

  const reconnectDeadline = Date.now() + timeoutMs;
  while (socketConnectionCount < 2 && Date.now() < reconnectDeadline) {
    await page.waitForTimeout(10);
  }
  assert(socketConnectionCount === 2, "Realtime client did not reconnect after socket close.");
  await page.getByText("Reconnecting…", { exact: true }).waitFor({ state: "detached" });
  await page.getByText("200000 / 226318 elements", { exact: true }).waitFor();

  const readyResourceResponses = Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          "/v2/sessions/current/model/geometry/validation" && response.ok(),
    ),
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          "/v2/sessions/current/simulation/solver/status" && response.ok(),
    ),
  ]);
  currentPreparation = preparationFixture("ready");
  preparationRevision = 4;
  sendPreparationInvalidation(4);
  await page.locator(".fm-simulation-startup").waitFor({ state: "detached" });
  await page.locator('[data-slot-id="viewport-main"]').waitFor({ state: "attached" });
  await readyResourceResponses;

  await page.emulateMedia({ reducedMotion: "reduce" });
  currentPreparation = preparationFixture("failed");
  preparationRevision = 5;
  sendPreparationInvalidation(5);
  await page
    .locator(".fm-simulation-startup__title")
    .getByText("Simulation preparation failed", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Copy diagnostics" }).waitFor();
  const failureDialog = page.getByRole("dialog");
  await failureDialog.waitFor();
  await assertFailureDialogFocus(failureDialog, "auto-open");
  await assertReducedMotionFailureDialogStable(failureDialog);
  await failureDialog
    .getByText(
      "fem_mixed_p1_runtime_scope_rejected: failed_predicates=[gpu_dmi_kernel_not_mixed_p1]; fallback=none",
      {
      exact: true,
      },
    )
    .waitFor();
  await failureDialog.getByText("What happened", { exact: true }).waitFor();
  await failureDialog.getByText("How to fix", { exact: true }).waitFor();
  await failureDialog.getByText("Technical diagnostics", { exact: true }).waitFor();
  await failureDialog
    .getByText("DMI is unavailable on the FEM mixed-P1 GPU lane", { exact: true })
    .waitFor();
  await failureDialog
    .getByText("gpu_dmi_kernel_not_mixed_p1", { exact: true })
    .waitFor();
  await failureDialog.getByText("740ms", { exact: true }).waitFor();
  await failureDialog.getByText("prep-smoke-3", { exact: true }).waitFor();
  const fullReport = failureDialog.locator(
    ".fm-simulation-preparation-failure-dialog__full-report",
  );
  assert(
    (await fullReport.getAttribute("open")) === null,
    "Full diagnostic report was not collapsed by default.",
  );
  await failureDialog.screenshot({ path: failureCollapsedScreenshot });
  await fullReport.getByText("Full diagnostic report", { exact: true }).click();
  assert(
    (await fullReport.getAttribute("open")) !== null,
    "Full diagnostic report did not expand from its native summary control.",
  );
  await assertFailureDialogFocus(failureDialog, "summary click");
  await assertExpandedFailureDialogGeometry(failureDialog);
  await failureDialog.getByRole("button", { name: "Close" }).waitFor();
  await failureDialog.screenshot({ path: failureExpandedScreenshot });
  await failureDialog
    .getByRole("button", { name: "Copy full diagnostic report" })
    .click();
  await failureDialog
    .getByRole("status")
    .getByText("Diagnostic report copied to clipboard.", { exact: true })
    .waitFor();
  await assertFailureDialogFocus(failureDialog, "copy click");
  await failureDialog.getByRole("button", { name: "Close" }).click();
  await failureDialog.waitFor({ state: "detached" });
  await page.waitForTimeout(250);
  assert(
    (await page.getByRole("dialog").count()) === 0,
    "Failure dialog reopened for the same failure identity after manual close.",
  );
  await page.getByRole("button", { name: "View error details" }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  const openDiagnostics = page
    .locator(".fm-simulation-startup__actions")
    .getByRole("button", { name: "Open full diagnostics" });
  await openDiagnostics.waitFor();
  assert(
    (await page.locator(".fm-simulation-startup__detail").textContent()) ===
      "GPU runtime initialization failed.",
    "Failure summary drifted.",
  );
  assert((await progress.getAttribute("aria-valuenow")) === null, "Failure exposed numeric progress.");
  assert(
    (await progress.getAttribute("aria-valuetext")) ===
      "Simulation preparation failed",
    "Failure progress semantics drifted.",
  );
  await assertViewportBlocked("failed");
  await openDiagnostics.click();
  await page
    .locator(".fm-simulation-startup__diagnostics-dock")
    .waitFor({ state: "visible" });
  assert(
    (await page.locator('[data-slot-id="panel-bottom"]').count()) === 1,
    "Mounted diagnostics consumer was not visible after the failure action.",
  );
  await page
    .locator(".fm-simulation-startup__title")
    .getByText("Simulation preparation failed", { exact: true })
    .waitFor();

  const preparationChanges = preparationRealtimeChanges();
  assert(
    JSON.stringify(preparationChanges.map((change) => change.revision)) ===
      JSON.stringify([2, 4, 5]),
    `Unexpected preparation revisions traveled on WebSocket: ${JSON.stringify(preparationChanges)}`,
  );
  assert(
    preparationChanges.every(
      (change) =>
        JSON.stringify(Object.keys(change).sort()) ===
          JSON.stringify(["recommended_fetch", "resource", "resource_id", "revision"]),
    ),
    `WebSocket carried preparation resource content: ${JSON.stringify(preparationChanges)}`,
  );
  assert(
    preparationChanges.every(
      (change) =>
        change.resource === "simulation" &&
        change.resource_id === "preparation" &&
        change.recommended_fetch === preparationPath,
    ),
    `Preparation WebSocket resource identity drifted: ${JSON.stringify(preparationChanges)}`,
  );
  assertNoRecordedDiagnostics(networkFailures, "Unexpected network failures");
  assertNoRecordedDiagnostics(consoleErrors, "Unexpected console errors");
  assertNoRecordedDiagnostics(pageErrors, "Page errors");
  assertNoRecordedDiagnostics(failedResponses, "Failed HTTP responses");

  console.log(
    JSON.stringify(
      {
        assertions: [
          "connecting",
          "planning-indeterminate",
          "meshing-63",
          "websocket-close-reconnecting-stale",
          "status-pointer-http-recovery",
          "websocket-reconnect-clears-stale",
          "websocket-revision-only-content",
          "ready-release",
          "failed-new-preparation",
          "mounted-diagnostics-consumer",
          "representative-geometry",
          "narrow-geometry",
          "reduced-motion",
          "exact-stage-log-time-text",
          "network-failures-none",
          "page-errors-none",
          "http-errors-none",
        ],
        preparationRequests: preparationRequestCount,
        screenshots: [
          representativeScreenshot,
          narrowScreenshot,
          failureCollapsedScreenshot,
          failureExpandedScreenshot,
        ],
        workspaceUrl,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(JSON.stringify(await boundedFailureSnapshot(error), null, 2));
  throw error;
} finally {
  await browser.close();
}
