"use client";

import { forwardRef, useEffect, useMemo, useSyncExternalStore } from "react";
import { type Sprite } from "three";

import { WIDGET_RENDER_ORDER } from "./orientationHudConstants";
import { type HudTextRun, type HudTextStyle, type HudTextTexture, hudTextKey, buildHudTextTexture } from "./hudText.model";

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
    depthTest?: boolean;
    opacity?: number;
    position: [number, number, number];
    renderOrder?: number;
    runs: readonly HudTextRun[];
    style: HudTextStyle;
  }
>(function HudTextSprite(
  {
    anchor = [0.5, 0.5],
    depthTest = false,
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
        depthTest={depthTest}
        depthWrite={false}
        map={texture}
        opacity={opacity}
        toneMapped={false}
        transparent
      />
    </sprite>
  );
});
