import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { SceneResource } from "@/kernel/api/apiTypes";
import { defaultArrayAxisSpec } from "@/kernel/authoring/array3dModel";
import { resolveArray3DChildBoundsMeters } from "./Array3DLatticeTableSection";
import { computeDraftSummaryMetrics } from "./geometrySerialization";
import {
  analyzeDeleteObjectImpact,
  bakeScaleIntoDraft,
  buildBaselineFromScene,
  buildGeometryNodeDraft,
  buildQuickCutoutGeometry,
  canBakeScaleIntoDraft,
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

  it("summarizes composite CSG and Array3D objects with real recursive AABB bounds and preserves raw geometry on serialize", () => {
    const diffFilm = {
      geometry_kind: "Difference",
      geometry_params: {
        operands: [
          {
            enabled: true,
            geometry: { geometry_kind: "Box", geometry_params: { size: [500e-9, 500e-9, 20e-9] } },
            label: "Film",
            operand_id: "op:1",
          },
          {
            enabled: true,
            geometry: { geometry_kind: "Cylinder", geometry_params: { height: 24e-9, radius: 50e-9 } },
            label: "Hole",
            operand_id: "op:2",
          },
        ],
      },
    };
    const arrayGeom = {
      geometry_kind: "Array3D",
      geometry_params: {
        axes: [
          defaultArrayAxisSpec("x", { count: 3, enabled: true, pitch_m: 600e-9 }),
          defaultArrayAxisSpec("y", { count: 2, enabled: true, pitch_m: 600e-9 }),
          defaultArrayAxisSpec("z", { count: 1, enabled: false, pitch_m: 100e-9 }),
        ],
        child: diffFilm,
        merge_overlapping: false,
      },
    };
    const scene = {
      objects: [
        { geometry: diffFilm, id: "film_diff", name: "FilmDiff" },
        { geometry: arrayGeom, id: "film_arr", name: "FilmArr" },
      ],
      revision: 6,
    } as unknown as SceneResource;

    const diffDraft = buildBaselineFromScene(
      { kind: "object.geometry", label: "FilmDiff", moduleSource: "explorer", nodeId: "model:object:film_diff:geometry", objectId: "film_diff", ref: null },
      scene,
      false,
    );
    expect(diffDraft.compositeSummary).toMatchObject({
      displayLabel: "Boolean Difference",
      enabledOperandCount: 2,
      kind: "Difference",
      operandCount: 2,
    });
    expect(diffDraft.compositeSummary?.boundsMeters?.size).toEqual([500e-9, 500e-9, 20e-9]);
    expect(computeDraftSummaryMetrics(diffDraft).spanText).toContain("500");
    expect(computeDraftSummaryMetrics(diffDraft).spanText).not.toContain("100 × 100 × 10");
    expect(serializeGeometryPayload(diffDraft)).toEqual(diffFilm);

    const arrDraft = buildBaselineFromScene(
      { kind: "object.geometry", label: "FilmArr", moduleSource: "explorer", nodeId: "model:object:film_arr:geometry", objectId: "film_arr", ref: null },
      scene,
      false,
    );
    expect(arrDraft.compositeSummary).toMatchObject({
      dimensionsLabel: "3×2×1",
      displayLabel: "Array 3D Lattice",
      instanceCount: 6,
      kind: "Array3D",
    });
    expect(arrDraft.compositeSummary?.boundsMeters?.size[0]).toBeCloseTo(1700e-9, 14);
    expect(resolveArray3DChildBoundsMeters(scene.objects[0], diffFilm).size).toEqual([500e-9, 500e-9, 20e-9]);
    expect(resolveArray3DChildBoundsMeters(scene.objects[1], arrayGeom).size).toEqual([500e-9, 500e-9, 20e-9]);
  });

  it("keeps Array3DLatticeTableSection responsive, Explorer selection-role badges unclipped, and Delete Object button unwrapped", () => {
    const widgetsCss = readFileSync(
      new URL("../../../../../design/styles/inspector-widgets.css", import.meta.url),
      "utf8",
    );
    expect(widgetsCss).toContain("@container fm-array3d (max-width: 460px)");

    const explorerCss = readFileSync(
      new URL("../../../../../design/styles/explorer.css", import.meta.url),
      "utf8",
    );
    expect(explorerCss).toContain(".fm-explorer-tree-row__badge--selection-role");
    expect(explorerCss).toContain("flex-shrink: 0;");
    expect(explorerCss).toContain(".fm-explorer-tree-row__badge:not([data-selection-role])");

    const objectGeometrySource = readFileSync(
      new URL("./ObjectGeometrySpec.tsx", import.meta.url),
      "utf8",
    );
    expect(objectGeometrySource).toContain("deleteAction:");

    const modifiersBarSource = readFileSync(
      new URL("./PrimitiveModifiersBar.tsx", import.meta.url),
      "utf8",
    );
    expect(modifiersBarSource).toContain("whitespace-nowrap");
  });

  it("blocks Bake Scale on composite objects and auto-assigns the first scene material for new primitive drafts", () => {
    const sceneWithMaterials = {
      materials: [
        { id: "mat_py", name: "Permalloy", properties: { Ms: 8e5 } },
        { id: "mat_cofeb", name: "CoFeB", properties: { Ms: 1.2e6 } },
      ],
      objects: [
        {
          geometry: {
            geometry_kind: "Difference",
            geometry_params: {
              operands: [
                {
                  enabled: true,
                  geometry: { geometry_kind: "Box", geometry_params: { size: [400e-9, 400e-9, 20e-9] } },
                  label: "Film",
                  operand_id: "op_film",
                },
                {
                  enabled: true,
                  geometry: { geometry_kind: "Cylinder", geometry_params: { height: 24e-9, radius: 25e-9 } },
                  label: "Hole",
                  operand_id: "op_hole",
                },
              ],
            },
          },
          id: "film_diff",
          name: "FilmDiff",
          transform: { scale: [2, 2, 1], translation: [0, 0, 0] },
        },
      ],
      revision: 8,
    } as unknown as SceneResource;

    const newDraft = buildBaselineFromScene(
      {
        kind: "builder.primitive",
        label: "New box",
        moduleSource: "ribbon",
        nodeId: "builder:primitive:box",
        objectId: null,
        ref: null,
      },
      sceneWithMaterials,
      true,
    );
    expect(newDraft.materialRef).toBe("mat_py");

    const newDraftNoMaterials = buildBaselineFromScene(
      {
        kind: "builder.primitive",
        label: "New box",
        moduleSource: "ribbon",
        nodeId: "builder:primitive:box",
        objectId: null,
        ref: null,
      },
      { materials: [], objects: [], revision: 1 } as unknown as SceneResource,
      true,
    );
    expect(newDraftNoMaterials.materialRef).toBeNull();

    const compositeDraft = buildBaselineFromScene(
      {
        kind: "object.geometry",
        label: "FilmDiff",
        moduleSource: "explorer",
        nodeId: "model:object:film_diff:geometry",
        objectId: "film_diff",
        ref: null,
      },
      sceneWithMaterials,
      false,
    );
    expect(canBakeScaleIntoDraft(compositeDraft)).toEqual({
      ok: false,
      reason: "Bake Scale applies to primitive solids only.",
    });
    expect(bakeScaleIntoDraft(compositeDraft)).toEqual({});
  });

  it("serializes staged inline operand edits + controlled Array 3D lattice edits atomically into composite geometry", () => {
    const initialAxes: [
      ReturnType<typeof defaultArrayAxisSpec>,
      ReturnType<typeof defaultArrayAxisSpec>,
      ReturnType<typeof defaultArrayAxisSpec>,
    ] = [
      defaultArrayAxisSpec("x", { count: 3, direction: "symmetric", enabled: true, pitch_m: 100e-9 }),
      defaultArrayAxisSpec("y", { count: 3, direction: "symmetric", enabled: true, pitch_m: 100e-9 }),
      defaultArrayAxisSpec("z", { count: 1, direction: "positive", enabled: false, pitch_m: 100e-9 }),
    ];
    const nextAxes: [
      ReturnType<typeof defaultArrayAxisSpec>,
      ReturnType<typeof defaultArrayAxisSpec>,
      ReturnType<typeof defaultArrayAxisSpec>,
    ] = [
      defaultArrayAxisSpec("x", { count: 4, direction: "symmetric", enabled: true, pitch_m: 110e-9 }),
      defaultArrayAxisSpec("y", { count: 4, direction: "symmetric", enabled: true, pitch_m: 110e-9 }),
      defaultArrayAxisSpec("z", { count: 1, direction: "positive", enabled: false, pitch_m: 100e-9 }),
    ];
    const diffWithArrayHole = {
      geometry_kind: "Difference",
      geometry_params: {
        operands: [
          {
            enabled: true,
            geometry: { geometry_kind: "Box", geometry_params: { size: [500e-9, 500e-9, 20e-9] } },
            label: "Film",
            operand_id: "op_film",
          },
          {
            enabled: true,
            geometry: {
              geometry_kind: "Array3D",
              geometry_params: {
                axes: initialAxes,
                child: {
                  geometry_kind: "Cylinder",
                  geometry_params: { axis: [0, 0, 1], height: 24e-9, radius: 25e-9 },
                },
                merge_overlapping: false,
              },
            },
            label: "Hole",
            operand_id: "op_hole",
          },
        ],
      },
    };
    const scene = {
      objects: [{ geometry: diffWithArrayHole, id: "film_1", name: "Film" }],
      revision: 12,
    } as unknown as SceneResource;

    const baseline = buildBaselineFromScene(
      {
        kind: "object.geometry",
        label: "Film",
        moduleSource: "explorer",
        nodeId: "model:object:film_1:geometry",
        objectId: "film_1",
        ref: null,
      },
      scene,
      false,
    );

    const serialized = serializeGeometryPayload({
      ...baseline,
      inlineNodePatches: {
        op_hole: {
          array3dConfig: {
            axes: nextAxes,
            mergeOverlapping: true,
            realization: "modifier_in_object",
          },
          enabled: false,
        },
        "op_hole/array-child": {
          radius: 35e-9,
        },
      },
    });

    const operands = (serialized.geometry_params as { operands: Array<Record<string, unknown>> })
      .operands;
    expect(operands[1]?.enabled).toBe(false);
    const holeArrayParams = (
      operands[1]?.geometry as { geometry_params: Record<string, unknown> }
    ).geometry_params;
    expect(holeArrayParams.axes).toEqual(nextAxes);
    expect(holeArrayParams.merge_overlapping).toBe(true);
    expect(
      (holeArrayParams.child as { geometry_params: { radius: number } }).geometry_params.radius,
    ).toBe(35e-9);
  });
});
