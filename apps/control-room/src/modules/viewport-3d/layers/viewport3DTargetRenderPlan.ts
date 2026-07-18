import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

import { percentToUnit } from "./viewport3DLayerSettings";

export interface Viewport3DRenderChannelPlan {
  opacity: number;
  visible: boolean;
}

export interface Viewport3DTargetRenderPlan {
  bounds: Viewport3DRenderChannelPlan;
  points: Viewport3DRenderChannelPlan;
  primitive: Viewport3DRenderChannelPlan;
  surface: Viewport3DRenderChannelPlan;
  vectors: Viewport3DRenderChannelPlan;
  wireframe: Viewport3DRenderChannelPlan;
}

export interface Viewport3DTargetRenderProfile {
  featureEdges: { opacity: number };
  glyphs: { opacityScale: number };
}

function channel(
  targetVisible: boolean,
  channelVisible: boolean,
  opacity: number,
): Viewport3DRenderChannelPlan {
  return {
    opacity: Math.max(0, Math.min(1, opacity)),
    visible: targetVisible && channelVisible,
  };
}

export function resolveViewport3DTargetRenderPlan(
  settings: VisualizationTargetSettings,
  profile: Viewport3DTargetRenderProfile,
): Viewport3DTargetRenderPlan {
  return {
    bounds: channel(
      settings.visible,
      settings.boundsVisible,
      percentToUnit(settings.boundsOpacityPercent),
    ),
    points: channel(
      settings.visible,
      settings.pointsVisible,
      percentToUnit(settings.pointOpacityPercent),
    ),
    primitive: channel(
      settings.visible,
      settings.primitiveVisible ?? false,
      percentToUnit(settings.primitiveOpacityPercent ?? 100),
    ),
    surface: channel(
      settings.visible,
      settings.shaderVisible,
      percentToUnit(settings.surfaceOpacityPercent),
    ),
    vectors: channel(
      settings.visible,
      settings.vectorsVisible,
      percentToUnit(settings.vectorAlphaPercent) * profile.glyphs.opacityScale,
    ),
    wireframe: channel(
      settings.visible,
      settings.wireframeVisible,
      percentToUnit(settings.wireframeOpacityPercent) *
        profile.featureEdges.opacity,
    ),
  };
}

export function resolveViewport3DSelectionRenderPlan(
  selected: boolean,
  opacity: number,
): Viewport3DRenderChannelPlan {
  return channel(true, selected, opacity);
}
