import type {
  DisplayPatchRequest,
  DisplaySelection,
} from "./types";
import {
  quantitySelectionFromDisplay,
  slicePlaneFromDisplay,
  type QuantitySelectionState,
  type SlicePlaneState,
} from "../features/workspaceSync/contracts";

export type DisplayPreviewComponent =
  | "3D"
  | DisplaySelection["field_component"];

export function displaySelectionFromPreviewComponent(
  component: DisplayPreviewComponent,
  fallbackFieldComponent: DisplaySelection["field_component"] = "magnitude",
): Pick<DisplaySelection, "view_mode" | "field_component" | "vector_glyphs"> {
  if (component === "3D") {
    return {
      view_mode: "3d",
      field_component: fallbackFieldComponent,
      vector_glyphs: true,
    };
  }
  return {
    view_mode: "2d",
    field_component:
      component === "x" || component === "y" || component === "z"
        ? component
        : "magnitude",
    vector_glyphs: false,
  };
}

export function displayPatchFromPreviewComponent(
  component: DisplayPreviewComponent,
  fallbackFieldComponent: DisplaySelection["field_component"] = "magnitude",
): Pick<DisplayPatchRequest, "view_mode" | "field_component" | "vector_glyphs"> {
  return displaySelectionFromPreviewComponent(component, fallbackFieldComponent);
}

export function previewComponentFromDisplaySelection(
  selection: Pick<DisplaySelection, "view_mode" | "field_component">,
): DisplayPreviewComponent {
  return selection.view_mode === "3d" ? "3D" : selection.field_component;
}

export function quantitySelectionStateFromDisplaySelection(
  selection: Pick<
    DisplaySelection,
    | "active_quantity_id"
    | "view_mode"
    | "field_component"
    | "colormap"
    | "auto_contrast"
    | "contrast_min"
    | "contrast_max"
  >,
): QuantitySelectionState {
  return quantitySelectionFromDisplay(selection);
}

export function slicePlaneStateFromDisplaySelection(
  selection: Pick<DisplaySelection, "slice_mode" | "slice_layer">,
  options?: Parameters<typeof slicePlaneFromDisplay>[1],
): SlicePlaneState {
  return slicePlaneFromDisplay(selection, options);
}
