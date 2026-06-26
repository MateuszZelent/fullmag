import { useCallback, useSyncExternalStore } from "react";

import {
  createObjectExtensionActivationState,
  setObjectExtensionEnabled,
} from "./ObjectExtensionsSectionModel";
import type {
  ObjectExtensionActivationState,
  ObjectExtensionId,
} from "./objectExtensionTypes";

type Listener = () => void;

let activationSnapshot = createObjectExtensionActivationState();
const listeners = new Set<Listener>();

function emitActivationSnapshot(next: ObjectExtensionActivationState): void {
  activationSnapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getObjectExtensionActivationSnapshot(): ObjectExtensionActivationState {
  return activationSnapshot;
}

export function setGlobalObjectExtensionEnabled(
  objectId: string,
  extensionId: ObjectExtensionId,
  enabled: boolean,
): void {
  emitActivationSnapshot(
    setObjectExtensionEnabled(activationSnapshot, objectId, extensionId, enabled),
  );
}

export function useObjectExtensionActivationSnapshot(): ObjectExtensionActivationState {
  return useSyncExternalStore(
    subscribe,
    getObjectExtensionActivationSnapshot,
    getObjectExtensionActivationSnapshot,
  );
}

export function useObjectExtensionActivation(): {
  activation: ObjectExtensionActivationState;
  setEnabled(
    objectId: string,
    extensionId: ObjectExtensionId,
    enabled: boolean,
  ): void;
} {
  const activation = useObjectExtensionActivationSnapshot();

  const setEnabled = useCallback(
    (objectId: string, extensionId: ObjectExtensionId, enabled: boolean) => {
      setGlobalObjectExtensionEnabled(objectId, extensionId, enabled);
    },
    [],
  );

  return { activation, setEnabled };
}
