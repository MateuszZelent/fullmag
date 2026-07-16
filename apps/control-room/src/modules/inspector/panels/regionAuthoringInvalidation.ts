import {
  MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_MAGNETIZATION_ASSET_PATH,
  MODEL_MATERIAL_PATH,
} from "@/kernel/api/apiPaths";
import type { SceneResource } from "@/kernel/api/apiTypes";
import type { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import type { ResourceRuntimeStore } from "@/kernel/resources/ResourceRuntimeStore";
import {
  FDM_REGION_MEMBERSHIP_BINARY_RESOURCE_KEY,
  FDM_REGION_MEMBERSHIPS_RESOURCE_KEY,
  MESH_BUILD_CURRENT_RESOURCE_KEY,
  MESH_REGION_MEMBERSHIPS_RESOURCE_KEY,
  MESH_SUMMARY_RESOURCE_KEY,
  MESH_SEMANTICS_RESOURCE_KEY,
  MODEL_MATERIAL_FIELDS_RESOURCE_KEY,
  MODEL_REGION_DIAGNOSTICS_RESOURCE_KEY,
  MODEL_REGIONS_RESOURCE_KEY,
  SCENE_RESOURCE_KEY,
  resolveMeshRegionQualityResourceKey,
  resolveObjectMeshQualityResourceKey,
  resolveObjectMeshReportResourceKey,
  resolveObjectTopologyResourceKey,
  publishCommittedSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";

export function regionAuthoringInvalidationKeys(): string[] {
  return [
    SCENE_RESOURCE_KEY,
    MODEL_REGIONS_RESOURCE_KEY,
    MODEL_REGION_DIAGNOSTICS_RESOURCE_KEY,
    MODEL_MATERIAL_FIELDS_RESOURCE_KEY,
    MODEL_MAGNETIZATION_ASSET_PATH,
    MODEL_MATERIAL_PATH,
    MODEL_GEOMETRY_VALIDATION_PATH,
    MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  ];
}

/**
 * Return only resources that describe the current realized mesh.  The
 * latest-successful build is intentionally omitted: it remains a historical,
 * inspectable artifact while the scene is mesh-dirty.
 */
export function regionMeshInvalidationKeys(scene: SceneResource): string[] {
  const dirtyObjects = (scene.objects ?? []).filter((object) =>
    Array.isArray(object.tags) && object.tags.some((tag) => tag === "mesh:dirty"),
  );
  if (dirtyObjects.length === 0) return [];

  const keys = new Set<string>([
    MESH_BUILD_CURRENT_RESOURCE_KEY,
    MESH_SUMMARY_RESOURCE_KEY,
    MESH_SEMANTICS_RESOURCE_KEY,
    MESH_REGION_MEMBERSHIPS_RESOURCE_KEY,
    FDM_REGION_MEMBERSHIPS_RESOURCE_KEY,
    FDM_REGION_MEMBERSHIP_BINARY_RESOURCE_KEY,
  ]);
  for (const object of dirtyObjects) {
    keys.add(resolveObjectTopologyResourceKey(object.id));
    keys.add(resolveObjectMeshReportResourceKey(object.id));
    keys.add(resolveObjectMeshQualityResourceKey(object.id));
    for (const region of object.regions ?? []) {
      if (typeof region.region_id === "string" && region.region_id.length > 0) {
        keys.add(resolveMeshRegionQualityResourceKey(region.region_id));
      }
    }
  }
  return [...keys];
}

export function publishRegionAuthoringScene(
  resources: ResourceInvalidationController,
  scene: SceneResource,
  revision: number,
  runtimeStore?: ResourceRuntimeStore<SceneResource>,
): void {
  publishCommittedSceneResource(resources, scene, revision, runtimeStore);
  for (const key of [
    ...regionAuthoringInvalidationKeys(),
    ...regionMeshInvalidationKeys(scene),
  ]) {
    if (key !== SCENE_RESOURCE_KEY) {
      resources.invalidate(key, revision);
    }
  }
}
