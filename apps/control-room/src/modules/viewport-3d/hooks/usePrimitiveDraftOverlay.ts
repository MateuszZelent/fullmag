import { useSyncExternalStore } from "react";

import { primitiveDraftOverlayStore } from "@/kernel/authoring/geometryLifecycleCommands";

import { primitiveDraftOverlayObject } from "../layers/PrimitiveObjectLayerModel";

export function usePrimitiveDraftOverlay() {
  const draft = useSyncExternalStore(
    primitiveDraftOverlayStore.subscribe,
    primitiveDraftOverlayStore.getSnapshot,
    primitiveDraftOverlayStore.getServerSnapshot,
  );
  return draft ? primitiveDraftOverlayObject(draft) : null;
}
