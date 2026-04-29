import { describe, expect, it } from "vitest";

import { MAGNETIC_PRESET_CATALOG } from "@/lib/magnetizationPresetCatalog";
import { buildAuthoredMagnetizationPreview } from "../authoredMagnetizationPreview";
import type { FemLiveMesh, SceneDocument } from "@/lib/session/types";

function identityTransform() {
  return {
    translation: [0, 0, 0] as [number, number, number],
    rotation_quat: [0, 0, 0, 1] as [number, number, number, number],
    scale: [1, 1, 1] as [number, number, number],
    pivot: [0, 0, 0] as [number, number, number],
  };
}

function buildScene(magnetization: {
  preset_kind: string;
  preset_params: Record<string, unknown>;
}): SceneDocument {
  return {
    revision: 4,
    objects: [{
      id: "free",
      name: "free",
      geometry: { geometry_kind: "cylinder", geometry_params: {} },
      transform: identityTransform(),
      material_ref: "mat:free",
      region_name: null,
      magnetization_ref: "mag:free",
      physics_stack: [],
      object_mesh: null,
      mesh_override: null,
      visible: true,
      locked: false,
      tags: [],
    }],
    magnetization_assets: [{
      id: "mag:free",
      name: "free magnetization",
      kind: "preset_texture",
      value: null,
      seed: null,
      source_path: null,
      source_format: null,
      dataset: null,
      sample_index: null,
      mapping: { space: "object", projection: "object_local", clamp_mode: "none" },
      texture_transform: identityTransform(),
      preset_kind: magnetization.preset_kind,
      preset_params: magnetization.preset_params,
      preset_version: 1,
      ui_label: null,
    }],
  } as Partial<SceneDocument> as SceneDocument;
}

function buildMesh(nodes: [number, number, number][]): FemLiveMesh {
  return {
    mesh_name: "test",
    nodes,
    elements: [],
    boundary_faces: [],
    topology_buffers: null,
    node_count: nodes.length,
    element_count: 0,
    boundary_face_count: 0,
    object_segments: [],
    mesh_parts: [{
      id: "part:free",
      label: "free",
      role: "magnetic_object",
      object_id: "free",
      geometry_id: "free",
      material_id: null,
      element_start: 0,
      element_count: 0,
      boundary_face_start: 0,
      boundary_face_count: 0,
      boundary_face_indices: [],
      node_start: 0,
      node_count: nodes.length,
      node_indices: [],
      surface_faces: [],
      bounds_min: null,
      bounds_max: null,
    }],
  } as Partial<FemLiveMesh> as FemLiveMesh;
}

describe("buildAuthoredMagnetizationPreview", () => {
  it("keeps vortex catalog defaults aligned with the backend evaluator", () => {
    const vortex = MAGNETIC_PRESET_CATALOG.find((entry) => entry.kind === "vortex");
    const antivortex = MAGNETIC_PRESET_CATALOG.find((entry) => entry.kind === "antivortex");

    expect(vortex?.defaultParams.core_radius).toBe(1e-9);
    expect(antivortex?.defaultParams.core_radius).toBe(1e-9);
  });

  it("samples selected vortex texture in mesh node order", () => {
    const scene = {
      revision: 4,
      objects: [{
        id: "free",
        name: "free",
        geometry: { geometry_kind: "cylinder", geometry_params: {} },
        transform: identityTransform(),
        material_ref: "mat:free",
        region_name: null,
        magnetization_ref: "mag:free",
        physics_stack: [],
        object_mesh: null,
        mesh_override: null,
        visible: true,
        locked: false,
        tags: [],
      }],
      magnetization_assets: [{
        id: "mag:free",
        name: "free magnetization",
        kind: "preset_texture",
        value: null,
        seed: null,
        source_path: null,
        source_format: null,
        dataset: null,
        sample_index: null,
        mapping: { space: "object", projection: "object_local", clamp_mode: "none" },
        texture_transform: identityTransform(),
        preset_kind: "vortex",
        preset_params: { circulation: 1, core_polarity: 1, core_radius: 1e-9, plane: "xy" },
        preset_version: 1,
        ui_label: null,
      }],
    } as Partial<SceneDocument> as SceneDocument;
    const mesh = {
      mesh_name: "test",
      nodes: [[1, 0, 0], [0, 1, 0], [3, 3, 3]],
      elements: [],
      boundary_faces: [],
      topology_buffers: null,
      node_count: 3,
      element_count: 0,
      boundary_face_count: 0,
      object_segments: [],
      mesh_parts: [{
        id: "part:free",
        label: "free",
        role: "magnetic_object",
        object_id: "free",
        geometry_id: "free",
        material_id: null,
        element_start: 0,
        element_count: 0,
        boundary_face_start: 0,
        boundary_face_count: 0,
        boundary_face_indices: [],
        node_start: 0,
        node_count: 2,
        node_indices: [],
        surface_faces: [],
        bounds_min: null,
        bounds_max: null,
      }],
    } as Partial<FemLiveMesh> as FemLiveMesh;

    const preview = buildAuthoredMagnetizationPreview({
      scene,
      mesh,
      selectedSidebarNodeId: "mag-free",
      selectedObjectId: null,
      activeTransformScope: null,
    });

    expect(preview?.presetKind).toBe("vortex");
    const values = Array.from(preview?.vectors ?? []);
    expect(values[0]).toBeCloseTo(0);
    expect(values[1]).toBeCloseTo(1);
    expect(values[2]).toBeCloseTo(0);
    expect(values[3]).toBeCloseTo(-1);
    expect(values[4]).toBeCloseTo(0);
    expect(values[5]).toBeCloseTo(0);
    expect(values.slice(6)).toEqual([0, 0, 0]);
  });

  it("samples random seeded texture with visible nanoscale variation", () => {
    const scene = buildScene({
      preset_kind: "random",
      preset_params: { seed: 7 },
    });
    const mesh = buildMesh([
      [0, 0, 0],
      [50e-9, 0, 0],
      [100e-9, 25e-9, 0],
    ]);

    const preview = buildAuthoredMagnetizationPreview({
      scene,
      mesh,
      selectedSidebarNodeId: "mag-free",
      selectedObjectId: null,
      activeTransformScope: null,
    });

    expect(preview?.presetKind).toBe("random");
    expect(preview?.vectors.length).toBe(9);
    const dot01 =
      preview!.vectors[0] * preview!.vectors[3] +
      preview!.vectors[1] * preview!.vectors[4] +
      preview!.vectors[2] * preview!.vectors[5];
    const dot12 =
      preview!.vectors[3] * preview!.vectors[6] +
      preview!.vectors[4] * preview!.vectors[7] +
      preview!.vectors[5] * preview!.vectors[8];
    expect(Math.abs(dot01)).toBeLessThan(0.999);
    expect(Math.abs(dot12)).toBeLessThan(0.999);
  });

  it("can resample all authored textures after a mesh rebuild without a texture node selection", () => {
    const scene = {
      revision: 7,
      objects: [{
        id: "free",
        name: "free",
        geometry: { geometry_kind: "cylinder", geometry_params: {} },
        transform: identityTransform(),
        material_ref: "mat:free",
        region_name: null,
        magnetization_ref: "mag:free",
        physics_stack: [],
        object_mesh: null,
        mesh_override: null,
        visible: true,
        locked: false,
        tags: [],
      }],
      magnetization_assets: [{
        id: "mag:free",
        name: "free magnetization",
        kind: "preset_texture",
        value: null,
        seed: null,
        source_path: null,
        source_format: null,
        dataset: null,
        sample_index: null,
        mapping: { space: "object", projection: "object_local", clamp_mode: "none" },
        texture_transform: identityTransform(),
        preset_kind: "vortex",
        preset_params: { circulation: 1, core_polarity: 1, core_radius: 1e-9, plane: "xy" },
        preset_version: 1,
        ui_label: null,
      }],
    } as Partial<SceneDocument> as SceneDocument;
    const mesh = {
      mesh_id: "mesh-a",
      generation_id: "generation-after-rebuild",
      mesh_name: "test",
      nodes: [[1, 0, 0], [0, 1, 0], [3, 3, 3]],
      elements: [],
      boundary_faces: [],
      topology_buffers: null,
      node_count: 3,
      element_count: 0,
      boundary_face_count: 0,
      object_segments: [],
      mesh_parts: [{
        id: "part:free",
        label: "free",
        role: "magnetic_object",
        object_id: "free",
        geometry_id: "free",
        material_id: null,
        element_start: 0,
        element_count: 0,
        boundary_face_start: 0,
        boundary_face_count: 0,
        boundary_face_indices: [],
        node_start: 0,
        node_count: 2,
        node_indices: [1, 0],
        surface_faces: [],
        bounds_min: null,
        bounds_max: null,
      }],
    } as Partial<FemLiveMesh> as FemLiveMesh;

    const preview = buildAuthoredMagnetizationPreview({
      scene,
      mesh,
      selectedSidebarNodeId: "mesh-statistics",
      selectedObjectId: null,
      activeTransformScope: null,
      includeAllObjects: true,
    });

    expect(preview?.revision).toContain("generation-after-rebuild");
    const values = Array.from(preview?.vectors ?? []);
    expect(values[0]).toBeCloseTo(0);
    expect(values[1]).toBeCloseTo(1);
    expect(values[3]).toBeCloseTo(-1);
    expect(values[4]).toBeCloseTo(0);
    expect(values.slice(6)).toEqual([0, 0, 0]);
  });
});
