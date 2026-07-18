import { afterEach, describe, expect, it, vi } from "vitest";

import { fieldMapCommands } from "./fieldMapCommands";
import { fieldMapStore } from "./fieldMapStore";
import { planarMonitorFramePreviewStore } from "@/kernel/workspace/planarMonitorFramePreview";

describe("field-map commands", () => {
  afterEach(() => {
    fieldMapStore.reset();
    planarMonitorFramePreviewStore.clear();
  });

  it("opens the shared center surface and selects a monitor through one command", async () => {
    const setActiveViewportMainModule = vi.fn();
    const setFocusedSlot = vi.fn();
    const command = fieldMapCommands.find(
      (entry) => entry.id === "field-map.select-monitor",
    );

    await command?.run({
      input: { monitorId: "plane-1" },
      layout: {
        setActiveViewportMainModule,
        setFocusedSlot,
      } as never,
      source: "test",
    });

    expect(fieldMapStore.get().activeMonitorId).toBe("plane-1");
    expect(setActiveViewportMainModule).toHaveBeenCalledWith("field-map");
    expect(setFocusedSlot).toHaveBeenCalledWith("viewport-main");
  });

  it("loads the resolved monitor frame before opening its outline in 3D", async () => {
    const setActiveViewportMainModule = vi.fn();
    const setFocusedSlot = vi.fn();
    const meta = vi.fn().mockResolvedValue({
      frame: {
        bounds_uv_m: [-2, 2, -1, 1],
        normal: [0, 0, 1],
        origin_m: [0, 0, 3],
        u_axis: [1, 0, 0],
        v_axis: [0, 1, 0],
      },
    });
    const command = fieldMapCommands.find(
      (entry) => entry.id === "planar-monitor.show-frame-3d",
    );

    const result = await command?.run({
      api: {
        data: { fields: { planar: { meta } } },
        visualization: {
          state: vi.fn().mockResolvedValue({
            planar: {
              component: "magnitude",
              quantity_id: "m",
              resolution: { height: 256, width: 512 },
              view_scope: { kind: "monitor_target" },
            },
          }),
        },
      } as never,
      input: { monitorId: "plane-1" },
      layout: {
        setActiveViewportMainModule,
        setFocusedSlot,
      } as never,
      source: "test",
    });

    expect(result).toEqual({ status: "completed" });
    expect(meta).toHaveBeenCalledWith(
      "m",
      "plane-1",
      expect.objectContaining({ scope_kind: "monitor_target" }),
    );
    expect(planarMonitorFramePreviewStore.getSnapshot()).toMatchObject({
      boundsUvM: [-2, 2, -1, 1],
      monitorId: "plane-1",
      originM: [0, 0, 3],
    });
    expect(setActiveViewportMainModule).toHaveBeenCalledWith("viewport-3d");
  });
});
