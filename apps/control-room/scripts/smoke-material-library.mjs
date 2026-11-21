import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { waitForAppMenu } from "./lib/app-menu-browser.mjs";

// Exercise the real database and authoring API using task-owned scratch models.
const origin = process.env.CONTROL_ROOM_MATERIAL_SMOKE_ORIGIN;
assert.equal(origin, "http://127.0.0.1:3217", "Use only the isolated material database DEV group on port 3217.");

const { chromium } = createRequire(import.meta.url)("playwright");
const catalogPath = "/v2/workspace/material-library";
const sessionPath = "/v2/sessions/current";
const statusPath = sessionPath + "/status";
const scenePath = sessionPath + "/model/scene";
const transactionPath = sessionPath + "/model/transactions";
const token = randomUUID();
const variantName = "Material smoke variant " + token;
const customName = "Material smoke custom " + token;
const objectName = "Material smoke film " + token;
const builtinId = "builtin:permalloy";
const priorScratchId = process.env.CONTROL_ROOM_MATERIAL_SMOKE_PRIOR_SESSION;
const variantMs = 825000;
const editedMs = 910000;
const checks = [];
const inspectorEvidence = {};
const ownedEntries = new Map();
let sessionId;
let browser;
let context;
let phase = "initialize";
let primaryError;
let releaseMutation;

async function request(path, { method = "GET", status = 200, data, headers } = {}) {
  const response = await fetch(origin + path, {
    method, redirect: "error", signal: AbortSignal.timeout(60_000),
    headers: data === undefined ? headers : { "content-type": "application/json", ...headers },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (response.status !== status) {
    const detail = (await response.text()).slice(0, 800);
    assert.equal(response.status, status, method + " " + path + " returned " + response.status + " " + detail);
  }
  return response.json();
}

async function ownsCurrentModel() {
  const current = await request(statusPath);
  assert.equal(current.session?.session_id, sessionId, "The current model no longer belongs to this smoke.");
  return current;
}

async function startScratch(page, suffix) {
  if (sessionId) await ownsCurrentModel();
  const name = "Material browser " + token + " " + suffix;
  const previous = sessionId ?? priorScratchId;
  if (!sessionId && priorScratchId) {
    const active = (await request(statusPath)).session;
    assert.equal(active?.session_id, priorScratchId, "The prior scratch session ID does not match the current session.");
    assert.match(active.name, /^Material browser [0-9a-f-]{36} [AB]$/, "Only a prior material smoke session may be replaced.");
  }
  const session = await request("/v2/sessions", {
    method: "POST", status: 201,
    data: { name, backend: "fdm", device: "cpu", precision: "double", replace_current: Boolean(previous) },
  });
  assert.equal(typeof session.session_id, "string");
  sessionId = session.session_id;
  assert.notEqual(sessionId, previous);
  assert.equal((await ownsCurrentModel()).session.name, name);
  await page.goto(origin + "/workspace", { waitUntil: "commit" });
  await page.waitForURL((url) => url.origin === origin && url.pathname.startsWith("/session/"));
  await waitForAppMenu(page, "Tools");
  return sessionId;
}

async function waitForScene(predicate, name) {
  const deadline = Date.now() + 20_000;
  do {
    await ownsCurrentModel();
    const scene = await request(scenePath);
    if (predicate(scene)) return scene;
    await delay(200);
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for " + name);
}

async function menu(page, title, item) {
  await page.getByRole("button", { name: title, exact: true }).click();
  await page.getByRole("menuitem", { name: item })
    .and(page.locator(':not([data-disabled]):not([aria-disabled="true"])')).click();
}

async function restoreHistory(page, item) {
  const [response] = await Promise.all([
    page.waitForResponse((reply) => new URL(reply.url()).pathname === transactionPath
      && reply.request().method() === "POST" && reply.request().postDataJSON()?.kind === "replace_scene"),
    menu(page, "Edit", item),
  ]);
  assert.equal(response.status(), 200, "Authoring history restore returned " + response.status());
  const acknowledgement = await response.json();
  assert(Number.isSafeInteger(acknowledgement.scene_revision), "Missing committed scene revision.");
}

async function openDatabase(page) {
  await menu(page, "Tools", /^Material database/);
  const dialog = page.getByRole("dialog", { name: "Material database" });
  await dialog.getByRole("searchbox", { name: "Search materials" }).waitFor();
  return dialog;
}

const button = (scope, name) => scope.getByRole("button", { name, exact: true });
const editorName = (dialog) => dialog.getByLabel("Material name", { exact: true });
const entry = (dialog, id) => dialog.locator('[data-material-id="' + id + '"]');

async function saveEntry(page, dialog, name) {
  const observed = page.waitForResponse((response) => new URL(response.url()).pathname === catalogPath
    && response.request().method() === "POST");
  await button(dialog, "Save to database").click();
  const response = await observed;
  assert.equal(response.status(), 201, "Database creation failed for " + name);
  const saved = await response.json();
  assert.equal(saved.name, name);
  assert.match(saved.id, /^custom:[a-zA-Z0-9:_-]+$/);
  ownedEntries.set(saved.id, { name, revision: saved.revision });
  await dialog.getByText("Material saved to database.", { exact: true }).waitFor();
  return saved;
}

async function findEntry(dialog, saved) {
  await dialog.getByRole("searchbox", { name: "Search materials" }).fill(saved.name);
  await entry(dialog, saved.id).click();
}

async function removeEntry(page, dialog, saved) {
  await findEntry(dialog, saved);
  await button(dialog, "Delete entry").click();
  const confirm = page.getByRole("alertdialog", { name: "Delete " + saved.name + "?" });
  await button(confirm, "Delete from database").click();
  await dialog.getByText("Material removed from database. Model copies are unchanged.", { exact: true }).waitFor();
  const catalog = await request(catalogPath);
  assert(!catalog.entries.some((item) => item.id === saved.id), "The database still contains the deleted entry.");
  ownedEntries.delete(saved.id);
}

function assigned(scene, objectId) {
  const object = (scene.objects ?? []).find((item) => item.id === objectId);
  return (scene.materials ?? []).find((item) => item.id === object?.material_ref);
}

function checkSource(material, saved) {
  assert.equal(material.source?.catalog_id, saved.id);
  assert.equal(material.source.catalog_revision, saved.revision);
  assert.equal(material.source.properties.Ms, saved.properties.Ms);
  assert.deepEqual(material.source.references, saved.references);
}

try {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: "block" });
  const page = await context.newPage();
  await page.addInitScript(() => { window.__FULLMAG_REACT_PROFILER__ = true; });
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(120_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  phase = "built-in and variant";
  const firstSession = await startScratch(page, "A");
  const original = (await request(catalogPath)).entries.find((item) => item.id === builtinId);
  assert.equal(original?.kind, "builtin");
  let dialog = await openDatabase(page);
  await dialog.getByRole("searchbox", { name: "Search materials" }).fill("Permalloy");
  await entry(dialog, builtinId).click();
  await dialog.getByText(/Read-only original/).waitFor();
  assert.equal(await button(dialog, "Edit entry").count(), 0);
  assert.equal(await button(dialog, "Delete entry").count(), 0);
  await button(dialog, "Create variant").click();
  await editorName(dialog).fill(variantName);
  await dialog.getByLabel("Ms (A/m)", { exact: true }).fill(String(variantMs));
  await dialog.getByRole("heading", { name: "Source: " + original.name }).waitFor();

  phase = "dirty draft and save";
  await page.keyboard.press("Escape");
  const discard = page.getByRole("alertdialog", { name: "Discard unsaved changes?" });
  await button(discard, "Keep editing").click();
  assert.equal(await editorName(dialog).inputValue(), variantName);
  const variant = await saveEntry(page, dialog, variantName);
  assert.equal(variant.kind, "modified");
  assert.equal(variant.source.catalog_id, builtinId);
  assert.deepEqual(variant.references, original.references);
  const catalog = await request(catalogPath);
  assert.deepEqual(catalog.entries.find((item) => item.id === builtinId), original);
  assert.equal((await request(scenePath)).materials?.length ?? 0, 0, "Database save changed the empty model.");
  checks.push("read-only original, variant source and independent save", "Escape preserves a dirty draft");

  phase = "custom entry";
  await button(dialog, "New material").click();
  await editorName(dialog).fill(customName);
  await dialog.getByLabel("alpha (1)", { exact: true }).fill("0.007");
  const custom = await saveEntry(page, dialog, customName);
  assert.equal(custom.kind, "custom");
  assert.equal(custom.source, null);
  await findEntry(dialog, custom);
  await button(dialog, "Edit entry").click();
  await dialog.getByLabel("Summary", { exact: true }).fill("Retain this unsaved edit after conflict.");
  const concurrentEdit = await request(catalogPath + "/" + encodeURIComponent(custom.id), {
    method: "PUT",
    data: {
      base_revision: custom.revision,
      name: custom.name,
      properties: custom.properties,
      summary: "Written from another catalog client.",
    },
  });
  ownedEntries.set(custom.id, { name: custom.name, revision: concurrentEdit.revision });
  const conflictResponse = page.waitForResponse((response) =>
    response.request().method() === "PUT" && new URL(response.url()).pathname.startsWith(catalogPath + "/"));
  await button(dialog, "Save to database").click();
  assert.equal((await conflictResponse).status(), 409);
  await dialog.getByText(/Your draft is preserved/).waitFor();
  assert.equal(await dialog.getByLabel("Summary", { exact: true }).inputValue(), "Retain this unsaved edit after conflict.");
  await button(dialog, "Reload catalog entry").click();
  await button(page.getByRole("alertdialog", { name: "Discard unsaved changes?" }), "Discard changes").click();
  await dialog.getByText(concurrentEdit.summary, { exact: true }).first().waitFor();
  await removeEntry(page, dialog, concurrentEdit);

  phase = "catalog in another model";
  await button(dialog, "Close material database").click();
  await dialog.waitFor({ state: "hidden" });
  const secondSession = await startScratch(page, "B");
  assert.notEqual(secondSession, firstSession);
  assert.equal((await request(scenePath)).materials?.length ?? 0, 0);
  await page.getByRole("button", { name: /command search/i }).first().click();
  await page.getByPlaceholder("Search commands").fill("Add Box");
  await page.getByRole("option").filter({ hasText: "Add Box" }).first().click();
  await page.getByText("Primitive Geometry", { exact: true }).first().waitFor();
  await page.locator('input[aria-label="Name"]').fill(objectName);
  await page.locator('input[aria-label="Region"]').fill("material-smoke-" + token);
  for (const [label, size] of [["Size X", "1.6e-7"], ["Size Y", "8e-8"], ["Size Z", "1.2e-8"]]) {
    await page.locator('input[aria-label="' + label + '"]').fill(size);
  }
  await button(page, "Apply Draft").click();
  const populated = await waitForScene((scene) => scene.objects?.some((item) => item.name === objectName), "scratch geometry");
  const object = populated.objects.find((item) => item.name === objectName);
  await page.getByTitle("Expand All").click();
  const magneticNode = "model:object:" + object.id + ":magnetic-parameters";
  await page.locator('[data-node-id="' + magneticNode + '"]').click();
  const choose = button(page, "Choose from database");
  await choose.click();
  dialog = page.getByRole("dialog", { name: "Material database" });
  await findEntry(dialog, variant);
  await button(dialog, "Use in model").click();
  await dialog.waitFor({ state: "hidden" });
  const imported = assigned(await waitForScene((scene) => assigned(scene, object.id)?.source?.catalog_id === variant.id, "atomic assignment"), object.id);
  checkSource(imported, variant);
  assert.equal(imported.properties.Ms, variantMs);
  assert.deepEqual(imported.references, variant.references);
  checks.push("custom entry, revision conflict and draft preservation", "same catalog in a new model, atomic use via Inspector");

  phase = "undo and redo assignment";
  await restoreHistory(page, /^Undo/);
  await waitForScene((scene) => !assigned(scene, object.id)?.source, "undo");
  await restoreHistory(page, /^Redo/);
  await waitForScene((scene) => assigned(scene, object.id)?.source?.catalog_id === variant.id, "redo");
  checks.push("undo and redo assignment");

  phase = "published version keyboard selection";
  // Only the catalog projection is substituted. The model write and history
  // restore below use the real authoring API and leave no publication behind.
  const versionKey = "sample_" + token.replaceAll("-", "");
  const versionSource = {
    catalog_id: "custom:published:permalloy:" + versionKey,
    catalog_revision: variant.revision,
    name: variant.name,
    kind: variant.kind,
    properties: variant.properties,
    references: variant.references,
    version: { family: "permalloy", version: versionKey, source_project: "Material browser " + token + " A" },
  };
  const version = { source: versionSource, original: variant.source, display_name: variantName + " published", archived: false, revision: variant.revision };
  const earlier = {
    ...version, display_name: variantName + " archived", archived: true,
    source: { ...versionSource, catalog_id: versionSource.catalog_id + "_older", version: { ...versionSource.version, version: versionKey + "_older" } },
  };
  const catalogPattern = "**" + catalogPath;
  const versionCatalog = async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const snapshot = await response.json();
    await route.fulfill({ response, json: { ...snapshot, versions: [...(snapshot.versions ?? []), version, earlier] } });
  };
  await page.route(catalogPattern, versionCatalog);
  try {
    await choose.click();
    dialog = page.getByRole("dialog", { name: "Material database" });
    const search = dialog.getByRole("searchbox", { name: "Search materials" });
    await search.fill("permalloy." + versionKey);
    const activeVersion = entry(dialog, versionSource.catalog_id);
    await activeVersion.focus();
    await page.keyboard.press("Enter");
    const heading = dialog.getByRole("heading", { name: version.display_name, exact: true });
    await heading.waitFor();
    await page.waitForFunction((id) => document.activeElement?.id === id, await heading.getAttribute("id"));
    await dialog.getByRole("heading", { name: /Compared with original/ }).waitFor();
    assert.equal(await entry(dialog, earlier.source.catalog_id).count(), 0);
    await button(dialog, "Show archived versions").click();
    await entry(dialog, earlier.source.catalog_id).click();
    assert.equal(await button(dialog, "Use in model").count(), 0);
    await activeVersion.click();
    await button(dialog, "Use in model").focus();
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "hidden" });
    const versionScene = await waitForScene((scene) => assigned(scene, object.id)?.source?.catalog_id === versionSource.catalog_id, "published assignment");
    const versionCopy = assigned(versionScene, object.id);
    assert.equal(versionCopy.name, version.display_name);
    assert.deepEqual(versionCopy.source, versionSource);
    assert.deepEqual(versionCopy.properties, versionSource.properties);
    await restoreHistory(page, /^Undo/);
    await waitForScene((scene) => assigned(scene, object.id)?.source?.catalog_id === variant.id, "undo published assignment");
    checks.push("keyboard selection, archive visibility and atomic published snapshot assignment");
  } finally {
    await page.unroute(catalogPattern, versionCatalog);
  }

  phase = "manual edit and ACK";
  await page.locator('[data-node-id="' + magneticNode + ':material"]').click();
  await page.getByText("Unmodified copy", { exact: true }).waitFor();
  const panel = page.locator(".fm-inspector");
  // Track the existing Inspector profiler and the browser's model scene reads
  // from the first edit through acknowledgement, excluding API readback below.
  await panel.evaluate((element) => {
    element.dataset.materialSmokeRoot = "retained";
    for (const entry of performance.getEntriesByType("measure")) {
      if (entry.name.startsWith("fullmag.react.render.InspectorModule")) performance.clearMeasures(entry.name);
    }
  });
  let sceneReads = 0;
  const observeSceneRead = (outgoing) => {
    if (outgoing.method() === "GET" && new URL(outgoing.url()).pathname === scenePath) sceneReads++;
  };
  page.on("request", observeSceneRead);
  await panel.getByRole("textbox", { name: "Ms", exact: true }).fill(String(editedMs));
  let observeMutation;
  const mutationSeen = new Promise((resolve) => { observeMutation = resolve; });
  const mutationRelease = new Promise((resolve) => { releaseMutation = resolve; });
  const pattern = "**" + transactionPath + "*";
  let patchCount = 0;
  const holdAck = async (route) => {
    if (route.request().method() !== "POST" || route.request().postDataJSON()?.kind !== "patch_material") {
      await route.continue();
      return;
    }
    patchCount++;
    const response = await route.fetch({ maxRedirects: 0 });
    observeMutation(response.status());
    await mutationRelease;
    await route.fulfill({ response });
  };
  await page.route(pattern, holdAck);
  await button(panel, "Apply Parameters").click();
  const patchStatus = await Promise.race([
    mutationSeen,
    delay(12_000, null, { ref: false }),
  ]);
  assert.equal(patchStatus, 200, "Manual edit did not produce a successful authoring transaction.");
  await panel.getByRole("textbox", { name: "Aex", exact: true }).focus();
  const pending = await panel.evaluate((element) => {
    const control = element.querySelector('input[aria-label="Aex"]');
    const scroll = element.querySelector(".fm-scroll-area__viewport");
    return {
      root: element.dataset.materialSmokeRoot,
      focused: document.activeElement === control,
      disabled: control?.disabled,
      opacity: control && getComputedStyle(control).opacity,
      scroll: scroll?.scrollTop,
      opacityAnimations: element.getAnimations({ subtree: true }).filter((animation) =>
        animation.effect?.getKeyframes?.().some((frame) => "opacity" in frame)).length,
    };
  });
  assert.equal(pending.root, "retained");
  assert.equal(pending.focused, true);
  assert.equal(pending.disabled, false);
  assert.equal(pending.opacity, "1");
  assert.equal(pending.opacityAnimations, 0);
  releaseMutation();
  releaseMutation = undefined;
  await page.getByText("Modified in model", { exact: true }).waitFor();
  await page.unroute(pattern, holdAck);
  const acknowledged = await panel.evaluate((element) => {
    const control = element.querySelector('input[aria-label="Aex"]');
    return {
      root: element.dataset.materialSmokeRoot,
      focused: document.activeElement === control,
      disabled: control?.disabled,
      opacity: control && getComputedStyle(control).opacity,
      scroll: element.querySelector(".fm-scroll-area__viewport")?.scrollTop,
      opacityAnimations: element.getAnimations({ subtree: true }).filter((animation) =>
        animation.effect?.getKeyframes?.().some((frame) => "opacity" in frame)).length,
    };
  });
  assert.deepEqual(acknowledged, { ...pending, root: "retained" });
  assert.equal(patchCount, 1);
  page.off("request", observeSceneRead);
  const renders = await page.evaluate(() => performance.getEntriesByType("measure")
    .filter((entry) => entry.name.startsWith("fullmag.react.render.InspectorModule")).length);
  assert(renders > 0 && renders <= 12, "Expected 1–12 Inspector profiler samples through ACK, got " + renders);
  assert(sceneReads <= 8, "Expected at most eight model scene reads through ACK, got " + sceneReads);
  Object.assign(inspectorEvidence, { renders, sceneReads, patchCount });
  const edited = assigned(await waitForScene((scene) => assigned(scene, object.id)?.properties.Ms === editedMs, "edited material"), object.id);
  checkSource(edited, variant);
  assert.equal((await request(catalogPath)).entries.find((item) => item.id === variant.id).properties.Ms, variantMs);
  checks.push("manual edit with stable Inspector across acknowledgement");

  phase = "database deletion preserves model";
  dialog = await openDatabase(page);
  await removeEntry(page, dialog, variant);
  await button(dialog, "Close material database").click();
  await dialog.waitFor({ state: "hidden" });
  await ownsCurrentModel();
  assert.deepEqual(assigned(await request(scenePath), object.id), edited);
  await page.reload({ waitUntil: "domcontentloaded" });
  await ownsCurrentModel();
  assert.deepEqual(assigned(await request(scenePath), object.id), edited);
  checks.push("deleting a source leaves the edited model copy and provenance intact after reload");

  phase = "project archive";
  const finalScene = await request(scenePath);
  // SceneResource adds transport metadata to the authoring document.
  const documentKeys = [
    "version", "revision", "scene", "universe", "objects", "couplings",
    "materials", "magnetization_assets", "field_drives", "monitors", "selections",
    "magnetization_constraints", "current_modules", "current_transports",
    "spin_transports", "spin_torques", "oersted_fields", "study", "outputs", "editor",
    "antenna_port_modes", "antenna_field_solve_stages", "antenna_target_projections",
    "solved_antenna_drives", "antenna_spectrum_requests",
  ];
  const sceneDocument = Object.fromEntries(documentKeys.filter((key) => key in finalScene)
    .map((key) => [key, finalScene[key]]));
  const { session } = await ownsCurrentModel();
  const scope = "session=" + encodeURIComponent(session.session_id)
    + "&epoch=" + encodeURIComponent(session.session_epoch)
    + "&request_scope_epoch=" + encodeURIComponent(session.request_scope_epoch);
  const headers = { "x-fullmag-session-scope": scope };
  // The material editor accepts incomplete models. Canonical export requires
  // an initial magnetization on the authored magnetic object.
  const magnetizationId = "mag:material-smoke:" + token;
  sceneDocument.magnetization_assets = [...(sceneDocument.magnetization_assets ?? []), {
    id: magnetizationId, name: "Material smoke initial magnetization", kind: "uniform", value: [1, 0, 0],
  }];
  sceneDocument.objects = sceneDocument.objects.map((item) => item.id === object.id
    ? { ...item, magnetization_ref: magnetizationId } : item);
  const committed = await request(transactionPath, {
    method: "POST", headers,
    data: { kind: "replace_scene", base_revision: finalScene.scene_revision ?? finalScene.revision, scene: sceneDocument },
  });
  const projectPath = "/v2/persistence/projects";
  const displayName = "Material smoke " + token;
  const empty = await request(projectPath, { method: "POST", status: 201, data: { name: displayName } });
  const saved = await request(projectPath + "/authoring", {
    method: "POST",
    data: {
      expected_project_id: empty.project_id, expected_revision: empty.revision,
      archive_base64: empty.archive_base64, display_name: displayName + ".fms",
      scene_document: sceneDocument,
    },
  });
  const reopened = await request(projectPath + "/open", {
    method: "POST",
    data: { archive_base64: saved.archive_base64, display_name: displayName + ".fms" },
  });
  assert.equal(reopened.project_id, empty.project_id);
  const reopenedMaterial = assigned(reopened.authoring_scene_document, object.id);
  assert.equal(reopenedMaterial.properties.Ms, editedMs);
  checkSource(reopenedMaterial, variant);
  checks.push("portable project archive retains the detached material and origin");

  phase = "Python round trip";
  await ownsCurrentModel();
  const script = await request(sessionPath + "/model/syncs", {
    method: "POST", headers,
    data: { expected_scene_revision: committed.scene_revision },
  });
  assert.equal(script.written, true);
  assert.match(script.source, /material_assets/);
  // Execute only the canonical source rendered above from this generated model.
  const reimported = await request(projectPath + "/from-script", {
    method: "POST", status: 201,
    data: {
      source: { name: "material-smoke.py", text: script.source },
      project_name: displayName + " Python",
      origin: "material-library-browser-smoke",
      consent: { executed_by_user: true },
    },
  });
  const pythonMaterial = assigned(reimported.scene_document, object.id);
  assert.equal(pythonMaterial.properties.Ms, editedMs);
  checkSource(pythonMaterial, variant);
  assert.deepEqual(pageErrors, []);
  checks.push("canonical Python export and import preserve parameters and source snapshot");
} catch (error) {
  primaryError = error;
} finally {
  releaseMutation?.();
  // On partial failure, retire only rows created by this invocation and still
  // at the observed revision. A conflict preserves the other writer's row.
  if (context && ownedEntries.size) {
    try {
      const catalog = await request(catalogPath);
      for (const row of catalog.entries) {
        const owned = ownedEntries.get(row.id);
        if (owned?.name !== row.name || owned.revision !== row.revision) continue;
        await request(catalogPath + "/" + encodeURIComponent(row.id), {
          method: "DELETE", data: { base_revision: row.revision },
        });
      }
    } catch (error) {
      primaryError ??= error;
    }
  }
  await browser?.close();
}

console.log(JSON.stringify({
  schema: "fullmag.material-library-browser-smoke.v1",
  state: primaryError ? "failed" : "passed",
  phase,
  sessionId: sessionId ?? null,
  checks,
  inspector: inspectorEvidence,
  error: primaryError ? String(primaryError.message).slice(0, 500) : null,
}, null, 2));
if (primaryError) process.exitCode = 1;
