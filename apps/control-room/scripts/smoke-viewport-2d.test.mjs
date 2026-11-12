import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { assertPlanarEvidenceReady } from "./lib/planar-field-evidence.mjs";
import {
  PLANAR_TOOL_LABELS,
  REMOVED_CANVAS_CONTROL_LABELS,
  assertCroppedPlanarMeta,
  assertFullFramePlanarMeta,
  assertLayerFlagsUnchanged,
  assertLayerMoved,
  assertLegendCardCount,
  assertMigratedLayers,
  assertNodeReadoutHeading,
  assertPlanarToolbarSnapshot,
  assertTicksWithinRange,
  countPositionCommits,
  drawnFieldLayers,
  expectedMigratedLayers,
  frameIntervalWorldRange,
} from "./lib/planar-toolbar-smoke.mjs";

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

test("2D smoke drives the toolbar, crop, node inspector and field-layer scenarios", () => {
  for (const caseId of [
    "toolbar-six-tools",
    "toolbar-zoom-box",
    "toolbar-crop-window",
    "toolbar-inspect-node-",
    "toolbar-field-layer-list",
    "toolbar-vector-mask",
    "toolbar-section-slider",
    "toolbar-legacy-session-image",
  ]) {
    assert.match(source, new RegExp(caseId));
  }
  assert.match(source, /\.\.\.toolbarCases/);
  assert.match(source, /getByRole\("toolbar", \{ name: "2D view tools", exact: true \}\)/);
  assert.match(source, /data-planar-tool-overlay/);
  assert.match(source, /data-planar-node-readout='hover'/);
  assert.match(source, /data-planar-axis-tick/);
  assert.match(source, /data-planar-crop/);
  assert.match(source, /CONTROL_ROOM_PLANAR_LEGACY_FIXTURE/);
  assert.doesNotMatch(source, /2D view controls/);
});

test("toolbar snapshot requires the six tools in order and no removed canvas controls", () => {
  const snapshot = { tools: [...PLANAR_TOOL_LABELS], checked: ["Navigate"], removedHits: [] };
  assert.equal(assertPlanarToolbarSnapshot(snapshot), true);
  assert.throws(() => assertPlanarToolbarSnapshot({ ...snapshot, tools: snapshot.tools.slice(1) }), /2D view tools expose/);
  assert.throws(() => assertPlanarToolbarSnapshot({ ...snapshot, checked: [] }), /Exactly one canvas tool/);
  assert.throws(() => assertPlanarToolbarSnapshot({ ...snapshot, removedHits: ["Quantity"] }), /still rendered: Quantity/);
  assert.deepEqual([...REMOVED_CANVAS_CONTROL_LABELS], ["Quantity", "Scope", "Free section", "Single layer"]);
});

test("crop metadata must describe the clipped window with a new sample token", () => {
  const crop = { u_min_m: -3e-8, u_max_m: 1e-8, v_min_m: -1e-8, v_max_m: 1e-8 };
  const meta = {
    frame: { bounds_uv_m: [-2e-8, 1e-8, -1e-8, 1e-8], full_bounds_uv_m: [-2e-8, 2e-8, -2e-8, 2e-8] },
    sample_token: "planar-sample-v3:crop",
  };
  assert.deepEqual(assertCroppedPlanarMeta(meta, crop, "planar-sample-v3:full"), [-2e-8, 1e-8, -1e-8, 1e-8]);
  assert.throws(() => assertCroppedPlanarMeta(meta, crop, "planar-sample-v3:crop"), /kept the uncropped sample token/);
  assert.throws(
    () => assertCroppedPlanarMeta({ ...meta, frame: { ...meta.frame, bounds_uv_m: meta.frame.full_bounds_uv_m } }, crop, "x"),
    /differ from crop/,
  );
  assert.equal(assertFullFramePlanarMeta({ frame: { bounds_uv_m: [0, 1, 0, 1], full_bounds_uv_m: [0, 1, 0, 1] } }), true);
  assert.throws(() => assertFullFramePlanarMeta(meta), /not the full frame/);
});

test("axis ticks are checked against the crop's world range", () => {
  const frame = { origin_m: [1e-8, 0, 0], u_axis: [1, 0, 0], v_axis: [0, 0, -1] };
  assert.deepEqual(frameIntervalWorldRange(frame, "u", -1e-8, 1e-8), [0, 2e-8]);
  assert.deepEqual(frameIntervalWorldRange(frame, "v", 0, 1e-8), [-1e-8, 0]);
  assert.equal(assertTicksWithinRange([0, 1e-8, 2e-8], [0, 2e-8], "Horizontal"), true);
  assert.throws(() => assertTicksWithinRange([0, 3e-8], [0, 2e-8], "Horizontal"), /fall outside the crop/);
  assert.throws(() => assertTicksWithinRange([1e-8], [0, 2e-8], "Vertical"), /fewer than two ticks/);
});

test("node readout headings name FEM nodes and FDM cell centres", () => {
  assert.equal(assertNodeReadoutHeading("film · m · node 18,204", "fem"), true);
  assert.equal(assertNodeReadoutHeading("All objects · m · cell 42", "fdm"), true);
  assert.throws(() => assertNodeReadoutHeading("film · m · cell 3", "fem"), /node number/);
  assert.throws(() => assertNodeReadoutHeading("film · m", "fdm"), /cell number/);
});

test("legend cards follow the visible layers that draw, and masks keep layer flags", () => {
  const planar = {
    layers: { raster: true, vectors: false },
    field_overlays: [
      { id: "object:film", visible: true, raster_visible: true },
      { id: "airbox", visible: false, raster_visible: true },
      { id: "all", visible: true, raster_visible: false, vectors_visible: true },
    ],
  };
  assert.deepEqual(drawnFieldLayers(planar).map((layer) => layer.id), ["object:film"]);
  assert.equal(assertLegendCardCount(planar, 1), 1);
  assert.throws(() => assertLegendCardCount(planar, 3), /3 cards for 1 visible/);
  assert.equal(assertLegendCardCount({ ...planar, viewport_colorbar_visible: false }, 0), 0);
  assert.equal(assertLayerMoved(["a", "b", "c"], ["a", "c", "b"], "c", 1), true);
  assert.throws(() => assertLayerMoved(["a", "b", "c"], ["c", "a", "b"], "c", 1), /Layer order/);
  assert.equal(assertLayerFlagsUnchanged(planar.field_overlays, planar.field_overlays.map((layer) => ({ ...layer }))), true);
  assert.throws(
    () => assertLayerFlagsUnchanged(planar.field_overlays, [{ ...planar.field_overlays[0], raster_visible: false }, ...planar.field_overlays.slice(1)]),
    /flags changed/,
  );
});

test("slider commits are counted from display PATCH bodies", () => {
  assert.equal(countPositionCommits([
    { planar: { default_slice: { position_fraction: 0.4 } } },
    { planar: { interaction: { zoom: 2 } } },
    { planar: { default_slice: { plane: "xz" } } },
    null,
  ]), 1);
});

test("a legacy session migrates to the same image: base field becomes the bottom layer", () => {
  const legacy = {
    layer_model: "legacy",
    quantity_id: "H_demag",
    component: "magnitude",
    layers: { raster: true, vectors: false },
    field_overlays: [{ id: "object:film", quantity_id: "m", component: "magnitude", visible: false }],
  };
  assert.deepEqual(expectedMigratedLayers(legacy), [
    { id: "object:film", quantity_id: "m", component: "magnitude", visible: true },
    { id: "all", quantity_id: "H_demag", component: "magnitude", visible: true, raster_visible: true, vectors_visible: false },
  ]);
  assert.deepEqual(
    expectedMigratedLayers({ ...legacy, field_overlays: [{ id: "all", quantity_id: "m", component: "x" }] }).map((layer) => layer.id),
    ["all", "all-2"],
  );
  assert.deepEqual(expectedMigratedLayers({ ...legacy, layers: { raster: false, vectors: false } }).map((layer) => layer.id), ["object:film"]);
  const restored = {
    layer_model: "layers",
    field_overlays: expectedMigratedLayers(legacy).map((layer) => ({ ...layer, colormap: "viridis" })),
  };
  assert.deepEqual(assertMigratedLayers(legacy, restored), ["object:film", "all"]);
  assert.throws(() => assertMigratedLayers(legacy, { ...restored, layer_model: "legacy" }), /layer_model legacy/);
  assert.throws(
    () => assertMigratedLayers(legacy, { ...restored, field_overlays: restored.field_overlays.slice().reverse() }),
    /Restored layer 0 id/,
  );
});
