import {
  ACESFilmicToneMapping,
  NoToneMapping,
  SRGBColorSpace,
  type WebGLRenderer,
} from "three";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_VIEWPORT_3D_VISUAL_PROFILE_ID,
  configureViewport3DRenderer,
  getViewport3DVisualProfile,
  resolveViewport3DCanvasDpr,
  resolveViewport3DCanvasGlOptions,
} from "./viewport3dVisualProfile";

describe("viewport3d visual profiles", () => {
  it("defaults to the interactive profile", () => {
    expect(DEFAULT_VIEWPORT_3D_VISUAL_PROFILE_ID).toBe("interactive");
    expect(getViewport3DVisualProfile(undefined)).toMatchObject({
      id: "interactive",
      antialias: true,
      preserveDrawingBuffer: false,
      toneMapping: "none",
      voxelFillRatio: 1,
      voxelMagnitudeThreshold: 0,
      voxelTopography: {
        amplitudeCells: 0,
        component: "z",
        enabled: false,
      },
    });
  });

  it("defines profile-owned FDM voxel gap and threshold settings", () => {
    expect(getViewport3DVisualProfile("interactive-lite").voxelFillRatio).toBe(
      1,
    );
    expect(getViewport3DVisualProfile("figure").voxelFillRatio).toBe(1);
    expect(
      getViewport3DVisualProfile("capture").voxelMagnitudeThreshold,
    ).toBe(0);
    expect(getViewport3DVisualProfile("figure").voxelTopography).toEqual({
      amplitudeCells: 0,
      component: "z",
      enabled: false,
    });
  });

  it("caps DPR per profile without dropping below 1", () => {
    const lite = getViewport3DVisualProfile("interactive-lite");
    const figure = getViewport3DVisualProfile("figure");

    expect(
      resolveViewport3DCanvasDpr({ devicePixelRatio: 0.5, profile: lite }),
    ).toBe(1);
    expect(
      resolveViewport3DCanvasDpr({ devicePixelRatio: 3, profile: figure }),
    ).toBe(2);
  });

  it("keeps DPR profile-owned during camera interaction", () => {
    const profile = getViewport3DVisualProfile("interactive");

    expect(
      resolveViewport3DCanvasDpr({
        devicePixelRatio: 2,
        profile,
      }),
    ).toBe(1.25);
  });

  it("uses preserveDrawingBuffer only for capture", () => {
    expect(
      resolveViewport3DCanvasGlOptions(
        getViewport3DVisualProfile("interactive"),
      ),
    ).toMatchObject({
      antialias: true,
      preserveDrawingBuffer: false,
    });
    expect(
      resolveViewport3DCanvasGlOptions(getViewport3DVisualProfile("capture")),
    ).toMatchObject({
      antialias: true,
      preserveDrawingBuffer: true,
    });
  });

  it("honors the antialiasOverride toggle, with the profile keeping a veto (S-15)", () => {
    // The profile can turn antialiasing OFF unconditionally...
    expect(
      resolveViewport3DCanvasGlOptions(
        getViewport3DVisualProfile("interactive-lite"),
        true,
      ),
    ).toMatchObject({ antialias: false });
    // ...but where the profile allows it, the override is now honored
    // instead of being silently discarded (previously `void _antialiasOverride`
    // made the user-facing "Antialiasing" toggle a no-op whenever no
    // post-processing effect was active -- see S-15).
    expect(
      resolveViewport3DCanvasGlOptions(
        getViewport3DVisualProfile("interactive"),
        false,
      ),
    ).toMatchObject({ antialias: false });
    expect(
      resolveViewport3DCanvasGlOptions(
        getViewport3DVisualProfile("interactive"),
        true,
      ),
    ).toMatchObject({ antialias: true });
    // Omitting the override keeps the pure profile-owned behavior.
    expect(
      resolveViewport3DCanvasGlOptions(getViewport3DVisualProfile("interactive")),
    ).toMatchObject({ antialias: true });
  });

  it("keeps quality profiles un-tonemapped for scientific surface colors", () => {
    const renderer = {
      outputColorSpace: "",
      toneMapping: ACESFilmicToneMapping,
      toneMappingExposure: 2,
    } as WebGLRenderer;

    configureViewport3DRenderer(
      renderer,
      getViewport3DVisualProfile("balanced"),
    );

    expect(renderer.toneMapping).toBe(NoToneMapping);
    expect(renderer.toneMappingExposure).toBe(1);
    expect(renderer.outputColorSpace).toBe(SRGBColorSpace);
  });

  it("keeps lite profile un-tonemapped for cheapest interaction", () => {
    const renderer = {
      outputColorSpace: "",
      toneMapping: ACESFilmicToneMapping,
      toneMappingExposure: 2,
    } as WebGLRenderer;

    configureViewport3DRenderer(
      renderer,
      getViewport3DVisualProfile("interactive-lite"),
    );

    expect(renderer.toneMapping).toBe(NoToneMapping);
    expect(renderer.toneMappingExposure).toBe(1);
  });
});
