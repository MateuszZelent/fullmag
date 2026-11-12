import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommandContext } from "@/kernel/commands/commandTypes";
import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import { fieldMapSurfaceStore } from "@/kernel/visualization/fieldMapSurfaceStore";
import { planarToolStore } from "@/kernel/visualization/planarToolStore";

import { fieldMapToolCommands, PLANAR_TOOL_COMMANDS, zoomPlanarViewCentre } from "./fieldMapToolCommands";
import { fieldMapViewCommands } from "./fieldMapViewCommands";
import { zoomPlanarInteractionAt } from "./renderer/planarInteraction";

type PlanarState = NonNullable<VisualizationStateResource["planar"]>;

function planarState(overrides: Partial<PlanarState> = {}): PlanarState {
  return {
    colormap: "viridis",
    component: "magnitude",
    default_slice: { operator: { kind: "plane_sample" }, plane: "xy", position_fraction: 0.5 },
    interaction: { pan_u_m: 2e-9, pan_v_m: -1e-9, zoom: 2 },
    layers: {
      boundaries: false, bounds: false, contours: false, mesh: false, points: false,
      probes: true, raster: true, streamlines: false, vectors: false,
    },
    point_style: { color: "#ffffff", opacity: 1, size: 1 },
    quality: "interactive",
    quantity_id: "m",
    resolution: { height: 128, vector_budget: 512, width: 256 },
    source: { kind: "default" },
    vector_style: {
      color_mode: "orientation", length_mode: "uniform", monochrome_color: "#ffffff",
      opacity: 1, scale: 1, thickness: 1,
    },
    view_scope: { kind: "monitor_target" },
    viewport_colorbar_visible: true,
    visible: true,
    wireframe_style: { color: "#ffffff", opacity: 1 },
    ...overrides,
  } as PlanarState;
}

function context(active = true): CommandContext & { queuePatch: ReturnType<typeof vi.fn> } {
  const queuePatch = vi.fn();
  return {
    layout: { get: () => ({ activeViewportMainModuleId: active ? "field-map" : "viewport-3d" }) } as never,
    queuePatch,
    source: "test",
    visualizationSync: { flushNow: vi.fn(), queuePatch } as never,
  };
}

function command(id: string) {
  const found = fieldMapToolCommands.find((entry) => entry.id === id);
  expect(found, id).toBeDefined();
  return found!;
}

describe("field-map tool commands", () => {
  afterEach(() => {
    planarToolStore.reset();
    fieldMapSurfaceStore.reset();
  });

  it("reports each tool as active exactly when the tool store holds it", async () => {
    const ctx = context();
    for (const { id, tool } of PLANAR_TOOL_COMMANDS) {
      const result = await command(id).run(ctx);
      expect(result.status).toBe("completed");
      expect(planarToolStore.getSnapshot().activeTool).toBe(tool);
      for (const other of PLANAR_TOOL_COMMANDS) {
        expect(command(other.id).isActive?.(ctx)).toBe(other.id === id);
      }
    }
    expect(ctx.queuePatch).not.toHaveBeenCalled();
  });

  it("toggles the vector mask without touching the other layers and reports it pressed", async () => {
    const planar = planarState();
    fieldMapSurfaceStore.set({ planar });
    const ctx = context();
    const vectors = fieldMapViewCommands.find((entry) => entry.id === "field-map.toggle-vectors")!;

    expect(vectors.isActive?.(ctx)).toBe(false);
    await vectors.run(ctx);
    expect(ctx.queuePatch).toHaveBeenCalledExactlyOnceWith({
      planar: { layers: { ...planar.layers, vectors: !planar.layers.vectors } },
    });
    fieldMapSurfaceStore.set({ planar: planarState({ layers: { ...planar.layers, vectors: true } }) });
    expect(vectors.isActive?.(ctx)).toBe(true);

    await command("field-map.toggle-points").run(ctx);
    expect(ctx.queuePatch).toHaveBeenLastCalledWith({
      planar: { layers: { ...planar.layers, vectors: true, points: true } },
    });
  });

  it("disables every command with a reason outside the 2D view", () => {
    fieldMapSurfaceStore.set({ planar: planarState() });
    const ctx = context(false);
    for (const entry of fieldMapToolCommands) {
      expect(entry.isEnabled?.(ctx), entry.id).toBe(false);
      expect(entry.disabledReason?.(ctx), entry.id).toBe("Open the 2D view first.");
    }
  });

  it("uses the H B C I P R F letters without reusing an existing 2D shortcut", () => {
    const viewShortcuts = new Set(
      fieldMapViewCommands.flatMap((entry) => entry.shortcut ? [entry.shortcut.toUpperCase()] : []),
    );
    const toolShortcuts = fieldMapToolCommands.flatMap((entry) => entry.shortcut ? [entry.shortcut] : []);

    expect(toolShortcuts.sort()).toEqual(["B", "C", "F", "H", "I", "P", "R"]);
    for (const shortcut of toolShortcuts) expect(viewShortcuts.has(shortcut)).toBe(false);
    for (const preserved of ["[", "]", "SHIFT+{", "SHIFT+}", "V", "X", "Y", "Z", "M", "A", "G"]) {
      expect(viewShortcuts.has(preserved), preserved).toBe(true);
    }
  });

  it("zooms by 1.25 about the view centre and back, within the wheel-zoom clamp", async () => {
    const planar = planarState();
    fieldMapSurfaceStore.set({ planar });
    const ctx = context();

    await command("field-map.zoom-in").run(ctx);
    expect(ctx.queuePatch).toHaveBeenLastCalledWith({
      planar: { interaction: { pan_u_m: 2e-9, pan_v_m: -1e-9, zoom: 2.5 } },
    });
    await command("field-map.zoom-out").run(ctx);
    expect(ctx.queuePatch).toHaveBeenLastCalledWith({
      planar: { interaction: { pan_u_m: 2e-9, pan_v_m: -1e-9, zoom: 1.6 } },
    });

    // Same clamp as wheel zoom: zoomPlanarInteractionAt keeps zoom positive.
    const tiny = zoomPlanarViewCentre({ panU: 0, panV: 0, zoom: 1e-12 }, 1e-3);
    expect(tiny.zoom).toBe(zoomPlanarInteractionAt([0, 1, 0, 1], { panU: 0, panV: 0, zoom: 1e-12 }, 0.5, 0.5, 1e-15).zoom);
  });

  it("fits the view and refuses field lines for scalar tensor projections", async () => {
    fieldMapSurfaceStore.set({ planar: planarState({ component: "frobenius" }) });
    const ctx = context();

    await command("field-map.fit").run(ctx);
    expect(ctx.queuePatch).toHaveBeenLastCalledWith({
      planar: { interaction: { pan_u_m: 0, pan_v_m: 0, zoom: 1 } },
    });
    expect(command("field-map.toggle-streamlines").isEnabled?.(ctx)).toBe(false);
    expect(command("field-map.toggle-streamlines").disabledReason?.(ctx)).toContain("scalar");
  });

  it("sets the slice panel count and the legend mask", async () => {
    const planar = planarState();
    fieldMapSurfaceStore.set({ planar });
    const ctx = context();

    expect((await command("field-map.multislice-panels").run({ ...ctx, input: { count: 5 } })).status).toBe("failed");
    await command("field-map.multislice-panels").run({ ...ctx, input: { count: 4 } });
    expect(ctx.queuePatch).toHaveBeenLastCalledWith({
      planar: { multislice: { enabled: true, position_fractions: [0.2, 0.4, 0.6, 0.8] } },
    });
    await command("field-map.toggle-legend").run(ctx);
    expect(ctx.queuePatch).toHaveBeenLastCalledWith({ planar: { viewport_colorbar_visible: false } });

    fieldMapSurfaceStore.set({ planar: planarState({ source: { kind: "monitor", monitor_id: "m1" } }) });
    expect(command("field-map.toggle-multislice").disabledReason?.(ctx)).toBe(
      "Slice panels apply to the Default source.",
    );
  });
});
