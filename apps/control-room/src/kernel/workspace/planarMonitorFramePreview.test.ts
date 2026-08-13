import { describe, expect, it, vi } from "vitest";

import { planarMonitorFramePreviewStore } from "./planarMonitorFramePreview";

describe("planar monitor 3D frame preview store", () => {
  it("publishes and clears only the lightweight resolved frame", () => {
    const listener = vi.fn();
    const unsubscribe = planarMonitorFramePreviewStore.subscribe(listener);
    const frame = {
      boundsUvM: [-1, 1, -2, 2] as const,
      monitorId: "plane-1",
      normal: [0, 0, 1] as const,
      operator: null,
      originM: [0, 0, 0] as const,
      uAxis: [1, 0, 0] as const,
      vAxis: [0, 1, 0] as const,
    };

    planarMonitorFramePreviewStore.set(frame);
    expect(planarMonitorFramePreviewStore.getSnapshot()).toBe(frame);
    planarMonitorFramePreviewStore.clear();
    expect(planarMonitorFramePreviewStore.getSnapshot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
