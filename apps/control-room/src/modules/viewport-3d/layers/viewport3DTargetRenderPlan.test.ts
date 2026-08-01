import { describe, expect, it } from "vitest";

import {
  DEFAULT_OBJECT_VISUALIZATION,
  type VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";

import {
  resolveViewport3DSelectionRenderPlan,
  resolveViewport3DTargetRenderPlan,
} from "./viewport3DTargetRenderPlan";

function settings(
  patch: Partial<VisualizationTargetSettings> = {},
): VisualizationTargetSettings {
  return { ...DEFAULT_OBJECT_VISUALIZATION, ...patch };
}

describe("resolveViewport3DTargetRenderPlan", () => {
  it("keeps every channel opacity independent from surface opacity", () => {
    const profile = {
      featureEdges: { opacity: 0.5 },
      glyphs: { opacityScale: 0.8 },
    };
    const initial = resolveViewport3DTargetRenderPlan(
      settings({
        boundsOpacityPercent: 30,
        boundsVisible: true,
        pointOpacityPercent: 70,
        pointsVisible: true,
        primitiveOpacityPercent: 55,
        primitiveVisible: true,
        surfaceOpacityPercent: 20,
        vectorAlphaPercent: 60,
        vectorsVisible: true,
        wireframeOpacityPercent: 80,
        wireframeVisible: true,
      }),
      profile,
    );
    const changedSurface = resolveViewport3DTargetRenderPlan(
      settings({
        boundsOpacityPercent: 30,
        boundsVisible: true,
        pointOpacityPercent: 70,
        pointsVisible: true,
        primitiveOpacityPercent: 55,
        primitiveVisible: true,
        surfaceOpacityPercent: 5,
        vectorAlphaPercent: 60,
        vectorsVisible: true,
        wireframeOpacityPercent: 80,
        wireframeVisible: true,
      }),
      profile,
    );

    expect(initial.surface.opacity).toBe(0.2);
    expect(changedSurface.surface.opacity).toBe(0.05);
    expect(changedSurface.wireframe.opacity).toBe(initial.wireframe.opacity);
    expect(changedSurface.points.opacity).toBe(initial.points.opacity);
    expect(changedSurface.primitive.opacity).toBe(initial.primitive.opacity);
    expect(changedSurface.vectors.opacity).toBe(initial.vectors.opacity);
    expect(changedSurface.bounds.opacity).toBe(initial.bounds.opacity);
    expect(changedSurface).toMatchObject({
      bounds: { opacity: 0.3, visible: true },
      points: { opacity: 0.7, visible: true },
      primitive: { opacity: 0.55, visible: true },
      vectors: { opacity: 0.48, visible: true },
      wireframe: { opacity: 0.4, visible: true },
    });
  });

  it("disables every pass when target master visibility is off", () => {
    expect(
      resolveViewport3DTargetRenderPlan(
        settings({
          boundsVisible: true,
          pointsVisible: true,
          primitiveVisible: true,
          shaderVisible: true,
          vectorsVisible: true,
          visible: false,
          wireframeVisible: true,
        }),
        {
          featureEdges: { opacity: 1 },
          glyphs: { opacityScale: 1 },
        },
      ),
    ).toMatchObject({
      bounds: { visible: false },
      points: { visible: false },
      primitive: { visible: false },
      surface: { visible: false },
      vectors: { visible: false },
      wireframe: { visible: false },
    });
  });

  it("keeps selection visibility and opacity independent from target channels", () => {
    expect(resolveViewport3DSelectionRenderPlan(true, 0.72)).toEqual({
      opacity: 0.72,
      visible: true,
    });
    expect(resolveViewport3DSelectionRenderPlan(false, 0.72)).toEqual({
      opacity: 0.72,
      visible: false,
    });
  });
});
