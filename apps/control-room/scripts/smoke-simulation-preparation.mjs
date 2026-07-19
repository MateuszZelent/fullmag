import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const workspaceUrl =
  process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:3107/workspace";
const timeoutMs = Number(
  process.env.CONTROL_ROOM_SIMULATION_PREPARATION_SMOKE_TIMEOUT_MS ?? 30_000,
);
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
    preparation_id: "simulation-preparation-smoke",
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

  if (kind === "failed") {
    return {
      ...common,
      active_stage_id: "solver_initialization",
      completed_at_unix_ms: baseTime + 22_000,
      failure: {
        diagnostics_correlation_id: "prep-smoke-3",
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
      revision: 3,
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

const playwright = await loadPlaywright();
if (!playwright?.chromium) {
  console.error("Simulation preparation smoke requires local Playwright.");
  process.exit(2);
}

await mkdir(evidenceDir, { recursive: true });
const browser = await playwright.chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { height: 900, width: 1_440 } });
const browserErrors = [];
const failedResponses = [];
let currentPreparation = preparationFixture("planning");
let holdPreparation = true;
let pendingPreparationRoute = null;
let preparationRequestCount = 0;
let preparationRevision = 1;
let socketRoute = null;
let sequence = 1;

await page.addInitScript(() => {
  window.__FULLMAG_CONFIG__ = {
    ...(window.__FULLMAG_CONFIG__ ?? {}),
    controlRoomApiBase: window.location.origin,
    disableRealtime: false,
  };
});

page.on("console", (message) => {
  if (message.type() === "error") browserErrors.push(message.text());
});
page.on("pageerror", (error) => {
  browserErrors.push(error.stack ?? error.message);
});
page.on("response", (response) => {
  if (response.status() >= 400) {
    failedResponses.push(`${response.status()} ${response.url()}`);
  }
});

await page.routeWebSocket(`**${eventsPath}*`, (route) => {
  assert(
    route.protocols().includes("fullmag.live.v1"),
    "Realtime connection omitted fullmag.live.v1.",
  );
  socketRoute = route;
});

await page.route("**/v2/**", async (route) => {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname === "/v2/sessions/current/status") {
    await fulfillJson(route, statusFixture(preparationRevision));
    return;
  }
  if (pathname === preparationPath) {
    preparationRequestCount += 1;
    if (holdPreparation) {
      pendingPreparationRoute = route;
      return;
    }
    await fulfillJson(route, currentPreparation);
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

function sendPreparationInvalidation(revision) {
  assert(socketRoute, "Realtime socket is not connected.");
  socketRoute.send(
    JSON.stringify({
      contract_version: "1.0.0",
      payload: {
        changes: [
          {
            recommended_fetch: preparationPath,
            resource: "stages",
            resource_id: "simulation/preparation",
            revision,
          },
        ],
      },
      seq: ++sequence,
      type: "resource.batch_changed",
    }),
  );
}

async function assertViewportBlocked(state) {
  assert(
    (await page.locator('[data-slot-id="viewport-main"]').count()) === 0,
    `Viewport rendered during ${state} preparation.`,
  );
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
  socketRoute.send(
    JSON.stringify({
      payload: { communication_policy: { status_refresh_ms: 50 } },
      seq: sequence,
      type: "hello",
    }),
  );

  assert(pendingPreparationRoute, "Initial preparation request was not held.");
  holdPreparation = false;
  await fulfillJson(pendingPreparationRoute, currentPreparation);
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

  currentPreparation = preparationFixture("failed");
  preparationRevision = 3;
  holdPreparation = true;
  sendPreparationInvalidation(3);
  await page.getByText("Reconnecting…", { exact: true }).waitFor();
  await page.getByText("Displayed progress may be out of date.", { exact: true }).waitFor();
  await assertViewportBlocked("stale");
  assert(pendingPreparationRoute, "Stale preparation request was not held.");
  holdPreparation = false;
  await fulfillJson(pendingPreparationRoute, currentPreparation);
  pendingPreparationRoute = null;
  await page.getByRole("heading", { name: "Simulation preparation failed" }).waitFor();
  await page.getByRole("button", { name: "Copy diagnostics" }).waitFor();
  await page.getByRole("button", { name: "Open full diagnostics" }).waitFor();
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

  currentPreparation = preparationFixture("ready");
  preparationRevision = 4;
  sendPreparationInvalidation(4);
  await page.locator(".fm-simulation-startup").waitFor({ state: "detached" });
  await page.locator('[data-slot-id="viewport-main"]').waitFor({ state: "attached" });
  assert(
    browserErrors.length === 0 && failedResponses.length === 0,
    `Browser emitted errors:\n${browserErrors.join("\n")}\nFailed responses:\n${failedResponses.join("\n")}`,
  );

  console.log(
    JSON.stringify(
      {
        assertions: [
          "connecting",
          "planning-indeterminate",
          "meshing-63",
          "reconnecting-stale",
          "failed-terminal",
          "ready-release",
          "representative-geometry",
          "narrow-geometry",
          "reduced-motion",
          "exact-stage-log-time-text",
          "browser-errors-none",
        ],
        preparationRequests: preparationRequestCount,
        screenshots: [representativeScreenshot, narrowScreenshot],
        workspaceUrl,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
