import { describe, expect, it } from "vitest";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

import {
  resolveCameraInteractionSettings,
  resolveMeshPartSurfaceMaterialColor,
  surfaceMaterialColorFromSettings,
  VERTEX_COLOR_MATERIAL_COLOR,
} from "./viewport3DLayerSettings";

function settings(
  patch: Partial<VisualizationTargetSettings> = {},
): VisualizationTargetSettings {
  return {
    activeQuantityId: "m",
    boundsVisible: false,
    geometryScope: "full",
    opacityPercent: 100,
    pointsVisible: false,
    renderMode: "surface",
    shaderColorMode: "orientation",
    shaderMonoColor: "#123456",
    shaderVisible: true,
    surfaceColorSource: "orientation",
    vectorAlphaPercent: 100,
    vectorBudget: 12,
    vectorCenteringEnabled: true,
    vectorColorMode: "orientation",
    vectorLengthScale: 1,
    vectorMonoColor: "#00c2ff",
    vectorSurfaceOffsetEnabled: false,
    vectorSurfaceOffsetScale: 0.1,
    vectorThickness: 1,
    vectorsVisible: false,
    visible: true,
    wireframeColor: "#666666",
    wireframeOpacityPercent: 100,
    wireframeVisible: false,
    ...patch,
  };
}

describe("surfaceMaterialColorFromSettings", () => {
  it("uses a white material base when scalar vertex colors are active", () => {
    expect(
      surfaceMaterialColorFromSettings(settings(), "#313244", true),
    ).toBe(VERTEX_COLOR_MATERIAL_COLOR);
  });

  it("preserves monochrome surface color when vertex colors are inactive", () => {
    expect(
      surfaceMaterialColorFromSettings(
        settings({
          shaderColorMode: "monochrome",
          shaderMonoColor: "#abcdef",
          surfaceColorSource: "solid",
        }),
        "#313244",
        false,
      ),
    ).toBe("#abcdef");
  });
});

describe("resolveMeshPartSurfaceMaterialColor", () => {
  it("uses neutral mesh color instead of magnetization preview when field colors are missing", () => {
    expect(
      resolveMeshPartSurfaceMaterialColor(
        settings({ surfaceColorSource: "orientation" }),
        "#313244",
        "#c255f0",
        false,
      ),
    ).toBe("#313244");
  });
});

describe("resolveCameraInteractionSettings", () => {
  it("uses a cheaper temporary layer set during active camera drag", () => {
    expect(
      resolveCameraInteractionSettings(
        settings({
          pointsVisible: true,
          shaderVisible: false,
          vectorsVisible: true,
          wireframeVisible: true,
        }),
        true,
      ),
    ).toMatchObject({
      boundsVisible: true,
      pointsVisible: false,
      shaderVisible: true,
      vectorsVisible: false,
      wireframeVisible: false,
    });
  });

  it("leaves settings unchanged outside active camera drag", () => {
    const source = settings({ wireframeVisible: true });

    expect(resolveCameraInteractionSettings(source, false)).toBe(source);
  });
});
