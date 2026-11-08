"use client";

import { useEffect, useSyncExternalStore } from "react";

import { useSessionResourceIdentity } from "../resources/useSessionStatus";
import { sessionResourceIdentityKey } from "../resources/sessionResourceIdentity";

import {
  EMPTY_OBSERVATION_SOURCE,
  observationSourceWorkspaceStore,
  type ObservationSourceWorkspaceState,
} from "./observationSourceWorkspace";

export function useObservationSourceWorkspaceSelector<T>(
  selector: (state: ObservationSourceWorkspaceState) => T,
): T {
  const identity = useSessionResourceIdentity();
  const identityKey = identity ? sessionResourceIdentityKey(identity) : null;
  useEffect(() => {
    observationSourceWorkspaceStore.clearForSession(identity);
  }, [identity]);

  return useSyncExternalStore(
    observationSourceWorkspaceStore.subscribe,
    () => {
      const snapshot = observationSourceWorkspaceStore.getSnapshot();
      const scopedSnapshot =
        identityKey && (snapshot.pinned ?? snapshot.prepared)?.sessionIdentityKey === identityKey
          ? snapshot
          : EMPTY_OBSERVATION_SOURCE;
      return selector(scopedSnapshot);
    },
    () => selector(EMPTY_OBSERVATION_SOURCE),
  );
}
