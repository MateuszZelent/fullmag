import { describe, expect, it } from "vitest";

import {
  displayPatchFromPreviewComponent,
  displaySelectionFromPreviewComponent,
  previewComponentFromDisplaySelection,
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
});

