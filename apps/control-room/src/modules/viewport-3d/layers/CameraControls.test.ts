import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";
import { MOUSE } from "three";

import {
  commitOrbitCameraEnd,
  normalizeViewport3DOrbitDebugAngles,
  resolveViewport3DOrbitDebugControlDeltas,
  resolveViewport3DOrbitDebugStep,
  resolveViewport3DCameraFit,
  resolveViewport3DCameraInteractionOptions,
  shouldApplyViewport3DOrbitDebugAngles,
  shouldApplyViewport3DCameraState,
  shouldAutoFitViewport3DBoundsChange,
  shouldSyncOrbitControlsTarget,
  VIEWPORT_3D_ORBIT_DEBUG_LIMITS,
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

  it("drives the temporary azimuth and polar panel through a local demand-rendered rig", () => {
    const source = readFileSync(
      new URL("./CameraControls.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("useFrame((_, deltaSeconds) => {");
    expect(source).toContain("controls.rotateLeft(deltas.rotateLeft)");
    expect(source).toContain("controls.rotateUp(deltas.rotateUp)");
    expect(source).toContain('tracker.recordDirtyFrame("camera-orbit-debug")');
    expect(source).toContain("orbitDebugCommitRevision");
  });

  it("normalizes temporary orbit debug angles to the requested control range", () => {
    expect(
      normalizeViewport3DOrbitDebugAngles({
        azimuth: -1,
        polar: Math.PI,
      }),
    ).toEqual({
      azimuth: VIEWPORT_3D_ORBIT_DEBUG_LIMITS.azimuthMin,
      polar: Math.PI,
    });

    expect(normalizeViewport3DOrbitDebugAngles(null)).toEqual({
      azimuth: 0,
      polar: Math.PI / 2,
    });
  });

  it("ignores sub-epsilon temporary orbit debug updates", () => {
    expect(
      shouldApplyViewport3DOrbitDebugAngles(
        { azimuth: 0, polar: Math.PI / 2 },
        { azimuth: Math.PI * 2 - 5e-7, polar: Math.PI / 2 },
      ),
    ).toBe(false);
    expect(
      shouldApplyViewport3DOrbitDebugAngles(
        { azimuth: 0, polar: Math.PI / 2 },
        { azimuth: 2e-6, polar: Math.PI / 2 },
      ),
    ).toBe(true);
  });

  it("smoothly steps temporary orbit debug angles toward the target", () => {
    const next = resolveViewport3DOrbitDebugStep({
      currentAngles: { azimuth: 0, polar: 0 },
      deltaSeconds: 1 / 60,
      targetAngles: { azimuth: Math.PI, polar: Math.PI / 2 },
    });

    expect(next.azimuth).toBeGreaterThan(0);
    expect(next.azimuth).toBeLessThan(Math.PI);
    expect(next.polar).toBeGreaterThan(0);
    expect(next.polar).toBeLessThan(Math.PI / 2);
  });

  it("maps absolute temporary orbit debug targets to OrbitControls deltas", () => {
    const deltas = resolveViewport3DOrbitDebugControlDeltas({
      currentAngles: { azimuth: 0.5, polar: 1.2 },
      targetAngles: { azimuth: 1.1, polar: 0.7 },
    });

    expect(deltas.rotateLeft).toBeCloseTo(-0.6);
    expect(deltas.rotateUp).toBeCloseTo(0.5);
  });

  it("keeps a full-turn azimuth target equivalent to zero without snapping the panel value", () => {
    expect(
      shouldApplyViewport3DOrbitDebugAngles(
        { azimuth: 0, polar: Math.PI / 2 },
        { azimuth: Math.PI * 2, polar: Math.PI / 2 },
      ),
    ).toBe(false);
    expect(
      resolveViewport3DOrbitDebugControlDeltas({
        currentAngles: { azimuth: 0, polar: Math.PI / 2 },
        targetAngles: { azimuth: Math.PI * 2, polar: Math.PI / 2 },
      }).rotateLeft,
    ).toBeCloseTo(0);
  });

  it("keeps temporary orbit debug changes local until the commit revision is requested", () => {
    const source = readFileSync(
      new URL("./CameraControls.tsx", import.meta.url),
      "utf8",
    );
    const requestBlock = source.slice(
      source.indexOf('tracker.recordDirtyFrame("camera-orbit-debug-request")') - 480,
      source.indexOf('tracker.recordDirtyFrame("camera-orbit-debug-request")') + 120,
    );
    const frameBlock = source.slice(
      source.indexOf("useFrame((_, deltaSeconds) => {"),
      source.indexOf("const recordOrbitControlFrame = useCallback"),
    );

    expect(requestBlock).not.toContain("commitOrbitCameraEnd");
    expect(frameBlock).toContain("pendingOrbitDebugCommitRevisionRef");
    expect(frameBlock).toContain("commitOrbitCameraEnd({");
  });

  it("does not re-render the debug panel on every OrbitControls change event", () => {
    const source = readFileSync(
      new URL("./CameraControls.tsx", import.meta.url),
      "utf8",
    );
    const changeBlock = source.slice(
      source.indexOf("const recordOrbitControlFrame = useCallback"),
      source.indexOf("const handleStart = useCallback"),
    );

    expect(changeBlock).toContain('tracker.recordDirtyFrame("camera-control")');
    expect(changeBlock).not.toContain("onOrbitDebugAnglesChange");
  });

  it("does not clamp OrbitControls zoom distance so users can enter the scene interior", () => {
    const source = readFileSync(
      new URL("./CameraControls.tsx", import.meta.url),
      "utf8",
    );
    const orbitControlsBlock = source.slice(
      source.indexOf("<OrbitControls"),
      source.indexOf("</OrbitControls>"),
    );

    expect(orbitControlsBlock).toContain("zoomToCursor");
    expect(orbitControlsBlock).not.toContain("minDistance");
    expect(orbitControlsBlock).not.toContain("maxDistance");
  });

  it("does not feed a stale declarative target back into OrbitControls during gestures", () => {
    const source = readFileSync(
      new URL("./CameraControls.tsx", import.meta.url),
      "utf8",
    );
    const targetSyncBlock = source.slice(
      source.indexOf('tracker.recordDirtyFrame("camera-control-target")') - 520,
      source.indexOf('tracker.recordDirtyFrame("camera-control-target")') + 90,
    );
    const orbitControlsBlock = source.slice(
      source.indexOf("<OrbitControls"),
      source.indexOf("</OrbitControls>"),
    );

    expect(targetSyncBlock).toContain("if (interactionActive) return;");
    expect(orbitControlsBlock).not.toContain("target={cameraState.target}");
  });

  it("skips OrbitControls target updates for reference-only target changes", () => {
    expect(
      shouldSyncOrbitControlsTarget([0, 0, 0], [5e-13, 0, 0]),
    ).toBe(false);
    expect(
      shouldSyncOrbitControlsTarget([0, 0, 0], [2e-12, 0, 0]),
    ).toBe(true);
  });

  it("does not passively apply resource camera state while OrbitControls are active", () => {
    const source = readFileSync(
      new URL("./CameraControls.tsx", import.meta.url),
      "utf8",
    );
    const cameraResourceBlock = source.slice(
      source.indexOf('tracker.recordDirtyFrame("camera-resource")') - 720,
      source.indexOf('tracker.recordDirtyFrame("camera-resource")') + 80,
    );

    expect(cameraResourceBlock).toContain("if (interactionActive) return;");
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
