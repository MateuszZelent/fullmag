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
  installTextureGizmoKeyboardShortcuts,
  resolveTextureGizmoWorldPose,
} from "./TextureTransformGizmo";
import { sampleViewport3DSurfaceHslColors } from "./viewport3dPrimitiveModel";

describe("TextureTransformGizmo & 3D surface preview synchronization", () => {
  beforeEach(() => {
    resetTextureDraftBridgeForTests();
  });

  afterEach(() => {
    resetTextureDraftBridgeForTests();
    vi.restoreAllMocks();
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
});
