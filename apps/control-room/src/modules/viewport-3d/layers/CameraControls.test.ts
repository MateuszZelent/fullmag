import { describe, expect, it, vi } from "vitest";

import {
  commitOrbitCameraEnd,
  resolveWheelZoomDistance,
  resolveViewport3DCameraFit,
  shouldAutoFitViewport3DBoundsChange,
} from "./CameraControls";
import {
  DEFAULT_VIEWPORT_3D_CAMERA_STATE,
  viewport3dStore,
} from "../viewport3dStore";

describe("resolveViewport3DCameraFit", () => {
  it("maps wheel deltas to bounded dolly distances", () => {
    expect(resolveWheelZoomDistance(1e-6, 1000)).toBeGreaterThan(1e-6);
    expect(resolveWheelZoomDistance(1e-6, -1000)).toBeLessThan(1e-6);
    expect(resolveWheelZoomDistance(0, 1000)).toBe(1e-12);
  });

  it("fits nanoscale micromagnetic bounds without meter-scale clipping", () => {
    const fit = resolveViewport3DCameraFit({
      center: [1e-7, 0, 0],
      radius: 5e-8,
      size: [1e-7, 6e-8, 5e-9],
    });

    expect(fit.target).toEqual([1e-7, 0, 0]);
    expect(fit.position[0]).toBeCloseTo(2.4e-7);
    expect(fit.near).toBeLessThan(1e-8);
    expect(fit.far).toBeGreaterThan(1e-6);
  });

  it("uses micrometer-scale defaults before resources arrive", () => {
    const fit = resolveViewport3DCameraFit(null);

    expect(fit.position[0]).toBeCloseTo(2.8e-6);
    expect(fit.target).toEqual([0, 0, 0]);
    expect(fit.near).toBeLessThan(1e-7);
  });

  it("auto-fits changed bounds only while the camera is still auto-managed", () => {
    const lastAutoFitCameraState = {
      position: [1, 2, 3] as [number, number, number],
      target: [0, 0, 0] as [number, number, number],
    };

    expect(
      shouldAutoFitViewport3DBoundsChange({
        currentCameraState: lastAutoFitCameraState,
        lastAutoFitCameraState,
        nextBoundsSignature: "next",
        previousBoundsSignature: "previous",
      }),
    ).toBe(true);

    expect(
      shouldAutoFitViewport3DBoundsChange({
        currentCameraState: {
          position: [4, 5, 6],
          target: [0, 0, 0],
        },
        lastAutoFitCameraState,
        nextBoundsSignature: "next",
        previousBoundsSignature: "previous",
      }),
    ).toBe(false);
  });

  it("does not write orbit drag-end camera into the module store", () => {
    viewport3dStore.resetForTest();
    const onCameraChange = vi.fn();

    commitOrbitCameraEnd({
      cameraPosition: [3, 2, 1],
      controlTarget: [0.5, 0.25, 0],
      onCameraChange,
    });

    expect(viewport3dStore.getSnapshot().camera).toEqual(
      DEFAULT_VIEWPORT_3D_CAMERA_STATE,
    );
    expect(onCameraChange).toHaveBeenCalledWith({
      position: [3, 2, 1],
      target: [0.5, 0.25, 0],
      up: [0, 0, 1],
    });
  });
});
