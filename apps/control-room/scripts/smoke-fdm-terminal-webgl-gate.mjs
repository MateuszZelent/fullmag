import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  assertCompletedTerminalFieldContract,
  assertCompletedTerminalTelemetry,
  terminalFieldRequestPath,
} from "./fdm-terminal-field-contract.mjs";

const apiBase = (process.env.CONTROL_ROOM_API_BASE_URL ?? "http://127.0.0.1:8197").replace(/\/$/, "");
const workspaceUrl = process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:3197/workspace";
const artifactDir = process.env.CONTROL_ROOM_FDM_TERMINAL_WEBGL_ARTIFACT_DIR ?? ".fullmag/reports/fdm-terminal-webgl-gate";
const evidencePath = process.env.CONTROL_ROOM_FDM_TERMINAL_WEBGL_EVIDENCE ?? `${artifactDir}/fdm-terminal-webgl-gate.json`;
const timeoutMs = Number(process.env.CONTROL_ROOM_FDM_TERMINAL_WEBGL_TIMEOUT_MS ?? 180_000);
const objectId = process.env.CONTROL_ROOM_FDM_TERMINAL_OBJECT_ID ?? "smoke_box";
const canvasSelector = ".fm-viewport-3d canvas";

async function main() {
  const playwright = await loadPlaywright();
  if (!playwright?.chromium) throw new Error("FDM terminal WebGL smoke requires Playwright Chromium.");
  await mkdir(artifactDir, { recursive: true });
  const stageExecution = await poll("completed FDM stage", async () => {
    const value = await getJson("/v2/sessions/current/simulation/stages/execution");
    return String(value?.runtime_state ?? "").toLowerCase() === "completed" ? value : null;
  });
  const run = await poll("completed FDM run", async () => {
    const value = await getJson("/v2/sessions/current/simulation/runs/current");
    return value?.status === "completed" && Number.isInteger(value?.total_steps) && Number.isFinite(value?.solver_time_seconds) ? value : null;
  });
  const finalStep = run.total_steps;
  const finalTime = run.solver_time_seconds;
  const catalog = await getJson("/v2/sessions/current/data/fields");
  const scopes = { airbox: { scopeId: "airbox", scopeKind: "airbox" }, object: { scopeId: objectId, scopeKind: "object" } };
  const fieldEntries = [
    ["object", "H_demag"], ["object", "H_eff"], ["object", "eden_demag"],
    ["object", "H_ext"],
    ["airbox", "H_demag"], ["airbox", "H_eff"],
  ];
  const fields = Object.fromEntries(await Promise.all(fieldEntries.map(async ([scope, quantityId]) => [
    `${scope}:${quantityId}`,
    await getJson(terminalFieldRequestPath(quantityId, scopes[scope])),
  ])));
  const terminal = assertCompletedTerminalFieldContract({ catalog, fields, finalStep, finalTime, stageExecution });
  const objectMetrics = await getJson(`/v2/sessions/current/simulation/objects/${encodeURIComponent(objectId)}/metrics`);
  const tableRows = await getJson("/v2/sessions/current/data/tables/default/rows?columns=t,dt,mx,my,mz");
  const telemetry = assertCompletedTerminalTelemetry({ finalStep, finalTime, objectMetrics, tableRows });

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
    await page.goto(workspaceUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const canvas = page.locator(canvasSelector);
    await canvas.waitFor({ state: "visible", timeout: timeoutMs });
    const canvasHealth = await canvas.evaluate((node) => {
      const gl = node.getContext("webgl2") ?? node.getContext("webgl");
      const rect = node.getBoundingClientRect();
      return { drawing_buffer: [gl?.drawingBufferWidth ?? 0, gl?.drawingBufferHeight ?? 0], is_context_lost: gl?.isContextLost() ?? true, visible: rect.width > 0 && rect.height > 0 };
    });
    if (!canvasHealth.visible || canvasHealth.is_context_lost || canvasHealth.drawing_buffer.some((value) => value <= 0)) throw new Error(`WebGL canvas unhealthy: ${JSON.stringify(canvasHealth)}`);
    const switches = [];
    switches.push(await switchInspectorQuantity({ page, quantityId: "H_demag", requests, scope: "object", scopes }));
    switches.push(await switchRibbonQuantity({ page, quantityId: "H_eff", requests, scope: "object", scopes }));
    switches.push(await switchInspectorQuantity({ page, quantityId: "H_ext", requests, scope: "object", scopes }));
    switches.push(await switchInspectorQuantity({ page, quantityId: "eden_demag", requests, scope: "object", scopes }));
    const airboxMagnetization = await assertAirboxMagnetizationUnavailable({ page, scopes });
    for (const [scope, quantityId] of [["airbox", "H_demag"], ["airbox", "H_eff"]]) {
      switches.push(await switchInspectorQuantity({ page, quantityId, requests, scope, scopes }));
    }
    const screenshotPath = `${artifactDir}/fdm-terminal-webgl.png`;
    const screenshot = await canvas.screenshot({ path: screenshotPath });
    if (errors.length > 0) throw new Error(`Browser errors: ${errors.join("\\n")}`);
    const evidence = { schema_version: "fdm_terminal_webgl_gate.v1", qualification_status: "passed_cpu_fdm_terminal", terminal, telemetry, run, catalog, fields, airbox_magnetization: airboxMagnetization, canvas: { ...canvasHealth, screenshot: { path: screenshotPath, sha256: createHash("sha256").update(screenshot).digest("hex") } }, field_requests: requests, quantity_switches: switches, no_manual_compute_fields: true, workspace_url: workspaceUrl };
    await writeEvidenceAtomically(evidencePath, evidence);
    console.log(`FDM terminal WebGL gate passed: ${evidencePath}`);
  } finally { await browser.close(); }
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

async function switchInspectorQuantity({ page, quantityId, requests, scope, scopes }) {
  await patchJson("/v2/sessions/current/visualization/state", {
    domains: { active_scope_id: scopes[scope].scopeId, active_scope_kind: scopes[scope].scopeKind },
  });
  const target = page.getByText(scope === "airbox" ? "Airbox" : objectId, { exact: true }).first();
  await target.click({ timeout: timeoutMs });
  const quantity = page.locator('select[aria-label="Quantity Source"]').first();
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

async function assertAirboxMagnetizationUnavailable({ page, scopes }) {
  await patchJson("/v2/sessions/current/visualization/state", {
    domains: { active_scope_id: scopes.airbox.scopeId, active_scope_kind: scopes.airbox.scopeKind },
  });
  await page.getByText("Airbox", { exact: true }).first().click({ timeout: timeoutMs });
  const option = page.locator('select[aria-label="Quantity Source"] option[value="m"]').first();
  const count = await option.count();
  const disabled = count === 0 ? null : await option.isDisabled();
  if (count > 0 && !disabled) throw new Error("Airbox exposes magnetic-only m as an enabled quantity.");
  return { option_count: count, disabled };
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
async function poll(label, test) { const deadline = Date.now() + timeoutMs; let lastError = null; while (Date.now() < deadline) { try { const value = await test(); if (value) return value; } catch (error) { lastError = error; } await new Promise((resolve) => setTimeout(resolve, 250)); } throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`); }
async function loadPlaywright() { try { return await import("playwright"); } catch { try { return await import("@playwright/test"); } catch { return null; } } }
async function writeEvidenceAtomically(path, value) { await mkdir(dirname(path), { recursive: true }); const temporaryPath = `${path}.tmp-${process.pid}`; await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" }); await rename(temporaryPath, path); }

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) main().catch(async (error) => { await writeEvidenceAtomically(evidencePath, { schema_version: "fdm_terminal_webgl_gate.v1", qualification_status: "blocked", no_manual_compute_fields: true, failure: { message: error.message, name: error.name }, workspace_url: workspaceUrl }); console.error(error.stack ?? error.message); process.exitCode = 1; });
