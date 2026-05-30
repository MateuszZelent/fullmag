import { inflateSync } from "node:zlib";

const url = process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const apiBase =
  process.env.CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_RUNTIME_HTTP_BASE ??
  process.env.NEXT_PUBLIC_API_URL ??
  null;
const allowMissingSession =
  process.env.CONTROL_ROOM_SCREENSHOT_ALLOW_MISSING_SESSION === "1";
const defaultRequiredScenes = allowMissingSession ? "fdm" : "fdm,fem,object";
const requiredScenes = new Set(
  (process.env.CONTROL_ROOM_SCREENSHOT_SCENES ?? defaultRequiredScenes)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean),
);
const requiredProfiles = ["interactive", "figure"];
const CANVAS_TOP_OVERLAY_EXCLUSION_PX = 48;

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
    "Viewport 3D screenshot gate requires Playwright or @playwright/test in the current environment.",
  );
  process.exit(2);
}

const browser = await playwright.chromium.launch();
const page = await browser.newPage({
  viewport: { height: 900, width: 1440 },
});
const errors = [];
const missingSessionFixtureRequests = [];

if (allowMissingSession) {
  await installFdmFixtureApi(page, missingSessionFixtureRequests);
}

if (apiBase || allowMissingSession) {
  await page.addInitScript(({ allowMissingSessionSmoke, baseUrl }) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      ...(baseUrl ? { controlRoomApiBase: baseUrl } : {}),
      ...(allowMissingSessionSmoke ? { allowMissingSessionSmoke: true } : {}),
    };
  }, { allowMissingSessionSmoke: allowMissingSession, baseUrl: apiBase });
}

page.on("console", (message) => {
  if (message.type() === "error") {
    const text = message.text();
    if (isIgnorableConsoleError(text)) return;
    errors.push(text);
  }
});
page.on("pageerror", (error) => {
  errors.push(error.message);
});
page.on("response", (response) => {
  const status = response.status();
  if (status < 400 || isAllowedMissingSessionResponse(response.url(), status)) {
    return;
  }
  errors.push(`${status} ${response.url()}`);
});

try {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const viewport = page.locator(".fm-viewport-3d");
  const canvas = page.locator(".fm-viewport-3d canvas");
  await canvas.waitFor({ state: "visible", timeout: 15_000 });
  await waitForCanvasReady(canvas);

  const detectedScene = await detectScene(viewport);
  if (requiredScenes.has("object")) {
    await ensureObjectScene(page, viewport);
  }
  const detectedScenes = new Set([detectedScene]);
  if ((await primitiveObjectCount(viewport)) > 0) detectedScenes.add("object");
  let fdmFixtureDelta = null;
  if (requiredScenes.has("fdm") && !detectedScenes.has("fdm")) {
    fdmFixtureDelta = await verifyFdmFixtureScene(browser);
    detectedScenes.add("fdm");
  }

  for (const scene of requiredScenes) {
    if (!detectedScenes.has(scene)) {
      throw new Error(
        `Required screenshot scene '${scene}' is not available. Detected scenes: ${[
          ...detectedScenes,
        ].join(", ")}`,
      );
    }
  }

  const dimensionFrameDelta = await enableDimensionFrameCage(page, canvas);
  const captures = [];
  for (const profile of requiredProfiles) {
    await setVisualProfile(page, viewport, profile);
    const sample = await sampleCanvasComposite(page, canvas);
    if (!sample.nonBlank) {
      throw new Error(
        `Viewport 3D ${profile} screenshot is blank: ${sample.variedPixels}/${sample.sampledPixels} sampled pixels differ from background.`,
      );
    }
    captures.push({ profile, sample });
  }

  const delta = canvasCompositeDifference(captures[0].sample, captures[1].sample);
  if (!delta.changed) {
    throw new Error(
      `Viewport 3D interactive/figure screenshots are too similar: ${delta.changedPixels}/${delta.sampledPixels} changed sampled pixels, minimum ${delta.minimumChangedPixels}.`,
    );
  }
  if (errors.length > 0) {
    throw new Error(`Browser console/network errors:\n${errors.join("\n")}`);
  }

  console.log(
    "Viewport 3D screenshot gate passed:",
    `profiles=${requiredProfiles.join(",")}`,
    `scenes=${[...detectedScenes].join(",")}`,
    `changedPixels=${delta.changedPixels}/${delta.sampledPixels}`,
    `dimensionFrameChangedPixels=${dimensionFrameDelta.changedPixels}/${dimensionFrameDelta.sampledPixels}`,
    fdmFixtureDelta
      ? `fdmFixtureChangedPixels=${fdmFixtureDelta.changedPixels}/${fdmFixtureDelta.sampledPixels}`
      : "fdmFixture=live",
  );
} finally {
  await browser.close();
}

async function verifyFdmFixtureScene(browser) {
  const page = await browser.newPage({
    viewport: { height: 900, width: 1440 },
  });
  const errors = [];
  const fixtureRequests = [];

  await installFdmFixtureApi(page, fixtureRequests);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status >= 400) errors.push(`${status} ${response.url()}`);
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const viewport = page.locator(".fm-viewport-3d");
    const canvas = page.locator(".fm-viewport-3d canvas");
    await canvas.waitFor({ state: "visible", timeout: 15_000 });
    await waitForCanvasReady(canvas);
    try {
      await page.waitForFunction(
        () => {
          const summary = document
            .querySelector(".fm-viewport-3d__hud span:nth-child(3)")
            ?.textContent?.trim();
          return /^\d+\/\d+$/.test(summary ?? "");
        },
        null,
        { timeout: 10_000 },
      );
    } catch (error) {
      const summary = await viewport
        .locator(".fm-viewport-3d__hud span")
        .nth(2)
        .textContent()
        .catch(() => "missing");
      const hudText = await viewport
        .locator(".fm-viewport-3d__hud")
        .textContent()
        .catch(() => "missing");
      throw new Error(
        `Timed out waiting for FDM fixture HUD. hud=${hudText}; summary=${summary}; errors=${errors.join(" | ") || "none"}; requests=${[
          ...new Set(fixtureRequests),
        ].join(", ") || "none"}; cause=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const detectedScene = await detectScene(viewport);
    if (detectedScene !== "fdm") {
      throw new Error(`FDM fixture rendered '${detectedScene}' instead of 'fdm'.`);
    }

    const dimensionFrameDelta = await enableDimensionFrameCage(page, canvas);
    const captures = [];
    for (const profile of requiredProfiles) {
      await setVisualProfile(page, viewport, profile);
      const sample = await sampleCanvasComposite(page, canvas);
      if (!sample.nonBlank) {
        throw new Error(
          `FDM fixture ${profile} screenshot is blank: ${sample.variedPixels}/${sample.sampledPixels} sampled pixels differ from background.`,
        );
      }
      captures.push({ profile, sample });
    }

    const delta = canvasCompositeDifference(
      captures[0].sample,
      captures[1].sample,
    );
    if (!delta.changed) {
      throw new Error(
        `FDM fixture interactive/figure screenshots are too similar: ${delta.changedPixels}/${delta.sampledPixels} changed sampled pixels, minimum ${delta.minimumChangedPixels}.`,
      );
    }
    if (errors.length > 0) {
      throw new Error(`FDM fixture browser console/network errors:\n${errors.join("\n")}`);
    }
    return {
      changedPixels: delta.changedPixels,
      dimensionFrameChangedPixels: dimensionFrameDelta.changedPixels,
      dimensionFrameSampledPixels: dimensionFrameDelta.sampledPixels,
      sampledPixels: delta.sampledPixels,
    };
  } finally {
    await page.close();
  }
}

async function installFdmFixtureApi(page, fixtureRequests) {
  const fixtureBase = apiBase ?? "http://localhost:8081";
  await page.addInitScript((baseUrl) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      allowMissingSessionSmoke: true,
      controlRoomApiBase: baseUrl,
    };
  }, fixtureBase);

  await page.route("**/v2/sessions/current/**", async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    fixtureRequests.push(`${request.method()} ${requestUrl.pathname}`);
    if (request.method() === "OPTIONS") {
      await fulfillEmpty(route, 204);
      return;
    }

    const path = requestUrl.pathname;
    if (path === "/v2/sessions/current/status") {
      await fulfillJson(route, fdmStatusFixture());
      return;
    }
    if (path === "/v2/sessions/current/visualization/state") {
      await fulfillJson(route, fdmVisualizationStateFixture());
      return;
    }
    if (path === "/v2/sessions/current/data/domain/meta") {
      await fulfillJson(route, fdmDomainMetaFixture());
      return;
    }
    if (path === "/v2/sessions/current/data/domain/topology") {
      await fulfillEmpty(route, 204);
      return;
    }
    if (path === "/v2/sessions/current/data/fields/m/samples/vector") {
      await fulfillBinary(route, makeFdmFieldVectorBuffer());
      return;
    }
    if (path === "/v2/sessions/current/model/scene") {
      await fulfillJson(route, { objects: [], revision: 0, schema_version: 1 });
      return;
    }
    if (path === "/v2/sessions/current/model/universe") {
      await fulfillJson(route, {
        mesh_dirty: false,
        object_bounds_max: [6e-7, 4e-7, 1e-7],
        object_bounds_min: [-6e-7, -4e-7, -1e-7],
        scene_revision: 0,
        study_universe_mesh: null,
        universe: null,
      });
      return;
    }
    if (path === "/v2/sessions/current/meshing/meshes/shared-domain/manifest") {
      await fulfillEmpty(route, 204);
      return;
    }

    await fulfillEmpty(route, 204);
  });
}

async function ensureObjectScene(page, viewport) {
  if ((await primitiveObjectCount(viewport)) > 0) return;

  await page.getByRole("tab", { name: "Geometry" }).click();
  const addBox = page.locator('[data-action-id="geometry.add-box"]');
  await addBox.waitFor({ state: "visible", timeout: 20_000 });
  await addBox.click();

  const draftName = page.locator('.fm-inspector-panel input[aria-label="Name"]').first();
  await draftName.waitFor({ state: "visible", timeout: 20_000 });
  await fillDraftInput(draftName, `Screenshot Box ${Date.now().toString(36)}`);
  await fillDraftField(page, "X", "9e-7");
  await fillDraftField(page, "Y", "7e-7");
  await fillDraftField(page, "Z", "1e-7");
  await fillDraftField(page, "TX", "-1.6e-6");

  await page
    .locator(".fm-inspector-panel button")
    .filter({ hasText: "Apply Draft" })
    .first()
    .click();

  await page.waitForFunction(
    () => {
      const value = document
        .querySelector(".fm-viewport-3d")
        ?.getAttribute("data-primitive-object-count");
      return Number(value ?? 0) > 0;
    },
    null,
    { timeout: 20_000 },
  );
}

async function setVisualProfile(page, viewport, profile) {
  if ((await viewport.getAttribute("data-visual-profile-id")) === profile) return;

  await page.getByRole("tab", { exact: true, name: "View" }).click({ force: true });
  await page.locator('[data-action-id="view-render-quality"]').click({ force: true });
  await page
    .getByRole("menuitemradio", { exact: true, name: profileLabel(profile) })
    .click();
  await page.waitForFunction(
    (expected) =>
      document
        .querySelector(".fm-viewport-3d")
        ?.getAttribute("data-visual-profile-id") === expected,
    profile,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(120);
}

async function enableDimensionFrameCage(page, canvas) {
  const commandId = "viewport-3d.dimension-frame-cage";
  const baseline = await sampleCanvasComposite(page, canvas);
  await page.getByRole("tab", { exact: true, name: "View" }).click({ force: true });
  await page
    .locator('[data-action-id="view-dimension-frame"]')
    .click({ force: true });
  await page
    .getByRole("menuitemradio", { exact: true, name: "Floor + vertical" })
    .click();
  const changed = await waitForCanvasCompositeChange(
    page,
    canvas,
    baseline,
    "dimension frame screenshot renders after cage mode",
    "Viewport screenshot canvas did not visually change after enabling dimension frame cage",
  );
  const delta = canvasCompositeDifference(baseline, changed);
  console.log(
    `Viewport 3D dimension frame screenshot passed (command=${commandId}, changedPixels=${delta.changedPixels}/${delta.sampledPixels}).`,
  );
  return delta;
}

async function waitForCanvasCompositeChange(
  page,
  canvas,
  baseline,
  label,
  failureMessage,
) {
  const deadline = Date.now() + 10_000;
  let lastDelta = null;
  while (Date.now() <= deadline) {
    const current = await sampleCanvasComposite(page, canvas);
    if (!current.nonBlank) {
      throw new Error(
        `${failureMessage}: viewport is blank (${current.variedPixels}/${current.sampledPixels} sampled pixels differ from background).`,
      );
    }
    const delta = canvasCompositeDifference(baseline, current);
    if (delta.changed) return current;
    lastDelta = delta;
    await page.waitForTimeout(100);
  }

  const suffix = lastDelta
    ? `${lastDelta.changedPixels}/${lastDelta.sampledPixels} sampled pixels changed; threshold=${lastDelta.minimumChangedPixels}`
    : "no canvas sample was collected";
  throw new Error(`${label} timed out. ${failureMessage}: ${suffix}.`);
}

function profileLabel(profile) {
  if (profile === "figure") return "Figure";
  if (profile === "interactive") return "Interactive";
  if (profile === "interactive-lite") return "Interactive Lite";
  return profile;
}

async function primitiveObjectCount(viewport) {
  const value = await viewport.getAttribute("data-primitive-object-count");
  return Number(value ?? 0);
}

async function detectScene(viewport) {
  const summary = await viewport.locator(".fm-viewport-3d__hud span").nth(2).textContent();
  if (/^\d+\/\d+$/.test(summary ?? "")) return "fdm";
  if (/^\d+\+\d+$/.test(summary ?? "")) return "fem";
  return "unknown";
}

async function waitForCanvasReady(canvas) {
  await canvas.evaluate((node) =>
    new Promise((resolve) => {
      const deadline = performance.now() + 5_000;
      const tick = () => {
        const rect = node.getBoundingClientRect();
        if ((rect.width > 0 && rect.height > 0) || performance.now() > deadline) {
          resolve(undefined);
          return;
        }
        requestAnimationFrame(tick);
      };
      tick();
    }),
  );
}

async function fillDraftInput(locator, value) {
  await locator.fill("");
  await locator.fill(value);
  await locator.evaluate((node) => {
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
    node.blur();
  });
}

async function fillDraftField(page, label, value) {
  const input = page.locator(`.fm-inspector-panel input[aria-label="${label}"]`).first();
  await input.waitFor({ state: "visible", timeout: 20_000 });
  await fillDraftInput(input, value);
}

async function sampleCanvasComposite(page, canvas) {
  const box = await canvas.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { height: rect.height, width: rect.width, x: rect.x, y: rect.y };
  });
  const background = await canvas.evaluate((node) => {
    const viewport = node.closest(".fm-viewport-3d");
    return viewport ? getComputedStyle(viewport).backgroundColor : "";
  });
  const backgroundRgb = parseCssRgb(background);
  const png = await page.screenshot({
    clip: {
      height: Math.max(
        1,
        Math.floor(box.height - CANVAS_TOP_OVERLAY_EXCLUSION_PX),
      ),
      width: Math.max(1, Math.floor(box.width)),
      x: Math.max(0, Math.floor(box.x)),
      y: Math.max(0, Math.floor(box.y + CANVAS_TOP_OVERLAY_EXCLUSION_PX)),
    },
  });
  const bitmap = parsePng(png);
  const stride = Math.max(1, Math.floor(Math.min(bitmap.width, bitmap.height) / 64));
  const signature = [];
  let sampledPixels = 0;
  let variedPixels = 0;

  for (let y = 0; y < bitmap.height; y += stride) {
    for (let x = 0; x < bitmap.width; x += stride) {
      sampledPixels += 1;
      const offset = (y * bitmap.width + x) * 4;
      const rgb = [
        bitmap.rgba[offset],
        bitmap.rgba[offset + 1],
        bitmap.rgba[offset + 2],
      ];
      signature.push(...rgb);
      if (pixelDiffers(rgb, backgroundRgb)) variedPixels += 1;
    }
  }

  return {
    nonBlank: variedPixels > 0,
    sampledPixels,
    signature,
    variedPixels,
  };
}

function canvasCompositeDifference(before, after) {
  const length = Math.min(before.signature.length, after.signature.length);
  let changedPixels = 0;
  for (let offset = 0; offset < length; offset += 3) {
    const delta =
      Math.abs(before.signature[offset] - after.signature[offset]) +
      Math.abs(before.signature[offset + 1] - after.signature[offset + 1]) +
      Math.abs(before.signature[offset + 2] - after.signature[offset + 2]);
    if (delta > 18) changedPixels += 1;
  }

  const sampledPixels = Math.floor(length / 3);
  const minimumChangedPixels = Math.max(6, Math.floor(sampledPixels * 0.003));
  return {
    changed: changedPixels >= minimumChangedPixels,
    changedPixels,
    minimumChangedPixels,
    sampledPixels,
  };
}

async function fulfillJson(route, body, status = 200) {
  await route.fulfill({
    body: JSON.stringify(body),
    headers: fixtureHeaders({ "content-type": "application/json" }),
    status,
  });
}

async function fulfillBinary(route, arrayBuffer, status = 200) {
  await route.fulfill({
    body: Buffer.from(arrayBuffer),
    headers: fixtureHeaders({
      "content-type": "application/octet-stream",
      etag: '"fdm-fixture"',
    }),
    status,
  });
}

async function fulfillEmpty(route, status = 204) {
  await route.fulfill({
    body: "",
    headers: fixtureHeaders(),
    status,
  });
}

function fixtureHeaders(extra = {}) {
  return {
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "x-api-contract-version,etag,x-request-id",
    "x-api-contract-version": "1.0.0",
    ...extra,
  };
}

function fdmStatusFixture() {
  return {
    api_contract_version: "1.0.0",
    capabilities: {
      algorithms_available: [],
      binary_fields: true,
      cell_fields: true,
      eigen_modes: false,
      explicit_topology: false,
      gpu_telemetry: false,
      node_fields: false,
      preview_2d: false,
      preview_3d: true,
      scalar_history: false,
      structured_grid: true,
    },
    display: {
      active_quantity_id: "m",
      auto_contrast: true,
      colormap: "viridis",
      contrast_max: null,
      contrast_min: null,
      field_component: "magnitude",
      max_points: 120000,
      slice_layer: 0,
      slice_mode: "xy",
      vector_density: 2,
      vector_glyphs: true,
      view_mode: "3d",
      x_chosen_size: 1,
      y_chosen_size: 1,
    },
    domain: {
      cell_count: 192,
      discretization: "fdm",
      generation_id: 1,
    },
    energies: {},
    metrics: {
      steps_per_second: null,
      total_steps: 0,
      uptime_seconds: 0,
    },
    resources: {
      artifact_revision: 0,
      artifacts_revision: 0,
      command_completion_revision: 0,
      commands_revision: 0,
      display_revision: 1,
      domain_generation_id: 1,
      engine_log_revision: 0,
      field_catalog_revision: 1,
      field_revision: 1,
      fields_revision: 1,
      mesh_build_revision: 0,
      mesh_revision: 0,
      scalars_revision: 0,
      scene_revision: 0,
      slice_revision: 0,
      stages_revision: 0,
      topology_revision: 0,
      visualization_state_revision: 1,
      workspace_revision: 0,
    },
    run: null,
    runtime_bundle_version: "screenshot-fixture",
    session: {
      created_at: "0",
      name: "fdm-screenshot-fixture",
      session_id: "fdm-fixture",
      workspace_root: "/tmp/fullmag-fdm-fixture",
    },
    solver: {
      state: "idle",
    },
  };
}

function fdmDomainMetaFixture() {
  return {
    bounds: {
      max: [6e-7, 4e-7, 1e-7],
      min: [-6e-7, -4e-7, -1e-7],
    },
    coordinate_system: "cartesian",
    counts: { cells: 192 },
    dimension: 3,
    discretization: "fdm",
    domain_id: "fdm-fixture-domain",
    generation_id: 1,
    grid: {
      origin: [-6e-7, -4e-7, -1e-7],
      shape: [12, 8, 2],
      spacing: [1e-7, 1e-7, 1e-7],
    },
    units: { length: "m" },
  };
}

function fdmVisualizationStateFixture() {
  return {
    active_quantity_id: "m",
    auto_contrast: true,
    camera: {
      position: [1.4e-6, 1.0e-6, 8e-7],
      projection: "perspective",
      target: [0, 0, 0],
      up: [0, 0, 1],
    },
    clip: {
      enabled: false,
      normal_axis: "z",
      offset: 0,
    },
    colormap: "viridis",
    contrast_max: null,
    contrast_min: null,
    diagnostics: { warnings: [] },
    domains: {
      active_scope_id: null,
      active_scope_kind: "domain",
    },
    fdm: {
      x_chosen_size: 1,
      y_chosen_size: 1,
    },
    fem: {
      topology_mode: "surface",
      volume_edges_budget: 0,
    },
    field_component: "magnitude",
    layers: {
      bounds: { visible: true },
      points: { visible: false },
      quantity_overlay: { visible: true },
      surface: { opacity: 0.94, visible: true },
      vectors: { density: 2, domain: "full_domain", visible: true },
      wireframe: { visible: true },
    },
    max_points: 120000,
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
    sampling: {
      max_glyphs: 192,
      max_points: 120000,
    },
    schema_version: 1,
    slice: {
      layer: 0,
      mode: "xy",
    },
    slice_layer: 0,
    slice_mode: "xy",
    trim: {
      enabled: false,
      max: [1, 1, 1],
      min: [0, 0, 0],
    },
    vector_density: 2,
    vector_glyphs: true,
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

function makeFdmFieldVectorBuffer() {
  const grid = [12, 8, 2];
  const pointCount = grid[0] * grid[1] * grid[2];
  const valueCount = pointCount * 3;
  const buffer = new ArrayBuffer(48 + valueCount * Float64Array.BYTES_PER_ELEMENT);
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
  new TextEncoder().encodeInto("m", new Uint8Array(buffer, 28, 16));

  const values = new Float64Array(buffer, 48);
  let offset = 0;
  for (let z = 0; z < grid[2]; z += 1) {
    for (let y = 0; y < grid[1]; y += 1) {
      for (let x = 0; x < grid[0]; x += 1) {
        const centeredX = (x - (grid[0] - 1) / 2) / ((grid[0] - 1) / 2);
        const centeredY = (y - (grid[1] - 1) / 2) / ((grid[1] - 1) / 2);
        const twist = z === 0 ? -0.35 : 0.35;
        const length = Math.hypot(centeredX, centeredY, twist) || 1;
        values[offset++] = -centeredY / length;
        values[offset++] = centeredX / length;
        values[offset++] = twist / length;
      }
    }
  }

  return buffer;
}

function parsePng(buffer) {
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("Screenshot is not a PNG image.");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  if (bitDepth !== 8 || interlace !== 0 || ![2, 6].includes(colorType)) {
    throw new Error(
      `Unsupported PNG screenshot format: bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace}.`,
    );
  }

  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const source = inflateSync(Buffer.concat(idat));
  const rowLength = width * bytesPerPixel;
  const raw = Buffer.alloc(height * rowLength);
  let sourceOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = source[sourceOffset];
    sourceOffset += 1;
    const rowOffset = y * rowLength;
    for (let x = 0; x < rowLength; x += 1) {
      const value = source[sourceOffset + x];
      const left = x >= bytesPerPixel ? raw[rowOffset + x - bytesPerPixel] : 0;
      const up = y > 0 ? raw[rowOffset - rowLength + x] : 0;
      const upLeft =
        y > 0 && x >= bytesPerPixel
          ? raw[rowOffset - rowLength + x - bytesPerPixel]
          : 0;
      raw[rowOffset + x] = unfilterPngByte(filter, value, left, up, upLeft);
    }
    sourceOffset += rowLength;
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const sourceIndex = index * bytesPerPixel;
    const targetIndex = index * 4;
    rgba[targetIndex] = raw[sourceIndex];
    rgba[targetIndex + 1] = raw[sourceIndex + 1];
    rgba[targetIndex + 2] = raw[sourceIndex + 2];
    rgba[targetIndex + 3] = colorType === 6 ? raw[sourceIndex + 3] : 255;
  }

  return { height, rgba, width };
}

function unfilterPngByte(filter, value, left, up, upLeft) {
  if (filter === 0) return value;
  if (filter === 1) return (value + left) & 255;
  if (filter === 2) return (value + up) & 255;
  if (filter === 3) return (value + Math.floor((left + up) / 2)) & 255;
  if (filter === 4) return (value + paeth(left, up, upLeft)) & 255;
  throw new Error(`Unsupported PNG filter: ${filter}.`);
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}

function parseCssRgb(value) {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match) return [0, 0, 0];
  const channels = match[1].split(",").map((channel) => Number(channel.trim()));
  return [
    Number.isFinite(channels[0]) ? channels[0] : 0,
    Number.isFinite(channels[1]) ? channels[1] : 0,
    Number.isFinite(channels[2]) ? channels[2] : 0,
  ];
}

function pixelDiffers(rgb, backgroundRgb) {
  return rgb.some((channel, index) => Math.abs(channel - backgroundRgb[index]) > 8);
}

function isIgnorableConsoleError(text) {
  if (
    allowMissingSession &&
    text === "Failed to load resource: the server responded with a status of 404 (Not Found)"
  ) {
    return true;
  }

  return (
    allowMissingSession &&
    text.includes("/v2/sessions/current/events/ws") &&
    text.includes("Unexpected response code: 404")
  );
}

function isAllowedMissingSessionResponse(responseUrl, status) {
  if (!allowMissingSession || status !== 404) {
    return false;
  }

  try {
    return new URL(responseUrl).pathname.startsWith("/v2/sessions/current/");
  } catch {
    return false;
  }
}
