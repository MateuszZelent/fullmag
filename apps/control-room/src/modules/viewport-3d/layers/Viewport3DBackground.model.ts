import type { Viewport3DColors } from "../viewport3dTypes";
import { Color, DataTexture, LinearFilter, RGBAFormat, SRGBColorSpace } from "three";

/** Rows run bottom to top; stored bytes are sRGB, interpolation is prepared in linear light. */
export function createViewportBackgroundTexture(colors: Viewport3DColors, strength: number): DataTexture {
  const height = 256;
  const pixels = new Uint8Array(height * 2 * 4);
  const amount = Math.min(1, Math.max(0, Number.isFinite(strength) ? strength : 0));
  const base = new Color(colors.background);
  const top = base.clone().lerp(new Color(colors.backgroundTop ?? colors.background), amount);
  const bottom = base.clone().lerp(new Color(colors.backgroundBottom ?? colors.background), amount);
  const sample = new Color();
  for (let row = 0; row < height; row += 1) {
    sample.copy(bottom).lerp(top, row / (height - 1)).convertLinearToSRGB();
    for (let column = 0; column < 2; column += 1) {
      const offset = (row * 2 + column) * 4;
      pixels[offset] = Math.round(sample.r * 255);
      pixels[offset + 1] = Math.round(sample.g * 255);
      pixels[offset + 2] = Math.round(sample.b * 255);
      pixels[offset + 3] = 255;
    }
  }
  const texture = new DataTexture(pixels, 2, height, RGBAFormat);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
