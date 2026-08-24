import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const SCRATCH_AUTHORING_SCHEMA = "scratch-authoring-browser.v1";
export const SCRATCH_AUTHORING_MAX_REQUESTS = 500;
export const SCRATCH_AUTHORING_MAX_RENDER_MUTATIONS = 2500;
export const DEFAULT_COMMAND_POLL_DELAYS_MS = [
  0,
  100,
  250,
  500,
  750,
  1000,
  ...Array.from({ length: 30 }, () => 2000),
];
export const DEFAULT_SCRATCH_WORKSPACE_URL =
  process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:3100/workspace";
export const DEFAULT_SCRATCH_API_BASE =
  process.env.CONTROL_ROOM_API_BASE ?? new URL(DEFAULT_SCRATCH_WORKSPACE_URL).origin;

const requestCounters = new WeakMap();

export function finiteSceneRevision(scene) {
  const value = scene?.scene_revision ?? scene?.revision;
  const revision = Number(value);
  if (!Number.isFinite(revision)) {
    throw new Error("Scene response does not expose a finite scene revision.");
  }
  return revision;
}

export function scratchApiUrl(apiBase, path) {
  return new URL(path, apiBase).toString();
}

export function buildScratchObjectTransaction(fixture, baseRevision) {
  const object = fixture.object;
  return {
    kind: "create_object",
    base_revision: baseRevision,
    object_id: object.id,
    name: object.name,
    region_name: object.region_name ?? object.name,
    geometry: {
      geometry_kind: object.geometry.kind,
      geometry_params: object.geometry.params,
    },
    transform: {
      rotation_quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
      translation: [0, 0, 0],
      pivot: [0, 0, 0],
    },
  };
}

export function buildScratchMaterialTransaction(fixture, baseRevision) {
  const material = fixture.material;
  return {
    kind: "create_material",
    base_revision: baseRevision,
    material_id: material.id,
    name: material.name,
    properties: {
      Ms: material.Ms,
      Aex: material.Aex,
      alpha: material.alpha,
      Dind: material.Dind ?? null,
      Dbulk: material.Dbulk ?? null,
    },
    references: [],
  };
}

export function buildScratchTextureTransaction(fixture, baseRevision) {
  const texture = fixture.texture;
  return {
    kind: "patch_magnetization",
    base_revision: baseRevision,
    object_id: fixture.object.id,
    magnetization_ref: texture.id,
    asset: {
      id: texture.id,
      name: texture.name,
      kind: "preset_texture",
      mapping: {
        space: "object",
        projection: "object_local",
        clamp_mode: "none",
      },
      texture_transform: {
        translation: [0, 0, 0],
        rotation_quat: [0, 0, 0, 1],
        scale: [1, 1, 1],
        pivot: [0, 0, 0],
      },
      preset_kind: texture.preset_kind,
      preset_params: texture.preset_params,
      preset_version: texture.preset_version ?? 1,
      ui_label: texture.name,
    },
  };
}

export function buildScratchStudyPatch(fixture, baseRevision) {
  const study = {
    requested_backend: fixture.backend,
    requested_device: "cpu",
    requested_mode: "strict",
    requested_precision: "double",
    exchange_enabled: true,
    demag_enabled: true,
    external_field: null,
    solver: {
      integrator: "heun",
      fixed_timestep: String(fixture.study.fixed_timestep),
    },
    stages: [
      {
        kind: "relax",
        entrypoint_kind: "flat_relax",
        stage_id: "relax-scratch",
        algorithm: "llg_overdamped",
        max_steps: String(fixture.study.max_steps),
        torque_tolerance: String(fixture.study.torque_tolerance),
        fixed_timestep: String(fixture.study.fixed_timestep),
      },
    ],
  };
  if (fixture.backend === "fdm") {
    study.fdm = {
      default_cell: fixture.grid.default_cell,
      per_magnet: fixture.grid.per_magnet,
      demag: { strategy: "multilayer_convolution", mode: "auto", explain: true },
    };
  }
  if (fixture.backend === "fem") {
    study.universe_mesh = fixture.universe;
    study.shared_domain_mesh = fixture.mesh;
    study.mesh_defaults = fixture.mesh;
  }
  return {
    kind: "merge_patch",
    base_revision: baseRevision,
    merge_patch: {
      study,
      ...(fixture.backend === "fem"
        ? {
            universe: fixture.universe,
          }
        : {}),
    },
  };
}

export function buildScratchInteractionPatch(baseRevision) {
  return {
    base_revision: baseRevision,
    enabled: true,
    present: true,
    params: {},
  };
}

export function sceneAuthoringSummary(scene, fixture) {
  const object = scene?.objects?.find((entry) => entry.id === fixture.object.id);
  const material = scene?.materials?.find((entry) => entry.id === fixture.material.id);
  const texture = scene?.magnetization_assets?.find((entry) => entry.id === fixture.texture.id);
  const texturePayload = texture?.asset ?? texture;
  return {
    revision: scene?.revision ?? null,
    object_id: object?.id ?? null,
    material_ref: object?.material_ref ?? null,
    magnetization_ref: object?.magnetization_ref ?? null,
    geometry_kind: object?.geometry?.geometry_kind ?? null,
    geometry_params: object?.geometry?.geometry_params ?? null,
    translation: object?.transform?.translation ?? null,
    material_properties: material?.properties ?? null,
    texture_preset_kind: texturePayload?.preset_kind ?? null,
    texture_preset_params: texturePayload?.preset_params ?? null,
    exchange_enabled: scene?.study?.exchange_enabled ?? null,
    demag_enabled: scene?.study?.demag_enabled ?? null,
    stage_ids: Array.isArray(scene?.study?.stages)
      ? scene.study.stages.map((stage) => stage.stage_id)
      : [],
    fdm_grid: scene?.study?.fdm ?? null,
    fem_mesh: scene?.study?.shared_domain_mesh ?? scene?.study?.mesh_defaults ?? null,
    universe: scene?.universe ?? null,
    backend: scene?.study?.requested_backend ?? null,
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function matchesExpectedFields(actual, expected) {
  return Boolean(actual && typeof actual === "object") &&
    Object.entries(expected ?? {}).every(([key, value]) => sameJson(actual[key], value));
}

function materialProperty(properties, key) {
  if (!properties || typeof properties !== "object") return null;
  return properties[key] ?? properties[key.toLowerCase()] ?? null;
}

export function assertScratchScene(scene, fixture) {
  const summary = sceneAuthoringSummary(scene, fixture);
  const failures = [];
  if (summary.object_id !== fixture.object.id) failures.push("object");
  if (summary.material_ref !== fixture.material.id) failures.push("material");
  if (summary.magnetization_ref !== fixture.texture.id) failures.push("texture");
  if (summary.geometry_kind !== fixture.object.geometry.kind) failures.push("geometry kind");
  if (!sameJson(summary.geometry_params, fixture.object.geometry.params)) failures.push("geometry params");
  if (!sameJson(summary.translation, fixture.object.translation)) failures.push("translation");
  for (const [key, expected] of Object.entries(fixture.material)) {
    if (key === "id" || key === "name") continue;
    if (Number(materialProperty(summary.material_properties, key)) !== Number(expected)) failures.push(`material ${key}`);
  }
  if (summary.texture_preset_kind !== fixture.texture.preset_kind) failures.push("texture preset");
  if (!sameJson(summary.texture_preset_params, fixture.texture.preset_params)) failures.push("texture params");
  if (summary.exchange_enabled !== true) failures.push("exchange");
  if (summary.demag_enabled !== true) failures.push("demag");
  if (!summary.stage_ids.includes("relax-scratch")) failures.push("relax stage");
  if (summary.backend !== fixture.backend) failures.push("backend");
  if (fixture.backend === "fdm") {
    if (!sameJson(summary.fdm_grid?.default_cell, fixture.grid.default_cell)) failures.push("FDM default cell");
    const perMagnetGrid = summary.fdm_grid?.per_magnet && Object.keys(summary.fdm_grid.per_magnet).length > 0
      ? summary.fdm_grid.per_magnet
      : summary.fdm_grid?.per_object_grid;
    if (!sameJson(perMagnetGrid, fixture.grid.per_magnet)) failures.push("FDM per-magnet cell");
  }
  if (fixture.backend === "fem") {
    if (!matchesExpectedFields(summary.fem_mesh, fixture.mesh)) failures.push("FEM mesh");
    if (!matchesExpectedFields(summary.universe, fixture.universe)) failures.push("airbox");
  }
  if (failures.length > 0) {
    throw new Error(`Scratch SceneDocument is incomplete: ${failures.join(", ")}`);
  }
  return summary;
}

export function webglHealthFromCanvasRecords(records) {
  const visible = records.filter((record) => record.visible);
  const healthy = visible.filter(
    (record) => !record.contextLost && record.drawingBufferWidth > 0 && record.drawingBufferHeight > 0,
  );
  return {
    visible_canvas_count: visible.length,
    healthy_canvas_count: healthy.length,
    context_lost: visible.some((record) => record.contextLost),
    drawing_buffer_nonzero: healthy.length > 0,
    records,
  };
}

export async function canvasHealth(page) {
  const records = await page.evaluate(() =>
    [...document.querySelectorAll("canvas")].map((canvas) => {
      const rect = canvas.getBoundingClientRect();
      const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      return {
        visible: rect.width > 0 && rect.height > 0,
        contextLost: context?.isContextLost?.() ?? false,
        drawingBufferWidth: context?.drawingBufferWidth ?? 0,
        drawingBufferHeight: context?.drawingBufferHeight ?? 0,
      };
    }),
  );
  return webglHealthFromCanvasRecords(records);
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    return await import("@playwright/test");
  }
}

async function requestJson(request, url, options = {}) {
  const counter = requestCounters.get(request);
  if (counter) counter.count += 1;
  const response = await request.fetch(url, {
    method: options.method ?? "GET",
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    data: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!response.ok()) {
    const error = new Error(`${options.method ?? "GET"} ${url} failed with ${response.status()}`);
    error.status = response.status();
    error.body = body;
    throw error;
  }
  return body;
}

export function commandStatusKind(detail) {
  return String(detail?.status || detail?.completion_status || "").toLowerCase();
}

export function publishedMeshRevision(detail) {
  const invalidation = (detail?.resource_invalidations ?? []).find((entry) => {
    const key = String(entry?.resource_key ?? "");
    return (
      key === "meshing/shared-domain/manifest" ||
      key === "data/domain/topology" ||
      (key.startsWith("meshing/objects/") && key.endsWith("/topology"))
    );
  });
  const revision = Number(invalidation?.revision);
  return Number.isFinite(revision) ? revision : null;
}

export async function awaitCommandTerminal(
  request,
  apiBase,
  commandId,
  { pollDelaysMs = DEFAULT_COMMAND_POLL_DELAYS_MS, baseMeshRevision = null } = {},
) {
  let lastDetail = null;
  for (const delay of pollDelaysMs) {
    if (delay > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
    const detail = await requestJson(
      request,
      scratchApiUrl(apiBase, `/v2/sessions/current/simulation/commands/${encodeURIComponent(commandId)}`),
    );
    lastDetail = detail;
    const status = commandStatusKind(detail);
    if (status === "failed" || status === "rejected") {
      return {
        detail,
        status: "failed",
        message: detail.error ?? detail.reason ?? `Command ended with ${status}.`,
      };
    }
    if (status === "cancelled") {
      return {
        detail,
        status: "cancelled",
        message: detail.error ?? detail.reason ?? "Command was cancelled.",
      };
    }
    if (status !== "completed") continue;
    if (baseMeshRevision != null) {
      const meshRevision = publishedMeshRevision(detail);
      if (meshRevision == null || meshRevision <= baseMeshRevision) {
        return {
          detail,
          status: "failed",
          message: "Mesh command completed without publishing a newer mesh revision.",
        };
      }
    }
    return { detail, status: "completed" };
  }
  const detail = lastDetail ?? (await requestJson(
    request,
    scratchApiUrl(apiBase, `/v2/sessions/current/simulation/commands/${encodeURIComponent(commandId)}`),
  ));
  return {
    detail,
    status: "timeout",
    message: "Timed out waiting for the command terminal resource.",
  };
}

async function commitTransaction(request, apiBase, transaction) {
  return requestJson(request, scratchApiUrl(apiBase, "/v2/sessions/current/model/transactions"), {
    method: "POST",
    body: transaction,
  });
}

async function runPaletteCommand(page, title) {
  const paletteButton = page.getByRole("button", { name: /command search/i }).first();
  await paletteButton.click();
  const input = page.getByPlaceholder("Search commands");
  await input.fill(title);
  const item = page.getByRole("option").filter({ hasText: title }).first();
  await item.click();
}

async function waitForAuthoringSurface(page, backend, objectId = null) {
  await page.getByText("Explorer").first().waitFor({ state: "visible" });
  await page.getByText("Model").first().click();
  if (!objectId) return;
  await page.getByTitle("Expand All").click();
  await page.locator(`[data-node-id="model:object:${objectId}"]`).click();
  const objectNode = `model:object:${objectId}`;
  await page.locator(`[data-node-id="${objectNode}:geometry"]`).click();
  await page.getByText("Primitive Geometry").first().waitFor({ state: "visible" });
  await page.locator(`[data-node-id="${objectNode}:magnetic-parameters"]`).click();
  await page.getByText("Magnetic Parameters").first().waitFor({ state: "visible" });
  await page.locator(`[data-node-id="${objectNode}:magnetic-texture"]`).click();
  await page.getByText("Magnetic Texture").first().waitFor({ state: "visible" });
  if (backend === "fdm") {
    await page.locator('[data-node-id="model:study"]').click();
    await page.getByText("FDM Grid Preview").first().waitFor({ state: "visible" });
  }
}

async function screenshot(page, evidenceDir, name) {
  const path = resolve(evidenceDir, name);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
  return path;
}

export async function runScratchAuthoringBrowser({
  backend,
  fixture,
  workspaceUrl = DEFAULT_SCRATCH_WORKSPACE_URL,
  apiBase = DEFAULT_SCRATCH_API_BASE,
  evidenceDir = resolve(process.cwd(), ".fullmag/test-results/scratch-authoring"),
  timeoutMs = Number(process.env.CONTROL_ROOM_SCRATCH_AUTHORING_TIMEOUT_MS ?? 120_000),
}) {
  const playwright = await loadPlaywright();
  if (!playwright?.chromium) throw new Error("Playwright Chromium is required for scratch authoring smoke.");
  const executablePath = process.env.CONTROL_ROOM_BROWSER_EXECUTABLE?.trim();
  const browser = await playwright.chromium.launch({
    headless: process.env.CONTROL_ROOM_HEADFUL !== "1",
    ...(executablePath ? { executablePath } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const requestCounter = { count: 0 };
  requestCounters.set(context.request, requestCounter);
  page.setDefaultTimeout(timeoutMs);
  const requests = [];
  const errors = [];
  page.on("request", (request) => {
    if (request.url().includes("/v2/")) requests.push({ method: request.method(), url: request.url() });
  });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await page.addInitScript(({ apiBase: configuredApiBase }) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      controlRoomApiBase: configuredApiBase,
      disableRealtime: false,
    };
    window.__FULLMAG_SCRATCH_RENDER_COUNT__ = 0;
    const observe = () => {
      if (!document.documentElement) return;
      const observer = new MutationObserver(() => {
        window.__FULLMAG_SCRATCH_RENDER_COUNT__ += 1;
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.documentElement) observe();
    else document.addEventListener("DOMContentLoaded", observe, { once: true });
  }, { apiBase });

  try {
    const created = await requestJson(context.request, scratchApiUrl(apiBase, "/v2/sessions"), {
      method: "POST",
      body: {
        name: fixture.session.name,
        backend,
        device: "cpu",
        precision: "double",
        replace_current: true,
      },
    });
    const manifest = {
      schema_version: SCRATCH_AUTHORING_SCHEMA,
      backend,
      session_id: created.session?.session_id ?? created.session_id ?? null,
      revisions: [],
      command_ids: [],
      commands: [],
      screenshots: [],
      request_count: 0,
      page_request_count: 0,
      topology_request_count: 0,
      dom_mutation_count: 0,
      webgl: null,
      errors,
    };

    await page.goto(workspaceUrl, { waitUntil: "domcontentloaded" });
    await waitForAuthoringSurface(page, backend);
    manifest.screenshots.push(await screenshot(page, evidenceDir, `${backend}-01-empty.png`));

    await runPaletteCommand(page, "Add Box");
    await page.getByText("Primitive Geometry").first().waitFor({ state: "visible" });

    let scene = await requestJson(context.request, scratchApiUrl(apiBase, "/v2/sessions/current/model/scene"));
    let revision = finiteSceneRevision(scene);
    manifest.revisions.push(revision);
    if (!scene.objects?.some((object) => object.id === fixture.object.id)) {
      const fallback = buildScratchObjectTransaction(fixture, revision);
      const response = await commitTransaction(context.request, apiBase, fallback);
      scene = response.committed_scene ?? response;
      revision = finiteSceneRevision(response);
      manifest.revisions.push(revision);
    }

    const objectId = fixture.object.id;
    const objectPath = `/v2/sessions/current/model/objects/${encodeURIComponent(objectId)}`;
    const objectGeometryPath = `${objectPath}/geometry`;
    const transformed = await requestJson(context.request, scratchApiUrl(apiBase, objectGeometryPath), {
      method: "PATCH",
      body: {
        base_revision: revision,
        geometry: { geometry_kind: fixture.object.geometry.kind, geometry_params: fixture.object.geometry.params },
        transform: {
          translation: fixture.object.translation,
          rotation_quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
          pivot: [0, 0, 0],
        },
      },
    });
    revision = finiteSceneRevision(transformed);
    manifest.revisions.push(revision);

    const materialResponse = await commitTransaction(context.request, apiBase, buildScratchMaterialTransaction(fixture, revision));
    revision = finiteSceneRevision(materialResponse);
    manifest.revisions.push(revision);
    const assigned = await requestJson(context.request, scratchApiUrl(apiBase, objectPath), {
      method: "PATCH",
      body: { base_revision: revision, material_ref: fixture.material.id },
    });
    revision = finiteSceneRevision(assigned);
    manifest.revisions.push(revision);

    const textureResponse = await commitTransaction(context.request, apiBase, buildScratchTextureTransaction(fixture, revision));
    revision = finiteSceneRevision(textureResponse);
    manifest.revisions.push(revision);

    for (const interaction of ["exchange", "demag"]) {
      const interactionResponse = await requestJson(
        context.request,
        scratchApiUrl(apiBase, `${objectPath}/interactions/${interaction}`),
        { method: "PATCH", body: buildScratchInteractionPatch(revision) },
      );
      revision = finiteSceneRevision(interactionResponse);
      manifest.revisions.push(revision);
    }

    const studyResponse = await commitTransaction(context.request, apiBase, buildScratchStudyPatch(fixture, revision));
    revision = finiteSceneRevision(studyResponse);
    manifest.revisions.push(revision);
    const errorProbes = { invalid_authoring_request: false, revision_conflict: false };
    try {
      await commitTransaction(context.request, apiBase, {
        ...buildScratchObjectTransaction(fixture, revision),
        object_id: "",
      });
    } catch (error) {
      errorProbes.invalid_authoring_request = error.status === 400;
    }
    try {
      await commitTransaction(context.request, apiBase, {
        kind: "merge_patch",
        base_revision: Math.max(0, revision - 1),
        merge_patch: { scene: { name: "stale scratch draft" } },
      });
    } catch (error) {
      errorProbes.revision_conflict = error.status === 409;
    }
    if (!errorProbes.invalid_authoring_request || !errorProbes.revision_conflict) {
      throw new Error(`E5 error probes did not fail closed: ${JSON.stringify(errorProbes)}`);
    }
    manifest.error_probes = errorProbes;
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAuthoringSurface(page, backend, objectId);
    manifest.screenshots.push(await screenshot(page, evidenceDir, `${backend}-02-authored.png`));

    const runtimeStatus = await requestJson(
      context.request,
      scratchApiUrl(apiBase, "/v2/sessions/current/status"),
    );
    const baseMeshRevision = backend === "fem"
      ? Number(runtimeStatus.resources?.mesh_build_revision ?? 0)
      : null;
    const meshResponse = await requestJson(
      context.request,
      scratchApiUrl(apiBase, "/v2/sessions/current/simulation/commands"),
      {
        method: "POST",
        body: {
          kind: "mesh_build",
          reason: "scratch_authoring_browser_smoke",
          mesh_reason: "shared-domain",
          mesh_target: { kind: "study_domain" },
        },
      },
    );
    if (!meshResponse.accepted || !meshResponse.command_id) {
      throw new Error(`Mesh build command was not accepted: ${JSON.stringify(meshResponse)}`);
    }
    manifest.command_ids.push(meshResponse.command_id);
    const meshTerminal = await awaitCommandTerminal(
      context.request,
      apiBase,
      meshResponse.command_id,
      { baseMeshRevision },
    );
    manifest.commands.push({
      kind: "mesh_build",
      command_id: meshResponse.command_id,
      status: meshTerminal.status,
      completion_status: meshTerminal.detail?.completion_status ?? null,
      terminal_at_unix_ms: meshTerminal.detail?.terminal_at_unix_ms ?? null,
      requested_execution: meshTerminal.detail?.requested_execution ?? null,
      resolved_execution: meshTerminal.detail?.resolved_execution ?? null,
      resource_invalidations: meshTerminal.detail?.resource_invalidations ?? [],
      diagnostics: meshTerminal.detail?.diagnostics ?? [],
      error: meshTerminal.detail?.error ?? meshTerminal.message ?? null,
    });
    if (meshTerminal.status !== "completed") {
      throw new Error(`Mesh build did not complete: ${meshTerminal.message ?? JSON.stringify(meshTerminal.detail)}`);
    }

    const runResponse = await requestJson(context.request, scratchApiUrl(apiBase, "/v2/sessions/current/simulation/commands"), {
      method: "POST",
      body: {
        kind: "relax",
        target: { kind: "study" },
        reason: "scratch_authoring_browser_smoke",
        max_steps: fixture.study.max_steps,
        torque_tolerance_apm: fixture.study.torque_tolerance,
        fixed_timestep: fixture.study.fixed_timestep,
      },
    });
    if (!runResponse.accepted || !runResponse.command_id) {
      throw new Error(`Relax command was not accepted: ${JSON.stringify(runResponse)}`);
    }
    manifest.command_ids.push(runResponse.command_id);
    const runTerminal = await awaitCommandTerminal(
      context.request,
      apiBase,
      runResponse.command_id,
    );
    manifest.commands.push({
      kind: "relax",
      command_id: runResponse.command_id,
      status: runTerminal.status,
      completion_status: runTerminal.detail?.completion_status ?? null,
      terminal_at_unix_ms: runTerminal.detail?.terminal_at_unix_ms ?? null,
      requested_execution: runTerminal.detail?.requested_execution ?? null,
      resolved_execution: runTerminal.detail?.resolved_execution ?? null,
      resource_invalidations: runTerminal.detail?.resource_invalidations ?? [],
      diagnostics: runTerminal.detail?.diagnostics ?? [],
      artifact_refs: runTerminal.detail?.artifact_refs ?? [],
      run_id: runTerminal.detail?.run_id ?? null,
      error: runTerminal.detail?.error ?? runTerminal.message ?? null,
    });
    if (runTerminal.status !== "completed") {
      throw new Error(`Relax did not complete: ${runTerminal.message ?? JSON.stringify(runTerminal.detail)}`);
    }
    const sync = await requestJson(context.request, scratchApiUrl(apiBase, "/v2/sessions/current/model/syncs"), {
      method: "POST",
      body: {},
    });
    manifest.script_path = sync.script_path ?? null;

    const finalScene = await requestJson(context.request, scratchApiUrl(apiBase, "/v2/sessions/current/model/scene"));
    manifest.normalized_scene = assertScratchScene(finalScene, fixture);
    manifest.webgl = await canvasHealth(page);
    manifest.dom_mutation_count = await page.evaluate(() => window.__FULLMAG_SCRATCH_RENDER_COUNT__ ?? 0);
    manifest.request_count = requestCounter.count;
    manifest.page_request_count = requests.length;
    manifest.topology_request_count = requests.filter(({ url }) => /topology|meshes\//i.test(url)).length;
    if (manifest.webgl.visible_canvas_count === 0 || !manifest.webgl.drawing_buffer_nonzero || manifest.webgl.context_lost) {
      throw new Error(`WebGL health failed: ${JSON.stringify(manifest.webgl)}`);
    }
    if (manifest.request_count > SCRATCH_AUTHORING_MAX_REQUESTS) {
      throw new Error(`Scratch authoring request count exceeded ${SCRATCH_AUTHORING_MAX_REQUESTS}: ${manifest.request_count}`);
    }
    if (manifest.dom_mutation_count > SCRATCH_AUTHORING_MAX_RENDER_MUTATIONS) {
      throw new Error(`Scratch authoring DOM mutation count exceeded ${SCRATCH_AUTHORING_MAX_RENDER_MUTATIONS}: ${manifest.dom_mutation_count}`);
    }
    if (errors.length > 0) throw new Error(`Browser errors: ${errors.join("\n")}`);
    const outputPath = resolve(evidenceDir, `${backend}.manifest.json`);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return { ...manifest, output_path: outputPath };
  } finally {
    requestCounters.delete(context.request);
    await context.close();
    await browser.close();
  }
}
