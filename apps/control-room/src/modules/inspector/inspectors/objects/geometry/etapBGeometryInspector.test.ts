import { describe, expect, it } from "vitest";

import type { SceneResource } from "@/kernel/api/apiTypes";
import {
  analyzeDeleteObjectImpact,
  buildBaselineFromScene,
  buildGeometryNodeDraft,
  buildQuickCutoutGeometry,
  computeCutoutHeightFromBounds,
  mergeTransformPatch,
  patchOperandInCompositeGeometry,
  serializeGeometryPayload,
  serializeTransformPayload,
} from "./index";

describe("Etap B Geometry Inspector models: BooleanNode, GeometryNode, Transform3D patch, DeleteImpact", () => {
  it("serializes Cone, Torus, and PolygonPrism in canonical Etap B contract format", () => {
    const baseSelection = {
      kind: "builder.primitive",
      label: "New cone",
      moduleSource: "explorer" as const,
      nodeId: "geometry:draft:cone",
      objectId: null,
      ref: null,
    };
    const baseDraft = buildBaselineFromScene(baseSelection, null, true);

    expect(
      serializeGeometryPayload({
        ...baseDraft,
        bottomRadius: 40e-9,
        height: 60e-9,
        primitiveKind: "Cone",
        symmetryAxis: "x",
        topRadius: 15e-9,
      }),
    ).toEqual({
      geometry_kind: "Cone",
      geometry_params: {
        axis: [1, 0, 0],
        height: 60e-9,
        radius_bottom: 40e-9,
        radius_top: 15e-9,
      },
    });

    expect(
      serializeGeometryPayload({
        ...baseDraft,
        majorRadius: 80e-9,
        minorRadius: 20e-9,
        primitiveKind: "Torus",
        symmetryAxis: "y",
      }),
    ).toEqual({
      geometry_kind: "Torus",
      geometry_params: {
        axis: [0, 1, 0],
        major_radius: 80e-9,
        minor_radius: 20e-9,
      },
    });

    expect(
      serializeGeometryPayload({
        ...baseDraft,
        height: 15e-9,
        polygonVertices: [
          { _rowId: "v1", x_m: -50e-9, y_m: -30e-9 },
          { _rowId: "v2", x_m: 50e-9, y_m: -30e-9 },
          { _rowId: "v3", x_m: 0, y_m: 40e-9 },
        ],
        primitiveKind: "PolygonExtrusion",
      }),
    ).toEqual({
      geometry_kind: "PolygonPrism",
      geometry_params: {
        thickness: 15e-9,
        vertices_xy: [
          [-50e-9, -30e-9],
          [50e-9, -30e-9],
          [0, 40e-9],
        ],
      },
    });
  });

  it("computes cutout height automatically as 1.2 * L_z from target bounds", () => {
    expect(computeCutoutHeightFromBounds({ size: [200e-9, 100e-9, 10e-9] })).toBeCloseTo(12e-9, 15);
    const cyl = buildQuickCutoutGeometry("Cylinder", { size: [200e-9, 100e-9, 10e-9] });
    expect(cyl).toMatchObject({
      geometry_kind: "Cylinder",
      geometry_params: {
        axis: [0, 0, 1],
        height: 12e-9,
        radius: 20e-9,
      },
    });
  });

  it("preserves unmodified Transform3D rotation_quat, scale, and pivot on partial translation edit", () => {
    const existingTransform = {
      custom_flag: true,
      pivot: [5e-9, -5e-9, 0],
      pivot_mode: "custom",
      rotation_quat: [0, 0, 0.3826834323650898, 0.9238795325112867],
      scale: [2, 1.5, 1],
      translation: [10e-9, 0, 0],
    };
    const scene = {
      objects: [
        {
          geometry: { geometry_kind: "Box", geometry_params: { size: [1e-7, 1e-7, 1e-8] } },
          id: "film_1",
          name: "Film",
          transform: existingTransform,
        },
      ],
      revision: 3,
    } as unknown as SceneResource;

    const baseline = buildBaselineFromScene(
      { kind: "object.geometry", label: "Film", moduleSource: "explorer", nodeId: "model:object:film_1:geometry", objectId: "film_1", ref: null },
      scene,
      false,
    );
    const edited = { ...baseline, translation: [25e-9, 0, 0] as const };
    const merged = serializeTransformPayload(edited, existingTransform, baseline);

    expect(merged.translation).toEqual([25e-9, 0, 0]);
    expect(merged.rotation_quat).toEqual(existingTransform.rotation_quat);
    expect(merged.scale).toEqual([2, 1.5, 1]);
    expect(merged.pivot).toEqual([5e-9, -5e-9, 0]);
    expect(merged.custom_flag).toBe(true);

    expect(
      mergeTransformPatch(existingTransform, { translation: [1, 2, 3] }),
    ).toMatchObject({
      pivot: [5e-9, -5e-9, 0],
      rotation_quat: existingTransform.rotation_quat,
      scale: [2, 1.5, 1],
      translation: [1, 2, 3],
    });
  });

  it("builds and patches GeometryNodeInspectorSpec operand drafts losslessly", () => {
    const scene = {
      objects: [
        {
          geometry: {
            geometry_kind: "Difference",
            geometry_params: {
              operands: [
                {
                  enabled: true,
                  geometry: { geometry_kind: "Box", geometry_params: { size: [1e-7, 1e-7, 1e-8] } },
                  label: "Base plate",
                  operand_id: "op_base",
                },
                {
                  enabled: true,
                  geometry: { geometry_kind: "Cylinder", geometry_params: { height: 1.2e-8, radius: 1.5e-8 } },
                  label: "Center hole",
                  operand_id: "op_hole",
                  transform: { translation: [0, 0, 0] },
                },
              ],
            },
          },
          id: "film_1",
          name: "Patterned Film",
        },
      ],
      revision: 5,
    } as unknown as SceneResource;

    const selection = {
      kind: "object.geometry.node",
      label: "Center hole",
      moduleSource: "explorer" as const,
      nodeId: "model:object:film_1:geometry:op_hole",
      objectId: "film_1",
      ref: {
        geometryNodeId: "op_hole",
        kind: "object.geometry.node" as const,
        nodeId: "model:object:film_1:geometry:op_hole",
        objectId: "film_1",
        operandId: "op_hole",
        type: "scene-object" as const,
        visualizationTargetId: "object:film_1" as const,
      },
    };

    const draft = buildGeometryNodeDraft(selection, scene);
    expect(draft).toMatchObject({
      enabled: true,
      exists: true,
      index: 1,
      objectId: "film_1",
      operandId: "op_hole",
      primitiveKind: "Cylinder",
      radius: 1.5e-8,
      roleBadge: "− Subtract",
      total: 2,
    });

    const patched = patchOperandInCompositeGeometry(scene.objects[0]?.geometry, {
      ...draft,
      radius: 2.5e-8,
      translation: [10e-9, -5e-9, 0],
    });
    const operands = (patched?.geometry_params as { operands: Array<Record<string, unknown>> }).operands;
    expect(operands[0]?.operand_id).toBe("op_base");
    expect((operands[1]?.geometry as { geometry_params: { radius: number } }).geometry_params.radius).toBe(2.5e-8);
    expect((operands[1]?.transform as { translation: number[] }).translation).toEqual([10e-9, -5e-9, 0]);

    // Legacy 2-operand dicts ({ base, tool }, { a, b }, { left, right }) patch cleanly too.
    const legacyUnion = {
      geometry_kind: "Union",
      geometry_params: {
        a: { geometry_kind: "Box", geometry_params: { size: [1e-7, 1e-7, 1e-8] } },
        b: { geometry_kind: "Sphere", geometry_params: { radius: 2e-8 } },
      },
    };
    const legacyPatched = patchOperandInCompositeGeometry(legacyUnion, {
      ...draft,
      operandId: "b",
      primitiveKind: "Sphere",
      radius: 3.5e-8,
      translation: [0, 0, 0],
    });
    expect(
      ((legacyPatched?.geometry_params as Record<string, unknown>).b as { geometry_params: { radius: number } }).geometry_params.radius,
    ).toBe(3.5e-8);
    expect((legacyPatched?.geometry_params as Record<string, unknown>).a).toEqual(legacyUnion.geometry_params.a);
  });

  it("analyzes dependent regions, couplings, field drives, monitors, transports, and CSG refs from canonical SceneResource", () => {
    const scene = {
      couplings: [{ id: "cpl_1", name: "RKKY", object_a: "film_1", object_b: "film_2" }],
      current_transports: [{ id: "ct_1", name: "Drive line", object_id: "film_1" }],
      field_drives: {
        drives: [{ id: "fd_1", name: "RF pulse", target: { object_id: "film_1" } }],
        mask_drives: [{ id: "md_1", name: "Mask pulse", target: { object_id: "film_1" } }],
      },
      monitors: {
        planar: [{ id: "pm_1", name: "Mz slice", target: { object_id: "film_1" } }],
      },
      objects: [
        {
          id: "film_1",
          name: "Bottom Film",
          regions: [{ id: "r1", name: "Center dot" }],
        },
        {
          geometry: {
            geometry_kind: "Difference",
            geometry_params: {
              operands: [
                { enabled: true, geometry: { geometry_kind: "Box" }, label: "Top", operand_id: "a" },
                { enabled: true, geometry: { geometry_kind: "Box" }, label: "Ref", operand_id: "b", source_object_id: "film_1" },
              ],
            },
          },
          id: "film_2",
          name: "Top Film",
        },
      ],
      revision: 9,
    } as unknown as SceneResource;

    const impact = analyzeDeleteObjectImpact(scene, "film_1");
    expect(impact.objectName).toBe("Bottom Film");
    expect(impact.totalDependents).toBe(7);
    expect(impact.categories.map((c) => c.kind)).toEqual([
      "regions",
      "couplings",
      "field_drives",
      "transports",
      "planar_monitors",
      "csg_references",
    ]);
    expect(impact.categories.find((c) => c.kind === "field_drives")?.count).toBe(2);
    expect(impact.categories.find((c) => c.kind === "planar_monitors")?.count).toBe(1);
  });
});
