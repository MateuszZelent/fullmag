import { describe, expect, it } from "vitest";

import {
  DEFAULT_OBJECT_VISUALIZATION,
  ObjectVisualizationController,
  resolveEffectiveVisualizationSettings,
  resolveTargetVisualization,
} from "@/kernel/visualization/ObjectVisualizationController";

import {
  buildVisualizationPanelSections,
  colorPickerInputValue,
  SURFACE_COLOR_SOURCE_ITEMS,
  surfaceDisplayPassPatch,
  surfaceSolidColorPatch,
  VISUALIZATION_COLOR_MODE_ITEMS,
} from "./ObjectVisualizationPanelModel";

describe("ObjectVisualizationPanelModel", () => {
  it("exposes the surface color source options used by Surface Coloring", () => {
    expect(SURFACE_COLOR_SOURCE_ITEMS.map((item) => item.value)).toEqual([
      "solid",
      "orientation",
      "component_x",
      "component_y",
      "component_z",
      "magnitude",
      "colormap",
    ]);
  });

  it("exposes the production color mode options used by Global Display", () => {
    expect(VISUALIZATION_COLOR_MODE_ITEMS.map((item) => item.value)).toEqual([
      "orientation",
      "x",
      "y",
      "z",
      "magnitude",
      "monochrome",
    ]);
  });

  it("keeps color picker input compatible with CSS token defaults", () => {
    expect(colorPickerInputValue("#00ffaa")).toBe("#00ffaa");
    expect(colorPickerInputValue("#00FFAA")).toBe("#00FFAA");
    expect(colorPickerInputValue("var(--fm-surface-magnetic)")).toBe("#ffffff");
  });

  it("turns a surface color picker value into a visible solid-color patch", () => {
    expect(surfaceSolidColorPatch("#00ffaa")).toEqual({
      shaderMonoColor: "#00ffaa",
      surfaceColorSource: "solid",
    });
  });

  it("turns the Surface display pass into surface-only rendering", () => {
    expect(surfaceDisplayPassPatch(DEFAULT_OBJECT_VISUALIZATION)).toMatchObject({
      pointsVisible: false,
      renderMode: "surface",
      shaderVisible: true,
      wireframeVisible: false,
    });
  });

  it("lets an already surface-only display pass toggle the surface off", () => {
    expect(
      surfaceDisplayPassPatch({
        ...DEFAULT_OBJECT_VISUALIZATION,
        pointsVisible: false,
        renderMode: "surface",
        shaderVisible: true,
        wireframeVisible: false,
      }),
    ).toEqual({ shaderVisible: false });
  });

  it("builds pass-specific sections for a visible object target", () => {
    const sections = buildVisualizationPanelSections({
      effectiveSettings: resolveEffectiveVisualizationSettings(
        DEFAULT_OBJECT_VISUALIZATION,
      ),
      settings: DEFAULT_OBJECT_VISUALIZATION,
    });

    expect(sections.map((section) => section.id)).toEqual([
      "display-passes",
      "surface-coloring",
      "wireframe",
      "vectors",
      "geometry-scope",
      "opacity",
      "overrides",
    ]);
    expect(sections.find((section) => section.id === "surface-coloring"))
      .toMatchObject({
        disabled: false,
        fields: expect.arrayContaining([
          expect.objectContaining({ id: "surfaceColorSource" }),
          expect.objectContaining({ id: "shaderMonoColor" }),
        ]),
      });
  });

  it("marks pass-specific controls inactive while preserving configured values", () => {
    const hidden = {
      ...DEFAULT_OBJECT_VISUALIZATION,
      vectorsVisible: true,
      visible: false,
    };
    const sections = buildVisualizationPanelSections({
      effectiveSettings: resolveEffectiveVisualizationSettings(hidden),
      settings: hidden,
    });

    expect(sections.find((section) => section.id === "surface-coloring"))
      .toMatchObject({ disabled: true });
    expect(sections.find((section) => section.id === "vectors"))
      .toMatchObject({ disabled: true });
  });

  it("keeps object vector controls active when the target inherits global vector visibility", () => {
    const visualization = new ObjectVisualizationController();
    const resolved = resolveTargetVisualization({
      snapshot: visualization.getSnapshot(),
      target: {
        id: "free-layer",
        kind: "object",
        label: "Free layer",
      },
      visualizationState: {
        layers: {
          vectors: {
            density: 512,
            domain: "full_domain",
            visible: true,
          },
        },
        revision: 11,
        vector_glyphs: true,
      } as never,
    });
    const sections = buildVisualizationPanelSections({
      effectiveSettings: resolved.effectiveSettings,
      settings: resolved.settings,
    });

    expect(resolved.settings.vectorsVisible).toBe(true);
    expect(sections.find((section) => section.id === "vectors")).toMatchObject({
      disabled: false,
    });
  });

  it("keeps surface vector and wireframe fields addressable by target setting keys", () => {
    const sections = buildVisualizationPanelSections({
      effectiveSettings: resolveEffectiveVisualizationSettings(
        DEFAULT_OBJECT_VISUALIZATION,
      ),
      settings: DEFAULT_OBJECT_VISUALIZATION,
    });
    const fieldIds = sections.flatMap((section) =>
      section.fields.map((field) => field.id),
    );

    expect(fieldIds).toEqual(expect.arrayContaining([
      "surfaceColorSource",
      "shaderMonoColor",
      "wireframeColor",
      "wireframeOpacityPercent",
      "vectorColorMode",
      "vectorMonoColor",
      "vectorAlphaPercent",
      "vectorThickness",
    ]));
  });
});
