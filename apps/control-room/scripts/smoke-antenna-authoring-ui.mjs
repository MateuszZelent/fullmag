import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { chromium } from "playwright";

import {
  antennaExplorerNodeIds,
  assertAntennaScene,
} from "./lib/antenna-authoring-browser.mjs";
import { isExpectedScratchHttpError } from "./lib/scratch-authoring-browser.mjs";

const apiBase = process.env.CONTROL_ROOM_API_BASE ?? "http://127.0.0.1:3100";
const workspaceUrl =
  process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:3100/workspace";
const backend = process.env.CONTROL_ROOM_ANTENNA_BACKEND ?? "fdm";
const evidenceDir = resolve(
  process.env.CONTROL_ROOM_ANTENNA_EVIDENCE_DIR ??
    ".fullmag/test-results/antenna-authoring",
);
const timeoutMs = Number(
  process.env.CONTROL_ROOM_ANTENNA_SMOKE_TIMEOUT_MS ?? 120_000,
);

if (backend !== "fdm" && backend !== "fem") {
  throw new Error(`CONTROL_ROOM_ANTENNA_BACKEND must be fdm or fem, got ${backend}`);
}

async function responseJson(response, label) {
  const body = await response.text();
  if (!response.ok()) {
    throw new Error(`${label} failed (${response.status()}): ${body}`);
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error}`);
  }
}

async function readScene(context) {
  return responseJson(
    await context.request.get(`${apiBase}/v2/sessions/current/model/scene`),
    "read antenna scene",
  );
}

async function waitForScene(context, predicate, label) {
  const deadline = Date.now() + timeoutMs;
  let scene = await readScene(context);
  while (Date.now() < deadline) {
    if (predicate(scene)) return scene;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    scene = await readScene(context);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(scene)}`);
}

async function selectNode(page, nodeId) {
  const node = page.locator(`[data-node-id="${nodeId}"]`);
  await node.waitFor({ state: "visible" });
  await node.click();
  const prompt = page.getByRole("button", {
    name: "Apply and continue",
    exact: true,
  });
  if (await prompt.isVisible().catch(() => false)) await prompt.click();
}

function fieldSolutionFixture({ objectId, portId, stageId, outputId, session }) {
  const sampleBytes = antennaSampleBytes();
  const fieldBytes = antennaFieldBytes();
  return {
    asset_id: `asset:${outputId}`,
    assumptions: ["browser smoke thin-metadata fixture"],
    bases: [{
      port_mode_id: portId,
      measured_positive_terminal_current_a: 1,
      normalization_current_a: 1,
      normalization_scale: 1,
      current_balance_certificate_digest: "sha256:browser-smoke-current",
      magnetic_field_per_ampere: {
        layout: "sample_xyz_interleaved",
        path: "antenna/field.f64le",
        scalar_type: "float64_le",
        sha256: payloadSha256(fieldBytes),
        unit: "A/m/A",
        value_count: 6,
      },
      quadrature_diagnostics: {},
    }],
    component: "vector_basis",
    conductor_positions: {
      layout: "xyz",
      path: "antenna/conductor.f64le",
      scalar_type: "f64",
      sha256: "sha256:antenna-conductor",
      unit: "m",
      value_count: 3,
    },
    content_digest: `sha256:field:${outputId}`,
    current_transport_id: `${objectId}:current`,
    gauge_policy: "zero_mean",
    geometry_revision: "scene",
    material_revision: "scene",
    mesh_digest: "mesh:browser-smoke",
    quantity: "H_ant_basis",
    requested_execution: { backend, device: "cpu", precision: "double" },
    resolved_execution: { backend, device: "cpu", precision: "double" },
    resource_id: `antenna/field-solution/${outputId}`,
    sample_positions: {
      layout: "sample_xyz_interleaved",
      path: "antenna/samples.f64le",
      scalar_type: "float64_le",
      sha256: payloadSha256(sampleBytes),
      unit: "m",
      value_count: 6,
    },
    sample_topology: null,
    schema_version: "antenna_field_solution.v1",
    session_epoch: session?.session_epoch ?? session?.epoch ?? "browser-smoke",
    session_id: session?.session_id ?? "browser-smoke",
    signatures: {
      current_solution_signature: "sha256:current",
      field_solution_signature: `sha256:field:${outputId}`,
      target_projection_signatures: {},
    },
    solution_id: outputId,
    solver_policy: { policy: "fixture-only" },
    source_object_id: objectId,
    stage_id: stageId,
    status: "ready",
    target_projection_signature: null,
  };
}

function antennaSampleBytes() {
  const buffer = Buffer.alloc(6 * 8);
  [1e-9, 2e-9, 3e-9, 4e-9, 5e-9, 6e-9]
    .forEach((value, index) => buffer.writeDoubleLE(value, index * 8));
  return buffer;
}

function antennaFieldBytes() {
  const buffer = Buffer.alloc(6 * 8);
  [1, -2, 3, 4, -5, 6]
    .forEach((value, index) => buffer.writeDoubleLE(value, index * 8));
  return buffer;
}

function payloadSha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const expectedAbortedResourcePaths = [
  "/meshing/meshes/shared-domain/manifest",
  "/simulation/stages/execution",
  "/data/fdm-region-memberships",
  "/data/domain/topology",
];

function isExpectedAntennaRequestFailure(entry) {
  return (
    entry.method === "GET" &&
    entry.failure === "net::ERR_ABORTED" &&
    expectedAbortedResourcePaths.some((path) => entry.url.includes(path))
  );
}

function stageOutputCatalogFixture({ objectId, stageId, outputId, session }) {
  return {
    content_digest: `sha256:catalog:${stageId}`,
    diagnostic: null,
    outputs: [
      {
        kind: "field_solution",
        manifest_ref: "manifest.json",
        output_id: outputId,
        quantity_ids: ["H_ant_basis"],
        reused_existing: false,
        solution_ref: {
          asset_id: `asset:${outputId}`,
          content_digest: `sha256:field:${outputId}`,
          output_id: outputId,
          stage_id: stageId,
        },
      },
    ],
    port_mode_id: `${objectId}:port:common`,
    resource_id: `antenna/stage-output-catalog/${stageId}`,
    schema_version: "antenna_stage_output_catalog.v1",
    session_epoch: session?.session_epoch ?? session?.epoch ?? "browser-smoke",
    session_id: session?.session_id ?? "browser-smoke",
    solution_id: outputId,
    stage_id: stageId,
    stage_kind: "antenna_field_solve",
    stage_revision: 1,
    status: "ready",
  };
}

async function installAntennaResultFixtures(page, resolved, session) {
  await page.route(`${apiBase}/v2/sessions/current/data/antenna/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const encodedStageId = encodeURIComponent(resolved.stageId);
    const encodedOutputId = encodeURIComponent(resolved.outputId);
    if (
      pathname.endsWith(`/stages/${encodedStageId}/output-catalog`)
    ) {
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "application/json",
          etag: '"antenna-catalog-smoke"',
          "x-api-contract-version": "1.0.0",
          "access-control-expose-headers": "x-api-contract-version,etag",
        },
        body: JSON.stringify(stageOutputCatalogFixture({ ...resolved, session })),
      });
      return;
    }
    if (pathname.endsWith(`/field-solutions/${encodedOutputId}`)) {
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "application/json",
          etag: '"antenna-field-smoke"',
          "x-api-contract-version": "1.0.0",
          "access-control-expose-headers": "x-api-contract-version,etag",
        },
        body: JSON.stringify(fieldSolutionFixture({ ...resolved, session })),
      });
      return;
    }
    await route.continue();
  });
}

async function readWebglHealth(page) {
  return page.evaluate(() => {
    const canvases = [...document.querySelectorAll("canvas")];
    const visible = canvases.filter((canvas) => {
      const rect = canvas.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const contexts = visible.map((canvas) => {
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      return {
        context_lost: gl?.isContextLost?.() ?? null,
        drawing_buffer_nonzero: Boolean(
          gl && gl.drawingBufferWidth > 0 && gl.drawingBufferHeight > 0,
        ),
      };
    });
    return {
      canvas_count: canvases.length,
      visible_canvas_count: visible.length,
      contexts,
      context_lost: contexts.some((context) => context.context_lost === true),
      drawing_buffer_nonzero: contexts.some(
        (context) => context.drawing_buffer_nonzero,
      ),
    };
  });
}

const runtimeErrors = [];
const httpErrors = [];
const requestFailures = [];
const unexpectedPayloadRequests = [];
let browser;
let context;
let exitCode = 0;

try {
  browser = await chromium.launch({
    headless: process.env.CONTROL_ROOM_HEADFUL !== "1",
  });
  context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.stack ?? error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) {
      httpErrors.push({
        method: response.request().method(),
        status: response.status(),
        url: response.url(),
      });
    }
  });
  page.on("requestfailed", (request) => {
    requestFailures.push({
      failure: request.failure()?.errorText ?? "unknown",
      method: request.method(),
      url: request.url(),
    });
  });
  page.on("request", (request) => {
    if (request.url().includes(`/field-solutions/`) && request.url().includes(`/payloads/`)) {
      unexpectedPayloadRequests.push(request.url());
    }
  });
  await page.addInitScript((configuredApiBase) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      controlRoomApiBase: configuredApiBase,
      disableRealtime: false,
    };
  }, apiBase);

  const created = await responseJson(
    await context.request.post(`${apiBase}/v2/sessions`, {
      data: {
        name: `Antenna authoring UI smoke ${backend.toUpperCase()}`,
        backend,
        device: "cpu",
        precision: "double",
        replace_current: true,
      },
    }),
    "create antenna smoke session",
  );

  const profiledWorkspaceUrl = new URL(workspaceUrl);
  profiledWorkspaceUrl.searchParams.set("fullmagReactProfiler", "1");
  await page.goto(profiledWorkspaceUrl.toString(), { waitUntil: "domcontentloaded" });
  await page.getByText("Explorer").first().waitFor({ state: "visible" });
  await page.getByText("Model").first().click();
  await page.getByRole("button", { name: /command search/i }).first().click();
  await page.getByPlaceholder("Search commands").fill("Add Microstrip Antenna");
  await page
    .getByRole("option")
    .filter({ hasText: "Add Microstrip Antenna" })
    .first()
    .click();

  const scene = await waitForScene(
    context,
    (next) => next.objects?.some((object) => object?.role === "antenna"),
    "microstrip antenna authoring",
  );
  const resolved = assertAntennaScene(scene);
  const nodeIds = antennaExplorerNodeIds(
    resolved.objectId,
    resolved.portId,
    resolved.stageId,
  );
  await page.getByTitle("Expand All").click();
  await installAntennaResultFixtures(
    page,
    resolved,
    created.session ?? created,
  );

  await selectNode(page, nodeIds.conductor);
  await page.getByText("Antenna conductor").first().waitFor({ state: "visible" });
  const conductorPanel = page.locator(".fm-inspector-panel").filter({ hasText: "Antenna conductor" }).first();
  const conductorRoot = await conductorPanel.elementHandle();
  const firstWidth = conductorPanel.getByRole("textbox", { name: "Station 1 signal width" });
  const secondWidth = conductorPanel.getByRole("textbox", { name: "Station 2 signal width" });
  const saveWidths = conductorPanel.getByRole("button", { name: "Save width stations" });
  const inspectorViewport = page.locator(".fm-inspector__content .fm-scroll-area__viewport");
  const initialScroll = await inspectorViewport.evaluate((element) => {
    element.style.maxHeight = "180px";
    element.scrollTop = 40;
    return element.scrollTop;
  });
  if (initialScroll <= 0) throw new Error("Inspector scroll preservation probe did not scroll.");
  await page.evaluate(() => performance.clearMeasures());
  let geometryPatchRequests = 0;
  let sceneResourceRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/v2/sessions/current/model/scene") sceneResourceRequests += 1;
  });
  await page.route(`${apiBase}/v2/sessions/current/model/transactions`, async (route) => {
    if (route.request().postDataJSON()?.kind === "patch_object_geometry") {
      geometryPatchRequests += 1;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    await route.continue();
  });
  await firstWidth.fill("60e-9");
  await saveWidths.click();
  if (!await saveWidths.isDisabled() || await secondWidth.isDisabled()) {
    throw new Error("Antenna Inspector disabled unrelated controls incorrectly during geometry ACK.");
  }
  const pendingAppearance = await secondWidth.evaluate((element) => ({
    opacity: getComputedStyle(element).opacity,
    opacityAnimation: element.getAnimations().some((animation) =>
      typeof animation.effect?.getKeyframes === "function" &&
      animation.effect.getKeyframes().some((frame) => "opacity" in frame)),
  }));
  if (pendingAppearance.opacity !== "1" || pendingAppearance.opacityAnimation) {
    throw new Error(`Unrelated station field was dimmed or animated during ACK: ${JSON.stringify(pendingAppearance)}`);
  }
  const pendingStable = await conductorRoot?.evaluate((element) =>
    element.isConnected && element === document.querySelector(".fm-inspector-panel"));
  if (!pendingStable) throw new Error("Antenna Inspector remounted during geometry mutation.");
  if (await inspectorViewport.evaluate((element) => element.scrollTop) !== initialScroll ||
      !await saveWidths.evaluate((element) => document.activeElement === element)) {
    throw new Error("Antenna Inspector lost scroll or focus while geometry mutation was pending.");
  }
  const editedScene = await waitForScene(
    context,
    (next) => next.objects?.find((object) => object.id === resolved.objectId)
      ?.geometry?.geometry_params?.stations?.[0]?.signal_width_m === 60e-9,
    "committed microstrip width station",
  );
  await conductorPanel.getByText("Width stations committed").waitFor({ state: "visible" });
  const acknowledgedStable = await conductorRoot?.evaluate((element) =>
    element.isConnected && element === document.querySelector(".fm-inspector-panel"));
  if (!acknowledgedStable || geometryPatchRequests !== 1 ||
      editedScene.objects.find((object) => object.id === resolved.objectId)
        ?.geometry?.geometry_params?.return_width_m !== 500e-9) {
    throw new Error("Microstrip width edit lost Inspector identity, issued duplicate writes, or altered return width.");
  }
  const acknowledgedScroll = await inspectorViewport.evaluate((element) => element.scrollTop);
  const inspectorRenderCount = await page.evaluate(() => performance.getEntriesByType("measure")
    .filter((entry) => entry.name.startsWith("fullmag.react.render.InspectorModule")).length);
  const acknowledgedAppearance = await secondWidth.evaluate((element) => ({
    opacity: getComputedStyle(element).opacity,
    opacityAnimation: element.getAnimations().some((animation) =>
      typeof animation.effect?.getKeyframes === "function" &&
      animation.effect.getKeyframes().some((frame) => "opacity" in frame)),
  }));
  if (acknowledgedScroll !== initialScroll || sceneResourceRequests > 8 || inspectorRenderCount > 8 ||
      !await saveWidths.evaluate((element) => document.activeElement === element) ||
      acknowledgedAppearance.opacity !== "1" || acknowledgedAppearance.opacityAnimation) {
    throw new Error("Antenna Inspector lost scroll/focus, dimmed a station, or issued unbounded requests after ACK.");
  }
  await selectNode(page, nodeIds.port);
  await page.getByText(`Antenna port ${resolved.portId}`).waitFor({ state: "visible" });
  await selectNode(page, nodeIds.solution);
  const solutionPanel = page
    .locator(".fm-inspector-panel")
    .filter({ hasText: "Antenna field solve" })
    .first();
  await solutionPanel.waitFor({ state: "visible" });
  await solutionPanel.getByText("Runtime result", { exact: true }).waitFor({ state: "visible" });
  await solutionPanel.getByText(/requires a mesh-exact ConservativeCurrentView/)
    .waitFor({ state: "visible", timeout: timeoutMs });
  const solutionText = await solutionPanel.textContent();
  for (const expected of [
    "Stage catalog result",
    "authoring invalid",
    "H_ant_basis",
    "requires a mesh-exact ConservativeCurrentView",
  ]) {
    if (!solutionText?.includes(expected)) {
      throw new Error(`Antenna solution Inspector is missing ${expected}.`);
    }
  }
  if (solutionText?.includes("Published solution") || unexpectedPayloadRequests.length > 0) {
    throw new Error(`Invalid antenna authoring exposed a published field: ${JSON.stringify(unexpectedPayloadRequests)}`);
  }

  const webgl = await readWebglHealth(page);
  const expectedHttpErrors = httpErrors.filter(isExpectedScratchHttpError);
  const unexpectedHttpErrors = httpErrors.filter(
    (entry) => !isExpectedScratchHttpError(entry),
  );
  const expectedRequestFailures = requestFailures.filter(isExpectedAntennaRequestFailure);
  const unexpectedRequestFailures = requestFailures.filter(
    (entry) => !isExpectedAntennaRequestFailure(entry),
  );
  const unexpectedRuntimeErrors = runtimeErrors.filter(
    (message) => !message.startsWith("Failed to load resource:"),
  );
  if (
    unexpectedRuntimeErrors.length ||
    unexpectedHttpErrors.length ||
    unexpectedRequestFailures.length
  ) {
    throw new Error(
      `Antenna browser errors: ${JSON.stringify({
        unexpectedRuntimeErrors,
        unexpectedHttpErrors,
        expectedHttpErrors,
        expectedRequestFailures,
        unexpectedRequestFailures,
      })}`,
    );
  }
  if (
    webgl.visible_canvas_count === 0 ||
    !webgl.drawing_buffer_nonzero ||
    webgl.context_lost
  ) {
    throw new Error(`Antenna WebGL health failed: ${JSON.stringify(webgl)}`);
  }

  const manifest = {
    schema: "antenna-authoring-ui.v1",
    scope: "authoring-inspector",
    backend,
    session_id: created.session?.session_id ?? created.session_id ?? null,
    scene_revision: editedScene.revision ?? null,
    resolved,
    checks: {
      authored_conductor: true,
      width_station_committed: true,
      conductor_inspector_stable_through_ack: true,
      unrelated_width_control_enabled_during_ack: true,
      no_unrelated_opacity_change_or_animation: true,
      conductor_scroll_and_focus_preserved: true,
      scene_resource_requests_bounded: sceneResourceRequests <= 8,
      inspector_render_count_bounded: inspectorRenderCount <= 8,
      authored_port: true,
      authored_field_solve: true,
      fixture_stage_output_catalog_served: true,
      incomplete_field_solve_rejected: true,
      invalid_field_preview_suppressed: true,
      webgl_visible_canvas: webgl.visible_canvas_count > 0,
      webgl_drawing_buffer_nonzero: webgl.drawing_buffer_nonzero,
      webgl_context_not_lost: !webgl.context_lost,
    },
    webgl,
    expected_http_errors: expectedHttpErrors,
    expected_request_failures: expectedRequestFailures,
    unexpected_payload_requests: unexpectedPayloadRequests,
    note:
      "This smoke checks that the incomplete microstrip draft cannot display a mocked result as current. It does not execute the native antenna solve, Relax, LLG, export/reload, stale/reuse, FFT, or field-map lifecycle.",
  };
  await mkdir(evidenceDir, { recursive: true });
  const screenshotPath = resolve(evidenceDir, `${backend}-authoring-inspector.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  manifest.screenshot = screenshotPath;
  const manifestPath = resolve(evidenceDir, `${backend}-authoring-inspector.manifest.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  manifest.manifest = manifestPath;
  console.log(JSON.stringify(manifest, null, 2));
} catch (error) {
  exitCode = 1;
  console.error(error instanceof Error ? error.stack ?? error.message : error);
} finally {
  await Promise.allSettled([context?.close(), browser?.close()]);
}

process.exitCode = exitCode;
