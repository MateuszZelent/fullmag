import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  buildViewport3DDiagnostics,
  Viewport3DResourceTracker,
} from "./viewport3dDiagnostics";

describe("viewport3dDiagnostics", () => {
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
    ).toBe("q:m top:7 field:8 surface:stale-visible obj:3 air:1 geo:1 cache:2KB frames:2");
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
      "target-passes:1[object:layer-a{passes=surface|vector-glyph demand=surface:x vector-glyph buffers=buffer:layer-a full-vector-complete quantity=m component=full scope=object:object:layer-a points=100000 ncomp=3 sampled=false state=target-buffer work=field-color:scalar-colors:ready:object:layer-a:surface|vector-glyph:vector-glyphs:ready:object:layer-a:vector-glyph degradation=none}]",
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
