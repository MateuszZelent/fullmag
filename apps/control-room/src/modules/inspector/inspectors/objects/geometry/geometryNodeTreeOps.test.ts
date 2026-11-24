import { describe, expect, it } from "vitest";

import type { SceneResource } from "@/kernel/api/apiTypes";
import { defaultArrayAxisSpec } from "@/kernel/authoring/array3dModel";
import { buildGeometryTreeExplorerNodes } from "@/modules/explorer/builders/geometryTreeExplorerNodes";

import { summarizeGeometryOnlyValidationMessages } from "../../../panels/geometryObjectPanelModel";

import {
  buildGeometryNodeDraft,
  buildGeometryNodeSelection,
  formatGeometryUnitSummary,
  patchGeometryNodeAtPath,
  patchOperandInCompositeGeometry,
  resolveGeometryNodeByPath,
} from "./index";

describe("Recursive Geometry Tree ops, Array3D unit editing, and Geometry-only diagnostics", () => {
  it("resolves and patches a depth-2 Cylinder inside Array3D inside Difference while preserving Array3D.axes and Film base box", () => {
    const axes = [
      defaultArrayAxisSpec("x", { count: 3, direction: "symmetric", enabled: true, pitch_m: 120e-9 }),
      defaultArrayAxisSpec("y", { count: 3, direction: "symmetric", enabled: true, pitch_m: 120e-9 }),
      defaultArrayAxisSpec("z", { count: 1, direction: "positive", enabled: false, pitch_m: 100e-9 }),
    ];
    const filmBase = {
      enabled: true,
      geometry: { geometry_kind: "Box", geometry_params: { size: [500e-9, 500e-9, 20e-9] } },
      label: "Film",
      operand_id: "op_film",
    };
    const rootGeometry = {
      geometry_kind: "Difference",
      geometry_params: {
        operands: [
          filmBase,
          {
            enabled: true,
            geometry: {
              geometry_kind: "Array3D",
              geometry_params: {
                axes,
                child: {
                  geometry_kind: "Cylinder",
                  geometry_params: {
                    axis: [0, 0, 1],
                    height: 40e-9,
                    radius: 22e-9,
                  },
                },
                merge_overlapping: false,
              },
            },
            label: "Hole",
            operand_id: "op_hole",
            transform: {
              pivot: [1e-9, 2e-9, 0],
              translation: [0, 0, 0],
            },
          },
        ],
      },
    };

    // 1. Explorer tree encodes deterministic paths and crisp non-duplicate Array3D / Base Unit labels.
    const explorerNodes = buildGeometryTreeExplorerNodes(
      "film_1",
      "model:object:film_1:geometry",
      rootGeometry,
    );
    expect(explorerNodes).toHaveLength(2);
    const holeNode = explorerNodes[1]!;
    expect(holeNode).toMatchObject({
      geometryNodeId: "op_hole",
      label: "Hole",
      operandId: "op_hole",
    });
    expect(holeNode.badge).toContain("− Subtract · 3×3×1");

    const unitNode = holeNode.children?.[0];
    expect(unitNode).toMatchObject({
      geometryNodeId: "op_hole/array-child",
      label: "Hole (Cylinder)",
      operandId: "array-child",
    });
    expect(unitNode?.badge).toContain("Base Unit");
    expect(unitNode?.badge).not.toContain("Array 3D");

    // 2. Selecting the Array3D operand shows unit summary + arrayChildPath for 1-click jump.
    const scene = {
      objects: [{ geometry: rootGeometry, id: "film_1", name: "Antidot Film" }],
      revision: 11,
    } as unknown as SceneResource;

    const arrayDraft = buildGeometryNodeDraft(
      {
        ...buildGeometryNodeSelection("film_1", "op_hole", "Hole"),
        moduleSource: "explorer",
      },
      scene,
    );
    expect(arrayDraft).toMatchObject({
      arrayChildPath: "op_hole/array-child",
      arrayUnitSummary: "Cylinder (r = 22 nm, h = 40 nm)",
      exists: true,
      isArray3D: true,
      isTopLevelBooleanOperand: true,
      operandId: "op_hole",
    });

    // 3. Jumping to op_hole/array-child resolves the depth-2 Cylinder cleanly.
    const unitSelection = {
      ...buildGeometryNodeSelection("film_1", "op_hole/array-child", "Hole (Cylinder)"),
      moduleSource: "inspector" as const,
    };
    const unitDraft = buildGeometryNodeDraft(unitSelection, scene);
    expect(unitDraft).toMatchObject({
      ancestors: [{ label: "Hole", path: "op_hole" }],
      depth: 1,
      exists: true,
      height: 40e-9,
      isArray3D: false,
      isEditablePrimitive: true,
      operandId: "op_hole/array-child",
      primitiveKind: "Cylinder",
      radius: 22e-9,
      roleBadge: "Base Unit",
      symmetryAxis: "z",
    });

    // 4. Patching radius (22 nm -> 35 nm), height (40 nm -> 55 nm), and child_transform updates immutably
    // while preserving Array3D.axes, merge_overlapping, and the Film base box.
    const patched = patchOperandInCompositeGeometry(rootGeometry, {
      ...unitDraft,
      eulerDeg: [0, 0, 90],
      height: 55e-9,
      radius: 35e-9,
      scale: [1.1, 1.1, 1],
      translation: [5e-9, -5e-9, 0],
    });
    expect(patched).not.toBeNull();

    const patchedOperands = (
      patched?.geometry_params as { operands: Array<Record<string, unknown>> }
    ).operands;
    expect(patchedOperands[0]).toEqual(filmBase);

    const patchedHoleArray = (
      patchedOperands[1]?.geometry as { geometry_params: Record<string, unknown> }
    ).geometry_params;
    expect(patchedHoleArray.axes).toEqual(axes);
    expect(patchedHoleArray.merge_overlapping).toBe(false);

    const patchedChildParams = (
      patchedHoleArray.child as { geometry_params: Record<string, unknown> }
    ).geometry_params;
    expect(patchedChildParams.radius).toBe(35e-9);
    expect(patchedChildParams.height).toBe(55e-9);

    const patchedChildTx = patchedHoleArray.child_transform as {
      rotation_quat: number[];
      scale: number[];
      translation: number[];
    };
    expect(patchedChildTx.translation).toEqual([5e-9, -5e-9, 0]);
    expect(patchedChildTx.scale).toEqual([1.1, 1.1, 1]);
    expect(patchedChildTx.rotation_quat[2]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(patchedChildTx.rotation_quat[3]).toBeCloseTo(Math.SQRT1_2, 6);

    // Original input was not mutated.
    expect(
      (
        (rootGeometry.geometry_params.operands[1] as Record<string, unknown>)
          .geometry as { geometry_params: { child: { geometry_params: { radius: number } } } }
      ).geometry_params.child.geometry_params.radius,
    ).toBe(22e-9);
  });

  it("resolves and patches a depth-2 Box inside nested Difference(Union(BoxA, BoxB), CylC)", () => {
    const boxB = {
      enabled: true,
      geometry: { geometry_kind: "Box", geometry_params: { size: [60e-9, 200e-9, 15e-9] } },
      label: "Arm B",
      operand_id: "box_b",
    };
    const cylC = {
      enabled: true,
      geometry: { geometry_kind: "Cylinder", geometry_params: { height: 25e-9, radius: 18e-9 } },
      label: "Center Hole",
      operand_id: "cyl_c",
    };
    const nested = {
      geometry_kind: "Difference",
      geometry_params: {
        operands: [
          {
            enabled: true,
            geometry: {
              geometry_kind: "Union",
              geometry_params: {
                operands: [
                  {
                    enabled: true,
                    geometry: {
                      geometry_kind: "Box",
                      geometry_params: { size: [200e-9, 60e-9, 15e-9] },
                    },
                    label: "Arm A",
                    operand_id: "box_a",
                    transform: {
                      custom_tag: "keep-me",
                      pivot: [2e-9, 0, 0],
                      rotation_quat: [0, 0, 0.3826834323650898, 0.9238795325112867],
                      translation: [10e-9, 0, 0],
                    },
                  },
                  boxB,
                ],
              },
            },
            label: "Cross Union",
            operand_id: "union_ab",
          },
          cylC,
        ],
      },
    };

    const resolved = resolveGeometryNodeByPath(nested, "union_ab/box_a");
    expect(resolved).toMatchObject({
      ancestors: [{ label: "Cross Union", path: "union_ab" }],
      depth: 1,
      geometryKind: "Box",
      isEditablePrimitive: true,
      label: "Arm A",
      path: "union_ab/box_a",
    });

    // Editing BoxA dimensions + scale preserves untouched rotation_quat, pivot, custom_tag, BoxB, and CylC!
    const patched = patchGeometryNodeAtPath(nested, "union_ab/box_a", {
      sizeX: 280e-9,
      sizeY: 80e-9,
      sizeZ: 20e-9,
      scale: [1, 1.5, 1],
    });
    expect(patched).not.toBeNull();

    const diffOperands = (
      patched?.geometry_params as { operands: Array<Record<string, unknown>> }
    ).operands;
    expect(diffOperands[1]).toEqual(cylC);

    const unionOperands = (
      diffOperands[0]?.geometry as { geometry_params: { operands: Array<Record<string, unknown>> } }
    ).geometry_params.operands;
    expect(unionOperands[1]).toEqual(boxB);

    const patchedBoxA = unionOperands[0]!;
    expect(
      (patchedBoxA.geometry as { geometry_params: { size: number[] } }).geometry_params.size,
    ).toEqual([280e-9, 80e-9, 20e-9]);
    expect(patchedBoxA.transform).toEqual({
      custom_tag: "keep-me",
      pivot: [2e-9, 0, 0],
      rotation_quat: [0, 0, 0.3826834323650898, 0.9238795325112867],
      scale: [1, 1.5, 1],
      translation: [10e-9, 0, 0],
    });
  });

  it("supports Cone, Torus, Ellipsoid, SlicePlane, and Translate/Transform wrapper patching", () => {
    const slicedCone = {
      geometry_kind: "SlicePlane",
      geometry_params: {
        child: {
          geometry_kind: "Translate",
          geometry_params: {
            child: {
              geometry_kind: "Cone",
              geometry_params: {
                axis: [0, 0, 1],
                height: 30e-9,
                radius_bottom: 40e-9,
                radius_top: 10e-9,
              },
            },
            offset: [15e-9, 0, 0],
          },
        },
        keep_side: "positive",
        plane_normal: [1, 0, 0],
        plane_origin_m: [0, 0, 0],
      },
    };

    const resolved = resolveGeometryNodeByPath(slicedCone, "slice-child");
    expect(resolved?.geometryKind).toBe("Cone");
    expect(formatGeometryUnitSummary(slicedCone.geometry_params.child)).toContain("Cone");

    const patched = patchGeometryNodeAtPath(slicedCone, "slice-child", {
      bottomRadius: 50e-9,
      height: 45e-9,
      symmetryAxis: "y",
      topRadius: 15e-9,
      translation: [25e-9, -5e-9, 0],
    });
    const nextChild = (patched?.geometry_params as { child: Record<string, unknown> }).child;
    expect(nextChild.geometry_kind).toBe("Translate");
    expect((nextChild.geometry_params as { offset: number[] }).offset).toEqual([25e-9, -5e-9, 0]);
    expect(
      (nextChild.geometry_params as { child: { geometry_params: Record<string, unknown> } }).child
        .geometry_params,
    ).toEqual({
      axis: [0, 1, 0],
      height: 45e-9,
      radius_bottom: 50e-9,
      radius_top: 15e-9,
    });
  });

  it("filters missing-material and missing-magnetization readiness diagnostics from geometry-only summaries while keeping true geometry errors", () => {
    const validationPayload = {
      diagnostics: [
        {
          code: "GEOMETRY_OBJECT_MATERIAL_MISSING",
          message: "Object 'film_1' references a missing material.",
          object_id: "film_1",
        },
        {
          code: "GEOMETRY_OBJECT_MAGNETIZATION_MISSING",
          message: "Object 'film_1' must reference a magnetization asset before compute.",
          object_id: "film_1",
        },
        {
          code: "GEOMETRY_OBJECT_OUTSIDE_UNIVERSE",
          message: "Object 'film_1' extends outside the declared Universe bounds.",
          object_id: "film_1",
        },
        {
          code: "GEOMETRY_CSG_DIFFERENCE_INVALID",
          message: "Difference requires at least two enabled operands.",
          object_id: "film_1",
        },
        {
          message: "Object 'film_1' references a missing material.",
          object_id: "film_1",
        },
      ],
    };

    expect(summarizeGeometryOnlyValidationMessages(validationPayload, "film_1")).toEqual([
      "Object 'film_1' extends outside the declared Universe bounds.",
      "Difference requires at least two enabled operands.",
    ]);
  });
});
