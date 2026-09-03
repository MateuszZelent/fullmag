"use client";

import type {
  MagnetizationAsset,
  SceneDocument,
  SceneMaterialAsset,
  SceneObject,
  ScriptBuilderGeometryEntry,
} from "../../../lib/session/types";

export function resolveObjectNameFromNodeId(
  nodeId: string | undefined,
  source: readonly SceneObject[] | readonly ScriptBuilderGeometryEntry[],
): string | null {
  if (!nodeId) {
    return null;
  }
  const candidate = nodeId.replace(/^(geo|mat|obj|reg|physobj|mag)-/, "");
  const names = source
    .map((entry) => ("geometry_kind" in entry ? entry.name : entry.name || entry.id))
    .sort((left, right) => right.length - left.length);
  return names.find((name) => candidate === name || candidate.startsWith(`${name}-`)) ?? null;
}

export function findGeometryByNodeId(
  nodeId: string | undefined,
  geometries: ScriptBuilderGeometryEntry[],
): { geometry: ScriptBuilderGeometryEntry | undefined; index: number; name: string | null } {
  const name = resolveObjectNameFromNodeId(nodeId, geometries);
  const index = name ? geometries.findIndex((geometry) => geometry.name === name) : -1;
  return {
    geometry: index >= 0 ? geometries[index] : undefined,
    index,
    name,
  };
}

export function defaultSceneMaterialId(name: string): string {
  return `mat:${name}`;
}

export function defaultSceneMagnetizationId(name: string): string {
  return `mag:${name}`;
}

export function findSceneObjectByNodeId(
  nodeId: string | undefined,
  scene: SceneDocument | null,
): {
  object: SceneObject | undefined;
  index: number;
  name: string | null;
  material: SceneMaterialAsset | undefined;
  magnetization: MagnetizationAsset | undefined;
} {
  const objects = scene?.objects ?? [];
  const name = resolveObjectNameFromNodeId(nodeId, objects);
  const index = name
    ? objects.findIndex((object) => object.name === name || object.id === name)
    : -1;
  const object = index >= 0 ? objects[index] : undefined;
  return {
    object,
    index,
    name,
    material: object
      ? scene?.materials.find((material) => material.id === object.material_ref)
      : undefined,
    magnetization: object
      ? scene?.magnetization_assets.find(
          (asset) => asset.id === object.magnetization_ref,
        )
      : undefined,
  };
}
