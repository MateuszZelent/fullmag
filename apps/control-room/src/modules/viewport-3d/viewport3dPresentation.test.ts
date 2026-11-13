import { EquirectangularReflectionMapping } from "three";
import { describe, expect, it } from "vitest";
import { resolveViewport3DQualityProfileId, resolveViewport3DPresentationQuality, resolveViewport3DShadowBounds, createViewport3DStudioHdri } from "./viewport3dPresentation";
import { normalizeViewport3DAppearancePreferences, applyViewport3DAppearancePatch, DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES } from "./viewport3dAppearancePreferences";
import { getViewport3DVisualProfile } from "./viewport3dVisualProfile";
import { resolveViewport3DMaterialProfile } from "./layers/viewport3DMaterialProfile";

describe("presentation preferences and scientific protection", () => {
  it("migrates old preferences to scientific mode and validates visual/export parameters", () => {
    expect(normalizeViewport3DAppearancePreferences({})).toMatchObject({ renderMode: "scientific", exportScale: 2 });
    const appearance = normalizeViewport3DAppearancePreferences({ renderMode: "presentation", materialRoughness: -2, materialMetalness: 4, exportScale: 3 });
    expect(appearance).toMatchObject({ renderMode: "presentation", materialRoughness: 0.05, materialMetalness: 1, exportScale: 2 });
    expect(applyViewport3DAppearancePatch(appearance, { renderMode: "bad", exportScale: 4 })).toMatchObject({ renderMode: "presentation", exportScale: 4 });
  });
  it("keeps scientific colors invariant across all qualities while enabling PBR only on request", () => {
    for (const id of ["interactive-lite", "interactive", "balanced", "figure", "capture"] as const) {
      const profile = getViewport3DVisualProfile(id);
      const scientific = resolveViewport3DMaterialProfile(profile);
      const presentation = resolveViewport3DMaterialProfile(profile, { ...DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES, renderMode: "presentation" });
      expect(scientific.uniformGeometry.pbr).toBe(false);
      expect(presentation.uniformGeometry.pbr).toBe(true);
      expect(presentation.magneticSurface).toEqual(scientific.magneticSurface);
      expect(presentation.magneticSurface).toEqual({ shadeStrength: 0, toneMapped: false });
      expect(presentation.glyphs.toneMapped).toBe(false);
    }
  });
});

describe("presentation quality and bounds", () => {
  it("retains low-quality budgets during capture instead of forcing capture effects", () => {
    expect(resolveViewport3DQualityProfileId("capture", "interactive-lite")).toBe("interactive-lite");
    expect(resolveViewport3DQualityProfileId("figure", "interactive-lite")).toBe("figure");
    expect(resolveViewport3DQualityProfileId("capture")).toBe("interactive");
  });
  it("offers explicit increasing shadow/AO costs without changing data", () => {
    const lite = resolveViewport3DPresentationQuality("interactive-lite");
    const interactive = resolveViewport3DPresentationQuality("interactive");
    const figure = resolveViewport3DPresentationQuality("figure");
    expect(lite).toMatchObject({ shadowMapSize: 0, aoEnabled: false });
    expect(interactive).toMatchObject({ shadowMapSize: 512, aoEnabled: true, aoHalfRes: true });
    expect(figure).toMatchObject({ shadowMapSize: 2048, aoEnabled: true, aoHalfRes: false });
    expect(figure).not.toHaveProperty("glyphBudget");
  });
  it("fits offset, flat and microscopic scenes with positive finite clip ranges", () => {
    for (const bounds of [
      { min: [100, -2, 30], max: [104, 0, 34] },
      { min: [0, 0, 0], max: [1e-9, 1e-12, 1e-9] },
      { min: [2, 3, 4], max: [2, 3, 4] },
    ]) {
      const center: [number, number, number] = [0, 1, 2].map((i) => (bounds.min[i] + bounds.max[i]) / 2) as [number, number, number];
      const size: [number, number, number] = [0, 1, 2].map((i) => bounds.max[i] - bounds.min[i]) as [number, number, number];
      const result = resolveViewport3DShadowBounds({ center, size, radius: Math.hypot(...size) / 2 });
      expect(result.radius).toBeGreaterThan(0);
      expect(Number.isFinite(result.radius)).toBe(true);
      expect(result.near).toBeGreaterThan(0);
      expect(result.far).toBeGreaterThan(result.near);
      expect(result.center).toEqual(bounds.min.map((v, i) => (v + bounds.max[i]) / 2));
    }
  });
  it("builds a deterministic linear HDRI with radiance above one and no external assets", () => {
    const texture = createViewport3DStudioHdri();
    expect(texture.image.width).toBe(256);
    expect(texture.image.height).toBe(128);
    const pixels = texture.image.data as Float32Array;
    let max = 0;
    for (const v of pixels) { expect(Number.isFinite(v)).toBe(true); max = Math.max(max, v); }
    expect(max).toBeGreaterThan(1);
    expect(texture.mapping).toBe(EquirectangularReflectionMapping);
    texture.dispose();
  });
});
