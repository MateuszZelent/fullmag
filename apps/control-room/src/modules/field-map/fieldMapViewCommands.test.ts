import { afterEach, describe, expect, it, vi } from "vitest";

import { VISUALIZATION_STATE_PATH } from "@/kernel/api/apiPaths";
import { fieldMapSurfaceStore } from "@/kernel/visualization/fieldMapSurfaceStore";
import { fieldMapViewCommands } from "./fieldMapViewCommands";

async function run(id: string, component: string, vectors = false) {
  const queuePatch = vi.fn();
  const command = fieldMapViewCommands.find((entry) => entry.id === id);
  expect(command).toBeDefined();
  const result = await command!.run({ source: "test",
    resourceData: { [VISUALIZATION_STATE_PATH]: { planar: {
      component, quantity_id: "J_spin", colormap: "viridis", range: { mode: "auto" },
      layers: { vectors, mesh: false },
    } } },
    visualizationSync: { queuePatch } as never,
  });
  return { result, queuePatch };
}

describe("field-map tensor shortcuts", () => {
  afterEach(() => fieldMapSurfaceStore.reset());

  it.each(["direction", "x", "y", "z", "magnitude"])("refuses the %s vector preset for a tensor", async (preset) => {
    for (const projection of ["frobenius", "c4", "spin_flow_z"]) {
      const { result, queuePatch } = await run(`field-map.component-${preset}`, projection);
      expect(result?.status).toBe("failed");
      expect(queuePatch).not.toHaveBeenCalled();
    }
  });

  it("preserves component shortcuts for ordinary vector fields", async () => {
    const { result, queuePatch } = await run("field-map.component-x", "magnitude");
    expect(result?.status).toBe("completed");
    expect(queuePatch).toHaveBeenCalledWith({ planar: expect.objectContaining({ component: "x" }) });
  });

  it("refuses scalar tensor arrows but permits vector projections and turning stale arrows off", async () => {
    const scalar = await run("field-map.toggle-vectors", "frobenius");
    expect(scalar.result?.status).toBe("failed");
    expect(scalar.queuePatch).not.toHaveBeenCalled();
    const vector = await run("field-map.toggle-vectors", "spin_flow_z");
    expect(vector.result?.status).toBe("completed");
    expect(vector.queuePatch).toHaveBeenCalledWith({ planar: { layers: { vectors: true, mesh: false } } });
    const stale = await run("field-map.toggle-vectors", "frobenius", true);
    expect(stale.result?.status).toBe("completed");
    expect(stale.queuePatch).toHaveBeenCalledWith({ planar: { layers: { vectors: false, mesh: false } } });
  });

  it("exports CSV data with the crop window of the current source", async () => {
    const crop = { u_min_m: -1e-8, u_max_m: 1e-8, v_min_m: 0, v_max_m: 2e-8 };
    const state = vi.fn().mockResolvedValue({
      planar: {
        component: "magnitude",
        crop,
        default_slice: { plane: "xy" },
        quantity_id: "m",
        resolution: { height: 64, width: 64 },
        source: { kind: "default" },
        view_scope: { kind: "monitor_target" },
      },
    });
    const meta = vi.fn().mockResolvedValue({});
    const scalar = vi.fn().mockResolvedValue({ status: "not-modified" });
    const emptyMask = vi.fn().mockResolvedValue({ status: "not-modified" });
    const command = fieldMapViewCommands.find((entry) => entry.id === "field-map.export-data")!;
    const result = await command.run({
      api: { data: { fields: { planar: { emptyMask, meta, scalar } } }, visualization: { state } } as never,
      source: "test",
    });
    expect(result?.status).toBe("failed");
    const window = { window_u_min_m: "-1e-8", window_u_max_m: "1e-8", window_v_min_m: "0", window_v_max_m: "2e-8" };
    for (const request of [meta, scalar, emptyMask]) {
      expect(request).toHaveBeenCalledWith("m", { kind: "default" }, expect.objectContaining(window), undefined);
    }
  });
});