import { DataTexture, EquirectangularReflectionMapping, FloatType, LinearFilter, LinearSRGBColorSpace, RGBAFormat } from "three";
import type { Viewport3DVisualProfileId } from "./viewport3dVisualProfile";
import type { Viewport3DBounds } from "./viewport3dRenderModel";

/** One-shot exports retain the selected rendering/data budget; only pixel size changes. */
export function resolveViewport3DQualityProfileId(profileId: Viewport3DVisualProfileId, captureReturnProfileId: Viewport3DVisualProfileId | null = null): Viewport3DVisualProfileId {
  return profileId === "capture" ? captureReturnProfileId ?? "interactive" : profileId;
}

/** Presentation effects follow the existing quality profile; field values stay unchanged. */
export function resolveViewport3DPresentationQuality(id: Viewport3DVisualProfileId) {
  switch (id) {
    case "interactive-lite": return { shadowMapSize: 0, aoEnabled: false, aoHalfRes: true };
    case "interactive": return { shadowMapSize: 512, aoEnabled: true, aoHalfRes: true };
    case "balanced": return { shadowMapSize: 1024, aoEnabled: true, aoHalfRes: true };
    default: return { shadowMapSize: 2048, aoEnabled: true, aoHalfRes: false };
  }
}

/** Bound the light camera in scene units, including microscopic and flat geometry. */
export function resolveViewport3DShadowBounds(bounds: Viewport3DBounds | null) {
  const finite = (value: number) => Number.isFinite(value) ? value : 0;
  const center: [number, number, number] = bounds ? [finite(bounds.center[0]), finite(bounds.center[1]), finite(bounds.center[2])] : [0, 0, 0];
  const size = bounds?.size ?? [1, 1, 1];
  const radius = Math.max(1e-12, Math.hypot(...size.map((v) => Number.isFinite(v) ? v : 0)) * 0.65);
  return { center, radius, near: radius * 0.05, far: radius * 8 };
}

/** Locally generated linear HDR studio panorama: large softboxes, no network/assets. */
export function createViewport3DStudioHdri(): DataTexture {
  const width = 256, height = 128;
  const pixels = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const elevation = ((y + 0.5) / height - 0.5) * Math.PI;
    for (let x = 0; x < width; x += 1) {
      const azimuth = ((x + 0.5) / width - 0.5) * Math.PI * 2;
      const angularDistance = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
      const softbox = (a: number, e: number, strength: number, w: number, h: number) => strength * Math.exp(-0.5 * ((angularDistance(azimuth, a) / w) ** 8 + ((elevation - e) / h) ** 8));
      const radiance = 0.15 + Math.max(0, Math.sin(elevation)) * 0.25
        + softbox(-0.9, 0.65, 10, 0.4, 0.35)
        + softbox(1.2, 0.35, 5, 0.28, 0.5)
        + softbox(2.8, 0.8, 7, 0.5, 0.2);
      const offset = (y * width + x) * 4;
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = radiance;
      pixels[offset + 3] = 1;
    }
  }
  const texture = new DataTexture(pixels, width, height, RGBAFormat, FloatType);
  texture.name = "FullmagStudioHDRI";
  texture.colorSpace = LinearSRGBColorSpace;
  texture.mapping = EquirectangularReflectionMapping;
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
