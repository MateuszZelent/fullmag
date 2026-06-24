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
