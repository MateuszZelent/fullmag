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

  it("uses lower roughness for lit magnetic surfaces", () => {
    const lite = resolveViewport3DMaterialProfile(
      getViewport3DVisualProfile("interactive-lite"),
    );
    const interactive = resolveViewport3DMaterialProfile(
      getViewport3DVisualProfile("interactive"),
    );

    expect(interactive.magneticSurface.roughness).toBeLessThan(
      lite.magneticSurface.roughness ?? 1,
    );
    expect(interactive.magneticSurface.toneMapped).toBe(true);
  });

  it("boosts primitive previews in figure profiles", () => {
    const interactive = resolveViewport3DMaterialProfile(
      getViewport3DVisualProfile("interactive"),
    );
    const figure = resolveViewport3DMaterialProfile(
      getViewport3DVisualProfile("figure"),
    );

    expect(figure.primitivePreview.emissiveIntensity).toBeGreaterThan(
      interactive.primitivePreview.emissiveIntensity ?? 0,
    );
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
      opacity: 0.34,
      toneMapped: false,
    });
    expect(interactive.axes.opacity).toBe(0.75);
    expect(figure.selectionShell.opacity).toBeGreaterThan(
      interactive.selectionShell.opacity,
    );
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
