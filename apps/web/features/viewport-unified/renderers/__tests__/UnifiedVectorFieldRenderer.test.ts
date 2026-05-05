import { describe, expect, it } from "vitest";

import {
  buildVectorSurfaceCameraFitSignature,
  shouldApplyVectorSurfaceCameraAutoFit,
  shouldRenderVectorSurfaceCanvas,
  shouldShowVectorSurfaceOrientationReference,
} from "../UnifiedVectorFieldRenderer";
import type { Viewport3DModel } from "../../model/viewport3dContracts";

describe("shouldRenderVectorSurfaceCanvas", () => {
  it("does not keep a VectorSurface WebGL canvas mounted when hidden", () => {
    expect(
      shouldRenderVectorSurfaceCanvas({
        canvasEnabled: true,
        hostReady: true,
        viewportVisible: false,
      }),
    ).toBe(false);
  });

  it("renders only when the canvas feature, event host, and visible viewport are all active", () => {
    expect(
      shouldRenderVectorSurfaceCanvas({
        canvasEnabled: false,
        hostReady: true,
        viewportVisible: true,
      }),
    ).toBe(false);
    expect(
      shouldRenderVectorSurfaceCanvas({
        canvasEnabled: true,
        hostReady: false,
        viewportVisible: true,
      }),
    ).toBe(false);
    expect(
      shouldRenderVectorSurfaceCanvas({
        canvasEnabled: true,
        hostReady: true,
        viewportVisible: true,
      }),
    ).toBe(true);
  });
});

describe("buildVectorSurfaceCameraFitSignature", () => {
  it("waits until the vector-surface viewport is visible and has renderable geometry", () => {
    expect(
      buildVectorSurfaceCameraFitSignature({
        viewportVisible: false,
        sceneMode: "grid",
        hasRenderableContent: true,
        center: [8, 4, 4],
        extent: [16, 8, 8],
      }),
    ).toBeNull();
    expect(
      buildVectorSurfaceCameraFitSignature({
        viewportVisible: true,
        sceneMode: "grid",
        hasRenderableContent: false,
        center: [0, 0, 0],
        extent: [1, 1, 1],
      }),
    ).toBeNull();
  });

  it("changes when late geometry replaces the placeholder frame", () => {
    const placeholder = buildVectorSurfaceCameraFitSignature({
      viewportVisible: true,
      sceneMode: "world",
      hasRenderableContent: false,
      center: [0, 0, 0],
      extent: [1, 1, 1],
    });
    const realGeometry = buildVectorSurfaceCameraFitSignature({
      viewportVisible: true,
      sceneMode: "grid",
      hasRenderableContent: true,
      center: [32, 8, 16],
      extent: [64, 16, 32],
    });

    expect(placeholder).toBeNull();
    expect(realGeometry).toBe("grid:32.0000000000,8.00000000000,16.0000000000:64.0000000000,16.0000000000,32.0000000000");
  });
});

describe("shouldApplyVectorSurfaceCameraAutoFit", () => {
  it("fits once for a new geometry signature", () => {
    expect(
      shouldApplyVectorSurfaceCameraAutoFit({
        nextFitSignature: "grid:ready",
        previousFitSignature: null,
        persistedCameraAvailable: false,
        cameraInteractionActive: false,
      }),
    ).toBe(true);
    expect(
      shouldApplyVectorSurfaceCameraAutoFit({
        nextFitSignature: "grid:ready",
        previousFitSignature: "grid:ready",
        persistedCameraAvailable: false,
        cameraInteractionActive: false,
      }),
    ).toBe(false);
  });

  it("does not override a restored camera or an active camera interaction", () => {
    expect(
      shouldApplyVectorSurfaceCameraAutoFit({
        nextFitSignature: "grid:ready",
        previousFitSignature: null,
        persistedCameraAvailable: true,
        cameraInteractionActive: false,
      }),
    ).toBe(false);
    expect(
      shouldApplyVectorSurfaceCameraAutoFit({
        nextFitSignature: "grid:ready",
        previousFitSignature: null,
        persistedCameraAvailable: false,
        cameraInteractionActive: true,
      }),
    ).toBe(false);
  });
});

describe("shouldShowVectorSurfaceOrientationReference", () => {
  const baseModel = {
    overlays: {
      orientationReferenceVisible: true,
    },
  } as Viewport3DModel;

  it("uses the viewport model overlay state for HSL sphere visibility", () => {
    expect(
      shouldShowVectorSurfaceOrientationReference({
        viewportVisible: true,
        geometryMode: false,
        viewport3DModel: baseModel,
        orientationReferenceKillSwitch: true,
      }),
    ).toBe(true);
  });

  it("hides the HSL sphere outside orientation coloring or when killed by diagnostics", () => {
    expect(
      shouldShowVectorSurfaceOrientationReference({
        viewportVisible: true,
        geometryMode: false,
        viewport3DModel: {
          ...baseModel,
          overlays: {
            ...baseModel.overlays,
            orientationReferenceVisible: false,
          },
        },
        orientationReferenceKillSwitch: true,
      }),
    ).toBe(false);
    expect(
      shouldShowVectorSurfaceOrientationReference({
        viewportVisible: true,
        geometryMode: false,
        viewport3DModel: baseModel,
        orientationReferenceKillSwitch: false,
      }),
    ).toBe(false);
  });
});
