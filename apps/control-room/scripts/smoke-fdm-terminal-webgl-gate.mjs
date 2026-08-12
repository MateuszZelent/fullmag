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
  const scene = await getJson("/v2/sessions/current/model/scene");
  const sceneObject = Array.isArray(scene?.objects)
    ? scene.objects.find((candidate) => candidate?.id === objectId)
    : null;
  if (!sceneObject?.id) {
    throw new Error(`Terminal FDM smoke object ${objectId} is absent from model/scene.`);
  }
  const explorerTargets = {
    airbox: {
      nodeId: "model:airbox:visualization",
      parentNodeIds: ["model:airbox"],
      inspectorOwner: "airbox.visualization",
      targetId: "fdm-universe-outside-support",
    },
    object: {
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
  const requests = [];
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "GET" && request.url().includes("/data/fields/")) requests.push(request.url());
  });
  try {
    await page.addInitScript((baseUrl) => { window.__FULLMAG_CONFIG__ = { ...(window.__FULLMAG_CONFIG__ ?? {}), controlRoomApiBase: baseUrl }; }, apiBase);
    setPhase("workspace-load");
    await page.goto(workspaceUrl, { waitUntil: "domcontentloaded", timeout: browserPhaseTimeoutMs });
    const canvas = page.locator(canvasSelector);
    await canvas.waitFor({ state: "visible", timeout: browserPhaseTimeoutMs });
    const canvasHealth = await canvas.evaluate((node) => {
      const gl = node.getContext("webgl2") ?? node.getContext("webgl");
      const rect = node.getBoundingClientRect();
      return { drawing_buffer: [gl?.drawingBufferWidth ?? 0, gl?.drawingBufferHeight ?? 0], is_context_lost: gl?.isContextLost() ?? true, visible: rect.width > 0 && rect.height > 0 };
    });
    if (!canvasHealth.visible || canvasHealth.is_context_lost || canvasHealth.drawing_buffer.some((value) => value <= 0)) throw new Error(`WebGL canvas unhealthy: ${JSON.stringify(canvasHealth)}`);
    const switches = [];
    setPhase("object-quantity-switches");
    switches.push(await switchInspectorQuantity({ page, explorerTargets, quantityId: "H_demag", requests, scope: "object", scopes }));
    switches.push(await switchRibbonQuantity({ page, quantityId: "H_eff", requests, scope: "object", scopes }));
    switches.push(await switchInspectorQuantity({ page, explorerTargets, quantityId: "H_ext", requests, scope: "object", scopes }));
    switches.push(await switchInspectorQuantity({ page, explorerTargets, quantityId: "eden_demag", requests, scope: "object", scopes }));
    setPhase("airbox-quantity-gate");
    const airboxMagnetization = await assertAirboxMagnetizationUnavailable({ page, explorerTargets, scopes });
    setPhase("airbox-field-switches");
    for (const [scope, quantityId] of [["airbox", "H_demag"], ["airbox", "H_eff"]]) {
      switches.push(await switchInspectorQuantity({ page, explorerTargets, quantityId, requests, scope, scopes }));
    }
    setPhase("screenshot");
    const screenshotPath = `${artifactDir}/fdm-terminal-webgl.png`;
    const screenshot = await canvas.screenshot({ path: screenshotPath });
    if (errors.length > 0) throw new Error(`Browser errors: ${errors.join("\\n")}`);
    const evidence = { schema_version: "fdm_terminal_webgl_gate.v1", qualification_status: "passed_cpu_fdm_terminal", terminal, telemetry, run, session_status: sessionStatus, stage_execution: stageExecution, catalog, fields, airbox_magnetization: airboxMagnetization, canvas: { ...canvasHealth, screenshot: { path: screenshotPath, sha256: createHash("sha256").update(screenshot).digest("hex") } }, field_requests: requests, quantity_switches: switches, no_manual_compute_fields: true, workspace_url: workspaceUrl };
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

async function switchRibbonQuantity({ page, quantityId, requests, scope, scopes }) {
  const results = page.getByRole("tab", { name: "Results", exact: true }).first();
  await results.click({ timeout: timeoutMs });
  const action = page.getByRole("button", { name: quantityId, exact: true }).first();
  const before = requests.length;
  await action.click({ timeout: timeoutMs });
  await poll(`Ribbon ${quantityId} visualization state`, async () => {
    const state = await getJson("/v2/sessions/current/visualization/state");
    return state?.quantity?.active_quantity_id === quantityId ? state : null;
  });
  const request = await waitForScopedFieldRequest({ requests, quantityId, scope: scopes[scope], start: before });
  return { quantity_id: quantityId, request, scope, surface: "ribbon" };
}

async function switchInspectorQuantity({ page, explorerTargets, quantityId, requests, scope, scopes }) {
  await patchJson("/v2/sessions/current/visualization/state", {
    domains: { active_scope_id: scopes[scope].scopeId, active_scope_kind: scopes[scope].scopeKind },
  });
  const inspector = await selectExplorerVisualizationTarget(page, explorerTargets[scope]);
  const quantity = inspector.locator('select[aria-label="Quantity Source"]');
  if (await quantity.count() !== 1) {
    throw new Error(`Selected ${scope} visualization inspector must expose exactly one Quantity Source select; found ${await quantity.count()}.`);
  }
  await quantity.waitFor({ state: "visible", timeout: timeoutMs });
  const before = requests.length;
  await quantity.selectOption(quantityId);
  await poll(`Inspector ${scope} ${quantityId} quantity`, async () => {
    const state = await getJson("/v2/sessions/current/visualization/state");
    const override = (state?.overrides ?? []).find((entry) => entry.scope === scopes[scope].scopeKind && entry.scope_id === scopes[scope].scopeId);
    return override?.quantity?.active_quantity_id === quantityId ? state : null;
  });
  const request = await waitForScopedFieldRequest({ requests, quantityId, scope: scopes[scope], start: before });
  return { scope, quantity_id: quantityId, request, request_count_delta: requests.length - before, surface: "inspector" };
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
  const targetGroup = inspector.locator('[data-slot="inspector-group"]', {
    has: inspector.getByRole("heading", { name: "Target", exact: true }),
  });
  if (await targetGroup.count() !== 1) {
    throw new Error(`Selected ${target.inspectorOwner} inspector must expose exactly one Target group; found ${await targetGroup.count()}.`);
  }
  const trigger = targetGroup.locator('[data-slot="inspector-group-trigger"]');
  if (await trigger.count() !== 1) {
    throw new Error(`Selected ${target.inspectorOwner} Target group must expose exactly one disclosure trigger; found ${await trigger.count()}.`);
  }
  if (await trigger.getAttribute("aria-expanded") === "false") {
    await trigger.click({ timeout: timeoutMs });
  }
  const targetId = await targetGroup.locator(".fm-inspector-field-row").evaluateAll((rows) => {
    const row = rows.find((candidate) =>
      candidate.querySelector(".fm-inspector-field-row__label")?.textContent?.trim() === "Target ID",
    );
    return row?.querySelector(".fm-inspector-field-row__value")?.textContent?.trim() ?? null;
  });
  if (targetId !== target.targetId) {
    throw new Error(`Explorer ${target.nodeId} opened ${target.inspectorOwner} with Target ID ${targetId ?? "none"}; expected ${target.targetId}.`);
  }
  return inspector;
}

async function waitForScopedFieldRequest({ requests, quantityId, scope, start = 0 }) {
  return poll(`${scope.scopeKind} ${quantityId} viewport field request`, () => {
    const prefix = `/v2/sessions/current/data/fields/${encodeURIComponent(quantityId)}/`;
    const request = requests.slice(start).find((value) => {
      const url = new URL(value);
      return url.pathname.startsWith(prefix)
        && url.searchParams.get("scope_kind") === scope.scopeKind
        && url.searchParams.get("scope_id") === scope.scopeId;
    });
    return request ?? null;
  });
}

async function getJson(path) { const response = await fetch(`${apiBase}${path}`); if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`); return response.json(); }
async function patchJson(path, body) { const response = await fetch(`${apiBase}${path}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`); return response.json(); }
async function poll(label, test, limitMs = timeoutMs) { const deadline = Date.now() + limitMs; let lastError = null; while (Date.now() < deadline) { try { const value = await test(); if (value) return value; } catch (error) { lastError = error; } await new Promise((resolve) => setTimeout(resolve, 250)); } throw new Error(`${label} timed out in phase=${activePhase} after ${limitMs}ms${lastError ? `: ${lastError.message}` : ""}`); }
async function loadPlaywright() { try { return await import("playwright"); } catch { try { return await import("@playwright/test"); } catch { return null; } } }
async function writeEvidenceAtomically(path, value) { await mkdir(dirname(path), { recursive: true }); const temporaryPath = `${path}.tmp-${process.pid}`; await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" }); await rename(temporaryPath, path); }

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) main().catch(async (error) => { await writeEvidenceAtomically(evidencePath, { schema_version: "fdm_terminal_webgl_gate.v1", qualification_status: "blocked", no_manual_compute_fields: true, failure: { message: error.message, name: error.name }, workspace_url: workspaceUrl }); console.error(error.stack ?? error.message); process.exitCode = 1; });
