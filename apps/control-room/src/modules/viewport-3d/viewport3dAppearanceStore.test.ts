import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { viewport3dStore } from "./viewport3dStore";

describe("viewport3dStore appearance preferences", () => {
  beforeEach(() => viewport3dStore.resetForTest());
  afterEach(() => viewport3dStore.resetForTest());

  it("publishes and persists presentation-only edits and resets them without changing camera", () => {
    const camera = viewport3dStore.getSnapshot().camera;
    viewport3dStore.setAppearance({ renderMode: "presentation" });
    expect(viewport3dStore.getSnapshot().appearance.renderMode).toBe("presentation");
    viewport3dStore.setAppearance({ materialRoughness: 0.8, materialMetalness: 0.9, softShadows: false, exportScale: 4 });
    expect(viewport3dStore.getSnapshot().appearance).toMatchObject({ materialRoughness: 0.8, materialMetalness: 0.9, softShadows: false, exportScale: 4 });
    viewport3dStore.resetAppearance("all");
    expect(viewport3dStore.getSnapshot().appearance).toMatchObject({ renderMode: "scientific", exportScale: 2 });
    expect(viewport3dStore.getSnapshot().camera).toBe(camera);
  });

  it("bounds appearance patches and keeps the selected appearance snapshot stable", () => {
    const initialAppearance = viewport3dStore.getSnapshot().appearance;
    viewport3dStore.setAppearance({
      backgroundMode: "gradient",
      backgroundStrength: 4,
      aoIntensity: -2,
      lightingElevation: 150,
    });

    expect(viewport3dStore.getSnapshot().appearance).toMatchObject({
      backgroundMode: "gradient",
      backgroundStrength: 1,
      aoIntensity: 0,
      lightingElevation: 90,
    });
    expect(viewport3dStore.getSnapshot().appearance).not.toBe(initialAppearance);

    const appearance = viewport3dStore.getSnapshot().appearance;
    viewport3dStore.setCamera({
      position: [2, 3, 4],
      target: [0, 0, 0],
      up: [0, 0, 1],
    });
    expect(viewport3dStore.getSnapshot().appearance).toBe(appearance);
  });

  it("resets only the requested preference section and preserves the camera", () => {
    viewport3dStore.setAppearance({
      backgroundMode: "gradient",
      dimensionOrigin: "world",
      lightingIntensity: 1.8,
    });
    viewport3dStore.setDimensionFrameDensity("fine");
    viewport3dStore.setEffectBloom(true);
    viewport3dStore.setCamera({
      position: [8, 7, 6],
      target: [1, 2, 3],
      up: [0, 0, 1],
    });
    viewport3dStore.setCameraProjection("orthographic");

    viewport3dStore.resetAppearance("frame");

    expect(viewport3dStore.getSnapshot().appearance).toMatchObject({
      backgroundMode: "gradient",
      dimensionOrigin: "frame-center",
      lightingIntensity: 1.8,
    });
    expect(viewport3dStore.getSnapshot().widgets.dimensionFrameDensity).toBe("auto");
    expect(viewport3dStore.getSnapshot().widgets.effectBloom).toBe(true);
    expect(viewport3dStore.getSnapshot().camera.position).toEqual([8, 7, 6]);
    expect(viewport3dStore.getSnapshot().widgets.cameraProjection).toBe("orthographic");
  });

  it("resets all persisted appearance preferences without resetting camera state", () => {
    viewport3dStore.setAppearance({
      backgroundMode: "gradient",
      lightingIntensity: 1.7,
      exportAnnotations: false,
    });
    viewport3dStore.setDimensionFrameMode("cage");
    viewport3dStore.setScaleUnitMode("nm");
    viewport3dStore.setEffectAmbientOcclusion(true);
    viewport3dStore.setVisualProfile("figure");
    viewport3dStore.setCamera({
      position: [5, 4, 3],
      target: [1, 1, 1],
      up: [0, 0, 1],
    });
    viewport3dStore.setCameraProjection("orthographic");

    viewport3dStore.resetAppearance("all");

    expect(viewport3dStore.getSnapshot().appearance).toMatchObject({
      backgroundMode: "gradient",
      lightingIntensity: 1,
      exportAnnotations: true,
    });
    expect(viewport3dStore.getSnapshot().widgets.dimensionFrameMode).toBe("floor");
    expect(viewport3dStore.getSnapshot().widgets.scaleUnitMode).toBe("auto");
    expect(viewport3dStore.getSnapshot().widgets.effectAmbientOcclusion).toBe(false);
    expect(viewport3dStore.getSnapshot().visualProfileId).toBe("interactive");
    expect(viewport3dStore.getSnapshot().camera.position).toEqual([5, 4, 3]);
    expect(viewport3dStore.getSnapshot().widgets.cameraProjection).toBe("orthographic");
  });

  it("reports effective antialias diagnostics for a profile that suppresses the request", () => {
    viewport3dStore.setVisualProfile("interactive-lite");

    expect(viewport3dStore.getSnapshot().appearanceDiagnostics.antialias).toEqual({
      requested: true,
      effective: false,
      reason: "The selected visual profile disables canvas antialiasing.",
    });

    viewport3dStore.setEffectAntialias(false);
    expect(viewport3dStore.getSnapshot().appearanceDiagnostics.antialias).toEqual({
      requested: false,
      effective: false,
      reason: null,
    });
  });

  it("reports post-processing protection and browser availability", () => {
    viewport3dStore.setEffectAmbientOcclusion(true);
    viewport3dStore.setEffectBloom(true);
    viewport3dStore.setPostProcessingDataProtection(true);

    expect(viewport3dStore.getSnapshot().appearanceDiagnostics.ambientOcclusion).toEqual({
      requested: true,
      effective: false,
      reason: "Quantitative field colors are protected",
    });
    expect(viewport3dStore.getSnapshot().appearanceDiagnostics.bloom).toEqual({
      requested: true,
      effective: false,
      reason: "Quantitative field colors are protected",
    });

    viewport3dStore.setPostProcessingDataProtection(false);
    viewport3dStore.setPostProcessingAvailable(false);
    expect(viewport3dStore.getSnapshot().appearanceDiagnostics.bloom).toEqual({
      requested: true,
      effective: false,
      reason: "Post-processing is disabled by browser configuration.",
    });
  });

  it("surfaces capture failures until the next capture request", () => {
    viewport3dStore.setCaptureError("Export failed");
    expect(viewport3dStore.getSnapshot().captureError).toBe("Export failed");

    viewport3dStore.requestCapture();
    expect(viewport3dStore.getSnapshot().captureError).toBeNull();
  });

  it("retains the return profile while a capture is already pending", () => {
    viewport3dStore.setVisualProfile("balanced");
    viewport3dStore.requestCapture();
    const pending = viewport3dStore.getSnapshot();
    viewport3dStore.requestCapture();
    expect(viewport3dStore.getSnapshot().captureRevision).toBe(pending.captureRevision);
    expect(viewport3dStore.getSnapshot().captureReturnProfileId).toBe("balanced");
    viewport3dStore.completeCapture();
    expect(viewport3dStore.getSnapshot().visualProfileId).toBe("balanced");
  });
});
