import type {
  MagnetizationAsset,
  SceneDocument,
  SceneObject,
  ScriptBuilderGeometryEntry,
  ScriptBuilderMagnetizationEntry,
  ScriptBuilderState,
  Transform3D,
} from "./types";
import { ensureObjectPhysicsStack } from "./magneticPhysics";

function zeroVec3(): [number, number, number] {
  return [0, 0, 0];
}

function oneVec3(): [number, number, number] {
  return [1, 1, 1];
}

function identityQuat(): [number, number, number, number] {
  return [0, 0, 0, 1];
}

function cloneGeometryParams(
  value: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return value ? { ...value } : {};
}

function readTranslation(params: Record<string, unknown>): [number, number, number] {
  const raw =
    (Array.isArray(params.translation) ? params.translation : null) ??
    (Array.isArray(params.translate) ? params.translate : null);
  if (!raw || raw.length !== 3) {
    return zeroVec3();
  }
  return [Number(raw[0] ?? 0), Number(raw[1] ?? 0), Number(raw[2] ?? 0)];
}

function stripTranslation(params: Record<string, unknown>): Record<string, unknown> {
  const next = { ...params };
  delete next.translation;
  delete next.translate;
  return next;
}

function materialIdForGeometry(name: string): string {
  return `mat:${name}`;
}

function magnetizationIdForGeometry(name: string): string {
  return `mag:${name}`;
}

function identityTransformWithTranslation(
  translation: [number, number, number],
): Transform3D {
  return {
    translation,
    rotation_quat: identityQuat(),
    scale: oneVec3(),
    pivot: zeroVec3(),
  };
}

function buildMagnetizationAsset(
  name: string,
  magnetization: ScriptBuilderMagnetizationEntry,
): MagnetizationAsset {
  const inferredKind =
    magnetization.kind === "file" &&
    (magnetization.dataset != null || magnetization.sample_index != null)
      ? "sampled"
      : magnetization.kind;
  return {
    id: magnetizationIdForGeometry(name),
    name: `${name} magnetization`,
    kind: inferredKind,
    value: magnetization.value ?? null,
    seed: magnetization.seed ?? null,
    source_path: magnetization.source_path ?? null,
    source_format: magnetization.source_format ?? null,
    dataset: magnetization.dataset ?? null,
    sample_index: magnetization.sample_index ?? null,
    mapping: magnetization.mapping ?? {
      space: "object",
      projection: "object_local",
      clamp_mode: "none",
    },
    texture_transform: magnetization.texture_transform ?? {
      translation: zeroVec3(),
      rotation_quat: identityQuat(),
      scale: oneVec3(),
      pivot: zeroVec3(),
    },
    preset_kind: magnetization.preset_kind ?? null,
    preset_params: magnetization.preset_params ?? null,
    preset_version: magnetization.preset_version ?? null,
    ui_label: magnetization.ui_label ?? null,
  };
}

export function buildSceneDocumentFromScriptBuilder(
  builder: ScriptBuilderState,
): SceneDocument {
  const objects: SceneObject[] = builder.geometries.map((geometry) => {
    const geometryParams = cloneGeometryParams(geometry.geometry_params);
    const translation = readTranslation(geometryParams);
    return {
      id: geometry.name,
      name: geometry.name,
      geometry: {
        geometry_kind: geometry.geometry_kind,
        geometry_params: stripTranslation(geometryParams),
        bounds_min: geometry.bounds_min ?? null,
        bounds_max: geometry.bounds_max ?? null,
      },
      transform: identityTransformWithTranslation(translation),
      material_ref: materialIdForGeometry(geometry.name),
      region_name: geometry.region_name ?? null,
      magnetization_ref: magnetizationIdForGeometry(geometry.name),
      physics_stack: ensureObjectPhysicsStack(
        geometry.physics_stack,
        geometry.material.Dind,
      ),
      object_mesh: geometry.mesh ?? null,
      mesh_override: geometry.mesh ?? null,
      visible: true,
      locked: false,
      tags: [],
    };
  });

  return {
    version: "scene.v1",
    revision: builder.revision,
    scene: {
      id: "scene",
      name: "Scene",
      source_of_truth: "repo_head",
      authoring_schema: "mesh-first-fem.v1",
    },
    universe: builder.universe,
    objects,
    materials: builder.geometries.map((geometry) => ({
      id: materialIdForGeometry(geometry.name),
      name: `${geometry.name} material`,
      properties: geometry.material,
    })),
    magnetization_assets: builder.geometries.map((geometry) =>
      buildMagnetizationAsset(geometry.name, geometry.magnetization),
    ),
    current_modules: {
      modules: builder.current_modules,
      excitation_analysis: builder.excitation_analysis,
    },
    study: {
      backend: builder.backend,
      requested_backend: builder.backend ?? "auto",
      requested_device: "auto",
      requested_precision: "double",
      requested_mode: "strict",
      requested_cpu_threads: builder.cpu_threads,
      demag_realization: builder.demag_realization,
      external_field: builder.external_field,
      solver: builder.solver,
      universe_mesh: builder.universe,
      shared_domain_mesh: builder.mesh,
      mesh_defaults: builder.mesh,
      stages: builder.stages,
      study_pipeline: builder.study_pipeline ?? null,
      initial_state: builder.initial_state,
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

function magnetizationForObject(
  scene: SceneDocument,
  object: SceneObject,
): ScriptBuilderMagnetizationEntry {
  const asset = scene.magnetization_assets.find(
    (candidate) => candidate.id === object.magnetization_ref,
  );
  if (!asset) {
    return {
      kind: "uniform",
      value: [1, 0, 0],
      seed: null,
      source_path: null,
      source_format: null,
      dataset: null,
      sample_index: null,
    };
  }
  return {
    kind: asset.kind,
    value: asset.value,
    seed: asset.seed,
    source_path: asset.source_path,
    source_format: asset.source_format,
    dataset: asset.dataset,
    sample_index: asset.sample_index,
    mapping: asset.mapping,
    texture_transform: asset.texture_transform,
    preset_kind: asset.preset_kind,
    preset_params: asset.preset_params,
    preset_version: asset.preset_version,
    ui_label: asset.ui_label,
  };
}

export function buildScriptBuilderFromSceneDocument(
  scene: SceneDocument,
): ScriptBuilderState {
  return {
    revision: scene.revision,
    backend: scene.study.backend,
    cpu_threads: scene.study.requested_cpu_threads,
    demag_realization: scene.study.demag_realization,
    external_field: scene.study.external_field,
    solver: scene.study.solver,
    mesh: scene.study.shared_domain_mesh ?? scene.study.mesh_defaults,
    universe: scene.study.universe_mesh ?? scene.universe,
    domain_frame: null,
    stages: scene.study.stages,
    study_pipeline: scene.study.study_pipeline ?? null,
    initial_state: scene.study.initial_state,
    geometries: scene.objects.map((object): ScriptBuilderGeometryEntry => {
      const material =
        scene.materials.find((candidate) => candidate.id === object.material_ref)?.properties ?? {
          Ms: null,
          Aex: null,
          alpha: 0.01,
          Dind: null,
        };
      const geometryParams = stripTranslation(
        cloneGeometryParams(object.geometry.geometry_params),
      );
      const translation = object.transform.translation;
      if (translation.some((value) => Math.abs(value) > Number.EPSILON)) {
        geometryParams.translation = [...translation];
      }
      return {
        name: object.name || object.id,
        region_name: object.region_name ?? null,
        geometry_kind: object.geometry.geometry_kind,
        geometry_params: geometryParams,
        bounds_min: object.geometry.bounds_min ?? null,
        bounds_max: object.geometry.bounds_max ?? null,
        material,
        physics_stack: ensureObjectPhysicsStack(
          object.physics_stack,
          material.Dind,
        ),
        magnetization: magnetizationForObject(scene, object),
        mesh: object.object_mesh ?? object.mesh_override ?? null,
      };
    }),
    current_modules: scene.current_modules.modules,
    excitation_analysis: scene.current_modules.excitation_analysis,
  };
}

export function sceneDocumentSignature(scene: SceneDocument | null): string | null {
  return scene ? JSON.stringify(scene) : null;
}
