import { instanceTabVisibility } from "@/kernel/layout/instanceTabVisibility";
import { sharedResourceRuntimeStore } from "@/kernel/resources/ResourceRuntimeStore";
import type { ResourceKey } from "@/kernel/resources/resourceTypes";

interface ResourcePauseRuntimeStore {
  beginPauseMatching(predicate: (resourceKey: ResourceKey) => boolean): () => void;
}

interface VisibilitySource {
  hidden(): boolean;
  subscribe(listener: () => void): () => void;
}

const everyResource = (): boolean => true;

/**
 * While this page's instance tab is hidden on the host page (ADR 0069), defers
 * every resource load: realtime invalidations and timed refreshes only record
 * the latest request per resource, which loads once the tab is back in front.
 * Nothing on the server stops; the realtime connection stays open.
 */
export function createHiddenInstanceTabResourcePauseController({
  runtimeStore = sharedResourceRuntimeStore,
  visibility = instanceTabVisibility,
}: {
  runtimeStore?: ResourcePauseRuntimeStore;
  visibility?: VisibilitySource;
} = {}): () => void {
  let releasePause: (() => void) | null = null;
  const sync = (): void => {
    if (visibility.hidden()) {
      releasePause ??= runtimeStore.beginPauseMatching(everyResource);
    } else if (releasePause) {
      releasePause();
      releasePause = null;
    }
  };
  const unsubscribe = visibility.subscribe(sync);
  sync();
  return () => {
    unsubscribe();
    releasePause?.();
    releasePause = null;
  };
}
