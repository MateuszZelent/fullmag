import { describe, expect, it } from "vitest";

import { DEFAULT_OBJECT_VISUALIZATION } from "@/kernel/visualization/ObjectVisualizationController";

import { resolveVectorFieldLayerStyle } from "./VectorFieldLayer";
import {
  shaderColorFromSettings,
  shaderUsesVertexColors,
  surfaceScalarColorModeFromSettings,
  vectorColorModeFromSettings,
  vectorStyleFromSettings,
  wireframeOpacityFromSettings,
} from "./viewport3DLayerSettings";

describe("VectorFieldLayer style mapping", () => {
  it("maps canonical vector style into material alpha, monochrome color, and glyph thickness", () => {
    expect(
      resolveVectorFieldLayerStyle({
        colorMode: "monochrome",
        fallbackColor: "#55ccff",
        opacity: 0.5,
        style: {
          alpha: 0.4,
          monoColor: "#ff3366",
          thickness: 2,
        },
      }),
    ).toEqual({
      headRadiusRatio: 0.40,
      materialColor: "#ff3366",
      materialOpacity: 0.2,
      shaftRadiusRatio: 0.16,
    });
  });

  it("applies glyph material profile opacity to vector style", () => {
    expect(
      resolveVectorFieldLayerStyle({
        colorMode: "monochrome",
        fallbackColor: "#55ccff",
        opacity: 0.5 * 0.8,
        style: {
          alpha: 0.5,
          monoColor: "#ff3366",
          thickness: 1,
        },
      }).materialOpacity,
    ).toBe(0.2);
  });

  it("maps target display settings into shader wireframe and vector layer styles", () => {
    const settings = {
      ...DEFAULT_OBJECT_VISUALIZATION,
      opacityPercent: 50,
      shaderColorMode: "monochrome",
      shaderMonoColor: "#ff3366",
      surfaceColorSource: "solid",
      vectorAlphaPercent: 40,
      vectorColorMode: "x",
      vectorMonoColor: "#44ccff",
      vectorThickness: 2,
      wireframeOpacityPercent: 30,
    } as const;

    expect(shaderColorFromSettings(settings, "#dddddd")).toBe("#ff3366");
    expect(shaderUsesVertexColors(settings)).toBe(false);
    expect(surfaceScalarColorModeFromSettings(settings)).toBeNull();
    expect(wireframeOpacityFromSettings(settings)).toBe(0.15);
    expect(
      wireframeOpacityFromSettings(settings, { opacity: 0.42 }),
    ).toBe(0.063);
    expect(vectorColorModeFromSettings(settings, "orientation")).toBe("x");
    expect(vectorStyleFromSettings(settings, {})).toEqual({
      alpha: 0.4,
      monoColor: "#44ccff",
      thickness: 2,
    });
  });

  it("maps non-solid surface coloring sources to scalar color modes", () => {
    const settings = {
      ...DEFAULT_OBJECT_VISUALIZATION,
      surfaceColorSource: "component_z",
    } as const;

    expect(shaderUsesVertexColors(settings)).toBe(true);
    expect(surfaceScalarColorModeFromSettings(settings)).toBe("z");
  });
});
