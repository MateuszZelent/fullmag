import { Color, type ColorRepresentation } from "three";

import type { Viewport3DColors, Viewport3DHudColors } from "../viewport3dTypes";

export type HudAxisId = "x" | "y" | "z";

/**
 * HUD palette for a colour set. Theme-resolved colours carry `hud`; colour
 * sets built by hand (tests, thumbnails) fall back to the base tokens so the
 * HUD still follows the active background.
 */
export function resolveHudColors(colors: Viewport3DColors): Viewport3DHudColors {
  if (colors.hud) return colors.hud;
  const label = colorToCss(colors.textPrimary ?? colors.textSecondary ?? colors.wire);
  const tick = colorToCss(colors.textSecondary ?? colors.wire);
  return {
    axisX: colorToCss(colors.danger ?? label),
    axisY: colorToCss(colors.success ?? label),
    axisZ: colorToCss(colors.accent),
    chip: colorToCss(colors.panel ?? colors.background),
    chipBorder: colorToCss(colors.wire),
    cubeEdge: colorToCss(colors.wire),
    cubeFace: colorToCss(colors.panelRaised ?? colors.panel ?? colors.mesh),
    cubeShade: colorToCss(colors.background),
    grid: tick,
    halo: colorToCss(colors.background),
    label,
    tick,
  };
}

export function hudAxisColor(hud: Viewport3DHudColors, axis: HudAxisId): string {
  if (axis === "x") return hud.axisX;
  if (axis === "y") return hud.axisY;
  return hud.axisZ;
}

export function colorToCss(color: ColorRepresentation): string {
  return typeof color === "string" ? color : `#${new Color(color).getHexString()}`;
}
