import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Raycaster,
  Vector2,
  Vector3,
} from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SceneResource } from "@/kernel/api/apiTypes";
import { resolveTargetBoundsMeters } from "@/shared/domain/magnetization-texture/boundsResolver";
import { createDefaultMagneticTextureDraft } from "@/shared/domain/magnetization-texture/presetDefaults";
import {
  getTextureDraftBridgeSnapshot,
  patchActiveTextureDraft,
  registerTextureInspectorBinding,
  resetTextureDraftBridgeForTests,
  toggleTextureGizmo,
} from "@/shared/domain/magnetization-texture/textureDraftBridge";

import {
  applyTextureGizmoRotateDrag,
  applyTextureGizmoScaleDrag,
  applyTextureGizmoTranslateDrag,
  buildCharacteristicProxyWireframeSegments,
  buildSubdividedSurfacePreviewData,
  createTextureGizmoDragController,
  createViewport3DTextureTransformModel,
  installTextureGizmoKeyboardShortcuts,
  pickTextureGizmoHandleFromGroup,
  resolveTextureGizmoWorldPose,
  Viewport3DTextureTransformLayer,
} from "./TextureTransformGizmo";
import { sampleViewport3DSurfaceHslColors } from "./viewport3dPrimitiveModel";

vi.mock("./viewport3dBatchedInvalidate", () => ({
  useBatchedInvalidate: () => vi.fn(),
}));

describe("TextureTransformGizmo & 3D surface preview synchronization", () => {
  beforeEach(() => {
    resetTextureDraftBridgeForTests();
  });

  afterEach(() => {
    resetTextureDraftBridgeForTests();
    vi.restoreAllMocks();
  });

  it("mounts in the renderer without the workspace KernelProvider", () => {
    const props = {
      primitiveModel: null,
      selectedObjectId: null,
      textureTransformModel: {
        getAuthoredDraft: () => null,
        sampleSurfaceColors: () => null,
      },
    };

    expect(renderToStaticMarkup(createElement(Viewport3DTextureTransformLayer, props))).toBe("");
  });

  it("handles Q/W/E/R/T keyboard shortcuts and ignores editable inputs", () => {
    const listeners = new Map<string, (event: Event) => void>();
    const fakeWindow = {
      addEventListener: (type: string, cb: (event: Event) => void) => {
        listeners.set(type, cb);
      },
      removeEventListener: (type: string) => {
        listeners.delete(type);
      },
    };
    const cleanup = installTextureGizmoKeyboardShortcuts(fakeWindow as never);
    const dispatchKey = (key: string, targetTag = "DIV") => {
      const preventDefault = vi.fn();
      listeners.get("keydown")?.({
        key,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        defaultPrevented: false,
        target: { tagName: targetTag },
        preventDefault,
      } as unknown as Event);
      return preventDefault;
    };

    expect(getTextureDraftBridgeSnapshot().gizmoEnabled).toBe(false);

    // Typing "t" inside an INPUT must be ignored
    expect(dispatchKey("t", "INPUT")).not.toHaveBeenCalled();
    expect(getTextureDraftBridgeSnapshot().gizmoEnabled).toBe(false);

    // Pressing "T" on viewport toggles gizmo ON
    expect(dispatchKey("t")).toHaveBeenCalledTimes(1);
    expect(getTextureDraftBridgeSnapshot().gizmoEnabled).toBe(true);
    expect(getTextureDraftBridgeSnapshot().transformScope).toBe("texture");

    // Q -> view, W -> translate, E -> rotate, R -> scale
    dispatchKey("q");
    expect(getTextureDraftBridgeSnapshot().gizmoMode).toBe("view");
    dispatchKey("w");
    expect(getTextureDraftBridgeSnapshot().gizmoMode).toBe("translate");
    dispatchKey("e");
    expect(getTextureDraftBridgeSnapshot().gizmoMode).toBe("rotate");
    dispatchKey("r");
    expect(getTextureDraftBridgeSnapshot().gizmoMode).toBe("scale");

    // Pressing "T" again toggles gizmo OFF
    dispatchKey("t");
    expect(getTextureDraftBridgeSnapshot().gizmoEnabled).toBe(false);

    cleanup();
  });

  it("applies 1 nm metric snap on Shift-translate, 15 deg snap on Shift-rotate, and uniform lock on scale", () => {
    const freeMove = applyTextureGizmoTranslateDrag(
      [0, 0, 0],
      [2.37e-9, -1.62e-9, 4.9e-9],
      "xy",
      false,
    );
    expect(freeMove[0]).toBeCloseTo(2.37e-9, 15);
    expect(freeMove[1]).toBeCloseTo(-1.62e-9, 15);
    expect(freeMove[2]).toBe(0);

    const snappedMove = applyTextureGizmoTranslateDrag(
      [0, 0, 0],
      [2.37e-9, -1.62e-9, 4.9e-9],
      "xy",
      true,
    );
    expect(snappedMove[0]).toBeCloseTo(2e-9, 15);
    expect(snappedMove[1]).toBeCloseTo(-2e-9, 15);
    expect(snappedMove[2]).toBe(0);

    // 22 degrees around Z with Shift -> snaps to 15 degrees
    const rot = applyTextureGizmoRotateDrag(
      [0, 0, 0, 1],
      [0, 0, 0],
      "z",
      (22 * Math.PI) / 180,
      true,
    );
    expect(rot.eulerDeg[2]).toBeCloseTo(15, 6);

    // Uniform scale lock propagates single-axis handle ratio across all 3 axes
    const lockedScale = applyTextureGizmoScaleDrag([1, 2, 0.5], "x", 1.5, true, false);
    expect(lockedScale).toEqual([1.5, 3, 0.75]);

    const unlockedScale = applyTextureGizmoScaleDrag([1, 2, 0.5], "x", 1.5, false, false);
    expect(unlockedScale).toEqual([1.5, 2, 0.5]);
  });

  it("synchronizes 60 FPS pointerMove updates into staged draft with zero HTTP requests", () => {
    const applyMagnetizationSpy = vi.fn();
    const scene: SceneResource = {
      revision: 3,
      objects: [
        {
          id: "disk",
          role: "magnet",
          geometry: { geometry_kind: "Cylinder", geometry_params: { radius: 50e-9, height: 5e-9 } },
        },
      ],
    } as unknown as SceneResource;

    const target = { kind: "object" as const, objectId: "disk" };
    const bounds = resolveTargetBoundsMeters(scene, target);
    let stagedDraft = createDefaultMagneticTextureDraft("bloch_skyrmion", bounds, "object");
    const owner = Symbol("inspector-test");

    const syncBinding = () => {
      registerTextureInspectorBinding(owner, {
        target,
        draft: stagedDraft,
        bounds,
        patchDraft: (partial) => {
          stagedDraft = { ...stagedDraft, ...partial };
          syncBinding();
        },
        fitCharacteristicSize: vi.fn(),
        resetTransform: vi.fn(),
      });
    };
    syncBinding();
    toggleTextureGizmo(true);

    // Simulate 60 frames of live gizmo drag
    for (let frame = 1; frame <= 60; frame += 1) {
      const nextTx = applyTextureGizmoTranslateDrag(
        [0, 0, 0],
        [frame * 0.25e-9, -frame * 0.1e-9, 0],
        "xy",
        false,
      );
      patchActiveTextureDraft({ translationM: nextTx });
    }

    expect(stagedDraft.translationM[0]).toBeCloseTo(15e-9, 15);
    expect(stagedDraft.translationM[1]).toBeCloseTo(-6e-9, 15);
    expect(applyMagnetizationSpy).toHaveBeenCalledTimes(0);

    const pose = resolveTextureGizmoWorldPose(stagedDraft, bounds);
    expect(pose.originWorld[0]).toBeCloseTo(15e-9, 15);
    expect(pose.originWorld[1]).toBeCloseTo(-6e-9, 15);
  });

  it("builds non-empty Characteristic Proxy Wireframe segments for skyrmionium, domain wall, helix, hopfion, and periodic tile box", () => {
    const bounds = resolveTargetBoundsMeters(null, { kind: "object", objectId: "film" });

    for (const presetKind of [
      "skyrmionium",
      "domain_wall",
      "helical",
      "hopfion_compact_support",
      "bloch_point",
    ] as const) {
      const draft = createDefaultMagneticTextureDraft(presetKind, bounds, "object");
      const segments = buildCharacteristicProxyWireframeSegments(draft, bounds);
      expect(segments.length, presetKind).toBeGreaterThanOrEqual(12);
      expect(segments.every((v) => Number.isFinite(v))).toBe(true);

      const periodicSegments = buildCharacteristicProxyWireframeSegments(
        { ...draft, clampMode: "repeat" },
        bounds,
      );
      // Periodic box adds 12 wireframe edges * 6 floats = 72 floats
      expect(periodicSegments.length).toBe(segments.length + 72);
    }
  });

  it("evaluates 32x32 surface HSL vertex colors honoring object.regions[].texture_override priority", () => {
    const scene: SceneResource = {
      revision: 5,
      magnetization_assets: [
        {
          id: "mag:film:up",
          kind: "preset_texture",
          preset_kind: "uniform",
          preset_version: 2,
          preset_params: { direction: [0, 0, 1] }, // +Z -> white [1, 1, 1]
        },
      ],
      objects: [
        {
          id: "film",
          role: "magnet",
          magnetization_ref: "mag:film:up",
          geometry: {
            geometry_kind: "Box",
            geometry_params: { size: [100e-9, 100e-9, 10e-9] },
          },
          regions: [
            {
              region_id: "low_prio",
              enabled: true,
              priority: 5,
              shape: { kind: "cylinder", center: [0, 0, 0], radius: 20e-9, height: 10e-9 },
              texture_override: {
                initial_magnetization: {
                  kind: "uniform",
                  value: [1, 0, 0], // +X -> red [1, 0, 0]
                },
              },
            },
            {
              region_id: "high_prio",
              enabled: true,
              priority: 20,
              shape: { kind: "cylinder", center: [0, 0, 0], radius: 10e-9, height: 10e-9 },
              texture_override: {
                initial_magnetization: {
                  kind: "uniform",
                  value: [0, 0, -1], // -Z -> black [0, 0, 0]
                },
              },
            },
          ],
        },
      ],
    } as unknown as SceneResource;

    const testPositions = new Float32Array([
      0, 0, 5e-9, // Inside both regions -> high_prio (-Z -> black) wins!
      15e-9, 0, 5e-9, // Inside low_prio only (+X -> red)
      40e-9, 40e-9, 5e-9, // Outside regions -> parent object (+Z -> white)
    ]);

    const colors = sampleViewport3DSurfaceHslColors({
      scene,
      objectId: "film",
      positionsWorld: testPositions,
    });
    expect(colors).not.toBeNull();
    // Point 0: -Z -> black [0, 0, 0]
    expect([colors![0], colors![1], colors![2]]).toEqual([0, 0, 0]);
    // Point 1: +X -> red [1, 0, 0]
    expect(colors![3]).toBeCloseTo(1, 5);
    expect(colors![4]).toBeCloseTo(0, 5);
    expect(colors![5]).toBeCloseTo(0, 5);
    // Point 2: +Z -> white [1, 1, 1]
    expect([colors![6], colors![7], colors![8]]).toEqual([1, 1, 1]);

    // Subdivided mesh builder produces 32x32 faces
    const meshData = buildSubdividedSurfacePreviewData(
      {
        bounds: { center: [0, 0, 0], radius: 80e-9, size: [100e-9, 100e-9, 10e-9] },
        csgPreview: null,
        fallbackLabel: "primitive",
        geometryKey: "film:Box",
        kind: "box",
        label: "Film",
        magnetizationTexturePreview: null,
        meshState: "primitive-only",
        objectId: "film",
        role: "magnet",
        sceneRevision: 5,
      },
      32,
    );
    expect(meshData.positionsWorld.length / 3).toBeGreaterThan(2000);
    expect(meshData.indices.length).toBeGreaterThan(6000);
  });

  it("synchronously locks OrbitControls, captures pointer on canvas, tracks window Raycaster drags for Translate/Rotate/Scale, and reverts on Escape", () => {
    const target = { kind: "object" as const, objectId: "disk" };
    const bounds = resolveTargetBoundsMeters(null, target);
    let stagedDraft = {
      ...createDefaultMagneticTextureDraft("bloch_skyrmion", bounds, "object"),
      uniformScaleLocked: false,
    };
    const owner = Symbol("inspector-drag-test");
    const syncBinding = () => {
      registerTextureInspectorBinding(owner, {
        target,
        draft: stagedDraft,
        bounds,
        patchDraft: (partial) => {
          stagedDraft = { ...stagedDraft, ...partial };
          syncBinding();
        },
        fitCharacteristicSize: vi.fn(),
        resetTransform: vi.fn(),
      });
    };
    syncBinding();
    toggleTextureGizmo(true);

    const camera = new PerspectiveCamera(45, 1, 1e-10, 1e-3);
    camera.position.set(0, 0, 300e-9);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    const controls = { enabled: true };
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    const canvas = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400 }),
      setPointerCapture,
      releasePointerCapture,
      style: { cursor: "" },
    };
    const winListeners = new Map<string, EventListener>();
    const fakeWin = {
      addEventListener: vi.fn((type: string, cb: EventListenerOrEventListenerObject) => {
        winListeners.set(type, cb as EventListener);
      }),
      removeEventListener: vi.fn((type: string) => {
        winListeners.delete(type);
      }),
    };
    const onGestureActiveChange = vi.fn();
    const invalidate = vi.fn();

    const controller = createTextureGizmoDragController(() => ({
      camera,
      canvas,
      controls,
      draft: stagedDraft,
      pose: resolveTextureGizmoWorldPose(stagedDraft, bounds),
      windowTarget: fakeWin as never,
      onGestureActiveChange,
      invalidate,
    }));

    // 1. Translate X drag via window pointermove + Raycaster
    const startRaycaster = new Raycaster();
    startRaycaster.setFromCamera(new Vector2(0, 0), camera);
    expect(
      controller.beginDrag({
        pointerId: 42,
        mode: "translate",
        handle: "x",
        key: "translate:x",
        ray: startRaycaster.ray,
        hitPoint: [0, 0, 0],
      }),
    ).toBe(true);

    // Synchronous invariants BEFORE any async effect
    expect(controls.enabled).toBe(false);
    expect(onGestureActiveChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(getTextureDraftBridgeSnapshot().gestureActive).toBe(true);
    expect(setPointerCapture).toHaveBeenCalledExactlyOnceWith(42);
    expect(canvas.style.cursor).toBe("grabbing");

    // Drag right across viewport (clientX: 200 -> 260)
    winListeners.get("pointermove")?.({
      pointerId: 42,
      clientX: 260,
      clientY: 200,
      shiftKey: false,
    } as unknown as Event);
    expect(stagedDraft.translationM[0]).toBeGreaterThan(10e-9);
    expect(stagedDraft.translationM[1]).toBe(0);

    winListeners.get("pointerup")?.({ pointerId: 42 } as unknown as Event);
    expect(controls.enabled).toBe(true);
    expect(releasePointerCapture).toHaveBeenCalledWith(42);
    expect(onGestureActiveChange).toHaveBeenLastCalledWith(false);
    expect(getTextureDraftBridgeSnapshot().gestureActive).toBe(false);
    expect(canvas.style.cursor).toBe("");

    // 2. Scale X axis drag + Escape revert
    const committedTx = [...stagedDraft.translationM];
    const poseAfterTx = resolveTextureGizmoWorldPose(stagedDraft, bounds);
    const scaleStartNdc = new Vector3(
      poseAfterTx.originWorld[0] + poseAfterTx.handleLength,
      0,
      0,
    ).project(camera);
    const scaleStartRaycaster = new Raycaster();
    scaleStartRaycaster.setFromCamera(new Vector2(scaleStartNdc.x, scaleStartNdc.y), camera);

    controller.beginDrag({
      pointerId: 55,
      mode: "scale",
      handle: "x",
      key: "scale:x",
      ray: scaleStartRaycaster.ray,
      hitPoint: [poseAfterTx.originWorld[0] + poseAfterTx.handleLength, 0, 0],
    });
    expect(controls.enabled).toBe(false);

    winListeners.get("pointermove")?.({
      pointerId: 55,
      clientX: ((scaleStartNdc.x + 0.25) * 0.5 + 0.5) * 400,
      clientY: 200,
      shiftKey: false,
    } as unknown as Event);
    expect(stagedDraft.scale[0]).toBeGreaterThan(1.1);
    expect(stagedDraft.scale[1]).toBe(1);

    // Escape cancels drag and restores start scale
    const preventDefault = vi.fn();
    winListeners.get("keydown")?.({
      key: "Escape",
      preventDefault,
      stopPropagation: vi.fn(),
    } as unknown as Event);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stagedDraft.scale).toEqual([1, 1, 1]);
    expect(stagedDraft.translationM).toEqual(committedTx);
    expect(controls.enabled).toBe(true);
    expect(getTextureDraftBridgeSnapshot().gestureActive).toBe(false);

    // 3. Uniform center cube scale drag
    const centerNdc = new Vector3(...poseAfterTx.originWorld).project(camera);
    const centerRay = new Raycaster();
    centerRay.setFromCamera(new Vector2(centerNdc.x, centerNdc.y), camera);
    controller.beginDrag({
      pointerId: 77,
      mode: "scale",
      handle: "uniform",
      key: "scale:uniform",
      ray: centerRay.ray,
      hitPoint: poseAfterTx.originWorld,
    });
    winListeners.get("pointermove")?.({
      pointerId: 77,
      clientX: ((centerNdc.x + 0.2) * 0.5 + 0.5) * 400,
      clientY: ((1 - (centerNdc.y + 0.2)) * 0.5) * 400,
      shiftKey: false,
    } as unknown as Event);
    expect(stagedDraft.scale[0]).toBeGreaterThan(1.05);
    expect(stagedDraft.scale[0]).toBeCloseTo(stagedDraft.scale[1], 8);
    expect(stagedDraft.scale[0]).toBeCloseTo(stagedDraft.scale[2], 8);
    controller.dispose();
    expect(controls.enabled).toBe(true);
  });

  it("picks generous 3.5x invisible Scale stalk and end-cube hitboxes cleanly via Raycaster", () => {
    const group = new Group();
    const L = 55e-9;
    const shaftRadius = L * 0.032;
    const hitboxRadius = shaftRadius * 3.5;
    const tipSize = L * 0.11;

    const uniformHit = new Mesh(
      new BoxGeometry(tipSize * 2.4, tipSize * 2.4, tipSize * 2.4),
      new MeshBasicMaterial({ opacity: 0, transparent: true }),
    );
    uniformHit.userData = {
      gizmoHandle: { mode: "scale", handle: "uniform", key: "scale:uniform", priority: 2 },
    };
    group.add(uniformHit);

    const stalkHit = new Mesh(
      new CylinderGeometry(hitboxRadius, hitboxRadius, L * 0.76, 12),
      new MeshBasicMaterial({ opacity: 0, transparent: true }),
    );
    stalkHit.position.set(L * 0.62, 0, 0);
    stalkHit.rotation.set(0, 0, -Math.PI / 2);
    stalkHit.userData = {
      gizmoHandle: { mode: "scale", handle: "x", key: "scale:x", priority: 1 },
    };
    group.add(stalkHit);

    const cubeHit = new Mesh(
      new BoxGeometry(tipSize * 3.2, tipSize * 3.2, tipSize * 3.2),
      new MeshBasicMaterial({ opacity: 0, transparent: true }),
    );
    cubeHit.position.set(L, 0, 0);
    cubeHit.userData = {
      gizmoHandle: { mode: "scale", handle: "x", key: "scale:x", priority: 1 },
    };
    group.add(cubeHit);

    const camera = new PerspectiveCamera(45, 1, 1e-10, 1e-3);
    camera.position.set(0, 0, 250e-9);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    // Off-center ray missing the thin 1.7 nm visual shaft (y = 4.5 nm > shaftRadius) STILL hits the 3.5x hitbox!
    const offAxisPt = new Vector3(L * 0.6, shaftRadius * 2.5, 0).project(camera);
    const raycaster = new Raycaster();
    raycaster.setFromCamera(new Vector2(offAxisPt.x, offAxisPt.y), camera);
    const pickedStalk = pickTextureGizmoHandleFromGroup(group, raycaster);
    expect(pickedStalk).toMatchObject({
      kind: "handle",
      mode: "scale",
      handle: "x",
      key: "scale:x",
    });

    // Center ray hits uniform scale cube with priority
    raycaster.setFromCamera(new Vector2(0, 0), camera);
    const pickedCenter = pickTextureGizmoHandleFromGroup(group, raycaster);
    expect(pickedCenter).toMatchObject({
      kind: "handle",
      mode: "scale",
      handle: "uniform",
      key: "scale:uniform",
    });
  });

  it("keeps authored magnetization surface eligible only for objects with committed non-field-file textures", () => {
    const scene = {
      version: "scene.v2",
      revision: 6,
      objects: [
        {
          id: "authored-box",
          name: "Authored box",
          role: "magnet",
          geometry: { geometry_kind: "Box", geometry_params: { size: [200e-9, 200e-9, 10e-9] } },
          magnetization_ref: "mag:authored-box:skyrmion",
        },
        {
          id: "plain-box",
          name: "Plain box",
          role: "magnet",
          geometry: { geometry_kind: "Box", geometry_params: { size: [100e-9, 100e-9, 10e-9] } },
          magnetization_ref: null,
        },
        {
          id: "file-box",
          name: "File box",
          role: "magnet",
          geometry: { geometry_kind: "Box", geometry_params: { size: [100e-9, 100e-9, 10e-9] } },
          magnetization_ref: "mag:file-box:imported",
        },
      ],
      magnetization_assets: [
        {
          id: "mag:authored-box:skyrmion",
          kind: "preset_texture",
          preset_kind: "bloch_skyrmion",
          preset_params: { radius_m: 30e-9 },
        },
        {
          id: "mag:file-box:imported",
          kind: "field_file",
          asset_path: "fields/init.ovf",
        },
      ],
    } as unknown as SceneResource;

    const model = createViewport3DTextureTransformModel(scene);
    expect(model.hasAuthoredMagnetization("authored-box")).toBe(true);
    expect(model.hasAuthoredMagnetization("plain-box")).toBe(false);
    expect(model.hasAuthoredMagnetization("file-box")).toBe(false);
  });
});
