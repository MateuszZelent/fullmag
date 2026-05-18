import { describe, expect, it, vi } from "vitest";
import { MOUSE, PerspectiveCamera, Vector3 } from "three";

import {
  applyViewport3DNativeCameraPan,
  applyViewport3DNativeCameraOrbit,
  commitOrbitCameraEnd,
  resolveViewport3DCameraInteractionOptions,
  resolveViewport3DPerspectivePanDistance,
  resolveWheelZoomDistance,
  resolveViewport3DCameraFit,
  shouldHandleViewport3DNativeCameraPan,
  shouldHandleViewport3DNativeCameraOrbit,
  shouldAutoFitViewport3DBoundsChange,
} from "./CameraControls";
import { resolveViewport3DCameraOrientation } from "../viewport3dCameraModel";
import {
  DEFAULT_VIEWPORT_3D_CAMERA_STATE,
  viewport3dStore,
} from "../viewport3dStore";

describe("resolveViewport3DCameraFit", () => {
  it("configures OrbitControls for fast explicit camera manipulation", () => {
    const options = resolveViewport3DCameraInteractionOptions();

    expect(options.enableDamping).toBe(false);
    expect(options.enablePan).toBe(true);
    expect(options.enableZoom).toBe(false);
    expect(options.panSpeed).toBeGreaterThanOrEqual(2.5);
    expect(options.rotateSpeed).toBe(1);
    expect(options.screenSpacePanning).toBe(true);
    expect(options.mouseButtons).toEqual({
      LEFT: MOUSE.ROTATE,
      MIDDLE: MOUSE.PAN,
      RIGHT: MOUSE.PAN,
    });
  });

  it("keeps right-button pan native so modifiers cannot turn it into rotation", () => {
    expect(
      shouldHandleViewport3DNativeCameraPan({
        button: 2,
        ctrlKey: true,
        metaKey: true,
        shiftKey: true,
      }),
    ).toBe(true);
    expect(
      shouldHandleViewport3DNativeCameraPan({
        button: 0,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(false);
  });

  it("keeps left-button rotation native for free camera movement", () => {
    expect(
      shouldHandleViewport3DNativeCameraOrbit({
        button: 0,
      }),
    ).toBe(true);
    expect(
      shouldHandleViewport3DNativeCameraOrbit({
        button: 2,
      }),
    ).toBe(false);
  });

  it("pans the camera and target together without changing orbit orientation", () => {
    const camera = new PerspectiveCamera(42, 1, 1e-12, 1e-3);
    const target = new Vector3(0, 0, 0);
    camera.up.set(0, 0, 1);
    camera.position.set(6.437336e-6, 4.634882e-6, 6.437336e-6);
    camera.lookAt(target);
    camera.updateMatrix();

    const before = resolveViewport3DCameraOrientation({
      position: camera.position.toArray() as [number, number, number],
      target: target.toArray() as [number, number, number],
      up: camera.up.toArray() as [number, number, number],
    });

    applyViewport3DNativeCameraPan({
      camera,
      deltaX: 300,
      deltaY: 0,
      target,
      viewportHeightPixels: 528,
      viewportWidthPixels: 742,
    });

    const after = resolveViewport3DCameraOrientation({
      position: camera.position.toArray() as [number, number, number],
      target: target.toArray() as [number, number, number],
      up: camera.up.toArray() as [number, number, number],
    });

    expect(target.length()).toBeGreaterThan(1e-5);
    expect(after.distance).toBeCloseTo(before.distance);
    expect(after.yawDegrees).toBeCloseTo(before.yawDegrees);
    expect(after.pitchDegrees).toBeCloseTo(before.pitchDegrees);
  });

  it("rotates the free camera in place instead of orbiting around the world origin", () => {
    const camera = new PerspectiveCamera(42, 1, 1e-12, 1e-3);
    const target = new Vector3(5e-6, -2e-6, 0);
    camera.up.set(0, 0, 1);
    camera.position.set(11.437336e-6, 2.634882e-6, 6.437336e-6);
    camera.lookAt(target);
    camera.updateMatrix();
    const beforePosition = camera.position.clone();
    const beforeTarget = target.clone();
    const beforeOrientation = resolveViewport3DCameraOrientation({
      position: camera.position.toArray() as [number, number, number],
      target: target.toArray() as [number, number, number],
      up: camera.up.toArray() as [number, number, number],
    });

    applyViewport3DNativeCameraOrbit({
      camera,
      deltaX: 300,
      deltaY: 0,
      rotationMode: "camera",
      target,
      viewportHeightPixels: 528,
    });

    const afterOrientation = resolveViewport3DCameraOrientation({
      position: camera.position.toArray() as [number, number, number],
      target: target.toArray() as [number, number, number],
      up: camera.up.toArray() as [number, number, number],
    });

    expect(camera.position.distanceTo(beforePosition)).toBeLessThan(1e-12);
    expect(target.distanceTo(beforeTarget)).toBeGreaterThan(1e-6);
    expect(camera.position.distanceTo(target)).toBeCloseTo(
      beforeOrientation.distance,
    );
    expect(afterOrientation.yawDegrees).not.toBeCloseTo(
      beforeOrientation.yawDegrees,
    );
  });

  it("keeps the legacy object-bound orbit mode available", () => {
    const camera = new PerspectiveCamera(42, 1, 1e-12, 1e-3);
    const target = new Vector3(5e-6, -2e-6, 0);
    camera.up.set(0, 0, 1);
    camera.position.set(11.437336e-6, 2.634882e-6, 6.437336e-6);
    camera.lookAt(target);
    camera.updateMatrix();
    const beforePosition = camera.position.clone();
    const beforeTarget = target.clone();

    applyViewport3DNativeCameraOrbit({
      camera,
      deltaX: 300,
      deltaY: 0,
      rotationMode: "object",
      target,
      viewportHeightPixels: 528,
    });

    expect(target.distanceTo(beforeTarget)).toBeLessThan(1e-12);
    expect(camera.position.distanceTo(beforePosition)).toBeGreaterThan(1e-6);
    expect(camera.position.distanceTo(target)).toBeCloseTo(
      beforePosition.distanceTo(beforeTarget),
    );
  });

  it("calibrates pan so a desktop drag can cross a fitted micromagnetic view quickly", () => {
    const distance = resolveViewport3DPerspectivePanDistance({
      cameraDistance: 1.021571e-5,
      deltaPixels: 300,
      fovDegrees: 42,
      viewportHeightPixels: 528,
    });

    expect(distance).toBeGreaterThan(1e-5);
  });

  it("maps wheel deltas to bounded dolly distances", () => {
    expect(resolveWheelZoomDistance(1e-6, 1000)).toBeGreaterThan(1e-6);
    expect(resolveWheelZoomDistance(1e-6, -1000)).toBeLessThan(1e-6);
    expect(resolveWheelZoomDistance(0, 1000)).toBe(1e-12);
  });

  it("zooms decisively for a common mouse wheel notch while preserving bounds", () => {
    expect(resolveWheelZoomDistance(1e-6, 120)).toBeGreaterThan(1.3e-6);
    expect(resolveWheelZoomDistance(1e-6, -120)).toBeLessThan(7.7e-7);
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
      up: [0, 0, 1] as [number, number, number],
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
          up: [0, 0, 1],
        },
        lastAutoFitCameraState,
        nextBoundsSignature: "next",
        previousBoundsSignature: "previous",
      }),
    ).toBe(false);
  });

  it("treats sub-visual camera jitter as the same auto-fit camera", () => {
    const lastAutoFitCameraState = {
      position: [1, 2, 3] as [number, number, number],
      target: [0, 0, 0] as [number, number, number],
      up: [0, 0, 1] as [number, number, number],
    };

    expect(
      shouldAutoFitViewport3DBoundsChange({
        currentCameraState: {
          position: [1 + 2e-8, 2, 3],
          target: [0, 0, 0],
          up: [0, 0, 1],
        },
        lastAutoFitCameraState,
        nextBoundsSignature: "next",
        previousBoundsSignature: "previous",
      }),
    ).toBe(true);
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
