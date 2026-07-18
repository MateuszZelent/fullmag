import {
  DATA_DOMAIN_META_PATH,
  DATA_DOMAIN_TOPOLOGY_PATH,
  DATA_FIELDS_PATH,
  DATA_FIELD_VECTOR_PATH,
  DATA_PLANAR_FIELD_META_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MESHING_SHARED_DOMAIN_QUALITY_DATA_PATH,
} from "@/kernel/api/apiPaths";
import type { LayoutController } from "@/kernel/layout/LayoutController";
import { sharedResourceRuntimeStore } from "@/kernel/resources/ResourceRuntimeStore";
import type { ResourceKey } from "@/kernel/resources/resourceTypes";

interface ResourcePauseRuntimeStore {
  beginPauseMatching(predicate: (resourceKey: ResourceKey) => boolean): () => void;
}

const VIEWPORT_3D_MODULE_ID = "viewport-3d";
const FIELD_MAP_MODULE_ID = "field-map";
const PLANAR_FIELD_PREFIX =
  DATA_PLANAR_FIELD_META_PATH.split("{quantity_id}")[0];
const FIELD_VECTOR_PREFIX = DATA_FIELD_VECTOR_PATH.split("{quantity_id}")[0];
const FIELD_VECTOR_SUFFIX = DATA_FIELD_VECTOR_PATH.split("{quantity_id}")[1];

function resourcePath(resourceKey: ResourceKey): string {
  return resourceKey.split("?")[0];
}

export function isViewport3DExclusiveResourceKey(
  resourceKey: ResourceKey,
): boolean {
  if (resourceKey.startsWith(`${DATA_FIELDS_PATH}#viewport-3d:`)) {
    return true;
  }

  const path = resourcePath(resourceKey);
  if (
    path.startsWith(FIELD_VECTOR_PREFIX) &&
    path.endsWith(FIELD_VECTOR_SUFFIX)
  ) {
    return true;
  }

  return (
    path === DATA_DOMAIN_META_PATH ||
    path === DATA_DOMAIN_TOPOLOGY_PATH ||
    path === MESHING_SHARED_DOMAIN_MANIFEST_PATH ||
    path === MESHING_SHARED_DOMAIN_QUALITY_DATA_PATH
  );
}

export function createViewport3DInactiveResourcePauseController({
  layout,
  runtimeStore = sharedResourceRuntimeStore,
}: {
  layout: LayoutController;
  runtimeStore?: ResourcePauseRuntimeStore;
}): () => void {
  let releasePause: (() => void) | null = null;
  let releasePlanarPause: (() => void) | null = null;

  const sync = (activeViewportMainModuleId: string): void => {
    const shouldPause = activeViewportMainModuleId !== VIEWPORT_3D_MODULE_ID;
    if (shouldPause && !releasePause) {
      releasePause = runtimeStore.beginPauseMatching(
        isViewport3DExclusiveResourceKey,
      );
    } else if (!shouldPause && releasePause) {
      releasePause();
      releasePause = null;
    }

    const shouldPausePlanar =
      activeViewportMainModuleId !== FIELD_MAP_MODULE_ID;
    if (shouldPausePlanar && !releasePlanarPause) {
      releasePlanarPause = runtimeStore.beginPauseMatching((resourceKey) =>
        resourceKey.startsWith(PLANAR_FIELD_PREFIX),
      );
    } else if (!shouldPausePlanar && releasePlanarPause) {
      releasePlanarPause();
      releasePlanarPause = null;
    }
  };

  sync(layout.get().activeViewportMainModuleId);
  const unsubscribe = layout.subscribe((state) =>
    sync(state.activeViewportMainModuleId),
  );

  return () => {
    unsubscribe();
    releasePause?.();
    releasePlanarPause?.();
    releasePause = null;
    releasePlanarPause = null;
  };
}
