import { describe, expect, it } from "vitest";

import type { CapabilityMap, DisplaySelection } from "../../../api/types";
import {
  buildSlice2DModel,
  createFdmSlice2DAdapter,
  createFemSlice2DAdapter,
  slice2DToolbarFromDisplay,
} from "../adapters";

function display(overrides: Partial<DisplaySelection> = {}): DisplaySelection {
  return {
    active_quantity_id: "m",
    view_mode: "2d",
    field_component: "x",
    colormap: "viridis",
    auto_contrast: true,
    contrast_min: null,
    contrast_max: null,
    vector_glyphs: true,
    vector_density: 4,
    slice_mode: "single",
    slice_layer: 2,
    max_points: 4096,
    x_chosen_size: 64,
    y_chosen_size: 64,
    ...overrides,
  };
}

function capabilities(overrides: Partial<CapabilityMap> = {}): CapabilityMap {
  return {
    structured_grid: true,
    explicit_topology: false,
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

describe("slice2d adapters", () => {
  it("normalizes DisplaySelection into the unified toolbar contract", () => {
    expect(slice2DToolbarFromDisplay(display({ slice_mode: "all_layers" }))).toMatchObject({
      quantityId: "m",
      component: "x",
      axis: "z",
      mode: "all_layers",
      layerIndex: 2,
      showVectors: true,
      renderMode: "vectors",
    });
  });

  it("builds FDM slice queries from the shared slice model", () => {
    const model = buildSlice2DModel({
      display: display(),
      resources: { domain_generation_id: 1, fields_revision: 2 },
      capabilities: capabilities(),
      adapterKind: "fdm",
    });
    expect(model.render.sampling).toBe("fdm-layer");
    expect(model.render.query).toMatchObject({
      plane: "xy",
      component: "x",
      include_arrows: true,
    });
    expect(model.capabilityGates.structured_grid.enabled).toBe(true);
  });

  it("builds FEM plane intersection requests without a separate top-level model", () => {
    const model = buildSlice2DModel({
      display: display({ field_component: "magnitude", vector_glyphs: false }),
      resources: { domain_generation_id: 1, fields_revision: 2 },
      capabilities: capabilities({ structured_grid: false, explicit_topology: true }),
      adapterKind: "fem",
      planeOptions: { axis: "x", positionPercent: 25 },
    });
    expect(model.render.sampling).toBe("fem-plane");
    expect(model.render.resourceKind).toBe("slice");
    expect(model.render.query).toMatchObject({
      plane: "yz",
      component: "magnitude",
      cut_norm: 0.25,
      include_arrows: false,
    });
  });

  it("uses physical cut_world when the FEM toolbar has world bounds", () => {
    const model = buildSlice2DModel({
      display: display({ vector_glyphs: false, x_chosen_size: 96 }),
      resources: { domain_generation_id: 1, fields_revision: 2 },
      capabilities: capabilities({ structured_grid: false, explicit_topology: true }),
      adapterKind: "fem",
      planeOptions: { axis: "z", positionPercent: 50 },
    });
    const frame = createFemSlice2DAdapter({
      preview_2d: true,
      structured_grid: false,
      explicit_topology: true,
      authoring_primitives: true,
      slice_probe: true,
      slice_measure: true,
      slice_profile: true,
      slice_vectors: true,
      slice_all_layers: true,
    }).buildSlice({
      ...model,
      plane: model.plane,
      toolbar: {
        ...model.toolbar,
        positionWorld: 2.5e-8,
        normalAxisBounds: { min: 0, max: 5e-8 },
      },
    });
    expect(frame.query).toMatchObject({
      plane: "xy",
      cut_world: 2.5e-8,
      x_size: 96,
      y_size: 96,
    });
    expect(frame.query).not.toHaveProperty("cut_norm");
  });

  it("builds FEM all-layer projection requests from projection toolbar state", () => {
    const model = buildSlice2DModel({
      display: display({ field_component: "y", slice_mode: "all_layers", vector_glyphs: false }),
      resources: { domain_generation_id: 1, fields_revision: 2 },
      capabilities: capabilities({ structured_grid: false, explicit_topology: true }),
      adapterKind: "fem",
      planeOptions: { axis: "z", positionPercent: 50 },
    });
    const toolbar = {
      ...model.toolbar,
      projectionReduction: "rms" as const,
      projectionIncludeAirAsZero: true,
      projectionSamples: 64,
      projectionResolution: 256,
    };
    const frame = createFemSlice2DAdapter({
      preview_2d: true,
      structured_grid: false,
      explicit_topology: true,
      authoring_primitives: true,
      slice_probe: true,
      slice_measure: true,
      slice_profile: true,
      slice_vectors: true,
      slice_all_layers: true,
    }).buildSlice({ ...model, plane: model.plane, toolbar });
    expect(frame.sampling).toBe("fem-projection");
    expect(frame.resourceKind).toBe("projection");
    expect(frame.query).toMatchObject({
      plane: "xy",
      component: "y",
      reduction: "rms",
      include_air_as_zero: true,
      samples: 64,
      x_size: 256,
      y_size: 256,
    });
  });

  it("keeps unsupported controls visible through disabled capability gates", () => {
    const fdm = createFdmSlice2DAdapter({
      preview_2d: true,
      structured_grid: false,
      explicit_topology: false,
      authoring_primitives: true,
      slice_probe: true,
      slice_measure: true,
      slice_profile: true,
      slice_vectors: true,
      slice_all_layers: false,
    });
    const frame = fdm.buildSlice({
      quantity: {
        activeQuantityId: "m",
        component: "magnitude",
        colormap: "viridis",
        autoContrast: true,
        contrastMin: null,
        contrastMax: null,
      },
      plane: {
        axis: "z",
        mode: "single",
        positionPercent: 50,
        layerIndex: 0,
        thicknessPercent: null,
        syncWith3DClip: false,
      },
      toolbar: slice2DToolbarFromDisplay(display()),
      revisions: {
        domainGenerationId: 1,
        topologyRevision: null,
        fieldsRevision: 2,
        scalarsRevision: null,
        displayRevision: null,
        meshRevision: null,
        meshBuildRevision: null,
        sceneRevision: null,
      },
    });
    expect(frame.sampling).toBe("unavailable");
    expect(frame.diagnostics[0]).toBe("Requires structured_grid capability");
  });

  it("keeps FEM disabled until explicit topology is available", () => {
    const fem = createFemSlice2DAdapter({
      preview_2d: true,
      structured_grid: true,
      explicit_topology: false,
      authoring_primitives: true,
      slice_probe: true,
      slice_measure: true,
      slice_profile: true,
      slice_vectors: true,
      slice_all_layers: true,
    });
    const frame = fem.buildSlice({
      quantity: {
        activeQuantityId: "m",
        component: "magnitude",
        colormap: "viridis",
        autoContrast: true,
        contrastMin: null,
        contrastMax: null,
      },
      plane: {
        axis: "z",
        mode: "single",
        positionPercent: 50,
        layerIndex: 0,
        thicknessPercent: null,
        syncWith3DClip: false,
      },
      toolbar: slice2DToolbarFromDisplay(display()),
      revisions: {
        domainGenerationId: 1,
        topologyRevision: null,
        fieldsRevision: 2,
        scalarsRevision: null,
        displayRevision: null,
        meshRevision: null,
        meshBuildRevision: null,
        sceneRevision: null,
      },
    });
    expect(frame.sampling).toBe("unavailable");
    expect(frame.diagnostics[0]).toBe("Requires explicit_topology capability");
  });
});
