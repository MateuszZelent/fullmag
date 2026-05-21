import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";
import { MOUSE } from "three";

import {
  commitOrbitCameraEnd,
  resolveViewport3DCameraFit,
  resolveViewport3DCameraInteractionOptions,
  shouldApplyViewport3DCameraState,
  shouldAutoFitViewport3DBoundsChange,
} from "./CameraControls";
import {
  DEFAULT_VIEWPORT_3D_CAMERA_STATE,
  viewport3dStore,
} from "../viewport3dStore";

describe("CameraControls", () => {
  it("uses Drei OrbitControls instead of custom pointer and wheel handlers", () => {
    const source = readFileSync(
      new URL("./CameraControls.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain('import { OrbitControls } from "@react-three/drei"');
    expect(source).toContain("<OrbitControls");
    expect(source).not.toContain('addEventListener("pointerdown"');
    expect(source).not.toContain('addEventListener("pointermove"');
    expect(source).not.toContain('addEventListener("wheel"');
    expect(source).not.toContain("useNativeCameraGestures");
    expect(source).not.toContain("useWheelZoom");
  });

  it("configures native OrbitControls with the standard mouse mapping", () => {
    const options = resolveViewport3DCameraInteractionOptions();

    expect(options.enableDamping).toBe(false);
    expect(options.enablePan).toBe(true);
    expect(options.enableZoom).toBe(true);
    expect(options.panSpeed).toBe(1);
    expect(options.rotateSpeed).toBe(1);
    expect(options.screenSpacePanning).toBe(true);
    expect(options.mouseButtons).toEqual({
      LEFT: MOUSE.ROTATE,
      MIDDLE: MOUSE.DOLLY,
      RIGHT: MOUSE.PAN,
    });
  });

  it("keeps CameraController from echoing resource cameras back into the module store", () => {
    const source = readFileSync(
      new URL("./CameraControls.tsx", import.meta.url),
      "utf8",
    );
    const cameraResourceBlock = source.slice(
      source.indexOf('tracker.recordDirtyFrame("camera-resource")') - 320,
      source.indexOf('tracker.recordDirtyFrame("camera-resource")') + 80,
    );

    expect(cameraResourceBlock).not.toContain("viewport3dStore.setCamera(cameraState)");
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

  it("reapplies the same camera state when projection swaps the Three camera", () => {
    const cameraState = {
      position: [1, 2, 3] as [number, number, number],
      target: [0, 0, 0] as [number, number, number],
      up: [0, 0, 1] as [number, number, number],
    };

    expect(
      shouldApplyViewport3DCameraState({
        appliedCamera: "perspective-camera",
        appliedCameraState: cameraState,
        currentCamera: "orthographic-camera",
        nextCameraState: cameraState,
      }),
    ).toBe(true);
  });

  it("writes OrbitControls camera commits into the module store", () => {
    viewport3dStore.resetForTest();
    const onCameraChange = vi.fn();

    commitOrbitCameraEnd({
      cameraPosition: [3, 2, 1],
      controlTarget: [0.5, 0.25, 0],
      onCameraChange,
    });

    expect(viewport3dStore.getSnapshot().camera).toEqual(
      {
        position: [3, 2, 1],
        target: [0.5, 0.25, 0],
        up: [0, 0, 1],
      },
    );
    expect(viewport3dStore.getSnapshot().camera).not.toEqual(
      DEFAULT_VIEWPORT_3D_CAMERA_STATE,
    );
    expect(onCameraChange).toHaveBeenCalledWith({
      position: [3, 2, 1],
      target: [0.5, 0.25, 0],
      up: [0, 0, 1],
    });
  });
});
