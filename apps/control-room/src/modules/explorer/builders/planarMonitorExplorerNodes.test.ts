import { describe, expect, it } from "vitest";

import { buildModelTree, buildPlanarMonitorNodes } from "./buildModelTree";

describe("planar monitor explorer nodes", () => {
  it("places committed monitors under Definitions / Planar Monitors", () => {
    const branch = buildPlanarMonitorNodes({
      count: 1,
      monitors: [
        {
          frame: {
            extent: { kind: "universe", padding_m: 0 },
            normal: [0, 0, 1],
            normalization_version: "planar_frame_v1",
            origin_m: [0, 0, 0],
            preset: "xy",
            u_axis: [1, 0, 0],
            v_axis: [0, 1, 0],
          },
          id: "plane-1",
          name: "Mid-plane",
          operator: { kind: "plane_sample" },
          target: { kind: "domain" },
        },
      ],
      scene_revision: 7,
    });

    expect(branch).toMatchObject({
      kind: "model.planar.monitors",
      label: "Planar Monitors",
      children: [
        {
          contextCommands: [
            "field-map.select-monitor",
            "planar-monitor.show-frame-3d",
            "planar-monitor.duplicate",
            "planar-monitor.rename",
            "planar-monitor.delete",
            "field-map.export-data",
          ],
          kind: "model.planar.monitor",
          label: "Mid-plane",
          monitorId: "plane-1",
        },
      ],
    });
  });

  it("keeps the Definitions branch in the canonical model tree when empty", () => {
    const root = buildModelTree(null, {
      planarMonitors: { count: 0, monitors: [], scene_revision: 0 },
    })[0];
    expect(root?.children?.[0]).toMatchObject({
      kind: "definitions.root",
      children: [{ kind: "model.planar.monitors", badge: "0" }],
    });
  });
});
