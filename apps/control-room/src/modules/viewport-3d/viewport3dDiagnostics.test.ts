import { describe, expect, it, vi } from "vitest";

import {
  buildViewport3DDiagnostics,
  Viewport3DResourceTracker,
} from "./viewport3dDiagnostics";

describe("viewport3dDiagnostics", () => {
  it("tracks and disposes viewport-owned resources", () => {
    const tracker = new Viewport3DResourceTracker();
    const dispose = vi.fn();
    const geometry = { dispose };
    const listener = vi.fn();
    tracker.subscribe(listener);

    tracker.track("geometry", geometry);
    expect(listener).toHaveBeenCalledTimes(1);

    tracker.recordDirtyFrame("topology");

    expect(tracker.getSnapshot()).toMatchObject({
      dirtyReason: "topology",
      frames: 1,
      geometries: 1,
    });
    expect(listener).toHaveBeenCalledTimes(1);

    tracker.release("geometry", geometry);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(tracker.getSnapshot().geometries).toBe(0);
    expect(listener).toHaveBeenCalledTimes(2);
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
        topologyRevision: 7,
        tracker: {
          contextLosses: 0,
          contextRestores: 0,
          dirtyReason: null,
          frames: 2,
          geometries: 1,
          materials: 0,
          textures: 0,
          workers: 0,
        },
      }),
    ).toBe("q:m top:7 field:8 obj:3 air:1 geo:1 cache:2KB frames:2");
  });
});
