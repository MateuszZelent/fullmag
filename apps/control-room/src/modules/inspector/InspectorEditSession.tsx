"use client";

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
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
export interface InspectorEditSessionStore {
  getCurrentSession: () => InspectorEditSession | null;
  getVersion: () => number;
  register: (
    owner: symbol,
    session: InspectorEditSession | null,
  ) => void;
  subscribe: (listener: Listener) => () => void;
  unregister: (owner: symbol) => void;
  update: (owner: symbol, session: InspectorEditSession | null) => void;
}

const InspectorEditSessionContext = createContext<InspectorEditSessionStore | null>(null);
const subscribeEmpty = () => () => undefined;
const getEmptySnapshot = () => 0;

export function createInspectorEditSessionStore(): InspectorEditSessionStore {
  let currentOwner: symbol | null = null;
  let currentSession: InspectorEditSession | null = null;
  let version = 0;
  const listeners = new Set<Listener>();

  function publish(): void {
    version += 1;
    listeners.forEach((listener) => listener());
  }

  return Object.freeze({
    getCurrentSession: () => currentSession,
    getVersion: () => version,
    register: (owner: symbol, session: InspectorEditSession | null) => {
      currentOwner = owner;
      currentSession = session;
      publish();
    },
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    unregister: (owner: symbol) => {
      if (currentOwner !== owner) return;
      currentOwner = null;
      currentSession = null;
      publish();
    },
    update: (owner: symbol, session: InspectorEditSession | null) => {
      if (currentOwner !== owner) return;
      currentSession = session;
      publish();
    },
  });
}

export function InspectorEditSessionProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createInspectorEditSessionStore);
  return (
    <InspectorEditSessionContext.Provider value={store}>
      {children}
    </InspectorEditSessionContext.Provider>
  );
}

export function useInspectorEditSession(): InspectorEditSession | null {
  const store = useContext(InspectorEditSessionContext);
  useSyncExternalStore(
    store?.subscribe ?? subscribeEmpty,
    store?.getVersion ?? getEmptySnapshot,
    getEmptySnapshot,
  );
  return store?.getCurrentSession() ?? null;
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
    applyRef.current = apply;
    resetRef.current = reset;
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
  }, [apply, applying, dirty, lockReason, mode, reset, valid]);
  const facade = useMemo<InspectorEditSession>(() => ({
    apply: () => sessionRef.current?.apply() ?? false,
    get applying() { return sessionRef.current?.applying ?? false; },
    get dirty() { return sessionRef.current?.dirty ?? false; },
    get lockReason() { return sessionRef.current?.lockReason; },
    get mode() { return sessionRef.current?.mode ?? "immediate"; },
    reset: () => sessionRef.current?.reset(),
    get valid() { return sessionRef.current?.valid ?? true; },
  }), []);
  const owner = useMemo(() => Symbol("inspector-edit-session"), []);

  useEffect(() => {
    if (!store) return;
    store.register(owner, sessionRef.current ? facade : null);
    return () => store.unregister(owner);
  }, [facade, owner, store]);

  useEffect(() => {
    if (!store) return;
    store.update(owner, sessionRef.current ? facade : null);
  }, [applying, dirty, facade, lockReason, mode, owner, store, valid]);
}
