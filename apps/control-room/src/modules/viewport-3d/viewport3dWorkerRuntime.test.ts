import { describe, expect, it, vi } from "vitest";

import { createViewport3DWorkerRuntime } from "./viewport3dWorkerRuntime";

describe("Viewport3DWorkerRuntime", () => {
  it("keeps every worker lane alive until the final viewport lease releases", () => {
    const lanes = [
      "topology-index",
      "field-color",
      "region-overlay",
      "vector-glyph",
      "fdm-cuboid",
    ].map((id) => ({ dispose: vi.fn(), id }));
    const runtime = createViewport3DWorkerRuntime(lanes);

    const first = runtime.acquire();
    const second = runtime.acquire();
    expect(runtime.getSnapshot()).toEqual({
      activeLeases: 2,
      disposed: false,
      jobs: 0,
      timers: 0,
      workers: 0,
    });

    first.release();
    expect(lanes.every((lane) => lane.dispose.mock.calls.length === 0)).toBe(true);

    second.release();
    expect(lanes.every((lane) => lane.dispose.mock.calls.length === 1)).toBe(true);
    expect(runtime.getSnapshot()).toMatchObject({ activeLeases: 0, disposed: true });
  });

  it("creates a fresh runtime after the prior last lease releases", () => {
    const firstDispose = vi.fn();
    const firstRuntime = createViewport3DWorkerRuntime([
      { dispose: firstDispose, id: "topology-index" },
    ]);
    firstRuntime.acquire().release();

    const secondDispose = vi.fn();
    const secondRuntime = createViewport3DWorkerRuntime([
      { dispose: secondDispose, id: "topology-index" },
    ]);
    const lease = secondRuntime.acquire();

    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(secondDispose).not.toHaveBeenCalled();
    expect(secondRuntime.getSnapshot()).toMatchObject({ activeLeases: 1, disposed: false });

    lease.release();
    expect(secondDispose).toHaveBeenCalledTimes(1);
  });
});
