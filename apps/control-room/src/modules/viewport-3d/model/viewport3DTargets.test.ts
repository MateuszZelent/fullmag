import { describe, expect, it } from "vitest";

import type { VisualizationStateResource } from "@/kernel/api/apiTypes";

import {
  resolveAirboxBaseVisualizationSettings,
  resolveGlobalObjectVisualizationSettings,
} from "./viewport3DTargets";

describe("viewport3DTargets", () => {
  it("maps canonical global mesh/vector layers into object render defaults", () => {
    expect(
      resolveGlobalObjectVisualizationSettings({
        layers: {
          points: { opacity: 0.45, visible: true },
          surface: { opacity: 0.45, visible: false },
          vectors: { density: 512, domain: "full_domain", visible: true },
          wireframe: { opacity: 0.45, visible: false },
        },
      } as unknown as VisualizationStateResource),
    ).toMatchObject({
      opacityPercent: 45,
      pointsVisible: true,
      renderMode: "points",
      shaderVisible: false,
      vectorsVisible: true,
      wireframeVisible: false,
    });
  });

  it("maps global vector style into object display fallback style fields", () => {
    expect(
      resolveGlobalObjectVisualizationSettings({
        vector_style: {
          alpha: 0.4,
          color_mode: "x",
          ferromagnet_visibility: "all",
          length_scale: 1,
          mono_color: "#44ccff",
          thickness: 2,
        },
      } as unknown as VisualizationStateResource),
    ).toMatchObject({
      shaderColorMode: "x",
      shaderMonoColor: "#44ccff",
      surfaceColorSource: "component_x",
      vectorAlphaPercent: 40,
      vectorColorMode: "x",
      vectorMonoColor: "#44ccff",
      vectorThickness: 2,
    });
  });

  it("maps canonical airbox layer state into the airbox render base", () => {
    expect(
      resolveAirboxBaseVisualizationSettings({
        layers: {
          airbox: {
            opacity: 0.35,
            points: { opacity: 1, visible: false },
            surface: { opacity: 1, visible: false },
            vectors: { density: 128, domain: "airbox_only", visible: true },
            visible: true,
            wireframe: { opacity: 1, visible: true },
          },
        },
      } as VisualizationStateResource),
    ).toMatchObject({
      opacityPercent: 35,
      renderMode: "wireframe",
      shaderVisible: false,
      vectorsVisible: true,
      visible: true,
      wireframeVisible: true,
    });
  });
});
