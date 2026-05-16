import { describe, expect, it } from "vitest";

import {
  displayPatchFromPreviewComponent,
  displayPatchFromPreviewComponentOnly,
  displaySelectionFromPreviewComponent,
  previewComponentFromDisplaySelection,
  quantitySelectionStateFromDisplaySelection,
  slicePlaneStateFromDisplaySelection,
} from "../displaySelection";

describe("displaySelection helpers", () => {
  it("maps 3D preview component to 3d mode with vector glyphs enabled", () => {
    const selection = displaySelectionFromPreviewComponent("3D", "magnitude");
    expect(selection).toEqual({
      view_mode: "3d",
      field_component: "magnitude",
      vector_glyphs: true,
    });
  });

  it("maps planar component to 2d mode with vector glyphs disabled", () => {
    const selection = displaySelectionFromPreviewComponent("x", "magnitude");
    expect(selection).toEqual({
      view_mode: "2d",
      field_component: "x",
      vector_glyphs: false,
    });
  });

  it("returns patch with vector_glyphs to keep display contract deterministic", () => {
    const patch = displayPatchFromPreviewComponent("3D", "z");
    expect(patch).toEqual({
      view_mode: "3d",
      field_component: "z",
      vector_glyphs: true,
    });
  });

  it("returns component-only patch when vector visibility must stay independent", () => {
    const patch = displayPatchFromPreviewComponentOnly("3D", "z");
    expect(patch).toEqual({
      view_mode: "3d",
      field_component: "z",
    });
    expect("vector_glyphs" in patch).toBe(false);
  });

  it("maps selection back to preview component", () => {
    expect(previewComponentFromDisplaySelection({
      view_mode: "3d",
      field_component: "x",
    })).toBe("3D");
    expect(previewComponentFromDisplaySelection({
      view_mode: "2d",
      field_component: "y",
    })).toBe("y");
  });

  it("normalizes display selection to shared quantity and slice contracts", () => {
    const selection = {
      active_quantity_id: "m",
      view_mode: "2d" as const,
      field_component: "z" as const,
      colormap: "magma",
      auto_contrast: false,
      contrast_min: -1,
      contrast_max: 1,
      slice_mode: "slab",
      slice_layer: 5,
    };
    expect(quantitySelectionStateFromDisplaySelection(selection)).toEqual({
      activeQuantityId: "m",
      component: "z",
      colormap: "magma",
      autoContrast: false,
      contrastMin: -1,
      contrastMax: 1,
    });
    expect(slicePlaneStateFromDisplaySelection(selection, { axis: "y" })).toMatchObject({
      axis: "y",
      mode: "slab",
      layerIndex: 5,
    });
  });
});
