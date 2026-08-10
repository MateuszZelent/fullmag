import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { inflateSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

import { createSmokeMutationGuard } from "./lib/smoke-session-isolation.mjs";
import { resolvePnpmInvocation } from "./resolve-pnpm-invocation.mjs";
import {
  assertScenarioHashesUnchanged,
  captureScenarioHashes,
  resolveRepositoryScenarioPaths,
} from "./smoke-viewport-3d-explorer-inspector-targets-isolation.mjs";

const configuredUrl = process.env.CONTROL_ROOM_URL ?? null;
const reuseFixtureFrontendOnly =
  process.env.CONTROL_ROOM_TARGET_SMOKE_REUSE_FRONTEND_ONLY === "1";
const requestedPort = Number(process.env.CONTROL_ROOM_TARGET_SMOKE_PORT ?? 0);
const apiBase = configuredUrl
  ? process.env.CONTROL_ROOM_API_BASE_URL ?? "http://fullmag-target-smoke.fixture.invalid"
  : "http://fullmag-target-smoke.fixture.invalid";
const timeoutMs = Number(process.env.CONTROL_ROOM_TARGET_SMOKE_TIMEOUT_MS ?? 30_000);
const CANVAS_SELECTOR = ".fm-viewport-3d canvas";
const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(appDir, "../..");
const browserAuditArtifactDir = join(appDir, ".artifacts", "viewport-3d-browser-audit");
// Keep enough rendered support cells for canvas-delta assertions while still
// retaining a strict outside-support Airbox and two independent regions.
// The physical extent remains [-1, 1]^3 with a central [-0.5, 0.5]^3 support.
const FDM_TARGET_GRID_SHAPE = [8, 8, 8];
const FDM_TARGET_GRID_CELL_COUNT = FDM_TARGET_GRID_SHAPE.reduce((a, b) => a * b, 1);
const FDM_TARGET_GRID_ORIGIN = [-1, -1, -1];
const FDM_TARGET_GRID_SPACING = [0.25, 0.25, 0.25];
const repositoryScenarioHashes = await captureScenarioHashes(
  resolveRepositoryScenarioPaths({ env: process.env, repositoryRoot }),
);

if (
  reuseFixtureFrontendOnly &&
  (!configuredUrl || apiBase !== "http://fullmag-target-smoke.fixture.invalid")
) {
  throw new Error(
    "CONTROL_ROOM_TARGET_SMOKE_REUSE_FRONTEND_ONLY requires CONTROL_ROOM_URL and the isolated fixture API origin.",
  );
}

const playwright = await loadPlaywright();
if (!playwright?.chromium) {
  throw new Error("Explorer/Inspector target smoke requires Playwright.");
}

if (process.env.CONTROL_ROOM_TARGET_SMOKE_VALIDATE_FIXTURE_ONLY === "1") {
  const fixture = createFdmFixture();
  console.log(
    `FDM target fixture validated: ${JSON.stringify({
      activeCellCount: fixture.fdmMembership.magnetic_support.active_cell_count,
      cellCount: fixture.fdmMembership.cell_count,
      grid: fixture.fdmMembership.counts,
      inactiveCellCount: fixture.fdmMembership.magnetic_support.inactive_cell_count,
      supportBounds: {
        max: fixture.fdmMembership.magnetic_support.bounds_max_m,
        min: fixture.fdmMembership.magnetic_support.bounds_min_m,
      },
    })}`,
  );
  process.exit(0);
}

let browser = null;
let mutationGuard = null;
let removeMutationProcessGuards = null;
let runtime = null;
let runFailure = null;
try {
  runtime = configuredUrl ? null : await startRuntime();
  const url = configuredUrl ?? runtime.url;
  mutationGuard = await createSmokeMutationGuard({
    apiBase,
    env: process.env,
    mutationRequired: configuredUrl !== null && !reuseFixtureFrontendOnly,
    pageUrl: url,
  });
  removeMutationProcessGuards = mutationGuard.installProcessGuards();
  browser = await playwright.chromium.launch();
  const fdmOnly = process.env.CONTROL_ROOM_TARGET_SMOKE_PHASE === "fdm";
  const femOnly = process.env.CONTROL_ROOM_TARGET_SMOKE_PHASE === "fem";
  const fdm = femOnly ? null : await verifyFdmObjectAndAirboxTargets(browser, url);
  const fieldFailures = fdmOnly || femOnly ? null : await verifyFdmFieldFailureRecovery(browser, url);
  const fem = fdmOnly ? null : await verifyFemObjectTargetAndFallback(browser, url);
  console.log(`Explorer/Inspector target smoke passed: ${JSON.stringify({ fdm, fem, fieldFailures, url })}`);
} catch (error) {
  runFailure = error;
  throw error;
} finally {
  const cleanupFailures = [];
  const cleanup = async (label, operation) => {
    try {
      await operation();
    } catch (error) {
      cleanupFailures.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`));
    }
  };
  if (browser) await cleanup("browser close", () => browser.close());
  if (runtime) await cleanup("isolated runtime stop", () => runtime.stop());
  let mutationRestored = mutationGuard === null;
  if (mutationGuard) {
    try {
      mutationGuard.restoreAndVerify();
      mutationRestored = true;
    } catch (error) {
      cleanupFailures.push(
        new Error(
          `restore disposable smoke script: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
  if (removeMutationProcessGuards && mutationRestored) {
    await cleanup("remove mutation process guards", () => removeMutationProcessGuards());
  }
  await cleanup("repository scenario SHA-256 check", () => assertScenarioHashesUnchanged(repositoryScenarioHashes));
  if (cleanupFailures.length > 0) {
    const cleanupError = new AggregateError(cleanupFailures, "Target smoke cleanup failed.");
    if (runFailure) {
      console.error(cleanupError);
    } else {
      throw cleanupError;
    }
  }
}

async function verifyFdmFieldFailureRecovery(browser, url) {
  const cases = ["empty", "stale", "mismatch"];
  const failures = [];
  for (const fieldMode of cases) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const fixture = createFdmFixture();
    fixture.fieldMode = fieldMode;
    const errors = attachBrowserErrors(page);
    await installFixtureApi(page, fixture);
    await installFixtureConfig(page);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      await requestFdmField(page, "m");
      const failed = await waitForFdmFieldResource(page, "m");
      if (failed.hasValues) {
        throw new Error(`${fieldMode} field response was rendered instead of failing closed: ${JSON.stringify(failed)}.`);
      }
      fixture.fieldMode = "ready";
      await requestFdmField(page, "H_eff");
      await waitForFdmFieldResource(page, "H_eff");
      const recoveryBaseline = await sampleViewportPixels(page);
      const mRequestsBeforeRecovery = countFieldRequests(fixture, { quantityId: "m" });
      await requestFdmField(page, "m");
      const recovered = await waitForFdmFieldResource(page, "m");
      if (!recovered.hasValues || recovered.key !== failed.key) {
        throw new Error(`${fieldMode} recovery did not rematerialize the same resource key: ${JSON.stringify({ failed, recovered })}.`);
      }
      const mRequestsAfterRecovery = countFieldRequests(fixture, { quantityId: "m" });
      if (mRequestsAfterRecovery !== mRequestsBeforeRecovery + 1) {
        throw new Error(`${fieldMode} recovery did not issue exactly one new m request: ${JSON.stringify({ mRequestsAfterRecovery, mRequestsBeforeRecovery, requests: fixture.fieldRequests })}.`);
      }
      const recoveryDelta = await waitForViewportPixelDelta(page, recoveryBaseline, `${fieldMode} same-page recovery`);
      await assertHealthyCanvas(page, `FDM ${fieldMode} field response`);
      assertNoBrowserErrors(errors);
      failures.push({ fieldMode, recoveryDelta, resourceKey: failed.key });
    } finally {
      await page.close();
    }
  }
  return { failedClosed: failures, recovered: true };
}

async function verifyFdmObjectAndAirboxTargets(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const fixture = createFdmFixture();
  const errors = attachBrowserErrors(page);
  await installFixtureApi(page, fixture);
  await installFixtureConfig(page);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await assertHealthyCanvas(page, "FDM initial");

    if (process.env.CONTROL_ROOM_TARGET_SMOKE_AIRBOX_ONLY === "1") {
      await selectAirboxVisualization(page);
      const geometry = await verifyAirboxGeometryModes(page, "fdm");
      await setAirboxGeometryOff(page);
      const vectorDeltas = await verifyAirboxVectorQuantities(page, fixture, "fdm");
      return { airboxDebug: true, fieldRequests: fixture.fieldRequests, geometry, vectorDeltas };
    }

    const a = await selectVisualizationNode(page, "fdm-left", null);
    await assertTarget(page, "object:fdm-left");
    const aBefore = await sampleViewportPixels(page);
    await assertNoViewportPixelDelta(page, aBefore, "FDM target no-op negative control");
    await setObjectDisplayState(page, { colorbar: true, vectors: true, wireframe: true });
    const aDelta = await waitForViewportPixelDelta(page, aBefore, "FDM left object controls");
    const aRenderModeDeltas = await verifyPrimaryRenderModeCycle(page, "FDM left object");
    await setObjectDisplayState(page, { colorbar: true, vectors: true, wireframe: true });
    const aState = await readTargetControls(page);

    const b = await selectVisualizationNode(page, "fdm-right", null);
    await assertTarget(page, "object:fdm-right");
    const bBefore = await readTargetControls(page);
    if (sameControlState(aState, bBefore)) {
      throw new Error(`FDM objects share visualization state: ${JSON.stringify({ aState, bBefore })}`);
    }
    const bBeforePixels = await sampleViewportPixels(page);
    await assertNoViewportPixelDelta(page, bBeforePixels, "FDM right object no-op negative control");
    await setObjectDisplayState(page, { colorbar: false, vectors: false, wireframe: false, visible: false });
    const bDelta = await waitForViewportPixelDelta(page, bBeforePixels, "FDM right object controls");
    const bState = await readTargetControls(page);

    await selectVisualizationNode(page, "fdm-left", null);
    const aRecovered = await readTargetControls(page);
    if (!sameControlState(aState, aRecovered)) {
      throw new Error(`FDM left object did not recover its independent state: ${JSON.stringify({ aState, aRecovered, bState })}`);
    }

    const leftRegionTarget = await selectVisualizationNode(page, "fdm-left", "core");
    const leftRegionBeforePixels = await sampleViewportPixels(page);
    await assertNoViewportPixelDelta(page, leftRegionBeforePixels, "FDM left same-named region no-op negative control");
    await setObjectDisplayState(page, { colorbar: false, vectors: false, wireframe: false });
    const leftRegionDelta = await waitForViewportPixelDelta(page, leftRegionBeforePixels, "FDM left same-named region controls");
    const leftRegionState = await readTargetControls(page);
    const rightRegionTarget = await selectVisualizationNode(page, "fdm-right", "core");
    const rightRegionBeforePixels = await sampleViewportPixels(page);
    await assertNoViewportPixelDelta(page, rightRegionBeforePixels, "FDM right same-named region no-op negative control");
    const rightRegionState = await readTargetControls(page);
    if (leftRegionTarget === rightRegionTarget || sameControlState(leftRegionState, rightRegionState)) {
      throw new Error(`Same-named FDM regions are not independent: ${JSON.stringify({ leftRegionTarget, rightRegionTarget, leftRegionState, rightRegionState })}`);
    }
    await setObjectDisplayState(page, { colorbar: true, vectors: true, wireframe: true });
    const rightRegionDelta = await waitForViewportPixelDelta(page, rightRegionBeforePixels, "FDM right same-named region controls");
    await selectVisualizationNode(page, "fdm-left", "core");
    const leftRegionRecovered = await readTargetControls(page);
    if (!sameControlState(leftRegionState, leftRegionRecovered)) {
      throw new Error(`FDM left region state leaked after editing the same-named right region: ${JSON.stringify({ leftRegionState, leftRegionRecovered })}`);
    }

    await selectAirboxVisualization(page);
    const geometry = await verifyAirboxGeometryModes(page, "fdm");
    await setAirboxGeometryOff(page);
    const airboxVectors = await assertAirboxControls(page);
    const airboxBefore = await sampleViewportPixels(page, 1);
    await airboxVectors.click();
    const airboxDelta = await waitForViewportPixelDelta(page, airboxBefore, "Airbox vectors", {
      minimumChangedPixels: 100,
    });
    await assertHealthyCanvas(page, "FDM Explorer/Inspector interactions");
    assertNoBrowserErrors(errors);
    assertFieldRequest(fixture, { component: "full", quantityId: "m", scopeId: null, scopeKind: "full" });
    await captureBrowserAuditScreenshot(page, "target-smoke-fdm-success.png");
    return { aDelta, aRenderModeDeltas, airboxDelta, bDelta, fieldRequests: fixture.fieldRequests, geometry, leftRegionDelta, objectTargets: [a, b], regionTargets: [leftRegionTarget, rightRegionTarget], rightRegionDelta };
  } finally {
    await page.close();
  }
}

async function verifyFemObjectTargetAndFallback(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const fixture = createFemFixture();
  const errors = attachBrowserErrors(page);
  await installFixtureApi(page, fixture);
  await installFixtureConfig(page);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await assertHealthyCanvas(page, "FEM initial");
    if (process.env.CONTROL_ROOM_TARGET_SMOKE_AIRBOX_ONLY === "1") {
      await selectAirboxVisualization(page);
      const geometry = await verifyAirboxGeometryModes(page, "fem");
      await setAirboxGeometryOff(page);
      const vectorDeltas = await verifyAirboxVectorQuantities(page, fixture, "fem");
      assertNoBrowserErrors(errors);
      return { airboxOnly: true, fieldRequests: fixture.fieldRequests, geometry, vectorDeltas };
    }
    await selectVisualizationNode(page, "fem-owned", null);
    await assertTarget(page, "object:fem-owned");
    const ownedBeforePixels = await sampleViewportPixels(page);
    await assertNoViewportPixelDelta(page, ownedBeforePixels, "FEM owned target no-op negative control");
    await setObjectDisplayState(page, { colorbar: true, vectors: true, wireframe: true });
    const ownedDelta = await waitForViewportPixelDelta(page, ownedBeforePixels, "FEM owned target controls");
    const ownedRenderModeDeltas = await verifyPrimaryRenderModeCycle(page, "FEM owned object");
    await setObjectDisplayState(page, { colorbar: true, vectors: true, wireframe: true });
    const owned = await readTargetControls(page);
    await selectVisualizationNode(page, "fem-fallback", null);
    await assertTarget(page, "object:fem-fallback");
    const fallbackBeforePixels = await sampleViewportPixels(page);
    await assertNoViewportPixelDelta(page, fallbackBeforePixels, "FEM fallback target no-op negative control");
    await setObjectDisplayState(page, { colorbar: false, vectors: false, wireframe: false });
    const fallbackDelta = await waitForViewportPixelDelta(page, fallbackBeforePixels, "FEM fallback target controls");
    const fallback = await readTargetControls(page);
    if (sameControlState(owned, fallback)) {
      throw new Error(`FEM object target and fallback share state: ${JSON.stringify({ owned, fallback })}`);
    }
    await selectAirboxVisualization(page);
    await verifyAirboxGeometryModes(page, "fem");
    await assertAirboxControls(page);
    await setAirboxQuantityAndVectors(page, "H_demag");
    await waitForFieldRequest(page, { component: "full", quantityId: "H_demag", scopeId: "part-airbox", scopeKind: "airbox" });
    assertFieldRequest(fixture, { component: "full", quantityId: "H_demag", scopeId: "part-airbox", scopeKind: "airbox" });
    await assertHealthyCanvas(page, "FEM target/fallback interactions");
    assertNoBrowserErrors(errors);
    await captureBrowserAuditScreenshot(page, "target-smoke-fem-success.png");
    return { fallbackDelta, fallbackTarget: "object:fem-fallback", fieldRequests: fixture.fieldRequests, ownedDelta, ownedRenderModeDeltas, ownedTarget: "object:fem-owned" };
  } finally {
    await page.close();
  }
}

async function installFixtureConfig(page) {
  await page.addInitScript((baseUrl) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      allowMissingSessionSmoke: true,
      controlRoomApiBase: baseUrl,
      disableRealtime: true,
    };
  }, apiBase);
}

async function installFixtureApi(page, fixture) {
  await page.route("**/v2/sessions/current/**", async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    const path = requestUrl.pathname;
    fixture.requests.push(`${request.method()} ${path}${requestUrl.search}`);
    if (request.method() === "OPTIONS") return fulfillEmpty(route, 204);
    if (path === "/v2/sessions/current/status") return fulfillJson(route, fixture.status);
    if (path === "/v2/sessions/current/visualization/state") return fulfillJson(route, fixture.visualization);
    if (path === "/v2/sessions/current/model/scene") return fulfillJson(route, fixture.scene);
    if (path === "/v2/sessions/current/model/regions") return fulfillJson(route, fixture.regions);
    if (path === "/v2/sessions/current/model/universe") return fulfillJson(route, fixture.universe);
    if (path === "/v2/sessions/current/data/domain/meta") return fulfillJson(route, fixture.domain);
    if (path === "/v2/sessions/current/meshing/meshes/shared-domain/manifest") {
      return fixture.manifest ? fulfillJson(route, fixture.manifest) : fulfillEmpty(route, 204);
    }
    if (path === "/v2/sessions/current/data/domain/topology") {
      return fixture.topology ? fulfillTopology(route, fixture.topology) : fulfillEmpty(route, 204);
    }
    if (path === "/v2/sessions/current/data/fdm-region-memberships") {
      return fulfillJson(route, fixture.fdmMembership);
    }
    if (path.startsWith("/v2/sessions/current/data/fdm-region-membership")) {
      return fulfillBinary(route, fixture.fdmMembershipBinary);
    }
    if (path.includes("/data/fields/") && path.endsWith("/meta")) return fulfillJson(route, fieldMetaFixture(path.split("/")[6] ?? "m"));
    if (path.includes("/data/fields/") && path.endsWith("/samples/vector")) {
      const quantityId = path.split("/")[6] ?? "m";
      const fieldRequest = {
        component: requestUrl.searchParams.get("component"),
        method: request.method(),
        ownerObjectId: requestUrl.searchParams.get("owner_object_id"),
        quantityId,
        scopeId: requestUrl.searchParams.get("scope_id"),
        scopeKind: requestUrl.searchParams.get("scope_kind"),
        url: `${path}${requestUrl.search}`,
      };
      fixture.fieldRequests.push(fieldRequest);
      if (fixture.fieldMode === "empty") return fulfillEmpty(route, 204);
      if (fixture.fieldMode === "stale") return fulfillBinary(route, fdmFieldVectorBuffer({ quantityId, gridShape: fixture.domain.grid?.shape }), fieldVectorHeaders({ ...fieldRequest, domainGenerationId: "stale" }));
      if (fixture.fieldMode === "mismatch") return fulfillBinary(route, fdmFieldVectorBuffer({ quantityId: "H_eff", gridShape: fixture.domain.grid?.shape }), fieldVectorHeaders({ ...fieldRequest, quantityId: "H_eff" }));
      if (fieldRequest.scopeKind === "full") {
        return fulfillBinary(
          route,
          fdmFieldVectorBuffer({ quantityId, gridShape: fixture.domain.grid?.shape }),
          fieldVectorHeaders(fieldRequest),
        );
      }
      const scoped = fdmScopedFieldVectorBuffer({ fieldRequest, fixture });
      return fulfillBinary(route, scoped.buffer, scoped.headers);
    }
    if (path === "/v2/sessions/current/data/fields") return fulfillJson(route, fieldCatalogFixture());
    return fulfillEmpty(route, 204);
  });
}

async function selectVisualizationNode(page, objectId, regionId) {
  await expand(page, '[data-node-id="model:objects"]');
  await expand(page, `[data-node-id="model:object:${objectId}"]`);
  let nodeId = `model:object:${objectId}:visualization`;
  if (regionId) {
    await expand(page, `[data-node-id="model:object:${objectId}:regions"]`);
    await expand(page, `[data-node-id="model:object:${objectId}:regions:${objectId}:${regionId}"]`);
    nodeId = `model:object:${objectId}:regions:${objectId}:${regionId}:visualization`;
  }
  const parentNodeId = regionId
    ? `model:object:${objectId}:regions:${objectId}:${regionId}`
    : `model:object:${objectId}`;
  const node = await ensureExplorerNodeVisible(
    page,
    `[data-node-id="${nodeId}"]`,
    `[data-node-id="${parentNodeId}"]`,
  );
  await node.click();
  await page.waitForFunction((id) => document.querySelector(`[data-node-id="${id}"]`)?.getAttribute("aria-selected") === "true", nodeId, { timeout: timeoutMs });
  return await readTargetId(page);
}

async function selectAirboxVisualization(page) {
  // Explorer rows are virtualized; after selecting a deep region the Airbox
  // row can be outside the rendered slice even though the model tab is active.
  await page.waitForFunction(() => {
    const trees = Array.from(document.querySelectorAll(".fm-explorer-tree"));
    const visibleTrees = trees.filter((tree) => tree.offsetParent !== null);
    for (const tree of visibleTrees) tree.scrollTop = 0;
    return Boolean(document.querySelector('[data-node-id="model:airbox"]'));
  }, null, { timeout: timeoutMs });
  await expand(page, '[data-node-id="model:airbox"]');
  const node = await ensureExplorerNodeVisible(
    page,
    '[data-node-id="model:airbox:visualization"]',
    '[data-node-id="model:airbox"]',
  );
  await node.click();
  await page.waitForFunction(() => document.querySelector('[data-node-id="model:airbox:visualization"]')?.getAttribute("aria-selected") === "true", null, { timeout: timeoutMs });
}

async function expand(page, selector) {
  const node = page.locator(selector);
  await node.waitFor({ state: "visible", timeout: timeoutMs });
  if ((await node.getAttribute("aria-expanded")) !== "false") return;
  await node.scrollIntoViewIfNeeded();
  await node.dblclick();
  await page.waitForFunction((id) => document.querySelector(`[data-node-id="${id}"]`)?.getAttribute("aria-expanded") === "true", selector.match(/data-node-id="([^"]+)"/)?.[1] ?? null, { timeout: timeoutMs });
}

async function ensureExplorerNodeVisible(page, selector, parentSelector) {
  const parent = page.locator(parentSelector);
  await parent.waitFor({ state: "visible", timeout: timeoutMs });
  await parent.scrollIntoViewIfNeeded();
  // The Explorer virtualizer can keep a newly expanded child outside the DOM
  // when its parent is at the bottom edge of the viewport. Position the
  // parent in the upper third of the tree before querying the child so the
  // row window includes the complete object subtree.
  await page.evaluate((parentId) => {
    const parent = document.querySelector(parentId);
    const tree = parent?.closest(".fm-explorer-tree");
    if (!parent || !tree) return;
    const parentTop =
      parent.getBoundingClientRect().top - tree.getBoundingClientRect().top + tree.scrollTop;
    tree.scrollTop = Math.max(0, parentTop - Math.floor(tree.clientHeight / 3));
  }, parentSelector);
  const node = page.locator(selector);
  await page.waitForFunction(
    (nodeSelector) => Boolean(document.querySelector(nodeSelector)),
    selector,
    { timeout: timeoutMs },
  );
  await node.waitFor({ state: "visible", timeout: timeoutMs });
  await node.scrollIntoViewIfNeeded();
  return node;
}

async function assertTarget(page, expected) {
  const actual = await readTargetId(page);
  if (actual !== expected) throw new Error(`Explorer selection resolved ${actual ?? "none"}; expected ${expected}.`);
}

async function readTargetId(page) {
  const panel = page.locator(".fm-inspector-panel").filter({ hasText: "Target ID" }).last();
  await panel.waitFor({ state: "visible", timeout: timeoutMs });
  return panel.locator(".fm-inspector-field-row").evaluateAll((rows) => {
    const row = rows.find((candidate) =>
      candidate.querySelector(".fm-inspector-field-row__label")?.textContent?.trim() === "Target ID",
    );
    return row?.querySelector(".fm-inspector-field-row__value")?.textContent?.trim() ?? null;
  });
}

async function setObjectDisplayState(page, expected) {
  const panel = page.locator(".fm-inspector-panel").last();
  const visible = panel.getByRole("button", { name: "Toggle target visibility" });
  const expectedVisible = expected.visible ?? true;
  const currentVisible = await visible.getAttribute("aria-pressed");
  if (expectedVisible && currentVisible !== "true") await visible.click();
  const vectors = panel.getByRole("button", { name: "Toggle vector field arrows" });
  if ((await vectors.getAttribute("aria-pressed")) !== String(expected.vectors)) await vectors.click();
  const shadedWithEdges = panel.getByRole("radio", { name: "Shaded +" });
  if (expected.wireframe && (await shadedWithEdges.getAttribute("aria-checked")) !== "true") await shadedWithEdges.click();
  if (!expected.wireframe) {
    const shaded = panel.getByRole("radio", { name: "Shaded", exact: true });
    if ((await shaded.getAttribute("aria-checked")) !== "true") await shaded.click();
  }
  if (expected.colorbar) {
    const colorSource = panel.locator('select[aria-label="Color source"]');
    const colorSourceCount = await colorSource.count();
    if (colorSourceCount !== 1) {
      throw new Error(`Selected inspector must expose exactly one Color source combobox; found ${colorSourceCount}.`);
    }
    if (!(await colorSource.isVisible())) {
      const coloring = panel.getByText("Surface Coloring", { exact: true });
      if (await coloring.count()) await coloring.last().click();
    }
    await colorSource.waitFor({ state: "visible", timeout: timeoutMs });
    if (await colorSource.isDisabled()) {
      throw new Error(`Color source is disabled before selection: ${JSON.stringify(await captureColorSourceGate(page, panel, colorSource))}.`);
    }
    await page.waitForFunction((source) => source instanceof HTMLSelectElement && !source.disabled && Array.from(source.options).some((option) => option.value === "magnitude"), await colorSource.elementHandle(), { timeout: timeoutMs });
    await colorSource.selectOption("magnitude");
  }
  const colorbar = panel.getByRole("switch", { name: "Add colorbar to viewport" });
  if (await colorbar.count() && (await colorbar.getAttribute("aria-checked")) !== String(expected.colorbar)) await colorbar.click();
  // Hiding is applied last because the Inspector intentionally disables
  // render-mode controls for a hidden target.
  if (!expectedVisible && (await visible.getAttribute("aria-pressed")) !== "false") await visible.click();
}

async function verifyPrimaryRenderModeCycle(page, targetLabel) {
  const panel = page.locator(".fm-inspector-panel").last();
  const deltas = {};
  let baseline = await sampleViewportPixels(page, 1);
  for (const mode of ["Wireframe", "Points", "Off", "Shaded"]) {
    const control = panel.getByRole("radio", { name: mode, exact: true });
    await control.waitFor({ state: "visible", timeout: timeoutMs });
    await control.click();
    await page.waitForFunction(
      (label) => document.querySelector(`.fm-viz-render-mode-grid [role="radio"][aria-label="${label}"]`)?.getAttribute("aria-checked") === "true",
      mode,
      { timeout: timeoutMs },
    );
    deltas[mode] = await waitForViewportPixelDelta(
      page,
      baseline,
      `${targetLabel} ${mode}`,
      { minimumChangedPixels: 6 },
    );
    baseline = await sampleViewportPixels(page, 1);
  }
  return deltas;
}

async function captureColorSourceGate(page, panel, colorSource) {
  return {
    colorSource: await colorSource.evaluate((select) => ({
      ariaDisabled: select.getAttribute("aria-disabled"),
      disabled: select.disabled,
      options: Array.from(select.options).map((option) => option.value),
      value: select.value,
    })),
    inspectorDebug: await panel.locator('[role="alert"], [data-slot*="diagnostic"], [data-slot*="warning"]').allTextContents(),
    inspectorText: (await panel.innerText()).slice(0, 8_000),
    selectedTarget: await readTargetId(page),
    runtime: await page.evaluate(() => {
      const audit = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
      return {
        fdmSettings: audit?.readFdmVisualizationSettings?.() ?? null,
        listeners: audit?.readViewportAuditRuntime?.().listenerCounts ?? null,
        visualization: audit?.readViewportAuditResource?.("/v2/sessions/current/visualization/state") ?? null,
      };
    }),
    requests: await page.evaluate(() => performance.getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => name.includes("/v2/sessions/current/"))),
  };
}

async function readTargetControls(page) {
  const panel = page.locator(".fm-inspector-panel").last();
  const surfaceColoring = panel.getByText("Surface Coloring", { exact: true });
  const colorbarSwitch = panel.getByRole("switch", { name: "Add colorbar to viewport" });
  if ((await colorbarSwitch.count()) === 0 && (await surfaceColoring.count()) === 1) {
    // Inspector groups are collapsed by default; expand the group before
    // reading a persisted colorbar value after changing the Explorer target.
    await surfaceColoring.click();
  }
  const selectedRenderMode = panel.locator('.fm-viz-render-mode-grid [role="radio"][aria-checked="true"]');
  if ((await selectedRenderMode.count()) !== 1) {
    await captureTargetControlFailure(page, "missing-selected-render-mode");
    throw new Error(
      `Selected Inspector must expose exactly one active render mode; found ${await selectedRenderMode.count()}.`,
    );
  }
  return {
    colorbar: await colorbarSwitch.getAttribute("aria-checked").catch(() => null),
    renderMode: await selectedRenderMode.getAttribute("aria-label"),
    vectors: await panel.getByRole("button", { name: "Toggle vector field arrows" }).getAttribute("aria-pressed"),
  };
}

async function captureTargetControlFailure(page, label) {
  await mkdir(browserAuditArtifactDir, { recursive: true });
  const screenshotPath = join(browserAuditArtifactDir, `target-smoke-${label}.png`);
  const diagnosticsPath = join(browserAuditArtifactDir, `target-smoke-${label}.json`);
  const diagnostics = await page.evaluate(() => ({
    panels: Array.from(document.querySelectorAll(".fm-inspector-panel")).map((panel, index) => ({
      index,
      radios: Array.from(panel.querySelectorAll('[role="radio"]')).map((radio) => ({
        ariaChecked: radio.getAttribute("aria-checked"),
        ariaLabel: radio.getAttribute("aria-label"),
        disabled: radio.hasAttribute("disabled"),
      })),
      text: panel.textContent?.slice(0, 8_000) ?? "",
    })),
    selectedNodeId: document.querySelector('[aria-selected="true"][data-node-id]')?.getAttribute("data-node-id") ?? null,
  }));
  await page.screenshot({ path: screenshotPath });
  await writeFile(diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`);
}

async function captureBrowserAuditScreenshot(page, filename) {
  await mkdir(browserAuditArtifactDir, { recursive: true });
  await page.screenshot({ path: join(browserAuditArtifactDir, filename) });
}

function sameControlState(left, right) {
  return left.colorbar === right.colorbar && left.renderMode === right.renderMode && left.vectors === right.vectors;
}

async function assertAirboxControls(page) {
  const panel = page.locator(".fm-inspector-panel").last();
  await panel.getByRole("button", { name: "Toggle vector field arrows" }).waitFor({ state: "visible", timeout: timeoutMs });
  if (await panel.getByRole("radio", { name: "Shaded", exact: true }).count()) throw new Error("Airbox exposed a shaded render mode.");
  if (await panel.getByRole("radio", { name: "Wireframe", exact: true }).count() !== 1) throw new Error("Airbox did not expose wireframe mode.");
  if (await panel.getByRole("radio", { name: "Points", exact: true }).count() !== 1) throw new Error("Airbox did not expose points mode.");
  if (await panel.getByRole("switch", { name: "Add colorbar to viewport" }).count()) throw new Error("Airbox exposed a colorbar control.");
  const vectors = panel.getByRole("button", { name: "Toggle vector field arrows" });
  // Establish a deterministic disabled baseline for the following pixel-delta
  // assertion.  The caller owns the single enable transition after sampling;
  // toggling here and then immediately toggling again would make the test a
  // no-op while still exercising a real control.
  if ((await vectors.getAttribute("aria-pressed")) === "true") await vectors.click();
  if ((await vectors.getAttribute("aria-pressed")) !== "false") throw new Error("Airbox vector toggle did not disable vectors for the delta baseline.");
  return vectors;
}

async function verifyAirboxGeometryModes(page, lane) {
  const panel = page.locator(".fm-inspector-panel").last();
  await assertAirboxControls(page);
  const off = panel.getByRole("radio", { name: "Off", exact: true });
  const deltas = {};
  for (const mode of ["Wireframe", "Points"]) {
    if ((await off.getAttribute("aria-checked")) !== "true") await off.click();
    const baseline = await sampleViewportPixels(page, 1);
    const control = panel.getByRole("radio", { name: mode, exact: true });
    await control.click();
    await page.waitForFunction(
      (label) => document.querySelector(`.fm-viz-render-mode-grid [role="radio"][aria-label="${label}"]`)?.getAttribute("aria-checked") === "true",
      mode,
      { timeout: timeoutMs },
    );
    deltas[mode] = await waitForViewportPixelDelta(
      page,
      baseline,
      `${lane.toUpperCase()} Airbox ${mode}`,
      { minimumChangedPixels: 12 },
    );
    await assertHealthyCanvas(page, `${lane.toUpperCase()} Airbox ${mode}`);
    await captureBrowserAuditScreenshot(page, `target-smoke-${lane}-airbox-${mode.toLowerCase()}.png`);
  }
  return deltas;
}

async function setAirboxGeometryOff(page) {
  const off = page.locator(".fm-inspector-panel").last().getByRole("radio", {
    name: "Off",
    exact: true,
  });
  if ((await off.getAttribute("aria-checked")) !== "true") await off.click();
  await page.waitForFunction(
    () => document.querySelector('.fm-viz-render-mode-grid [role="radio"][aria-label="Off"]')?.getAttribute("aria-checked") === "true",
    null,
    { timeout: timeoutMs },
  );
}

async function setAirboxQuantityAndVectors(page, quantityId) {
  const panel = page.locator(".fm-inspector-panel").last();
  const quantity = panel.locator('select[aria-label="Quantity Source"]');
  if (await quantity.count() !== 1) throw new Error(`Airbox inspector must expose exactly one Quantity Source combobox; found ${await quantity.count()}.`);
  await quantity.selectOption(quantityId);
  const vectors = panel.getByRole("button", { name: "Toggle vector field arrows" });
  if ((await vectors.getAttribute("aria-pressed")) !== "true") await vectors.click();
}

async function verifyAirboxVectorQuantities(page, fixture, lane) {
  await assertAirboxControls(page);
  const scopeId = lane === "fem" ? "part-airbox" : null;
  const minimumChangedPixels = lane === "fdm" ? 100 : 12;
  const deltas = {};
  for (const quantityId of ["H_demag", "H_eff", "H_ext"]) {
    const baseline = await sampleViewportPixels(page, 1);
    await setAirboxQuantityAndVectors(page, quantityId);
    await waitForFieldRequest(page, {
      component: "full",
      quantityId,
      scopeId,
      scopeKind: "airbox",
    });
    assertFieldRequest(fixture, {
      component: "full",
      quantityId,
      scopeId,
      scopeKind: "airbox",
    });
    const label = `${lane.toUpperCase()} Airbox ${quantityId} vectors`;
    deltas[quantityId] = await waitForViewportPixelDelta(page, baseline, label, {
      minimumChangedPixels,
    });
    await assertHealthyCanvas(page, label);
    await captureBrowserAuditScreenshot(
      page,
      `target-smoke-${lane}-airbox-${quantityId.toLowerCase().replace("_", "-")}-vectors.png`,
    );
  }
  return deltas;
}

async function assertHealthyCanvas(page, label) {
  const canvas = page.locator(CANVAS_SELECTOR);
  await canvas.waitFor({ state: "visible", timeout: timeoutMs });
  const state = await canvas.evaluate((node) => {
    const gl = node.getContext("webgl2") ?? node.getContext("webgl");
    return { height: gl?.drawingBufferHeight ?? 0, lost: gl?.isContextLost() ?? true, width: gl?.drawingBufferWidth ?? 0 };
  });
  if (state.lost || state.width <= 0 || state.height <= 0) throw new Error(`${label}: WebGL failed closed: ${JSON.stringify(state)}.`);
  const screenshot = await canvas.screenshot();
  if (screenshot.length < 64 || screenshot.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error(`${label}: viewport did not produce a PNG screenshot.`);
  }
}

async function sampleViewportPixels(page, explicitStride = null) {
  const canvas = page.locator(CANVAS_SELECTOR);
  const box = await canvas.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error("Viewport canvas has no screenshot bounds.");
  }
  const png = await page.screenshot({ clip: { height: box.height, width: box.width, x: box.x, y: box.y } });
  const bitmap = parsePng(png);
  const stride = explicitStride ?? Math.max(1, Math.floor(Math.min(bitmap.width, bitmap.height) / 64));
  const signature = [];
  for (let y = 0; y < bitmap.height; y += stride) {
    for (let x = 0; x < bitmap.width; x += stride) {
      const offset = (y * bitmap.width + x) * 4;
      signature.push(bitmap.rgba[offset], bitmap.rgba[offset + 1], bitmap.rgba[offset + 2]);
    }
  }
  return { signature, stride };
}

async function waitForViewportPixelDelta(page, baseline, label, options = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const current = await sampleViewportPixels(page, baseline.stride ?? null);
    const delta = viewportPixelDelta(baseline, current, options);
    if (delta.changed) return delta;
    last = delta;
    await waitForAnimationFrame(page);
  }
  const debug = process.env.CONTROL_ROOM_TARGET_SMOKE_DEBUG === "1"
    ? await readViewportDeltaDiagnostics(page)
    : null;
  await captureViewportDeltaFailure(page, label, { debug, delta: last });
  throw new Error(`${label} did not change rendered viewport pixels: ${JSON.stringify({ delta: last, debug })}.`);
}

async function captureViewportDeltaFailure(page, label, payload) {
  await mkdir(browserAuditArtifactDir, { recursive: true });
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  await page.screenshot({
    path: join(browserAuditArtifactDir, `target-smoke-${slug}-failure.png`),
  });
  await writeFile(
    join(browserAuditArtifactDir, `target-smoke-${slug}-failure.json`),
    `${JSON.stringify({ label, ...payload }, null, 2)}\n`,
  );
}

async function readViewportDeltaDiagnostics(page) {
  return page.evaluate(() => {
    const audit = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
    const panel = document.querySelectorAll(".fm-inspector-panel");
    const selected = document.querySelector('[aria-selected="true"][data-node-id]');
    const runtime = audit?.readViewportAuditRuntime?.() ?? null;
    return {
      selectedNode: selected?.getAttribute("data-node-id") ?? null,
      controls: Array.from(panel).at(-1)?.textContent?.slice(0, 2_000) ?? null,
      fdmSettings: audit?.readFdmVisualizationSettings?.() ?? null,
      fieldUpdateHoldActive: audit?.readViewport3DFieldUpdateHoldActive?.() ?? null,
      runtime,
      resources: performance.getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((name) => name.includes("/v2/sessions/current/"))
        .slice(-50),
    };
  });
}

async function assertNoViewportPixelDelta(page, baseline, label) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const delta = viewportPixelDelta(
    baseline,
    await sampleViewportPixels(page, baseline.stride ?? null),
  );
  if (delta.changed) {
    throw new Error(`${label} changed viewport pixels without a target control mutation: ${JSON.stringify(delta)}.`);
  }
}

async function waitForAnimationFrame(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}

function viewportPixelDelta(before, after, options = {}) {
  const length = Math.min(before.signature.length, after.signature.length);
  let changedPixels = 0;
  for (let offset = 0; offset < length; offset += 3) {
    const delta = Math.abs(before.signature[offset] - after.signature[offset]) + Math.abs(before.signature[offset + 1] - after.signature[offset + 1]) + Math.abs(before.signature[offset + 2] - after.signature[offset + 2]);
    if (delta > 18) changedPixels += 1;
  }
  const sampledPixels = Math.floor(length / 3);
  const minimumChangedPixels = options.minimumChangedPixels ?? Math.max(6, Math.floor(sampledPixels * 0.003));
  return { changed: changedPixels >= minimumChangedPixels, changedPixels, minimumChangedPixels, sampledPixels };
}

async function waitForFieldRequest(page, expected) {
  await page.waitForFunction((expectedRequest) => performance.getEntriesByType("resource")
    .map((entry) => new URL(entry.name))
    .some((url) => {
      const path = url.pathname.split("/");
      return url.pathname.endsWith("/samples/vector") &&
        path[6] === expectedRequest.quantityId &&
        url.searchParams.get("component") === expectedRequest.component &&
        url.searchParams.get("scope_id") === expectedRequest.scopeId &&
        url.searchParams.get("scope_kind") === expectedRequest.scopeKind;
    }), expected, { timeout: timeoutMs });
}

function assertFieldRequest(fixture, expected) {
  if (!hasFieldRequest(fixture, expected)) {
    throw new Error(`No field request matched ${JSON.stringify(expected)}: ${JSON.stringify(fixture.fieldRequests)}.`);
  }
}

function hasFieldRequest(fixture, expected) {
  return fixture.fieldRequests.some((entry) =>
    Object.entries(expected).every(([key, value]) => entry[key] === value),
  );
}

function countFieldRequests(fixture, expected) {
  return fixture.fieldRequests.filter((entry) =>
    Object.entries(expected).every(([key, value]) => entry[key] === value),
  ).length;
}

async function requestFdmField(page, quantityId) {
  await page.waitForFunction(() => typeof window.__FULLMAG_CONTROL_ROOM_AUDIT__?.patchFdmVisualization === "function", null, { timeout: timeoutMs });
  await page.evaluate((quantity) => {
    window.__FULLMAG_CONTROL_ROOM_AUDIT__.patchFdmVisualization({
      activeQuantityId: quantity,
      shaderVisible: true,
      surfaceColorSource: "magnitude",
      vectorBudget: 8,
      vectorsVisible: true,
    });
  }, quantityId);
}

async function waitForFdmFieldResource(page, quantityId) {
  return page.waitForFunction((quantity) => {
    const audit = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
    const matchingKeys = Object.keys(audit?.readViewportAuditRuntime?.().listenerCounts ?? {}).filter((candidate) => candidate.includes(`/data/fields/${quantity}/samples/vector?`));
    const key = matchingKeys[0];
    if (!key) return null;
    const resource = audit?.readViewportAuditResource?.(key);
    if (!resource || resource.status === "loading") return null;
    const payload = resource.data?.data?.values ? resource.data.data : resource.data;
    return { hasValues: Boolean(payload?.values?.length), key, status: resource.status };
  }, quantityId, { timeout: timeoutMs }).then((handle) => handle.jsonValue());
}

function attachBrowserErrors(page) {
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
function assertNoBrowserErrors(errors) { if (errors.length) throw new Error(`Browser errors:\n${errors.join("\n")}`); }

function createFdmFixture() {
  const objects = ["fdm-left", "fdm-right"].map((id, index) => ({
    geometry: { geometry_params: { size: [0.5, 0.5, 0.5] }, kind: "box" },
    id,
    regions: [{ enabled: true, frame: "object", name: "Core", region_id: `${id}:core`, shape: { center: [index * 2e-7, 0, 0], kind: "sphere", radius: 8e-8 } }],
    transform: { translation: [index * 2e-7, 0, 0] },
    visible: true,
  }));
  const fixture = baseFixture("fdm", objects);
  fixture.regions = regionListFixture(objects);
  fixture.fdmMembership = fdmMembershipFixture(objects);
  fixture.fdmMembershipBinary = fdmMembershipBuffer();
  validateFdmTargetFixture(fixture);
  return fixture;
}

function createFemFixture() {
  const objects = ["fem-owned", "fem-fallback"].map((id, index) => ({
    geometry: { geometry_params: { size: [0.5, 0.5, 0.5] }, kind: "box" },
    id,
    regions: [],
    transform: { translation: [index * 0.5, 0, 0] },
    visible: true,
  }));
  const fixture = baseFixture("fem", objects);
  const surfaceFaces = [[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]];
  const part = (id, role, objectId = null, ordinal = 0) => ({
    boundary_face_count: 4,
    boundary_face_indices: [0, 1, 2, 3].map((index) => index + ordinal * 4),
    boundary_face_start: ordinal * 4,
    bounds_max: ordinal === 0 ? [1, 1, 1] : [2, 2, 2],
    bounds_min: ordinal === 0 ? [0, 0, 0] : [-1, -1, -1],
    element_count: 1,
    element_start: ordinal,
    id,
    node_count: 4,
    node_indices: [0, 1, 2, 3].map((index) => index + ordinal * 4),
    node_start: ordinal * 4,
    object_id: objectId,
    role,
    surface_faces: surfaceFaces,
    topology: "tet4",
  });
  fixture.manifest = {
    generation_id: "1",
    mesh_parts: [part("part-owned", "magnetic", "fem-owned"), part("part-airbox", "airbox", null, 1)],
    regions: [],
    revision: 1,
    topology_fingerprint: "1".repeat(64),
    source_scene_revision: 1,
  };
  fixture.topology = femTopologyBuffer();
  return fixture;
}

function baseFixture(discretization, objects) {
  return {
    fieldRequests: [], requests: [],
    status: { api_contract_version: "1.0.0", capabilities: { binary_fields: true, explicit_topology: discretization === "fem", node_fields: true, preview_3d: true, structured_grid: discretization === "fdm" }, display: { active_quantity_id: "m", view_mode: "3d" }, domain: { cell_count: discretization === "fdm" ? FDM_TARGET_GRID_CELL_COUNT : 8, discretization, generation_id: 1 }, energies: {}, metrics: {}, resources: { domain_generation_id: 1, field_catalog_revision: 1, field_revision: 1, fields_revision: 1, mesh_revision: 1, scene_revision: 1, topology_revision: 1, visualization_state_revision: 1 }, run: null, runtime_bundle_version: "browser-target-fixture", session: { created_at: "0", name: "browser target fixture", session_id: "browser-target-fixture", workspace_root: "/tmp" }, solver: { state: "idle" } },
    visualization: { active_quantity_id: "m", layers: { airbox: { vectors: { visible: false }, wireframe: { visible: true } }, surface: { visible: true }, vectors: { visible: false }, wireframe: { visible: false } }, overrides: [], quantity: { active_quantity_id: "m" }, revision: 1, schema_version: 1 },
    scene: { objects, revision: 1, schema_version: 2 },
    universe: { mesh_dirty: false, object_bounds_max: [1, 1, 1], object_bounds_min: [-1, -1, -1], scene_revision: 1, study_universe_mesh: null, universe: null },
    domain: { bounds: { max: [1, 1, 1], min: [-1, -1, -1] }, coordinate_system: "cartesian", counts: { cells: discretization === "fdm" ? FDM_TARGET_GRID_CELL_COUNT : 8, nodes: 4 }, dimension: 3, discretization, domain_id: `${discretization}-browser-target-fixture`, generation_id: 1, grid: discretization === "fdm" ? { origin: FDM_TARGET_GRID_ORIGIN, shape: FDM_TARGET_GRID_SHAPE, spacing: FDM_TARGET_GRID_SPACING } : null, units: { length: "m" } },
    manifest: null, topology: null,
    regions: { geometry_realization_revision: 1, regions: [], scene_revision: 1 },
  };
}

function regionListFixture(objects) {
  return {
    geometry_realization_revision: 1,
    region_membership_revision: 1,
    region_topology_revision: 1,
    regions: objects.map(({ id }) => ({
      bounds_max: [1, 1, 1],
      bounds_min: [-1, -1, -1],
      enabled: true,
      frame: "object",
      interaction_refs: [],
      material_ref: "fixture-material",
      mesh_part_ids: [],
      name: "Core",
      owner_object_id: id,
      region_id: `${id}:core`,
      source: "authored_object_region",
      source_body_ids: [],
      source_object_ids: [id],
    })),
    scene_revision: 1,
  };
}

function fieldCatalogFixture() { return { domain_generation_id: 1, quantities: ["m", "H_eff", "H_demag", "H_ext"].map((quantity_id) => ({ available: true, components: 3, domain_generation_id: 1, field_revision: 1, kind: "vector", label: quantity_id === "m" ? "Magnetization" : quantity_id === "H_eff" ? "Effective field" : quantity_id === "H_ext" ? "External field" : "Demag field", location: "nodes", materialization_wall_time_ns: 0, materialized_at_unix_ms: 1, quantity_id, source_revision: 1, source_step: 0, stale_by_steps: 0, state: "complete", unit: quantity_id === "m" ? "1" : "A/m" })), revision: 1 }; }
function fieldMetaFixture(quantityId) { return { components: ["x", "y", "z"], quantity_id: quantityId, stats: { max: 1, min: 0 }, unit: quantityId === "m" ? "1" : "A/m" }; }
function fdmMembershipFixture(objects) {
  const region_legend = objects.map(({ id }, index) => ({
    numeric_id: index + 1,
    object_id: id,
    priority: 0,
    region_id: `${id}:core`,
  }));
  return {
    cell_count: FDM_TARGET_GRID_CELL_COUNT,
    cell_m: FDM_TARGET_GRID_SPACING,
    counts: FDM_TARGET_GRID_SHAPE,
    domain_generation_id: 1,
    encoding: "FMRM:u32_membership_le",
    freshness: "current",
    grid_fingerprint: "0".repeat(64),
    magnetic_support: {
      active_cell_count: 64,
      active_unassigned_cell_count: 0,
      bounds_max_m: [0.5, 0.5, 0.5],
      bounds_min_m: [-0.5, -0.5, -0.5],
      grid_fingerprint: "0".repeat(64),
      inactive_cell_count: FDM_TARGET_GRID_CELL_COUNT - 64,
      semantic_role: "magnetic-support",
    },
    mesh_revision: 1,
    object_ids: objects.map(({ id }) => id),
    origin_m: FDM_TARGET_GRID_ORIGIN,
    region_legend,
    region_legend_fingerprint: createHash("sha256")
      .update(
        JSON.stringify(
          region_legend.map(({ numeric_id, object_id, region_id, priority }) => ({
            numeric_id,
            object_id,
            region_id,
            priority,
          })),
        ),
      )
      .digest("hex"),
    region_membership_revision: 1,
    schema_version: "fdm_region_membership.v2",
  };
}
function fdmMembershipBuffer() {
  const [nx, ny, nz] = FDM_TARGET_GRID_SHAPE;
  const buffer = new ArrayBuffer(64 + FDM_TARGET_GRID_CELL_COUNT * Uint32Array.BYTES_PER_ELEMENT);
  const view = new DataView(buffer);
  for (const [i, c] of [..."FMRM"].entries()) view.setUint8(i, c.charCodeAt(0));
  view.setUint8(4, 2);
  view.setUint8(5, 2);
  view.setUint32(8, nx, true);
  view.setUint32(12, ny, true);
  view.setUint32(16, nz, true);
  view.setUint32(20, FDM_TARGET_GRID_CELL_COUNT, true);
  view.setUint32(24, 2, true);
  const regionIds = new Uint32Array(buffer, 64, FDM_TARGET_GRID_CELL_COUNT);
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        const index = x + nx * (y + ny * z);
        const insideSupport = x >= 2 && x <= 5 && y >= 2 && y <= 5 && z >= 2 && z <= 5;
        regionIds[index] = insideSupport ? ((x + y + z) % 2) + 1 : 0xffff_ffff;
      }
    }
  }
  return buffer;
}
function fdmFieldVectorBuffer({ quantityId = "m", gridShape = FDM_TARGET_GRID_SHAPE } = {}) {
  const [nx, ny, nz] = gridShape;
  const pointCount = nx * ny * nz;
  const buffer = new ArrayBuffer(48 + pointCount * 3 * Float64Array.BYTES_PER_ELEMENT);
  const view = new DataView(buffer);
  for (const [i, c] of [..."FMVP"].entries()) view.setUint8(i, c.charCodeAt(0));
  view.setUint8(4, 2);
  view.setUint8(5, 1);
  view.setUint8(6, 3);
  view.setUint32(12, pointCount * 3, true);
  view.setUint32(16, nx, true);
  view.setUint32(20, ny, true);
  view.setUint32(24, nz, true);
  new TextEncoder().encodeInto(quantityId, new Uint8Array(buffer, 28, 16));
  const values = new Float64Array(buffer, 48);
  for (let point = 0; point < pointCount; point += 1) {
    values[point * 3] = 1;
    values[point * 3 + 1] = (point % 3) * 0.25;
    values[point * 3 + 2] = 0.5;
  }
  return buffer;
}

function fdmScopedFieldVectorBuffer({ fieldRequest, fixture }) {
  const cellIndices = fixture.fdmMembership
    ? resolveFdmScopedCellIndices({ fieldRequest, fixture })
    : fieldRequest.scopeKind === "airbox"
      ? [4, 5, 6, 7]
      : [0, 1, 2, 3];
  const encoder = new TextEncoder();
  const scopeKindBytes = encoder.encode(fieldRequest.scopeKind ?? "full");
  const scopeIdBytes = encoder.encode(fieldRequest.scopeId ?? "");
  const domainGenerationId = String(
    fixture.fdmMembership?.domain_generation_id ?? fixture.domain.generation_id,
  );
  const generationIdBytes = encoder.encode(domainGenerationId);
  const rawMetadataLength =
    68 +
    scopeKindBytes.length +
    scopeIdBytes.length +
    generationIdBytes.length +
    cellIndices.length * Uint32Array.BYTES_PER_ELEMENT;
  const metadataLength = Math.ceil(rawMetadataLength / 8) * 8;
  const valueCount = cellIndices.length * 3;
  const buffer = new ArrayBuffer(
    48 + metadataLength + valueCount * Float64Array.BYTES_PER_ELEMENT,
  );
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMVP"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint8(4, 3);
  view.setUint8(5, 1);
  view.setUint8(6, 3);
  view.setUint32(8, metadataLength, true);
  view.setUint32(12, valueCount, true);
  view.setUint32(16, cellIndices.length, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, 1, true);
  encoder.encodeInto(fieldRequest.quantityId, new Uint8Array(buffer, 28, 16));

  for (const [index, code] of [..."FMMI"].entries()) {
    view.setUint8(48 + index, code.charCodeAt(0));
  }
  view.setUint16(52, 2, true);
  view.setUint16(56, generationIdBytes.length, true);
  const topologyRevision = fixture.fdmMembership?.mesh_revision ?? fixture.manifest?.revision ?? 1;
  view.setBigUint64(64, BigInt(topologyRevision), true);
  const gridFingerprint = fixture.fdmMembership?.grid_fingerprint ?? fixture.manifest?.topology_fingerprint ?? "1".repeat(64);
  for (let index = 0; index < 32; index += 1) {
    view.setUint8(72 + index, Number.parseInt(gridFingerprint.slice(index * 2, index * 2 + 2), 16));
  }
  view.setUint32(104, 1, true);
  view.setUint32(108, cellIndices.length, true);
  view.setUint16(112, scopeKindBytes.length, true);
  view.setUint16(114, scopeIdBytes.length, true);
  new Uint8Array(buffer, 116, scopeKindBytes.length).set(scopeKindBytes);
  new Uint8Array(buffer, 116 + scopeKindBytes.length, scopeIdBytes.length).set(scopeIdBytes);
  const generationIdStart = 116 + scopeKindBytes.length + scopeIdBytes.length;
  new Uint8Array(buffer, generationIdStart, generationIdBytes.length).set(generationIdBytes);
  let metadataOffset = generationIdStart + generationIdBytes.length;
  for (const cellIndex of cellIndices) {
    view.setUint32(metadataOffset, cellIndex, true);
    metadataOffset += Uint32Array.BYTES_PER_ELEMENT;
  }
  const values = new Float64Array(buffer, 48 + metadataLength, valueCount);
  for (let point = 0; point < cellIndices.length; point += 1) {
    const cellIndex = cellIndices[point];
    const varying = (cellIndex % 3) * 0.25;
    if (fieldRequest.quantityId === "H_eff") {
      values[point * 3] = 0.5;
      values[point * 3 + 1] = 1;
      values[point * 3 + 2] = varying;
    } else if (fieldRequest.quantityId === "H_ext") {
      values[point * 3] = varying;
      values[point * 3 + 1] = 0.5;
      values[point * 3 + 2] = 1;
    } else {
      values[point * 3] = 1;
      values[point * 3 + 1] = varying;
      values[point * 3 + 2] = 0.5;
    }
  }
  return {
    buffer,
    headers: {
      ...fieldVectorHeaders({
        ...fieldRequest,
        domainGenerationId,
      }),
      "x-fullmag-encoding": "FMVP;version=3",
      "x-fullmag-field-indexing": "explicit_node_indices",
      "x-fullmag-mesh-topology-hash": `sha256:${gridFingerprint}`,
      "x-fullmag-mesh-topology-revision": String(topologyRevision),
      "x-fullmag-node-index-count": String(cellIndices.length),
    },
  };
}

function resolveFdmScopedCellIndices({ fieldRequest, fixture }) {
  const memberships = new Uint32Array(
    fixture.fdmMembershipBinary,
    64,
    fixture.fdmMembership.cell_count,
  );
  if (fieldRequest.scopeKind === "airbox") {
    return Array.from(memberships.keys()).filter(
      (index) => memberships[index] === 0xffff_ffff,
    );
  }
  const numericIds = new Set(
    fixture.fdmMembership.region_legend
      .filter((entry) =>
        fieldRequest.scopeKind === "object"
          ? entry.object_id === fieldRequest.scopeId
          : entry.region_id === fieldRequest.scopeId &&
            (!fieldRequest.ownerObjectId || entry.object_id === fieldRequest.ownerObjectId),
      )
      .map((entry) => entry.numeric_id),
  );
  return Array.from(memberships.keys()).filter((index) => numericIds.has(memberships[index]));
}

function validateFdmTargetFixture(fixture) {
  const descriptor = fixture.fdmMembership;
  const summary = descriptor?.magnetic_support;
  if (!summary || descriptor.cell_count !== FDM_TARGET_GRID_CELL_COUNT) {
    throw new Error("FDM target fixture must publish a current magnetic_support summary.");
  }
  const ids = new Uint32Array(fixture.fdmMembershipBinary, 64, descriptor.cell_count);
  const [nx, ny, nz] = descriptor.counts;
  const active = [];
  for (let index = 0; index < ids.length; index += 1) {
    if (ids[index] === 0xffff_ffff) continue;
    const x = index % nx;
    const y = Math.floor(index / nx) % ny;
    const z = Math.floor(index / (nx * ny)) % nz;
    active.push([x, y, z]);
  }
  if (active.length !== summary.active_cell_count) {
    throw new Error(`FDM target fixture active count mismatch: mask=${active.length} summary=${summary.active_cell_count}.`);
  }
  if (ids.length - active.length !== summary.inactive_cell_count) {
    throw new Error(`FDM target fixture inactive count mismatch: mask=${ids.length - active.length} summary=${summary.inactive_cell_count}.`);
  }
  const supportMin = [0, 1, 2].map((axis) =>
    descriptor.origin_m[axis] + Math.min(...active.map((cell) => cell[axis])) * descriptor.cell_m[axis],
  );
  const supportMax = [0, 1, 2].map((axis) =>
    descriptor.origin_m[axis] + (Math.max(...active.map((cell) => cell[axis])) + 1) * descriptor.cell_m[axis],
  );
  if (
    supportMin.some((value, axis) => value !== summary.bounds_min_m[axis]) ||
    supportMax.some((value, axis) => value !== summary.bounds_max_m[axis])
  ) {
    throw new Error(`FDM target fixture support AABB mismatch: mask=[${supportMin}]–[${supportMax}] summary=[${summary.bounds_min_m}]–[${summary.bounds_max_m}].`);
  }
}
function femTopologyBuffer() {
  const nodeCount = 8;
  const elementCount = 2;
  const boundaryFaceCount = 8;
  const buffer = new ArrayBuffer(
    32 + nodeCount * 3 * 8 + elementCount * 4 * 4 + boundaryFaceCount * 3 * 4 + elementCount * 4 * 2,
  );
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMMT"].entries()) view.setUint8(index, code.charCodeAt(0));
  view.setUint8(4, 1);
  view.setUint8(5, 1);
  view.setUint32(8, nodeCount, true);
  view.setUint32(12, elementCount, true);
  view.setUint32(16, boundaryFaceCount, true);
  view.setUint32(20, elementCount, true);
  view.setUint32(24, elementCount, true);
  let offset = 32;
  new Float64Array(buffer, offset, nodeCount * 3).set([
    0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1,
    -1, -1, -1, 2, -1, -1, -1, 2, -1, -1, -1, 2,
  ]);
  offset += nodeCount * 3 * Float64Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, elementCount * 4).set([0, 1, 2, 3, 4, 5, 6, 7]);
  offset += elementCount * 4 * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, boundaryFaceCount * 3).set([
    0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3,
    4, 5, 6, 4, 5, 7, 4, 6, 7, 5, 6, 7,
  ]);
  offset += boundaryFaceCount * 3 * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, elementCount).set([1, 0]);
  offset += elementCount * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, elementCount).set([1, 0]);
  return buffer;
}

function parsePng(buffer) {
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Viewport screenshot is not PNG.");
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); if (data[8] !== 8 || data[12] !== 0) throw new Error("Unsupported PNG bit depth or interlace."); colorType = data[9]; }
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") break;
    offset += length + 12;
  }
  const bytesPerPixel = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!bytesPerPixel) throw new Error(`Unsupported PNG color type ${colorType}.`);
  const source = inflateSync(Buffer.concat(idat));
  const rowLength = width * bytesPerPixel;
  const raw = Buffer.alloc(height * rowLength);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = source[sourceOffset++];
    const rowOffset = y * rowLength;
    for (let x = 0; x < rowLength; x += 1) {
      const value = source[sourceOffset + x];
      const left = x >= bytesPerPixel ? raw[rowOffset + x - bytesPerPixel] : 0;
      const up = y ? raw[rowOffset - rowLength + x] : 0;
      const upLeft = y && x >= bytesPerPixel ? raw[rowOffset - rowLength + x - bytesPerPixel] : 0;
      raw[rowOffset + x] = unfilter(filter, value, left, up, upLeft);
    }
    sourceOffset += rowLength;
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) { const sourceIndex = index * bytesPerPixel; const targetIndex = index * 4; rgba[targetIndex] = raw[sourceIndex]; rgba[targetIndex + 1] = raw[sourceIndex + 1]; rgba[targetIndex + 2] = raw[sourceIndex + 2]; rgba[targetIndex + 3] = colorType === 6 ? raw[sourceIndex + 3] : 255; }
  return { height, rgba, width };
}

function unfilter(filter, value, left, up, upLeft) {
  if (filter === 0) return value;
  if (filter === 1) return (value + left) & 255;
  if (filter === 2) return (value + up) & 255;
  if (filter === 3) return (value + Math.floor((left + up) / 2)) & 255;
  if (filter === 4) { const estimate = left + up - upLeft; const leftDistance = Math.abs(estimate - left); const upDistance = Math.abs(estimate - up); const upLeftDistance = Math.abs(estimate - upLeft); return (value + (leftDistance <= upDistance && leftDistance <= upLeftDistance ? left : upDistance <= upLeftDistance ? up : upLeft)) & 255; }
  throw new Error(`Unsupported PNG filter ${filter}.`);
}

async function fulfillJson(route, body) { await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body), headers: fixtureHeaders() }); }
async function fulfillBinary(route, buffer, headers = {}) { await route.fulfill({ status: 200, contentType: "application/octet-stream", body: Buffer.from(buffer), headers: { ...fixtureHeaders(), ...headers } }); }
async function fulfillTopology(route, topology) {
  const range = route.request().headers().range;
  const etag = '"browser-target-fem-topology"';
  if (!range) return fulfillBinary(route, topology, { etag });
  const match = /^bytes=(\d+)-(\d+)$/.exec(range);
  if (!match) {
    return route.fulfill({
      body: "",
      headers: { ...fixtureHeaders(), "content-range": `bytes */${topology.byteLength}`, etag },
      status: 416,
    });
  }
  const start = Number(match[1]);
  const requestedEnd = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || requestedEnd < start || start >= topology.byteLength) {
    return route.fulfill({
      body: "",
      headers: { ...fixtureHeaders(), "content-range": `bytes */${topology.byteLength}`, etag },
      status: 416,
    });
  }
  const end = Math.min(requestedEnd, topology.byteLength - 1);
  return route.fulfill({
    body: Buffer.from(topology.slice(start, end + 1)),
    contentType: "application/octet-stream",
    headers: {
      ...fixtureHeaders(),
      "accept-ranges": "bytes",
      "content-length": String(end - start + 1),
      "content-range": `bytes ${start}-${end}/${topology.byteLength}`,
      etag,
    },
    status: 206,
  });
}
async function fulfillEmpty(route, status) { await route.fulfill({ status, body: "", headers: fixtureHeaders() }); }
function fieldVectorHeaders({ component, domainGenerationId = "1", quantityId, scopeId, scopeKind }) { return { "x-fullmag-component": component ?? "full", "x-fullmag-domain-generation-id": domainGenerationId, "x-fullmag-quantity-id": quantityId, ...(scopeId === null ? {} : { "x-fullmag-scope-id": scopeId }), "x-fullmag-scope-kind": scopeKind ?? "full" }; }
function fixtureHeaders() { return { "access-control-allow-origin": "*", "access-control-expose-headers": "accept-ranges, content-length, content-range, etag, x-api-contract-version, x-fullmag-component, x-fullmag-domain-generation-id, x-fullmag-encoding, x-fullmag-field-indexing, x-fullmag-mesh-topology-hash, x-fullmag-mesh-topology-revision, x-fullmag-node-index-count, x-fullmag-quantity-id, x-fullmag-scope-id, x-fullmag-scope-kind", "x-api-contract-version": "1.0.0" }; }
async function loadPlaywright() { try { return await import("playwright"); } catch { return null; } }

async function startRuntime() {
  const port = await reservePort(requestedPort);
  const pnpm = resolvePnpmInvocation();
  const distDirectory = `.next-audit-target-smoke-${process.pid}-${randomUUID().replaceAll("-", "")}`;
  const distPath = join(appDir, distDirectory);
  const generatedConfigSnapshot = await captureGeneratedConfigSnapshot();
  const child = spawn(pnpm.command, [...pnpm.argsPrefix, "--dir", appDir, "dev", "--webpack", "--port", String(port)], {
    cwd: appDir,
    detached: process.platform !== "win32",
    env: { ...process.env, FULLMAG_NEXT_DIST_DIR: distDirectory },
    shell: pnpm.shell,
    stdio: "pipe",
  });
  let spawnError = null;
  let runtimeOutput = "";
  const appendRuntimeOutput = (chunk) => {
    runtimeOutput = `${runtimeOutput}${chunk}`.slice(-8_000);
  };
  child.on("error", (error) => { spawnError = error; });
  child.stdout?.on("data", appendRuntimeOutput);
  child.stderr?.on("data", appendRuntimeOutput);
  const runtimeUrl = `http://localhost:${port}/workspace`;
  const stop = async () => {
    const cleanupFailures = [];
    for (const [label, operation] of [
      ["stop isolated Next runtime", () => stopChild(child)],
      ["remove isolated Next artifacts", () => rm(distPath, { force: true, recursive: true })],
      ["restore generated Next configuration", () => restoreGeneratedConfigSnapshot(generatedConfigSnapshot)],
    ]) {
      try {
        await operation();
      } catch (error) {
        cleanupFailures.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, "Could not stop isolated target smoke runtime.");
    }
  };
  try {
    await waitForHttp(runtimeUrl, child, () => spawnError, () => runtimeOutput);
  } catch (error) {
    await stop();
    throw error;
  }
  return { url: runtimeUrl, stop };
}
async function captureGeneratedConfigSnapshot() {
  const paths = [join(appDir, "next-env.d.ts"), join(appDir, "tsconfig.json")];
  return Promise.all(paths.map(async (path) => [path, await readFile(path)]));
}
async function restoreGeneratedConfigSnapshot(snapshot) {
  await Promise.all(snapshot.map(([path, contents]) => writeFile(path, contents)));
}
async function stopChild(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  signalChildTree(child, "SIGTERM");
  const terminated = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (terminated || child.exitCode != null || child.signalCode != null) return;
  signalChildTree(child, "SIGKILL");
  await exited;
}
function signalChildTree(child, signal) {
  if (process.platform === "win32" || child.pid == null) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}
function reservePort(port) { return new Promise((resolve, reject) => { const server = createServer(); server.once("error", reject); server.listen(port, process.env.CONTROL_ROOM_TARGET_SMOKE_BIND_HOST ?? "127.0.0.1", () => { const address = server.address(); server.close((error) => error ? reject(error) : resolve(address.port)); }); }); }
async function waitForHttp(url, child, readSpawnError, readStderr) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const spawnError = readSpawnError(); if (spawnError) throw new Error(`Target smoke server failed to spawn: ${spawnError.message}.`); if (child.exitCode != null) throw new Error(`Target smoke server exited with ${child.exitCode}: ${readStderr() || "no stderr"}`); try { if ((await fetch(url)).status < 500) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 200)); } throw new Error(`Timed out waiting for ${url}: ${readStderr() || "no stderr"}`); }
