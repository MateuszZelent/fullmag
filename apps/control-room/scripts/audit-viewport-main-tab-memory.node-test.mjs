import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const script = await readFile(
  new URL("./audit-viewport-main-tab-memory.mjs", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const { assertActiveThreeDObservation, assertInactiveTabObservation } = await import(
  "./audit-viewport-main-tab-memory.mjs"
);

test("registers the active viewport-main tab memory audit", () => {
  assert.equal(
    packageJson.scripts["audit:viewport-main-tab-memory"],
    "node scripts/audit-viewport-main-tab-memory.mjs",
  );
});

test("audits every registered heavy center tab and the 3D-only lifecycle signals", () => {
  for (const moduleId of [
    "viewport-3d",
    "field-map",
    "analysis-plots",
    "live-charts",
  ]) {
    assert.match(script, new RegExp(moduleId));
  }
  assert.match(script, /data-slot-id=\\?"viewport-main/);
  assert.match(script, /fm-viewport-3d canvas/);
  assert.match(script, /Viewport3DModule/);
  assert.match(script, /client-acks/);
  assert.match(script, /performance\.memory|Runtime\.getHeapUsage/);
  assert.match(script, /canvasRootConfigureStarted/);
  assert.match(script, /canvasContextsCreated/);
  assert.match(script, /viewportFrameReasons/);
  assert.match(script, /resourceCounts/);
  assert.match(script, /contextLosses/);
  assert.match(script, /raw_counters/);
  assert.match(script, /raw_reasons/);
});

test("fails inactive-tab proof on any 3D request, render measure, canvas, or acknowledgement", () => {
  assert.match(script, /threeDRequests\.length > 0/);
  assert.match(script, /viewport3DRenderMeasuresDelta > 0/);
  assert.match(script, /canvasCount > 0/);
  assert.match(script, /clientAckRequestsDelta > 0/);
  assert.match(script, /workerJobsDelta > 0/);
  assert.match(script, /viewportFramesDelta > 0/);
  assert.match(script, /\bpass,\n/);
});

test("fails closed for leaked workers or RAFs, reason overflow, and frames without reasons", () => {
  const baseline = {
    activeModuleId: "field-map",
    canvasCount: 0,
    clientAckRequestsDelta: 0,
    contextLossesDelta: 0,
    moduleId: "field-map",
    pendingAnimationFrames: 0,
    resourceCounts: {
      geometries: 0,
      materials: 0,
      renderTargets: 0,
      textures: 0,
      workers: 0,
    },
    rootCount: 0,
    threeDRequests: [],
    viewport3DRenderMeasuresDelta: 0,
    viewportFrameReasonsDelta: {},
    viewportFrameReasonsDroppedDelta: 0,
    viewportFrameReasonsOverflowed: false,
    viewportFramesDelta: 0,
    workerInstances: 0,
    workerJobsDelta: 0,
  };
  assert.doesNotThrow(() => assertInactiveTabObservation({ ...baseline }));
  for (const patch of [
    { pendingAnimationFrames: 1 },
    { workerInstances: 1 },
    {
      resourceCounts: {
        geometries: 0,
        materials: 0,
        renderTargets: 0,
        textures: 1,
        workers: 0,
      },
    },
    { viewportFrameReasonsOverflowed: true },
    { viewportFramesDelta: 1 },
  ]) {
    assert.throws(() => assertInactiveTabObservation({ ...baseline, ...patch }));
  }
});

test("fails active 3D proof when a committed frame has no exact frame-commit evidence", () => {
  const activeBaseline = {
    canvasContextsCreatedDelta: 0,
    canvasEventConnectionsDelta: 0,
    canvasRootConfigureCompletedDelta: 0,
    canvasRootConfigureStartedDelta: 0,
    canvasCount: 1,
    contextLossesDelta: 0,
    gpuUploadBytesDelta: 0,
    rootCount: 1,
    topologyBuildsDelta: 0,
    transitionLatencyMs: 0,
    viewportFrameReasonsDelta: { "frame-commit": 1 },
    viewportFrameReasonsDroppedDelta: 0,
    viewportFrameReasonsOverflowed: false,
    viewportFramesDelta: 1,
  };
  const budgets = {
    maxReopenGpuUploadBytes: 1,
    maxReopenLatencyMs: 1,
    maxReopenTopologyBuilds: 1,
  };

  assert.doesNotThrow(() => assertActiveThreeDObservation(activeBaseline, budgets));
  assert.throws(() =>
    assertActiveThreeDObservation(
      { ...activeBaseline, viewportFrameReasonsDelta: {} },
      budgets,
    ),
  );
  assert.throws(() =>
    assertActiveThreeDObservation(
      {
        ...activeBaseline,
        viewportFrameReasonsDelta: { "frame-commit": 2 },
      },
      budgets,
    ),
  );
});
