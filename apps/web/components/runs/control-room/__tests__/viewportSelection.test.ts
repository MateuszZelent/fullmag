import { describe, expect, it } from "vitest";

import type { SpatialPreviewState } from "@/lib/session/types";

import {
  resolveViewportSelectedObjectId,
  selectViewportVectorField,
} from "../viewportSelection";

function makePreview(args: Partial<SpatialPreviewState> = {}): SpatialPreviewState {
  return {
    kind: "spatial",
    display_kind: "vector_field",
    config_revision: 7,
    source_step: 3,
    source_time: 1.5e-12,
    spatial_kind: "grid",
    quantity: "m",
    unit: "dimensionless",
    quantity_domain: "magnetic_only",
    component: "3D",
    layer: 0,
    all_layers: false,
    type: "3D",
    vector_payload_id: null,
    vector_field_values: new Float64Array([1, 0, 0]),
    scalar_field: [],
    min: -1,
    max: 1,
    n_comp: 3,
    max_points: 16384,
    data_points_count: 1,
    x_possible_sizes: [],
    y_possible_sizes: [],
    x_chosen_size: 0,
    y_chosen_size: 0,
    applied_x_chosen_size: 0,
    applied_y_chosen_size: 0,
    applied_layer_stride: 1,
    auto_scale_enabled: true,
    auto_downscaled: false,
    auto_downscale_message: null,
    preview_grid: [1, 1, 1],
    fem_mesh: null,
    original_node_count: null,
    original_face_count: null,
    active_mask: null,
    ...args,
  };
}

describe("resolveViewportSelectedObjectId", () => {
  it("keeps the explicit object selection when one exists", () => {
    expect(
      resolveViewportSelectedObjectId({
        selectedObjectId: "disk",
        selectedSidebarNodeId: "study",
        stickyObjectId: "old-disk",
      }),
    ).toBe("disk");
  });

  it("preserves the last spatial object while navigating study nodes", () => {
    expect(
      resolveViewportSelectedObjectId({
        selectedObjectId: null,
        selectedSidebarNodeId: "study-stage-node:relax-1",
        stickyObjectId: "disk",
      }),
    ).toBe("disk");
  });

  it("drops the sticky object on non-study navigation", () => {
    expect(
      resolveViewportSelectedObjectId({
        selectedObjectId: null,
        selectedSidebarNodeId: "results",
        stickyObjectId: "disk",
      }),
    ).toBeNull();
  });
});

describe("selectViewportVectorField", () => {
  it("prefers preview vectors when the requested preview still targets the active quantity", () => {
    const previewVectors = new Float64Array([0, 1, 0]);
    const liveVectors = new Float64Array([1, 0, 0]);
    const result = selectViewportVectorField({
      activeQuantityId: "m",
      requestedPreviewQuantity: "m",
      previewControlsActive: true,
      renderPreview: makePreview({ quantity: "", vector_field_values: previewVectors }),
      liveField: liveVectors,
      isGlobalScalarQuantity: () => false,
    });

    expect(result.source).toBe("preview");
    expect(result.vectors).toBe(previewVectors);
  });

  it("falls back to live vectors when preview targets a different quantity", () => {
    const liveVectors = new Float64Array([1, 0, 0]);
    const result = selectViewportVectorField({
      activeQuantityId: "m",
      requestedPreviewQuantity: "h_eff",
      previewControlsActive: true,
      renderPreview: makePreview({ quantity: "h_eff" }),
      liveField: liveVectors,
      isGlobalScalarQuantity: () => false,
    });

    expect(result.source).toBe("live");
    expect(result.vectors).toBe(liveVectors);
  });

  it("returns no vectors for global scalar quantities", () => {
    const result = selectViewportVectorField({
      activeQuantityId: "e_total",
      requestedPreviewQuantity: "e_total",
      previewControlsActive: true,
      renderPreview: makePreview(),
      liveField: new Float64Array([1, 0, 0]),
      isGlobalScalarQuantity: (quantity) => quantity === "e_total",
    });

    expect(result.source).toBe("none");
    expect(result.vectors).toBeNull();
  });
});
