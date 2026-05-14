import { describe, expect, it } from "vitest";

import {
  DEFAULT_VIEWPORT_3D_CAMERA_STATE,
  resolveHslReferenceVisible,
  resolveViewport3DCameraProjection,
  resolveViewport3DCameraState,
  viewport3dStore,
} from "./viewport3dStore";

describe("viewport3dStore", () => {
  it("keeps the canonical camera snapshot in module-local state", () => {
    viewport3dStore.resetForTest();

    viewport3dStore.setCamera({
      position: [3, 2, 1],
      target: [0.5, 0.25, 0],
    });

    expect(viewport3dStore.getSnapshot().camera).toEqual({
      position: [3, 2, 1],
      target: [0.5, 0.25, 0],
    });
  });

  it("reset-camera restores the default camera snapshot", () => {
    viewport3dStore.resetForTest();

    viewport3dStore.setCamera({
      position: [9, 9, 9],
      target: [1, 1, 1],
    });

    viewport3dStore.resetCamera();

    expect(viewport3dStore.getSnapshot().camera).toEqual(
      DEFAULT_VIEWPORT_3D_CAMERA_STATE,
    );
  });

  it("defaults orientation widget preferences for the v2 viewport", () => {
    viewport3dStore.resetForTest();

    expect(viewport3dStore.getSnapshot().widgets).toEqual({
      cameraProjection: "perspective",
      hslReferenceMode: "auto",
      settingsDialogOpen: false,
      viewCubeVisible: true,
    });
  });

  it("updates view cube and HSL reference preferences", () => {
    viewport3dStore.resetForTest();

    viewport3dStore.toggleViewCube();
    viewport3dStore.setHslReferenceMode("off");

    expect(viewport3dStore.getSnapshot().widgets).toEqual({
      cameraProjection: "perspective",
      hslReferenceMode: "off",
      settingsDialogOpen: false,
      viewCubeVisible: false,
    });
  });

  it("derives HSL reference visibility from mode and vector coloring", () => {
    expect(resolveHslReferenceVisible("auto", "orientation")).toBe(true);
    expect(resolveHslReferenceVisible("auto", "magnitude")).toBe(false);
    expect(resolveHslReferenceVisible("on", "magnitude")).toBe(true);
    expect(resolveHslReferenceVisible("off", "orientation")).toBe(false);
  });

  it("derives viewport camera from backend visualization state", () => {
    const state = {
      camera: {
        fov_degrees: 35,
        orthographic_scale: 2.5e-6,
        position: [1e-6, 2e-6, 3e-6],
        projection: "orthographic" as const,
        target: [0, 0, 0],
        up: [0, 0, 1],
      },
    };

    expect(resolveViewport3DCameraState(state)).toEqual({
      position: [1e-6, 2e-6, 3e-6],
      target: [0, 0, 0],
    });
    expect(resolveViewport3DCameraProjection(state)).toBe("orthographic");
  });

  it("falls back to local camera defaults when visualization state has no camera", () => {
    expect(resolveViewport3DCameraState(null)).toEqual(
      DEFAULT_VIEWPORT_3D_CAMERA_STATE,
    );
    expect(resolveViewport3DCameraProjection(null)).toBe("perspective");
  });
});
