import { describe, expect, it } from "vitest";
import { SRGBColorSpace } from "three";
import type { Viewport3DColors } from "../viewport3dTypes";
import { createViewportBackgroundTexture } from "./Viewport3DBackground.model";

const colors = {
  background: "#222222", backgroundTop: "#111111", backgroundBottom: "#444444",
} as Viewport3DColors;

describe("viewport background texture", () => {
  it("stores an opaque bottom-to-top gradient in sRGB", () => {
    const texture = createViewportBackgroundTexture(colors, 1);
    try {
      const pixels = texture.image.data as Uint8Array;
      expect(texture.colorSpace).toBe(SRGBColorSpace);
      expect(texture.image.width).toBe(2);
      expect(pixels[0]).toBe(68);
      expect(pixels[pixels.length - 4]).toBe(17);
      for (let index = 3; index < pixels.length; index += 4) expect(pixels[index]).toBe(255);
    } finally { texture.dispose(); }
  });

  it("uses the solid base when strength is zero or invalid", () => {
    for (const strength of [0, Number.NaN, -1]) {
      const texture = createViewportBackgroundTexture(colors, strength);
      try {
        const pixels = texture.image.data as Uint8Array;
        expect(pixels[0]).toBe(34);
        expect(pixels[pixels.length - 4]).toBe(34);
      } finally { texture.dispose(); }
    }
  });
});
