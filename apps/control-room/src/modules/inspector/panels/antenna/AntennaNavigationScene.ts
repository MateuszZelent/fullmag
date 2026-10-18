import type { SceneResource } from "@/kernel/api/apiTypes";
import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { KernelApi } from "@/kernel/types";
import { sharedResourceRuntimeStore } from "@/kernel/resources/ResourceRuntimeStore";
import { resourceRuntimeKeyForClientScope } from "@/kernel/resources/resourceClientScope";

function sceneKey(kernel: KernelApi, scope: string | null): string | null {
  return scope && kernel.api.resourceCacheScope && kernel.commands.getSessionScopeKey() === scope
    ? resourceRuntimeKeyForClientScope(`${scope}|${MODEL_SCENE_PATH}`, kernel.api.resourceCacheScope) : null;
}

/** Read the already observed canonical scene without adding another loader. */
export function antennaNavigationSceneState(kernel: KernelApi, scope: string | null): {
  scene: SceneResource | null; error: string | null;
} {
  const key = sceneKey(kernel, scope);
  if (!key) return { scene: null, error: "The confirmed session is unavailable." };
  const snapshot = sharedResourceRuntimeStore.getSnapshot<SceneResource>(key);
  const error = snapshot.error ?? snapshot.refreshError;
  if (error) return { scene: null, error: error.message };
  const ready = snapshot.status === "ready" && snapshot.settledExternalRevision === kernel.resources.getRevision(`${scope}|${MODEL_SCENE_PATH}`);
  return { scene: ready ? snapshot.data : null, error: null };
}

export function antennaNavigationScene(kernel: KernelApi, scope: string | null): SceneResource | null {
  return antennaNavigationSceneState(kernel, scope).scene;
}

/** Observe both inputs to readiness without initiating another HTTP loader. */
export function observeAntennaNavigationScene(kernel: KernelApi, scope: string | null, listener: () => void): () => void {
  const key = sceneKey(kernel, scope);
  if (!key) return () => {};
  const unsubscribeCache = sharedResourceRuntimeStore.subscribe(key, listener);
  const unsubscribeRevision = kernel.resources.subscribe(`${scope}|${MODEL_SCENE_PATH}`, listener);
  listener();
  return () => { unsubscribeCache(); unsubscribeRevision(); };
}
