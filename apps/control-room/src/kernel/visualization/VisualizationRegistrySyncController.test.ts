import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  VisualizationStatePatch,
  VisualizationStateResource,
} from "../api/apiTypes";
import { VISUALIZATION_STATE_PATH } from "../api/apiPaths";

import { VisualizationRegistrySyncController } from "./VisualizationRegistrySyncController";

const visualizationRegistrySyncControllerSource = readFileSync(
  join(process.cwd(), "src/kernel/visualization/VisualizationRegistrySyncController.ts"),
  "utf8",
);

function blockBetween(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function visualizationState(
  revision: number,
  patch: Partial<VisualizationStateResource> = {},
): VisualizationStateResource {
  return {
    active_quantity_id: "m",
    auto_contrast: true,
    camera: {
      fov_degrees: 45,
      orthographic_scale: null,
      position: [0, 0, 1],
      projection: "perspective",
      target: [0, 0, 0],
      up: [0, 1, 0],
    },
    clip: {
      enabled: false,
      axis: "x",
      flipped: false,
      position_percent: 50,
    },
    colormap: "viridis",
    contrast_max: null,
    contrast_min: null,
    diagnostics: {
      degraded_reasons: [],
      warnings: [],
    },
    domains: {
      active_scope: {
        object_id: null,
        part_id: null,
        scope: "full",
      },
      topology_mode: "auto",
      volume_edges_budget: 100_000,
    },
    fdm: {
      x_chosen_size: 0,
      y_chosen_size: 0,
    },
    fem: {},
    field_component: "magnitude",
    layers: {
      airbox: {
        render_mode: "wireframe",
        show_airbox: false,
        show_airbox_vectors: false,
      },
      bounds: {
        visible: false,
      },
      points: {
        visible: false,
      },
      primitives: {
        visible: true,
      },
      quantity: {
        visible: true,
      },
      surface: {
        opacity: 1,
        visible: true,
      },
      vectors: {
        density: 50,
        domain: "auto",
        visible: false,
      },
      wireframe: {
        visible: false,
      },
    },
    max_points: 16_384,
    overrides: [],
    quantity: {
      active_quantity_id: "m",
      auto_contrast: true,
      colormap: "viridis",
      component: "magnitude",
      contrast_max: null,
      contrast_min: null,
      field_component: "magnitude",
    },
    revision,
    sampling: {
      max_bytes: null,
      max_glyphs: 16_384,
      max_points: 16_384,
      profile: "balanced",
      progressive: true,
    },
    schema_version: 4,
    slice: {
      axis: "z",
      auto_contrast: true,
      colormap: "viridis",
      component: "magnitude",
      layer_index: 0,
      mode: "single",
      position_percent: 50,
      projection_include_air_as_zero: false,
      projection_reduction: "mean_occupied",
      projection_resolution: 128,
      projection_samples: 32,
      quantity_id: "m",
      render_mode: "heatmap",
      show_airbox: false,
      show_magnetic_texture: true,
      show_mesh: false,
      show_primitives: true,
      show_quantity: true,
      show_vectors: false,
      thickness_percent: null,
    },
    slice_layer: 0,
    slice_mode: "single",
    targets: {
      airbox: {
        label: "Airbox",
        scope: "airbox",
        scope_id: "airbox",
        settings: {
          bounds_visible: false,
          geometry_scope: "full",
          opacity: 0.28,
          points_visible: false,
          render_mode: "wireframe",
          surface_color_source: "solid",
          surface_visible: false,
          vector_alpha: 1,
          vector_color_mode: "orientation",
          vector_mono_color: "#00c2ff",
          vector_thickness: 1,
          vectors_visible: false,
          visible: true,
          wireframe_color: "#94a3b8",
          wireframe_opacity: 1,
          wireframe_visible: true,
        },
        source: "airbox",
      },
      objects: [],
      parts: [],
    },
    trim: {
      x: { enabled: false, max_percent: 100, min_percent: 0 },
      y: { enabled: false, max_percent: 100, min_percent: 0 },
      z: { enabled: false, max_percent: 100, min_percent: 0 },
    },
    vector_density: 50,
    vector_glyphs: false,
    vector_style: {
      alpha: 1,
      color_mode: "orientation",
      ferromagnet_visibility: "hide",
      length_scale: 1,
      mono_color: "#00c2ff",
      thickness: 1,
    },
    view_mode: "3d",
    x_chosen_size: 0,
    y_chosen_size: 0,
    ...patch,
  } as VisualizationStateResource;
}

function createController({
  now,
  patch,
}: {
  now: () => number;
  patch?: (patch: VisualizationStatePatch) => Promise<VisualizationStateResource>;
}) {
  const patchSpy =
    patch ??
    vi.fn(async (nextPatch: VisualizationStatePatch) =>
      visualizationState(2, nextPatch as Partial<VisualizationStateResource>),
    );
  return {
    controller: new VisualizationRegistrySyncController({
      api: { patch: patchSpy },
      intervalMs: 1_000,
      maxLatencyMs: 2_500,
      now,
      quietMs: 600,
    }),
    patchSpy,
  };
}

describe("VisualizationRegistrySyncController", () => {
  it("keeps stable JSON fingerprinting out of the high-frequency queuePatch path", () => {
    const queuePatchBlock = blockBetween(
      visualizationRegistrySyncControllerSource,
      "  queuePatch(patch: VisualizationStatePatch): void {",
      "  start(): void {",
    );

    expect(queuePatchBlock).toContain("visualizationPatchSatisfiesPatch");
    expect(queuePatchBlock).not.toContain("fingerprintVisualizationPatch");
    expect(queuePatchBlock).not.toContain("stableJson");
  });

  it("does not start an idle recurring timer when there are no pending patches", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const { controller } = createController({ now: () => 0 });

    controller.start();
    controller.stop();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(clearIntervalSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(clearTimeoutSpy).not.toHaveBeenCalled();

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  it("coalesces camera changes and flushes only the latest patch after the quiet window", async () => {
    let time = 0;
    const { controller, patchSpy } = createController({ now: () => time });

    controller.queuePatch({
      camera: { position: [1, 0, 1], target: [0, 0, 0] },
    });
    time = 100;
    controller.queuePatch({
      camera: { position: [2, 0, 1], target: [0, 0, 0] },
    });

    time = 500;
    await controller.flushDue();
    expect(patchSpy).not.toHaveBeenCalled();

    time = 800;
    await controller.flushDue();
    expect(patchSpy).toHaveBeenCalledTimes(1);
    expect(patchSpy).toHaveBeenLastCalledWith({
      camera: { position: [2, 0, 1], target: [0, 0, 0] },
    });
  });

  it("skips optimistic overlay for camera-only patches to avoid busting rendering memos", () => {
    const time = 0;
    const { controller } = createController({ now: () => time });
    const remote = visualizationState(10);

    controller.observeRemoteState(remote);
    controller.queuePatch({
      camera: { position: [5, 4, 3], target: [1, 1, 1] },
    });

    // Camera-only patches return the original reference unchanged.
    // The viewport consumes camera state directly from viewport3dStore,
    // bypassing the optimistic overlay to avoid busting rendering memos.
    expect(controller.applyOptimisticState(remote)).toBe(remote);

    // The pending patch is still tracked for flushing to the backend.
    expect(controller.getSnapshot().pendingPatch).toMatchObject({
      camera: { position: [5, 4, 3], target: [1, 1, 1] },
    });

    controller.observeRemoteState(
      visualizationState(11, {
        camera: {
          ...remote.camera,
          position: [5, 4, 3],
          target: [1, 1, 1],
        },
      }),
    );

    expect(controller.getSnapshot().pendingPatch).toBeNull();
  });

  it("does not send a patch when an incoming backend state already satisfies the pending fingerprint", async () => {
    let time = 0;
    const { controller, patchSpy } = createController({ now: () => time });
    const remote = visualizationState(1);

    controller.queuePatch({
      camera: { position: [9, 8, 7], target: [0, 0, 0] },
    });
    controller.observeRemoteState(
      visualizationState(2, {
        camera: {
          ...remote.camera,
          position: [9, 8, 7],
          target: [0, 0, 0],
        },
      }),
    );

    time = 1_000;
    await controller.flushDue();

    expect(patchSpy).not.toHaveBeenCalled();
    expect(controller.getSnapshot().pendingPatch).toBeNull();
  });

  it("does not notify visualization resource subscribers for camera-only queueing", () => {
    const time = 0;
    const { controller } = createController({ now: () => time });
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.queuePatch({
      camera: { position: [2, 2, 2], target: [0, 0, 0] },
    });

    expect(listener).not.toHaveBeenCalled();
    expect(controller.getSnapshot().pendingPatch).toMatchObject({
      camera: { position: [2, 2, 2], target: [0, 0, 0] },
    });
  });

  it("flushes camera-only patches without invalidating visualization resources", async () => {
    let time = 0;
    const invalidations: Array<[string, number]> = [];
    const patchSpy = vi.fn(async (nextPatch: VisualizationStatePatch) =>
      visualizationState(12, nextPatch as Partial<VisualizationStateResource>),
    );
    const controller = new VisualizationRegistrySyncController({
      api: { patch: patchSpy },
      intervalMs: 1_000,
      maxLatencyMs: 2_500,
      now: () => time,
      quietMs: 600,
      resources: {
        invalidate: (key, revision) => invalidations.push([key, Number(revision)]),
      },
    });

    controller.queuePatch({
      camera: { position: [4, 4, 4], target: [0, 0, 0] },
    });
    time = 1_000;
    await controller.flushDue();

    expect(patchSpy).toHaveBeenCalledTimes(1);
    expect(invalidations).toEqual([]);
  });

  it("suppresses the websocket invalidation for its own camera-only patch revision", async () => {
    let time = 0;
    const patchSpy = vi.fn(async (nextPatch: VisualizationStatePatch) =>
      visualizationState(22, nextPatch as Partial<VisualizationStateResource>),
    );
    const controller = new VisualizationRegistrySyncController({
      api: { patch: patchSpy },
      now: () => time,
      quietMs: 600,
    });
    controller.queuePatch({
      camera: { position: [7, 7, 7], target: [0, 0, 0] },
    });
    time = 1_000;
    await controller.flushDue();

    expect(
      controller.shouldSuppressInvalidation(
        VISUALIZATION_STATE_PATH,
        22,
      ),
    ).toBe(true);
    expect(
      controller.shouldSuppressInvalidation(
        VISUALIZATION_STATE_PATH,
        22,
      ),
    ).toBe(false);
  });

  it("suppresses one visualization invalidation while a camera-only patch is inflight", async () => {
    let time = 0;
    let resolvePatch!: (state: VisualizationStateResource) => void;
    const patchSpy = vi.fn(
      () =>
        new Promise<VisualizationStateResource>((resolve) => {
          resolvePatch = resolve;
        }),
    );
    const controller = new VisualizationRegistrySyncController({
      api: { patch: patchSpy },
      now: () => time,
      quietMs: 600,
    });
    const remote = visualizationState(1);

    controller.queuePatch({
      camera: { position: [8, 8, 8], target: [0, 0, 0] },
    });
    time = 1_000;
    const flush = controller.flushDue();

    expect(
      controller.shouldSuppressInvalidation(
        VISUALIZATION_STATE_PATH,
        23,
      ),
    ).toBe(true);
    expect(
      controller.shouldSuppressInvalidation(
        VISUALIZATION_STATE_PATH,
        24,
      ),
    ).toBe(false);

    resolvePatch(
      visualizationState(23, {
        camera: {
          ...remote.camera,
          position: [8, 8, 8],
          target: [0, 0, 0],
          up: [0, 1, 0],
        },
      }),
    );
    await flush;
  });
});
