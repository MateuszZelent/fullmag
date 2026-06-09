import { describe, expect, it } from "vitest";

import {
  DEFAULT_VIEWPORT_3D_CAMERA_STATE,
  resolveHslReferenceVisible,
  resolveViewport3DCameraOrthographicScale,
  resolveViewport3DCameraProjection,
  resolveViewport3DCameraState,
  viewport3dStore,
} from "./viewport3dStore";

describe("viewport3dStore", () => {
  it("stores the active scalar colorbar legend with concrete range labels", () => {
    viewport3dStore.resetForTest();

    viewport3dStore.setActiveScalarColorbarLegend({
      label: "mat_ms [A/m]",
      maxLabel: "400000",
      minLabel: "400000",
      paletteGradient: "linear-gradient(90deg, black, white)",
    });

    expect(viewport3dStore.getActiveScalarColorbarLegend()).toEqual({
      label: "mat_ms [A/m]",
      maxLabel: "400000",
      minLabel: "400000",
      paletteGradient: "linear-gradient(90deg, black, white)",
    });
  });

  it("keeps the canonical camera snapshot in module-local state", () => {
    viewport3dStore.resetForTest();

    viewport3dStore.setCamera({
      position: [3, 2, 1],
      target: [0.5, 0.25, 0],
      up: [0, 0, 1],
    });

    expect(viewport3dStore.getSnapshot().camera).toEqual({
      position: [3, 2, 1],
      target: [0.5, 0.25, 0],
      up: [0, 0, 1],
    });
  });

  it("reset-camera restores the default camera snapshot", () => {
    viewport3dStore.resetForTest();

    viewport3dStore.setCamera({
      position: [9, 9, 9],
      target: [1, 1, 1],
      up: [0, 1, 0],
    });

    viewport3dStore.resetCamera();

    expect(viewport3dStore.getSnapshot().camera).toEqual(
      DEFAULT_VIEWPORT_3D_CAMERA_STATE,
    );
  });

  it("defaults orientation widget preferences for the v2 viewport", () => {
    viewport3dStore.resetForTest();

    expect(viewport3dStore.getSnapshot().widgets).toEqual({
      cameraDialogOpen: false,
      cameraOrthographicScale: null,
      cameraProjection: "perspective",
      dimensionFrameDensity: "auto",
      dimensionFrameMode: "floor",
      effectAmbientOcclusion: false,
      effectAntialias: true,
      effectBloom: false,
      fdmTopographyAmplitudeCells: 0,
      fdmTopographyComponent: "z",
      fdmTopographyEnabled: false,
      hslReferenceMode: "auto",
      inspectEnabled: false,
      inspectRevision: 0,
      rotationMode: "object",
      scaleLabelsVisible: true,
      scaleUnitMode: "auto",
      settingsDialogOpen: false,
      viewCubeVisible: true,
    });
  });

  it("updates view cube and HSL reference preferences", () => {
    viewport3dStore.resetForTest();

    viewport3dStore.toggleViewCube();
    viewport3dStore.setHslReferenceMode("off");

    expect(viewport3dStore.getSnapshot().widgets).toEqual({
      cameraDialogOpen: false,
      cameraOrthographicScale: null,
      cameraProjection: "perspective",
      dimensionFrameDensity: "auto",
      dimensionFrameMode: "floor",
      effectAmbientOcclusion: false,
      effectAntialias: true,
      effectBloom: false,
      fdmTopographyAmplitudeCells: 0,
      fdmTopographyComponent: "z",
      fdmTopographyEnabled: false,
      hslReferenceMode: "off",
      inspectEnabled: false,
      inspectRevision: 0,
      rotationMode: "object",
      scaleLabelsVisible: true,
      scaleUnitMode: "auto",
      settingsDialogOpen: false,
      viewCubeVisible: false,
    });
  });

  it("updates dimension frame preferences", () => {
    viewport3dStore.resetForTest();

    viewport3dStore.setDimensionFrameMode("cage");
    viewport3dStore.setDimensionFrameDensity("fine");
    viewport3dStore.setScaleLabelsVisible(false);
    viewport3dStore.setScaleUnitMode("nm");

    expect(viewport3dStore.getSnapshot().widgets).toMatchObject({
      dimensionFrameDensity: "fine",
      dimensionFrameMode: "cage",
      scaleLabelsVisible: false,
      scaleUnitMode: "nm",
    });
  });

  it("switches between free-camera and object-bound rotation modes", () => {
    viewport3dStore.resetForTest();

    expect(viewport3dStore.getSnapshot().widgets.rotationMode).toBe("object");

    viewport3dStore.setRotationMode("camera");
    expect(viewport3dStore.getSnapshot().widgets.rotationMode).toBe("camera");

    viewport3dStore.setRotationMode("object");
    expect(viewport3dStore.getSnapshot().widgets.rotationMode).toBe("object");
  });

  it("updates FDM topography preferences", () => {
    viewport3dStore.resetForTest();

    viewport3dStore.setFdmTopographyEnabled(true);
    viewport3dStore.setFdmTopographyAmplitudeCells(2.5);
    viewport3dStore.setFdmTopographyComponent("magnitude");

    expect(viewport3dStore.getSnapshot().widgets).toMatchObject({
      fdmTopographyAmplitudeCells: 2.5,
      fdmTopographyComponent: "magnitude",
      fdmTopographyEnabled: true,
    });
  });

  it("toggles the inspect tool as a viewport-local mode", () => {
    viewport3dStore.resetForTest();

    expect(viewport3dStore.getSnapshot().widgets.inspectEnabled).toBe(false);
    expect(viewport3dStore.getSnapshot().widgets.inspectRevision).toBe(0);

    viewport3dStore.toggleInspect();
    expect(viewport3dStore.getSnapshot().widgets.inspectEnabled).toBe(true);
    expect(viewport3dStore.getSnapshot().widgets.inspectRevision).toBe(1);

    viewport3dStore.setInspectEnabled(false);
    expect(viewport3dStore.getSnapshot().widgets.inspectEnabled).toBe(false);
    expect(viewport3dStore.getSnapshot().widgets.inspectRevision).toBe(2);
  });

  it("opens and closes the camera dialog from module commands", () => {
    viewport3dStore.resetForTest();

    viewport3dStore.setCameraDialogOpen(true);
    expect(viewport3dStore.getSnapshot().widgets.cameraDialogOpen).toBe(true);

    viewport3dStore.setCameraDialogOpen(false);
    expect(viewport3dStore.getSnapshot().widgets.cameraDialogOpen).toBe(false);
  });

  it("updates camera position and projection together for remote sync", () => {
    viewport3dStore.resetForTest();

    viewport3dStore.setCameraView({
      camera: {
        position: [4, 5, 6],
        target: [1, 2, 3],
        up: [0, 1, 0],
      },
      orthographicScale: 2.5e-6,
      projection: "orthographic",
    });

    expect(viewport3dStore.getSnapshot().camera).toEqual({
      position: [4, 5, 6],
      target: [1, 2, 3],
      up: [0, 1, 0],
    });
    expect(viewport3dStore.getSnapshot().widgets.cameraProjection).toBe(
      "orthographic",
    );
    expect(viewport3dStore.getSnapshot().widgets.cameraOrthographicScale).toBe(
      2.5e-6,
    );
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
      up: [0, 0, 1],
    });
    expect(resolveViewport3DCameraProjection(state)).toBe("orthographic");
    expect(resolveViewport3DCameraOrthographicScale(state)).toBe(2.5e-6);
  });

  it("falls back to local camera defaults when visualization state has no camera", () => {
    expect(resolveViewport3DCameraState(null)).toEqual(
      DEFAULT_VIEWPORT_3D_CAMERA_STATE,
    );
    expect(resolveViewport3DCameraProjection(null)).toBe("perspective");
  });
});
