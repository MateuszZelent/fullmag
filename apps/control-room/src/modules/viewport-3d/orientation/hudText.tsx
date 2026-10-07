"use client";

import { forwardRef, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  CanvasTexture,
  LinearFilter,
  SRGBColorSpace,
  type Sprite,
} from "three";

import { WIDGET_RENDER_ORDER } from "./orientationHudConstants";

/** One styled span of a HUD label, e.g. the italic axis letter in "x (nm)". */
export interface HudTextRun {
  color: string;
  italic?: boolean;
  /** Vertical shift in CSS px, positive downwards (subscripts). */
  shiftPx?: number;
  /** Font-size multiplier relative to the label font. */
  size?: number;
  text: string;
  weight?: number;
}

export interface HudTextStyle {
  /** Rounded plate behind the text, with an optional colour swatch. */
  chip?: { border: string; fill: string; swatch?: string };
  font: "mono" | "ui";
  fontPx: number;
  /** Outline colour: the viewport background, never a grey. */
  halo: string;
  haloPx?: number;
}

export interface HudTextTexture {
  heightPx: number;
  texture: CanvasTexture;
  widthPx: number;
}

const HUD_FONT_FAMILY: Record<HudTextStyle["font"], string> = {
  mono: '"JetBrains Mono", "Cascadia Code", ui-monospace, monospace',
  ui: 'Inter, "Segoe UI", Arial, sans-serif',
};
const HUD_DEFAULT_WEIGHT: Record<HudTextStyle["font"], number> = {
  mono: 600,
  ui: 700,
};

function runFont(run: HudTextRun, style: HudTextStyle): string {
  const weight = run.weight ?? HUD_DEFAULT_WEIGHT[style.font];
  const size = style.fontPx * (run.size ?? 1);
  return `${run.italic ? "italic " : ""}${weight} ${size}px ${HUD_FONT_FAMILY[style.font]}`;
}

/**
 * Rasterises a label at device resolution. Sizes are reported in CSS px so
 * callers can scale the sprite to a constant on-screen size.
 */
export function buildHudTextTexture(
  runs: readonly HudTextRun[],
  style: HudTextStyle,
): HudTextTexture {
  const dpr =
    typeof window === "undefined"
      ? 2
      : Math.min(3, Math.max(2, window.devicePixelRatio || 1));
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const haloPx = style.chip ? 0 : style.haloPx ?? 3;
  const padX = style.chip ? 6 : haloPx + 1;
  const padY = style.chip ? 2 : haloPx;
  const swatchPx = style.chip?.swatch ? Math.round(style.fontPx * 0.72) : 0;
  const swatchGap = swatchPx ? 5 : 0;

  const widths = runs.map((run) => {
    if (!context) return run.text.length * style.fontPx * 0.62;
    context.font = runFont(run, style);
    return context.measureText(run.text).width;
  });
  const textWidth = widths.reduce((sum, width) => sum + width, 0);
  const widthPx = Math.ceil(textWidth + swatchPx + swatchGap + padX * 2);
  const heightPx = Math.ceil(style.fontPx * 1.4 + padY * 2);
  canvas.width = Math.max(1, Math.round(widthPx * dpr));
  canvas.height = Math.max(1, Math.round(heightPx * dpr));

  if (context) {
    context.scale(dpr, dpr);
    const middle = heightPx / 2;
    if (style.chip) {
      const radius = heightPx / 2 - 0.5;
      context.beginPath();
      if (typeof context.roundRect === "function") {
        context.roundRect(0.5, 0.5, widthPx - 1, heightPx - 1, radius);
      } else {
        context.rect(0.5, 0.5, widthPx - 1, heightPx - 1);
      }
      context.globalAlpha = 0.94;
      context.fillStyle = style.chip.fill;
      context.fill();
      context.globalAlpha = 1;
      context.lineWidth = 1;
      context.strokeStyle = style.chip.border;
      context.stroke();
      if (style.chip.swatch) {
        context.beginPath();
        context.arc(padX + swatchPx / 2, middle, swatchPx / 2, 0, Math.PI * 2);
        context.fillStyle = style.chip.swatch;
        context.fill();
        context.strokeStyle = style.chip.border;
        context.stroke();
      }
    }
    context.textBaseline = "middle";
    context.textAlign = "left";
    context.lineJoin = "round";
    let x = padX + swatchPx + swatchGap;
    runs.forEach((run, index) => {
      context.font = runFont(run, style);
      const y = middle + (run.shiftPx ?? 0) + 0.5;
      if (haloPx > 0) {
        context.lineWidth = haloPx * 2;
        context.strokeStyle = style.halo;
        context.strokeText(run.text, x, y);
      }
      context.fillStyle = run.color;
      context.fillText(run.text, x, y);
      x += widths[index] ?? 0;
    });
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return { heightPx, texture, widthPx };
}

export function hudTextKey(runs: readonly HudTextRun[], style: HudTextStyle): string {
  return JSON.stringify([runs, style]);
}

// Labels rasterised before Inter / JetBrains Mono finish loading would keep
// the fallback face, so every font load bumps a version that re-keys them.
let hudFontsVersion = 0;
function subscribeHudFonts(onChange: () => void): () => void {
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  if (!fonts) return () => {};
  const bump = () => {
    hudFontsVersion += 1;
    onChange();
  };
  fonts.addEventListener("loadingdone", bump);
  void fonts.ready.then(bump).catch(() => undefined);
  return () => fonts.removeEventListener("loadingdone", bump);
}
const readHudFontsVersion = () => hudFontsVersion;

/** Texture memoised on content and disposed when the content changes. */
export function useHudTextTexture(
  runs: readonly HudTextRun[],
  style: HudTextStyle,
): HudTextTexture {
  const fontsVersion = useSyncExternalStore(
    subscribeHudFonts,
    readHudFontsVersion,
    readHudFontsVersion,
  );
  const key = `${fontsVersion}:${hudTextKey(runs, style)}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const result = useMemo(() => buildHudTextTexture(runs, style), [key]);
  useEffect(() => () => result.texture.dispose(), [result]);
  return result;
}

/**
 * Label for HUD groups whose local unit is one screen pixel
 * (`ScreenAnchoredGroup`). `anchor` follows `Sprite.center`.
 */
export const HudTextSprite = forwardRef<
  Sprite,
  {
    anchor?: [number, number];
    opacity?: number;
    position: [number, number, number];
    renderOrder?: number;
    runs: readonly HudTextRun[];
    style: HudTextStyle;
  }
>(function HudTextSprite(
  {
    anchor = [0.5, 0.5],
    opacity = 1,
    position,
    renderOrder = WIDGET_RENDER_ORDER + 5,
    runs,
    style,
  },
  ref,
) {
  const { heightPx, texture, widthPx } = useHudTextTexture(runs, style);
  return (
    <sprite
      ref={ref}
      center={anchor}
      position={position}
      renderOrder={renderOrder}
      scale={[widthPx, heightPx, 1]}
    >
      <spriteMaterial
        depthTest={false}
        depthWrite={false}
        map={texture}
        opacity={opacity}
        toneMapped={false}
        transparent
      />
    </sprite>
  );
});
