import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  const browserChannel = process.env.CONTROL_ROOM_TARGET_SMOKE_BROWSER_CHANNEL;
  browser = await playwright.chromium.launch(
    browserChannel ? { channel: browserChannel } : {},
  );
  const targetSmokePhase = process.env.CONTROL_ROOM_TARGET_SMOKE_PHASE;
  const analysisHandoffOnly = targetSmokePhase === "analysis-handoff";
  const fdmOnly = targetSmokePhase === "fdm" || analysisHandoffOnly;
  const femOnly = targetSmokePhase === "fem";
  const emptyPartColorOnly = targetSmokePhase === "empty-part-color";
  const fdm = femOnly || emptyPartColorOnly ? null : await verifyFdmObjectAndAirboxTargets(browser, url);
  const fieldFailures = fdmOnly || femOnly || emptyPartColorOnly ? null : await verifyFdmFieldFailureRecovery(browser, url);
  const fem = fdmOnly || emptyPartColorOnly ? null : await verifyFemObjectTargetAndFallback(browser, url);
  const emptyPartColor = emptyPartColorOnly
    ? await verifyEmptyPartThicknessAverageZ(browser, url)
    : null;
  console.log(`Explorer/Inspector target smoke passed: ${JSON.stringify({ emptyPartColor, fdm, fem, fieldFailures, url })}`);
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
      await page.waitForFunction(
        () => typeof window.__FULLMAG_CONTROL_ROOM_AUDIT__?.setActiveViewportModule === "function",
        null,
        { timeout: timeoutMs },
      );
      await page.evaluate(() => {
        window.__FULLMAG_CONTROL_ROOM_AUDIT__.setActiveViewportModule("viewport-3d");
      });
      await assertHealthyCanvas(page, `FDM ${fieldMode} initial`);
      const failedBaseline = await sampleViewportPixels(page);
      await requestFdmField(page, "m");
      const failed = await waitForFdmFieldResource(page, "m");
      if (fieldMode === "empty" && failed.hasValues) {
        throw new Error(`${fieldMode} field response was rendered instead of failing closed: ${JSON.stringify(failed)}.`);
      }
      if (fieldMode !== "empty") {
        if (!failed.hasValues) {
          throw new Error(`${fieldMode} field response did not expose a payload for the identity rejection check: ${JSON.stringify(failed)}.`);
        }
        await assertNoViewportPixelDelta(page, failedBaseline, `${fieldMode} field response fail-closed`);
      }
      fixture.fieldMode = "ready";
      await requestFdmField(page, "H_eff");
      await waitForFdmFieldResource(page, "H_eff");
      const recoveryBaseline = await sampleViewportPixels(page);
      const mRequestsBeforeRecovery = countFieldRequests(fixture, { quantityId: "m" });
      await invalidateFieldResource(page, failed.key);
      await waitForAnimationFrame(page);
      await requestFdmField(page, "m");
      await waitForFieldRequestCount(
        fixture,
        { quantityId: "m" },
        mRequestsBeforeRecovery + 1,
      );
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
    const analysisViewportHandoff = await verifyAnalysisViewportHandoff(page, "FDM");
    if (process.env.CONTROL_ROOM_TARGET_SMOKE_PHASE === "analysis-handoff") {
      assertNoBrowserErrors(errors);
      return { analysisViewportHandoff };
    }

    if (process.env.CONTROL_ROOM_TARGET_SMOKE_AIRBOX_ONLY === "1") {
      await selectAirboxVisualization(page);
      const geometry = await verifyAirboxGeometryModes(page, "fdm");
      await setAirboxGeometryOff(page);
      const vectorDeltas = await verifyAirboxVectorQuantities(page, fixture, "fdm");
      return { airboxDebug: true, analysisViewportHandoff, fieldRequests: fixture.fieldRequests, geometry, vectorDeltas };
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

    // Region targets are sparse overrides of their owner. Hiding an otherwise
    // identical region layer leaves the owner carrier visible, so establish a
    // plain owner baseline and qualify the region with a visible wireframe
    // override instead.
    await selectVisualizationNode(page, "fdm-left", null);
    await setObjectDisplayState(page, { colorbar: false, vectors: false, wireframe: false });
    const leftRegionTarget = await selectVisualizationNode(page, "fdm-left", "core");
    const leftRegionBeforePixels = await sampleViewportPixels(page);
    await assertNoViewportPixelDelta(page, leftRegionBeforePixels, "FDM left same-named region no-op negative control");
    await setObjectDisplayState(page, { colorbar: false, vectors: false, wireframe: true });
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
    return { aDelta, aRenderModeDeltas, airboxDelta, analysisViewportHandoff, bDelta, fieldRequests: fixture.fieldRequests, geometry, leftRegionDelta, objectTargets: [a, b], regionTargets: [leftRegionTarget, rightRegionTarget], rightRegionDelta };
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
    const fallbackBeforePixels = await sampleViewportPixels(page, 1);
    await assertNoViewportPixelDelta(page, fallbackBeforePixels, "FEM fallback target no-op negative control");
    await setObjectDisplayState(page, { colorbar: false, vectors: false, wireframe: false, visible: false });
    const fallbackDelta = await waitForViewportPixelDelta(page, fallbackBeforePixels, "FEM fallback target controls", {
      minimumChangedPixels: 18,
    });
    const fallback = await readTargetControls(page);
    if (sameControlState(owned, fallback)) {
      throw new Error(`FEM object target and fallback share state: ${JSON.stringify({ owned, fallback })}`);
    }
    await selectAirboxVisualization(page);
    await verifyAirboxGeometryModes(page, "fem");
    await assertAirboxControls(page);
    await setAirboxQuantityAndVectors(page, "H_demag");
    try {
      await waitForFieldRequest(page, { component: "full", quantityId: "H_demag", scopeId: "part-airbox", scopeKind: "airbox" });
    } catch (error) {
      throw new Error(`FEM Airbox H_demag request mismatch: ${error instanceof Error ? error.message : String(error)}; observed=${JSON.stringify(fixture.fieldRequests)}`);
    }
    assertFieldRequest(fixture, { component: "full", quantityId: "H_demag", scopeId: "part-airbox", scopeKind: "airbox" });
    await assertHealthyCanvas(page, "FEM target/fallback interactions");
    assertNoBrowserErrors(errors);
    await captureBrowserAuditScreenshot(page, "target-smoke-fem-success.png");
    return { fallbackDelta, fallbackTarget: "object:fem-fallback", fieldRequests: fixture.fieldRequests, ownedDelta, ownedRenderModeDeltas, ownedTarget: "object:fem-owned" };
  } finally {
    await page.close();
  }
}

async function verifyEmptyPartThicknessAverageZ(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const quantityId = "H_eff";
  let hasOriginalFailure = false;
  try {
    const fixture = createEmptyPartColorFixture();
    const errors = attachBrowserErrors(page);
    const network = attachBrowserNetworkDiagnostics(page);
    await installFixtureApi(page, fixture);
    await installFixtureConfig(page, true);
    await installFixtureRealtime(page, fixture);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await waitForFixtureRealtimeConnection(fixture);
    sendFixtureRealtimeHello(fixture, 1);
    await assertHealthyCanvas(page, "empty-range FEM initial", {
      browserErrors: errors,
      fixture,
      network,
    });

    // Keep the later part hidden while measuring A. Both parts have separate
    // object targets and share their XY projection columns in the typed mesh.
    await selectVisualizationNode(page, "fem-visible", null);
    await setObjectDisplayState(page, {
      colorbar: false,
      vectors: false,
      visible: false,
      wireframe: false,
    });
    await selectVisualizationNode(page, "fem-empty", null);
    await assertTarget(page, "object:fem-empty");
    await setObjectDisplayState(page, {
      colorbar: false,
      vectors: false,
      visible: true,
      wireframe: false,
    });
    const emptyBaseline = await sampleViewportPixels(page);
    const emptyRedPixels = countRedDominantPixels(emptyBaseline);
    if (emptyRedPixels < 4) {
      throw new Error(`Empty-range part A was not visibly rendered in its solid-color baseline: ${JSON.stringify({ emptyRedPixels })}.`);
    }

    await enableMagnitudeSurfaceColoring(page, fixture, "fem-empty");
    const fieldResource = await waitForFdmFieldResource(page, quantityId, {
      component: "full",
      partId: "part-empty-range",
      scopeKind: "part",
    });
    if (fieldResource.status !== "ready" || fieldResource.hasTargetPart || fieldResource.hasValues) {
      throw new Error(`Empty FEM part unexpectedly acquired a field envelope: ${JSON.stringify(fieldResource)}.`);
    }
    if (!fixture.emptyPartFieldResponses.some((entry) => entry.partId === "part-empty-range" && entry.status === 204 && entry.nodeIndices.length === 0)) {
      throw new Error("Empty FEM part did not receive the explicit empty scoped response.");
    }
    assertFieldRequest(fixture, {
      component: "full",
      quantityId,
      scopeId: "part-empty-range",
      scopeKind: "part",
    });
    const emptyOverride = assertMagnitudeThicknessOverride(fixture, "fem-empty");
    await assertHealthyCanvas(page, "empty-range FEM field-color request");

    // Keep A visible in its empty magnitude state while B is enabled and refreshed.
    // The solid-red snapshot above is only a visibility check, not a no-leak baseline.
    await selectVisualizationNode(page, "fem-visible", null);
    await assertTarget(page, "object:fem-visible");
    await setObjectDisplayState(page, {
      colorbar: false,
      vectors: false,
      visible: true,
      wireframe: false,
    });
    const positiveBaseline = await sampleViewportPixels(page);
    const positiveRedPixels = countRedDominantPixels(positiveBaseline);
    if (positiveRedPixels < 4) {
      throw new Error(`Positive-control part B was not visibly rendered in its solid-color baseline: ${JSON.stringify({ positiveRedPixels })}.`);
    }
    await enableMagnitudeSurfaceColoring(page, fixture, "fem-visible");
    // With both scalar targets visible, the production demand planner
    // coalesces equal quantity/mode requests into the full-domain envelope.
    const positiveFieldResource = await waitForFdmFullFieldPayload(page, quantityId);
    if (positiveFieldResource.status !== "ready" || !positiveFieldResource.hasValues) {
      throw new Error(`Nonempty FEM part did not acquire its own field envelope: ${JSON.stringify(positiveFieldResource)}.`);
    }
    if (!fixture.fullDomainFieldResponses.some((entry) => entry.revision === 1 && entry.pointCount === 8)) {
      throw new Error("The two scalar targets did not adopt the full-domain nodal field.");
    }
    const positiveOverride = assertMagnitudeThicknessOverride(fixture, "fem-visible");
    const positiveDelta = await waitForViewportPixelDelta(
      page,
      positiveBaseline,
      "nonempty FEM part B magnitude surface coloring",
      { minimumChangedPixels: 20 },
    );
    await assertHealthyCanvas(page, "nonempty FEM positive field-color control");

    // Build an A-only sample mask while B is stable, then perturb only B's
    // full-domain nodal values while both targets remain visible and A's target settings
    // remain unchanged.
    await selectVisualizationNode(page, "fem-empty", null);
    await assertTarget(page, "object:fem-empty");
    const aVisibleForMask = await sampleViewportPixels(page, null, true);
    await setObjectDisplayState(page, {
      colorbar: false,
      vectors: false,
      visible: false,
      wireframe: false,
    });
    const aHiddenForMask = await sampleViewportPixels(page, null, true);
    await setObjectDisplayState(page, {
      colorbar: false,
      vectors: false,
      visible: true,
      wireframe: false,
    });
    await assertHealthyCanvas(page, "empty-range FEM mask restored");
    const aRestoredForMask = await sampleViewportPixels(page, null, true);
    await assertViewportSampleGeometryEqual(page, aVisibleForMask, aHiddenForMask, "part A visibility mask");
    await assertViewportSampleGeometryEqual(page, aVisibleForMask, aRestoredForMask, "part A mask restore");
    const aPixelMask = await viewportPixelMask(page, aVisibleForMask, aHiddenForMask, "part A", { minimumMaskSamples: 21 });
    const aTotalSampleCount = Math.floor(aVisibleForMask.signature.length / 3);
    const aMaskRestoreMinimumChangedPixels =
      Math.min(20, Math.floor((aPixelMask.length * 20) / aTotalSampleCount)) + 1;
    const aMaskRestoreDelta = await assertViewportPixelDeltaOnMask(
      page,
      aVisibleForMask,
      aRestoredForMask,
      aPixelMask,
      "part A empty field visibility restore",
      { minimumChangedPixels: aMaskRestoreMinimumChangedPixels, shouldChange: false },
    );

    // The coalesced request unmounts the per-part hook. Verify A's
    // empty support from the actual manifest used by the renderer instead.
    const aFieldBeforeBRefresh = await readFEMPartNodeSupport(page, "part-empty-range");
    if (!aFieldBeforeBRefresh.emptyNodeMembership) {
      await captureViewportComparisonFailure(
        page,
        "part A empty field before B refresh",
        aRestoredForMask,
        null,
        { aFieldBeforeBRefresh },
      );
      throw new Error("Part A no longer has empty node membership before perturbing B.");
    }

    await selectVisualizationNode(page, "fem-visible", null);
    const bVisibleForMask = await sampleViewportPixels(page, null, true);
    await setObjectDisplayState(page, {
      colorbar: false,
      vectors: false,
      visible: false,
      wireframe: false,
    });
    const bHiddenForMask = await sampleViewportPixels(page, null, true);
    await setObjectDisplayState(page, {
      colorbar: false,
      vectors: false,
      visible: true,
      wireframe: false,
    });
    await assertHealthyCanvas(page, "nonempty FEM mask restored");
    const bRestoredForMask = await sampleViewportPixels(page, null, true);
    await assertViewportSampleGeometryEqual(page, bVisibleForMask, bHiddenForMask, "part B visibility mask");
    await assertViewportSampleGeometryEqual(page, bVisibleForMask, bRestoredForMask, "part B mask restore");
    const bPixelMask = await viewportPixelMask(page, bVisibleForMask, bHiddenForMask, "part B", { minimumMaskSamples: 20 });
    // A and B can share projected edge, antialias, or occlusion samples. A
    // changed pixel in A∩B is not evidence that B's field leaked into A.
    // Keep both raw masks and their intersection for every diagnostic.
    const aPixelMaskSet = new Set(aPixelMask);
    const bPixelMaskSet = new Set(bPixelMask);
    const aExclusivePixelMask = aPixelMask.filter((sampleIndex) =>
      !bPixelMaskSet.has(sampleIndex),
    );
    const bExclusivePixelMask = bPixelMask.filter((sampleIndex) =>
      !aPixelMaskSet.has(sampleIndex),
    );
    const intersectionPixelMask = aPixelMask.filter((sampleIndex) =>
      bPixelMaskSet.has(sampleIndex),
    );
    const minimumAExclusiveMaskSamples = 21;
    const minimumBExclusiveMaskSamples = 20;
    const aMinimumChangedPixels =
      Math.min(20, Math.floor((aExclusivePixelMask.length * 20) / aTotalSampleCount)) + 1;
    if (
      aExclusivePixelMask.length < minimumAExclusiveMaskSamples ||
      bExclusivePixelMask.length < minimumBExclusiveMaskSamples
    ) {
      let exclusiveMaskFailureDiagnostics;
      try {
        exclusiveMaskFailureDiagnostics = buildViewportMaskFailureDiagnostics(
          bVisibleForMask,
          bHiddenForMask,
          aPixelMask,
          bPixelMask,
        );
      } catch (error) {
        exclusiveMaskFailureDiagnostics = {
          captureError: error instanceof Error ? error.message : String(error),
          masks: {
            a: aPixelMask,
            aExclusive: aExclusivePixelMask,
            b: bPixelMask,
            bExclusive: bExclusivePixelMask,
            intersection: intersectionPixelMask,
          },
          rawMasks: { a: aPixelMask, b: bPixelMask },
        };
      }
      const maskCounts = {
        aExclusiveSamples: aExclusivePixelMask.length,
        bExclusiveSamples: bExclusivePixelMask.length,
        minimumAExclusiveMaskSamples,
        minimumBExclusiveMaskSamples,
      };
      await captureViewportComparisonFailure(
        page,
        "part A/B exclusive visibility mask size",
        bVisibleForMask,
        bHiddenForMask,
        {
          ...maskCounts,
          pixelMaskDiagnostics: exclusiveMaskFailureDiagnostics,
        },
      );
      throw new Error("Exclusive part masks are too small for the pixel contract: " + JSON.stringify(maskCounts));
    }

    const bMaskRestoreDelta = await assertViewportPixelDeltaOnMask(
      page,
      bVisibleForMask,
      bRestoredForMask,
      bPixelMask,
      "part B field visibility restore",
      { minimumChangedPixels: 20, shouldChange: false },
    );

    await selectVisualizationNode(page, "fem-empty", null);
    await assertTarget(page, "object:fem-empty");
    const aSettingsBeforeBRefresh = await readObjectVisualizationSettings(page, "fem-empty");
    const bSettingsBeforeBRefresh = await readObjectVisualizationSettings(page, "fem-visible");
    if (
      !aSettingsBeforeBRefresh ||
      aSettingsBeforeBRefresh.quantity?.active_quantity_id !== quantityId ||
      aSettingsBeforeBRefresh.style?.surface_color_source !== "magnitude" ||
      !bSettingsBeforeBRefresh ||
      bSettingsBeforeBRefresh.quantity?.active_quantity_id !== quantityId ||
      bSettingsBeforeBRefresh.style?.surface_color_source !== "magnitude"
    ) {
      await captureViewportComparisonFailure(
        page,
        "empty-range FEM target settings before perturbation",
        bRestoredForMask,
        null,
        { aSettingsBeforeBRefresh, bSettingsBeforeBRefresh },
      );
      throw new Error("Both FEM targets must retain H_eff magnitude settings before perturbing B.");
    }
    const bFieldBeforeRefresh = await waitForFdmFullFieldPayload(page, quantityId);
    if (
      bFieldBeforeRefresh.status !== "ready" ||
      !bFieldBeforeRefresh.hasValues
    ) {
      await captureViewportComparisonFailure(
        page,
        "part B field before perturbation",
        bRestoredForMask,
        null,
        { bFieldBeforeRefresh },
      );
      throw new Error("Part B field is not ready before perturbation.");
    }

    const bValuesBeforeExpected = [
      1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0,
      1_000, 0, 0,
      10_000, 0, 0,
      100_000, 0, 0,
      1_000_000, 0, 0,
    ];
    const bPayloadBefore = await waitForFdmFullFieldPayload(page, quantityId, {
      etag: '"fixture-full-r1"',
      values: bValuesBeforeExpected,
    });
    const bBeforePixels = await sampleViewportPixels(page, null, true);
    await assertViewportSampleGeometryEqual(page, aRestoredForMask, bBeforePixels, "pre-perturbation viewport");
    const bRequest = {
      component: "full",
      quantityId,
      scopeId: null,
      scopeKind: "full",
    };
    const bRequestsBefore = countFieldRequests(fixture, bRequest);

    const aFixtureResponseRevisionBefore = fixture.scopedFieldRevisions["part-empty-range"];
    fixture.scopedFieldRevisions["part-visible"] = 2;
    fixture.fullFieldRevision = 2;
    fixture.scopedFieldMagnitudes = [1, 2, 3, 4, 1_000_000, 1_000_000, 1_000_000, 1_000_000];
    const bCanonicalRequest = [...fixture.fieldRequests].reverse().find((entry) =>
      entry.method === "GET" &&
      entry.quantityId === quantityId &&
      entry.component === "full" &&
      entry.scopeId === null &&
      entry.scopeKind === "full",
    );
    if (!bCanonicalRequest) {
      throw new Error("Could not resolve the canonical H_eff field request for part B.");
    }
    const bRecommendedFetch = bCanonicalRequest.url;
    const bRecommendedFetchUrl = new URL(bRecommendedFetch, apiBase);
    if (
      bRecommendedFetchUrl.pathname !== "/v2/sessions/current/data/fields/H_eff/samples/vector" ||
      bRecommendedFetchUrl.searchParams.get("component") !== "full" ||
      bRecommendedFetchUrl.searchParams.has("scope_id") ||
      bRecommendedFetchUrl.searchParams.get("scope_kind") !== "full"
    ) {
      throw new Error("Part B realtime invalidation did not use its canonical field request URL.");
    }
    sendFixtureFieldSamplesInvalidation(fixture, 2, bRecommendedFetch, 2);

    let bPayloadAfter;
    try {
      bPayloadAfter = await waitForFdmFullFieldPayload(
        page,
        quantityId,
        {
          etag: '"fixture-full-r2"',
          values: [
            1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0,
            1_000_000, 0, 0,
            1_000_000, 0, 0,
            1_000_000, 0, 0,
            1_000_000, 0, 0,
          ],
        },
      );
    } catch (error) {
      await captureViewportComparisonFailure(
        page,
        "part B field revision adoption",
        bBeforePixels,
        null,
        { bRequestsBefore, error: error instanceof Error ? error.message : String(error) },
      );
      throw error;
    }

    const bRequestsAfter = countFieldRequests(fixture, bRequest);
    const bRevisionResponses = fixture.fullDomainFieldResponses.filter(
      (entry) => entry.revision === 2 && entry.pointCount === 8,
    );
    const aUnexpectedRevisionResponses = fixture.emptyPartFieldResponses.filter(
      (entry) =>
        entry.partId === "part-empty-range" &&
        entry.revision !== aFixtureResponseRevisionBefore,
    );
    const aFixtureResponseRevisionAfter = fixture.scopedFieldRevisions["part-empty-range"];
    const aFieldAfterBRefresh = {
      ...await readFEMPartNodeSupport(page, "part-empty-range"),
      fullFieldValuesOutsideBUnchanged:
        JSON.stringify(bPayloadAfter.values.slice(0, 12)) ===
        JSON.stringify(bPayloadBefore.values.slice(0, 12)),
    };
    const aSettingsAfterBRefresh = await readObjectVisualizationSettings(page, "fem-empty");
    const bSettingsAfterBRefresh = await readObjectVisualizationSettings(page, "fem-visible");
    if (
      bRequestsAfter <= bRequestsBefore ||
      bRevisionResponses.length === 0 ||
      aFixtureResponseRevisionAfter !== aFixtureResponseRevisionBefore ||
      aUnexpectedRevisionResponses.length > 0 ||
      !aFieldAfterBRefresh.emptyNodeMembership ||
      aFieldAfterBRefresh.manifestRevision !== aFieldBeforeBRefresh.manifestRevision ||
      !aFieldAfterBRefresh.fullFieldValuesOutsideBUnchanged ||
      JSON.stringify(aSettingsBeforeBRefresh) !== JSON.stringify(aSettingsAfterBRefresh) ||
      JSON.stringify(bSettingsBeforeBRefresh) !== JSON.stringify(bSettingsAfterBRefresh)
    ) {
      await captureViewportComparisonFailure(
        page,
        "part B perturbation contract",
        bBeforePixels,
        null,
        {
          aFixtureResponseRevisionAfter,
          aFixtureResponseRevisionBefore,
          aFieldAfterBRefresh,
          aUnexpectedRevisionResponses,
          aSettingsAfterBRefresh,
          aSettingsBeforeBRefresh,
          bSettingsAfterBRefresh,
          bSettingsBeforeBRefresh,
          bRequestsAfter,
          bRequestsBefore,
          bRevisionResponses,
          bPayloadAfter,
        },
      );
      throw new Error("B perturbation did not preserve A's empty field, target settings, and request/revision contract.");
    }

    await assertHealthyCanvas(page, "nonempty FEM B field revision adopted");
    let bPixelDelta;
    try {
      bPixelDelta = await waitForViewportPixelDelta(
        page,
        bBeforePixels,
        "nonempty FEM part B updated field color",
        { minimumChangedPixels: 20 },
      );
    } catch (error) {
      await captureViewportComparisonFailure(
        page,
        "part B pixel update",
        bBeforePixels,
        null,
        { bPayloadAfter, error: error instanceof Error ? error.message : String(error) },
      );
      throw error;
    }
    const bAfterPixels = await sampleViewportPixels(page, null, true);
    await assertViewportSampleGeometryEqual(page, bBeforePixels, bAfterPixels, "B field refresh");
    let maskFailureDiagnostics = null;
    try {
      maskFailureDiagnostics = buildViewportMaskFailureDiagnostics(
        bBeforePixels,
        bAfterPixels,
        aPixelMask,
        bPixelMask,
      );
    } catch (error) {
      maskFailureDiagnostics = {
        captureError: error instanceof Error ? error.message : String(error),
        masks: {
          a: aPixelMask,
          aExclusive: aExclusivePixelMask,
          b: bPixelMask,
          bExclusive: bExclusivePixelMask,
          intersection: intersectionPixelMask,
        },
        rawMasks: { a: aPixelMask, b: bPixelMask },
      };
    }
    if (maskFailureDiagnostics?.captureError) {
      await captureViewportComparisonFailure(
        page,
        "part A/B pixel mask diagnostics",
        bBeforePixels,
        bAfterPixels,
        { pixelMaskDiagnostics: maskFailureDiagnostics },
      );
      throw new Error("Could not capture complete A/B pixel mask diagnostics: " + maskFailureDiagnostics.captureError);
    }
    const aLeakDelta = await assertViewportPixelDeltaOnMask(
      page,
      bBeforePixels,
      bAfterPixels,
      aExclusivePixelMask,
      "later-part H_eff values changed visible empty-range part A",
      {
        failureDiagnostics: maskFailureDiagnostics,
        minimumChangedPixels: aMinimumChangedPixels,
        shouldChange: false,
      },
    );
    const bColorDelta = await assertViewportPixelDeltaOnMask(
      page,
      bBeforePixels,
      bAfterPixels,
      bExclusivePixelMask,
      "updated nonempty part B did not change its own field colors",
      {
        failureDiagnostics: maskFailureDiagnostics,
        minimumChangedPixels: 20,
        shouldChange: true,
      },
    );
    assertNoBrowserErrors(errors);
    await captureBrowserAuditScreenshot(page, "empty-part-thickness-average-z-success.png");
    return {
      emptyPartA: {
        fieldColorDelta: aLeakDelta,
        maskRestoreDelta: aMaskRestoreDelta,
        maskSamples: aPixelMask.length,
        nodeCount: 0,
        nodeStart: 4,
        redBaselineSamples: emptyRedPixels,
        visualizationOverride: emptyOverride,
      },
      fieldRequests: fixture.fieldRequests,
      fieldResource,
      exclusivePixelMaskContract: {
        aMinimumChangedPixels,
        aMinimumMaskSamples: minimumAExclusiveMaskSamples,
        aMaskSamples: aExclusivePixelMask.length,
        bMinimumChangedPixels: 20,
        bMinimumMaskSamples: minimumBExclusiveMaskSamples,
        bMaskSamples: bExclusivePixelMask.length,
      },
      pixelMaskDiagnostics: maskFailureDiagnostics,
      scopedFieldResponses: fixture.emptyPartFieldResponses,
      fullDomainFieldResponses: fixture.fullDomainFieldResponses,
      positiveFieldResource,
      positiveControlPartB: {
        fieldColorDelta: positiveDelta,
        nodeCount: 4,
        nodeStart: 4,
        redBaselineSamples: positiveRedPixels,
        visualizationOverride: positiveOverride,
      },
      crossPartFieldPerturbation: {
        aFixtureResponseRevisionUnchanged: aFixtureResponseRevisionAfter === aFixtureResponseRevisionBefore,
        aPixelDeltaDuringBRefresh: aLeakDelta,
        aPixelMaskSamples: aPixelMask.length,
        aTargetSettingsUnchanged: true,
        bTargetSettingsUnchanged: true,
        bAcceptedRevisionAfter: bPayloadAfter.etag,
        bAcceptedRevisionBefore: bPayloadBefore.etag,
        bColorDeltaDuringRefresh: bColorDelta,
        bFieldVectorsAfter: bPayloadAfter.values,
        bFieldVectorsBefore: bPayloadBefore.values,
        bPixelMaskSamples: bPixelMask.length,
        bRequestCountAfter: bRequestsAfter,
        bRequestCountBefore: bRequestsBefore,
        bResourceRevisionAfter: bPayloadAfter.resourceRevision,
        bResourceRevisionBefore: bPayloadBefore.resourceRevision,
        maskRestoreDeltaA: aMaskRestoreDelta,
        maskRestoreDeltaB: bMaskRestoreDelta,
      },
      projectionMode: "thickness_average_z",
      topology: "FEM H_eff: isolated empty part 204; equal scalar modes coalesced to full-domain nodal envelope",
      qualificationScope: "Browser empty support under a full-domain field refresh changing only B; independent scoped-empty response is checked before coalescing.",
    };
  } catch (error) {
    hasOriginalFailure = true;
    try {
      await captureViewportDeltaFailure(page, "empty-part-thickness-average-z", {
        originalError: error instanceof Error
          ? { message: error.message, name: error.name, stack: error.stack ?? null }
          : { thrownValue: String(error) },
      });
    } catch {
      // Preserve the scenario failure if the diagnostic fallback also fails.
    }
    throw error;
  } finally {
    try {
      await page.close();
    } catch (closeError) {
      if (!hasOriginalFailure) throw closeError;
    }
  }
}

async function enableMagnitudeSurfaceColoring(page, fixture, objectId) {
  await setObjectDisplayState(page, {
    colorbar: true,
    vectors: false,
    wireframe: false,
  });
  const panel = page.locator(".fm-inspector-panel").last();
  const colorSource = panel.locator('select[aria-label="Color source"]');
  const selectedColorSource = await colorSource.inputValue();
  if (selectedColorSource !== "magnitude") {
    throw new Error(`Inspector did not select magnitude surface coloring for ${objectId}: ${selectedColorSource}.`);
  }
  const colorbar = panel.getByRole("switch", { name: "Add colorbar to viewport" });
  if (
    (await colorbar.count()) &&
    (await colorbar.getAttribute("aria-checked")) === "true"
  ) {
    await colorbar.click();
    await waitForVisualizationMutationSettled(page, panel);
  }
  return assertMagnitudeThicknessOverride(fixture, objectId);
}

function assertMagnitudeThicknessOverride(fixture, objectId) {
  const override = fixture.visualization.overrides.find(
    (candidate) => candidate.scope === "object" && candidate.scope_id === objectId,
  );
  const style = override?.style;
  if (
    style?.surface_color_source !== "magnitude" ||
    style?.surface_projection_mode !== "thickness_average_z"
  ) {
    throw new Error(`Inspector/API resource did not retain magnitude thickness-average-Z for ${objectId}: ${JSON.stringify(override)}.`);
  }
  return {
    colorSource: style.surface_color_source,
    projectionMode: style.surface_projection_mode,
  };
}

function countRedDominantPixels(sample) {
  let count = 0;
  for (let offset = 0; offset < sample.signature.length; offset += 3) {
    const red = sample.signature[offset];
    const green = sample.signature[offset + 1];
    const blue = sample.signature[offset + 2];
    if (red >= 36 && red > green * 1.4 && red > blue * 1.4) count += 1;
  }
  return count;
}

async function installFixtureRealtime(page, fixture) {
  fixture.realtime = { connectionCount: 0, socket: null };
  await page.routeWebSocket(
    (url) => new URL(url).pathname === "/v2/sessions/current/events/ws",
    (websocket) => {
      if (!websocket.protocols().includes("fullmag.live.v1")) {
        throw new Error("Empty-part realtime fixture omitted fullmag.live.v1.");
      }
      fixture.realtime.connectionCount += 1;
      fixture.realtime.socket = websocket;
    },
  );
}

async function waitForFixtureRealtimeConnection(fixture) {
  const deadline = Date.now() + timeoutMs;
  while (fixture.realtime.connectionCount < 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (fixture.realtime.connectionCount < 1 || !fixture.realtime.socket) {
    throw new Error("Empty-part realtime fixture did not connect.");
  }
}

function sendFixtureRealtimeHello(fixture, sequence) {
  const socket = fixture.realtime?.socket;
  if (!socket) throw new Error("Empty-part realtime fixture socket is not connected.");
  socket.send(JSON.stringify({
    contract_version: "1.0.0",
    payload: {
      request_scope_epoch: fixture.status.session.request_scope_epoch,
    },
    run_id: fixture.status.run?.run_id ?? null,
    seq: sequence,
    session_id: fixture.status.session.session_id,
    type: "hello",
  }));
}

function sendFixtureFieldSamplesInvalidation(fixture, sequence, recommendedFetch, revision) {
  const socket = fixture.realtime?.socket;
  if (!socket) throw new Error("Empty-part realtime fixture socket is not connected.");
  socket.send(JSON.stringify({
    contract_version: "1.0.0",
    payload: {
      changes: [{
        quantity_ids: ["H_eff"],
        recommended_fetch: recommendedFetch,
        resource: "fields",
        resource_id: "samples",
        revision,
      }],
    },
    run_id: fixture.status.run?.run_id ?? null,
    seq: sequence,
    session_id: fixture.status.session.session_id,
    type: "resource.batch_changed",
  }));
}

async function installFixtureConfig(page, realtimeEnabled = false) {
  await page.addInitScript(({ baseUrl, realtimeEnabled: enableRealtime }) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      allowMissingSessionSmoke: true,
      controlRoomApiBase: baseUrl,
      disableRealtime: !enableRealtime,
    };
  }, { baseUrl: apiBase, realtimeEnabled });
}

async function installFixtureApi(page, fixture) {
  await page.route("**/v2/platform/development-backend", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") return route.continue();
    const requestUrl = new URL(request.url());
    fixture.requests.push(`${request.method()} ${requestUrl.pathname}${requestUrl.search}`);
    return fulfillJson(route, {
      schema_version: "1.0.0",
      configured: false,
      revision: 0,
      state: "disabled",
      current_build: null,
      ready_build: null,
      build_available: false,
      build_request_id: null,
      workspace_identity: null,
      restart_available: false,
      reason: "disabled",
    });
  });
  await page.route("**/v2/sessions", async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    fixture.requests.push(`${request.method()} ${requestUrl.pathname}${requestUrl.search}`);
    await fulfillJson(route, {
      schema_version: "2.0.0",
      sessions: [
        {
          current: true,
          name: fixture.status.session.name,
          session_id: fixture.status.session.session_id,
          status: "active",
        },
      ],
    });
  });
  await page.route("**/v2/sessions/current/**", async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    const path = requestUrl.pathname;
    fixture.requests.push(`${request.method()} ${path}${requestUrl.search}`);
    if (request.method() === "OPTIONS") return fulfillEmpty(route, 204);
    if (path === "/v2/sessions/current/visualization/state" && request.method() === "PATCH") {
      const patch = request.postDataJSON() ?? {};
      if (fixture.visualizationPatchReducer) {
        fixture.visualization = fixture.visualizationPatchReducer(
          fixture.visualization,
          patch,
        );
      } else {
        fixture.visualization = applyPatch(fixture.visualization, patch);
        fixture.visualization.revision += 1;
      }
      return fulfillJson(route, fixture.visualization);
    }
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
    if (path.startsWith("/v2/sessions/current/data/fields/") && path.endsWith("/availability")) {
      const quantityId = path.split("/")[6] ?? "m";
      return fulfillJson(route, fieldAvailabilityFixture({
        fixture,
        quantityId,
        query: requestUrl.searchParams,
      }));
    }
    if (path.includes("/data/fields/") && path.endsWith("/meta")) {
      const quantityId = path.split("/")[6] ?? "m";
      return fulfillJson(
        route,
        fixture.fieldMetaFactory?.(quantityId) ?? fieldMetaFixture(quantityId),
      );
    }
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
        if (fixture.fullDomainFieldResponses) {
          const revision = fixture.fullFieldRevision;
          const etag = '"fixture-full-r' + revision + '"';
          fixture.fullDomainFieldResponses.push({ etag, pointCount: 8, revision });
          return fulfillBinary(route,
            femEmptyPartColorFieldVectorBuffer(quantityId, fixture.scopedFieldMagnitudes),
            { ...fieldVectorHeaders(fieldRequest), etag });
        }
        if (fixture.fieldVectorFactory) {
          return fulfillBinary(
            route,
            fixture.fieldVectorFactory(quantityId),
            fieldVectorHeaders(fieldRequest),
          );
        }
        return fulfillBinary(
          route,
          fdmFieldVectorBuffer({ quantityId, gridShape: fixture.domain.grid?.shape }),
          fieldVectorHeaders(fieldRequest),
        );
      }
      if (fixture.emptyPartFieldResponses && fieldRequest.scopeKind === "part") {
        const part = fixture.manifest.mesh_parts.find((entry) => entry.id === fieldRequest.scopeId);
        if (!part) throw new Error(`Unknown scoped FEM fixture part ${fieldRequest.scopeId}.`);
        const nodeIndices = part.node_indices ?? Array.from({ length: part.node_count }, (_, index) => part.node_start + index);
        const revision = fixture.scopedFieldRevisions?.[part.id] ?? 1;
        const etag = '"fixture-' + part.id + '-r' + revision + '"';
        fixture.emptyPartFieldResponses.push({
          etag,
          partId: part.id,
          nodeIndices,
          revision,
          status: nodeIndices.length === 0 ? 204 : 200,
        });
        if (nodeIndices.length === 0) return fulfillEmpty(route, 204);
        const scoped = fdmScopedFieldVectorBuffer({ fieldRequest, fixture, nodeIndices });
        return fulfillBinary(route, scoped.buffer, { ...scoped.headers, etag });
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
  if (expectedVisible && currentVisible !== "true") {
    await setObjectVisibilityAndWaitForAcknowledgement(page, panel, visible, true);
  }
  const shadedWithEdges = panel.getByRole("radio", { name: "Shaded +" });
  if (expected.wireframe && (await shadedWithEdges.getAttribute("aria-checked")) !== "true") {
    await shadedWithEdges.click();
    await page.waitForFunction(
      () => document.querySelector('.fm-viz-render-mode-grid [role="radio"][aria-label="Shaded +"]')?.getAttribute("aria-checked") === "true",
      null,
      { timeout: timeoutMs },
    );
    await waitForVisualizationMutationSettled(page, panel);
  }
  if (!expected.wireframe) {
    const shaded = panel.getByRole("radio", { name: "Shaded", exact: true });
    if ((await shaded.getAttribute("aria-checked")) !== "true") {
      await shaded.click();
      await page.waitForFunction(
        () => document.querySelector('.fm-viz-render-mode-grid [role="radio"][aria-label="Shaded"]')?.getAttribute("aria-checked") === "true",
        null,
        { timeout: timeoutMs },
      );
      await waitForVisualizationMutationSettled(page, panel);
    }
  }
  // Surface coloring is deliberately disabled while the surface pass is off.
  // Establish the requested render mode before enabling vectors or selecting a
  // scalar color source, otherwise the smoke would test an invalid UI order.
  const vectors = panel.getByRole("button", { name: "Toggle vector field arrows" });
  if ((await vectors.getAttribute("aria-pressed")) !== String(expected.vectors)) {
    await vectors.click();
    await waitForVisualizationMutationSettled(page, panel);
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
    await waitForVisualizationMutationSettled(page, panel);
  }
  const colorbar = panel.getByRole("switch", { name: "Add colorbar to viewport" });
  if (await colorbar.count() && (await colorbar.getAttribute("aria-checked")) !== String(expected.colorbar)) {
    await colorbar.click();
    await waitForVisualizationMutationSettled(page, panel);
  }
  // Hiding is applied last because the Inspector intentionally disables
  // render-mode controls for a hidden target.
  if (!expectedVisible && (await visible.getAttribute("aria-pressed")) !== "false") {
    await setObjectVisibilityAndWaitForAcknowledgement(page, panel, visible, false);
  }
}

async function setObjectVisibilityAndWaitForAcknowledgement(page, panel, visible, expectedVisible) {
  const selectedTarget = await readTargetId(page);
  if (!selectedTarget?.startsWith("object:")) {
    throw new Error(`Target visibility mutation expected an object Inspector, got ${selectedTarget ?? "none"}.`);
  }
  const objectId = selectedTarget.slice("object:".length);
  const previousRevision = await page.evaluate(() => {
    const state = window.__FULLMAG_CONTROL_ROOM_AUDIT__
      ?.readViewportAuditResource?.("/v2/sessions/current/visualization/state");
    return Number.isSafeInteger(state?.data?.revision) ? state.data.revision : null;
  });
  const acknowledgementPromise = page.waitForResponse((response) => {
    const request = response.request();
    if (request.method() !== "PATCH" ||
        new URL(response.url()).pathname !== "/v2/sessions/current/visualization/state") return false;
    try {
      const patch = request.postDataJSON();
      return Array.isArray(patch?.overrides) && patch.overrides.some((override) =>
        override?.scope === "object" && override.scope_id === objectId &&
        override.visible === expectedVisible);
    } catch {
      return false;
    }
  }, { timeout: timeoutMs });
  acknowledgementPromise.catch(() => {});
  await visible.click();
  const acknowledgement = await acknowledgementPromise;
  if (!acknowledgement.ok()) {
    throw new Error(`Target visibility mutation was not acknowledged: HTTP ${acknowledgement.status()}.`);
  }
  const acknowledgedState = await acknowledgement.json();
  const acknowledgedTarget = acknowledgedState?.overrides?.find((override) =>
    override?.scope === "object" && override.scope_id === objectId);
  if (acknowledgedTarget?.visible !== expectedVisible) {
    throw new Error(`Target visibility mutation for ${objectId} returned a mismatched target override: ${JSON.stringify(acknowledgedTarget ?? null)}.`);
  }
  if (!Number.isSafeInteger(acknowledgedState?.revision) ||
      (previousRevision !== null && acknowledgedState.revision <= previousRevision)) {
    throw new Error(`Target visibility mutation for ${objectId} returned no advancing visualization revision: ${JSON.stringify({ acknowledgedState, previousRevision })}.`);
  }
  await waitForVisualizationMutationSettled(page, panel, acknowledgedState.revision);
  await waitForRenderedViewportFrame(page);
}

async function waitForVisualizationMutationSettled(page, panel, acknowledgedRevision = null) {
  const panelHandle = await panel.elementHandle();
  if (!panelHandle) throw new Error("Selected visualization Inspector disappeared while saving a display mutation.");
  try {
    await page.waitForFunction(
      (element) =>
        element instanceof HTMLElement &&
        !element.innerText.includes("Saving display changes."),
      panelHandle,
      { timeout: timeoutMs },
    );
  } catch (error) {
    const diagnostic = await page.evaluate(() => {
      const audit = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
      const panelElement = document.querySelectorAll(".fm-inspector-panel").item(
        document.querySelectorAll(".fm-inspector-panel").length - 1,
      );
      return {
        inspectorText: panelElement?.textContent?.slice(-2_000) ?? null,
        sync: audit?.readVisualizationSyncSnapshot?.() ?? null,
        controller: audit?.readVisualizationControllerSnapshot?.() ?? null,
        visualization: audit?.readViewportAuditResource?.("/v2/sessions/current/visualization/state") ?? null,
      };
    });
    throw new Error(
      `Visualization mutation did not settle: ${error instanceof Error ? error.message : String(error)} ${JSON.stringify(diagnostic)}`,
    );
  }
  if (acknowledgedRevision !== null) {
    try {
      await page.waitForFunction((revision) => {
        const state = window.__FULLMAG_CONTROL_ROOM_AUDIT__
          ?.readViewportAuditResource?.("/v2/sessions/current/visualization/state");
        return Number.isSafeInteger(state?.data?.revision) && state.data.revision >= revision;
      }, acknowledgedRevision, { timeout: timeoutMs });
    } catch (error) {
      const diagnostic = await page.evaluate(() => window.__FULLMAG_CONTROL_ROOM_AUDIT__
        ?.readViewportAuditResource?.("/v2/sessions/current/visualization/state") ?? null);
      throw new Error(
        `Visualization audit resource did not adopt acknowledged revision ${acknowledgedRevision}: ${error instanceof Error ? error.message : String(error)} ${JSON.stringify(diagnostic)}`,
      );
    }
  }
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
    await waitForVisualizationMutationSettled(page, panel);
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
  const selectedTarget = await readTargetId(page);
  const targetRef = visualizationTargetRefFromInspectorId(selectedTarget);
  return {
    colorSource: await colorSource.evaluate((select) => ({
      ariaDisabled: select.getAttribute("aria-disabled"),
      disabled: select.disabled,
      options: Array.from(select.options).map((option) => option.value),
      value: select.value,
    })),
    inspectorDebug: await panel.locator('[role="alert"], [data-slot*="diagnostic"], [data-slot*="warning"]').allTextContents(),
    inspectorText: (await panel.innerText()).slice(0, 8_000),
    selectedTarget,
    runtime: await page.evaluate(() => {
      const audit = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
      return {
        targetSettings: audit?.readVisualizationTargetSettings?.(targetRef) ?? null,
        listeners: audit?.readViewportAuditRuntime?.().listenerCounts ?? null,
        visualization: audit?.readViewportAuditResource?.("/v2/sessions/current/visualization/state") ?? null,
      };
    }, targetRef),
    requests: await page.evaluate(() => performance.getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => name.includes("/v2/sessions/current/"))),
  };
}

function visualizationTargetRefFromInspectorId(targetId) {
  if (targetId === "airbox") return { id: "airbox", kind: "airbox" };
  if (targetId?.startsWith("object:")) return { id: targetId, kind: "object" };
  if (targetId?.startsWith("part:")) return { id: targetId, kind: "part" };
  if (targetId?.startsWith("region:")) return { id: targetId, kind: "region" };
  if (targetId?.startsWith("fdm-native-layer:")) {
    return { id: targetId, kind: "fdm-native-layer" };
  }
  return { id: targetId ?? "fdm-domain", kind: "fdm-domain" };
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
  await waitForVisualizationMutationSettled(page, page.locator(".fm-inspector-panel").last());
}

async function setAirboxQuantityAndVectors(page, quantityId) {
  const panel = page.locator(".fm-inspector-panel").last();
  const quantity = panel.locator('select[aria-label="Quantity Source"]');
  if (await quantity.count() !== 1) throw new Error(`Airbox inspector must expose exactly one Quantity Source combobox; found ${await quantity.count()}.`);
  if (await quantity.isDisabled()) throw new Error(`Airbox Quantity Source is disabled before selecting ${quantityId}.`);
  const quantityIdAttribute = await quantity.getAttribute("id");
  await page.waitForFunction(
    ({ id, value }) => {
      const select = id ? document.getElementById(id) : null;
      return select instanceof HTMLSelectElement && Array.from(select.options).some((option) => option.value === value);
    },
    { id: quantityIdAttribute, value: quantityId },
    { timeout: timeoutMs },
  );
  const optionState = await quantity.locator(`option[value="${quantityId}"]`).evaluate((option) => ({
    disabled: option.disabled,
    label: option.textContent,
    value: option.value,
  }));
  if (optionState.disabled) {
    const diagnostic = await page.evaluate(() => {
      const audit = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
      return {
        inspectorText: document.querySelectorAll(".fm-inspector-panel").item(
          document.querySelectorAll(".fm-inspector-panel").length - 1,
        )?.textContent?.slice(-4_000) ?? null,
        sync: audit?.readVisualizationSyncSnapshot?.() ?? null,
        visualization: audit?.readViewportAuditResource?.("/v2/sessions/current/visualization/state") ?? null,
      };
    });
    throw new Error(`Airbox quantity option ${quantityId} is disabled: ${JSON.stringify({ optionState, diagnostic })}`);
  }
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


async function captureViewportCanvasFailureDiagnostics(page, label, context, waitError) {
  const screenshotPath = join(
    browserAuditArtifactDir,
    `canvas-failure-${Date.now()}-${randomUUID().slice(0, 8)}.png`,
  );
  let screenshotError = null;
  try {
    await mkdir(browserAuditArtifactDir, { recursive: true });
    await page.screenshot({ fullPage: true, path: screenshotPath, timeout: 10_000 });
  } catch (error) {
    screenshotError = error instanceof Error ? error.message : String(error);
  }

  let dom = null;
  let domError = null;
  try {
    dom = await page.evaluate(() => {
      const describe = (element) => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          className: typeof element.className === "string" ? element.className : "",
          height: rect.height,
          text: (element.textContent ?? "").trim().slice(0, 400),
          visible: style.display !== "none" && style.visibility !== "hidden" &&
            rect.width > 0 && rect.height > 0,
          width: rect.width,
        };
      };
      const audit = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
      let activeViewportModule = null;
      let auditError = null;
      try {
        activeViewportModule = audit?.readActiveViewportModule?.() ?? null;
      } catch (error) {
        auditError = error instanceof Error ? error.message : String(error);
      }
      const viewportHost = document.querySelector('[data-slot-id="viewport-main"]');
      return {
        activeViewportModule,
        alerts: [...document.querySelectorAll('[role="alert"]')].slice(0, 10).map(describe),
        auditError,
        bodyText: (document.body?.innerText ?? "").slice(0, 4_000),
        canvases: [...document.querySelectorAll("canvas")].slice(0, 10).map(describe),
        config: { disableViewport3D: window.__FULLMAG_CONFIG__?.disableViewport3D ?? null },
        document: { readyState: document.readyState, title: document.title, url: location.href },
        errorBoundaries: [...document.querySelectorAll(".fm-viewport-3d__error-boundary")].slice(0, 5).map(describe),
        placeholders: [...document.querySelectorAll(".fm-viewport-3d__placeholder")].slice(0, 5).map(describe),
        startHosts: [...document.querySelectorAll(".fm-start-host")].slice(0, 5).map(describe),
        viewport3D: describe(document.querySelector(".fm-viewport-3d")),
        viewportHost: describe(viewportHost),
        viewportModuleId: viewportHost?.getAttribute("data-active-module-id") ?? null,
      };
    });
  } catch (error) {
    domError = error instanceof Error ? error.message : String(error);
  }

  const fixture = context?.fixture;
  return {
    browserErrors: context?.browserErrors ?? [],
    dom,
    domError,
    fixture: fixture ? {
      capabilities: fixture.status?.capabilities ?? null,
      domain: { counts: fixture.domain?.counts ?? null, discretization: fixture.domain?.discretization ?? null },
      fieldRequests: fixture.fieldRequests?.slice(-20) ?? [],
      meshParts: fixture.manifest?.mesh_parts?.map((part) => ({
        boundary_face_count: part.boundary_face_count,
        boundary_face_start: part.boundary_face_start,
        element_count: part.element_count,
        element_start: part.element_start,
        id: part.id,
        node_count: part.node_count,
        node_start: part.node_start,
      })) ?? null,
      requests: fixture.requests?.slice(-60) ?? [],
      sessionId: fixture.status?.session?.session_id ?? null,
    } : null,
    label,
    network: context?.network ?? null,
    screenshot: screenshotError ? { error: screenshotError } : screenshotPath,
    timeout: waitError instanceof Error
      ? { message: waitError.message, name: waitError.name }
      : String(waitError),
  };
}

async function assertHealthyCanvas(page, label, diagnosticContext = null) {
  const canvas = page.locator(CANVAS_SELECTOR);
  try {
    await canvas.waitFor({ state: "visible", timeout: timeoutMs });
  } catch (error) {
    const diagnostic = await captureViewportCanvasFailureDiagnostics(
      page, label, diagnosticContext, error,
    );
    console.error(`[viewport-canvas-failure] ${JSON.stringify(diagnostic)}`);
    throw error;
  }
  const state = await canvas.evaluate((node) => {
    const gl = node.getContext("webgl2") ?? node.getContext("webgl");
    return {
      contextLost: gl?.isContextLost() ?? true,
      drawingBufferHeight: gl?.drawingBufferHeight ?? 0,
      drawingBufferWidth: gl?.drawingBufferWidth ?? 0,
    };
  });
  if (state.contextLost || state.drawingBufferWidth <= 0 || state.drawingBufferHeight <= 0) throw new Error(`${label}: WebGL failed closed: ${JSON.stringify(state)}.`);
  const screenshot = await canvas.screenshot();
  if (screenshot.length < 64 || screenshot.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error(`${label}: viewport did not produce a PNG screenshot.`);
  }
}

// ADR 0054 stage 3b: Analysis has no surface tabs. The surface follows the
// selected Explorer Results family node (results:run:<id>:<suffix>). Fixtures
// without a current run expose no family nodes; then the surface is reached
// through the persisted analysis-view preference and a reload, and the proof
// records which route was used.
const ANALYSIS_SURFACE_RESULTS_NODE_SUFFIX = Object.freeze({
  comparison: "comparison",
  dispersion: "k-resolved",
  dynamics: "dynamics",
  hysteresis: "hysteresis",
  "resonance-fmr": "resonance",
});

async function analysisSurfaceTitle(page) {
  return page.evaluate(() =>
    document
      .querySelector(".fm-analysis-plots__surface-title")
      ?.getAttribute("data-analysis-surface-title") ?? null,
  );
}

async function selectAnalysisSurfaceFromExplorer(page, surfaceId) {
  const suffix = ANALYSIS_SURFACE_RESULTS_NODE_SUFFIX[surfaceId];
  if (!suffix) throw new Error(`Unknown Analysis surface: ${surfaceId}`);
  if ((await page.locator(".fm-analysis-plots [role='tablist']").count()) !== 0) {
    throw new Error("Analysis must not render surface tabs; Explorer selection owns the surface.");
  }
  await page.locator(".fm-analysis-plots__surface-title").waitFor({ state: "visible", timeout: timeoutMs });
  if ((await analysisSurfaceTitle(page)) === surfaceId) return "already-active";
  const resultsTab = page.locator(".fm-explorer .fm-tabs-trigger").filter({ hasText: /^Results$/ }).first();
  let route = "stored-preference-reload";
  if (await resultsTab.count()) {
    if ((await resultsTab.getAttribute("aria-selected")) !== "true") await resultsTab.click({ timeout: timeoutMs });
    const resultsRoot = page.locator('.fm-explorer [role="treeitem"][data-node-id^="results:run:"]').first();
    if (await resultsRoot.count()) {
      const rootId = await resultsRoot.getAttribute("data-node-id");
      if ((await resultsRoot.getAttribute("aria-expanded")) === "false") {
        const branch = resultsRoot.locator(".fm-explorer-tree-row__branch");
        if (await branch.count()) await branch.click({ timeout: timeoutMs });
        else await resultsRoot.dblclick({ timeout: timeoutMs });
      }
      const familyNode = page.locator(`.fm-explorer [data-node-id="${rootId}:${suffix}"]`);
      if (await familyNode.count()) {
        await familyNode.click({ timeout: timeoutMs });
        route = "explorer";
      }
    }
  }
  if (route !== "explorer") {
    await page.evaluate(({ key, activeSurface }) => {
      window.localStorage.setItem(key, JSON.stringify({ schemaVersion: 2, activeSurface }));
    }, { key: "fm:analysis-view-preferences:v2", activeSurface: surfaceId });
    await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
    const analysis = page.locator(".fm-viewport-tabs__trigger").filter({ hasText: /^Analysis$/ }).first();
    await analysis.click({ timeout: timeoutMs });
  }
  await page.waitForFunction(
    (expected) =>
      document
        .querySelector(".fm-analysis-plots__surface-title")
        ?.getAttribute("data-analysis-surface-title") === expected,
    surfaceId,
    { timeout: timeoutMs },
  );
  return route;
}

async function verifyAnalysisViewportHandoff(page, lane) {
  const analysis = page.locator(".fm-viewport-tabs__trigger").filter({ hasText: /^Analysis$/ }).first();
  await analysis.click({ timeout: timeoutMs });
  await page.locator("[data-slot-id='viewport-main'][data-active-module-id='analysis-plots']").waitFor({
    state: "attached",
    timeout: timeoutMs,
  });
  const workflows = [
    { surfaceId: "resonance-fmr", surface: "Resonance & FMR", subview: "Frequency Response" },
    { surfaceId: "resonance-fmr", surface: "Resonance & FMR", subview: "Eigenmodes" },
    { surfaceId: "dispersion", surface: "Dispersion", subview: "Modal fₙ(k)" },
  ];
  for (const workflow of workflows) {
    await selectAnalysisSurfaceFromExplorer(page, workflow.surfaceId);
    const subview = page.getByRole("combobox", { name: `${workflow.surface} subview` });
    await subview.click({ timeout: timeoutMs });
    await page.getByRole("option", { name: workflow.subview, exact: true }).click({ timeout: timeoutMs });
    await page.waitForFunction(
      ({ surfaceId, subview }) => {
        const title = document.querySelector(".fm-analysis-plots__surface-title");
        const subviewTrigger = document.querySelector("[data-slot='select-trigger'][data-analysis-subview]");
        const panel = document.querySelector(".fm-analysis-plots__panel--primary");
        return (
          title?.getAttribute("data-analysis-surface-title") === surfaceId &&
          subviewTrigger?.textContent?.includes(subview) &&
          panel instanceof HTMLElement &&
          panel.offsetWidth > 0 &&
          panel.offsetHeight > 0 &&
          Boolean(panel.querySelector(".fm-chart-section, .fm-analysis-plots__empty, [role='status']"))
        );
      },
      workflow,
      { timeout: timeoutMs },
    );
  }
  const viewport = page.locator(".fm-viewport-tabs__trigger").filter({ hasText: /^3D Viewport$/ }).first();
  await viewport.click({ timeout: timeoutMs });
  await page.locator("[data-slot-id='viewport-main'][data-active-module-id='viewport-3d']").waitFor({
    state: "attached",
    timeout: timeoutMs,
  });
  await assertHealthyCanvas(page, `${lane} Analysis to 3D handoff`);
  return { surfaces: workflows.map(({ surface, subview }) => `${surface} / ${subview}`) };
}

async function sampleViewportPixels(page, explicitStride = null, includePng = false) {
  const canvasLocator = page.locator(CANVAS_SELECTOR);
  const box = await canvasLocator.boundingBox();
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
  const viewportState = await page.evaluate(() => {
    const rect = (element) => {
      if (!element) return null;
      const bounds = element.getBoundingClientRect();
      const round = (value) => Math.round(value * 100) / 100;
      return {
        bottom: round(bounds.bottom),
        height: round(bounds.height),
        left: round(bounds.left),
        right: round(bounds.right),
        top: round(bounds.top),
        width: round(bounds.width),
        x: round(bounds.x),
        y: round(bounds.y),
      };
    };
    const audit = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
    const viewport = document.querySelector(".fm-viewport-3d");
    const canvas = viewport?.querySelector("canvas") ?? null;
    const visualization = audit?.readViewportAuditResource?.("/v2/sessions/current/visualization/state") ?? null;
    const cameraAttributeNames = [
      "data-camera-position",
      "data-camera-projection",
      "data-camera-target",
      "data-camera-up",
    ];
    const cameraAttributes = Object.fromEntries(
      cameraAttributeNames.map((name) => [name, viewport?.getAttribute(name) ?? null]),
    );
    const sceneAttributeNames = [
      "data-viewport-bounds",
      "data-topology-freshness",
      "data-visual-profile-id",
      "data-primitive-object-count",
      "data-primitive-object-ids",
      "data-primitive-object-kinds",
      "data-primitive-object-geometry-descriptors",
    ];
    const sceneAttributes = Object.fromEntries(
      sceneAttributeNames.map((name) => [name, viewport?.getAttribute(name) ?? null]),
    );
    const gl = canvas instanceof HTMLCanvasElement
      ? canvas.getContext("webgl2") ?? canvas.getContext("webgl")
      : null;
    return {
      camera: visualization?.data?.camera ?? null,
      cameraAttributes,
      canvas: canvas instanceof HTMLCanvasElement
        ? {
            contextLost: gl?.isContextLost() ?? true,
            drawingBufferHeight: gl?.drawingBufferHeight ?? 0,
            drawingBufferWidth: gl?.drawingBufferWidth ?? 0,
            height: canvas.height,
            width: canvas.width,
          }
        : null,
      canvasRect: rect(canvas),
      devicePixelRatio: window.devicePixelRatio,
      sceneAttributes,
      viewportRect: rect(viewport),
    };
  });
  return {
    bitmapHeight: bitmap.height,
    bitmapWidth: bitmap.width,
    signature,
    stride,
    viewportState,
    ...(includePng ? { png } : {}),
  };
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
  await captureViewportDeltaFailure(page, label, { delta: last });
  throw new Error(`${label} did not change rendered viewport pixels: ${JSON.stringify({ delta: last })}.`);
}

async function resolveViewportFailureArtifactStem(label) {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const baseStem = `target-smoke-${slug}`;
  let suffix = "";
  for (;;) {
    const stem = `${baseStem}${suffix}`;
    const paths = ["before.png", "after.png", "failure.png", "failure.json"]
      .map((suffix) => join(browserAuditArtifactDir, `${stem}-${suffix}`));
    let occupied = false;
    for (const path of paths) {
      try {
        await access(path);
        occupied = true;
        break;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    if (!occupied) return stem;
    suffix = `-${Date.now()}-${randomUUID().slice(0, 8)}`;
  }
}

function failureCaptureError(error) {
  return error instanceof Error
    ? { message: error.message, name: error.name }
    : { thrownValue: String(error) };
}

async function captureViewportDeltaFailure(page, label, payload, artifactStem = null, initialErrors = {}) {
  const captureErrors = { ...initialErrors };
  let stem = artifactStem;
  if (!stem) {
    try {
      stem = await resolveViewportFailureArtifactStem(label);
    } catch (error) {
      captureErrors.uniqueArtifactName = failureCaptureError(error);
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      stem = `target-smoke-${slug}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    }
  }
  try {
    await mkdir(browserAuditArtifactDir, { recursive: true });
  } catch (error) {
    captureErrors.directory = failureCaptureError(error);
    return { artifactStem: stem, errors: captureErrors };
  }
  let diagnostics = null;
  try {
    diagnostics = await page.evaluate(() => {
    function serializeViewportAuditValue(value, depth = 0) {
      if (depth > 4) return "[depth-limit]";
      if (value instanceof Map) {
        return {
          __type: "Map",
          entries: Array.from(value.entries()).slice(0, 64).map(([key, entry]) => [
            String(key),
            serializeViewportAuditValue(entry, depth + 1),
          ]),
          size: value.size,
        };
      }
      if (ArrayBuffer.isView(value)) {
        return {
          __type: value.constructor?.name ?? "TypedArray",
          length: value.length,
          sample: Array.from(value).slice(0, 8),
        };
      }
      if (Array.isArray(value)) {
        return value.slice(0, 64).map((entry) =>
          serializeViewportAuditValue(entry, depth + 1),
        );
      }
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value)
            .slice(0, 64)
            .map(([key, entry]) => [
              key,
              serializeViewportAuditValue(entry, depth + 1),
            ]),
        );
      }
      return value;
    }
    const audit = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
    const selectedNode = document.querySelector('[aria-selected="true"][data-node-id]');
    const viewport = document.querySelector(".fm-viewport-3d");
    const panel = document.querySelectorAll(".fm-inspector-panel").item(
      document.querySelectorAll(".fm-inspector-panel").length - 1,
    );
    const targetIds = ["object:fem-empty", "object:fem-visible", "object:fdm-left", "object:fdm-right", "fdm-domain", "airbox"];
    const resources = Object.fromEntries(
      Object.keys(audit?.readViewportAuditRuntime?.().listenerCounts ?? {})
        .filter((key) => key.includes("/v2/sessions/current/data/fields/") || key.includes("visualization/state"))
        .map((key) => [key, audit?.readViewportAuditResource?.(key) ?? null]),
    );
    const targetSettings = Object.fromEntries(
      targetIds.map((id) => {
        const kind = id === "airbox" ? "airbox" : id === "fdm-domain" ? "fdm-domain" : "object";
        return [id, audit?.readVisualizationTargetSettings?.({ id, kind }) ?? null];
      }),
    );
    const canvas = document.querySelector(".fm-viewport-3d canvas");
    const canvasState = canvas instanceof HTMLCanvasElement
      ? (() => {
          const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
          return {
            contextLost: gl?.isContextLost() ?? true,
            drawingBufferHeight: gl?.drawingBufferHeight ?? 0,
            drawingBufferWidth: gl?.drawingBufferWidth ?? 0,
            height: canvas.height,
            width: canvas.width,
          };
        })()
      : null;
    return {
      activeViewportModule: audit?.readActiveViewportModule?.() ?? null,
      canvas: canvasState,
      inspector: panel?.textContent?.slice(0, 12_000) ?? null,
      listenerCounts: audit?.readViewportAuditRuntime?.().listenerCounts ?? null,
      resourceStats: audit?.readViewportAuditRuntime?.().resources ?? null,
      selectedNodeId: selectedNode?.getAttribute("data-node-id") ?? null,
      sync: audit?.readVisualizationSyncSnapshot?.() ?? null,
      targetSettings,
      viewportAttributes: viewport
        ? Object.fromEntries(Array.from(viewport.attributes).map((attribute) => [attribute.name, attribute.value]))
        : null,
      visualization: audit?.readViewportAuditResource?.("/v2/sessions/current/visualization/state") ?? null,
      workers: audit?.readViewportAuditRuntime?.().workers ?? null,
      fieldResources: serializeViewportAuditValue(resources),
    };
    });
  } catch (error) {
    captureErrors.diagnostics = failureCaptureError(error);
  }
  const screenshotPath = join(browserAuditArtifactDir, `${stem}-failure.png`);
  const diagnosticsPath = join(browserAuditArtifactDir, `${stem}-failure.json`);
  const serializeDiagnostics = () => `${JSON.stringify({
    artifacts: { diagnostics: diagnosticsPath, screenshot: screenshotPath },
    captureErrors,
    diagnostics,
    label,
    ...payload,
  }, null, 2)}\n`;
  let diagnosticsPersisted = false;
  try {
    await writeFile(diagnosticsPath, serializeDiagnostics());
    diagnosticsPersisted = true;
  } catch (error) {
    captureErrors.json = failureCaptureError(error);
  }
  try {
    await page.screenshot({ path: screenshotPath });
  } catch (error) {
    captureErrors.screenshot = failureCaptureError(error);
    if (diagnosticsPersisted) {
      try {
        await writeFile(diagnosticsPath, serializeDiagnostics());
      } catch (writeError) {
        captureErrors.jsonUpdate = failureCaptureError(writeError);
      }
    }
  }
  return { artifactStem: stem, diagnosticsPath, errors: captureErrors, screenshotPath };
}

function summarizeViewportPixelSample(sample) {
  if (!sample) return null;
  return {
    bitmapHeight: sample.bitmapHeight,
    bitmapWidth: sample.bitmapWidth,
    stride: sample.stride,
    viewportState: sample.viewportState,
  };
}

async function captureViewportComparisonFailure(page, label, before, after, payload) {
  let artifactStem = null;
  const artifactErrors = {};
  try {
    artifactStem = await resolveViewportFailureArtifactStem(label);
  } catch (error) {
    artifactErrors.uniqueArtifactName = failureCaptureError(error);
  }
  if (!artifactStem) {
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    artifactStem = `target-smoke-${slug}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  }
  try {
    await mkdir(browserAuditArtifactDir, { recursive: true });
  } catch (error) {
    artifactErrors.directory = failureCaptureError(error);
  }
  if (before?.png) {
    try {
      await writeFile(join(browserAuditArtifactDir, `${artifactStem}-before.png`), before.png);
    } catch (error) {
      artifactErrors.beforeScreenshot = failureCaptureError(error);
    }
  }
  if (after?.png) {
    try {
      await writeFile(join(browserAuditArtifactDir, `${artifactStem}-after.png`), after.png);
    } catch (error) {
      artifactErrors.afterScreenshot = failureCaptureError(error);
    }
  }
  return captureViewportDeltaFailure(page, label, {
    ...payload,
    afterSample: summarizeViewportPixelSample(after),
    beforeSample: summarizeViewportPixelSample(before),
  }, artifactStem, artifactErrors);
}

async function assertViewportSampleGeometryEqual(page, before, after, label) {
  const matches =
    before.bitmapWidth === after.bitmapWidth &&
    before.bitmapHeight === after.bitmapHeight &&
    before.stride === after.stride &&
    JSON.stringify(before.viewportState) === JSON.stringify(after.viewportState);
  if (matches) return;
  await captureViewportComparisonFailure(page, label, before, after, {
    reason: "viewport geometry, drawing buffer, device scale, or camera state changed",
  });
  throw new Error(label + " changed viewport geometry, drawing buffer, device scale, or camera state.");
}

async function viewportPixelMask(page, visible, hidden, label, options = {}) {
  const length = Math.min(visible.signature.length, hidden.signature.length);
  const indices = [];
  for (let offset = 0; offset < length; offset += 3) {
    const delta =
      Math.abs(visible.signature[offset] - hidden.signature[offset]) +
      Math.abs(visible.signature[offset + 1] - hidden.signature[offset + 1]) +
      Math.abs(visible.signature[offset + 2] - hidden.signature[offset + 2]);
    if (delta > 18) indices.push(offset / 3);
  }
  const minimumMaskSamples = options.minimumMaskSamples ?? 21;
  if (indices.length < minimumMaskSamples) {
    await captureViewportComparisonFailure(page, label + " mask construction", visible, hidden, {
      maskSamples: indices.length,
      minimumMaskSamples,
    });
    throw new Error(label + " visibility toggle did not produce a sufficiently large pixel mask: " + JSON.stringify({
      maskSamples: indices.length,
      minimumMaskSamples,
    }));
  }
  return indices;
}

function buildViewportMaskFailureDiagnostics(before, after, aPixelMask, bPixelMask) {
  const beforeBitmap = parsePng(before.png);
  const afterBitmap = parsePng(after.png);
  if (
    beforeBitmap.width !== afterBitmap.width ||
    beforeBitmap.height !== afterBitmap.height ||
    beforeBitmap.width !== before.bitmapWidth ||
    beforeBitmap.height !== before.bitmapHeight ||
    afterBitmap.width !== after.bitmapWidth ||
    afterBitmap.height !== after.bitmapHeight ||
    before.stride !== after.stride ||
    before.signature.length !== after.signature.length
  ) {
    throw new Error("Cannot map viewport mask diagnostics across different bitmap geometry.");
  }
  const stride = before.stride;
  const sampleColumns = Math.ceil(beforeBitmap.width / stride);
  const sampleRows = Math.ceil(beforeBitmap.height / stride);
  const sampleCount = sampleColumns * sampleRows;
  if (sampleCount !== Math.floor(before.signature.length / 3)) {
    throw new Error("Viewport mask diagnostics do not match the sampled pixel signature.");
  }
  const aIndices = aPixelMask.slice();
  const bIndices = bPixelMask.slice();
  const bIndexSet = new Set(bIndices);
  const aIndexSet = new Set(aIndices);
  const intersection = aIndices.filter((index) => bIndexSet.has(index));
  const aExclusive = aIndices.filter((index) => !bIndexSet.has(index));
  const bExclusive = bIndices.filter((index) => !aIndexSet.has(index));
  const canvasRect = before.viewportState?.canvasRect ?? null;
  const canvas = {
    bitmapWidth: beforeBitmap.width,
    bitmapHeight: beforeBitmap.height,
    cssRect: canvasRect,
    devicePixelRatio: before.viewportState?.devicePixelRatio ?? null,
  };
  const changedEntries = (indices) => {
    const entries = [];
    for (const sampleIndex of indices) {
      if (!Number.isInteger(sampleIndex) || sampleIndex < 0 || sampleIndex >= sampleCount) {
        throw new Error(`Viewport mask contains an invalid sample index: ${sampleIndex}.`);
      }
      const column = sampleIndex % sampleColumns;
      const row = Math.floor(sampleIndex / sampleColumns);
      const bitmapX = column * stride;
      const bitmapY = row * stride;
      const offset = (bitmapY * beforeBitmap.width + bitmapX) * 4;
      const rgbaBefore = Array.from(beforeBitmap.rgba.slice(offset, offset + 4));
      const rgbaAfter = Array.from(afterBitmap.rgba.slice(offset, offset + 4));
      const deltaL1 =
        Math.abs(rgbaBefore[0] - rgbaAfter[0]) +
        Math.abs(rgbaBefore[1] - rgbaAfter[1]) +
        Math.abs(rgbaBefore[2] - rgbaAfter[2]);
      // Match the existing RGB sample-delta cutoff; this records pixels without changing the assertion.
      if (deltaL1 <= 18) continue;
      entries.push({
        bitmapPixel: { x: bitmapX, y: bitmapY },
        canvasCssPixel: canvasRect
          ? {
              x: canvasRect.left + ((bitmapX + 0.5) / beforeBitmap.width) * canvasRect.width,
              y: canvasRect.top + ((bitmapY + 0.5) / beforeBitmap.height) * canvasRect.height,
            }
          : null,
        column,
        deltaL1,
        rgbaAfter,
        rgbaBefore,
        row,
        sampleIndex,
      });
    }
    return entries;
  };
  const allSamples = Array.from({ length: sampleCount }, (_, sampleIndex) => sampleIndex);
  return {
    canvas,
    coordinateMapping: [
      "sampleIndex = row * sampleColumns + column;",
      "bitmap x/y = column/row * stride;",
      "CSS pixel maps the bitmap pixel center through canvas cssRect.",
    ].join(" "),
    masks: {
      a: aIndices,
      aExclusive,
      b: bIndices,
      bExclusive,
      intersection,
    },
    sampleGrid: {
      columns: sampleColumns,
      rows: sampleRows,
      stride,
      totalSamples: sampleCount,
    },
    changedSamples: {
      allViewport: changedEntries(allSamples),
      a: changedEntries(aIndices),
      aExclusive: changedEntries(aExclusive),
      b: changedEntries(bIndices),
      bExclusive: changedEntries(bExclusive),
      intersection: changedEntries(intersection),
    },
  };
}

function viewportPixelDeltaOnMask(before, after, mask, options = {}) {
  let changedPixels = 0;
  for (const sampleIndex of mask) {
    const offset = sampleIndex * 3;
    const delta =
      Math.abs(before.signature[offset] - after.signature[offset]) +
      Math.abs(before.signature[offset + 1] - after.signature[offset + 1]) +
      Math.abs(before.signature[offset + 2] - after.signature[offset + 2]);
    if (delta > 18) changedPixels += 1;
  }
  const minimumChangedPixels = options.minimumChangedPixels ?? 21;
  return {
    changed: changedPixels >= minimumChangedPixels,
    changedPixels,
    maskSamples: mask.length,
    minimumChangedPixels,
  };
}

async function assertViewportPixelDeltaOnMask(page, before, after, mask, label, options = {}) {
  const delta = viewportPixelDeltaOnMask(before, after, mask, options);
  const shouldChange = options.shouldChange ?? false;
  const passed = shouldChange ? delta.changed : !delta.changed;
  if (passed) return delta;
  await captureViewportComparisonFailure(page, label, before, after, {
    delta,
    shouldChange,
    ...(options.failureDiagnostics ? { pixelMaskDiagnostics: options.failureDiagnostics } : {}),
  });
  throw new Error(label + " violated the masked pixel contract: " + JSON.stringify({
    delta,
    shouldChange,
  }));
}

async function readFEMPartNodeSupport(page, partId) {
  return page.evaluate((id) => {
    const snapshot = window.__FULLMAG_CONTROL_ROOM_AUDIT__?.readViewportAuditResource?.(
      "/v2/sessions/current/meshing/meshes/shared-domain/manifest",
    );
    const part = snapshot?.data?.mesh_parts?.find((entry) => entry.id === id);
    return {
      emptyNodeMembership: snapshot?.status === "ready" && part?.node_count === 0 &&
        (part.node_indices === undefined ||
          (Array.isArray(part.node_indices) && part.node_indices.length === 0)),
      manifestRevision: snapshot?.revision ?? null,
      nodeCount: part?.node_count ?? null,
      nodeIndices: part?.node_indices ?? null,
      nodeStart: part?.node_start ?? null,
      partId: id,
    };
  }, partId);
}

async function readObjectVisualizationSettings(page, objectId) {
  return page.evaluate((id) => {
    const audit = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
    // The renderer resolves persisted overrides together with controller
    // preferences. Raw controller defaults alone are not the object settings.
    const state = audit?.readViewportAuditResource?.("/v2/sessions/current/visualization/state");
    return state?.status === "ready"
      ? state.data?.overrides?.find((override) =>
          override.scope === "object" && override.scope_id === id) ?? null
      : null;
  }, objectId);
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

async function waitForRenderedViewportFrame(page) {
  await waitForAnimationFrame(page);
  await waitForAnimationFrame(page);
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

async function waitForFieldRequestCount(fixture, expected, count) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (countFieldRequests(fixture, expected) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for field request count ${count}: ${JSON.stringify({
      actual: countFieldRequests(fixture, expected),
      expected,
      requests: fixture.fieldRequests,
    })}`,
  );
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

async function waitForFdmFieldResource(page, quantityId, targetPart = null) {
  return page.waitForFunction(({ quantity, targetPart: expectedPart }) => {
    const audit = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
    const requestPath = `/data/fields/${encodeURIComponent(quantity)}/samples/vector?`;
    const matchingKeys = Object.keys(
      audit?.readViewportAuditRuntime?.().listenerCounts ?? {},
    ).filter((candidate) => {
      if (
        expectedPart &&
        !candidate.includes("#viewport-3d:part-field-vectors:")
      ) {
        return false;
      }
      let requestOffset = candidate.indexOf(requestPath);
      if (requestOffset < 0) return false;
      if (!expectedPart) return true;

      while (requestOffset >= 0) {
        const queryStart = requestOffset + requestPath.length;
        const queryEnd = candidate.indexOf("|", queryStart);
        const query = new URLSearchParams(
          candidate.slice(queryStart, queryEnd < 0 ? undefined : queryEnd),
        );
        if (
          query.get("component") === expectedPart.component &&
          query.get("scope_id") === expectedPart.partId &&
          query.get("scope_kind") === expectedPart.scopeKind
        ) {
          return true;
        }
        if (queryEnd < 0) break;
        requestOffset = candidate.indexOf(requestPath, queryEnd + 1);
      }
      return false;
    });
    const key = matchingKeys[0];
    if (!key) return null;
    const resource = audit?.readViewportAuditResource?.(key);
    if (!resource || resource.status === "loading") return null;
    if (expectedPart) {
      const partEnvelopes = resource.data;
      const hasTargetPart =
        partEnvelopes instanceof Map &&
        partEnvelopes.has(expectedPart.partId);
      const payload = hasTargetPart
        ? partEnvelopes.get(expectedPart.partId)?.data
        : null;
      return {
        hasTargetPart,
        hasValues: Boolean(payload?.values?.length),
        key,
        status: resource.status,
        targetPartId: expectedPart.partId,
      };
    }
    const payload = resource.data?.data?.values ? resource.data.data : resource.data;
    return { hasValues: Boolean(payload?.values?.length), key, status: resource.status };
  }, { quantity: quantityId, targetPart }, { timeout: timeoutMs }).then((handle) => handle.jsonValue());
}

async function waitForFdmFullFieldPayload(page, quantityId, expected = {}) {
  return page.waitForFunction(({ quantity, etag, values }) => {
    const audit = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
    const path = `/data/fields/${encodeURIComponent(quantity)}/samples/vector?`;
    const keys = Object.keys(audit?.readViewportAuditRuntime?.().listenerCounts ?? {});
    for (const key of keys) {
      if (key.includes("#viewport-3d:")) continue;
      const offset = key.indexOf(path);
      if (offset < 0) continue;
      const query = new URLSearchParams(key.slice(offset + path.length));
      if (query.get("scope_kind") !== "full" || query.get("component") !== "full") continue;
      const snapshot = audit?.readViewportAuditResource?.(key);
      const envelope = snapshot?.data;
      const payload = envelope?.data;
      if (snapshot?.status !== "ready" || !payload?.values?.length) continue;
      if (etag && envelope.etag !== etag) continue;
      const actualValues = Array.from(payload.values);
      if (values && (actualValues.length !== values.length ||
        actualValues.some((value, index) => value !== values[index]))) continue;
      return { etag: envelope.etag, hasValues: true, key,
        pointCount: payload.pointCount, resourceRevision: snapshot.revision,
        status: snapshot.status, values: actualValues };
    }
    return null;
  }, { quantity: quantityId, ...expected }, { timeout: timeoutMs })
    .then((handle) => handle.jsonValue());
}

async function invalidateFieldResource(page, resourceKey, reason = "smoke-recovery") {
  await page.evaluate(({ key, reasonPrefix }) => {
    const audit = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
    if (typeof audit?.invalidateResource !== "function") {
      throw new Error("Missing browser-audit resource invalidation hook.");
    }
    audit.invalidateResource(key, reasonPrefix + ":" + Date.now());
  }, { key: resourceKey, reasonPrefix: reason });
}

function attachBrowserErrors(page) {
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
function assertNoBrowserErrors(errors) { if (errors.length) throw new Error(`Browser errors:\n${errors.join("\n")}`); }

function attachBrowserNetworkDiagnostics(page) {
  const diagnostics = { apiRequests: [], failedRequests: [], failedResponses: [] };
  const retain = (items, item) => {
    items.push(item);
    if (items.length > 80) items.shift();
  };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/v2/")) {
      retain(diagnostics.apiRequests, { method: request.method(), path: url.pathname });
    }
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/v2/")) {
      retain(diagnostics.failedRequests, {
        failure: request.failure()?.errorText ?? null,
        method: request.method(),
        path: url.pathname,
      });
    }
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/v2/") && response.status() >= 400) {
      retain(diagnostics.failedResponses, {
        method: response.request().method(),
        path: url.pathname,
        status: response.status(),
      });
    }
  });
  return diagnostics;
}

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
  // Keep the realized topology provenance stable while visualization patches
  // invalidate and reload resources.  Without a source-scene revision the
  // Inspector correctly enters its fail-closed edge-only safety view during a
  // transient manifest refresh, which would make the smoke select a disabled
  // surface-color control even though the FDM carrier itself is current.
  fixture.manifest = {
    generation_id: "1",
    mesh_parts: [],
    regions: [],
    revision: 1,
    source_scene_revision: 1,
    topology_fingerprint: "0".repeat(64),
  };
  validateFdmTargetFixture(fixture);
  return fixture;
}

function createFemFixture() {
  const objects = ["fem-owned", "fem-fallback"].map((id, index) => ({
    geometry: { geometry_params: { size: [0.5, 0.5, 0.5] }, kind: "box" },
    id,
    regions: [],
    // Keep the primitive-only fallback outside the realized tetrahedral
    // carrier; otherwise hiding it changes only the few front-most pixels
    // that are not occluded by the owned FEM surface.
    transform: { translation: [index === 0 ? 0 : -0.5, 0, 0] },
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

function createEmptyPartColorFixture() {
  const objects = ["fem-empty", "fem-visible"].map((id) => ({
    geometry: { geometry_params: { size: [1, 1, 1] }, kind: "box" },
    id,
    regions: [],
    transform: { translation: [0, 0, 0] },
    visible: true,
  }));
  const fixture = baseFixture("fem", objects);
  const quantityId = "H_eff";
  const boundsMin = [-0.55, -0.45, -0.15];
  const boundsMax = [0.45, 0.55, 1.55];
  fixture.status.display.active_quantity_id = quantityId;
  fixture.status.domain.cell_count = 2;
  fixture.domain.bounds = { max: boundsMax, min: boundsMin };
  fixture.domain.counts = { cells: 2, nodes: 8 };
  fixture.universe.object_bounds_max = boundsMax;
  fixture.universe.object_bounds_min = boundsMin;
  fixture.visualization.active_quantity_id = quantityId;
  fixture.visualization.quantity.active_quantity_id = quantityId;
  fixture.visualization.overrides = objects.map(({ id }) => ({
    display: {
      surface: { visible: true },
      vectors: { visible: false },
      wireframe: { visible: false },
    },
    quantity: { active_quantity_id: quantityId },
    scope: "object",
    scope_id: id,
    style: {
      scalar_color_palette: "viridis",
      surface_color_source: "solid",
      surface_mono_color: "rgb(240, 24, 24)",
      surface_projection_mode: "thickness_average_z",
      viewport_colorbar_visible: false,
    },
  }));
  fixture.visualizationPatchReducer = applyFixtureVisualizationTargetPatch;
  fixture.fieldMode = "ready";
  fixture.fieldMetaFactory = (fieldQuantityId) => ({
    components: ["x", "y", "z"],
    quantity_id: fieldQuantityId,
    stats: { max: 1_000_000, min: 0 },
    unit: fieldQuantityId === "m" ? "1" : "A/m",
  });
  fixture.fieldVectorFactory = (fieldQuantityId) =>
    femEmptyPartColorFieldVectorBuffer(fieldQuantityId);
  fixture.emptyPartFieldResponses = [];
  fixture.fullDomainFieldResponses = [];
  fixture.fullFieldRevision = 1;
  fixture.scopedFieldRevisions = {
    "part-empty-range": 1,
    "part-visible": 1,
  };
  fixture.scopedFieldMagnitudes = [1, 2, 3, 4, 1_000, 10_000, 100_000, 1_000_000];
  fixture.scopedNodeValue = (nodeIndex) => [
    fixture.scopedFieldMagnitudes[nodeIndex], 0, 0,
  ];
  fixture.manifest = {
    generation_id: "1",
    mesh_parts: [
      {
        boundary_face_count: 4,
        boundary_face_indices: [0, 1, 2, 3],
        boundary_face_start: 0,
        bounds_max: [0.45, 0.55, 0.55],
        bounds_min: [-0.55, -0.45, -0.15],
        element_count: 1,
        element_start: 0,
        id: "part-empty-range",
        node_count: 0,
        node_start: 4,
        object_id: "fem-empty",
        role: "magnetic",
        topology: "tet4",
      },
      {
        boundary_face_count: 4,
        boundary_face_indices: [4, 5, 6, 7],
        boundary_face_start: 4,
        bounds_max: [0.45, 0.55, 1.55],
        bounds_min: [-0.55, -0.45, 0.85],
        element_count: 1,
        element_start: 1,
        id: "part-visible",
        node_count: 4,
        node_start: 4,
        object_id: "fem-visible",
        role: "magnetic",
        topology: "tet4",
      },
    ],
    regions: [],
    revision: 1,
    source_scene_revision: 1,
    topology_fingerprint: "2".repeat(64),
  };
  fixture.topology = femEmptyPartColorTopologyBuffer();
  return fixture;
}

function baseFixture(discretization, objects) {
  return {
    fieldRequests: [], requests: [],
    status: { api_contract_version: "1.0.0", capabilities: { binary_fields: true, explicit_topology: discretization === "fem", node_fields: true, preview_3d: true, structured_grid: discretization === "fdm" }, display: { active_quantity_id: "m", view_mode: "3d" }, domain: { cell_count: discretization === "fdm" ? FDM_TARGET_GRID_CELL_COUNT : 8, discretization, generation_id: 1 }, energies: {}, metrics: {}, resources: { domain_generation_id: 1, field_catalog_revision: 1, field_revision: 1, fields_revision: 1, mesh_revision: 1, scene_revision: 1, topology_revision: 1, visualization_state_revision: 1 }, run: null, runtime_bundle_version: "browser-target-fixture", session: { created_at: "0", name: "browser target fixture", session_epoch: "browser-target-fixture@0", request_scope_epoch: "browser-target-fixture-instance:0", session_id: "browser-target-fixture", workspace_root: "/tmp" }, solver: { state: "idle" } },
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

function applyPatch(state, patch) {
  return mergeRecords(state, patch ?? {});
}

function applyFixtureVisualizationTargetPatch(state, patch) {
  if (typeof patch.scope !== "string" || typeof patch.scope_id !== "string") {
    const next = applyPatch(state, patch ?? {});
    next.revision += 1;
    return next;
  }
  const existing = state.overrides.find(
    (override) =>
      override.scope === patch.scope && override.scope_id === patch.scope_id,
  );
  const nextOverride = mergeRecords(existing ?? {}, patch);
  const overrides = state.overrides.filter(
    (override) =>
      override.scope !== patch.scope || override.scope_id !== patch.scope_id,
  );
  overrides.push(nextOverride);
  return { ...state, overrides, revision: state.revision + 1 };
}

function mergeRecords(current, patch) {
  const output = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const previous = output[key];
    output[key] =
      isPlainObject(previous) && isPlainObject(value)
        ? mergeRecords(previous, value)
        : value;
  }
  return output;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldAvailabilityFixture({ fixture, quantityId, query }) {
  const scopeKind = query.get("scope_kind") ?? "full";
  const scopeId = query.get("scope_id");
  const targetId = query.get("target_id") ?? (scopeKind === "airbox" ? "airbox" : scopeId ?? "full");
  const materialized = fixture.fieldMode !== "empty";
  return {
    carrier_id: materialized ? `fixture:${fixture.discretization}:${scopeKind}:${scopeId ?? "full"}` : null,
    generation: String(fixture.domain.generation_id ?? 1),
    pending: false,
    quantity_id: quantityId,
    reason_code: materialized ? null : "target_carrier_missing",
    revision: 1,
    scope_id: scopeId,
    scope_kind: scopeKind,
    state: materialized ? "ready" : "supported",
    supported: true,
    target_id: targetId,
    materialized,
  };
}
function fieldCatalogFixture() { return { domain_generation_id: "1", quantities: ["m", "H_eff", "H_demag", "H_ext"].map((quantity_id) => ({ available: true, components: 3, domain: "full_domain", domain_generation_id: "1", field_revision: 1, kind: "vector", label: quantity_id === "m" ? "Magnetization" : quantity_id === "H_eff" ? "Effective field" : quantity_id === "H_ext" ? "External field" : "Demag field", location: "nodes", materialization_wall_time_ns: 0, materialized_at_unix_ms: 1, quantity_id, source_revision: 1, source_step: 0, spatial: true, stale_by_steps: 0, state: "complete", ui_exposed: true, unit: quantity_id === "m" ? "1" : "A/m" })), revision: 1 }; }
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

function fdmScopedFieldVectorBuffer({ fieldRequest, fixture, nodeIndices = null }) {
  const cellIndices = nodeIndices ?? (fixture.fdmMembership
    ? resolveFdmScopedCellIndices({ fieldRequest, fixture })
    : fieldRequest.scopeKind === "airbox"
      ? [4, 5, 6, 7]
      : [0, 1, 2, 3]);
  const encoder = new TextEncoder();
  const scopeKindBytes = encoder.encode(fieldRequest.scopeKind ?? "full");
  const resolvedScopeId =
    fieldRequest.scopeKind === "airbox" && fieldRequest.scopeId === null
      ? "airbox"
      : fieldRequest.scopeId ?? "";
  const scopeIdBytes = encoder.encode(resolvedScopeId);
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
    if (nodeIndices && fixture.scopedNodeValue) {
      values.set(fixture.scopedNodeValue(cellIndex), point * 3);
    } else if (fieldRequest.quantityId === "H_eff") {
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
        scopeId: resolvedScopeId,
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

function femEmptyPartColorTopologyBuffer() {
  const nodeCount = 8;
  const elementCount = 2;
  const boundaryFaceCount = 8;
  const buffer = new ArrayBuffer(
    32 +
      nodeCount * 3 * Float64Array.BYTES_PER_ELEMENT +
      elementCount * 4 * Uint32Array.BYTES_PER_ELEMENT +
      boundaryFaceCount * 3 * Uint32Array.BYTES_PER_ELEMENT +
      elementCount * 2 * Uint32Array.BYTES_PER_ELEMENT,
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
    -0.55, -0.45, -0.15,
    0.45, -0.45, -0.15,
    -0.55, 0.55, -0.15,
    -0.55, -0.45, 0.55,
    -0.55, -0.45, 0.85,
    0.45, -0.45, 0.85,
    -0.55, 0.55, 0.85,
    -0.55, -0.45, 1.55,
  ]);
  offset += nodeCount * 3 * Float64Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, elementCount * 4).set([
    0, 1, 2, 3,
    4, 5, 6, 7,
  ]);
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

function femEmptyPartColorFieldVectorBuffer(quantityId, magnitudes = [1, 2, 3, 4, 1_000, 10_000, 100_000, 1_000_000]) {
  const pointCount = 8;
  const componentCount = 3;
  const buffer = new ArrayBuffer(
    48 + pointCount * componentCount * Float64Array.BYTES_PER_ELEMENT,
  );
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMVP"].entries()) view.setUint8(index, code.charCodeAt(0));
  view.setUint8(4, 2);
  view.setUint8(5, 1);
  view.setUint8(6, componentCount);
  view.setUint32(12, pointCount * componentCount, true);
  view.setUint32(16, pointCount, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, 1, true);
  new TextEncoder().encodeInto(quantityId, new Uint8Array(buffer, 28, 16));
  const values = new Float64Array(buffer, 48);
  for (let point = 0; point < pointCount; point += 1) {
    values[point * componentCount] = magnitudes[point];
    values[point * componentCount + 1] = 0;
    values[point * componentCount + 2] = 0;
  }
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


