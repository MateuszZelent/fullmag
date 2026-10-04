import { afterEach, describe, expect, it, vi } from "vitest";

import { fieldMapCommands } from "./fieldMapCommands";
import { MODEL_PLANAR_MONITORS_PATH } from "@/kernel/api/apiPaths";
import { VISUALIZATION_STATE_PATH } from "@/kernel/api/apiPaths";
import { planarMonitorFramePreviewStore } from "@/kernel/workspace/planarMonitorFramePreview";
import {
  crossSectionWorkspaceStore,
  discardPlanarMonitorDraft,
} from "@/kernel/workspace/crossSectionWorkspace";

describe("field-map commands", () => {
  it("allows opening an empty workspace view without a live session", async () => {
    const setActiveViewportMainModule = vi.fn();
    const setFocusedSlot = vi.fn();
    const command = fieldMapCommands.find((entry) => entry.id === "field-map.open");
    const result = await command?.run({
      source: "test",
      sessionScopeKey: null,
      isCurrentSessionScope: () => false,
      layout: { setActiveViewportMainModule, setFocusedSlot } as never,
    });
    expect(result?.status).toBe("completed");
    expect(setActiveViewportMainModule).toHaveBeenCalledWith("field-map");
    expect(setFocusedSlot).toHaveBeenCalledWith("viewport-main");
  });

  it("does not move the new session view when a monitor deletion ACK arrives late", async () => {
    let current = true;
    const queuePatch = vi.fn();
    const invalidate = vi.fn();
    const command = fieldMapCommands.find((entry) => entry.id === "planar-monitor.delete");
    const result = await command?.run({
      source: "test",
      input: { monitorId: "plane-1" },
      isCurrentSessionScope: () => current,
      visualizationSync: { queuePatch } as never,
      resources: { invalidate } as never,
      api: {
        visualization: { state: vi.fn(async () => ({ planar: { source: { kind: "monitor", monitor_id: "plane-1" } } })) },
        model: { planarMonitors: {
          list: vi.fn(async () => ({ scene_revision: 7 })),
          remove: vi.fn(async () => { current = false; return { scene_revision: 8 }; }),
        } },
      } as never,
    });
    expect(result?.status).toBe("cancelled");
    expect(queuePatch).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("does not create a draft after the session changes during the domain read", async () => {
    let current = true;
    const setSelection = vi.fn();
    const setPanelVisible = vi.fn();
    const command = fieldMapCommands.find((entry) => entry.id === "planar-monitor.create");
    const result = await command?.run({
      source: "test",
      isCurrentSessionScope: () => current,
      selection: { set: setSelection } as never,
      layout: { setPanelVisible } as never,
      api: { data: { domain: { meta: vi.fn(async () => {
        current = false;
        return { bounds: { min: [0, 0, 0], max: [1, 1, 1] } };
      }) } } } as never,
    });
    expect(result?.status).toBe("cancelled");
    expect(setSelection).not.toHaveBeenCalled();
    expect(setPanelVisible).not.toHaveBeenCalled();
  });

  afterEach(() => {
    planarMonitorFramePreviewStore.clear();
    discardPlanarMonitorDraft();
  });

  it("registers the one-key 2D shortcut on the canonical open command", () => {
    expect(
      fieldMapCommands.find((entry) => entry.id === "field-map.open"),
    ).toMatchObject({ shortcut: "2" });
  });

  it("opens the shared center surface and selects a monitor through one typed planar patch", async () => {
    const setActiveViewportMainModule = vi.fn();
    const setFocusedSlot = vi.fn();
    const queuePatch = vi.fn();
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
      resourceData: {
        [VISUALIZATION_STATE_PATH]: {
          planar: { source: { kind: "default" } },
        },
      },
      visualizationSync: { queuePatch } as never,
    });

    expect(queuePatch).toHaveBeenCalledTimes(1);
    expect(queuePatch).toHaveBeenCalledWith({
      planar: { source: { kind: "monitor", monitor_id: "plane-1" } },
    });
    expect(setActiveViewportMainModule).toHaveBeenCalledWith("field-map");
    expect(setFocusedSlot).toHaveBeenCalledWith("viewport-main");
  });

  it("opens the session default without querying monitors, domain, or creating a draft", async () => {
    const setActiveViewportMainModule = vi.fn();
    const setFocusedSlot = vi.fn();
    const setPanelVisible = vi.fn();
    const selectionSet = vi.fn();
    const list = vi.fn();
    const domainMeta = vi.fn();
    const command = fieldMapCommands.find((entry) => entry.id === "field-map.open");

    const result = await command?.run({
      api: {
        data: {
          domain: {
            meta: domainMeta,
          },
        },
        model: {
          planarMonitors: {
            list,
          },
        },
      } as never,
      layout: {
        setActiveViewportMainModule,
        setFocusedSlot,
        setPanelVisible,
      } as never,
      selection: { set: selectionSet } as never,
      source: "test",
    });

    expect(result).toEqual({ status: "completed" });
    expect(list).not.toHaveBeenCalled();
    expect(domainMeta).not.toHaveBeenCalled();
    expect(selectionSet).not.toHaveBeenCalled();
    expect(setPanelVisible).not.toHaveBeenCalled();
    expect(crossSectionWorkspaceStore.getSnapshot().planarMonitorDraft).toBeNull();
  });

  it("creates every user entrypoint draft through the canonical monitor factory before opening the Inspector", async () => {
    const setFocusedSlot = vi.fn();
    const setPanelVisible = vi.fn();
    const selectionSet = vi.fn();
    const domainMeta = vi.fn().mockResolvedValue({
      bounds: { min: [-4, -6, -8], max: [4, 6, 8] },
    });
    const command = fieldMapCommands.find((entry) => entry.id === "planar-monitor.create");

    const result = await command?.run({
      api: {
        data: {
          domain: {
            meta: domainMeta,
          },
        },
      } as never,
      input: { intent: { source: "palette" } },
      layout: { setFocusedSlot, setPanelVisible } as never,
      selection: { set: selectionSet } as never,
      sessionScopeKey: "session=session-1&epoch=session-1%401",
      source: "palette",
    });

    expect(result).toEqual({ status: "completed" });
    expect(domainMeta).toHaveBeenCalledWith({
      sessionScopeKey: "session=session-1&epoch=session-1%401",
    });
    expect(crossSectionWorkspaceStore.getSnapshot().planarMonitorDraft).toMatchObject({
      monitor: {
        target: { kind: "domain" },
        operator: { kind: "plane_sample" },
        frame: { normalization_version: "planar_frame_v1" },
      },
    });
    expect(selectionSet).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "model.planar.monitor.draft" }),
      "palette",
    );
    expect(setPanelVisible).toHaveBeenCalledWith("right", true);
  });

  it("fails closed for an Explorer target whose active-session capability is unavailable", () => {
    const command = fieldMapCommands.find((entry) => entry.id === "planar-monitor.create");
    const context = {
      api: {} as never,
      input: {
        capability: { enabled: false, reason: "FDM target membership is not materialized." },
        intent: { source: "explorer", target: { kind: "object", object_id: "film" } },
      },
      source: "explorer" as const,
    };

    expect(command?.isEnabled?.(context)).toBe(false);
    expect(command?.disabledReason?.(context)).toBe("FDM target membership is not materialized.");
  });

  it("fails closed rather than substituting slice state when clip creation is requested while clipping is off", () => {
    const command = fieldMapCommands.find((entry) => entry.id === "planar-monitor.create");
    const context = {
      api: {} as never,
      input: { intent: { source: "clip" } },
      resourceData: {
        [VISUALIZATION_STATE_PATH]: {
          clip: { axis: "x", enabled: false, flipped: true, position_percent: 25 },
          slice: { axis: "z", position_percent: 75 },
        },
      },
      source: "ribbon" as const,
    };
    expect(command?.isEnabled?.(context)).toBe(false);
    expect(command?.disabledReason?.(context)).toBe(
      "Enable the clip plane before creating a planar monitor from it.",
    );
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
    const queuePatch = vi.fn();
    const command = fieldMapCommands.find(
      (entry) => entry.id === "planar-monitor.show-frame-3d",
    );
    const sessionScopeKey = "session=session-1&epoch=session-1%401";

    const result = await command?.run({
      api: {
        data: { fields: { planar: { meta } } },
        visualization: {
          state: vi.fn().mockResolvedValue({
            planar: {
              component: "magnitude",
              quantity_id: "m",
              resolution: { height: 256, width: 512 },
              source: { kind: "default" },
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
      sessionScopeKey,
      source: "test",
      visualizationSync: { queuePatch } as never,
    });

    expect(result).toEqual({ status: "completed" });
    expect(meta).toHaveBeenCalledWith(
      "m",
      { kind: "monitor", monitorId: "plane-1" },
      expect.objectContaining({ scope_kind: "monitor_target" }),
      { sessionScopeKey },
    );
    expect(planarMonitorFramePreviewStore.getSnapshot()).toMatchObject({
      boundsUvM: [-2, 2, -1, 1],
      monitorId: "plane-1",
      originM: [0, 0, 3],
    });
    expect(queuePatch).toHaveBeenCalledWith({
      planar: { source: { kind: "monitor", monitor_id: "plane-1" } },
    });
    expect(setActiveViewportMainModule).toHaveBeenCalledWith("viewport-3d");
  });

  it("keeps planar export reads in the captured session scope", async () => {
    const visualizationState = vi.fn().mockResolvedValue({
      planar: {
        component: "magnitude",
        layers: { mesh: true },
        quantity_id: "m",
        resolution: { height: 256, vector_budget: 64, width: 512 },
        source: { kind: "default" },
        view_scope: { kind: "monitor_target" },
      },
    });
    const meta = vi.fn().mockResolvedValue({});
    const monitor = vi.fn().mockResolvedValue({ monitor: { name: "Plane" } });
    const renderPng = vi.fn().mockResolvedValue({
      etag: "etag-1",
      status: "not-modified",
    });
    const command = fieldMapCommands.find((entry) => entry.id === "field-map.export-png");
    const sessionScopeKey = "session=session-1&epoch=session-1%401";

    const result = await command?.run({
      api: {
        data: {
          fields: {
            planar: { meta, renderPng },
          },
        },
        model: { planarMonitors: { get: monitor } },
        visualization: { state: visualizationState },
      } as never,
      input: { monitorId: "plane-1" },
      sessionScopeKey,
      source: "test",
    });

    expect(result).toEqual({
      message: "The planar PNG is not available for this revision.",
      status: "failed",
    });
    expect(visualizationState).toHaveBeenCalledWith({ sessionScopeKey });
    expect(meta).toHaveBeenCalledWith(
      "m",
      { kind: "monitor", monitorId: "plane-1" },
      expect.objectContaining({ quality: "export" }),
      { sessionScopeKey },
    );
    expect(monitor).toHaveBeenCalledWith("plane-1", { sessionScopeKey });
    expect(renderPng).toHaveBeenCalledWith(
      "m",
      { kind: "monitor", monitorId: "plane-1" },
      expect.objectContaining({ quality: "export" }),
      { sessionScopeKey },
    );
  });

  it("routes context-menu rename to the Inspector when no name was supplied", async () => {
    const setPanelVisible = vi.fn();
    const command = fieldMapCommands.find(
      (entry) => entry.id === "planar-monitor.rename",
    );

    const result = await command?.run({
      api: {
        model: {
          planarMonitors: {
            list: vi.fn().mockResolvedValue({ scene_revision: 7 }),
          },
        },
      } as never,
      input: { monitorId: "plane-1" },
      layout: { setPanelVisible } as never,
      source: "test",
    });

    expect(result).toEqual({
      message: "Edit the monitor name in the Inspector.",
      status: "completed",
    });
    expect(setPanelVisible).toHaveBeenCalledWith("right", true);
  });

  it("renames through the canonical monitor patch and invalidates its collection", async () => {
    const invalidate = vi.fn();
    const patch = vi.fn().mockResolvedValue({ scene_revision: 8 });
    const list = vi.fn().mockResolvedValue({ scene_revision: 7 });
    const get = vi.fn().mockResolvedValue({
      monitor: {
        id: "plane-1",
        name: "Old name",
        operator: { kind: "plane_sample" },
      },
    });
    const command = fieldMapCommands.find(
      (entry) => entry.id === "planar-monitor.rename",
    );
    const sessionScopeKey = "session=session-1&epoch=session-1%401";

    const result = await command?.run({
      api: {
        model: {
          planarMonitors: {
            get,
            list,
            patch,
          },
        },
      } as never,
      input: { monitorId: "plane-1", newName: "New name" },
      resources: { invalidate } as never,
      sessionScopeKey,
      source: "test",
    });

    expect(result).toEqual({ status: "completed" });
    expect(patch).toHaveBeenCalledWith("plane-1", {
      expected_scene_revision: 7,
      monitor: expect.objectContaining({ id: "plane-1", name: "New name" }),
    }, { sessionScopeKey });
    expect(list).toHaveBeenCalledWith({ sessionScopeKey });
    expect(get).toHaveBeenCalledWith("plane-1", { sessionScopeKey });
    expect(invalidate).toHaveBeenCalledWith(
      MODEL_PLANAR_MONITORS_PATH,
      8,
    );
  });

  it("repairs an actively deleted monitor to Default only after the delete succeeds", async () => {
    const queuePatch = vi.fn();
    const remove = vi.fn().mockResolvedValue({ scene_revision: 9 });
    const command = fieldMapCommands.find((entry) => entry.id === "planar-monitor.delete");

    await command?.run({
      api: {
        model: {
          planarMonitors: {
            list: vi.fn().mockResolvedValue({ scene_revision: 8 }),
            remove,
          },
        },
        visualization: {
          state: vi.fn().mockResolvedValue({
            planar: { source: { kind: "monitor", monitor_id: "plane-1" } },
          }),
        },
      } as never,
      input: { monitorId: "plane-1" },
      resources: { invalidate: vi.fn() } as never,
      source: "test",
      visualizationSync: { queuePatch } as never,
    });

    expect(remove).toHaveBeenCalledWith(
      "plane-1",
      { expected_scene_revision: 8 },
      undefined,
    );
    expect(queuePatch).toHaveBeenCalledWith({
      planar: { source: { kind: "default" } },
    });
  });

  it("records an immediate monitor deletion against the captured scene revision", async () => {
    const record = vi.fn();
    const remove = vi.fn().mockResolvedValue({ scene_revision: 9 });
    const command = fieldMapCommands.find((entry) => entry.id === "planar-monitor.delete");

    await command?.run({
      api: {
        model: {
          scene: vi.fn()
            .mockResolvedValueOnce({ objects: [], revision: 8 })
            .mockResolvedValueOnce({ objects: [], revision: 9 }),
          planarMonitors: {
            remove,
          },
        },
        visualization: {
          state: vi.fn().mockResolvedValue({ planar: { source: { kind: "default" } } }),
        },
      } as never,
      authoringHistory: { record } as never,
      input: { monitorId: "plane-1" },
      resources: { invalidate: vi.fn() } as never,
      source: "test",
      visualizationSync: { queuePatch: vi.fn() } as never,
    });

    expect(remove).toHaveBeenCalledWith(
      "plane-1",
      { expected_scene_revision: 8 },
      undefined,
    );
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      committedRevision: 9,
      label: "Delete planar monitor",
    }));
  });

  it("does not change Default when deleting a non-active monitor", async () => {
    const queuePatch = vi.fn();
    const command = fieldMapCommands.find((entry) => entry.id === "planar-monitor.delete");

    await command?.run({
      api: {
        model: {
          planarMonitors: {
            list: vi.fn().mockResolvedValue({ scene_revision: 8 }),
            remove: vi.fn().mockResolvedValue({ scene_revision: 9 }),
          },
        },
        visualization: {
          state: vi.fn().mockResolvedValue({ planar: { source: { kind: "default" } } }),
        },
      } as never,
      input: { monitorId: "plane-1" },
      resources: { invalidate: vi.fn() } as never,
      source: "test",
      visualizationSync: { queuePatch } as never,
    });

    expect(queuePatch).not.toHaveBeenCalled();
  });

  it("selects the server-returned id after duplicating a monitor", async () => {
    const queuePatch = vi.fn();
    const command = fieldMapCommands.find((entry) => entry.id === "planar-monitor.duplicate");

    await command?.run({
      api: {
        model: {
          planarMonitors: {
            list: vi.fn().mockResolvedValue({ scene_revision: 8 }),
            duplicate: vi.fn().mockResolvedValue({
              monitor: { id: "returned-id" },
              scene_revision: 9,
            }),
          },
        },
        visualization: {
          state: vi.fn().mockResolvedValue({ planar: { source: { kind: "default" } } }),
        },
      } as never,
      input: { monitorId: "plane-1" },
      resources: { invalidate: vi.fn() } as never,
      source: "test",
      visualizationSync: { queuePatch } as never,
    });

    expect(queuePatch).toHaveBeenCalledWith({
      planar: { source: { kind: "monitor", monitor_id: "returned-id" } },
    });
  });
});
