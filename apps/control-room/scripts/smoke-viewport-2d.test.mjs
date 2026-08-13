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
  monitorId: "xy-slab",
  operatorKind: "slab_average",
  quantityId: "m",
};

const meta = {
  etag: '"fm-planar-sha256:current"',
  field_revision: 18,
  monitor_hash: "sha256:monitor-current",
  monitor_revision: 27,
};

function readyEvidence(overrides = {}) {
  return {
    component: expected.component,
    fieldRevision: meta.field_revision,
    glyphCount: 64,
    metaIdentity: meta.etag,
    monitorHash: meta.monitor_hash,
    monitorId: expected.monitorId,
    monitorRevision: meta.monitor_revision,
    operatorKind: expected.operatorKind,
    operatorRevision: meta.monitor_revision,
    overlayCounts: { contours: 12, meshSegments: 48 },
    quantityId: expected.quantityId,
    raster: { checksum: "fnv1a32:deadbeef", max: 1, min: 0, sampleCount: 4 },
    scalarIdentity: meta.etag,
    status: "ready",
    ...overrides,
  };
}

test("2D smoke binds pass state to browser-consumed ready evidence", () => {
  assert.match(source, /page\.on\("response", async \(response\)/);
  assert.match(source, /assertPlanarEvidenceReady/);
  assert.match(source, /assertPlanarEvidenceReady\(value, expected, matchingMeta\)/);
  assert.match(
    source,
    /pass: smokeEvidence\.every\(\(evidence\) => evidence\.status === "ready"\)/,
  );
  assert.doesNotMatch(source, /pass: true/);
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

test("2D smoke accepts only fully bound renderer evidence", () => {
  assert.deepEqual(assertPlanarEvidenceReady(readyEvidence(), expected, meta), readyEvidence());
});
