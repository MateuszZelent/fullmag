import { describe, expect, it } from "vitest";

import type { CapabilityMap, DisplaySelection } from "@/src/api/types";
import { buildSlice2DModel } from "@/src/features/slice2d/adapters";
import {
  rebuildSlice2DModelFrame,
  resolveSlice2DFieldRequestState,
  resolveSlice2DFieldRevision,
} from "../slice2DRequestModel";

function display(overrides: Partial<DisplaySelection> = {}): DisplaySelection {
  return {
    active_quantity_id: "m",
    view_mode: "2d",
    field_component: "y",
    colormap: "viridis",
    auto_contrast: true,
    contrast_min: null,
    contrast_max: null,
    vector_glyphs: false,
    vector_density: 4,
    slice_mode: "all_layers",
    slice_layer: 2,
    max_points: 4096,
    x_chosen_size: 128,
    y_chosen_size: 128,
    ...overrides,
  };
}

function capabilities(overrides: Partial<CapabilityMap> = {}): CapabilityMap {
  return {
    structured_grid: false,
    explicit_topology: true,
    binary_fields: true,
    cell_fields: true,
    node_fields: false,
    scalar_history: true,
    eigen_modes: false,
    gpu_telemetry: false,
    preview_2d: true,
    preview_3d: true,
    algorithms_available: [],
    ...overrides,
  };
}

describe("slice2DRequestModel", () => {
  it("prefers resource revisions over legacy step counters", () => {
    expect(
      resolveSlice2DFieldRevision({
        runtimeResourceRevisions: {
          fields_revision: 42,
          field_revision: 41,
        },
        fieldDataRevision: "40",
        liveFieldSourceStep: 39,
        effectiveStep: 38,
      }),
    ).toBe(42);

    expect(
      resolveSlice2DFieldRevision({
        runtimeResourceRevisions: null,
        fieldDataRevision: "17",
        liveFieldSourceStep: 16,
        effectiveStep: 15,
      }),
    ).toBe(17);
  });

  it("rebuilds the FEM slice frame from the merged toolbar state", () => {
    const base = buildSlice2DModel({
      display: display(),
      resources: { domain_generation_id: 1, fields_revision: 2 },
      capabilities: capabilities(),
      adapterKind: "fem",
      planeOptions: { axis: "z", positionPercent: 50 },
    });

    const rebuilt = rebuildSlice2DModelFrame({
      base,
      adapterKind: "fem",
      toolbar: {
        ...base.toolbar,
        axis: "x",
        mode: "all_layers",
        positionPercent: 25,
        component: "z",
        projectionReduction: "rms",
        projectionResolution: 256,
        projectionSamples: 64,
      },
    });

    expect(rebuilt.render.resourceKind).toBe("projection");
    expect(rebuilt.render.sampling).toBe("fem-projection");
    expect(rebuilt.render.query).toMatchObject({
      plane: "yz",
      component: "z",
      reduction: "rms",
      samples: 64,
      x_size: 256,
      y_size: 256,
    });
  });

  it("rebuilds single-slice queries from world position and vector density", () => {
    const base = buildSlice2DModel({
      display: display({ slice_mode: "single", vector_glyphs: false }),
      resources: { domain_generation_id: 1, fields_revision: 2 },
      capabilities: capabilities({ structured_grid: true }),
      adapterKind: "fdm",
      planeOptions: { axis: "y", positionPercent: 50 },
    });

    const rebuilt = rebuildSlice2DModelFrame({
      base,
      adapterKind: "fdm",
      toolbar: {
        ...base.toolbar,
        axis: "y",
        mode: "single",
        positionWorld: 12.5,
        component: "x",
        showVectors: true,
        vectorDensity: 7,
      },
    });

    expect(rebuilt.render.resourceKind).toBe("slice");
    expect(rebuilt.render.sampling).toBe("fdm-layer");
    expect(rebuilt.render.query).toMatchObject({
      plane: "xz",
      component: "x",
      cut_world: 12.5,
      include_arrows: true,
      arrow_every: 7,
      max_arrows: 10_000,
    });
  });

  it("returns an explicit unsupported reason when the API path is enabled but slab is unavailable", () => {
    const model = buildSlice2DModel({
      display: display({ slice_mode: "slab" }),
      resources: { domain_generation_id: 1, fields_revision: 2 },
      capabilities: capabilities({ structured_grid: true }),
      adapterKind: "fdm",
      planeOptions: { axis: "z", positionPercent: 50 },
    });

    expect(
      resolveSlice2DFieldRequestState({
        enabled: true,
        model,
      }),
    ).toEqual({
      kind: null,
      query: null,
      unsupportedReason: "Slab mode is not implemented by the 2D API/renderer yet",
    });
  });

  it("keeps the request state empty when the slice API path is disabled", () => {
    const model = buildSlice2DModel({
      display: display(),
      resources: { domain_generation_id: 1, fields_revision: 2 },
      capabilities: capabilities(),
      adapterKind: "fem",
      planeOptions: { axis: "z", positionPercent: 50 },
    });

    expect(
      resolveSlice2DFieldRequestState({
        enabled: false,
        model,
      }),
    ).toEqual({
      kind: null,
      query: null,
      unsupportedReason: null,
    });
  });
});
