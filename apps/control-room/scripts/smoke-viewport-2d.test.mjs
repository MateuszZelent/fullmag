import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("./smoke-viewport-2d.mjs", import.meta.url),
  "utf8",
);

test("2D smoke binds pass state to browser-consumed ready evidence", () => {
  assert.match(source, /page\.on\("response", async \(response\)/);
  assert.match(source, /async function assertPlanarEvidence\(/);
  assert.match(source, /evidence\.status === "ready"/);
  assert.match(source, /matchingMeta\.etag !== value\.sampleIdentity/);
  assert.match(source, /matchingMeta\.field_revision !== value\.fieldRevision/);
  assert.match(
    source,
    /pass: smokeEvidence\.every\(\(evidence\) => evidence\.status === "ready"\)/,
  );
  assert.doesNotMatch(source, /pass: true/);
});

test("2D smoke records renderer telemetry rather than treating an old canvas as proof", () => {
  for (const attribute of [
    "monitorId",
    "operatorKind",
    "sampleIdentity",
    "fieldRevision",
    "glyphCount",
    "overlayCounts",
    "raster",
  ]) {
    assert.match(source, new RegExp(attribute));
  }
  const canvasProof = source.indexOf("const initialCanvas = await assertFieldMapCanvas(page)");
  const readyEvidence = source.indexOf("const initialEvidence = await assertPlanarEvidence(");
  assert.ok(canvasProof >= 0 && readyEvidence > canvasProof);
});
