import { describe, expect, it, vi } from "vitest";

import {
  planarMonitorFramePreviewInteraction,
  planarMonitorFrameSegments,
} from "./ClipPlaneLayer";

describe("planar monitor 3D frame preview", () => {
  it("builds an outline in the monitor's arbitrary world-space basis", () => {
    const segments = planarMonitorFrameSegments({
      boundsUvM: [-1, 1, -2, 2],
      monitorId: "oblique",
      normal: [Math.SQRT1_2, 0, Math.SQRT1_2],
      operator: { kind: "plane_sample" },
      originM: [10, 20, 30],
      uAxis: [Math.SQRT1_2, 0, -Math.SQRT1_2],
      vAxis: [0, 1, 0],
    });

    expect(segments).toHaveLength(36);
    expect([...segments.slice(0, 3)]).toEqual([
      Math.fround(10 - Math.SQRT1_2),
      18,
      Math.fround(30 + Math.SQRT1_2),
    ]);
    expect([...segments.slice(3, 6)]).toEqual([
      Math.fround(10 + Math.SQRT1_2),
      18,
      Math.fround(30 - Math.SQRT1_2),
    ]);
  });

  it("renders both slab faces and their thickness connectors from the canonical operator", () => {
    const segments = planarMonitorFrameSegments({
      boundsUvM: [-1, 1, -1, 1],
      monitorId: "slab",
      normal: [0, 0, 1],
      operator: { kind: "slab_average", thickness_m: 4 },
      originM: [0, 0, 0],
      uAxis: [1, 0, 0],
      vAxis: [0, 1, 0],
    });

    expect(segments).toHaveLength(96);
    expect([...segments].filter((_, index) => index % 3 === 2)).toEqual(
      expect.arrayContaining([Math.fround(-2), Math.fround(2)]),
    );
  });

  it("selects only a visible selectable frame and removes the hidden frame hit target", () => {
    const preview = {
      boundsUvM: [-1, 1, -1, 1] as const,
      monitorId: "plane-1",
      normal: [0, 0, 1] as const,
      operator: { kind: "plane_sample" as const },
      originM: [0, 0, 0] as const,
      uAxis: [1, 0, 0] as const,
      vAxis: [0, 1, 0] as const,
    };
    const onSelect = vi.fn();
    const stopPropagation = vi.fn();
    const visible = planarMonitorFramePreviewInteraction(preview, onSelect);
    visible?.onClick?.({ stopPropagation } as never);
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith("plane-1", false);

    const nonSelectable = planarMonitorFramePreviewInteraction({ ...preview, selectable: false }, onSelect);
    expect(nonSelectable?.onClick).toBeUndefined();
    expect(nonSelectable?.raycast).toBeDefined();
    expect(planarMonitorFramePreviewInteraction({ ...preview, visible: false }, onSelect)).toBeNull();
  });
});
