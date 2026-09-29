"use client";

import { useEffect, useSyncExternalStore } from "react";

import { useSessionResourceIdentity } from "../resources/useSessionStatus";
import { sessionResourceIdentityKey } from "../resources/sessionResourceIdentity";

import {
  observationSourceWorkspaceStore,
  type ObservationSourceWorkspaceState,
} from "./observationSourceWorkspace";

const SERVER_SNAPSHOT: ObservationSourceWorkspaceState = { pinned: null };

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
        identityKey && snapshot.pinned?.sessionIdentityKey === identityKey
          ? snapshot
          : SERVER_SNAPSHOT;
      return selector(scopedSnapshot);
    },
    () => selector(SERVER_SNAPSHOT),
  );
}
