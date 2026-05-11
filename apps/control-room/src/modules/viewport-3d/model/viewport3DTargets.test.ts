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
      } as VisualizationStateResource),
    ).toMatchObject({
      opacityPercent: 45,
      pointsVisible: true,
      renderMode: "points",
      shaderVisible: false,
      vectorsVisible: true,
      wireframeVisible: false,
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
