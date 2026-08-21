import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  assertCompletedTerminalFieldContract,
  assertCompletedTerminalTelemetry,
  assertInteractiveTerminalRun,
  terminalFieldRequestPath,
} from "./fdm-terminal-field-contract.mjs";

const apiBase = (process.env.CONTROL_ROOM_API_BASE_URL ?? "http://127.0.0.1:8197").replace(/\/$/, "");
const workspaceUrl = process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:3197/workspace";
const artifactDir = process.env.CONTROL_ROOM_FDM_TERMINAL_WEBGL_ARTIFACT_DIR ?? ".fullmag/reports/fdm-terminal-webgl-gate";
const evidencePath = process.env.CONTROL_ROOM_FDM_TERMINAL_WEBGL_EVIDENCE ?? `${artifactDir}/fdm-terminal-webgl-gate.json`;
const timeoutMs = Number(process.env.CONTROL_ROOM_FDM_TERMINAL_WEBGL_TIMEOUT_MS ?? 180_000);
const apiPhaseTimeoutMs = Math.min(timeoutMs, 30_000);
const browserPhaseTimeoutMs = Math.min(timeoutMs, 60_000);
const objectId = process.env.CONTROL_ROOM_FDM_TERMINAL_OBJECT_ID ?? "smoke_box";
const canvasSelector = ".fm-viewport-3d canvas";
let activePhase = "initialization";

function setPhase(next) {
  activePhase = next;
  console.log(`[fdm-terminal-webgl] phase=${activePhase}`);
}

async function main() {
  const playwright = await loadPlaywright();
  if (!playwright?.chromium) throw new Error("FDM terminal WebGL smoke requires Playwright Chromium.");
  await mkdir(artifactDir, { recursive: true });
  setPhase("completed-stage");
  const stageExecution = await poll("completed FDM stage", async () => {
    const value = await getJson("/v2/sessions/current/simulation/stages/execution");
    return Array.isArray(value?.stages) && value.stages.some((stage) => stage?.status === "completed") ? value : null;
  }, apiPhaseTimeoutMs);
  setPhase("interactive-terminal-run");
  const terminalRun = await poll("interactive terminal FDM run", async () => {
    const [run, sessionStatus] = await Promise.all([
      getJson("/v2/sessions/current/simulation/runs/current"),
      getJson("/v2/sessions/current/status"),
    ]);
    try {
      const coordinates = assertInteractiveTerminalRun({ run, sessionStatus, stageExecution });
      return { ...coordinates, run, sessionStatus };
    } catch {
      return null;
    }
  }, apiPhaseTimeoutMs);
  const { final_step: finalStep, final_time: finalTime, run, sessionStatus } = terminalRun;
  const sessionIdentity = requireSessionIdentity(sessionStatus);
  const scene = await getJson("/v2/sessions/current/model/scene");
  const sceneObject = Array.isArray(scene?.objects)
    ? scene.objects.find((candidate) => candidate?.id === objectId)
    : null;
  if (!sceneObject?.id) {
    throw new Error(`Terminal FDM smoke object ${objectId} is absent from model/scene.`);
  }
  const explorerTargets = {
    airbox: {
      debugInspectorOwner: "airbox.visualization.debug",
      debugNodeId: "model:airbox:visualization:debug",
      nodeId: "model:airbox:visualization",
      parentNodeIds: ["model:airbox"],
      inspectorOwner: "airbox.visualization",
      targetId: "airbox",
    },
    object: {
      debugInspectorOwner: "object.visualization.debug",
      debugNodeId: `model:object:${sceneObject.id}:visualization:debug`,
      nodeId: `model:object:${sceneObject.id}:visualization`,
      parentNodeIds: ["model:objects", `model:object:${sceneObject.id}`],
      inspectorOwner: "object.visualization",
      targetId: `object:${sceneObject.id}`,
    },
  };
  setPhase("terminal-field-catalog");
  const scopes = { airbox: { scopeId: "airbox", scopeKind: "airbox" }, object: { scopeId: objectId, scopeKind: "object" } };
  const fieldEntries = [
    ["object", "H_demag"], ["object", "H_eff"], ["object", "eden_demag"],
    ["object", "H_ext"],
    ["airbox", "H_demag"], ["airbox", "H_eff"],
  ];
  const { catalog, fields, terminal } = await awaitTerminalFieldGeneration({
    fieldEntries,
    finalStep,
    finalTime,
    getJson,
    poll,
    scopes,
    stageExecution,
    timeoutMs: apiPhaseTimeoutMs,
  });
  setPhase("terminal-telemetry");
  const objectMetrics = await getJson(`/v2/sessions/current/simulation/objects/${encodeURIComponent(objectId)}/metrics`);
  const tableRows = await getJson("/v2/sessions/current/data/tables/default/rows?columns=t,dt,mx,my,mz");
  const telemetry = assertCompletedTerminalTelemetry({ finalStep, finalTime, objectMetrics, tableRows });

  setPhase("browser-launch");
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });
  const responses = [];
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    const status = response.status();
    if (
      response.request().method() === "GET"
      && response.url().includes("/data/fields/")
      && status >= 200 && status < 300
    ) {
      const url = response.url();
      responses.push({
        handle: response,
        query: Object.fromEntries(new URL(url).searchParams),
        response_started_at_ms: Date.now(),
        status,
        url,
      });
    }
  });
  try {
    await page.addInitScript((baseUrl) => { window.__FULLMAG_CONFIG__ = { ...(window.__FULLMAG_CONFIG__ ?? {}), controlRoomApiBase: baseUrl }; }, apiBase);
    setPhase("workspace-load");
    await page.goto(workspaceUrl, { waitUntil: "domcontentloaded", timeout: browserPhaseTimeoutMs });
    const canvas = page.locator(canvasSelector);
    await canvas.waitFor({ state: "visible", timeout: browserPhaseTimeoutMs });
    await assertCanvasHealth(canvas, "after workspace load");
    const switches = [];
    setPhase("object-quantity-switches");
    switches.push(await switchInspectorQuantity({ page, explorerTargets, quantityId: "H_demag", responses, scope: "object", scopes, sessionIdentity }));
    switches.push(await switchRibbonQuantity({ page, explorerTargets, quantityId: "H_eff", responses, scope: "object", sessionIdentity }));
    switches.push(await switchInspectorQuantity({ page, explorerTargets, quantityId: "H_ext", responses, scope: "object", scopes, sessionIdentity }));
    switches.push(await switchInspectorQuantity({ page, explorerTargets, quantityId: "eden_demag", responses, scope: "object", scopes, sessionIdentity }));
    setPhase("airbox-quantity-gate");
    const airboxMagnetization = await assertAirboxMagnetizationUnavailable({ page, explorerTargets, scopes });
    setPhase("airbox-display-preflight");
    const airboxDisplay = await exerciseFdmAirboxRenderModes({ artifactDir, page, explorerTargets });
    setPhase("airbox-field-switches");
    for (const [scope, quantityId] of [["airbox", "H_demag"], ["airbox", "H_eff"]]) {
      switches.push(await switchInspectorQuantity({ page, explorerTargets, quantityId, responses, scope, scopes, sessionIdentity }));
    }
    const airboxRender = await assertFdmAirboxVectorRender({ page });
    const airboxInspector = await selectExplorerVisualizationTarget(page, explorerTargets.airbox);
    const focus = page.getByRole("button", { name: "Focus", exact: true }).last();
    if (await focus.count() === 1) await focus.click({ timeout: timeoutMs });
    const airboxVectorToggle = airboxInspector.getByRole("button", {
      name: "Toggle vector field arrows",
      exact: true,
    });
    await airboxVectorToggle.scrollIntoViewIfNeeded();
    const airboxControls = {
      target_id: explorerTargets.airbox.targetId,
      wireframe_checked: await airboxInspector.getByRole("radio", { name: "Wireframe", exact: true }).getAttribute("aria-checked"),
      vectors_pressed: await airboxVectorToggle.getAttribute("aria-pressed"),
      focused: await focus.count() === 1,
    };
    const finalCanvasHealth = await assertCanvasHealth(canvas, "after final field response");
    setPhase("screenshot");
    const screenshotPath = `${artifactDir}/fdm-terminal-webgl.png`;
    const screenshot = await canvas.screenshot({ path: screenshotPath });
    const pageScreenshotPath = `${artifactDir}/fdm-terminal-webgl-airbox-controls.png`;
    const pageScreenshot = await page.screenshot({ path: pageScreenshotPath });
    if (errors.length > 0) throw new Error(`Browser errors: ${errors.join("\\n")}`);
    const evidence = { schema_version: "fdm_terminal_webgl_gate.v1", qualification_status: "passed_cpu_fdm_terminal", terminal, telemetry, run, session_status: sessionStatus, stage_execution: stageExecution, catalog, fields, airbox_magnetization: airboxMagnetization, airbox_display: airboxDisplay, airbox_render: airboxRender, airbox_controls: airboxControls, canvas: { ...finalCanvasHealth, screenshot: { path: screenshotPath, sha256: createHash("sha256").update(screenshot).digest("hex") }, page_screenshot: { path: pageScreenshotPath, sha256: createHash("sha256").update(pageScreenshot).digest("hex") } }, field_responses: responses.map(summarizeFieldResponse), quantity_switches: switches, no_manual_compute_fields: true, workspace_url: workspaceUrl };
    await writeEvidenceAtomically(evidencePath, evidence);
    console.log(`FDM terminal WebGL gate passed: ${evidencePath}`);
  } finally { await browser.close(); }
}

export async function awaitTerminalFieldGeneration({
  fieldEntries,
  finalStep,
  finalTime,
  getJson,
  poll,
  scopes,
  stageExecution,
  timeoutMs,
}) {
  let lastSnapshot = null;
  try {
    return await poll("terminal FDM field generation", async () => {
      try {
        const catalog = await getJson("/v2/sessions/current/data/fields");
        const fields = Object.fromEntries(await Promise.all(fieldEntries.map(async ([scope, quantityId]) => [
          `${scope}:${quantityId}`,
          await getJson(terminalFieldRequestPath(quantityId, scopes[scope])),
        ])));
        lastSnapshot = { catalog, fields };
        return {
          catalog,
          fields,
          terminal: assertCompletedTerminalFieldContract({ catalog, fields, finalStep, finalTime, stageExecution }),
        };
      } catch (error) {
        lastSnapshot = { ...lastSnapshot, error: error.message };
        return null;
      }
    }, timeoutMs);
  } catch (error) {
    throw new Error(
      `Terminal FDM field generation did not converge: ${JSON.stringify(lastSnapshot)}`,
      { cause: error },
    );
  }
}

async function switchRibbonQuantity({ page, explorerTargets, quantityId, responses, scope, sessionIdentity }) {
  const renderPass = "surface";
  const preSwitchAdoptions = await captureLatestExactVisualizationAdoption({
    page,
    target: explorerTargets[scope],
  });
  const results = page.getByRole("tab", { name: "Results", exact: true }).first();
  await results.click({ timeout: timeoutMs });
  const action = page.getByRole("button", { name: quantityId, exact: true }).first();
  const before = responses.length;
  const switchStartedAtMs = Date.now();
  await action.click({ timeout: timeoutMs });
  await poll(`Ribbon ${quantityId} visualization state`, async () => {
    const state = await getJson("/v2/sessions/current/visualization/state");
    return state?.quantity?.active_quantity_id === quantityId ? state : null;
  });
  const response = await waitForScopedFieldResponse({
    quantityId,
    responses,
    scope: { scopeId: null, scopeKind: "full" },
    start: before,
  });
  const adoption = await waitForExactVisualizationDebugEvidence({
    page,
    preSwitchAdoptionSequence:
      preSwitchAdoptions.get(response.resource_key)?.[renderPass] ?? null,
    quantityId,
    renderPass,
    response,
    sessionIdentity,
    switchStartedAtMs,
    target: explorerTargets[scope],
  });
  return { adoption, quantity_id: quantityId, response, scope, surface: "ribbon" };
}

async function switchInspectorQuantity({ page, explorerTargets, quantityId, responses, scope, scopes, sessionIdentity }) {
  const renderPass = quantityId === "eden_demag" ? "surface" : "vector-glyph";
  const preSwitchAdoptions = await captureLatestExactVisualizationAdoption({
    page,
    target: explorerTargets[scope],
  });
  const inspector = await selectExplorerVisualizationTarget(page, explorerTargets[scope]);
  const quantity = inspector.locator('select[aria-label="Quantity Source"]');
  if (await quantity.count() !== 1) {
    throw new Error(`Selected ${scope} visualization inspector must expose exactly one Quantity Source select; found ${await quantity.count()}.`);
  }
  await quantity.waitFor({ state: "visible", timeout: timeoutMs });
  const before = responses.length;
  const switchStartedAtMs = Date.now();
  await quantity.selectOption(quantityId);
  await poll(`Inspector ${scope} ${quantityId} quantity`, async () => {
    return await quantity.inputValue() === quantityId ? true : null;
  });
  if (quantityId === "eden_demag") {
    const colorSource = inspector.locator('select[aria-label="Color source"]');
    await poll(`Inspector ${scope} ${quantityId} colormap pass`, async () =>
      await colorSource.inputValue() === "colormap" ? true : null,
    );
  } else {
    const vectorToggle = inspector.getByRole("button", {
      name: "Toggle vector field arrows",
      exact: true,
    });
    await vectorToggle.waitFor({ state: "visible", timeout: timeoutMs });
    if (await vectorToggle.getAttribute("aria-pressed") !== "true") {
      await vectorToggle.click({ timeout: timeoutMs });
    }
    await poll(`Inspector ${scope} ${quantityId} vector pass`, async () =>
      await vectorToggle.getAttribute("aria-pressed") === "true" ? true : null,
    );
  }
  const responseScope = {
    scopeId: scope === "object" ? null : scopes[scope].scopeId,
    scopeKind: scope === "object" ? "full" : "airbox",
  };
  const response = await waitForScopedFieldResponse({
    quantityId,
    responses,
    scope: responseScope,
    start: before,
  });
  const adoption = await waitForExactVisualizationDebugEvidence({
    page,
    preSwitchAdoptionSequence:
      preSwitchAdoptions.get(response.resource_key)?.[adoptionKindForRenderPass(renderPass)] ?? null,
    quantityId,
    renderPass,
    response,
    sessionIdentity,
    switchStartedAtMs,
    target: explorerTargets[scope],
  });
  return { adoption, scope, quantity_id: quantityId, response, response_count_delta: responses.length - before, surface: "inspector" };
}

async function assertAirboxMagnetizationUnavailable({ page, explorerTargets, scopes }) {
  await patchJson("/v2/sessions/current/visualization/state", {
    domains: { active_scope_id: scopes.airbox.scopeId, active_scope_kind: scopes.airbox.scopeKind },
  });
  const inspector = await selectExplorerVisualizationTarget(page, explorerTargets.airbox);
  const option = inspector.locator('select[aria-label="Quantity Source"] option[value="m"]');
  const count = await option.count();
  const disabled = count === 0 ? null : await option.isDisabled();
  if (count > 0 && !disabled) throw new Error("Airbox exposes magnetic-only m as an enabled quantity.");
  return { option_count: count, disabled };
}

async function exerciseFdmAirboxRenderModes({ artifactDir, page, explorerTargets }) {
  const inspector = await selectExplorerVisualizationTarget(page, explorerTargets.airbox);
  const visibility = inspector.getByRole("button", {
    name: "Toggle target visibility",
    exact: true,
  });
  await visibility.waitFor({ state: "visible", timeout: timeoutMs });
  if (await visibility.getAttribute("aria-pressed") !== "true") {
    await visibility.click({ timeout: timeoutMs });
  }
  const points = inspector.getByRole("radio", {
    name: "Points",
    exact: true,
  });
  await points.waitFor({ state: "visible", timeout: timeoutMs });
  if (await points.getAttribute("aria-checked") !== "true") {
    await points.click({ timeout: timeoutMs });
  }
  const pointsRender = await poll("FDM Airbox points target", async () => {
    const [targetId, pointsActive] = await page.locator(".fm-viewport-3d").evaluate((node) => [
      node.getAttribute("data-fdm-airbox-target"),
      node.getAttribute("data-fdm-airbox-points-visible"),
    ]);
    return targetId === "airbox" && pointsActive === "true"
      ? { target_id: targetId, points_visible: pointsActive }
      : null;
  });
  const pointsScreenshotPath = `${artifactDir}/fdm-airbox-points-on.png`;
  const pointsScreenshot = await page.locator(canvasSelector).screenshot({
    path: pointsScreenshotPath,
  });
  const wireframe = inspector.getByRole("radio", {
    name: "Wireframe",
    exact: true,
  });
  await wireframe.waitFor({ state: "visible", timeout: timeoutMs });
  if (await wireframe.getAttribute("aria-checked") !== "true") {
    await wireframe.click({ timeout: timeoutMs });
  }
  const wireframeRender = await poll("FDM Airbox wireframe target", async () => {
    const [targetId, wireframeActive] = await page.locator(".fm-viewport-3d").evaluate((node) => [
      node.getAttribute("data-fdm-airbox-target"),
      node.getAttribute("data-fdm-airbox-wireframe-visible"),
    ]);
    return targetId === "airbox" && wireframeActive === "true"
      ? { target_id: targetId, wireframe_visible: wireframeActive }
      : null;
  });
  const wireframeScreenshotPath = `${artifactDir}/fdm-airbox-wireframe-on.png`;
  const wireframeScreenshot = await page.locator(canvasSelector).screenshot({
    path: wireframeScreenshotPath,
  });
  const off = inspector.getByRole("radio", {
    name: "Off",
    exact: true,
  });
  await off.click({ timeout: timeoutMs });
  const offRender = await poll("FDM Airbox wireframe off target", async () => {
    const values = await page.locator(".fm-viewport-3d").evaluate((node) => ({
      points_visible: node.getAttribute("data-fdm-airbox-points-visible"),
      target_id: node.getAttribute("data-fdm-airbox-target"),
      wireframe_visible: node.getAttribute("data-fdm-airbox-wireframe-visible"),
    }));
    return values.target_id === "airbox"
      && values.points_visible === "false"
      && values.wireframe_visible === "false"
      ? values
      : null;
  });
  const offScreenshotPath = `${artifactDir}/fdm-airbox-wireframe-off.png`;
  const offScreenshot = await page.locator(canvasSelector).screenshot({
    path: offScreenshotPath,
  });
  return {
    target_id: "airbox",
    points_render: pointsRender,
    points_screenshot: {
      path: pointsScreenshotPath,
      sha256: createHash("sha256").update(pointsScreenshot).digest("hex"),
    },
    wireframe_render: wireframeRender,
    wireframe_screenshot: {
      path: wireframeScreenshotPath,
      sha256: createHash("sha256").update(wireframeScreenshot).digest("hex"),
    },
    off_render: offRender,
    off_screenshot: {
      path: offScreenshotPath,
      sha256: createHash("sha256").update(offScreenshot).digest("hex"),
    },
    visibility_pressed: await visibility.getAttribute("aria-pressed"),
    wireframe_checked_after_off: await wireframe.getAttribute("aria-checked"),
  };
}

async function assertFdmAirboxVectorRender({ page }) {
  return poll("FDM Airbox vector-only render adoption", async () => {
    const values = await page.locator(".fm-viewport-3d").evaluate((node) => ({
      target_id: node.getAttribute("data-fdm-airbox-target"),
      model_count: Number(node.getAttribute("data-fdm-airbox-model-count") ?? 0),
      vector_segment_count: Number(node.getAttribute("data-fdm-airbox-vector-segment-count") ?? 0),
      wireframe_visible: node.getAttribute("data-fdm-airbox-wireframe-visible"),
      vectors_visible: node.getAttribute("data-fdm-airbox-vectors-visible"),
    }));
    return values.target_id === "airbox"
      && values.wireframe_visible === "false"
      && values.vectors_visible === "true"
      && values.model_count > 0
      && values.vector_segment_count > 0
      ? values
      : null;
  });
}

function explorerTreeItem(page, nodeId) {
  return page.locator(`[role="treeitem"][data-node-id=${JSON.stringify(nodeId)}]`);
}

async function selectExplorerVisualizationTarget(page, target) {
  const modelTab = page.getByRole("tab", { name: "Model", exact: true });
  await modelTab.waitFor({ state: "visible", timeout: timeoutMs });
  if (await modelTab.getAttribute("aria-selected") !== "true") {
    await modelTab.click({ timeout: timeoutMs });
  }
  for (const parentNodeId of target.parentNodeIds) {
    const parent = explorerTreeItem(page, parentNodeId);
    await parent.waitFor({ state: "visible", timeout: timeoutMs });
    if (await parent.getAttribute("aria-expanded") === "false") {
      await parent.focus();
      await page.keyboard.press("ArrowRight");
    }
  }
  const row = explorerTreeItem(page, target.nodeId);
  await row.waitFor({ state: "visible", timeout: timeoutMs });
  await row.click({ timeout: timeoutMs });
  await poll(`Explorer selection ${target.nodeId}`, async () =>
    await row.getAttribute("aria-selected") === "true" ? true : null,
  );
  const inspector = page.locator(`.fm-inspector-panel[data-inspector-owner="${target.inspectorOwner}"]`);
  await inspector.waitFor({ state: "visible", timeout: timeoutMs });
  let targetGroup;
  let trigger;
  let targetGroupCount = 0;
  let triggerCount = 0;
  let headings = [];
  try {
    ({ targetGroup, trigger } = await poll(`Explorer ${target.nodeId} Target group`, async () => {
      headings = await inspector.getByRole("heading").allTextContents();
      const candidate = inspector
        .getByRole("heading", { name: "Target", exact: true })
        .locator('xpath=ancestor::section[@data-slot="inspector-group"][1]');
      targetGroupCount = await candidate.count();
      const candidateTrigger = candidate.locator('[data-slot="inspector-group-trigger"]');
      triggerCount = await candidateTrigger.count();
      return targetGroupCount === 1 && triggerCount === 1
        ? { targetGroup: candidate, trigger: candidateTrigger }
        : null;
    }));
  } catch (error) {
    throw new Error(
      `Explorer ${target.nodeId} Target group did not resolve; headings=${JSON.stringify(headings)}; owner=${target.inspectorOwner}; target_group_count=${targetGroupCount}; trigger_count=${triggerCount}.`,
      { cause: error },
    );
  }
  if (await trigger.getAttribute("aria-expanded") === "false") {
    await trigger.click({ timeout: timeoutMs });
  }
  let targetId = null;
  try {
    await poll(`Explorer ${target.nodeId} Target ID`, async () => {
      targetId = await targetGroup.locator(".fm-inspector-field-row").evaluateAll((rows) => {
        const row = rows.find((candidate) =>
          candidate.querySelector(".fm-inspector-field-row__label")?.textContent?.trim() === "Target ID",
        );
        return row?.querySelector(".fm-inspector-field-row__value")?.textContent?.trim() ?? null;
      });
      return targetId === target.targetId ? true : null;
    });
  } catch (error) {
    headings = await inspector.getByRole("heading").allTextContents();
    throw new Error(
      `Explorer ${target.nodeId} Target ID did not resolve; expected=${target.targetId}; actual=${targetId ?? "none"}; headings=${JSON.stringify(headings)}; owner=${target.inspectorOwner}.`,
      { cause: error },
    );
  }
  return inspector;
}

async function selectExplorerVisualizationDebugTarget(page, target) {
  await selectExplorerVisualizationTarget(page, target);
  const parent = explorerTreeItem(page, target.nodeId);
  if (await parent.getAttribute("aria-expanded") === "false") {
    await parent.focus();
    await page.keyboard.press("ArrowRight");
  }
  const row = explorerTreeItem(page, target.debugNodeId);
  await row.waitFor({ state: "visible", timeout: timeoutMs });
  await row.click({ timeout: timeoutMs });
  await poll(`Explorer debug selection ${target.debugNodeId}`, async () =>
    await row.getAttribute("aria-selected") === "true" ? true : null,
  );
  const inspector = page.locator(
    `.fm-inspector-panel[data-inspector-owner="${target.debugInspectorOwner}"]`,
  );
  await inspector.waitFor({ state: "visible", timeout: timeoutMs });
  await inspector.locator(".fm-visualization-debug-panel").waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  return inspector;
}

async function waitForExactVisualizationDebugEvidence({
  page,
  preSwitchAdoptionSequence,
  quantityId,
  renderPass = quantityId === "eden_demag" ? "surface" : "vector-glyph",
  response,
  sessionIdentity,
  switchStartedAtMs,
  target,
}) {
  const inspector = await selectExplorerVisualizationDebugTarget(page, target);
  const rawJson = inspector.getByRole("button", {
    name: "Raw bounded JSON",
    exact: true,
  });
  await rawJson.waitFor({ state: "visible", timeout: timeoutMs });
  if (await rawJson.getAttribute("aria-expanded") === "false") {
    await rawJson.click({ timeout: timeoutMs });
  }
  let lastSnapshot = null;
  try {
    return await poll(`exact ${target.targetId} ${quantityId} render adoption`, async () => {
      const text = await inspector.locator(".fm-visualization-debug-json code").textContent();
      if (!text) return null;
      const document = JSON.parse(text);
      const observation = findExactVisualizationDebugObservation(
        document,
        response.resource_key,
        target.targetId,
        adoptionKindForRenderPass(renderPass),
      );
      lastSnapshot = observation?.carrier ?? document?.model ?? null;
      if (!observation) return null;
      const { carrier, snapshot } = observation;
      const { adoption } = carrier.render;
      const passAdoption = adoption[adoptionKindForRenderPass(renderPass)];
      if (
        !exactVisualizationAdoptionMatches({
          observation,
          preSwitchAdoptionSequence,
          quantityId,
          renderPass,
          response,
          sessionIdentity,
          switchStartedAtMs,
        })
        || !["ready", "derived-global", "target-buffer"].includes(carrier.render.fieldBufferState)
        || !carrier.render.requestedFieldBufferId
        || carrier.render.requestedFieldBufferId !== passAdoption.adoptedFieldBufferId
        || passAdoption.adoptedResourceKey !== response.resource_key
      ) {
        return null;
      }
      if (renderPass === "surface") {
        if (
          !carrier.render.requestedPasses.includes("surface")
          || !carrier.render.surface.bufferKey
          || carrier.render.surface.bufferKey !== passAdoption.adoptedScalarBufferKey
          || !(carrier.render.surface.scalarByteLength > 0)
        ) {
          return null;
        }
        return {
          adopted_field_buffer_id: passAdoption.adoptedFieldBufferId,
          adopted_resource_key: passAdoption.adoptedResourceKey,
          adopted_scalar_buffer_key: passAdoption.adoptedScalarBufferKey,
          adopted_at_ms: passAdoption.adoptedAtMs,
          adoption_sequence: passAdoption.adoptionSequence,
          field_buffer_state: carrier.render.fieldBufferState,
          render_pass: renderPass,
          requested_field_buffer_id: carrier.render.requestedFieldBufferId,
          pre_switch_adoption_sequence: preSwitchAdoptionSequence,
          response_started_at_ms: response.response_started_at_ms,
          response_body_started_at_ms: response.response_body_started_at_ms,
          response_finished_at_ms: response.response_finished_at_ms,
          snapshot_captured_at_ms: snapshot.capturedAtMs,
          snapshot_frame_commit_id: snapshot.viewport.frameCommitId,
          switch_started_at_ms: switchStartedAtMs,
        };
      }
      if (
        !carrier.render.requestedPasses.includes("vector-glyph")
        || !carrier.render.vectors.buildKey
        || carrier.render.vectors.buildKey !== passAdoption.adoptedVectorBuildKey
        || !(carrier.render.vectors.segmentCount > 0)
        || !(passAdoption.adoptedVectorItemCount > 0)
      ) {
        return null;
      }
      return {
        adopted_field_buffer_id: passAdoption.adoptedFieldBufferId,
        adopted_resource_key: passAdoption.adoptedResourceKey,
        adopted_vector_build_key: passAdoption.adoptedVectorBuildKey,
        adopted_vector_item_count: passAdoption.adoptedVectorItemCount,
        adopted_at_ms: passAdoption.adoptedAtMs,
        adoption_sequence: passAdoption.adoptionSequence,
        field_buffer_state: carrier.render.fieldBufferState,
        render_pass: renderPass,
        requested_field_buffer_id: carrier.render.requestedFieldBufferId,
        pre_switch_adoption_sequence: preSwitchAdoptionSequence,
        response_started_at_ms: response.response_started_at_ms,
        response_body_started_at_ms: response.response_body_started_at_ms,
        response_finished_at_ms: response.response_finished_at_ms,
        snapshot_captured_at_ms: snapshot.capturedAtMs,
        snapshot_frame_commit_id: snapshot.viewport.frameCommitId,
        switch_started_at_ms: switchStartedAtMs,
        vector_build_key: carrier.render.vectors.buildKey,
      };
    }, browserPhaseTimeoutMs);
  } catch (error) {
    throw new Error(
      `Visualization Debug did not prove exact ${target.targetId} ${quantityId} adoption for ${response.resource_key}; last_snapshot=${JSON.stringify(lastSnapshot)}.`,
      { cause: error },
    );
  }
}

async function captureLatestExactVisualizationAdoption({ page, target }) {
  const inspector = await selectExplorerVisualizationDebugTarget(page, target);
  const document = await readVisualizationDebugDocument(inspector);
  const adoptions = new Map();
  for (const viewport of document?.model?.viewports ?? []) {
    for (const carrierGroup of viewport?.carriers ?? []) {
      for (const observation of carrierGroup?.observations ?? []) {
        const resourceKey = observation?.carrier?.request?.resourceKey;
        const adoption = observation?.carrier?.render?.adoption;
        if (!resourceKey || !adoption) continue;
        const current = adoptions.get(resourceKey) ?? { surface: null, vector: null };
        for (const pass of ["surface", "vector"]) {
          const sequence = adoption[pass]?.adoptionSequence;
          if (
            Number.isSafeInteger(sequence)
            && (current[pass] === null || sequence > current[pass])
          ) {
            current[pass] = sequence;
          }
        }
        adoptions.set(resourceKey, current);
      }
    }
  }
  return adoptions;
}

async function readVisualizationDebugDocument(inspector) {
  const rawJson = inspector.getByRole("button", {
    name: "Raw bounded JSON",
    exact: true,
  });
  await rawJson.waitFor({ state: "visible", timeout: timeoutMs });
  if (await rawJson.getAttribute("aria-expanded") === "false") {
    await rawJson.click({ timeout: timeoutMs });
  }
  return poll("Visualization Debug raw JSON", async () => {
    const text = await inspector.locator(".fm-visualization-debug-json code").textContent();
    return text ? JSON.parse(text) : null;
  });
}

function findExactVisualizationDebugObservation(document, resourceKey, targetId, pass) {
  const model = document?.model;
  if (model?.target?.id !== targetId || !Array.isArray(model?.viewports)) return null;
  let latest = null;
  for (const viewport of model.viewports) {
    for (const carrierGroup of viewport?.carriers ?? []) {
      for (const observation of carrierGroup?.observations ?? []) {
        const passAdoption = observation?.carrier?.render?.adoption?.[pass];
        const latestPassAdoption = latest?.carrier?.render?.adoption?.[pass];
        if (
          observation?.carrier?.request?.resourceKey === resourceKey
          && Number.isSafeInteger(passAdoption?.adoptionSequence)
          && Number.isFinite(observation?.snapshot?.capturedAtMs)
          && (
            latest === null
            || passAdoption.adoptionSequence > latestPassAdoption.adoptionSequence
            || (
              passAdoption.adoptionSequence === latestPassAdoption.adoptionSequence
              && observation.snapshot.capturedAtMs >= latest.snapshot.capturedAtMs
            )
          )
        ) {
          latest = observation;
        }
      }
    }
  }
  return latest;
}

async function waitForScopedFieldResponse({ responses, quantityId, scope, start = 0 }) {
  const entry = await poll(`${scope.scopeKind} ${quantityId} viewport field response`, () => {
    const prefix = `/v2/sessions/current/data/fields/${encodeURIComponent(quantityId)}/`;
    const response = responses.slice(start).find((value) => {
      const url = new URL(value.url);
      if (
        value.status < 200 || value.status >= 300
        || url.pathname !== `${prefix}samples/vector`
        || url.searchParams.get("scope_kind") !== scope.scopeKind
      ) {
        return false;
      }
      if (scope.scopeKind === "full") {
        return !url.searchParams.has("scope_id");
      }
      const responseScopeId = url.searchParams.get("scope_id");
      return responseScopeId === null || responseScopeId === scope.scopeId;
    });
    return response ?? null;
  });
  const response = entry.handle;
  const responseBodyStartedAtMs = Date.now();
  const headers = await response.allHeaders();
  const bodyError = await response.finished();
  if (bodyError) {
    throw new Error(`Field response body did not finish for ${entry.url}: ${bodyError.message}`);
  }
  return {
    ...summarizeFieldResponse(entry),
    domain_generation_id: normalizedHeader(headers, "x-fullmag-domain-generation-id"),
    etag: normalizedHeader(headers, "etag"),
    field_revision: normalizedHeader(headers, "x-fullmag-field-revision"),
    mesh_topology_hash: normalizedHeader(headers, "x-fullmag-mesh-topology-hash"),
    response_started_at_ms: entry.response_started_at_ms,
    response_body_started_at_ms: responseBodyStartedAtMs,
    response_finished_at_ms: Date.now(),
  };
}

function normalizedHeader(headers, name) {
  const value = headers[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function exactVisualizationAdoptionMatches({
  observation,
  preSwitchAdoptionSequence,
  quantityId,
  renderPass = quantityId === "eden_demag" ? "surface" : "vector-glyph",
  response,
  sessionIdentity,
  switchStartedAtMs,
}) {
  const carrier = observation?.carrier;
  const adoption = carrier?.render?.adoption;
  const pass = adoptionKindForRenderPass(renderPass);
  const passAdoption = adoption?.[pass];
  if (
    !passAdoption
    || !Number.isSafeInteger(passAdoption.adoptionSequence)
    || passAdoption.adoptionSequence <= (preSwitchAdoptionSequence ?? 0)
    || !Number.isSafeInteger(passAdoption.adoptedAtMs)
    || passAdoption.adoptedAtMs < Math.max(switchStartedAtMs, response.response_started_at_ms)
    || carrier.request?.resourceKey !== response.resource_key
    || passAdoption.adoptedResourceKey !== response.resource_key
    || !carrier.render.requestedFieldBufferId
    || carrier.render.requestedFieldBufferId !== passAdoption.adoptedFieldBufferId
    || !adoptedFieldBufferMatchesSession(passAdoption.adoptedFieldBufferId, sessionIdentity)
    || !response.etag
    || carrier.cache?.etag !== response.etag
    || carrier.cache?.dataIdentityMatches !== true
    || !response.field_revision
    || carrier.revisions?.fieldRevision !== response.field_revision
    || !response.domain_generation_id
    || carrier.revisions?.domainGenerationId !== response.domain_generation_id
    || (
      response.mesh_topology_hash != null
      && carrier.revisions?.meshTopologyHash !== response.mesh_topology_hash
    )
  ) {
    return false;
  }
  if (renderPass === "surface") {
    return carrier.render.requestedPasses?.includes("surface")
      && carrier.render.surface?.bufferKey === passAdoption.adoptedScalarBufferKey;
  }
  return carrier.render.requestedPasses?.includes("vector-glyph")
    && carrier.render.vectors?.buildKey === passAdoption.adoptedVectorBuildKey;
}

function adoptedFieldBufferMatchesSession(fieldBufferId, sessionIdentity) {
  const sessionId = sessionIdentity?.sessionId?.trim();
  const sessionEpoch = sessionIdentity?.sessionEpoch?.trim();
  return Boolean(
    sessionId
    && sessionEpoch
    && typeof fieldBufferId === "string"
    && fieldBufferId.startsWith(`${sessionId}:${sessionEpoch}:`),
  );
}

function requireSessionIdentity(sessionStatus) {
  const sessionId = sessionStatus?.session?.session_id?.trim();
  const sessionEpoch = sessionStatus?.session?.session_epoch?.trim();
  if (!sessionId || !sessionEpoch) {
    throw new Error("FDM terminal WebGL proof requires current session_id and session_epoch.");
  }
  return { sessionEpoch, sessionId };
}

function adoptionKindForRenderPass(renderPass) {
  return renderPass === "surface" ? "surface" : "vector";
}

function summarizeFieldResponse(entry) {
  const url = new URL(entry.url);
  return {
    query: entry.query,
    response_started_at_ms: entry.response_started_at_ms,
    resource_key: `${url.pathname}${url.search}`,
    status: entry.status,
    url: entry.url,
  };
}

async function assertCanvasHealth(canvas, phase) {
  const health = await canvas.evaluate((node) => {
    const gl = node.getContext("webgl2") ?? node.getContext("webgl");
    const rect = node.getBoundingClientRect();
    return {
      drawing_buffer: [gl?.drawingBufferWidth ?? 0, gl?.drawingBufferHeight ?? 0],
      is_context_lost: gl?.isContextLost() ?? true,
      visible: rect.width > 0 && rect.height > 0,
    };
  });
  if (!health.visible || health.is_context_lost || health.drawing_buffer.some((value) => value <= 0)) {
    throw new Error(`WebGL canvas unhealthy ${phase}: ${JSON.stringify(health)}`);
  }
  return health;
}

async function getJson(path) { const response = await fetch(`${apiBase}${path}`); if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`); return response.json(); }
async function patchJson(path, body) { const response = await fetch(`${apiBase}${path}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`); return response.json(); }
async function poll(label, test, limitMs = timeoutMs) { const deadline = Date.now() + limitMs; let lastError = null; while (Date.now() < deadline) { try { const value = await test(); if (value) return value; } catch (error) { lastError = error; } await new Promise((resolve) => setTimeout(resolve, 250)); } throw new Error(`${label} timed out in phase=${activePhase} after ${limitMs}ms${lastError ? `: ${lastError.message}` : ""}`); }
async function loadPlaywright() { try { return await import("playwright"); } catch { try { return await import("@playwright/test"); } catch { return null; } } }
async function writeEvidenceAtomically(path, value) { await mkdir(dirname(path), { recursive: true }); const temporaryPath = `${path}.tmp-${process.pid}`; await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" }); await rename(temporaryPath, path); }

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) main().catch(async (error) => { await writeEvidenceAtomically(evidencePath, { schema_version: "fdm_terminal_webgl_gate.v1", qualification_status: "blocked", no_manual_compute_fields: true, failure: { message: error.message, name: error.name }, workspace_url: workspaceUrl }); console.error(error.stack ?? error.message); process.exitCode = 1; });
