import { describe, expect, it } from "vitest";

import {
  applyViewport3DAppearancePatch,
  buildViewport3DPersistedPreferences,
  DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES,
  normalizeViewport3DAppearancePreferences,
  parseViewport3DPersistedPreferences,
  resolveViewport3DAppearanceDiagnostics,
  serializeViewport3DPersistedPreferences,
} from "./viewport3dAppearancePreferences";

describe("viewport3dAppearancePreferences", () => {
  it("publishes the R1 default appearance contract", () => {
    expect(DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES).toEqual({
      renderMode: "scientific",
      materialRoughness: 0.35,
      materialMetalness: 0.5,
      softShadows: true,
      exportScale: 2,
      backgroundMode: "gradient",
      backgroundStrength: 0.65,
      lightingMode: "studio",
      lightingIntensity: 1,
      lightingAzimuth: -35,
      lightingElevation: 45,
      lightingSpace: "camera",
      dimensionOrigin: "frame-center",
      gridOpacity: 1,
      aoIntensity: 1,
      aoRadius: 0.02,
      exportBackground: "view",
      exportAnnotations: true,
    });
  });

  it("bounds finite numeric values and ignores invalid patch fields", () => {
    const normalized = normalizeViewport3DAppearancePreferences({
      backgroundStrength: 4,
      lightingAzimuth: -240,
      lightingElevation: 100,
      gridOpacity: 0,
      aoIntensity: -1,
      aoRadius: 2,
      lightingMode: "invalid",
      fieldShading: true,
    });
    expect(normalized).toMatchObject({
      backgroundStrength: 1,
      lightingAzimuth: -180,
      lightingElevation: 90,
      gridOpacity: 0.25,
      aoIntensity: 0,
      aoRadius: 1,
      lightingMode: "studio",
    });
    expect(normalized).not.toHaveProperty("fieldShading");

    const patched = applyViewport3DAppearancePatch(normalized, {
      backgroundStrength: Number.NaN,
      lightingMode: "invalid",
      fieldShading: true,
    });
    expect(patched.backgroundStrength).toBe(1);
    expect(patched.lightingMode).toBe("studio");
    expect(patched).not.toHaveProperty("fieldShading");
  });

  it("ignores unknown fields and rejects malformed or unsupported records", () => {
    const parsed = parseViewport3DPersistedPreferences(JSON.stringify({
      schemaVersion: 1,
      appearance: {
        backgroundMode: "gradient",
        fieldShading: true,
        futurePreference: 7,
      },
      widgets: { viewCubeVisible: false, futureWidget: true },
      visualProfileId: "figure",
      camera: { position: [1, 2, 3] },
    }));
    expect(parsed).toMatchObject({
      appearance: { backgroundMode: "gradient", backgroundStrength: 0.65 },
      widgets: { viewCubeVisible: false },
      visualProfileId: "figure",
    });
    expect(parsed?.appearance).not.toHaveProperty("fieldShading");
    expect(parsed && "camera" in parsed).toBe(false);
    expect(parseViewport3DPersistedPreferences("{broken")).toBeNull();
    expect(parseViewport3DPersistedPreferences(JSON.stringify({
      schemaVersion: 2,
      appearance: { backgroundMode: "gradient" },
    }))).toBeNull();
  });

  it("persists only selected preferences and never a capture profile or camera", () => {
    const source = {
      appearance: { backgroundMode: "gradient" },
      captureReturnProfileId: null,
      visualProfileId: "figure",
      widgets: { dimensionFrameDensity: "fine", effectBloom: true },
      camera: { position: [1, 2, 3] },
    };
    const preferences = buildViewport3DPersistedPreferences(source);
    expect(preferences?.visualProfileId).toBe("figure");
    expect(preferences?.widgets).toMatchObject({
      dimensionFrameDensity: "fine",
      effectBloom: true,
    });
    expect(preferences && "camera" in preferences).toBe(false);
    expect(preferences && JSON.parse(serializeViewport3DPersistedPreferences(preferences)).camera)
      .toBeUndefined();
    expect(buildViewport3DPersistedPreferences({
      ...source,
      visualProfileId: "capture",
      captureReturnProfileId: null,
    })).toBeNull();
  });

  it("reports a reason when a profile suppresses requested antialiasing", () => {
    expect(resolveViewport3DAppearanceDiagnostics({
      ambientOcclusionRequested: false,
      antialiasRequested: true,
      bloomRequested: true,
      profileAllowsAntialias: false,
    })).toEqual({
      ambientOcclusion: { requested: false, effective: false, reason: null },
      bloom: { requested: true, effective: true, reason: null },
      antialias: {
        requested: true,
        effective: false,
        reason: "The selected visual profile disables canvas antialiasing.",
      },
    });
  });
});
