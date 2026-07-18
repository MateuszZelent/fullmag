import { describe, expect, it } from "vitest";

import { planarMonitorFrameSegments } from "./ClipPlaneLayer";

describe("planar monitor 3D frame preview", () => {
  it("builds an outline in the monitor's arbitrary world-space basis", () => {
    const segments = planarMonitorFrameSegments({
      boundsUvM: [-1, 1, -2, 2],
      monitorId: "oblique",
      normal: [Math.SQRT1_2, 0, Math.SQRT1_2],
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
});
