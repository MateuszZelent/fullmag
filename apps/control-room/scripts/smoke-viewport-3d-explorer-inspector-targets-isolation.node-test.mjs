import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createSmokeMutationGuard } from "./lib/smoke-session-isolation.mjs";
import {
  assertScenarioHashesUnchanged,
  captureScenarioHashes,
} from "./smoke-viewport-3d-explorer-inspector-targets-isolation.mjs";

test("refuses CONTROL_ROOM_URL without a disposable fixture proof before any network preflight", async () => {
  await assert.rejects(
    createSmokeMutationGuard({
      apiBase: "http://127.0.0.1:8181",
      env: {},
      mutationRequired: true,
      pageUrl: "http://127.0.0.1:3199/workspace",
    }),
    /refuses to mutate an existing Control Room session/,
  );
});

test("allows an explicitly reused frontend only when all session traffic stays on the fixture origin", async () => {
  const source = await readFile(
    new URL("./smoke-viewport-3d-explorer-inspector-targets.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /CONTROL_ROOM_TARGET_SMOKE_REUSE_FRONTEND_ONLY/);
  assert.match(source, /apiBase !== "http:\/\/fullmag-target-smoke\.fixture\.invalid"/);
  assert.match(source, /mutationRequired: configuredUrl !== null && !reuseFixtureFrontendOnly/);
});

test("scenario hash guard detects any repository scenario rewrite", async () => {
  const directory = await mkdtemp("/tmp/fullmag-target-smoke-isolation-");
  const scenario = join(directory, "scenario.py");
  await writeFile(scenario, "study = 'before'\n");
  const before = await captureScenarioHashes([scenario]);
  await writeFile(scenario, "study = 'after'\n");
  await assert.rejects(
    assertScenarioHashesUnchanged(before),
    /Scenario file changed during target smoke/,
  );
});

test("target smoke always stops its runtime before restoring mutation state", async () => {
  const source = await readFile(
    new URL("./smoke-viewport-3d-explorer-inspector-targets.mjs", import.meta.url),
    "utf8",
  );
  const stopIndex = source.indexOf('await cleanup("isolated runtime stop"');
  const restoreIndex = source.indexOf('`restore disposable smoke script:');

  assert.match(source, /runtime = configuredUrl \? null : await startRuntime\(\)/);
  assert.match(source, /\["stop isolated Next runtime", \(\) => stopChild\(child\)\]/);
  assert.match(source, /\["remove isolated Next artifacts", \(\) => rm\(distPath/);
  assert.match(source, /\["restore generated Next configuration", \(\) => restoreGeneratedConfigSnapshot\(generatedConfigSnapshot\)\]/);
  assert.match(source, /catch \(error\) \{\s+await stop\(\);/);
  assert.ok(stopIndex >= 0 && restoreIndex > stopIndex);
  assert.match(source, /if \(removeMutationProcessGuards && mutationRestored\)/);
});

test("target smoke drains isolated Next stdout so the launcher cannot block on a full pipe", async () => {
  const source = await readFile(
    new URL("./smoke-viewport-3d-explorer-inspector-targets.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /child\.stdout\?\.on\("data"/);
});

test("target smoke terminates the detached runtime process group before removing artifacts", async () => {
  const source = await readFile(
    new URL("./smoke-viewport-3d-explorer-inspector-targets.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /detached: process\.platform !== "win32"/);
  assert.match(source, /process\.kill\(-child\.pid, signal\)/);
});

test("target smoke fixture validates a realized FDM outside-support mask", async () => {
  const source = await readFile(
    new URL("./smoke-viewport-3d-explorer-inspector-targets.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /const FDM_TARGET_GRID_SHAPE = \[8, 8, 8\]/);
  assert.match(source, /magnetic_support: \{/);
  assert.match(source, /function validateFdmTargetFixture\(fixture\)/);
  assert.match(source, /validateFdmTargetFixture\(fixture\)/);
});

test("target smoke proves every magnetic primary render mode with canvas pixels", async () => {
  const source = await readFile(
    new URL("./smoke-viewport-3d-explorer-inspector-targets.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /async function verifyPrimaryRenderModeCycle\(page, targetLabel\)/);
  assert.match(source, /for \(const mode of \["Wireframe", "Points", "Off", "Shaded"\]\)/);
  assert.match(source, /sampleViewportPixels\(page, 1\)/);
  assert.match(source, /minimumChangedPixels: 6/);
  assert.match(source, /target-smoke-fdm-success\.png/);
  assert.match(source, /target-smoke-fem-success\.png/);
  assert.match(source, /targetSmokePhase === "fem"/);
});

test("target smoke cannot report Airbox success after a missing vector pixel delta", async () => {
  const source = await readFile(
    new URL("./smoke-viewport-3d-explorer-inspector-targets.mjs", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /AIRBOX_DEBUG_DELTA_ERROR/);
  assert.match(source, /await waitForViewportPixelDelta\(page, airboxBefore, "Airbox vectors"/);
});

test("target smoke persists canvas-delta failure evidence", async () => {
  const source = await readFile(
    new URL("./smoke-viewport-3d-explorer-inspector-targets.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /async function captureViewportDeltaFailure\(page, label, payload\)/);
  assert.match(source, /target-smoke-\$\{slug\}-failure\.png/);
  assert.match(source, /target-smoke-\$\{slug\}-failure\.json/);
});

test("target smoke serializes Map-backed resource data in failure evidence", async () => {
  const source = await readFile(
    new URL("./smoke-viewport-3d-explorer-inspector-targets.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /function serializeViewportAuditValue\(value(?:, depth = 0)?\)/);
  assert.match(source, /value instanceof Map/);
  assert.match(source, /Array\.from\(value\.entries\(\)/);
  assert.match(source, /fieldResources: serializeViewportAuditValue\(resources\)/);
});

test("FEM fixture honors exact topology range requests", async () => {
  const source = await readFile(
    new URL("./smoke-viewport-3d-explorer-inspector-targets.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /async function fulfillTopology\(route, topology\)/);
  assert.match(source, /status: 206/);
  assert.match(source, /content-range/);
});

test("target smoke serves production-shaped scoped FDM FMVP v3 metadata", async () => {
  const source = await readFile(
    new URL("./smoke-viewport-3d-explorer-inspector-targets.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /function fdmScopedFieldVectorBuffer\(/);
  assert.match(source, /for \(const \[index, code\] of \[\.\.\."FMMI"\]\.entries\(\)\)/);
  assert.match(source, /view\.setUint8\(4, 3\)/);
  assert.match(source, /fieldRequest\.scopeKind === "full"/);
});

test("target smoke fixture acknowledges visualization patches and exposes target availability", async () => {
  const source = await readFile(
    new URL("./smoke-viewport-3d-explorer-inspector-targets.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /request\.method\(\) === "PATCH"/);
  assert.match(source, /fixture\.visualization\s*=\s*applyPatch\(fixture\.visualization/);
  assert.match(source, /data\/fields\/.*availability/);
  assert.match(source, /target_id|scope_kind|scope_id/);
});

test("target smoke waits for target display mutations before touching dependent controls", async () => {
  const source = await readFile(
    new URL("./smoke-viewport-3d-explorer-inspector-targets.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /async function waitForVisualizationMutationSettled\(page, panel\)/);
  assert.match(source, /await waitForVisualizationMutationSettled\(page, panel\)/);
  assert.match(source, /Saving display changes/);
});

test("target smoke waits for the Airbox geometry mutation before changing quantity", async () => {
  const source = await readFile(
    new URL("./smoke-viewport-3d-explorer-inspector-targets.mjs", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /async function setAirboxGeometryOff\(page\)[\s\S]*?waitForVisualizationMutationSettled\(page, page\.locator\("\.fm-inspector-panel"\)\.last\(\)\)/,
  );
});
