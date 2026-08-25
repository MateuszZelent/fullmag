import { chromium } from "playwright";

import { isExpectedScratchHttpError } from "./lib/scratch-authoring-browser.mjs";

const apiBase = process.env.CONTROL_ROOM_API_BASE ?? "http://127.0.0.1:3100";
const workspaceUrl =
  process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:3100/workspace";
const backend = process.env.CONTROL_ROOM_SCRATCH_BACKEND ?? "fdm";
if (backend !== "fdm" && backend !== "fem") {
  throw new Error(`CONTROL_ROOM_SCRATCH_BACKEND must be fdm or fem, got ${backend}`);
}
let browser;
let context;
let page;

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

async function readScene() {
  return responseJson(
    await context.request.get(`${apiBase}/v2/sessions/current/model/scene`),
    "read scene",
  );
}

async function waitForScene(predicate, label) {
  const deadline = Date.now() + 30_000;
  let scene = await readScene();
  while (Date.now() < deadline) {
    if (predicate(scene)) return scene;
    await new Promise((resolve) => setTimeout(resolve, 250));
    scene = await readScene();
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(scene)}`);
}

async function fill(label, value) {
  await page
    .locator(`input[aria-label="${label}"], textarea[aria-label="${label}"]`)
    .fill(String(value));
}

async function selectNode(nodeId) {
  await page.locator(`[data-node-id="${nodeId}"]`).click();
  await page.waitForTimeout(500);
  const prompt = page.getByRole("button", {
    name: "Apply and continue",
    exact: true,
  });
  if (await prompt.isVisible().catch(() => false)) await prompt.click();
}

const runtimeErrors = [];
const failedResponses = [];
const notFoundResponses = [];
let exitCode = 0;
try {
  browser = await chromium.launch({
    headless: process.env.CONTROL_ROOM_HEADFUL !== "1",
  });
  context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  page = await context.newPage();
  page.setDefaultTimeout(120_000);
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    runtimeErrors.push(error.stack ?? error.message);
  });
  page.on("response", (response) => {
    if (response.status() === 404) {
      notFoundResponses.push({
        status: response.status(),
        method: response.request().method(),
        url: response.url(),
      });
    }
    if (response.status() >= 500) {
      failedResponses.push(`${response.status()} ${response.url()}`);
    }
  });
  await page.addInitScript((configuredApiBase) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      controlRoomApiBase: configuredApiBase,
      disableRealtime: false,
    };
  }, apiBase);

  await responseJson(
    await context.request.post(`${apiBase}/v2/sessions`, {
      data: {
        name: `Scratch UI smoke ${backend.toUpperCase()}`,
        backend,
        device: "cpu",
        precision: "double",
        replace_current: true,
      },
    }),
    "create scratch session",
  );

  await page.goto(workspaceUrl, {
    waitUntil: "domcontentloaded",
    timeout: 120_000,
  });
  await page.getByText("Explorer").first().waitFor({ state: "visible" });
  await page.getByText("Model").first().click();

  await page.getByRole("button", { name: /command search/i }).first().click();
  await page.getByPlaceholder("Search commands").fill("Add Box");
  await page.getByRole("option").filter({ hasText: "Add Box" }).first().click();
  await page.getByText("Primitive Geometry").first().waitFor({ state: "visible" });
  await fill("Name", "X ferromagnet");
  await fill("Region", "x-ferromagnet");
  await fill("Size X", 1.6e-7);
  await fill("Size Y", 8e-8);
  await fill("Size Z", 1.2e-8);
  await fill("Translation X", 2e-8);
  await fill("Translation Y", -1e-8);
  await fill("Translation Z", 0);
  await page.getByRole("button", { name: "Apply Draft", exact: true }).click();
  await page
    .locator('[data-node-id^="model:object:x-ferromagnet-"]')
    .first()
    .waitFor({ state: "visible" });

  let scene = await readScene();
  const objectId = scene.objects[0]?.id;
  if (!objectId) throw new Error("primitive geometry did not create a magnetic object");

  await page.getByTitle("Expand All").click();
  await selectNode(`model:object:${objectId}:magnetic-parameters`);
  await page.getByText("Create and Assign Material").waitFor({ state: "visible" });
  await fill("New material name", "CoFeB scratch");
  await fill("New material ID", "material:x-ferromagnet");
  await fill("New Ms", 1.1e6);
  await fill("New A", 1.3e-11);
  await fill("New alpha", 0.02);
  await page.getByRole("button", { name: "Create and assign", exact: true }).click();
  await waitForScene(
    (next) =>
      next.objects?.some(
        (object) =>
          object.id === objectId &&
          object.material_ref === "material:x-ferromagnet",
      ),
    "material assignment",
  );

  await selectNode(`model:object:${objectId}:magnetic-parameters:material`);
  await page.locator('input[aria-label="Ms"]').waitFor({ state: "visible" });
  await fill("Ms", 1.1e6);
  await fill("Aex", 1.3e-11);
  await fill("alpha", 0.02);
  await fill("Dind", 0);
  await fill("Dbulk", 0);
  await page.getByRole("button", { name: "Apply Parameters", exact: true }).click();
  await waitForScene(
    (next) =>
      next.materials?.some(
        (material) =>
          material.id === "material:x-ferromagnet" &&
          Number(material.properties?.Ms ?? material.properties?.ms) === 1.1e6,
      ),
    "material parameters",
  );

  await selectNode(`model:object:${objectId}:magnetic-texture:asset`);
  await page.getByText("Magnetic Texture").first().waitFor({ state: "visible" });
  await fill("Magnetization ref", "texture:x-ferromagnet:uniform-y");
  await fill("Asset label", "Uniform Y");
  await page.getByRole("combobox", { name: "Preset", exact: true }).selectOption("uniform");
  await fill("Direction X", 0);
  await fill("Direction Y", 1);
  await fill("Direction Z", 0);
  await page.getByRole("button", { name: "Save Texture", exact: true }).click();
  await waitForScene(
    (next) =>
      next.objects?.some(
        (object) =>
          object.id === objectId &&
          object.magnetization_ref === "texture:x-ferromagnet:uniform-y",
      ),
    "magnetization texture",
  );

  const applyInteraction = async (interaction, enabled) => {
    await selectNode(
      `model:object:${objectId}:magnetic-parameters:${interaction}`,
    );
    await page.getByText("Physics Interaction").first().waitFor({ state: "visible" });
    const checkbox = page.getByRole("checkbox", {
      name: "Enabled",
      exact: true,
    });
    if ((await checkbox.isChecked()) !== enabled) {
      if (enabled) await checkbox.check();
      else await checkbox.uncheck();
    }
    await page.getByRole("button", { name: "Apply Interaction", exact: true }).click();
    await page
      .getByText(`${interaction === "exchange" ? "Exchange" : "Demagnetization"} updated.`)
      .waitFor({ state: "visible" });
    const studyKey = interaction === "exchange" ? "exchange_enabled" : "demag_enabled";
    await waitForScene(
      (next) => next.study?.[studyKey] === enabled,
      `${interaction} ${enabled ? "enabled" : "disabled"}`,
    );
  };
  for (const interaction of ["exchange", "demag"]) {
    await applyInteraction(interaction, false);
  }
  for (const interaction of ["exchange", "demag"]) {
    await applyInteraction(interaction, true);
  }

  await selectNode("model:study");
  await page.getByText("Global Study Settings").waitFor({ state: "visible" });
  if (backend === "fdm") {
    await fill("FDM default cell", "8e-9, 8e-9, 4e-9");
    await page
      .locator('textarea[aria-label="FDM per-magnet grids"]')
      .fill(JSON.stringify({ [objectId]: { cell: [4e-9, 4e-9, 4e-9] } }));
    const gridButton = page.getByRole("button", { name: "Apply Grid", exact: true });
    if (await gridButton.isDisabled()) throw new Error("Apply Grid is unexpectedly disabled");
    await gridButton.click();
    await page.getByText("Committed global study settings.").waitFor({ state: "visible" });
    scene = await waitForScene(
      (next) =>
        next.study?.fdm?.default_cell != null &&
        (next.study?.fdm?.per_magnet?.[objectId] != null ||
          next.study?.fdm?.per_object_grid?.[objectId] != null),
      "FDM grid",
    );
  } else {
    await fill("FEM demag policy", '{"linear_solver":"cg"}');
    const saveGlobals = page.getByRole("button", { name: "Save globals", exact: true });
    if (await saveGlobals.isDisabled()) throw new Error("Save globals is unexpectedly disabled");
    await saveGlobals.click();
    await page.getByText("Committed global study settings.").waitFor({ state: "visible" });
    scene = await waitForScene(
      (next) =>
        next.study?.fem_demag_solver_policy?.solver === "CG" ||
        next.study?.fem_demag_solver_policy?.linear_solver === "cg",
      "FEM demag policy",
    );
  }

  const object = scene.objects.find((entry) => entry.id === objectId);
  const material = scene.materials.find(
    (entry) => entry.id === "material:x-ferromagnet",
  );
  const texture = scene.magnetization_assets.find(
    (entry) => entry.id === "texture:x-ferromagnet:uniform-y",
  );
  const perObjectGrid =
    scene.study?.fdm?.per_object_grid?.[objectId] ??
    scene.study?.fdm?.per_magnet?.[objectId];
  const manifest = {
    schema: "scratch-authoring-ui.v1",
    backend,
    device: "cpu",
    precision: "double",
    scene_revision: scene.revision,
    object_id: objectId,
    checks: {
      primitive_geometry: Boolean(object?.geometry?.geometry_kind === "Box"),
      translated_object: Boolean(
        JSON.stringify(object?.transform?.translation) ===
          JSON.stringify([2e-8, -1e-8, 0]),
      ),
      material: Boolean(material),
      material_parameters: Boolean(
        Number(material?.properties?.Ms ?? material?.properties?.ms) === 1.1e6 &&
          Number(material?.properties?.Aex ?? material?.properties?.aex) === 1.3e-11 &&
          Number(material?.properties?.alpha) === 0.02 &&
          Number(material?.properties?.Dind ?? material?.properties?.dind) === 0 &&
          Number(material?.properties?.Dbulk ?? material?.properties?.dbulk) === 0,
      ),
      uniform_y_texture: Boolean(
        texture?.preset_kind === "uniform" &&
          JSON.stringify(texture?.preset_params?.direction) ===
            JSON.stringify([0, 1, 0]),
      ),
      exchange_and_demag: Boolean(
        scene.study?.exchange_enabled === true &&
          scene.study?.demag_enabled === true,
      ),
      fdm_global_grid: backend === "fdm" ? Boolean(scene.study?.fdm?.default_cell) : true,
      fdm_per_object_grid: backend === "fdm" ? Boolean(perObjectGrid?.cell) : true,
      fem_demag_policy:
        backend === "fem"
          ? scene.study?.fem_demag_solver_policy?.solver === "CG" ||
            scene.study?.fem_demag_solver_policy?.linear_solver === "cg"
          : true,
    },
  };
  if (Object.values(manifest.checks).some((value) => !value)) {
    throw new Error(`Scratch UI checks failed: ${JSON.stringify(manifest)}`);
  }
  const expectedNotFoundResponses = notFoundResponses.filter((entry) =>
    isExpectedScratchHttpError(entry),
  );
  const unexpectedNotFoundResponses = notFoundResponses.filter(
    (entry) => !isExpectedScratchHttpError(entry),
  );
  const genericResourceErrorCount = runtimeErrors.filter((message) =>
    message.startsWith("Failed to load resource:"),
  ).length;
  const unexpectedRuntimeErrors = runtimeErrors.filter(
    (message) => !message.startsWith("Failed to load resource:"),
  );
  if (
    unexpectedRuntimeErrors.length > 0 ||
    failedResponses.length > 0 ||
    unexpectedNotFoundResponses.length > 0 ||
    genericResourceErrorCount > expectedNotFoundResponses.length
  ) {
    throw new Error(
      `Scratch UI runtime errors: ${JSON.stringify({
        unexpectedRuntimeErrors,
        failedResponses,
        unexpectedNotFoundResponses,
        expectedNotFoundResponses,
        genericResourceErrorCount,
      })}`,
    );
  }
  console.log(JSON.stringify(manifest, null, 2));
} catch (error) {
  exitCode = 1;
  console.error(error instanceof Error ? error.stack ?? error.message : error);
} finally {
  await Promise.allSettled([
    context?.close(),
    browser?.close(),
  ]);
}
process.exitCode = exitCode;
