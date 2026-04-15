"use client";

import {
  GEOMETRY_PRESET_CATALOG,
  evaluateGeometryPreset,
  type GeometryPresetKind,
} from "@/lib/geometryPresetCatalog";
import type {
  MagnetizationAsset,
  SceneMaterialAsset,
  SceneObject,
} from "@/lib/session/types";

function normalizeObjectBaseName(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "body";
}

function defaultSceneMaterialId(name: string): string {
  return `mat:${name}`;
}

function defaultSceneMagnetizationId(name: string): string {
  return `mag:${name}`;
}

export function makeUniqueSceneObjectName(
  baseName: string,
  objects: readonly SceneObject[],
  skipIndex = -1,
): string {
  const normalized = normalizeObjectBaseName(baseName);
  const existing = new Set(
    objects
      .map((object, index) => (index === skipIndex ? null : object.name || object.id))
      .filter((value): value is string => Boolean(value)),
  );
  if (!existing.has(normalized)) {
    return normalized;
  }
  let counter = 2;
  while (existing.has(`${normalized}_${counter}`)) {
    counter += 1;
  }
  return `${normalized}_${counter}`;
}

export function defaultSceneMaterialAsset(name: string): SceneMaterialAsset {
  return {
    id: defaultSceneMaterialId(name),
    name: `${name} material`,
    properties: {
      Ms: null,
      Aex: null,
      alpha: 0.01,
      Dind: null,
    },
  };
}

export function defaultSceneMagnetizationAsset(name: string): MagnetizationAsset {
  return {
    id: defaultSceneMagnetizationId(name),
    name: `${name} magnetization`,
    kind: "uniform",
    value: [0, 0, 1],
    seed: null,
    source_path: null,
    source_format: null,
    dataset: null,
    sample_index: null,
    mapping: {
      space: "object",
      projection: "object_local",
      clamp_mode: "clamp",
    },
    texture_transform: {
      translation: [0, 0, 0],
      rotation_quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
      pivot: [0, 0, 0],
    },
    preset_kind: null,
    preset_params: null,
    preset_version: null,
    ui_label: null,
  };
}

export function createSceneObjectFromGeometryPreset(
  presetKind: GeometryPresetKind,
  objects: readonly SceneObject[],
): {
  object: SceneObject;
  material: SceneMaterialAsset;
  magnetization: MagnetizationAsset;
} {
  const descriptor =
    GEOMETRY_PRESET_CATALOG.find((entry) => entry.kind === presetKind) ??
    GEOMETRY_PRESET_CATALOG[0];
  const name = makeUniqueSceneObjectName(descriptor.label, objects);
  const presetParams = { ...descriptor.defaultParams };
  const evaluated = evaluateGeometryPreset(presetKind, presetParams);

  return {
    object: {
      id: name,
      name,
      geometry: {
        geometry_kind: evaluated.geometry_kind,
        geometry_params: {
          ...evaluated.geometry_params,
          name,
        },
        bounds_min: null,
        bounds_max: null,
        preset_kind: presetKind,
        preset_params: presetParams,
        preset_version: 1,
      },
      transform: {
        translation: [0, 0, 0],
        rotation_quat: [0, 0, 0, 1],
        scale: [1, 1, 1],
        pivot: [0, 0, 0],
      },
      material_ref: defaultSceneMaterialId(name),
      region_name: null,
      magnetization_ref: defaultSceneMagnetizationId(name),
      physics_stack: undefined,
      object_mesh: null,
      mesh_override: null,
      visible: true,
      locked: false,
      tags: [],
    },
    material: defaultSceneMaterialAsset(name),
    magnetization: defaultSceneMagnetizationAsset(name),
  };
}
