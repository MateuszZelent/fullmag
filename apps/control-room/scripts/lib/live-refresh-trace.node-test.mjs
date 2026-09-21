import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_LIVE_REFRESH_GATES,
  diffLiveRefreshSamples,
  evaluateLiveRefreshGates,
  formatLiveRefreshReport,
  liveRefreshGatesOutcome,
  normalizeLiveRefreshSample,
  summarizeLiveRefreshTrace,
} from "./live-refresh-trace.mjs";

function sample({
  at,
  frames = 0,
  reasons = {},
  materials = 0,
  geometries = 0,
  topologyBuilds = 0,
  aborted = 0,
  rejections = {},
  displayed = null,
  prepared = null,
  omit = [],
}) {
  const counters = {
    fieldDecodes: 0,
    fieldSwaps: 0,
    geometriesCreated: geometries,
    geometriesDisposed: 0,
    gpuUploadBytes: 0,
    gpuUploads: 0,
    materialsCreated: materials,
    materialsDisposed: 0,
    retentionRejections: rejections,
    topologyBuilds,
    topologyUploads: 0,
    typedArrayCopiedBytes: 0,
    uploadTicketsAborted: aborted,
    viewportFrameReasons: reasons,
    viewportFrames: frames,
    workerJobs: 0,
  };
  for (const key of omit) delete counters[key];
  return { atMs: at, counters, revisions: { displayed, prepared, received: prepared, requested: prepared } };
}

describe("normalizeLiveRefreshSample", () => {
  it("marks absent counters as null instead of zero", () => {
    const normalized = normalizeLiveRefreshSample(
      sample({ at: 0, omit: ["uploadTicketsAborted", "retentionRejections"] }),
    );
    assert.equal(normalized.counters.uploadTicketsAborted, null);
    assert.equal(normalized.retentionRejections, null);
    assert.equal(normalized.counters.materialsCreated, 0);
  });
});

describe("diffLiveRefreshSamples", () => {
  it("reports only positive reason deltas", () => {
    const a = normalizeLiveRefreshSample(sample({ at: 0, reasons: { "field-colors": 2 } }));
    const b = normalizeLiveRefreshSample(
      sample({ at: 100, reasons: { "field-colors": 5, "model-layer-stage-reset": 1 } }),
    );
    const delta = diffLiveRefreshSamples(a, b);
    assert.deepEqual(delta.viewportFrameReasons, {
      "field-colors": 3,
      "model-layer-stage-reset": 1,
    });
    assert.equal(delta.durationMs, 100);
  });

  it("propagates null for counters missing on either side", () => {
    const a = normalizeLiveRefreshSample(sample({ at: 0, omit: ["uploadTicketsAborted"] }));
    const b = normalizeLiveRefreshSample(sample({ at: 10, aborted: 3 }));
    assert.equal(diffLiveRefreshSamples(a, b).counters.uploadTicketsAborted, null);
  });
});

describe("summarizeLiveRefreshTrace", () => {
  it("skips warmup ticks so the first scene build does not fail the gates", () => {
    const summary = summarizeLiveRefreshTrace(
      [
        sample({ at: 0, displayed: "1", prepared: "1" }),
        sample({ at: 2000, materials: 4, geometries: 9, displayed: "2", prepared: "2" }),
        sample({ at: 4000, materials: 4, geometries: 9, displayed: "3", prepared: "3" }),
      ],
      { warmupTicks: 1 },
    );
    assert.equal(summary.ticks, 2);
    assert.equal(summary.totals.materialsCreated, 0);
    assert.equal(summary.totals.geometriesCreated, 0);
  });

  it("counts stage resets from the viewport frame reasons", () => {
    const summary = summarizeLiveRefreshTrace(
      [
        sample({ at: 0, displayed: "1", prepared: "1" }),
        sample({ at: 2000, displayed: "2", prepared: "2" }),
        sample({
          at: 4000,
          reasons: { "model-layer-stage-reset": 3 },
          displayed: "3",
          prepared: "3",
        }),
      ],
      { warmupTicks: 1 },
    );
    assert.equal(summary.stageResets, 3);
  });

  it("detects a displayed revision going backwards", () => {
    const summary = summarizeLiveRefreshTrace(
      [
        sample({ at: 0, displayed: "5", prepared: "5" }),
        sample({ at: 2000, displayed: "6", prepared: "6" }),
        sample({ at: 4000, displayed: "4", prepared: "7" }),
      ],
      { warmupTicks: 0 },
    );
    assert.equal(summary.revisionRegressions.length, 1);
    assert.equal(summary.revisionRegressions[0].to, "4");
  });

  it("flags ticks that blank out after a frame was already displayed", () => {
    const summary = summarizeLiveRefreshTrace(
      [
        sample({ at: 0, displayed: "1", prepared: "1" }),
        sample({ at: 2000, displayed: null, prepared: "2" }),
      ],
      { warmupTicks: 0 },
    );
    assert.equal(summary.blankAfterFirstDisplayTicks.length, 1);
    assert.equal(summary.blankAfterFirstDisplayTicks[0].prepared, "2");
  });

  it("does not flag blanks before anything was ever displayed", () => {
    const summary = summarizeLiveRefreshTrace(
      [sample({ at: 0 }), sample({ at: 2000 })],
      { warmupTicks: 0 },
    );
    assert.equal(summary.blankAfterFirstDisplayTicks.length, 0);
  });
});

describe("evaluateLiveRefreshGates", () => {
  const cleanTrace = [
    sample({ at: 0, displayed: "1", prepared: "1" }),
    sample({ at: 2000, displayed: "2", prepared: "2", reasons: { "field-colors": 1 } }),
    sample({ at: 4000, displayed: "3", prepared: "3", reasons: { "field-colors": 2 } }),
  ];

  it("passes a clean run", () => {
    const gates = evaluateLiveRefreshGates(
      summarizeLiveRefreshTrace(cleanTrace, { warmupTicks: 1 }),
    );
    assert.equal(liveRefreshGatesOutcome(gates), "pass");
  });

  it("fails when the stage resets on a field-only update", () => {
    const gates = evaluateLiveRefreshGates(
      summarizeLiveRefreshTrace(
        [
          ...cleanTrace,
          sample({
            at: 6000,
            displayed: "4",
            prepared: "4",
            reasons: { "model-layer-stage-reset": 1 },
          }),
        ],
        { warmupTicks: 1 },
      ),
    );
    const g1 = gates.find((gate) => gate.id === "G1");
    assert.equal(g1.status, "fail");
    assert.equal(liveRefreshGatesOutcome(gates), "fail");
  });

  it("reports unknown, never pass, when a counter is absent", () => {
    const gates = evaluateLiveRefreshGates(
      summarizeLiveRefreshTrace(
        [
          sample({ at: 0, displayed: "1", prepared: "1", omit: ["uploadTicketsAborted"] }),
          sample({ at: 2000, displayed: "2", prepared: "2", omit: ["uploadTicketsAborted"] }),
          sample({ at: 4000, displayed: "3", prepared: "3", omit: ["uploadTicketsAborted"] }),
        ],
        { warmupTicks: 1 },
      ),
    );
    const g5 = gates.find((gate) => gate.id === "G5");
    assert.equal(g5.status, "unknown");
    assert.equal(g5.actual, null);
    assert.equal(liveRefreshGatesOutcome(gates), "unknown");
  });

  it("fails on retention rejected because of domain or carrier identity", () => {
    const gates = evaluateLiveRefreshGates(
      summarizeLiveRefreshTrace(
        [
          sample({ at: 0, displayed: "1", prepared: "1" }),
          sample({ at: 2000, displayed: "2", prepared: "2" }),
          sample({
            at: 4000,
            displayed: "3",
            prepared: "3",
            rejections: { generation: 1 },
          }),
        ],
        { warmupTicks: 1 },
      ),
    );
    const g8 = gates.find((gate) => gate.id === "G8");
    assert.equal(g8.status, "fail");
    assert.equal(g8.actual, 1);
  });

  it("honours overridden limits", () => {
    const summary = summarizeLiveRefreshTrace(
      [
        sample({ at: 0, displayed: "1", prepared: "1" }),
        sample({ at: 2000, displayed: "2", prepared: "2" }),
        sample({ at: 4000, displayed: "3", prepared: "3", materials: 2 }),
      ],
      { warmupTicks: 1 },
    );
    assert.equal(
      evaluateLiveRefreshGates(summary).find((gate) => gate.id === "G2").status,
      "fail",
    );
    assert.equal(
      evaluateLiveRefreshGates(summary, { maxMaterialsCreated: 2 }).find(
        (gate) => gate.id === "G2",
      ).status,
      "pass",
    );
    assert.equal(DEFAULT_LIVE_REFRESH_GATES.maxMaterialsCreated, 0);
  });
});

describe("formatLiveRefreshReport", () => {
  it("renders every gate and the frame reason histogram", () => {
    const summary = summarizeLiveRefreshTrace(
      [
        sample({ at: 0, displayed: "1", prepared: "1" }),
        sample({ at: 2000, displayed: "2", prepared: "2", reasons: { "field-colors": 4 } }),
      ],
      { warmupTicks: 0 },
    );
    const report = formatLiveRefreshReport(summary, evaluateLiveRefreshGates(summary));
    assert.match(report, /G1 brak resetu etapu/);
    assert.match(report, /field-colors: 4/);
  });
});
