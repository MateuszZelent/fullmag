import {
  surfaceColorSourceToColorMode,
  type VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";
import type { ColorRepresentation } from "three";

import type { VectorFieldLayerVectorStyle } from "./VectorFieldLayer";
import type { Viewport3DMaterialProfile } from "./viewport3DMaterialProfile";

export const VERTEX_COLOR_MATERIAL_COLOR = 0xffffff;

export function opacityFromSettings(
  settings: VisualizationTargetSettings,
): number {
  return percentToUnit(settings.opacityPercent);
}

export function percentToUnit(value: number): number {
  return Math.max(0, Math.min(1, value / 100));
}

export function shaderColorFromSettings(
  settings: VisualizationTargetSettings,
  fallback: ColorRepresentation,
): ColorRepresentation {
  return settings.shaderColorMode === "monochrome"
    ? renderableColor(settings.shaderMonoColor, fallback)
    : fallback;
}

export function surfaceMaterialColorFromSettings(
  settings: VisualizationTargetSettings,
  fallback: ColorRepresentation,
  hasVertexColors: boolean,
): ColorRepresentation {
  return hasVertexColors
    ? VERTEX_COLOR_MATERIAL_COLOR
    : shaderColorFromSettings(settings, fallback);
}

export function resolveMeshPartSurfaceMaterialColor(
  settings: VisualizationTargetSettings,
  meshColor: ColorRepresentation,
  _magnetizationTexturePreviewColor: ColorRepresentation | null,
  hasVertexColors: boolean,
): ColorRepresentation {
  return surfaceMaterialColorFromSettings(settings, meshColor, hasVertexColors);
}

export function shaderUsesVertexColors(
  settings: VisualizationTargetSettings,
): boolean {
  return settings.surfaceColorSource !== "solid";
}

export function surfaceScalarColorModeFromSettings(
  settings: VisualizationTargetSettings,
): string | null {
  return surfaceColorSourceToColorMode(settings.surfaceColorSource);
}

export function vectorColorModeFromSettings(
  settings: VisualizationTargetSettings,
  fallback: string,
): string {
  return settings.vectorColorMode ?? fallback;
}

export function vectorStyleFromSettings(
  settings: VisualizationTargetSettings,
  fallback: VectorFieldLayerVectorStyle,
): VectorFieldLayerVectorStyle {
  return {
    alpha: percentToUnit(settings.vectorAlphaPercent),
    monoColor: renderableStringColor(
      settings.vectorMonoColor,
      fallback.monoColor ?? null,
    ),
    thickness: settings.vectorThickness ?? fallback.thickness,
  };
}

export function wireframeColorFromSettings(
  settings: VisualizationTargetSettings,
  fallback: ColorRepresentation,
): ColorRepresentation {
  return renderableColor(settings.wireframeColor, fallback);
}

export function wireframeOpacityFromSettings(
  settings: VisualizationTargetSettings,
  featureEdges?: Viewport3DMaterialProfile["featureEdges"],
): number {
  const baseOpacity = settings.shaderVisible
    ? opacityFromSettings(settings)
    : 1.0;
  const opacity =
    baseOpacity *
    percentToUnit(settings.wireframeOpacityPercent);
  return Math.max(0, Math.min(1, opacity * (featureEdges?.opacity ?? 1)));
}

export function resolveCameraInteractionSettings(
  settings: VisualizationTargetSettings,
  interactionActive: boolean,
): VisualizationTargetSettings {
  if (
    !interactionActive ||
    (!settings.wireframeVisible &&
      !settings.pointsVisible &&
      !settings.vectorsVisible)
  ) {
    return settings;
  }

  return {
    ...settings,
    boundsVisible:
      settings.boundsVisible ||
      (!settings.shaderVisible &&
        (settings.wireframeVisible ||
          settings.pointsVisible ||
          settings.vectorsVisible)),
    pointsVisible: false,
    shaderVisible:
      settings.shaderVisible ||
      settings.wireframeVisible ||
      settings.pointsVisible ||
      settings.vectorsVisible,
    vectorsVisible: false,
    wireframeVisible: false,
  };
}

function renderableColor(
  value: string | null | undefined,
  fallback: ColorRepresentation,
): ColorRepresentation {
  if (!value || value.startsWith("var(")) return fallback;
  return value;
}

function renderableStringColor(
  value: string | null | undefined,
  fallback: string | null,
): string | null {
  if (!value || value.startsWith("var(")) return fallback;
  return value;
}
