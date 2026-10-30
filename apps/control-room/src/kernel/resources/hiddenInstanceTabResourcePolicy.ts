import { DATA_FIELDS_PATH } from "@/kernel/api/apiPaths";
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

// `/v2/sessions/current/data/`, derived from the typed path table.
const SESSION_DATA_PLANE_SEGMENT = DATA_FIELDS_PATH.slice(0, DATA_FIELDS_PATH.lastIndexOf("/") + 1);

/** Field, topology, table and scalar reads: the heavy live data plane. */
export function isSessionDataPlaneResourceKey(resourceKey: ResourceKey): boolean {
  return resourceKey.includes(SESSION_DATA_PLANE_SEGMENT);
}

interface DocumentVisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/**
 * While the browser tab itself is hidden, defers live data-plane loads. A
 * running solve keeps invalidating field vectors and table rows every tick;
 * nobody sees them, so only the latest request per resource is kept and it
 * loads when the tab is shown again. Control-plane resources (status, health,
 * commands) are not paused.
 */
export function createHiddenDocumentResourcePauseController({
  runtimeStore = sharedResourceRuntimeStore,
  visibility,
}: {
  runtimeStore?: ResourcePauseRuntimeStore;
  visibility: DocumentVisibilitySource;
}): () => void {
  let releasePause: (() => void) | null = null;
  const sync = (): void => {
    if (visibility.hidden) {
      releasePause ??= runtimeStore.beginPauseMatching(isSessionDataPlaneResourceKey);
    } else if (releasePause) {
      releasePause();
      releasePause = null;
    }
  };
  visibility.addEventListener("visibilitychange", sync);
  sync();
  return () => {
    visibility.removeEventListener("visibilitychange", sync);
    releasePause?.();
    releasePause = null;
  };
}
