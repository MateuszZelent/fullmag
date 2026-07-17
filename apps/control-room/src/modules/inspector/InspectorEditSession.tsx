"use client";

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export type InspectorEditMode = "staged" | "liveViewport" | "immediate";

export interface InspectorEditSession {
  apply: () => Promise<boolean> | boolean;
  applying: boolean;
  dirty: boolean;
  lockReason?: string;
  mode: InspectorEditMode;
  reset: () => Promise<void> | void;
  valid: boolean;
}

export interface InspectorActionState {
  applyReason: string | null;
  canApply: boolean;
  canReset: boolean;
}

export function inspectorActionState(session: InspectorEditSession | null): InspectorActionState {
  if (!session) return { applyReason: "This selection has no staged changes", canApply: false, canReset: false };
  if (session.lockReason) return { applyReason: session.lockReason, canApply: false, canReset: false };
  if (session.mode === "liveViewport") {
    return {
      applyReason: "Viewport changes are applied live",
      canApply: false,
      canReset: session.dirty && !session.applying,
    };
  }
  if (session.mode === "immediate") {
    return { applyReason: "Actions in this view run immediately", canApply: false, canReset: false };
  }
  return {
    applyReason: !session.dirty
      ? "No unapplied changes"
      : !session.valid
        ? "Resolve validation errors before applying"
        : session.applying
          ? "Applying changes"
          : null,
    canApply: session.dirty && session.valid && !session.applying,
    canReset: session.dirty && !session.applying,
  };
}

type Listener = () => void;
interface InspectorEditSessionStore {
  currentOwner: symbol | null;
  currentSession: InspectorEditSession | null;
  listeners: Set<Listener>;
  version: number;
}

const InspectorEditSessionContext = createContext<InspectorEditSessionStore | null>(null);
const subscribeEmpty = () => () => undefined;

export function InspectorEditSessionProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<InspectorEditSessionStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = {
      currentOwner: null,
      currentSession: null,
      listeners: new Set(),
      version: 0,
    };
  }
  return (
    <InspectorEditSessionContext.Provider value={storeRef.current}>
      {children}
    </InspectorEditSessionContext.Provider>
  );
}

export function useInspectorEditSession(): InspectorEditSession | null {
  const store = useContext(InspectorEditSessionContext);
  useSyncExternalStore(
    store
      ? (listener) => {
          store.listeners.add(listener);
          return () => store.listeners.delete(listener);
        }
      : subscribeEmpty,
    () => store?.version ?? 0,
    () => 0,
  );
  return store?.currentSession ?? null;
}

export function useRegisterInspectorEditSession(
  mode: InspectorEditMode | null,
  applying: boolean,
  dirty: boolean,
  valid: boolean,
  lockReason: string | undefined,
  apply: () => Promise<boolean> | boolean,
  reset: () => Promise<void> | void,
): void {
  const store = useContext(InspectorEditSessionContext);
  const applyRef = useRef(apply);
  const resetRef = useRef(reset);
  applyRef.current = apply;
  resetRef.current = reset;
  const sessionRef = useRef<InspectorEditSession | null>(
    mode
      ? {
          apply: () => applyRef.current(),
          applying,
          dirty,
          lockReason,
          mode,
          reset: () => resetRef.current(),
          valid,
        }
      : null,
  );
  useLayoutEffect(() => {
    sessionRef.current = mode
      ? {
          apply: () => applyRef.current(),
          applying,
          dirty,
          lockReason,
          mode,
          reset: () => resetRef.current(),
          valid,
        }
      : null;
  }, [applying, dirty, lockReason, mode, valid]);
  const facade = useMemo<InspectorEditSession>(() => ({
    apply: () => sessionRef.current?.apply() ?? false,
    get applying() { return sessionRef.current?.applying ?? false; },
    get dirty() { return sessionRef.current?.dirty ?? false; },
    get lockReason() { return sessionRef.current?.lockReason; },
    get mode() { return sessionRef.current?.mode ?? "immediate"; },
    reset: () => sessionRef.current?.reset(),
    get valid() { return sessionRef.current?.valid ?? true; },
  }), []);

  useEffect(() => {
    if (!store) return;
    const owner = Symbol("inspector-edit-session");
    store.currentOwner = owner;
    store.currentSession = sessionRef.current ? facade : null;
    store.version += 1;
    store.listeners.forEach((listener) => listener());
    return () => {
      if (store.currentOwner !== owner) return;
      store.currentOwner = null;
      store.currentSession = null;
      store.version += 1;
      store.listeners.forEach((listener) => listener());
    };
  }, [facade, store]);

  useEffect(() => {
    if (!store || store.currentSession !== facade) return;
    store.version += 1;
    store.listeners.forEach((listener) => listener());
  }, [applying, dirty, facade, lockReason, mode, store, valid]);
}
