import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  VisualizationStatePatch,
  VisualizationStateResource,
} from "../api/apiTypes";
import { VISUALIZATION_STATE_PATH } from "../api/apiPaths";
import { ControlRoomApiError } from "../api/ControlRoomApi";

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
    schema_version: 5,
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
          active_quantity_id: "m",
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
      "  queuePatch(\n",
      "  start(): void {",
    );

    expect(queuePatchBlock).toContain("visualizationPatchSatisfiesPatch");
    expect(queuePatchBlock).not.toContain("fingerprintVisualizationPatch");
    expect(queuePatchBlock).not.toContain("stableJson");
  });

  it("keeps generic deep merge out of the high-frequency queuePatch path", () => {
    const queuePatchBlock = blockBetween(
      visualizationRegistrySyncControllerSource,
      "  queuePatch(\n",
      "  start(): void {",
    );
    const queuedMergeBlock = blockBetween(
      visualizationRegistrySyncControllerSource,
      "function mergeQueuedVisualizationPatch",
      "function mergeVisualizationStatePatch",
    );

    expect(queuePatchBlock).toContain("mergeQueuedVisualizationPatch");
    expect(queuePatchBlock).not.toContain("mergeVisualizationStatePatch");
    expect(queuedMergeBlock).not.toContain("deepMerge");
    expect(queuedMergeBlock).not.toContain("cloneJson");
    expect(queuedMergeBlock).not.toContain("stableJson");
  });

  it("keeps generic JSON fingerprinting and deep clone merge out of the sync controller", () => {
    expect(visualizationRegistrySyncControllerSource).not.toContain("deepMerge");
    expect(visualizationRegistrySyncControllerSource).not.toContain("cloneJson");
    expect(visualizationRegistrySyncControllerSource).not.toContain("stableJson");
    expect(visualizationRegistrySyncControllerSource).not.toContain("sortJson");
    expect(visualizationRegistrySyncControllerSource).not.toContain("JSON.stringify");
    expect(visualizationRegistrySyncControllerSource).not.toContain("intervalMs");
    expect(visualizationRegistrySyncControllerSource).not.toContain("setInterval");
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

  it("keeps camera projection optimistic so stale remote state cannot bounce the ORTHO toggle", () => {
    const time = 0;
    const { controller } = createController({ now: () => time });
    const remote = visualizationState(10, {
      camera: {
        ...visualizationState(10).camera,
        projection: "orthographic",
      },
    });

    controller.observeRemoteState(remote);
    controller.queuePatch({
      camera: { projection: "perspective" },
    });

    const optimistic = controller.applyOptimisticState(remote);

    expect(optimistic).not.toBe(remote);
    expect(optimistic?.camera.projection).toBe("perspective");
    expect(optimistic?.camera.position).toEqual(remote.camera.position);
  });

  it("reports stale remote camera state while a local camera patch is active", () => {
    const time = 0;
    const { controller } = createController({ now: () => time });
    const remote = visualizationState(10);

    controller.observeRemoteState(remote);
    controller.queuePatch({
      camera: { projection: "orthographic" },
    });

    expect(controller.hasUnsatisfiedCameraPatch(remote)).toBe(true);
    expect(
      controller.hasUnsatisfiedCameraPatch(
        visualizationState(11, {
          camera: {
            ...remote.camera,
            projection: "orthographic",
          },
        }),
      ),
    ).toBe(false);
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

  it("rejects a permanent 400 once and rolls back the optimistic overlay", async () => {
    const patchSpy = vi.fn(async () => {
      throw new ControlRoomApiError("invalid opacity", 400, "req-invalid");
    });
    const controller = new VisualizationRegistrySyncController({
      api: { patch: patchSpy },
      retryBaseDelayMs: 0,
    });
    const remote = visualizationState(7);
    controller.observeRemoteState(remote);
    controller.queuePatch({ layers: { surface: { visible: false } } });

    await controller.flushNow();

    expect(patchSpy).toHaveBeenCalledTimes(1);
    expect(controller.applyOptimisticState(remote)).toBe(remote);
    expect(controller.getSnapshot()).toMatchObject({
      inflightPatch: null,
      mutation: {
        attempts: 1,
        requestId: "req-invalid",
        status: "rejected",
        targetId: "visualization",
      },
      pendingPatch: null,
    });
  });

  it("bounds transient 503 retries and ends in rejected state", async () => {
    const patchSpy = vi.fn(async () => {
      throw new ControlRoomApiError("temporarily unavailable", 503, "req-503");
    });
    const controller = new VisualizationRegistrySyncController({
      api: { patch: patchSpy },
      maxTransientAttempts: 3,
      retryBaseDelayMs: 0,
    });
    controller.queuePatch({ layers: { wireframe: { visible: false } } });

    await controller.flushNow();

    expect(patchSpy).toHaveBeenCalledTimes(3);
    expect(controller.getSnapshot()).toMatchObject({
      mutation: {
        attempts: 3,
        requestId: "req-503",
        status: "rejected",
      },
      pendingPatch: null,
    });
  });

  it("retries the exact rejected mutation on explicit user request", async () => {
    const patchSpy = vi
      .fn()
      .mockRejectedValueOnce(
        new ControlRoomApiError("invalid opacity", 400, "req-invalid"),
      )
      .mockResolvedValueOnce(visualizationState(8));
    const controller = new VisualizationRegistrySyncController({
      api: { patch: patchSpy },
      retryBaseDelayMs: 0,
    });
    const patch = { layers: { surface: { visible: false } } } as const;
    controller.queuePatch(patch);
    await controller.flushNow();

    await controller.retryRejectedMutation();

    expect(patchSpy).toHaveBeenNthCalledWith(2, patch);
    expect(controller.getSnapshot().mutation?.status).toBe("succeeded");
  });

  it("retains interleaved optimistic target overrides by scope identity", () => {
    const { controller } = createController({ now: () => 0 });
    const remote = visualizationState(10);
    controller.observeRemoteState(remote);

    controller.queuePatch({
      overrides: [
        {
          scope: "object",
          scope_id: "object:a",
          style: { vector_budget: 111 },
        },
      ],
    });
    controller.queuePatch({
      overrides: [
        {
          scope: "object",
          scope_id: "object:b",
          style: { vector_budget: 222 },
        },
      ],
    });

    expect(controller.getSnapshot().pendingPatch?.overrides).toEqual([
      {
        scope: "object",
        scope_id: "object:a",
        style: { vector_budget: 111 },
      },
      {
        scope: "object",
        scope_id: "object:b",
        style: { vector_budget: 222 },
      },
    ]);
  });

  it("removes a target override when a reset omits it from a queued replacement", () => {
    const { controller } = createController({ now: () => 0 });
    const remote = visualizationState(10);
    controller.observeRemoteState(remote);

    controller.queuePatch(
      {
        overrides: [
          {
            scope: "object",
            scope_id: "film",
            display: { vectors: { visible: true } },
          },
          {
            scope: "object",
            scope_id: "other",
            display: { vectors: { visible: true } },
          },
        ],
      },
      ["object:film", "object:other"],
    );
    controller.queuePatch(
      {
        overrides: [
          {
            scope: "object",
            scope_id: "other",
            display: { vectors: { visible: true } },
          },
        ],
      },
      ["object:film"],
    );

    expect(controller.getSnapshot().pendingPatch?.overrides).toEqual([
      {
        scope: "object",
        scope_id: "other",
        display: { vectors: { visible: true } },
      },
    ]);
    expect(controller.applyOptimisticState(remote)?.overrides).toEqual([
      {
        scope: "object",
        scope_id: "other",
        display: { vectors: { visible: true } },
      },
    ]);
  });

  it("rebases a target reset against the latest remote overrides", () => {
    const { controller } = createController({ now: () => 0 });
    const remote = visualizationState(10, {
      overrides: [
        {
          scope: "object",
          scope_id: "film",
          display: { vectors: { visible: true } },
        },
        {
          scope: "object",
          scope_id: "other",
          display: { vectors: { visible: true } },
        },
      ],
    });
    controller.observeRemoteState(remote);

    controller.queuePatch({ overrides: [] }, ["object:film"]);

    expect(controller.applyOptimisticState(remote)?.overrides).toEqual([
      {
        scope: "object",
        scope_id: "other",
        display: { vectors: { visible: true } },
      },
    ]);
  });

  it("maps persisted FDM and native-layer scopes to canonical target identities", () => {
    const { controller } = createController({ now: () => 0 });
    const remote = visualizationState(10, {
      overrides: [
        {
          scope: "fdm_domain",
          scope_id: "fdm-universe-outside-support",
          display: { vectors: { visible: false } },
        },
        {
          scope: "fdm_native_layer",
          scope_id: "fdm-native-layer:bottom",
          display: { vectors: { visible: false } },
        },
        {
          scope: "object",
          scope_id: "film",
          display: { vectors: { visible: false } },
        },
      ],
    });
    controller.observeRemoteState(remote);

    controller.queuePatch(
      { overrides: [] },
      ["fdm-universe-outside-support"],
    );
    controller.queuePatch(
      { overrides: [] },
      ["fdm-native-layer:bottom"],
    );

    expect(controller.getSnapshot().pendingTargetIds).toEqual([
      "fdm-universe-outside-support",
      "fdm-native-layer:bottom",
    ]);

    expect(controller.applyOptimisticState(remote)?.overrides).toEqual([
      {
        scope: "object",
        scope_id: "film",
        display: { vectors: { visible: false } },
      },
    ]);
  });

  it("rebases a queued target operation onto newer remote overrides before sending", async () => {
    const sentPatches: VisualizationStatePatch[] = [];
    const { controller } = createController({
      now: () => 0,
      patch: async (patch) => {
        sentPatches.push(patch);
        return visualizationState(12, patch as Partial<VisualizationStateResource>);
      },
    });
    const initial = visualizationState(10, {
      overrides: [
        {
          scope: "object",
          scope_id: "film",
          display: { vectors: { visible: false } },
        },
      ],
    });
    controller.observeRemoteState(initial);
    controller.queuePatch(
      {
        overrides: [
          {
            scope: "object",
            scope_id: "film",
            display: { vectors: { visible: true } },
          },
        ],
      },
      ["object:film"],
    );

    controller.observeRemoteState(
      visualizationState(11, {
        overrides: [
          {
            scope: "object",
            scope_id: "film",
            display: { vectors: { visible: false } },
          },
          {
            scope: "object",
            scope_id: "other",
            display: { vectors: { visible: true } },
          },
        ],
      }),
    );
    await controller.flushNow();

    expect(sentPatches[0]).toEqual(
      expect.objectContaining({
        overrides: expect.arrayContaining([
          expect.objectContaining({
            scope: "object",
            scope_id: "film",
            display: expect.objectContaining({ vectors: { visible: true } }),
          }),
          expect.objectContaining({
            scope: "object",
            scope_id: "other",
            display: { vectors: { visible: true } },
          }),
        ]),
      }),
    );
    expect(sentPatches[0]?.overrides).toHaveLength(2);
  });

  it("exposes rejected target identities for pending overlay rollback", async () => {
    const patchSpy = vi.fn(async () => {
      throw new ControlRoomApiError("invalid visibility", 400, "req-visibility");
    });
    const onRejectedTargetPatches = vi.fn();
    const controller = new VisualizationRegistrySyncController({
      api: { patch: patchSpy },
      onRejectedTargetPatches,
      retryBaseDelayMs: 0,
    });
    controller.observeRemoteState(visualizationState(7));
    controller.queuePatch(
      {
        overrides: [
          {
            scope: "fdm_domain",
            scope_id: "fdm-universe-outside-support",
            display: { vectors: { visible: true } },
          },
        ],
      },
      ["fdm-universe-outside-support"],
    );

    await controller.flushNow();

    expect(controller.getSnapshot()).toMatchObject({
      mutation: {
        requestId: "req-visibility",
        status: "rejected",
      },
      rejectedTargetIds: ["fdm-universe-outside-support"],
    });
    expect(onRejectedTargetPatches).toHaveBeenCalledWith([
      "fdm-universe-outside-support",
    ]);
  });

  it("flushes FDM target overrides through the versioned visualization resource", async () => {
    const { controller, patchSpy } = createController({ now: () => 0 });
    const remote = visualizationState(10);
    controller.observeRemoteState(remote);
    const patch = {
      overrides: [
        {
          scope: "fdm_domain",
          scope_id: "fdm-universe-outside-support",
          display: { vectors: { visible: true } },
          style: { vector_budget: 256 },
        },
      ],
    } as unknown as VisualizationStatePatch;

    controller.queuePatch(patch);

    expect(controller.applyOptimisticState(remote)?.overrides).toEqual(
      patch.overrides,
    );
    await controller.flushNow();

    expect(patchSpy).toHaveBeenCalledWith(patch);
  });

  it("tracks target identities from queued through inflight mutation", async () => {
    let resolvePatch!: (state: VisualizationStateResource) => void;
    const patchSpy = vi.fn(
      () =>
        new Promise<VisualizationStateResource>((resolve) => {
          resolvePatch = resolve;
        }),
    );
    const { controller } = createController({ now: () => 0, patch: patchSpy });

    controller.queuePatch({ overrides: [] }, ["object:film"]);
    expect(controller.getSnapshot().pendingTargetIds).toEqual(["object:film"]);

    const flush = controller.flushNow();
    expect(controller.getSnapshot().inflightTargetIds).toEqual(["object:film"]);
    expect(controller.getSnapshot().pendingTargetIds).toEqual([]);

    resolvePatch(visualizationState(2, { overrides: [] }));
    await flush;

    expect(controller.getSnapshot().inflightTargetIds).toEqual([]);
    expect(controller.getSnapshot().pendingTargetIds).toEqual([]);
  });
});

  it("rebases rapid planar upsert then remove without disturbing unrelated overrides", async () => {
    const sentPatches: VisualizationStatePatch[] = [];
    const { controller } = createController({
      now: () => 0,
      patch: async (patch) => {
        sentPatches.push(patch);
        return visualizationState(
          12,
          patch as Partial<VisualizationStateResource>,
        );
      },
    });
    const filmOverride = {
      scope: "object" as const,
      scope_id: "film",
      wireframe_style: { color: "#111111", opacity: 0.4 },
    };
    const unrelatedOverride = {
      scope: "object" as const,
      scope_id: "other",
      wireframe_style: { color: "#222222", opacity: 0.5 },
    };
    controller.observeRemoteState(
      visualizationState(10, {
        planar: {
          target_overrides: [filmOverride, unrelatedOverride],
        } as unknown as NonNullable<VisualizationStateResource["planar"]>,
      }),
    );

    controller.queuePlanarTargetOverride({
      kind: "upsert",
      target: { id: "object:film", kind: "object", label: "Film" },
      wireframeStyle: { color: "#abcdef", opacity: 0.25 },
    });
    controller.queuePlanarTargetOverride({
      kind: "remove",
      target: { id: "object:film", kind: "object", label: "Film" },
    });

    expect(controller.getSnapshot()).toMatchObject({
      pendingPlanarTargetIds: ["object:film"],
      pendingTargetIds: [],
    });

    const newestUnrelatedOverride = {
      scope: "part" as const,
      scope_id: "boundary",
      wireframe_style: { color: "#333333", opacity: 0.6 },
    };
    const latest = visualizationState(11, {
      planar: {
        target_overrides: [
          filmOverride,
          unrelatedOverride,
          newestUnrelatedOverride,
        ],
      } as unknown as NonNullable<VisualizationStateResource["planar"]>,
    });
    controller.observeRemoteState(latest);

    const optimistic = controller.applyOptimisticState(latest);
    expect(optimistic?.planar?.target_overrides).toEqual([
      unrelatedOverride,
      newestUnrelatedOverride,
    ]);
    expect(optimistic?.planar?.target_overrides?.[0]).toBe(unrelatedOverride);
    expect(optimistic?.planar?.target_overrides?.[1]).toBe(
      newestUnrelatedOverride,
    );

    await controller.flushNow();

    expect(sentPatches[0]?.planar?.target_overrides).toEqual([
      unrelatedOverride,
      newestUnrelatedOverride,
    ]);
    expect(sentPatches[0]?.planar?.target_overrides?.[0]).toBe(
      unrelatedOverride,
    );
    expect(sentPatches[0]?.planar?.target_overrides?.[1]).toBe(
      newestUnrelatedOverride,
    );
  });

  it("isolates root and planar target ids during mixed optimistic merge and rebase", async () => {
    const sentPatches: VisualizationStatePatch[] = [];
    const { controller } = createController({
      now: () => 0,
      patch: async (patch) => {
        sentPatches.push(patch);
        return visualizationState(
          12,
          patch as Partial<VisualizationStateResource>,
        );
      },
    });
    const rootTarget = {
      scope: "object" as const,
      scope_id: "root-film",
      display: { vectors: { visible: false } },
    };
    const rootCrossChannelEntry = {
      scope: "object" as const,
      scope_id: "planar-film",
      display: { points: { visible: true } },
    };
    const planarTarget = {
      scope: "object" as const,
      scope_id: "planar-film",
      wireframe_style: { color: "#111111", opacity: 0.4 },
    };
    const planarCrossChannelEntry = {
      scope: "object" as const,
      scope_id: "root-film",
      wireframe_style: { color: "#222222", opacity: 0.5 },
    };
    const initial = visualizationState(10, {
      overrides: [rootTarget, rootCrossChannelEntry],
      planar: {
        target_overrides: [planarTarget, planarCrossChannelEntry],
      } as unknown as NonNullable<VisualizationStateResource["planar"]>,
    });
    controller.observeRemoteState(initial);

    controller.queuePatch(
      {
        overrides: [
          {
            scope: "object",
            scope_id: "root-film",
            display: { vectors: { visible: true } },
          },
        ],
      },
      ["object:root-film"],
    );
    controller.queuePlanarTargetOverride({
      kind: "upsert",
      target: {
        id: "object:planar-film",
        kind: "object",
        label: "Planar film",
      },
      wireframeStyle: { color: "#abcdef", opacity: 0.25 },
    });

    expect(controller.getSnapshot()).toMatchObject({
      pendingTargetIds: ["object:root-film"],
      pendingPlanarTargetIds: ["object:planar-film"],
    });

    const latestRootUnrelated = {
      ...rootCrossChannelEntry,
      display: { points: { visible: false } },
    };
    const latestPlanarUnrelated = {
      ...planarCrossChannelEntry,
      wireframe_style: { color: "#333333", opacity: 0.75 },
    };
    const latest = visualizationState(11, {
      overrides: [rootTarget, latestRootUnrelated],
      planar: {
        target_overrides: [planarTarget, latestPlanarUnrelated],
      } as unknown as NonNullable<VisualizationStateResource["planar"]>,
    });
    controller.observeRemoteState(latest);

    const optimistic = controller.applyOptimisticState(latest);
    expect(optimistic?.overrides[0]).toMatchObject({
      scope: "object",
      scope_id: "root-film",
      display: { vectors: { visible: true } },
    });
    expect(optimistic?.overrides).toHaveLength(2);
    expect(optimistic?.overrides[1]).toBe(latestRootUnrelated);
    expect(optimistic?.planar?.target_overrides).toEqual([
      {
        scope: "object",
        scope_id: "planar-film",
        wireframe_style: { color: "#abcdef", opacity: 0.25 },
      },
      latestPlanarUnrelated,
    ]);
    expect(optimistic?.planar?.target_overrides?.[1]).toBe(
      latestPlanarUnrelated,
    );

    await controller.flushNow();

    expect(sentPatches[0]?.overrides?.[1]).toBe(latestRootUnrelated);
    expect(sentPatches[0]?.planar?.target_overrides?.[1]).toBe(
      latestPlanarUnrelated,
    );
    expect(sentPatches[0]?.overrides).toHaveLength(2);
    expect(sentPatches[0]?.planar?.target_overrides).toHaveLength(2);
  });
