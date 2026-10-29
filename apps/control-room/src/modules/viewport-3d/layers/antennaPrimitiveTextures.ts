import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace } from "three";

// Small, deterministic studio reflection and object-space brushed finish.
// Both textures are owned and released by the primitive layer's resource tracker.
export function createAntennaPrimitiveTextures() {
  const size = 64;
  const reflection = new Uint8Array(size * size * 4);
  const brushed = new Uint8Array(size * size * 4);
  const fract = (value: number) => value - Math.floor(value);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = 2 * x / (size - 1) - 1;
      const ny = 2 * y / (size - 1) - 1;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const key = Math.max(0, -0.45 * nx + 0.65 * ny + 0.62 * nz);
      const fill = Math.max(0, 0.65 * nx + 0.2 * ny + 0.73 * nz);
      const highlight = Math.pow(Math.max(0, -0.35 * nx + 0.45 * ny + 0.82 * nz), 40);
      const brightness = Math.min(1, 0.3 + 0.46 * key + 0.16 * fill + 0.45 * highlight);
      const streak = fract(Math.sin(y * 91.7) * 1731.9);
      const grain = fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);
      const brush = 0.91 + 0.065 * streak + 0.025 * grain;
      const index = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        reflection[index + channel] = Math.round(brightness * 255);
        brushed[index + channel] = Math.round(brush * 255);
      }
      reflection[index + 3] = 255;
      brushed[index + 3] = 255;
    }
  }
  const matcap = new DataTexture(reflection, size, size);
  const brush = new DataTexture(brushed, size, size);
  for (const texture of [matcap, brush]) {
    texture.colorSpace = SRGBColorSpace;
    texture.magFilter = LinearFilter;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
  }
  brush.wrapS = brush.wrapT = RepeatWrapping;
  brush.repeat.set(4, 4);
  return { matcap, brush };
}
