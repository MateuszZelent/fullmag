// Managed proof against the task-owned waiting mixed FEM model.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startBrowserQaLoopbackProxy } from "./lib/browser-qa-loopback-proxy.mjs";
import {
  createInspectorRequestBudgetState,
  recordInspectorRequestBudget,
  resetInspectorDocumentBudget,
} from "./lib/inspector-request-budget.mjs";

export const ACK_SESSION_NAME = "airbox_inspector_mixed";
export const ACK_OBJECT_NAME = "mixed_p1_box_prism";
const schema = "fullmag.docker-dev-inspector-ack-result.v1";
const identityKeys = ["session_id", "session_epoch", "request_scope_epoch"];
const sourceFiles = {
  runner: new URL("./check-inspector-ack-browser.mjs", import.meta.url),
  loopback_proxy: new URL("./lib/browser-qa-loopback-proxy.mjs", import.meta.url),
  request_budget: new URL("./lib/inspector-request-budget.mjs", import.meta.url),
};
const reportDir = "/tmp/fullmag-inspector-ack";
const statusPath = "/v2/sessions/current/status";
const scenePath = "/v2/sessions/current/model/scene";
const MAX_REQUESTS = 512;
const MAX_READS_PER_PATH = 16;

export function inspectorAckSession(status) {
  assert.equal(status?.session?.name, ACK_SESSION_NAME, "The current session is not the task-owned ACK fixture");
  for (const key of identityKeys) {
    assert(typeof status.session[key] === "string" && status.session[key].length > 0
      && status.session[key].length <= 512, "The ACK fixture omitted its session identity");
  }
  assert.equal(status.solver?.state, "awaiting_command", "The ACK fixture must await a command");
  assert.equal(status.lifecycle?.commandability, "allowed");
  assert.equal(status.lifecycle?.connectivity, "connected");
  assert.equal(status.lifecycle?.session_resource, "active");
  return Object.fromEntries([...identityKeys, "name"].map((key) => [key, status.session[key]]));
}

function sameSession(expected, actual) {
  return identityKeys.every((key) => expected?.[key] === actual?.[key])
    && expected?.name === actual?.name;
}

function revision(scene) {
  const value = scene?.scene_revision ?? scene?.revision;
  assert(Number.isSafeInteger(value) && value >= 0, "The ACK scene omitted its revision");
  return value;
}

function objectInScene(scene, objectId) {
  assert(Array.isArray(scene?.objects), "The ACK scene omitted its objects");
  const matches = scene.objects.filter((object) => object?.id === objectId);
  assert.equal(matches.length, 1, "The pinned ACK object is absent or duplicated");
  return matches[0];
}

// This decision never creates a compensating write for an unrelated name or
// session. The returned revision is enforced by the normal object PATCH API.
export function inspectorAckRestoreDecision({ expectedSession, actualSession, objectId, originalName, generatedName, scene }) {
  if (!sameSession(expectedSession, actualSession)) return { state: "unknown", reason: "session-changed" };
  const object = objectInScene(scene, objectId);
  if (object.name === originalName) return { state: "original", revision: revision(scene) };
  if (object.name !== generatedName) return { state: "conflict", reason: "name-changed-by-another-writer" };
  return { state: "restore", patch: { name: originalName, base_revision: revision(scene) } };
}

async function sourceHashes() {
  return Object.fromEntries(await Promise.all(Object.entries(sourceFiles).map(async ([key, path]) => {
    const raw = await fs.readFile(path);
    assert(raw.length <= 2 * 1024 * 1024, "ACK harness source exceeds its pin bound");
    return [key, createHash("sha256").update(raw).digest("hex")];
  })));
}

function sessionScope(session) {
  return "session=" + encodeURIComponent(session.session_id)
    + "&epoch=" + encodeURIComponent(session.session_epoch)
    + "&request_scope_epoch=" + encodeURIComponent(session.request_scope_epoch);
}

function boundedMessage(error) {
  return String(error?.message ?? error).replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 512);
}

function deadline(promise, milliseconds, message) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

export async function runInspectorAck() {
  assert.equal(process.env.CONTROL_ROOM_BROWSER_QA_SCENARIO, "inspector-ack", "Managed Inspector ACK admission is required");
  const upstreamUrl = process.env.CONTROL_ROOM_URL;
  const publicUrl = process.env.CONTROL_ROOM_PUBLIC_URL;
  const expectedSources = JSON.parse(process.env.CONTROL_ROOM_INSPECTOR_ACK_SOURCE_SHA256 ?? "null");
  const beforeHashes = await sourceHashes();
  assert.deepEqual(beforeHashes, expectedSources, "Inspector ACK source pins differ");
  const expectedVersion = process.env.CONTROL_ROOM_EXPECTED_PLAYWRIGHT_VERSION;
  const require = createRequire(import.meta.url);
  const playwrightVersion = require("playwright/package.json").version;
  assert.equal(playwrightVersion, expectedVersion);
  const { chromium } = await import("playwright");
  const timeout = Number(process.env.CONTROL_ROOM_BROWSER_QA_TIMEOUT_MS);
  assert(Number.isInteger(timeout) && timeout >= 30_000 && timeout <= 900_000);
  const startedAt = Date.now();
  const cleanupReserveMs = 20_000;
  const timerBudget = () => Math.max(1, timeout - cleanupReserveMs - (Date.now() - startedAt));
  const budget = createInspectorRequestBudgetState();
  resetInspectorDocumentBudget(budget, "startup");
  const counts = new Map();
  const violations = [];
  const errors = [];
  const receipts = [];
  let totalRequests = 0;
  let phase = "startup";
  let measured = false;
  let measuredRequests = 0;
  let proxy, browser, context, page;
  let pinned, sessionAfter, objectId, original, generated, objectPath, baseline, pending, ack;
  let inspector, name, notes, marker, originalObject;
  let commitRequest = null;
  let commitForwarded = false;
  let commitSettled = false;
  let commitStatus = null;
  let restoreAttempted = false;
  let release;
  let requested;
  const hold = new Promise((resolveHold) => { release = resolveHold; });
  const heldRequest = new Promise((resolveRequest) => { requested = resolveRequest; });
  let failure = null;
  let restoration = { state: "not-needed" };
  let nodePreserved = false;
  let focusPreserved = false;

  function record(method, path, enforce = true) {
    totalRequests++;
    if (totalRequests > MAX_REQUESTS && enforce) throw new Error("Inspector ACK request evidence exceeded its bound");
    if (!measured) return;
    measuredRequests++;
    const key = method + " " + path;
    if (!counts.has(key) && counts.size >= 128) throw new Error("Inspector ACK path inventory exceeded its bound");
    const limit = method === "PATCH" && path === objectPath ? 2
      : ["GET", "HEAD"].includes(method) ? MAX_READS_PER_PATH : 16;
    const result = recordInspectorRequestBudget(budget, { method, requestKey: key, requestLimit: limit });
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (result.exceeded) {
      if (enforce) throw new Error("Inspector ACK per-path request budget exceeded");
      if (violations.length < 16) violations.push("Inspector ACK cleanup exceeded the request budget");
    }
  }

  async function api(path, { method = "GET", data, scoped = true } = {}) {
    // Cleanup readback and its single guarded restoration remain possible
    // after a scenario budget failure. Such a result still cannot pass.
    record(method, path, phase !== "cleanup");
    const response = await page.request.fetch(new URL(path, proxy.origin).href, {
      method,
      ...(data === undefined ? {} : { data }),
      headers: { accept: "application/json", ...(scoped ? { "x-fullmag-session-scope": sessionScope(pinned) } : {}) },
      timeout: 5_000,
    });
    assert(response.ok(), "Inspector ACK API read/write was not acknowledged");
    return { status: response.status(), body: await response.json() };
  }

  async function readPinnedScene() {
    const current = inspectorAckSession((await api(statusPath, { scoped: false })).body);
    assert(sameSession(pinned, current), "Inspector ACK session changed");
    const scene = (await api(scenePath)).body;
    const after = inspectorAckSession((await api(statusPath, { scoped: false })).body);
    assert(sameSession(pinned, after), "Inspector ACK session changed during readback");
    return { session: after, scene };
  }

  async function snapshot() {
    return inspector.evaluate((root) => ({
      fields: [...root.querySelectorAll("input,textarea,select")].map((element) => ({
        label: element.getAttribute("aria-label"), disabled: element.disabled, opacity: getComputedStyle(element).opacity,
      })),
      opacity_animations: root.getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.getKeyframes().some((frame) => "opacity" in frame)).length,
      scroll: root.querySelector(".fm-inspector__content .fm-scroll-area__viewport").scrollTop,
    }));
  }

  try {
    proxy = await startBrowserQaLoopbackProxy(publicUrl, upstreamUrl);
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--use-angle=swiftshader-webgl"],
    });
    context = await browser.newContext({ viewport: { width: 1440, height: 780 }, serviceWorkers: "block" });
    page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => { if (errors.length < 16) errors.push(boundedMessage(error)); });
    page.on("console", (message) => {
      if (message.type() === "error" && errors.length < 16) errors.push(boundedMessage(message.text()));
    });
    page.on("requestfinished", (request) => { if (request === commitRequest) commitSettled = true; });
    page.on("requestfailed", (request) => {
      if (request === commitRequest) commitSettled = true;
      if (phase !== "teardown" && errors.length < 16) errors.push("Request failed: " + new URL(request.url()).pathname);
    });
    page.on("response", (response) => {
      if (response.request() === commitRequest) commitStatus = response.status();
      if (response.status() >= 400 && errors.length < 16) {
        errors.push("HTTP " + response.status() + " " + new URL(response.url()).pathname);
      }
    });
    await page.route("**/v2/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      try {
        record(method, path);
        if (!["GET", "HEAD"].includes(method)) {
          if (method === "PATCH" && path === objectPath && pinned) {
            const body = request.postDataJSON();
            assert.equal(body?.name, restoreAttempted ? original : generated);
            assert(Object.keys(body).every((key) => ["base_revision", "name", "notes", "material_ref", "region_name"].includes(key)));
            if (Object.hasOwn(body, "notes")) assert.equal(body.notes, originalObject.notes ?? "");
            for (const key of ["material_ref", "region_name"]) {
              if (Object.hasOwn(body, key)) assert.equal(body[key], originalObject[key] ?? null);
            }
            assert.equal(request.headers()["x-fullmag-session-scope"], sessionScope(pinned));
            assert(Number.isSafeInteger(body.base_revision) && body.base_revision >= 0);
            if (!restoreAttempted) {
              assert.equal(commitRequest, null, "Inspector ACK submitted duplicate commit PATCH");
              commitRequest = request;
              requested();
              await hold;
              if (phase === "cleanup" && !commitForwarded) return route.abort();
              commitForwarded = true;
            }
          } else {
            assert(method === "POST" && path === "/v2/sessions/current/visualization/client-acks",
              "Inspector ACK refused an unrelated mutation");
          }
        }
        await route.continue();
      } catch (error) {
        if (violations.length < 16) violations.push(boundedMessage(error));
        await route.abort().catch(() => undefined);
      }
    });
    await page.goto(new URL("/workspace", proxy.origin).href, {
      waitUntil: "domcontentloaded", timeout: Math.min(90_000, timerBudget()),
    });
    pinned = inspectorAckSession((await api(statusPath, { scoped: false })).body);
    const scene = (await api(scenePath)).body;
    const objects = scene.objects?.filter((object) => object.name === ACK_OBJECT_NAME);
    assert.equal(objects?.length, 1, "The task-owned ACK object is absent or duplicated");
    originalObject = objects[0];
    objectId = originalObject.id;
    assert(typeof objectId === "string" && objectId.length > 0 && objectId.length <= 512);
    original = objects[0].name;
    generated = original + "_ui_ack_" + randomUUID();
    objectPath = "/v2/sessions/current/model/objects/" + encodeURIComponent(objectId);
    await page.getByRole("treeitem", { name: original, exact: true }).waitFor({ timeout: Math.min(60_000, timerBudget()) });
    await page.getByRole("treeitem", { name: original, exact: true }).click();
    inspector = page.locator(".fm-inspector");
    name = inspector.getByRole("textbox", { name: "Name", exact: true });
    notes = inspector.getByRole("textbox", { name: "Notes", exact: true });
    assert.equal(await name.inputValue(), original);
    await readPinnedScene();
    marker = await inspector.elementHandle();
    baseline = await snapshot();
    assert(baseline.fields.length > 0);
    measured = true;
    resetInspectorDocumentBudget(budget, "ack-apply");
    phase = "commit";
    await name.fill(generated);
    const responsePromise = page.waitForResponse((response) => response.request() === commitRequest, { timeout: 15_000 });
    // Keep the response rejection observed even if an earlier assertion fails.
    responsePromise.catch(() => undefined);
    await inspector.locator(".fm-inspector__action-bar").getByRole("button", { name: "Apply", exact: true }).click();
    await deadline(heldRequest, 10_000, "No object PATCH submitted");
    await notes.focus();
    await inspector.locator(".fm-inspector__content .fm-scroll-area__viewport").evaluate((element) => { element.scrollTop = 90; });
    pending = await snapshot();
    assert.deepEqual(pending.fields, baseline.fields);
    assert.equal(pending.opacity_animations, 0);
    assert(pending.scroll > 0, "Inspector ACK needs a nonzero scroll position");
    assert(await marker.evaluate((element) => element === document.querySelector(".fm-inspector")));
    phase = "ack";
    release();
    const response = await responsePromise;
    const committed = await response.json();
    assert(response.ok(), "The real object commit was not acknowledged");
    receipts.push({ phase: "commit", status: response.status(), revision: revision(committed) });
    await page.getByRole("treeitem", { name: generated, exact: true }).waitFor();
    nodePreserved = await marker.evaluate((element) => element === document.querySelector(".fm-inspector"));
    focusPreserved = await notes.evaluate((element) => element === document.activeElement);
    assert(nodePreserved && focusPreserved, "Inspector ACK lost its node or focus");
    ack = await snapshot();
    assert.deepEqual(ack.fields, baseline.fields);
    assert.equal(ack.opacity_animations, 0);
    assert.equal(ack.scroll, pending.scroll);
    await fs.mkdir(reportDir, { recursive: true });
    await page.screenshot({ path: reportDir + "/ack.png" });
  } catch (error) {
    failure = boundedMessage(error);
  } finally {
    phase = "cleanup";
    release();
    if (pinned && objectId) {
      try {
        const current = await readPinnedScene();
        const decision = inspectorAckRestoreDecision({
          expectedSession: pinned, actualSession: current.session, objectId, originalName: original,
          generatedName: generated, scene: current.scene,
        });
        if (decision.state === "restore") {
          restoreAttempted = true;
          const response = await api(objectPath, { method: "PATCH", data: decision.patch });
          receipts.push({ phase: "restore", status: response.status, revision: revision(response.body) });
          const restored = await readPinnedScene();
          assert.equal(objectInScene(restored.scene, objectId).name, original);
          sessionAfter = restored.session;
          restoration = { state: "restored", revision: revision(restored.scene), name: original };
        } else if (decision.state === "original" && (!commitForwarded || commitSettled || commitStatus !== null)) {
          restoration = { state: "original", revision: decision.revision, name: original };
        } else {
          restoration = { state: decision.state === "conflict" ? "conflict" : "unknown", reason: decision.reason ?? "commit-outcome-unknown" };
        }
      } catch (error) {
        restoration = { state: "unknown", reason: boundedMessage(error) };
      }
    }
    if (restoration.state !== "restored" && commitForwarded) failure ??= "Inspector ACK restoration was not confirmed";
    phase = "teardown";
    await context?.close().catch((error) => { errors.push(boundedMessage(error)); });
    await browser?.close().catch((error) => { errors.push(boundedMessage(error)); });
    await proxy?.close().catch((error) => { errors.push(boundedMessage(error)); });
  }
  const afterHashes = await sourceHashes();
  const patchCount = counts.get("PATCH " + objectPath) ?? 0;
  if (patchCount !== 2 || receipts.length !== 2 || measuredRequests > 128
      || violations.length || errors.length || proxy?.failures.length
      || JSON.stringify(afterHashes) !== JSON.stringify(beforeHashes)) {
    failure ??= "Inspector ACK evidence, request budget or source pins differed";
  }
  const result = {
    schema, state: failure ? "failed" : "passed", scenario: "inspector-ack",
    public_url: publicUrl, probe_url: upstreamUrl, playwright_version: playwrightVersion,
    browser_gpu_mode: process.env.CONTROL_ROOM_BROWSER_GPU_MODE,
    source_sha256_before: beforeHashes, source_sha256_after: afterHashes,
    session: pinned ?? null, session_after: sessionAfter ?? null, object_id: objectId ?? null, original_name: original ?? null,
    generated_name: generated ?? null, baseline: baseline ?? null, pending: pending ?? null, ack: ack ?? null,
    node_preserved: nodePreserved, focus_preserved: focusPreserved,
    receipts, restoration, request_counts: Object.fromEntries(counts), measured_requests: measuredRequests,
    total_requests: totalRequests, request_limit: 128, per_path_read_limit: MAX_READS_PER_PATH,
    violations, errors, proxy_failures: proxy?.failures.slice(0, 16).map(boundedMessage) ?? [],
    failure,
  };
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(reportDir + "/result.json", JSON.stringify(result));
  process.stdout.write(JSON.stringify(result) + "\n");
  if (failure) process.exitCode = 1;
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runInspectorAck();
  } catch (error) {
    process.stdout.write(JSON.stringify({ schema, state: "failed", scenario: "inspector-ack", failure: boundedMessage(error) }) + "\n");
    process.exitCode = 1;
  }
}
