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
      toneMapping: "aces",
      voxelFillRatio: 0.92,
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
      0.88,
    );
    expect(getViewport3DVisualProfile("figure").voxelFillRatio).toBe(0.96);
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

  it("keeps native canvas antialiasing profile-owned", () => {
    expect(
      resolveViewport3DCanvasGlOptions(
        getViewport3DVisualProfile("interactive"),
        false,
      ),
    ).toMatchObject({ antialias: true });
    expect(
      resolveViewport3DCanvasGlOptions(
        getViewport3DVisualProfile("interactive-lite"),
        true,
      ),
    ).toMatchObject({ antialias: false });
  });

  it("configures ACES tone mapping for quality profiles", () => {
    const renderer = {
      outputColorSpace: "",
      toneMapping: NoToneMapping,
      toneMappingExposure: 1,
    } as WebGLRenderer;

    configureViewport3DRenderer(
      renderer,
      getViewport3DVisualProfile("balanced"),
    );

    expect(renderer.toneMapping).toBe(ACESFilmicToneMapping);
    expect(renderer.toneMappingExposure).toBe(1.05);
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
