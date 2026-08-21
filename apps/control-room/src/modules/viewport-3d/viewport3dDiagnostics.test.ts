import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { recordVisualizationDebugResourceCounts } from "@/kernel/performance/visualizationDebugPerformanceProbe";

import {
  buildViewport3DDiagnostics,
  Viewport3DResourceTracker,
} from "./viewport3dDiagnostics";

describe("viewport3dDiagnostics", () => {
  const testWindow = globalThis as typeof globalThis & Window;

  afterEach(() => {
    delete testWindow.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__;
    vi.unstubAllGlobals();
  });

  it("subscribes build-engine diagnostics into the diagnostic recorder", () => {
    const source = readFileSync(
      new URL("./viewport3dDiagnostics.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("subscribeViewport3DBuildDiagnostics");
    expect(source).toContain(
      "createDiagnosticRecordFromViewport3DBuildDiagnostic",
    );
    expect(source).toContain("subscribeViewport3DGpuUploadDiagnostics");
    expect(source).toContain(
      "createDiagnosticRecordFromViewport3DGpuUploadDiagnostic",
    );
  });

  it("tracks and disposes viewport-owned resources without forcing React updates", () => {
    const tracker = new Viewport3DResourceTracker();
    const dispose = vi.fn();
    const geometry = { dispose };
    const listener = vi.fn();
    tracker.subscribe(listener);

    tracker.track("geometry", geometry);
    expect(listener).not.toHaveBeenCalled();

    tracker.recordDirtyFrame("topology");

    expect(tracker.getSnapshot()).toMatchObject({
      dirtyReason: "topology",
      frames: 1,
      geometries: 1,
    });
    expect(listener).not.toHaveBeenCalled();

    tracker.release("geometry", geometry);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(tracker.getSnapshot().geometries).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it("publishes fresh zero resource counts when teardown disposes the tracker", () => {
    vi.stubGlobal("window", testWindow);
    testWindow.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__ = {
      publishes: 0,
      scans: 0,
      viewportFrames: 0,
    };
    const tracker = new Viewport3DResourceTracker();
    for (const kind of [
      "geometry",
      "material",
      "render-target",
      "texture",
      "worker",
    ] as const) {
      tracker.track(kind, { dispose: vi.fn() });
    }
    recordVisualizationDebugResourceCounts({
      geometries: 1,
      materials: 1,
      renderTargets: 1,
      textures: 1,
      workers: 1,
    });

    tracker.disposeAll();

    expect(testWindow.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__.resourceCounts).toEqual({
      geometries: 0,
      materials: 0,
      renderTargets: 0,
      textures: 0,
      workers: 0,
    });
  });

  it("counts dirty-frame reasons until they are consumed", () => {
    const tracker = new Viewport3DResourceTracker();

    tracker.recordDirtyFrame("camera-control");
    tracker.recordDirtyFrame("camera-control");
    tracker.recordDirtyFrame("resources-updated");

    expect(tracker.consumeDirtyReasonCounts()).toEqual({
      "camera-control": 2,
      "resources-updated": 1,
    });
    expect(tracker.consumeDirtyReasonCounts()).toEqual({});
  });

  it("publishes only one worker-runtime snapshot for 1000 identical notifications", () => {
    const tracker = new Viewport3DResourceTracker();
    const listener = vi.fn();
    tracker.subscribe(listener);

    for (let index = 0; index < 1_000; index += 1) {
      tracker.setWorkerRuntimeCounts({ jobs: 1, timers: 2, workers: 3 });
    }

    expect(listener).toHaveBeenCalledTimes(1);
    expect(tracker.getSnapshot()).toMatchObject({
      workerRuntimeJobs: 1,
      workerRuntimeTimers: 2,
      workerRuntimeWorkers: 3,
    });
  });

  it("records context loss and restoration diagnostics", () => {
    const tracker = new Viewport3DResourceTracker();

    tracker.recordContextLost();
    tracker.recordContextRestored();

    expect(tracker.getSnapshot()).toMatchObject({
      contextLosses: 1,
      contextRestores: 1,
      dirtyReason: "context-restored",
    });
  });

  it("builds a compact diagnostics summary", () => {
    expect(
      buildViewport3DDiagnostics({
        airboxPartCount: 1,
        cache: { byteLength: 2048, entryCount: 2 },
        fieldRevision: 8,
        objectCount: 3,
        quantityId: "m",
        surfaceColorStatus: "stale-visible",
        topologyRevision: 7,
        tracker: {
          contextLosses: 0,
          contextRestores: 0,
          dirtyReason: null,
          frames: 2,
          geometries: 1,
          materials: 0,
          renderTargets: 0,
          textures: 0,
          workers: 0,
        },
      }),
    ).toBe("q:m top:7 field:8 surface:stale-visible obj:3 air:1 geo:1 cache:2KB glyph-cache:0/0B/0B worker-runtime:0/0/0 frames:2");
  });

  it("reports bounded per-carrier Airbox field status and reason", () => {
    expect(
      buildViewport3DDiagnostics({
        airboxFieldVectorPartStates: new Map([
          ["part:a", { reasonCode: null, revision: "field-1", status: "ready" }],
          [
            "part:b",
            {
              reasonCode: "field_refresh_in_progress",
              revision: "field-2",
              status: "stale",
            },
          ],
        ]),
        airboxPartCount: 2,
        cache: { byteLength: 0, entryCount: 0 },
        fieldRevision: null,
        objectCount: 0,
        quantityId: "H_demag",
        topologyRevision: null,
        tracker: {
          contextLosses: 0,
          contextRestores: 0,
          dirtyReason: null,
          frames: 0,
          geometries: 0,
          materials: 0,
          renderTargets: 0,
          textures: 0,
          workers: 0,
        },
      }),
    ).toContain(
      "airbox-fields:2[part:a=ready@field-1;part:b=stale:field_refresh_in_progress@field-2]",
    );
  });

  it("reports rejected unaddressable render carriers as a bounded diagnostic", () => {
    const diagnostics = buildViewport3DDiagnostics({
      airboxPartCount: 0,
      cache: { byteLength: 0, entryCount: 0 },
      fieldRevision: null,
      manifestCarrierRejectedCount: 2,
      objectCount: 0,
      quantityId: "m",
      topologyRevision: null,
      tracker: {
        contextLosses: 0,
        contextRestores: 0,
        dirtyReason: null,
        frames: 0,
        geometries: 0,
        materials: 0,
        renderTargets: 0,
        textures: 0,
        workers: 0,
      },
    });

    expect(diagnostics).toContain("unaddressable-render-target:2");
  });

  it("reports both visible and requested field revisions while syncing", () => {
    expect(
      buildViewport3DDiagnostics({
        airboxPartCount: 0,
        cache: { byteLength: 0, entryCount: 0 },
        fieldPayloadRevision: 41,
        fieldRequestedRevision: 42,
        fieldRevision: 41,
        fieldStatus: "stale",
        objectCount: 0,
        quantityId: "m",
        topologyRevision: 7,
        tracker: {
          contextLosses: 0,
          contextRestores: 0,
          dirtyReason: null,
          frames: 0,
          geometries: 0,
          materials: 0,
          renderTargets: 0,
          textures: 0,
          workers: 0,
        },
      }),
    ).toContain("field syncing r41 -> r42");
  });

  it("includes bounded field-demand request explanations", () => {
    expect(
      buildViewport3DDiagnostics({
        airboxPartCount: 0,
        cache: { byteLength: 0, entryCount: 0 },
        fieldDemandDiagnostics: [
          {
            demands: [
              "surface:x:complete",
              "vector-glyph:full:complete",
            ],
            requests: [
              "quantity=m component=full scope=object:object:layer-a consumers=object:layer-a:surface,object:layer-a:vector-glyph",
            ],
            targetId: "object:layer-a",
          },
          {
            demands: ["vector-glyph:full:sampled-ok max_samples=128"],
            requests: [
              "quantity=m component=full scope=object:object:layer-b max_samples=128 consumers=object:layer-b:vector-glyph",
            ],
            targetId: "object:layer-b",
          },
        ],
        fieldRevision: 12,
        objectCount: 2,
        quantityId: "m",
        topologyRevision: 11,
        tracker: {
          contextLosses: 0,
          contextRestores: 0,
          dirtyReason: null,
          frames: 0,
          geometries: 0,
          materials: 0,
          renderTargets: 0,
          textures: 0,
          workers: 0,
        },
      }),
    ).toContain(
      "field-demands:2[object:layer-a{surface:x:complete|vector-glyph:full:complete=>quantity=m component=full scope=object:object:layer-a consumers=object:layer-a:surface,object:layer-a:vector-glyph};object:layer-b{vector-glyph:full:sampled-ok max_samples=128=>quantity=m component=full scope=object:object:layer-b max_samples=128 consumers=object:layer-b:vector-glyph}]",
    );
  });

  it("includes bounded per-target buffer and derived-work explanations", () => {
    expect(
      buildViewport3DDiagnostics({
        airboxPartCount: 0,
        cache: { byteLength: 0, entryCount: 0 },
        fieldRevision: 12,
        objectCount: 1,
        quantityId: "m",
        targetDiagnostics: [
          {
            buffers: [
              "buffer:layer-a full-vector-complete quantity=m component=full scope=object:object:layer-a points=100000 ncomp=3 sampled=false state=target-buffer",
            ],
            degradation: [],
            demand: "surface:x vector-glyph",
            derivedWork: [
              "field-color:scalar-colors:ready:object:layer-a:surface",
              "vector-glyph:vector-glyphs:ready:object:layer-a:vector-glyph",
            ],
            passes: ["surface", "vector-glyph"],
            requests: [
              "quantity=m&component=full&scope_kind=object&scope_id=object:layer-a",
            ],
            retained: [],
            targetId: "object:layer-a",
          },
        ],
        topologyRevision: 11,
        tracker: {
          contextLosses: 0,
          contextRestores: 0,
          dirtyReason: null,
          frames: 0,
          geometries: 0,
          materials: 0,
          renderTargets: 0,
          textures: 0,
          workers: 0,
        },
      }),
    ).toContain(
      "target-passes:1[object:layer-a{passes=surface|vector-glyph demand=surface:x vector-glyph buffers=buffer:layer-a full-vector-complete quantity=m component=full scope=object:object:layer-a points=100000 ncomp=3 sampled=false state=target-buffer work=field-color:scalar-colors:ready:object:layer-a:surface|vector-glyph:vector-glyphs:ready:object:layer-a:vector-glyph degradation=none retained=none}]",
    );
  });

  it("includes stale-compatible retention in compact target diagnostics", () => {
    expect(
      buildViewport3DDiagnostics({
        airboxPartCount: 0,
        cache: { byteLength: 0, entryCount: 0 },
        fieldRevision: 12,
        objectCount: 1,
        quantityId: "m",
        targetDiagnostics: [
          {
            buffers: ["state=target-buffer"],
            degradation: [],
            demand: "surface:x",
            derivedWork: [],
            passes: ["surface"],
            requests: [],
            retained: [
              "surface stale-compatible current=field-2 retained=field=field-1",
            ],
            targetId: "object:layer-a",
          },
        ],
        topologyRevision: 11,
        tracker: {
          contextLosses: 0,
          contextRestores: 0,
          dirtyReason: null,
          frames: 0,
          geometries: 0,
          materials: 0,
          renderTargets: 0,
          textures: 0,
          workers: 0,
        },
      }),
    ).toContain(
      "retained=surface stale-compatible current=field-2 retained=field=field-1",
    );
  });

  it("includes data-plane mismatch and pipeline timing diagnostics", () => {
    expect(
      buildViewport3DDiagnostics({
        airboxPartCount: 0,
        cache: { byteLength: 0, entryCount: 0 },
        dataPlaneIssues: [
          "request-key-mismatch target=part-a key=component=x request=component=y",
        ],
        fieldRevision: 12,
        objectCount: 1,
        pipelineDiagnostics: [
          {
            lane: "vector-glyph",
            mainAdoptMs: 4,
            mainUploadMs: 3,
            queueWaitMs: 7,
            transferMs: 2,
            workerComputeMs: 11,
          },
          {
            lane: "gpu-upload",
            mainAdoptMs: 0,
            mainUploadMs: 6,
            queueWaitMs: 1,
            transferMs: 0,
            workerComputeMs: 0,
          },
        ],
        quantityId: "m",
        topologyRevision: 11,
        tracker: {
          contextLosses: 0,
          contextRestores: 0,
          dirtyReason: null,
          frames: 0,
          geometries: 0,
          materials: 0,
          renderTargets: 0,
          textures: 0,
          workers: 0,
        },
      }),
    ).toContain(
      "data-plane:1[request-key-mismatch target=part-a key=component=x request=component=y] pipeline:2[vector-glyph{queue=7ms worker=11ms transfer=2ms adopt=4ms upload=3ms};gpu-upload{queue=1ms worker=0ms transfer=0ms adopt=0ms upload=6ms}]",
    );
  });

  it("includes explicit worker fallback diagnostics by build lane", () => {
    expect(
      buildViewport3DDiagnostics({
        airboxPartCount: 0,
        buildFallbacks: [
          {
            count: 2,
            key: "vector-segments:part-a",
            lane: "vector-glyph",
            reason: "worker-unavailable",
            revisionSummary: "topology=mesh-1 field=field-1",
            timestampMs: 100,
          },
          {
            count: 1,
            key: "complex-phase:m",
            lane: "field-color",
            reason: "worker-failed",
            revisionSummary: "field=field-1 phase=1.57",
            timestampMs: 120,
          },
        ],
        cache: { byteLength: 0, entryCount: 0 },
        fieldRevision: 12,
        objectCount: 1,
        quantityId: "m",
        topologyRevision: 11,
        tracker: {
          contextLosses: 0,
          contextRestores: 0,
          dirtyReason: null,
          frames: 0,
          geometries: 0,
          materials: 0,
          renderTargets: 0,
          textures: 0,
          workers: 0,
        },
      }),
    ).toContain(
      "fallbacks:2[field-color{count=1 reason=worker-failed key=complex-phase:m};vector-glyph{count=2 reason=worker-unavailable key=vector-segments:part-a}]",
    );
  });

  it("records viewport resource ledger events without forcing subscriptions", () => {
    const records: unknown[] = [];
    const tracker = new Viewport3DResourceTracker({
      record: (record) => records.push(record),
    });
    const dispose = vi.fn();
    const texture = { dispose };
    const listener = vi.fn();
    tracker.subscribe(listener);

    tracker.track("texture", texture, {
      byteLength: 4096,
      id: "viewport3d.texture.field",
      label: "Field texture",
      owner: "viewport-3d",
    });

    expect(tracker.getLedgerSnapshot()).toEqual([
      {
        byteLength: 4096,
        createdAtMs: expect.any(Number),
        id: "viewport3d.texture.field",
        kind: "texture",
        label: "Field texture",
        owner: "viewport-3d",
      },
    ]);
    expect(listener).not.toHaveBeenCalled();

    tracker.release("texture", texture, "quantity-switch");

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(tracker.getLedgerSnapshot()).toEqual([]);
    expect(records).toEqual([
      expect.objectContaining({
        detail: expect.objectContaining({
          byteLength: 4096,
          kind: "texture",
          resourceId: "viewport3d.texture.field",
        }),
        name: "viewport-3d.resource-tracked",
      }),
      expect.objectContaining({
        detail: expect.objectContaining({
          releaseReason: "quantity-switch",
          resourceId: "viewport3d.texture.field",
        }),
        name: "viewport-3d.resource-released",
      }),
    ]);
  });
});
