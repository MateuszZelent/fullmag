import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { assertPlanarEvidenceReady } from "./lib/planar-field-evidence.mjs";

const source = await readFile(
  new URL("./smoke-viewport-2d.mjs", import.meta.url),
  "utf8",
);

const expected = {
  component: "magnitude",
  operatorKind: "slab_average",
  quantityId: "m",
  sourceId: "xy-slab",
  sourceKind: "monitor",
};

const meta = {
  etag: '"fm-planar-sha256:current"',
  field_revision: 18,
  source: {
    kind: "monitor",
    monitor_hash: "sha256:monitor-current",
    monitor_id: "xy-slab",
    monitor_revision: 27,
  },
};

function readyEvidence(overrides = {}) {
  return {
    component: expected.component,
    fieldRevision: meta.field_revision,
    glyphCount: 64,
    metaIdentity: meta.etag,
    operatorKind: expected.operatorKind,
    operatorRevision: meta.source.monitor_revision,
    overlayCounts: { contours: 12, meshSegments: 48 },
    quantityId: expected.quantityId,
    raster: { checksum: "fnv1a32:deadbeef", max: 1, min: 0, sampleCount: 4 },
    scalarIdentity: meta.etag,
    sourceHash: meta.source.monitor_hash,
    sourceId: expected.sourceId,
    sourceKind: expected.sourceKind,
    sourceRevision: meta.source.monitor_revision,
    status: "ready",
    ...overrides,
  };
}

test("2D smoke binds pass state to browser-consumed ready evidence", () => {
  assert.match(source, /page\.on\("response", async \(response\)/);
  assert.match(source, /assertPlanarEvidenceReady/);
  assert.match(source, /assertPlanarEvidenceReady\(value, expected, matchingMeta\)/);
  assert.match(source, /source: \{ kind: "monitor", monitor_id: monitorId \}/);
  assert.doesNotMatch(source, /active_monitor_id/);
  assert.match(
    source,
    /smokeEvidence\.every\(\(evidence\) => evidence\.status === "ready"\)/,
  );
  assert.doesNotMatch(source, /pass: true/);
});

test("2D smoke has a typed Default-source lane with full frame and operator coverage", () => {
  assert.match(source, /CONTROL_ROOM_PLANAR_SOURCE_KIND/);
  assert.match(source, /runDefaultSliceSmoke/);
  assert.match(source, /defaultPlane/);
  assert.match(source, /positionFraction/);
  assert.match(source, /resolvedCoordinateM/);
  assert.match(source, /slab_average/);
  assert.match(source, /planar-default/);
  assert.match(source, /createAuthoredMonitor/);
  assert.match(source, /async function postJson\(resourcePath, body\)/);
  assert.doesNotMatch(source, /import assert from "node:assert\/strict"/);
  assert.doesNotMatch(source, /bounds_uv_m: undefined/);
  assert.match(source, /render_png/);
  assert.match(source, /default-vs-monitor/);
  assert.doesNotMatch(source, /waitForDefaultControls/);
  assert.doesNotMatch(source, /getByLabel\("Source"/);
  assert.doesNotMatch(source, /getByLabel\("Sampling"/);
});

test("2D smoke rejects an old painted raster while the new sample is loading", () => {
  assert.throws(
    () =>
      assertPlanarEvidenceReady(
        readyEvidence({
          metaIdentity: '"fm-planar-sha256:new"',
          scalarIdentity: '"fm-planar-sha256:old"',
          status: "loading",
        }),
        expected,
        { ...meta, etag: '"fm-planar-sha256:new"' },
      ),
    /status loading/,
  );
});

test("2D smoke rejects divergent scalar and meta identities", () => {
  assert.throws(
    () =>
      assertPlanarEvidenceReady(
        readyEvidence({ scalarIdentity: '"fm-planar-sha256:stale"' }),
        expected,
        meta,
      ),
    /scalar identity mismatch/,
  );
});

test("2D smoke rejects evidence from the wrong planar source variant", () => {
  assert.throws(
    () =>
      assertPlanarEvidenceReady(
        readyEvidence({ sourceKind: "default", sourceId: "default" }),
        expected,
        meta,
      ),
    /source kind mismatch|sourceKind mismatch|source mismatch/,
  );
});

test("2D smoke accepts only fully bound renderer evidence", () => {
  assert.deepEqual(assertPlanarEvidenceReady(readyEvidence(), expected, meta), readyEvidence());
});

test("2D smoke captures each legal layer and a terminal 3D lifecycle proof", () => {
  for (const layer of ["raster", "contours", "mesh", "boundaries", "vectors", "probes"]) {
    assert.match(source, new RegExp(`id: "${layer}"`));
  }
  assert.match(source, /readPlanarWorkerSnapshot/);
  assert.match(source, /created - workerBaseline\.created/);
  assert.match(source, /terminated - workerBaseline\.terminated/);
  assert.match(source, /final_webgl/);
  assert.match(source, /drawingBufferWidth/);
  assert.match(source, /qualification_cases/);
  assert.match(source, /gitHead/);
  assert.match(source, /runtime_bundle_identity/);
});

test("2D smoke qualifies points from occupied evaluation-bin centers without relabelling mesh", () => {
  assert.match(source, /id: "points"/);
  assert.match(source, /evidence\.overlayCounts\.pointMarkers > 0/);
  assert.doesNotMatch(source, /points:\s*"mesh"/);
});

test("2D smoke qualifies meta frame bounds separately from the 3D frame proof", () => {
  assert.match(source, /id: "bounds"/);
  assert.match(source, /evidence\.overlayCounts\.boundsSegments === 4/);
  assert.doesNotMatch(source, /unsupported_required_layers/);
  assert.match(source, /planar-frame-preview-3d\.png/);
});

test("2D smoke exits nonzero after writing a blocked qualification report", () => {
  assert.match(source, /if \(!report\.pass\)/);
  assert.match(source, /qualification is blocked/);
});

test("2D smoke binds browser pass to the fail-closed science report", () => {
  assert.match(source, /readScienceReport/);
  assert.match(source, /scienceReport\.pass === true/);
  assert.match(source, /scienceReport\.head === currentGitHead/);
  assert.match(source, /scienceReport\.runtime_bundle_identity/);
  assert.match(source, /scienceReport\.qualification_complete === true/);
});
