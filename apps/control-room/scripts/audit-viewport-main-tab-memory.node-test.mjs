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
});

test("fails inactive-tab proof on any 3D request, render measure, canvas, or acknowledgement", () => {
  assert.match(script, /threeDRequests\.length > 0/);
  assert.match(script, /viewport3DRenderMeasuresDelta > 0/);
  assert.match(script, /canvasCount > 0/);
  assert.match(script, /clientAckRequestsDelta > 0/);
  assert.match(script, /\bpass,\n/);
});
