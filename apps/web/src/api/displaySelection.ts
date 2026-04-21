import type {
  DisplayPatchRequest,
  DisplaySelection,
} from "./types";

export type DisplayPreviewComponent =
  | "3D"
  | DisplaySelection["field_component"];

export function displaySelectionFromPreviewComponent(
  component: DisplayPreviewComponent,
  fallbackFieldComponent: DisplaySelection["field_component"] = "magnitude",
): Pick<DisplaySelection, "view_mode" | "field_component"> {
  if (component === "3D") {
    return {
      view_mode: "3d",
      field_component: fallbackFieldComponent,
    };
  }
  return {
    view_mode: "2d",
    field_component:
      component === "x" || component === "y" || component === "z"
        ? component
        : "magnitude",
  };
}

export function displayPatchFromPreviewComponent(
  component: DisplayPreviewComponent,
  fallbackFieldComponent: DisplaySelection["field_component"] = "magnitude",
): Pick<DisplayPatchRequest, "view_mode" | "field_component"> {
  return displaySelectionFromPreviewComponent(component, fallbackFieldComponent);
}

export function previewComponentFromDisplaySelection(
  selection: Pick<DisplaySelection, "view_mode" | "field_component">,
): DisplayPreviewComponent {
  return selection.view_mode === "3d" ? "3D" : selection.field_component;
}
