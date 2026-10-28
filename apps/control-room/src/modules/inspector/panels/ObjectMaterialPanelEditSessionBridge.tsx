"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";

import {
  useInspectorEditSessionStore,
  type InspectorEditSession,
  type InspectorEditSessionStore,
} from "../InspectorEditSession";
import {
  combineObjectMaterialEditSessions,
  type ObjectMaterialMutationCoordinator,
} from "./ObjectMaterialPanelEditSession";

const emptyInspectorEditSessionVersion = () => 0;

export function ObjectMaterialPanelEditSessionBridge({
  absorbingBoundaryEditSessionStore,
  materialSession,
  mutationCoordinator,
  mutationScopeKey,
}: {
  absorbingBoundaryEditSessionStore: InspectorEditSessionStore;
  materialSession: InspectorEditSession;
  mutationCoordinator: ObjectMaterialMutationCoordinator;
  mutationScopeKey: string;
}) {
  useSyncExternalStore(
    absorbingBoundaryEditSessionStore.subscribe,
    absorbingBoundaryEditSessionStore.getVersion,
    emptyInspectorEditSessionVersion,
  );
  const combinedEditSession = combineObjectMaterialEditSessions(
    materialSession,
    absorbingBoundaryEditSessionStore.getCurrentSession(),
  );
  const store = useInspectorEditSessionStore();
  const sessionRef = useRef(combinedEditSession);
  const scopeKeyRef = useRef(mutationScopeKey);
  useLayoutEffect(() => {
    sessionRef.current = combinedEditSession;
    scopeKeyRef.current = mutationScopeKey;
  }, [combinedEditSession, mutationScopeKey]);
  const owner = useMemo(() => Symbol("object-material-combined-session"), []);
  const facade = useMemo<InspectorEditSession>(() => ({
    apply: async () => {
      if (mutationCoordinator.getActive(scopeKeyRef.current)) return false;
      return (await sessionRef.current.apply()) === true;
    },
    get applyBlockReason() {
      return sessionRef.current.applyBlockReason;
    },
    get applying() {
      return sessionRef.current.applying || mutationCoordinator.getActive(scopeKeyRef.current) !== null;
    },
    get dirty() {
      return sessionRef.current.dirty || mutationCoordinator.getActive(scopeKeyRef.current) !== null;
    },
    get lockReason() {
      return sessionRef.current.lockReason;
    },
    get mode() {
      return sessionRef.current.mode;
    },
    reset: async () => {
      if (mutationCoordinator.getActive(scopeKeyRef.current)) return;
      await sessionRef.current.reset();
    },
    get valid() {
      return sessionRef.current.valid;
    },
  }), [mutationCoordinator]);
  useEffect(() => {
    if (!store) return;
    store.register(owner, facade);
    return () => store.unregister(owner);
  }, [facade, owner, store]);
  useEffect(() => {
    if (!store) return;
    store.update(owner, facade);
  }, [
    combinedEditSession.applyBlockReason,
    combinedEditSession.applying,
    combinedEditSession.dirty,
    combinedEditSession.lockReason,
    combinedEditSession.mode,
    combinedEditSession.valid,
    facade,
    owner,
    store,
  ]);
  return null;
}
