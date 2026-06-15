import {
  MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
} from "@/kernel/api/apiPaths";
import type { SceneResource } from "@/kernel/api/apiTypes";
import type { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import type { ResourceRuntimeStore } from "@/kernel/resources/ResourceRuntimeStore";
import {
  MODEL_MATERIAL_FIELDS_RESOURCE_KEY,
  MODEL_REGION_DIAGNOSTICS_RESOURCE_KEY,
  MODEL_REGIONS_RESOURCE_KEY,
  SCENE_RESOURCE_KEY,
  publishCommittedSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";

export function regionAuthoringInvalidationKeys(): string[] {
  return [
    SCENE_RESOURCE_KEY,
    MODEL_REGIONS_RESOURCE_KEY,
    MODEL_REGION_DIAGNOSTICS_RESOURCE_KEY,
    MODEL_MATERIAL_FIELDS_RESOURCE_KEY,
    MODEL_GEOMETRY_VALIDATION_PATH,
    MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  ];
}

export function publishRegionAuthoringScene(
  resources: ResourceInvalidationController,
  scene: SceneResource,
  revision: number,
  runtimeStore?: ResourceRuntimeStore<SceneResource>,
): void {
  publishCommittedSceneResource(resources, scene, revision, runtimeStore);
  for (const key of regionAuthoringInvalidationKeys()) {
    if (key !== SCENE_RESOURCE_KEY) {
      resources.invalidate(key, revision);
    }
  }
}
