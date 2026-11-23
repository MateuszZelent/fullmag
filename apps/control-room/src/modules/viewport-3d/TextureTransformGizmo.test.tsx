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
import { defaultArrayAxisSpec } from "@/kernel/authoring/array3dModel";
import { resolveTargetBoundsMeters } from "@/shared/domain/magnetization-texture/boundsResolver";
import { samplePresetTextureV2Client } from "@/shared/domain/magnetization-texture/evaluateV2Client";
import {
  buildPresetSpecFromDraft,
  computeRelativePresetDefaults,
  createDefaultMagneticTextureDraft,
  switchDraftPresetPatch,
} from "@/shared/domain/magnetization-texture/presetDefaults";
import { MAGNETIZATION_TEXTURE_PRESETS } from "@/shared/domain/magnetization-texture/texturePresets";
import {
  getTextureDraftBridgeSnapshot,
  patchActiveTextureDraft,
  registerTextureInspectorBinding,
  resetTextureDraftBridgeForTests,
  toggleTextureGizmo,
} from "@/shared/domain/magnetization-texture/textureDraftBridge";

import { DEFAULT_OBJECT_VISUALIZATION } from "@/kernel/visualization/ObjectVisualizationController";
import {
  applyTextureGizmoRotateDrag,
  applyTextureGizmoScaleDrag,
  applyTextureGizmoTranslateDrag,
  buildAuthoredMagnetizationArrowBuffers,
  buildAuthoredMagnetizationArrowGlyphData,
  buildAuthoredMagnetizationArrowInstanceColors,
  buildAuthoredMagnetizationArrowSegments,
  buildAuthoredMagnetizationVectorGridPoints,
  buildCharacteristicProxyWireframeSegments,
  buildSubdividedSurfacePreviewData,
  createTextureGizmoDragController,
  createViewport3DTextureTransformModel,
  installTextureGizmoKeyboardShortcuts,
  pickTextureGizmoHandleFromGroup,
  resolveActiveAuthoredTextureSurfaceObjectIds,
  resolveTextureGizmoWorldPose,
  sampleAuthoredMagnetizationVectors,
  Viewport3DTextureTransformLayer,
} from "./TextureTransformGizmo";
import { magnetizationHslLinearRgb } from "./orientation/magnetizationColor";
import {
  buildViewport3DPrimitiveRenderModel,
  sampleViewport3DSurfaceHslColors,
} from "./viewport3dPrimitiveModel";

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
        hasAuthoredMagnetization: () => false,
        sampleSurfaceColors: () => null,
        sampleVectors: () => null,
      },
    };

    expect(renderToStaticMarkup(createElement(Viewport3DTextureTransformLayer, props))).toBe("");
  });

  it("scopes Q/W/E/R/T shortcuts to the 3D viewport or active gizmo/binding and ignores editable inputs", () => {
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
    const dispatchKey = (
      key: string,
      target: {
        tagName?: string;
        closest?: (selector: string) => unknown;
      } = { tagName: "DIV" },
    ) => {
      const preventDefault = vi.fn();
      listeners.get("keydown")?.({
        key,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        defaultPrevented: false,
        target,
        preventDefault,
      } as unknown as Event);
      return preventDefault;
    };
    const viewportCanvasTarget = { tagName: "CANVAS" };
    const viewportContainerTarget = {
      tagName: "DIV",
      closest: (selector: string) =>
        selector.includes(".fm-viewport-3d") ? { tagName: "DIV" } : null,
    };

    expect(getTextureDraftBridgeSnapshot().gizmoEnabled).toBe(false);

    // Keys outside the 3D viewport with no active gizmo/binding must NOT be intercepted
    for (const key of ["t", "q", "w", "e", "r"]) {
      expect(dispatchKey(key, { tagName: "DIV" })).not.toHaveBeenCalled();
    }
    expect(getTextureDraftBridgeSnapshot().gizmoEnabled).toBe(false);

    // Typing "t" inside an INPUT must be ignored even inside a viewport container
    expect(
      dispatchKey("t", {
        tagName: "INPUT",
        closest: () => ({ tagName: "DIV" }),
      }),
    ).not.toHaveBeenCalled();
    expect(getTextureDraftBridgeSnapshot().gizmoEnabled).toBe(false);

    // Pressing "T" on viewport canvas toggles gizmo ON
    expect(dispatchKey("t", viewportCanvasTarget)).toHaveBeenCalledTimes(1);
    expect(getTextureDraftBridgeSnapshot().gizmoEnabled).toBe(true);
    expect(getTextureDraftBridgeSnapshot().transformScope).toBe("texture");

    // Once gizmo is active, Q/W/E/R work even if target is a non-editable container
    expect(dispatchKey("q", { tagName: "DIV" })).toHaveBeenCalledTimes(1);
    expect(getTextureDraftBridgeSnapshot().gizmoMode).toBe("view");
    expect(dispatchKey("w", viewportContainerTarget)).toHaveBeenCalledTimes(1);
    expect(getTextureDraftBridgeSnapshot().gizmoMode).toBe("translate");
    expect(dispatchKey("e", viewportCanvasTarget)).toHaveBeenCalledTimes(1);
    expect(getTextureDraftBridgeSnapshot().gizmoMode).toBe("rotate");
    expect(dispatchKey("r", viewportCanvasTarget)).toHaveBeenCalledTimes(1);
    expect(getTextureDraftBridgeSnapshot().gizmoMode).toBe("scale");

    // Pressing "T" again toggles gizmo OFF
    expect(dispatchKey("t", viewportCanvasTarget)).toHaveBeenCalledTimes(1);
    expect(getTextureDraftBridgeSnapshot().gizmoEnabled).toBe(false);

    // After gizmo is OFF, outside-viewport keys are again left alone
    expect(dispatchKey("w", { tagName: "DIV" })).not.toHaveBeenCalled();

    // When an active texture inspector binding exists, T/W work from non-editable targets
    const owner = Symbol("shortcut-binding");
    const bounds = resolveTargetBoundsMeters(
      {
        revision: 1,
        objects: [
          {
            id: "disk",
            role: "magnet",
            geometry: {
              geometry_kind: "Cylinder",
              geometry_params: { radius: 50e-9, height: 5e-9 },
            },
          },
        ],
      } as unknown as SceneResource,
      { kind: "object", objectId: "disk" },
    );
    registerTextureInspectorBinding(owner, {
      target: { kind: "object", objectId: "disk" },
      draft: createDefaultMagneticTextureDraft("bloch_skyrmion", bounds, "object"),
      bounds,
      patchDraft: vi.fn(),
      fitCharacteristicSize: vi.fn(),
      resetTransform: vi.fn(),
    });
    expect(dispatchKey("t", { tagName: "DIV" })).toHaveBeenCalledTimes(1);
    expect(getTextureDraftBridgeSnapshot().gizmoEnabled).toBe(true);
    // Editable input is still ignored even when activeBinding & gizmoEnabled are true
    expect(dispatchKey("r", { tagName: "TEXTAREA" })).not.toHaveBeenCalled();

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

  it("samples authored magnetization vector grid down to budget 16 (default 196), lifts above surface, and builds solid 3D arrow transforms + linear-RGB instance colors", () => {
    const scene = {
      version: "scene.v2",
      revision: 8,
      objects: [
        {
          id: "skyrmion-slab",
          name: "Skyrmion slab",
          role: "magnet",
          geometry: {
            geometry_kind: "Box",
            geometry_params: { size: [100e-9, 100e-9, 5e-9] },
          },
          magnetization_ref: "mag:skyrmion-slab",
        },
        {
          id: "uniform-disk",
          name: "Uniform disk",
          role: "magnet",
          geometry: {
            geometry_kind: "Cylinder",
            geometry_params: { radius: 50e-9, height: 5e-9 },
          },
          magnetization_ref: "mag:uniform-x",
        },
      ],
      magnetization_assets: [
        {
          id: "mag:skyrmion-slab",
          kind: "preset_texture",
          preset_kind: "bloch_skyrmion",
          preset_version: 2,
          preset_params: { radius_m: 25e-9, wall_width_m: 8e-9, polarity: 1, chirality: 1 },
        },
        {
          id: "mag:uniform-x",
          kind: "preset_texture",
          preset_kind: "uniform",
          preset_version: 2,
          preset_params: { direction: [1, 0, 0] },
        },
      ],
    } as unknown as SceneResource;

    const slabObj = {
      bounds: { center: [0, 0, 0] as [number, number, number], radius: 75e-9, size: [100e-9, 100e-9, 5e-9] as [number, number, number] },
      csgPreview: null,
      fallbackLabel: "primitive",
      geometryKey: "skyrmion-slab:Box",
      kind: "box" as const,
      label: "Skyrmion slab",
      magnetizationTexturePreview: null,
      meshState: "primitive-only" as const,
      objectId: "skyrmion-slab",
      role: "magnet",
      sceneRevision: 8,
    };

    // Budget clamping (min 16, default 196, max 2000) & zero budget
    expect(buildAuthoredMagnetizationVectorGridPoints(slabObj, { budget: 0 }).count).toBe(0);
    const defaultGrid = buildAuthoredMagnetizationVectorGridPoints(slabObj, {
      geometryScope: "surface",
    });
    expect(defaultGrid.count).toBe(196);
    const lowGrid = buildAuthoredMagnetizationVectorGridPoints(slabObj, {
      budget: 12,
      geometryScope: "surface",
    });
    expect(lowGrid.count).toBe(16);
    const midLowGrid = buildAuthoredMagnetizationVectorGridPoints(slabObj, {
      budget: 25,
      geometryScope: "surface",
    });
    expect(midLowGrid.count).toBe(25);
    const highGrid = buildAuthoredMagnetizationVectorGridPoints(slabObj, {
      budget: 9999,
      geometryScope: "full",
    });
    expect(highGrid.count).toBeLessThanOrEqual(2000);
    expect(highGrid.count).toBeGreaterThanOrEqual(16);

    // Default thin-film surface lift sits cleanly above top face (+hz = 2.5 nm)
    // and respects Z-buffer depth occlusion (renderOnTop = false) so lower-layer
    // vectors never bleed through an upper layer in multilayer stacks.
    expect(defaultGrid.renderOnTop).toBe(false);
    const defaultZ = defaultGrid.positionsWorld[2]!;
    const expectedMinLift = Math.max(defaultGrid.pitch * 0.16, 100e-9 * 0.006);
    expect(defaultZ).toBeCloseTo(2.5e-9 + expectedMinLift, 15);
    const liftedGrid = buildAuthoredMagnetizationVectorGridPoints(slabObj, {
      geometryScope: "surface",
      surfaceOffsetEnabled: true,
      surfaceOffsetScale: 1,
    });
    expect(liftedGrid.positionsWorld[2]!).toBeGreaterThan(defaultZ);

    // Evaluate skyrmion vectors through textureTransformModel
    const model = createViewport3DTextureTransformModel(scene);
    const sampled = model.sampleVectors({
      objectId: "skyrmion-slab",
      positionsWorld: lowGrid.positionsWorld,
    });
    expect(sampled).not.toBeNull();
    expect(sampled!.length).toBe(lowGrid.count * 3);
    // All sampled spins are unit vectors
    for (let i = 0; i < lowGrid.count; i += 1) {
      const mag = Math.hypot(sampled![i * 3]!, sampled![i * 3 + 1]!, sampled![i * 3 + 2]!);
      expect(mag).toBeCloseTo(1, 5);
    }

    // 7-channel segment builder + real 3D solid instanced arrow transforms
    const singleAnchor = new Float32Array([0, 0, 0]);
    const unitX = new Float32Array([1, 0, 0]);
    const segmentsCentered = buildAuthoredMagnetizationArrowSegments(singleAnchor, unitX, 10e-9, {
      centeringEnabled: true,
      lengthScale: 1,
    });
    expect(segmentsCentered.length).toBe(7);
    // Length = 0.85 * pitch = 8.5 nm, centered around 0 -> [-4.25 nm, +4.25 nm]
    expect(segmentsCentered[0]).toBeCloseTo(-4.25e-9, 15);
    expect(segmentsCentered[3]).toBeCloseTo(4.25e-9, 15);
    expect(segmentsCentered[6]).toBeCloseTo(1, 6);

    const segmentsScaled = buildAuthoredMagnetizationArrowSegments(singleAnchor, unitX, 10e-9, {
      centeringEnabled: false,
      lengthScale: 2,
    });
    // Tail starts at anchor 0, tip extends to 2 * 0.85 * pitch = 17 nm
    expect(segmentsScaled[0]).toBeCloseTo(0, 15);
    expect(segmentsScaled[3]).toBeCloseTo(17e-9, 15);

    // Thickness & lengthScale scaling on solid 3D cylinder shaft + cone head transforms
    const baseGlyph = buildAuthoredMagnetizationArrowGlyphData(singleAnchor, unitX, 10e-9, {
      centeringEnabled: true,
      colorMode: "orientation",
      lengthScale: 1,
      thickness: 1,
    });
    const thickGlyph = buildAuthoredMagnetizationArrowGlyphData(singleAnchor, unitX, 10e-9, {
      centeringEnabled: true,
      colorMode: "orientation",
      lengthScale: 1,
      thickness: 2.5,
    });
    const longGlyph = buildAuthoredMagnetizationArrowGlyphData(singleAnchor, unitX, 10e-9, {
      centeringEnabled: true,
      colorMode: "orientation",
      lengthScale: 2,
      thickness: 1,
    });
    expect(baseGlyph.arrowCount).toBe(1);
    const baseLen = 8.5e-9;
    // Shaft length = (1 - 0.34) * arrowLen, head length = 0.34 * arrowLen
    expect(baseGlyph.transforms.shaftScales[1]).toBeCloseTo(baseLen * 0.66, 15);
    expect(baseGlyph.transforms.headScales[1]).toBeCloseTo(baseLen * 0.34, 15);
    // Radii scale directly with thickness (0.052 * thickness, 0.145 * thickness)
    expect(baseGlyph.transforms.shaftScales[0]).toBeCloseTo(baseLen * 0.052, 15);
    expect(baseGlyph.transforms.headScales[0]).toBeCloseTo(baseLen * 0.145, 15);
    expect(thickGlyph.transforms.shaftScales[0]! / baseGlyph.transforms.shaftScales[0]!).toBeCloseTo(2.5, 6);
    expect(thickGlyph.transforms.headScales[0]! / baseGlyph.transforms.headScales[0]!).toBeCloseTo(2.5, 6);
    // Length scales directly with lengthScale
    expect(longGlyph.transforms.shaftScales[1]! / baseGlyph.transforms.shaftScales[1]!).toBeCloseTo(2, 6);
    expect(longGlyph.transforms.headScales[1]! / baseGlyph.transforms.headScales[1]!).toBeCloseTo(2, 6);
    // Thickness clamping (0.25..4)
    const minThick = buildAuthoredMagnetizationArrowGlyphData(singleAnchor, unitX, 10e-9, {
      thickness: 0.01,
    });
    const maxThick = buildAuthoredMagnetizationArrowGlyphData(singleAnchor, unitX, 10e-9, {
      thickness: 99,
    });
    expect(minThick.transforms.shaftScales[0]).toBeCloseTo(baseLen * 0.052 * 0.25, 15);
    expect(maxThick.transforms.headScales[0]).toBeCloseTo(baseLen * 0.145 * 4, 15);

    // All per-instance color modes produce valid finite linear-RGB colors
    const multiPos = new Float32Array([
      0, 0, 0,
      10e-9, 0, 0,
      20e-9, 0, 0,
      30e-9, 0, 0,
    ]);
    const multiVec = new Float32Array([
      1, 0, 0, // +X, mag 1
      0, -0.5, 0, // -Y, mag 0.5
      0, 0, -1, // -Z, mag 1
      0, 0, 1, // +Z, mag 1
    ]);
    const multiSegments = buildAuthoredMagnetizationArrowSegments(multiPos, multiVec, 10e-9);
    for (const mode of ["orientation", "monochrome", "magnitude", "x", "y", "z"] as const) {
      const colors = buildAuthoredMagnetizationArrowInstanceColors(multiSegments, {
        colorMode: mode,
        fallbackMonoColor: "#808080",
        monoColor: "var(--fm-accent)",
        scalarColorPalette: "coolwarm",
      });
      expect(colors.length, mode).toBe(12);
      for (let i = 0; i < colors.length; i += 1) {
        expect(Number.isFinite(colors[i]!), `${mode}[${i}]`).toBe(true);
        expect(colors[i]!, `${mode}[${i}]`).toBeGreaterThanOrEqual(0);
        expect(colors[i]!, `${mode}[${i}]`).toBeLessThanOrEqual(1);
      }
    }

    // Orientation coloring matches magnetizationHslLinearRgb(1, 0, 0)
    const [expectedR, expectedG, expectedB] = magnetizationHslLinearRgb(1, 0, 0);
    expect(baseGlyph.colors[0]).toBeCloseTo(expectedR, 5);
    expect(baseGlyph.colors[1]).toBeCloseTo(expectedG, 5);
    expect(baseGlyph.colors[2]).toBeCloseTo(expectedB, 5);

    // Monochrome converts sRGB midtone (#808080 ~ 0.502 sRGB -> ~0.2159 linear)
    const monoLinear = buildAuthoredMagnetizationArrowInstanceColors(segmentsCentered, {
      colorMode: "monochrome",
      fallbackMonoColor: "#808080",
      monoColor: "var(--fm-accent)",
    });
    expect(monoLinear[0]).toBeCloseTo(0.21586, 3);
    expect(monoLinear[1]).toBeCloseTo(0.21586, 3);
    expect(monoLinear[2]).toBeCloseTo(0.21586, 3);

    // Component ("z") distinguishes -Z (blue) vs +Z (red) in coolwarm
    const zColors = buildAuthoredMagnetizationArrowInstanceColors(multiSegments, {
      colorMode: "z",
      scalarColorPalette: "coolwarm",
    });
    expect(zColors[6 + 2]!).toBeGreaterThan(zColors[6]!);
    expect(zColors[9]!).toBeGreaterThan(zColors[9 + 2]!);

    // Magnitude distinguishes 0.5 vs 1.0 in viridis
    const magColors = buildAuthoredMagnetizationArrowInstanceColors(multiSegments, {
      colorMode: "magnitude",
      scalarColorPalette: "viridis",
    });
    expect(magColors[0]).not.toBeCloseTo(magColors[3]!, 2);

    // Legacy buildAuthoredMagnetizationArrowBuffers export remains compatible
    const legacyCentered = buildAuthoredMagnetizationArrowBuffers(singleAnchor, unitX, 10e-9, {
      centeringEnabled: true,
      colorMode: "orientation",
      lengthScale: 1,
    });
    expect(legacyCentered.arrowCount).toBe(1);
    expect(legacyCentered.positions.length).toBe(18);
    expect(legacyCentered.positions[0]).toBeCloseTo(-4.25e-9, 15);
    expect(legacyCentered.positions[3]).toBeCloseTo(4.25e-9, 15);

    // Direct sampleAuthoredMagnetizationVectors returns null for unknown object
    expect(
      sampleAuthoredMagnetizationVectors({
        scene,
        objectId: "missing",
        positionsWorld: singleAnchor,
      }),
    ).toBeNull();
  });

  it("renders AuthoredMagnetizationPersistentVectors as instanced 3D shaft + head meshes when vectorsVisible is enabled and suppresses when covered by live field or saved viewport", () => {
    const scene = {
      version: "scene.v2",
      revision: 9,
      objects: [
        {
          id: "authored-box",
          name: "Authored box",
          role: "magnet",
          geometry: { geometry_kind: "Box", geometry_params: { size: [100e-9, 100e-9, 5e-9] } },
          magnetization_ref: "mag:authored-box",
        },
      ],
      magnetization_assets: [
        {
          id: "mag:authored-box",
          kind: "preset_texture",
          preset_kind: "bloch_skyrmion",
          preset_version: 2,
          preset_params: { radius_m: 25e-9 },
        },
      ],
    } as unknown as SceneResource;

    const primitiveModel = {
      sceneRevision: 9,
      objects: [
        {
          bounds: { center: [0, 0, 0] as [number, number, number], radius: 75e-9, size: [100e-9, 100e-9, 5e-9] as [number, number, number] },
          csgPreview: null,
          fallbackLabel: "primitive",
          geometryKey: "authored-box:Box",
          kind: "box" as const,
          label: "Authored box",
          magnetizationTexturePreview: null,
          meshState: "primitive-only" as const,
          objectId: "authored-box",
          role: "magnet",
          sceneRevision: 9,
        },
      ],
    };

    const textureTransformModel = createViewport3DTextureTransformModel(scene);

    // Vectors ON even when surface shader is OFF (wireframe/vectors-only mode) -> emits two <instancedMesh> (shaft + head)
    const vectorsOnlyMarkup = renderToStaticMarkup(
      createElement(Viewport3DTextureTransformLayer, {
        getObjectSettings: () => ({
          ...DEFAULT_OBJECT_VISUALIZATION,
          activeQuantityId: "",
          primitiveVisible: false,
          shaderVisible: false,
          vectorThickness: 1.5,
          vectorsVisible: true,
          visible: true,
        }),
        liveFieldCoveredObjectIds: new Set(),
        primitiveModel,
        savedViewportActive: false,
        selectedObjectId: null,
        textureTransformModel,
      }),
    );
    expect(vectorsOnlyMarkup.match(/<instancedMesh\b/g)?.length).toBe(2);
    expect(vectorsOnlyMarkup).not.toContain("<lineSegments");

    // Suppressed when live solver field covers the object
    const liveCoveredMarkup = renderToStaticMarkup(
      createElement(Viewport3DTextureTransformLayer, {
        getObjectSettings: () => ({
          ...DEFAULT_OBJECT_VISUALIZATION,
          vectorsVisible: true,
          visible: true,
        }),
        liveFieldCoveredObjectIds: new Set(["authored-box"]),
        primitiveModel,
        savedViewportActive: false,
        selectedObjectId: null,
        textureTransformModel,
      }),
    );
    expect(liveCoveredMarkup).toBe("");

    // Suppressed when saved viewport playback is active
    const savedPlaybackMarkup = renderToStaticMarkup(
      createElement(Viewport3DTextureTransformLayer, {
        getObjectSettings: () => ({
          ...DEFAULT_OBJECT_VISUALIZATION,
          vectorsVisible: true,
          visible: true,
        }),
        liveFieldCoveredObjectIds: new Set(),
        primitiveModel,
        savedViewportActive: true,
        selectedObjectId: null,
        textureTransformModel,
      }),
    );
    expect(savedPlaybackMarkup).toBe("");

    // Suppressed when user chose a different quantity (e.g. H_demag)
    const otherQuantityMarkup = renderToStaticMarkup(
      createElement(Viewport3DTextureTransformLayer, {
        getObjectSettings: () => ({
          ...DEFAULT_OBJECT_VISUALIZATION,
          activeQuantityId: "H_demag",
          vectorsVisible: true,
          visible: true,
        }),
        liveFieldCoveredObjectIds: new Set(),
        primitiveModel,
        savedViewportActive: false,
        selectedObjectId: null,
        textureTransformModel,
      }),
    );
    expect(otherQuantityMarkup).toBe("");
  });

  it("renders perforated ExtrudeGeometry surface preview (zero triangles inside holes) and filters vector arrows out of 3x3 antidot holes", () => {
    const holeRadius = 16e-9;
    const holePitch = 80e-9;
    const holeCenters: readonly [number, number][] = [
      [-holePitch, -holePitch],
      [0, -holePitch],
      [holePitch, -holePitch],
      [-holePitch, 0],
      [0, 0],
      [holePitch, 0],
      [-holePitch, holePitch],
      [0, holePitch],
      [holePitch, holePitch],
    ];

    const scene = {
      version: "scene.v2",
      revision: 12,
      objects: [
        {
          id: "film",
          name: "Film",
          role: "magnet",
          magnetization_ref: "mag:film:dw",
          geometry: {
            geometry_kind: "Difference",
            geometry_params: {
              operands: [
                {
                  enabled: true,
                  geometry: {
                    geometry_kind: "Box",
                    geometry_params: { size: [300e-9, 300e-9, 20e-9] },
                  },
                  label: "Base Film",
                  operand_id: "op:base",
                },
                {
                  enabled: true,
                  geometry: {
                    geometry_kind: "Array3D",
                    geometry_params: {
                      axes: [
                        defaultArrayAxisSpec("x", {
                          count: 3,
                          direction: "symmetric",
                          enabled: true,
                          pitch_m: holePitch,
                        }),
                        defaultArrayAxisSpec("y", {
                          count: 3,
                          direction: "symmetric",
                          enabled: true,
                          pitch_m: holePitch,
                        }),
                        defaultArrayAxisSpec("z", { count: 1, enabled: false, pitch_m: 100e-9 }),
                      ],
                      child: {
                        geometry_kind: "Cylinder",
                        geometry_params: { axis: [0, 0, 1], height: 24e-9, radius: holeRadius },
                      },
                      merge_overlapping: false,
                    },
                  },
                  label: "Antidot 3x3",
                  operand_id: "op:holes",
                },
              ],
            },
          },
        },
      ],
      magnetization_assets: [
        {
          id: "mag:film:dw",
          kind: "preset_texture",
          preset_kind: "domain_wall",
          preset_version: 2,
          preset_params: { wall_width_m: 20e-9, normal_axis: "x" },
        },
      ],
    } as unknown as SceneResource;

    // Bounds resolver must return exact 300 x 300 x 20 nm (not 100nm default)
    const resolvedBounds = resolveTargetBoundsMeters(scene, { kind: "object", objectId: "film" });
    expect(resolvedBounds.source).toBe("object-primitive");
    expect(resolvedBounds.size[0]).toBeCloseTo(300e-9, 15);
    expect(resolvedBounds.size[1]).toBeCloseTo(300e-9, 15);
    expect(resolvedBounds.size[2]).toBeCloseTo(20e-9, 15);

    const primitiveModel = buildViewport3DPrimitiveRenderModel(scene, null);
    const filmObj = primitiveModel.objects[0]!;
    expect(filmObj.kind).toBe("composite");

    // 1. Subdivided surface preview must use perforated ExtrudeGeometry with 9 holes
    const surface = buildSubdividedSurfacePreviewData(filmObj, 32);
    expect(surface.sourceGeometryType).toBe("ExtrudeGeometry");
    expect(surface.analyticalHoleCount).toBe(9);
    expect(surface.positionsWorld.length / 3).toBeGreaterThan(800);
    expect(surface.indices.length / 3).toBeGreaterThan(1200);

    // Zero vertices and zero triangle centroids may fall strictly inside any of the 9 holes
    const innerTol = holeRadius - 1e-9;
    let vertexViolations = 0;
    for (let i = 0; i < surface.positionsWorld.length; i += 3) {
      const vx = surface.positionsWorld[i]!;
      const vy = surface.positionsWorld[i + 1]!;
      for (const [hx, hy] of holeCenters) {
        if (Math.hypot(vx - hx, vy - hy) < innerTol) vertexViolations += 1;
      }
    }
    expect(vertexViolations).toBe(0);

    let centroidViolations = 0;
    for (let t = 0; t + 2 < surface.indices.length; t += 3) {
      const i0 = surface.indices[t]! * 3;
      const i1 = surface.indices[t + 1]! * 3;
      const i2 = surface.indices[t + 2]! * 3;
      const cx =
        (surface.positionsWorld[i0]! +
          surface.positionsWorld[i1]! +
          surface.positionsWorld[i2]!) /
        3;
      const cy =
        (surface.positionsWorld[i0 + 1]! +
          surface.positionsWorld[i1 + 1]! +
          surface.positionsWorld[i2 + 1]!) /
        3;
      for (const [hx, hy] of holeCenters) {
        if (Math.hypot(cx - hx, cy - hy) < innerTol) centroidViolations += 1;
      }
    }
    expect(centroidViolations).toBe(0);

    // 2. Vector arrow grids (both surface and full) must place ZERO arrows inside any of the 9 holes
    for (const scope of ["surface", "full"] as const) {
      const grid = buildAuthoredMagnetizationVectorGridPoints(filmObj, {
        budget: 400,
        geometryScope: scope,
      });
      expect(grid.count, scope).toBeGreaterThan(100);
      for (let i = 0; i < grid.count; i += 1) {
        const ax = grid.positionsWorld[i * 3]!;
        const ay = grid.positionsWorld[i * 3 + 1]!;
        for (const [hx, hy] of holeCenters) {
          expect(Math.hypot(ax - hx, ay - hy), `${scope} arrow ${i}`).toBeGreaterThan(
            holeRadius - 1e-12,
          );
        }
      }
    }

    // 3. Z-fighting suppression marks film as texture-covered when persistent or live surface is active
    const textureTransformModel = createViewport3DTextureTransformModel(scene);
    const suppressedPersistent = resolveActiveAuthoredTextureSurfaceObjectIds({
      activeLiveSurfaceKey: null,
      getObjectSettings: () => ({
        ...DEFAULT_OBJECT_VISUALIZATION,
        primitiveVisible: true,
        shaderVisible: false,
        surfaceColorSource: "orientation",
        visible: true,
      }),
      liveFieldCoveredObjectIds: new Set(),
      primitiveModel,
      savedViewportActive: false,
      selectedObjectId: null,
      textureTransformModel,
    });
    expect(suppressedPersistent.has("film")).toBe(true);

    // Wireframe-only or live-field-covered objects are NOT suppressed
    const notSuppressedLiveField = resolveActiveAuthoredTextureSurfaceObjectIds({
      activeLiveSurfaceKey: null,
      getObjectSettings: () => DEFAULT_OBJECT_VISUALIZATION,
      liveFieldCoveredObjectIds: new Set(["film"]),
      primitiveModel,
      savedViewportActive: false,
      selectedObjectId: null,
      textureTransformModel,
    });
    expect(notSuppressedLiveField.has("film")).toBe(false);

    // Active live binding suppresses base primitive solid
    const suppressedLiveDraft = resolveActiveAuthoredTextureSurfaceObjectIds({
      activeLiveSurfaceKey: "film",
      getObjectSettings: () => ({
        ...DEFAULT_OBJECT_VISUALIZATION,
        surfaceColorSource: "solid",
      }),
      liveFieldCoveredObjectIds: new Set(),
      primitiveModel,
      savedViewportActive: false,
      selectedObjectId: "film",
      textureTransformModel,
    });
    expect(suppressedLiveDraft.has("film")).toBe(true);
  });

  it("renders Magnetic Texture preview and vector arrows across ALL top-level Array3D instances with zero vertices or arrows in inter-dot gaps", () => {
    const dotRadius = 20e-9;
    const pitch = 120e-9;
    const scene = {
      version: "scene.v2",
      revision: 13,
      objects: [
        {
          id: "dot_array",
          name: "Dot Array",
          role: "magnet",
          magnetization_ref: "mag:dots:vortex",
          geometry: {
            geometry_kind: "Array3D",
            geometry_params: {
              axes: [
                defaultArrayAxisSpec("x", { count: 2, direction: "symmetric", enabled: true, pitch_m: pitch }),
                defaultArrayAxisSpec("y", { count: 2, direction: "symmetric", enabled: true, pitch_m: pitch }),
                defaultArrayAxisSpec("z", { count: 1, enabled: false, pitch_m: 100e-9 }),
              ],
              child: {
                geometry_kind: "Cylinder",
                geometry_params: { axis: [0, 0, 1], height: 15e-9, radius: dotRadius },
              },
              merge_overlapping: false,
            },
          },
        },
      ],
      magnetization_assets: [
        {
          id: "mag:dots:vortex",
          kind: "preset_texture",
          preset_kind: "vortex",
          preset_version: 2,
          preset_params: { core_radius_m: 10e-9 },
        },
      ],
    } as unknown as SceneResource;

    const primitiveModel = buildViewport3DPrimitiveRenderModel(scene, null);
    const arrayObj = primitiveModel.objects[0]!;
    expect(arrayObj.kind).toBe("array3d");

    const surface = buildSubdividedSurfacePreviewData(arrayObj, 24);
    expect(surface.instanceCount).toBe(4);
    expect(surface.positionsWorld.length / 3).toBeGreaterThan(100);
    // Every vertex must belong to one of the 4 cylinders at (±60nm, ±60nm) — never in the gap at (0,0)
    const centers: readonly [number, number][] = [
      [-60e-9, -60e-9],
      [60e-9, -60e-9],
      [-60e-9, 60e-9],
      [60e-9, 60e-9],
    ];
    for (let i = 0; i < surface.positionsWorld.length; i += 3) {
      const vx = surface.positionsWorld[i]!;
      const vy = surface.positionsWorld[i + 1]!;
      const minDist = Math.min(...centers.map(([cx, cy]) => Math.hypot(vx - cx, vy - cy)));
      expect(minDist).toBeLessThanOrEqual(dotRadius + 1e-9);
    }

    const arrows = buildAuthoredMagnetizationVectorGridPoints(arrayObj, {
      budget: 64,
      geometryScope: "surface",
    });
    expect(arrows.count).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < arrows.count; i += 1) {
      const ax = arrows.positionsWorld[i * 3]!;
      const ay = arrows.positionsWorld[i * 3 + 1]!;
      const minDist = Math.min(...centers.map(([cx, cy]) => Math.hypot(ax - cx, ay - cy)));
      expect(minDist).toBeLessThanOrEqual(dotRadius + 1e-9);
    }
  });

  it("evaluates every preset default cleanly on 300x300x20 nm bounds (including skyrmion_lattice) via samplePresetTextureV2Client", () => {
    const scene = {
      version: "scene.v2",
      revision: 1,
      objects: [
        {
          id: "film_300",
          name: "Film 300nm",
          role: "magnet",
          geometry: {
            geometry_kind: "Box",
            geometry_params: { size: [300e-9, 300e-9, 20e-9] },
          },
        },
      ],
    } as unknown as SceneResource;

    const bounds = resolveTargetBoundsMeters(scene, { kind: "object", objectId: "film_300" });
    expect(bounds.size).toEqual([300e-9, 300e-9, 20e-9]);

    let switchedDraft = createDefaultMagneticTextureDraft("uniform", bounds, "object");
    for (const preset of MAGNETIZATION_TEXTURE_PRESETS) {
      const freshDraft = createDefaultMagneticTextureDraft(preset.id, bounds, "object");
      const freshSpec = buildPresetSpecFromDraft(freshDraft, bounds);
      const freshVec = samplePresetTextureV2Client(freshSpec, [0, 0, 0], bounds);
      expect(Math.hypot(freshVec[0], freshVec[1], freshVec[2]), preset.id).toBeCloseTo(1, 9);

      switchedDraft = {
        ...switchedDraft,
        ...switchDraftPresetPatch(switchedDraft, preset.id, bounds),
      };
      const switchedSpec = buildPresetSpecFromDraft(switchedDraft, bounds);
      const switchedVec = samplePresetTextureV2Client(switchedSpec, [10e-9, -10e-9, 0], bounds);
      expect(Math.hypot(switchedVec[0], switchedVec[1], switchedVec[2]), `${preset.id} switch`).toBeCloseTo(1, 9);

      const relParams = computeRelativePresetDefaults(preset.id, bounds);
      const relVec = samplePresetTextureV2Client(
        {
          preset_kind: preset.id,
          preset_version: 2,
          preset_params: relParams,
        },
        [0, 0, 0],
        bounds,
      );
      expect(Math.hypot(relVec[0], relVec[1], relVec[2]), `${preset.id} relative`).toBeCloseTo(1, 9);
    }

    const skyrmionLatticeDraft = createDefaultMagneticTextureDraft("skyrmion_lattice", bounds, "object");
    expect(skyrmionLatticeDraft.latticeConstantM).toBeGreaterThan(2 * skyrmionLatticeDraft.radiusM);
  });

  it("isolates transient invalid draft parameters in viewport 3D samplers without silencing samplePresetTextureV2Client", () => {
    const scene = {
      version: "scene.v2",
      revision: 2,
      magnetization_assets: [
        {
          id: "mag:invalid_lattice",
          kind: "preset_texture",
          preset_kind: "skyrmion_lattice",
          preset_version: 2,
          preset_params: {
            plane: "xy",
            lattice: "hexagonal",
            lattice_constant: 40e-9,
            radius: 30e-9,
            wall_width: 5e-9,
            kind: "bloch",
            core_polarity: -1,
            chirality: 1,
          },
        },
      ],
      objects: [
        {
          id: "film_300",
          name: "Film 300nm",
          role: "magnet",
          magnetization_ref: "mag:invalid_lattice",
          geometry: {
            geometry_kind: "Box",
            geometry_params: { size: [300e-9, 300e-9, 20e-9] },
          },
        },
      ],
    } as unknown as SceneResource;

    const bounds = resolveTargetBoundsMeters(scene, { kind: "object", objectId: "film_300" });
    const invalidDraft = {
      ...createDefaultMagneticTextureDraft("skyrmion_lattice", bounds, "object"),
      latticeConstantM: 40e-9,
      radiusM: 30e-9, // violates lattice_constant > 2 * radius
    };
    const invalidSpec = buildPresetSpecFromDraft(invalidDraft, bounds);

    // Direct evaluator remains strict fail-closed
    expect(() => samplePresetTextureV2Client(invalidSpec, [0, 0, 0], bounds)).toThrow(
      /must be strictly greater than 2 \* radius/,
    );

    const positionsWorld = new Float32Array([0, 0, 0, 10e-9, 0, 0]);
    const liveBinding = {
      target: { kind: "object" as const, objectId: "film_300" },
      draft: invalidDraft,
      bounds,
      patchDraft: vi.fn(),
      fitCharacteristicSize: vi.fn(),
      resetTransform: vi.fn(),
    };

    // Viewport 3D HSL surface and vector samplers isolate errors and return null
    expect(
      sampleViewport3DSurfaceHslColors({
        scene,
        objectId: "film_300",
        positionsWorld,
        liveBinding,
      }),
    ).toBeNull();
    expect(
      sampleViewport3DSurfaceHslColors({
        scene,
        objectId: "film_300",
        positionsWorld,
      }),
    ).toBeNull();

    expect(
      sampleAuthoredMagnetizationVectors({
        scene,
        objectId: "film_300",
        positionsWorld,
        liveBinding,
      }),
    ).toBeNull();
    expect(
      sampleAuthoredMagnetizationVectors({
        scene,
        objectId: "film_300",
        positionsWorld,
      }),
    ).toBeNull();

    const model = createViewport3DTextureTransformModel(scene);
    expect(
      model.sampleSurfaceColors({
        objectId: "film_300",
        positionsWorld,
        liveBinding,
      }),
    ).toBeNull();
    expect(
      model.sampleVectors({
        objectId: "film_300",
        positionsWorld,
        liveBinding,
      }),
    ).toBeNull();

    // Rendering Viewport3DTextureTransformLayer with invalid activeBinding does not throw
    const primitiveModel = buildViewport3DPrimitiveRenderModel(scene, null);
    const owner = Symbol("invalid-draft-render-test");
    registerTextureInspectorBinding(owner, liveBinding);
    toggleTextureGizmo(true);

    expect(() =>
      renderToStaticMarkup(
        createElement(Viewport3DTextureTransformLayer, {
          colors: {
            accent: "#38bdf8",
            background: "#0f172a",
            field: "#22d3ee",
            grid: "#334155",
            muted: "#64748b",
            selection: "#fbbf24",
            surface: "#1e293b",
          } as never,
          getObjectSettings: () => ({
            ...DEFAULT_OBJECT_VISUALIZATION,
            vectorsVisible: true,
          }),
          primitiveModel,
          selectedObject: primitiveModel.objects[0] ?? null,
          textureTransformModel: model,
        }),
      ),
    ).not.toThrow();
  });
});
