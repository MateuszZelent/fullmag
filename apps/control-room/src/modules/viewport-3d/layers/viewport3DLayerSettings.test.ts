import { describe, expect, it } from "vitest";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

import {
  resolveMeshPartSurfaceMaterialColor,
  surfaceMaterialColorFromSettings,
  VERTEX_COLOR_MATERIAL_COLOR,
  vectorStyleFromSettings,
} from "./viewport3DLayerSettings";

function settings(
  patch: Partial<VisualizationTargetSettings> = {},
): VisualizationTargetSettings {
  return {
    activeQuantityId: "m",
    airboxSyntheticVectorsEnabled: false,
    boundsOpacityPercent: patch.boundsOpacityPercent ?? 100,
    boundsVisible: patch.boundsVisible ?? false,
    geometryScope: "full",
    surfaceOpacityPercent: 100,
    pointColor: "#999999",
    pointOpacityPercent: patch.pointOpacityPercent ?? 100,
    pointsVisible: patch.pointsVisible ?? false,
    renderMode: "surface",
    shaderColorMode: "orientation",
    shaderMonoColor: "#123456",
    shaderVisible: true,
    surfaceColorSource: "orientation",
    viewportColorbarVisible: patch.viewportColorbarVisible ?? false,
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
    scalarColorPalette: patch.scalarColorPalette ?? "viridis",
    surfaceProjectionMode: patch.surfaceProjectionMode ?? "raw_nodal",
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
  it("uses magnetization preview color when field colors are missing", () => {
    expect(
      resolveMeshPartSurfaceMaterialColor(
        settings({ surfaceColorSource: "orientation" }),
        "#313244",
        "#c255f0",
        false,
      ),
    ).toBe("#c255f0");
  });
});

describe("vectorStyleFromSettings", () => {
  it("does not inherit global vector thickness when target settings omit it", () => {
    expect(
      vectorStyleFromSettings(settings({ vectorThickness: undefined }), {
        monoColor: "#ffffff",
        thickness: 4,
      }),
    ).toMatchObject({
      thickness: 1,
    });
  });
});
