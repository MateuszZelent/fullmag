import { describe, expect, it } from "vitest";

import type { SceneDocument } from "../../lib/session/types";
import {
  createScenePrimitiveAuthoringUpdate,
  geometryPresetForPrimitiveKind,
  resolveScenePresetForPrimitiveKind,
} from "../../features/geometry-builder/scene/scenePrimitiveAuthoring";

function makeScene(): SceneDocument {
  return {
    version: "scene.v1",
    revision: 7,
    scene: {
      id: "scene",
      name: "Scene",
      source_of_truth: "repo_head",
      authoring_schema: "mesh-first-fem.v1",
    },
    universe: {
      mode: "box",
      size: [20e-9, 20e-9, 20e-9],
      center: [0, 0, 0],
      padding: [0, 0, 0],
      airbox_hmax: null,
      airbox_hmin: null,
      airbox_growth_rate: null,
      airbox_grading: null,
    },
    objects: [],
    materials: [],
    magnetization_assets: [],
    current_modules: {
      modules: [],
      excitation_analysis: null,
    },
    study: {
      backend: null,
      requested_backend: "auto",
      requested_device: "auto",
      requested_precision: "double",
      requested_mode: "strict",
      requested_cpu_threads: null,
      fem_demag_solver_policy: null,
      demag_realization: null,
      external_field: null,
      solver: {} as SceneDocument["study"]["solver"],
      universe_mesh: {
        mode: "box",
        size: [20e-9, 20e-9, 20e-9],
        center: [0, 0, 0],
        padding: [0, 0, 0],
        airbox_hmax: null,
        airbox_hmin: null,
        airbox_growth_rate: null,
        airbox_grading: null,
      },
      shared_domain_mesh: {} as SceneDocument["study"]["shared_domain_mesh"],
      mesh_defaults: {} as SceneDocument["study"]["mesh_defaults"],
      stages: [],
      study_pipeline: null,
      initial_state: null,
    },
    outputs: { items: [] },
    editor: {
      selected_object_id: null,
      gizmo_mode: null,
      transform_space: null,
      selected_entity_id: null,
      focused_entity_id: null,
      object_view_mode: "context",
      vector_domain_filter: "auto",
      ferromagnet_visibility_mode: "hide",
      air_mesh_visible: false,
      air_mesh_opacity: 28,
      mesh_entity_view_state: {},
      visualization_presets: [],
      active_visualization_preset_ref: null,
      active_transform_scope: null,
    },
  };
}

describe("scene primitive authoring", () => {
  it("does not silently map preview-only primitive kinds to production presets", () => {
    expect(resolveScenePresetForPrimitiveKind("ellipsoid")).toMatchObject({
      presetKind: "sphere",
      status: "preview",
    });
    expect(resolveScenePresetForPrimitiveKind("tube")).toMatchObject({
      presetKind: "ring",
      status: "preview",
    });
    expect(resolveScenePresetForPrimitiveKind("triangular_prism")).toMatchObject({
      presetKind: null,
      status: "unsupported",
    });
    expect(geometryPresetForPrimitiveKind("triangular_prism")).toBeNull();
  });

  it("rejects preview-only primitive creation instead of creating a fallback box", () => {
    expect(() =>
      createScenePrimitiveAuthoringUpdate({
        scene: makeScene(),
        kind: "triangular_prism",
      }),
    ).toThrow(/not available as a production SceneDocument primitive/);
  });

  it("creates canonical SceneDocument updates instead of local builder primitives", () => {
    const update = createScenePrimitiveAuthoringUpdate({
      scene: makeScene(),
      kind: "box",
    });

    expect(update.scene.revision).toBe(8);
    expect(update.scene.objects).toHaveLength(1);
    expect(update.scene.materials).toHaveLength(1);
    expect(update.scene.magnetization_assets).toHaveLength(1);
    expect(update.scene.objects[0].tags).toContain("mesh:dirty");
    expect(update.scene.editor.selected_object_id).toBe(update.selectedObjectId);
    expect(update.mergePatch).toMatchObject({
      editor: {
        selected_object_id: update.selectedObjectId,
        active_transform_scope: "object",
        gizmo_mode: "translate",
      },
    });
  });

  it("places new objects beside the selected overlay and expands universe resources", () => {
    const update = createScenePrimitiveAuthoringUpdate({
      scene: makeScene(),
      kind: "box",
      placementOverlay: {
        boundsMin: [-10e-9, -10e-9, -5e-9],
        boundsMax: [10e-9, 10e-9, 5e-9],
      },
    });

    const object = update.scene.objects[0];
    expect(object.transform.translation[0]).toBeGreaterThan(10e-9);
    expect(update.scene.universe?.size?.[0]).toBeGreaterThan(20e-9);
    expect(update.scene.study.universe_mesh?.size?.[0]).toBeGreaterThan(20e-9);
  });
});
