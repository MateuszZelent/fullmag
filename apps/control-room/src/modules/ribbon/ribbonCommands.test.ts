import { describe, expect, it, vi } from "vitest";

import type {
  VisualizationStatePatch,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import { VISUALIZATION_STATE_PATH } from "@/kernel/api/apiPaths";
import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import type { CommandContext } from "@/kernel/commands/commandTypes";
import {
  AnalysisFieldOverlayController,
  type AnalysisFieldOverlayState,
} from "@/kernel/visualization/AnalysisFieldOverlayController";

import {
  globalQuantityCommandInput,
  RIBBON_COMMANDS,
  RIBBON_VISUALIZATION_APPLY_GLOBAL_QUANTITY_COMMAND,
} from "./ribbonCommands";

function overlayForOwner(
  runId: string,
  stageId: string,
  artifactRevision: number,
): AnalysisFieldOverlayState {
  return {
    fieldId: "analysis:eigen:sample-0:mode-1",
    label: "Mode 1",
    modeIndex: 1,
    modeIntent: {
      analysisRunId: runId,
      analysisStageId: stageId,
      artifactRevision: String(artifactRevision),
      fieldId: "analysis:eigen:sample-0:mode-1",
      metadataResourceKey: `analysis/${runId}/${stageId}/mode-1/meta`,
      modeId: "sample-0/mode-1",
      modeIndex: 1,
      nodeId: `results:${runId}:${stageId}:mode-1`,
      sampleId: "sample-0",
      sampleIndex: 0,
    },
    provenance: {
      artifactRevision: String(artifactRevision),
      resourceRef: "data/fields/analysis:eigen:sample-0:mode-1",
      runId,
      stageId,
    },
    query: { view: "phase_rotated_real" },
    sampleIndex: 0,
    source: "eigen-mode",
  };
}

function visualizationState(revision: number): VisualizationStateResource {
  return {
    active_quantity_id: "H_eff",
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
      active_scope: "full",
    },
    fdm: {
      x_chosen_size: 0,
      y_chosen_size: 0,
    },
    fem: {
      topology_mode: "auto",
      volume_edges_budget: 100_000,
    },
    field_component: "magnitude",
    layers: {
      airbox: {
        bounds: { opacity: 1, visible: false },
        opacity: 0.28,
        points: { opacity: 1, visible: false },
        surface: { opacity: 0.28, visible: false },
        vectors: { density: 50, domain: "auto", visible: false },
        visible: false,
        wireframe: { opacity: 1, visible: false },
      },
      bounds: {
        opacity: 1,
        visible: false,
      },
      points: {
        opacity: 1,
        visible: false,
      },
      primitives: {
        opacity: 1,
        visible: true,
      },
      quantity_overlay: {
        opacity: 1,
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
        opacity: 1,
        visible: false,
      },
      volume_mesh: {
        opacity: 1,
        visible: false,
      },
    },
    max_points: 16_384,
    overrides: [],
    quantity: {
      active_quantity_id: "H_eff",
      auto_contrast: true,
      colormap: "viridis",
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
      airbox_render_mode: "wireframe",
      auto_contrast: true,
      axis: "z",
      colormap: "viridis",
      component: "magnitude",
      layer_index: 0,
      mesh_color_scale: "viridis",
      mesh_filter_expression: "",
      mesh_quality_metric: "skewness",
      mesh_shrink_factor: 1,
      mode: "single",
      position_percent: 50,
      projection_include_air_as_zero: false,
      projection_reduction: "mean_occupied",
      projection_resolution: 128,
      projection_samples: 32,
      quantity_id: "H_eff",
      render_mode: "heatmap",
      show_airbox: false,
      show_airbox_vectors: false,
      show_magnetic_texture: true,
      show_mesh: false,
      show_primitives: true,
      show_quantity: true,
      show_vectors: false,
      thickness_percent: null,
    },
    slice_layer: 0,
    slice_mode: "single",
    trim: {
      axes: {
        x: { enabled: false, max_percent: 100, min_percent: 0 },
        y: { enabled: false, max_percent: 100, min_percent: 0 },
        z: { enabled: false, max_percent: 100, min_percent: 0 },
      },
      enabled: false,
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
  } satisfies VisualizationStateResource;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function executeGlobalQuantityCommand(
  overlay: AnalysisFieldOverlayController,
  patch: (value: VisualizationStatePatch) => Promise<VisualizationStateResource>,
) {
  const command = RIBBON_COMMANDS.find(
    ({ id }) => id === RIBBON_VISUALIZATION_APPLY_GLOBAL_QUANTITY_COMMAND,
  );
  if (!command) throw new Error("Global quantity command is not registered.");

  const registry = new CommandRegistry();
  registry.register(command);
  const context: CommandContext = {
    analysisFieldOverlay: overlay,
    api: { visualization: { patch } } as unknown as NonNullable<CommandContext["api"]>,
    resourceData: {
      [VISUALIZATION_STATE_PATH]: visualizationState(7),
    },
    source: "test",
  };
  return registry.execute(
    RIBBON_VISUALIZATION_APPLY_GLOBAL_QUANTITY_COMMAND,
    context,
    globalQuantityCommandInput("H_eff", true),
  );
}

describe("Ribbon global quantity overlay cleanup", () => {
  it("clears the original overlay after the quantity patch is acknowledged", async () => {
    const overlay = new AnalysisFieldOverlayController();
    overlay.set(overlayForOwner("run-1", "stage-1", 4));
    const patch = vi.fn(async () => visualizationState(8));

    const result = await executeGlobalQuantityCommand(overlay, patch);

    expect(result.status).toBe("completed");
    expect(overlay.getSnapshot()).toBeNull();
  });

  it("preserves a newer typed overlay when an older patch ACK arrives", async () => {
    const overlay = new AnalysisFieldOverlayController();
    overlay.set(overlayForOwner("run-old", "stage-old", 4));
    const acknowledgement = deferred<VisualizationStateResource>();
    const patch = vi.fn(() => acknowledgement.promise);

    const pendingCommand = executeGlobalQuantityCommand(overlay, patch);
    expect(patch).toHaveBeenCalledOnce();

    overlay.set(overlayForOwner("run-new", "stage-new", 5));
    const newerOverlay = overlay.getSnapshot();
    acknowledgement.resolve(visualizationState(8));

    const result = await pendingCommand;

    expect(result.status).toBe("completed");
    expect(overlay.getSnapshot()).toBe(newerOverlay);
    expect(overlay.getSnapshot()).toMatchObject({
      fieldId: "analysis:eigen:sample-0:mode-1",
      modeIntent: {
        analysisRunId: "run-new",
        analysisStageId: "stage-new",
        artifactRevision: "5",
      },
      provenance: {
        artifactRevision: "5",
        runId: "run-new",
        stageId: "stage-new",
      },
    });
  });

  it("preserves an overlay created during the patch when none existed initially", async () => {
    const overlay = new AnalysisFieldOverlayController();
    const acknowledgement = deferred<VisualizationStateResource>();
    const patch = vi.fn(() => acknowledgement.promise);

    const pendingCommand = executeGlobalQuantityCommand(overlay, patch);
    expect(patch).toHaveBeenCalledOnce();

    overlay.set(overlayForOwner("run-new", "stage-new", 5));
    const newerOverlay = overlay.getSnapshot();
    acknowledgement.resolve(visualizationState(8));

    const result = await pendingCommand;

    expect(result.status).toBe("completed");
    expect(overlay.getSnapshot()).toBe(newerOverlay);
  });

  it("preserves the original overlay when the quantity patch is rejected", async () => {
    const overlay = new AnalysisFieldOverlayController();
    overlay.set(overlayForOwner("run-1", "stage-1", 4));
    const originalOverlay = overlay.getSnapshot();
    const patch = vi.fn(async () => {
      throw new Error("visualization update rejected");
    });

    const result = await executeGlobalQuantityCommand(overlay, patch);

    expect(result.status).toBe("failed");
    expect(overlay.getSnapshot()).toBe(originalOverlay);
  });
});
