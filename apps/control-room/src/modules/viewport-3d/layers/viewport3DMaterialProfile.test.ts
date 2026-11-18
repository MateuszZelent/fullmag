import { describe, expect, it } from "vitest";

import { DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES } from "../viewport3dAppearancePreferences";
import { getViewport3DVisualProfile } from "../viewport3dVisualProfile";
import { resolveViewport3DMaterialProfile } from "./viewport3DMaterialProfile";

describe("viewport3D material profile", () => {
  it("shades field colors only in studio Presentation across visual quality profiles", () => {
    const scientific = resolveViewport3DMaterialProfile(
      getViewport3DVisualProfile("interactive"),
    );
    const interactivePresentation = resolveViewport3DMaterialProfile(
      getViewport3DVisualProfile("interactive"),
      { ...DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES, renderMode: "presentation" },
    );
    const litePresentation = resolveViewport3DMaterialProfile(
      getViewport3DVisualProfile("interactive-lite"),
      { ...DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES, renderMode: "presentation" },
    );

    expect(scientific.magneticSurface).toEqual({
      presentation: null,
      shadeStrength: 0,
      toneMapped: false,
    });
    expect(interactivePresentation.magneticSurface.shadeStrength).toBe(1);
    expect(interactivePresentation.magneticSurface.toneMapped).toBe(true);
    expect(interactivePresentation.magneticSurface.presentation).toEqual({
      metalness: DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES.materialMetalness,
      roughness: DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES.materialRoughness,
      shadows: true,
    });
    expect(litePresentation.magneticSurface.shadeStrength).toBe(1);
    expect(litePresentation.magneticSurface.presentation?.shadows).toBe(false);
  });

  it("keeps field colors unshaded in Scientific and flat Presentation", () => {
    const scientificStudio = resolveViewport3DMaterialProfile(
      getViewport3DVisualProfile("interactive"),
      { ...DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES, lightingMode: "studio" },
    );
    const presentationFlat = resolveViewport3DMaterialProfile(
      getViewport3DVisualProfile("interactive"),
      {
        ...DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES,
        lightingMode: "flat",
        renderMode: "presentation",
      },
    );

    expect(scientificStudio.magneticSurface.shadeStrength).toBe(0);
    expect(scientificStudio.magneticSurface.presentation).toBeNull();
    expect(presentationFlat.magneticSurface.shadeStrength).toBe(0);
    expect(presentationFlat.magneticSurface.presentation).toBeNull();
    expect(presentationFlat.magneticSurface.toneMapped).toBe(false);
  });

  it("keeps lite materials un-tonemapped", () => {
    const profile = resolveViewport3DMaterialProfile(
      getViewport3DVisualProfile("interactive-lite"),
    );

    expect(profile.magneticSurface.toneMapped).toBe(false);
    expect(profile.primitivePreview.toneMapped).toBe(false);
  });

  it("keeps Scientific magnetic surfaces exact while enabling studio for uniform geometry", () => {
    const interactive = resolveViewport3DMaterialProfile(
      getViewport3DVisualProfile("interactive"),
    );

    expect(interactive.magneticSurface).toEqual({
      presentation: null,
      shadeStrength: 0,
      toneMapped: false,
    });
    expect(interactive.primitivePreview).toEqual({ toneMapped: false });
    expect(interactive.uniformGeometry.lit).toBe(true);
    expect(interactive.primitivePreview).not.toHaveProperty("emissiveIntensity");
  });

  it("uses appearance material parameters and quality-gated shadows for Presentation fields", () => {
    const profile = resolveViewport3DMaterialProfile(
      getViewport3DVisualProfile("balanced"),
      {
        ...DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES,
        materialMetalness: 0.18,
        materialRoughness: 0.72,
        renderMode: "presentation",
        softShadows: false,
      },
    );

    expect(profile.magneticSurface.presentation).toEqual({
      metalness: 0.18,
      roughness: 0.72,
      shadows: false,
    });
  });

  it("keeps lighting mode independent from capture quality", () => {
    const interactive = resolveViewport3DMaterialProfile(
      getViewport3DVisualProfile("interactive"),
    );
    const figure = resolveViewport3DMaterialProfile(
      getViewport3DVisualProfile("figure"),
    );

    expect(figure.primitivePreview).toEqual(interactive.primitivePreview);
    expect(figure.uniformGeometry).toEqual(interactive.uniformGeometry);
  });

  it("supports flat uniform geometry without changing quantitative shading", () => {
    const flat = resolveViewport3DMaterialProfile(
      getViewport3DVisualProfile("interactive"),
      { lightingMode: "flat" },
    );

    expect(flat.uniformGeometry.lit).toBe(false);
    expect(flat.magneticSurface.shadeStrength).toBe(0);
  });

  it("maps visual profile edge opacity and boost into feature edge opacity", () => {
    const lite = resolveViewport3DMaterialProfile(
      getViewport3DVisualProfile("interactive-lite"),
    );
    const figure = resolveViewport3DMaterialProfile(
      getViewport3DVisualProfile("figure"),
    );

    expect(lite.featureEdges.opacity).toBeCloseTo(0.255);
    expect(figure.featureEdges.opacity).toBeGreaterThan(
      lite.featureEdges.opacity,
    );
  });

  it("centralizes non-surface semantic layer material settings", () => {
    const interactive = resolveViewport3DMaterialProfile(
      getViewport3DVisualProfile("interactive"),
    );
    const figure = resolveViewport3DMaterialProfile(
      getViewport3DVisualProfile("figure"),
    );

    expect(interactive.glyphs).toEqual({
      opacityScale: 0.92,
      toneMapped: false,
    });
    expect(interactive.grid).toMatchObject({
      depthWrite: false,
      opacity: 0.26,
      toneMapped: false,
    });
    expect(interactive.axes.opacity).toBe(0.6);
    expect(interactive.dimensionFrame).toMatchObject({
      labelOpacity: expect.any(Number),
      majorOpacity: expect.any(Number),
      minorOpacity: expect.any(Number),
      tickOpacity: expect.any(Number),
    });
    expect(interactive.dimensionFrame.minorOpacity).toBeGreaterThanOrEqual(0.12);
    expect(interactive.dimensionFrame.minorOpacity).toBeLessThanOrEqual(0.28);
    expect(interactive.dimensionFrame.majorOpacity).toBeGreaterThanOrEqual(0.24);
    expect(interactive.dimensionFrame.majorOpacity).toBeLessThanOrEqual(0.46);
    expect(interactive.dimensionFrame.labelOpacity).toBeGreaterThanOrEqual(0.72);
    expect(interactive.dimensionFrame.labelOpacity).toBeLessThanOrEqual(1);
    expect(figure.dimensionFrame.majorOpacity).toBe(
      interactive.dimensionFrame.majorOpacity,
    );
    expect(figure.selectionShell.opacity).toBe(interactive.selectionShell.opacity);
  });

  it("keeps render pass policy out of material appearance profiles", () => {
    const profile = resolveViewport3DMaterialProfile(
      getViewport3DVisualProfile("interactive"),
    );

    expect(profile.magneticSurface).not.toHaveProperty("polygonOffset");
    expect(profile.airSurface).not.toHaveProperty("polygonOffset");
    expect(profile.primitivePreview).not.toHaveProperty("polygonOffset");
  });
});
