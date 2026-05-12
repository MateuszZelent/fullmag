import type {
  SurfaceColorSource,
  VisualizationColorMode,
  VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";

export const SURFACE_COLOR_SOURCE_ITEMS: Array<{
  label: string;
  value: SurfaceColorSource;
}> = [
  { value: "solid", label: "Solid (plain material)" },
  { value: "orientation", label: "HSL orientation" },
  { value: "component_x", label: "Component X" },
  { value: "component_y", label: "Component Y" },
  { value: "component_z", label: "Component Z" },
  { value: "magnitude", label: "Magnitude |m|" },
  { value: "colormap", label: "Colormap" },
];

export const VISUALIZATION_COLOR_MODE_ITEMS: Array<{
  label: string;
  value: VisualizationColorMode;
}> = [
  { value: "orientation", label: "HSL orientation" },
  { value: "x", label: "X component" },
  { value: "y", label: "Y component" },
  { value: "z", label: "Z component" },
  { value: "magnitude", label: "Magnitude" },
  { value: "monochrome", label: "Monochrome" },
];

export interface VisualizationPanelField {
  id: keyof VisualizationTargetSettings;
  kind: "color" | "mode" | "number" | "toggle";
  label: string;
}

export interface VisualizationPanelSection {
  disabled: boolean;
  fields: VisualizationPanelField[];
  id:
    | "display-passes"
    | "geometry-scope"
    | "opacity"
    | "overrides"
    | "surface-coloring"
    | "vectors"
    | "wireframe";
  title: string;
}

export function buildVisualizationPanelSections({
  effectiveSettings,
  settings,
}: {
  effectiveSettings: VisualizationTargetSettings;
  settings: VisualizationTargetSettings;
}): VisualizationPanelSection[] {
  const passDisabled = !settings.visible;

  return [
    {
      disabled: false,
      fields: [
        { id: "visible", kind: "toggle", label: "Visible" },
        { id: "shaderVisible", kind: "toggle", label: "Surface" },
        { id: "wireframeVisible", kind: "toggle", label: "Wireframe" },
        { id: "boundsVisible", kind: "toggle", label: "Frame" },
        { id: "pointsVisible", kind: "toggle", label: "Points" },
        { id: "vectorsVisible", kind: "toggle", label: "Vectors" },
      ],
      id: "display-passes",
      title: "Display Passes",
    },
    {
      disabled: passDisabled || !effectiveSettings.shaderVisible,
      fields: [
        { id: "surfaceColorSource", kind: "mode", label: "Color source" },
        { id: "shaderMonoColor", kind: "color", label: "Solid color" },
      ],
      id: "surface-coloring",
      title: "Surface Coloring",
    },
    {
      disabled: passDisabled || !effectiveSettings.wireframeVisible,
      fields: [
        { id: "wireframeColor", kind: "color", label: "Wireframe color" },
        {
          id: "wireframeOpacityPercent",
          kind: "number",
          label: "Wireframe opacity",
        },
      ],
      id: "wireframe",
      title: "Wireframe",
    },
    {
      disabled: passDisabled || !effectiveSettings.vectorsVisible,
      fields: [
        { id: "vectorColorMode", kind: "mode", label: "Vector coloring" },
        { id: "vectorMonoColor", kind: "color", label: "Vector mono color" },
        { id: "vectorAlphaPercent", kind: "number", label: "Vector alpha" },
        { id: "vectorThickness", kind: "number", label: "Vector thickness" },
      ],
      id: "vectors",
      title: "Vectors",
    },
    {
      disabled: passDisabled,
      fields: [{ id: "geometryScope", kind: "mode", label: "Geometry scope" }],
      id: "geometry-scope",
      title: "Geometry Scope",
    },
    {
      disabled: false,
      fields: [{ id: "opacityPercent", kind: "number", label: "Opacity" }],
      id: "opacity",
      title: "Opacity",
    },
    {
      disabled: false,
      fields: [],
      id: "overrides",
      title: "Overrides",
    },
  ];
}
