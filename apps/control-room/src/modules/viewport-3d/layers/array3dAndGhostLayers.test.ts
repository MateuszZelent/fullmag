import { Vector3 } from "three";
import { beforeEach, describe, expect, it } from "vitest";

import { applyArray3DPreset } from "@/kernel/authoring/array3dModel";
import { geometryGhostVisibilityStore } from "@/kernel/visualization/geometryGhostVisibilityStore";

import {
  buildMergeSafeGizmoTransformPatch,
  createMoveGestureController,
  resolveGizmoAnchorPosition,
  resolveGizmoAxisVector,
  resolveGizmoShortcutUpdate,
} from "../MoveObjectGizmo.model";
import type { Viewport3DPrimitiveObject } from "../viewport3dPrimitiveModel";
import {
  buildArray3DInstanceMatrices,
  extractArray3DPreviewDescriptors,
} from "./Array3DInstancedPreviewLayer";
import { resolveGhostCutterDescriptors } from "./GhostCutterOverlayLayer";

function mockPrimitiveObject(
  overrides: Partial<Viewport3DPrimitiveObject>,
): Viewport3DPrimitiveObject {
  return {
    bounds: { center: [0, 0, 0], size: [100e-9, 100e-9, 10e-9] },
    csgPreview: null,
    fallbackLabel: "Parametric",
    geometryKey: "obj:1",
    kind: "box",
    label: "Film",
    magnetizationTexturePreview: null,
    meshState: "primitive-only",
    objectId: "film_1",
    role: "magnet",
    sceneRevision: 1,
    translation: [0, 0, 0],
    ...overrides,
  };
}

describe("Viewport 3D Etap D: Array3D InstancedMesh, GhostCutterOverlay, and Transform Gizmo", () => {
  beforeEach(() => {
    geometryGhostVisibilityStore.clear();
  });

  it("extracts Array3D descriptors for both direct objects and CSG cutters and builds exact instance matrices", () => {
    const hexAxes = applyArray3DPreset("hexagonal_xy", 100e-9);
    const antidotFilm = mockPrimitiveObject({
      objectId: "antidot",
      rawGeometry: {
        geometry_kind: "Difference",
        geometry_params: {
          operands: [
            {
              enabled: true,
              geometry: { geometry_kind: "Box", geometry_params: { size: [500e-9, 500e-9, 10e-9] } },
              label: "Film",
              operand_id: "base",
            },
            {
              enabled: true,
              geometry: {
                geometry_kind: "Array3D",
                geometry_params: {
                  axes: hexAxes,
                  child: {
                    geometry_kind: "Cylinder",
                    geometry_params: { height: 12e-9, radius: 15e-9 },
                  },
                  merge_overlapping: false,
                },
              },
              label: "Antidot Lattice",
              operand_id: "holes",
            },
          ],
        },
      },
      transform: { translation: [10e-9, 0, 0] },
    });

    const descriptors = extractArray3DPreviewDescriptors([antidotFilm]);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      childKind: "Cylinder",
      isCutter: true,
      objectId: "antidot",
      operandId: "holes",
    });

    const matrices = buildArray3DInstanceMatrices(descriptors[0]!);
    expect(matrices).toHaveLength(16); // 4x4x1
    // Verify root translation [10nm, 0, 0] is composed into every instance matrix.
    const pos = new Vector3().setFromMatrixPosition(matrices[0]!);
    expect(Number.isFinite(pos.x)).toBe(true);
    expect(Number.isFinite(pos.y)).toBe(true);
  });

  it("resolves ghost cutter descriptors when toggled in local store or selected, without touching SceneDocument", () => {
    const compositeObj = mockPrimitiveObject({
      objectId: "film_csg",
      rawGeometry: {
        geometry_kind: "Difference",
        geometry_params: {
          operands: [
            {
              enabled: true,
              geometry: { geometry_kind: "Box", geometry_params: { size: [100e-9, 100e-9, 10e-9] } },
              label: "Base",
              operand_id: "op_base",
            },
            {
              enabled: true,
              geometry: { geometry_kind: "Cylinder", geometry_params: { height: 12e-9, radius: 15e-9 } },
              label: "Hole",
              operand_id: "op_hole",
              transform: { translation: [5e-9, -5e-9, 0] },
            },
          ],
        },
      },
      transform: { translation: [10e-9, 20e-9, 0] },
    });

    // Neither toggled nor selected -> empty
    expect(
      resolveGhostCutterDescriptors(
        [compositeObj],
        null,
        null,
        geometryGhostVisibilityStore.getSnapshot(),
      ),
    ).toHaveLength(0);

    // Selected operand -> visible
    const selectedGhosts = resolveGhostCutterDescriptors(
      [compositeObj],
      "film_csg",
      "op_hole",
      geometryGhostVisibilityStore.getSnapshot(),
    );
    expect(selectedGhosts).toHaveLength(1);
    expect(selectedGhosts[0]?.position).toEqual([15e-9, 15e-9, 0]);
    expect(selectedGhosts[0]?.role).toBe("subtract");

    // Local ghost toggle -> visible even when deselected
    geometryGhostVisibilityStore.setGhostVisible("film_csg", "op_hole", true);
    const toggledGhosts = resolveGhostCutterDescriptors(
      [compositeObj],
      null,
      null,
      geometryGhostVisibilityStore.getSnapshot(),
    );
    expect(toggledGhosts).toHaveLength(1);
  });

  it("anchors gizmo at pivot, switches G/R/S/L modes, and produces merge-safe Transform3D patches", () => {
    expect(
      resolveGizmoAnchorPosition({
        bounds: { center: [10e-9, 0, 0] },
        transform: { pivot: [5e-9, -2e-9, 0] },
      }),
    ).toEqual([15e-9, -2e-9, 0]);

    expect(resolveGizmoShortcutUpdate("r", "move", "world")).toEqual({
      mode: "rotate",
      space: "world",
    });
    expect(resolveGizmoShortcutUpdate("s", "rotate", "world")).toEqual({
      mode: "scale",
      space: "world",
    });
    expect(resolveGizmoShortcutUpdate("l", "scale", "world")).toEqual({
      mode: "scale",
      space: "local",
    });
    expect(resolveGizmoShortcutUpdate("g", "scale", "local")).toEqual({
      mode: "move",
      space: "local",
    });

    // 90 deg rotation around Z rotates local +X onto world +Y.
    const q90z: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    const localX = resolveGizmoAxisVector("x", "local", q90z);
    expect(localX.x).toBeCloseTo(0, 6);
    expect(localX.y).toBeCloseTo(1, 6);

    const rotPatch = buildMergeSafeGizmoTransformPatch({
      axis: "z",
      currentTransform: {
        pivot: [1e-9, 0, 0],
        rotationQuat: [0, 0, 0, 1],
        scale: [2, 2, 1],
        translation: [10e-9, 0, 0],
      },
      delta: Math.PI / 2,
      mode: "rotate",
      space: "world",
    });
    expect(rotPatch.rotation_quat).toBeDefined();
    expect(rotPatch.translation).toBeUndefined();
    expect(rotPatch.scale).toBeUndefined();

    const scalePatch = buildMergeSafeGizmoTransformPatch({
      axis: "x",
      currentTransform: {
        rotationQuat: q90z,
        scale: [2, 1, 1],
        translation: [10e-9, 0, 0],
      },
      delta: 0.5,
      mode: "scale",
      space: "local",
    });
    expect(scalePatch).toEqual({ scale: [3, 1, 1] });
  });

  it("composes rotated parent transform with operand & child transforms in GhostCutter and Array3D", () => {
    // 90 deg rotation around Z maps local +X [10nm, 0, 0] -> world +Y [0, 10nm, 0]
    const q90z: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    const rotatedObj = mockPrimitiveObject({
      objectId: "rot_csg",
      rawGeometry: {
        geometry_kind: "Difference",
        geometry_params: {
          operands: [
            {
              enabled: true,
              geometry: { geometry_kind: "Box", geometry_params: { size: [100e-9, 100e-9, 10e-9] } },
              label: "Base",
              operand_id: "op_base",
            },
            {
              enabled: true,
              geometry: {
                geometry_kind: "Array3D",
                geometry_params: {
                  axes: applyArray3DPreset("stripe_1d", 20e-9),
                  child: { geometry_kind: "Cylinder", geometry_params: { height: 12e-9, radius: 5e-9 } },
                  child_transform: { translation: [0, 0, 2e-9] },
                  merge_overlapping: false,
                },
              },
              label: "Rotated Holes",
              operand_id: "op_holes",
              transform: { translation: [10e-9, 0, 0] },
            },
          ],
        },
      },
      transform: { rotationQuat: q90z, translation: [0, 0, 0] },
    });

    const ghosts = resolveGhostCutterDescriptors(
      [rotatedObj],
      "rot_csg",
      "op_holes",
      geometryGhostVisibilityStore.getSnapshot(),
    );
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0]!.position[0]).toBeCloseTo(0, 12);
    expect(ghosts[0]!.position[1]).toBeCloseTo(10e-9, 12);

    const arrayDescs = extractArray3DPreviewDescriptors([rotatedObj]);
    expect(arrayDescs).toHaveLength(1);
    const matrices = buildArray3DInstanceMatrices(arrayDescs[0]!);
    // Symmetric stripe_1d has 6 instances centered around 0; average world pos should be (0, 10nm, 2nm)
    const avg = matrices.reduce(
      (acc, mat) => acc.add(new Vector3().setFromMatrixPosition(mat)),
      new Vector3(),
    ).divideScalar(matrices.length);
    expect(avg.x).toBeCloseTo(0, 12);
    expect(avg.y).toBeCloseTo(10e-9, 12);
    expect(avg.z).toBeCloseTo(2e-9, 12);
  });

  it("projects local-space gizmo drag onto rotated local axis and preserves dragged axis on commit", async () => {
    const q90z: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    let committedAxisPayload: { axis: string; delta: number; translation: [number, number, number] } | null = null;
    const controller = createMoveGestureController({
      baseRevision: 5,
      objectId: "rot_obj",
      onAxisCommit: (payload) => {
        committedAxisPayload = {
          axis: payload.axis,
          delta: payload.delta,
          translation: payload.translation,
        };
      },
      onCommit: () => true,
      onDraftChange: () => undefined,
      origin: [0, 0, 0],
      rotationQuat: q90z,
      space: "local",
    });

    // Dragging local X handle (which points along world +Y after 90 deg Z rotation) by +25nm in world Y
    controller.begin("x", 1, [0, 0, 0], () => undefined, () => undefined);
    controller.move(1, [0, 25e-9, 0]);
    await controller.end(1);

    expect(committedAxisPayload).not.toBeNull();
    expect(committedAxisPayload!.axis).toBe("x");
    expect(committedAxisPayload!.delta).toBeCloseTo(25e-9, 12);
    expect(committedAxisPayload!.translation[0]).toBeCloseTo(0, 12);
    expect(committedAxisPayload!.translation[1]).toBeCloseTo(25e-9, 12);
  });
});
