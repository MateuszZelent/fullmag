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
  return percentToUnit(settings.surfaceOpacityPercent);
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
  if (hasVertexColors) return VERTEX_COLOR_MATERIAL_COLOR;

  // `surfaceColorSource` is the inspector's canonical choice.  The solid
  // color control intentionally patches that source and `shaderMonoColor`,
  // but it does not need to rewrite the legacy `shaderColorMode` field.  The
  // material must therefore honor the source directly or FDM surfaces keep
  // falling back to the default mesh color while the inspector says Solid.
  return settings.surfaceColorSource === "solid"
    ? renderableColor(settings.shaderMonoColor, fallback)
    : shaderColorFromSettings(settings, fallback);
}

export function resolveMeshPartSurfaceMaterialColor(
  settings: VisualizationTargetSettings,
  meshColor: ColorRepresentation,
  magnetizationTexturePreviewColor: ColorRepresentation | null,
  hasVertexColors: boolean,
): ColorRepresentation {
  const fallback =
    settings.surfaceColorSource === "solid"
      ? meshColor
      : magnetizationTexturePreviewColor ?? meshColor;
  return surfaceMaterialColorFromSettings(settings, fallback, hasVertexColors);
}

export function resolveMeshPartMagnetizationTexturePreviewColor(
  analysisOverlayActive: boolean,
  magnetizationTexturePreviewColor: ColorRepresentation | null,
): ColorRepresentation | null {
  return analysisOverlayActive ? null : magnetizationTexturePreviewColor;
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
    monoColor: renderableStringColor(
      settings.vectorMonoColor,
      fallback.monoColor ?? null,
    ),
    thickness: settings.vectorThickness ?? 1,
  };
}

export function pointColorFromSettings(
  settings: VisualizationTargetSettings,
  fallback: ColorRepresentation,
): ColorRepresentation {
  return renderableColor(settings.pointColor, fallback);
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
  const opacity = percentToUnit(settings.wireframeOpacityPercent);
  return Math.max(0, Math.min(1, opacity * (featureEdges?.opacity ?? 1)));
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
