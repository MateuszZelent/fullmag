import { describe, expect, it } from "vitest";

import {
  DEFAULT_AIRBOX_VISUALIZATION,
  DEFAULT_OBJECT_VISUALIZATION,
  ObjectVisualizationController,
  resolveEffectiveVisualizationSettings,
  resolveTargetVisualization,
} from "@/kernel/visualization/ObjectVisualizationController";

import {
  buildAirboxVisibilityDiagnostic,
  buildVisualizationPanelSections,
  colorPickerInputValue,
  SURFACE_COLOR_SOURCE_ITEMS,
  surfaceDisplayPassPatch,
  surfaceSolidColorPatch,
  VISUALIZATION_COLOR_MODE_ITEMS,
  VISUALIZATION_QUANTITY_ITEMS,
  visualizationQuantityItems,
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

  it("exposes target quantity options for the inspector visualization panel", () => {
    expect(VISUALIZATION_QUANTITY_ITEMS.map((item) => item.value)).toEqual([
      "m",
      "h_eff",
      "h_demag",
      "h_ex",
      "h_ani",
      "eden_total",
      "eden_ex",
      "eden_demag",
      "eden_ext",
      "eden_ani",
      "eden_dmi",
    ]);
    expect(visualizationQuantityItems("exchange_field")[0]).toEqual({
      label: "exchange_field",
      value: "exchange_field",
    });
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
      "quantity-source",
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
    expect(sections.find((section) => section.id === "quantity-source"))
      .toMatchObject({
        disabled: false,
        fields: [expect.objectContaining({ id: "activeQuantityId" })],
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
      "activeQuantityId",
      "shaderMonoColor",
      "wireframeColor",
      "wireframeOpacityPercent",
      "vectorColorMode",
      "vectorMonoColor",
      "vectorAlphaPercent",
      "vectorThickness",
    ]));
  });

  it("explains an airbox Visible request that is still off in backend state", () => {
    const diagnostic = buildAirboxVisibilityDiagnostic({
      displaySettings: {
        ...DEFAULT_AIRBOX_VISUALIZATION,
        visible: false,
        wireframeVisible: true,
      },
      renderWarning: null,
      settings: {
        ...DEFAULT_AIRBOX_VISUALIZATION,
        visible: false,
        wireframeVisible: true,
      },
    });

    expect(diagnostic).toMatchObject({
      status: "backend-off",
      title: "Airbox visibility not confirmed",
    });
    expect(diagnostic?.message).toContain("layers.airbox.visible=false");
    expect(diagnostic?.details).toEqual(
      expect.arrayContaining([
        { label: "Backend master", value: "off" },
        { label: "Wireframe pass", value: "on" },
      ]),
    );
  });

  it("confirms when airbox master visibility and a drawable pass are both active", () => {
    const diagnostic = buildAirboxVisibilityDiagnostic({
      displaySettings: {
        ...DEFAULT_AIRBOX_VISUALIZATION,
        visible: true,
        wireframeVisible: true,
      },
      renderWarning: null,
      settings: {
        ...DEFAULT_AIRBOX_VISUALIZATION,
        visible: true,
        wireframeVisible: true,
      },
    });

    expect(diagnostic).toMatchObject({
      status: "confirmed",
      title: "Airbox visibility confirmed",
    });
  });
});
