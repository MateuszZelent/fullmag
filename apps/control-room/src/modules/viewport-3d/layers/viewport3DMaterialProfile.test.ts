import { describe, expect, it } from "vitest";

import { getViewport3DVisualProfile } from "../viewport3dVisualProfile";
import { resolveViewport3DMaterialProfile } from "./viewport3DMaterialProfile";

describe("viewport3D material profile", () => {
  it("keeps lite materials un-tonemapped", () => {
    const profile = resolveViewport3DMaterialProfile(
      getViewport3DVisualProfile("interactive-lite"),
    );

    expect(profile.magneticSurface.toneMapped).toBe(false);
    expect(profile.primitivePreview.toneMapped).toBe(false);
  });

  it("keeps magnetic and primitive surfaces unlit", () => {
    const interactive = resolveViewport3DMaterialProfile(
      getViewport3DVisualProfile("interactive"),
    );

    expect(interactive.magneticSurface).toEqual({ toneMapped: false });
    expect(interactive.primitivePreview).toEqual({ toneMapped: false });
    expect(interactive.magneticSurface).not.toHaveProperty("metalness");
    expect(interactive.magneticSurface).not.toHaveProperty("roughness");
    expect(interactive.primitivePreview).not.toHaveProperty("emissiveIntensity");
  });

  it("keeps capture-oriented primitive previews unlit", () => {
    const interactive = resolveViewport3DMaterialProfile(
      getViewport3DVisualProfile("interactive"),
    );
    const figure = resolveViewport3DMaterialProfile(
      getViewport3DVisualProfile("figure"),
    );

    expect(figure.primitivePreview).toEqual(interactive.primitivePreview);
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
