"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { KernelContext } from "@/kernel/KernelContext";
import type { RequestOptions } from "@/kernel/api/apiTypes";

import { applyInspectorSessionWithHistory } from "./InspectorHistoryBridge";

export type InspectorEditMode = "staged" | "liveViewport" | "immediate";

export type InspectorEditSessionModeV2 =
  | "staged"
  | "liveViewport"
  | "immediate"
  | "readOnly";

export type InspectorEditSessionStatusV2 =
  | "ReadOnlyIdle"
  | "LiveClean"
  | "LiveOverridden"
  | "ImmediateReady"
  | "ImmediateRunning"
  | "StagedClean"
  | "DirtyValid"
  | "DirtyInvalid"
  | "ConfirmCostly"
  | "Applying"
  | "AppliedFlash"
  | "ApplyRejected";

export interface InspectorEditSession {
  applyBlockReason?: string;
  apply: () => Promise<boolean> | boolean;
  applying: boolean;
  dirty: boolean;
  lockReason?: string;
  mode: InspectorEditMode;
  reset: () => Promise<void> | void;
  valid: boolean;
}

export interface InspectorDirtySessionSummary {
  readonly sessionKey: string;
  readonly nodeTitle: string;
  readonly dirtyFieldLabels: readonly string[];
}

export interface InspectorEditSessionV2 {
  readonly sessionKey: string;
  readonly nodeTitle?: string;
  readonly mode: InspectorEditSessionModeV2;
  readonly applying: boolean;
  readonly dirty: boolean;
  readonly dirtyFields: ReadonlySet<string>;
  readonly dirtyFieldLabels: readonly string[];
  readonly invalidFields: ReadonlyMap<string, string>;
  readonly valid: boolean;
  readonly lockReason: string | null;
  readonly applyBlockReason: string | null;
  apply: () => Promise<boolean>;
  revertAll: () => Promise<void> | void;
  revertField: (fieldKey: string) => void;
  focusField: (fieldKey: string) => void;
}

export interface InspectorActionState {
  applyReason: string | null;
  canApply: boolean;
  canReset: boolean;
}

export function formatInspectorSessionKey(
  selectionKey: string,
  specId: string,
  modeTabId?: string | null,
): string {
  return `${selectionKey}::${specId}::${modeTabId ?? "default"}`;
}

export function areInspectorFieldValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => areInspectorFieldValuesEqual(item, right[index]))
    );
  }
  return false;
}

function areDraftObjectsShallowEqual<TDraft extends Record<string, unknown>>(
  left: TDraft,
  right: TDraft,
): boolean {
  if (left === right) return true;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (
      !Object.prototype.hasOwnProperty.call(right, key) ||
      !areInspectorFieldValuesEqual(left[key], right[key])
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Losslessly rebases incoming baseline fields onto the active draft while
 * keeping every dirty user-edited field intact (Review Focus #2).
 */
export function rebaseInspectorDraft<TDraft extends Record<string, unknown>>(
  currentDraft: TDraft,
  incomingBaseline: TDraft,
  dirtyFields: ReadonlySet<string>,
): TDraft {
  let changed = false;
  const next: Record<string, unknown> = { ...currentDraft };
  for (const key of Object.keys(incomingBaseline)) {
    if (dirtyFields.has(key)) {
      continue;
    }
    if (!areInspectorFieldValuesEqual(currentDraft[key], incomingBaseline[key])) {
      next[key] = incomingBaseline[key];
      changed = true;
    }
  }
  return changed ? (next as TDraft) : currentDraft;
}

export function adaptSessionV2ToLegacy(
  session: InspectorEditSessionV2,
): InspectorEditSession {
  return {
    apply: () => session.apply(),
    get applyBlockReason() {
      return session.applyBlockReason ?? undefined;
    },
    get applying() {
      return session.applying;
    },
    get dirty() {
      return session.dirty;
    },
    get lockReason() {
      return session.lockReason ?? undefined;
    },
    get mode(): InspectorEditMode {
      return session.mode === "readOnly" ? "immediate" : session.mode;
    },
    reset: () => session.revertAll(),
    get valid() {
      return session.valid;
    },
  };
}

export function inspectorActionState(
  session: InspectorEditSession | null,
): InspectorActionState {
  if (!session) {
    return {
      applyReason: "This selection has no staged changes",
      canApply: false,
      canReset: false,
    };
  }
  if (session.lockReason) {
    return { applyReason: session.lockReason, canApply: false, canReset: false };
  }
  if (session.mode === "liveViewport") {
    return {
      applyReason: "Viewport changes are applied live",
      canApply: false,
      canReset: session.dirty && !session.applying,
    };
  }
  if (session.mode === "immediate") {
    return {
      applyReason: "Actions in this view run immediately",
      canApply: false,
      canReset: false,
    };
  }
  const applyReason = session.applying
    ? "Applying changes"
    : !session.dirty
      ? "No unapplied changes"
      : session.applyBlockReason ??
        (!session.valid ? "Resolve validation errors before applying" : null);
  return {
    applyReason,
    canApply:
      session.dirty &&
      session.valid &&
      !session.applying &&
      !session.applyBlockReason,
    canReset: session.dirty && !session.applying,
  };
}

type Listener = () => void;

export interface InspectorEditSessionStore {
  getCurrentSession: () => InspectorEditSession | null;
  getVersion: () => number;
  register: (owner: symbol, session: InspectorEditSession | null) => void;
  subscribe: (listener: Listener) => () => void;
  unregister: (owner: symbol) => void;
  update: (owner: symbol, session: InspectorEditSession | null) => void;
  registerV2: (
    sessionKey: string,
    owner: symbol,
    session: InspectorEditSessionV2 | null,
  ) => void;
  updateV2: (
    sessionKey: string,
    owner: symbol,
    session: InspectorEditSessionV2 | null,
  ) => void;
  unregisterV2: (sessionKey: string, owner: symbol) => void;
  getSessionV2: (sessionKey: string) => InspectorEditSessionV2 | null;
  getSessionsV2: () => ReadonlyMap<string, InspectorEditSessionV2>;
  getPrimaryStagedSessionV2: () => InspectorEditSessionV2 | null;
  isSessionRegistered: (
    session: InspectorEditSession | InspectorEditSessionV2,
  ) => boolean;
  hasAnyStagedDirtySession: () => boolean;
  getActiveStagedDirtySummaries: () => readonly InspectorDirtySessionSummary[];
  getStagedDirtyFieldCount: () => number;
}

const InspectorEditSessionContext = createContext<InspectorEditSessionStore | null>(
  null,
);
const subscribeEmpty = () => () => undefined;
const getEmptySnapshot = () => 0;
const EMPTY_SUMMARIES: readonly InspectorDirtySessionSummary[] = Object.freeze([]);
const EMPTY_STRING_SET: ReadonlySet<string> = new Set();
const EMPTY_ERROR_MAP: ReadonlyMap<string, string> = new Map();

export function createInspectorEditSessionStore(): InspectorEditSessionStore {
  let currentOwner: symbol | null = null;
  let currentSession: InspectorEditSession | null = null;
  const v2Entries = new Map<
    string,
    { adapter: InspectorEditSession; owner: symbol; session: InspectorEditSessionV2 }
  >();
  let latestV2Key: string | null = null;
  let version = 0;
  const listeners = new Set<Listener>();

  function publish(): void {
    version += 1;
    listeners.forEach((listener) => listener());
  }

  function findPrimaryStagedV2Entry() {
    for (const entry of v2Entries.values()) {
      if (entry.session.mode === "staged" && entry.session.dirty) {
        return entry;
      }
    }
    if (latestV2Key) {
      const latest = v2Entries.get(latestV2Key);
      if (latest && latest.session.mode === "staged") {
        return latest;
      }
    }
    for (const entry of v2Entries.values()) {
      if (entry.session.mode === "staged") {
        return entry;
      }
    }
    return null;
  }

  return Object.freeze({
    getActiveStagedDirtySummaries: () => {
      const summaries: InspectorDirtySessionSummary[] = [];
      for (const { session } of v2Entries.values()) {
        if (session.mode === "staged" && session.dirty) {
          summaries.push({
            dirtyFieldLabels: session.dirtyFieldLabels,
            nodeTitle: session.nodeTitle ?? "Selection",
            sessionKey: session.sessionKey,
          });
        }
      }
      return summaries.length > 0 ? summaries : EMPTY_SUMMARIES;
    },
    getCurrentSession: () => {
      const primaryStagedV2 = findPrimaryStagedV2Entry();
      if (primaryStagedV2 && primaryStagedV2.session.dirty) {
        return primaryStagedV2.adapter;
      }
      if (currentSession) {
        return currentSession;
      }
      if (primaryStagedV2) {
        return primaryStagedV2.adapter;
      }
      if (latestV2Key) {
        return v2Entries.get(latestV2Key)?.adapter ?? null;
      }
      const fallback = v2Entries.values().next().value;
      return fallback?.adapter ?? null;
    },
    getPrimaryStagedSessionV2: () => findPrimaryStagedV2Entry()?.session ?? null,
    getSessionV2: (sessionKey: string) =>
      v2Entries.get(sessionKey)?.session ?? null,
    getSessionsV2: () => {
      const result = new Map<string, InspectorEditSessionV2>();
      for (const [key, entry] of v2Entries) {
        result.set(key, entry.session);
      }
      return result;
    },
    getStagedDirtyFieldCount: () => {
      let count = 0;
      for (const { session } of v2Entries.values()) {
        if (session.mode === "staged" && session.dirty) {
          count += Math.max(1, session.dirtyFields.size);
        }
      }
      if (count === 0 && currentSession?.mode === "staged" && currentSession.dirty) {
        return 1;
      }
      return count;
    },
    getVersion: () => version,
    hasAnyStagedDirtySession: () => {
      for (const { session } of v2Entries.values()) {
        if (session.mode === "staged" && session.dirty) {
          return true;
        }
      }
      return currentSession?.mode === "staged" && currentSession.dirty;
    },
    isSessionRegistered: (
      candidate: InspectorEditSession | InspectorEditSessionV2,
    ) => {
      if (currentSession === candidate) return true;
      for (const entry of v2Entries.values()) {
        if (entry.session === candidate || entry.adapter === candidate) {
          return true;
        }
      }
      return false;
    },
    register: (owner: symbol, session: InspectorEditSession | null) => {
      currentOwner = owner;
      currentSession = session;
      publish();
    },
    registerV2: (
      sessionKey: string,
      owner: symbol,
      session: InspectorEditSessionV2 | null,
    ) => {
      if (!session) {
        const existing = v2Entries.get(sessionKey);
        if (existing && existing.owner === owner) {
          v2Entries.delete(sessionKey);
          if (latestV2Key === sessionKey) {
            latestV2Key = Array.from(v2Entries.keys()).at(-1) ?? null;
          }
          publish();
        }
        return;
      }
      const existing = v2Entries.get(sessionKey);
      const adapter =
        existing && existing.session === session
          ? existing.adapter
          : adaptSessionV2ToLegacy(session);
      v2Entries.set(sessionKey, { adapter, owner, session });
      latestV2Key = sessionKey;
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
    unregisterV2: (sessionKey: string, owner: symbol) => {
      const existing = v2Entries.get(sessionKey);
      if (!existing || existing.owner !== owner) return;
      v2Entries.delete(sessionKey);
      if (latestV2Key === sessionKey) {
        latestV2Key = Array.from(v2Entries.keys()).at(-1) ?? null;
      }
      publish();
    },
    update: (owner: symbol, session: InspectorEditSession | null) => {
      if (currentOwner !== owner) return;
      currentSession = session;
      publish();
    },
    updateV2: (
      sessionKey: string,
      owner: symbol,
      session: InspectorEditSessionV2 | null,
    ) => {
      const existing = v2Entries.get(sessionKey);
      if (existing && existing.owner !== owner) return;
      if (!session) {
        if (!existing) return;
        v2Entries.delete(sessionKey);
        if (latestV2Key === sessionKey) {
          latestV2Key = Array.from(v2Entries.keys()).at(-1) ?? null;
        }
        publish();
        return;
      }
      const adapter =
        existing && existing.session === session
          ? existing.adapter
          : adaptSessionV2ToLegacy(session);
      v2Entries.set(sessionKey, { adapter, owner, session });
      publish();
    },
  });
}

export function InspectorEditSessionProvider({
  children,
  store: suppliedStore,
}: {
  children: ReactNode;
  store?: InspectorEditSessionStore;
}) {
  const [ownedStore] = useState(createInspectorEditSessionStore);
  const store = suppliedStore ?? ownedStore;
  return (
    <InspectorEditSessionContext.Provider value={store}>
      {children}
    </InspectorEditSessionContext.Provider>
  );
}

export function useInspectorEditSessionStore(): InspectorEditSessionStore | null {
  return useContext(InspectorEditSessionContext);
}

export function useInspectorEditSession(): InspectorEditSession | null {
  const store = useInspectorEditSessionStore();
  useSyncExternalStore(
    store?.subscribe ?? subscribeEmpty,
    store?.getVersion ?? getEmptySnapshot,
    getEmptySnapshot,
  );
  return store?.getCurrentSession() ?? null;
}

export function usePrimaryStagedInspectorSessionV2(): InspectorEditSessionV2 | null {
  const store = useInspectorEditSessionStore();
  useSyncExternalStore(
    store?.subscribe ?? subscribeEmpty,
    store?.getVersion ?? getEmptySnapshot,
    getEmptySnapshot,
  );
  return store?.getPrimaryStagedSessionV2() ?? null;
}

export function useStagedDirtyFieldCount(): number {
  const store = useInspectorEditSessionStore();
  useSyncExternalStore(
    store?.subscribe ?? subscribeEmpty,
    store?.getVersion ?? getEmptySnapshot,
    getEmptySnapshot,
  );
  return store?.getStagedDirtyFieldCount() ?? 0;
}

export function useRegisterInspectorEditSessionV2(
  session: InspectorEditSessionV2 | null,
): void {
  const store = useContext(InspectorEditSessionContext);
  const owner = useMemo(() => Symbol("inspector-edit-session-v2"), []);
  const sessionKey = session?.sessionKey ?? null;
  const sessionRef = useRef<InspectorEditSessionV2 | null>(session);

  useLayoutEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const facade = useMemo<InspectorEditSessionV2 | null>(() => {
    if (!sessionKey) return null;
    return {
      apply: async () => (await sessionRef.current?.apply()) === true,
      get applyBlockReason() {
        return sessionRef.current?.applyBlockReason ?? null;
      },
      get applying() {
        return sessionRef.current?.applying ?? false;
      },
      get dirty() {
        return sessionRef.current?.dirty ?? false;
      },
      get dirtyFieldLabels() {
        return sessionRef.current?.dirtyFieldLabels ?? [];
      },
      get dirtyFields() {
        return sessionRef.current?.dirtyFields ?? EMPTY_STRING_SET;
      },
      focusField: (fieldKey: string) => sessionRef.current?.focusField(fieldKey),
      get invalidFields() {
        return sessionRef.current?.invalidFields ?? EMPTY_ERROR_MAP;
      },
      get lockReason() {
        return sessionRef.current?.lockReason ?? null;
      },
      get mode() {
        return sessionRef.current?.mode ?? "readOnly";
      },
      get nodeTitle() {
        return sessionRef.current?.nodeTitle;
      },
      revertAll: () => sessionRef.current?.revertAll(),
      revertField: (fieldKey: string) => sessionRef.current?.revertField(fieldKey),
      sessionKey,
      get valid() {
        return sessionRef.current?.valid ?? true;
      },
    };
  }, [sessionKey]);

  const sessionMode = session?.mode ?? null;
  const sessionDirty = session?.dirty ?? false;
  const sessionApplying = session?.applying ?? false;
  const sessionValid = session?.valid ?? true;
  const sessionLockReason = session?.lockReason ?? null;
  const sessionApplyBlockReason = session?.applyBlockReason ?? null;
  const sessionNodeTitle = session?.nodeTitle ?? null;
  const sessionDirtyLabelsKey = session
    ? session.dirtyFieldLabels.join("\u0000")
    : "";
  const sessionInvalidKey = session
    ? Array.from(session.invalidFields.entries())
        .map(([k, v]) => `${k}:${v}`)
        .join("\u0000")
    : "";

  useEffect(() => {
    if (!store || !sessionKey || !facade) return;
    store.registerV2(sessionKey, owner, facade);
    return () => store.unregisterV2(sessionKey, owner);
  }, [facade, owner, sessionKey, store]);

  useEffect(() => {
    if (!store || !sessionKey || !facade) return;
    store.updateV2(sessionKey, owner, facade);
  }, [
    facade,
    owner,
    sessionApplyBlockReason,
    sessionApplying,
    sessionDirty,
    sessionDirtyLabelsKey,
    sessionInvalidKey,
    sessionKey,
    sessionLockReason,
    sessionMode,
    sessionNodeTitle,
    sessionValid,
    store,
  ]);
}

export interface UseInspectorEditSessionV2Options<
  TDraft extends Record<string, unknown>,
> {
  selectionKey: string;
  specId: string;
  modeTabId?: string | null;
  nodeTitle?: string;
  mode: InspectorEditSessionModeV2;
  baseline: TDraft;
  fieldLabels?: Partial<Record<keyof TDraft & string, string>>;
  validate?: (
    draft: TDraft,
  ) => ReadonlyMap<string, string> | Record<string, string | null | undefined>;
  serverFieldErrors?: Partial<Record<keyof TDraft & string, string | null | undefined>>;
  hasLiveOverrides?: (draft: TDraft, baseline: TDraft) => boolean;
  lockReason?: string | null;
  applyBlockReason?: string | null;
  onApply?: (draft: TDraft, baseline: TDraft) => Promise<boolean> | boolean;
  onRevert?: (baseline: TDraft) => Promise<void> | void;
  onFocusField?: (fieldKey: string) => void;
  historyMode?: "bridge" | "mutation-owned";
}

export interface InspectorEditSessionV2Controller<
  TDraft extends Record<string, unknown>,
> {
  readonly sessionKey: string;
  readonly animationKey: string;
  readonly status: InspectorEditSessionStatusV2;
  readonly draft: TDraft;
  readonly baseline: TDraft;
  readonly dirty: boolean;
  readonly applying: boolean;
  readonly appliedFlash: boolean;
  readonly dirtyFields: ReadonlySet<string>;
  readonly dirtyFieldLabels: readonly string[];
  readonly touchedFields: ReadonlySet<string>;
  readonly invalidFields: ReadonlyMap<string, string>;
  readonly valid: boolean;
  setField: <K extends keyof TDraft & string>(key: K, value: TDraft[K]) => void;
  patchDraft: (partial: Partial<TDraft>) => void;
  markTouched: (key: keyof TDraft & string) => void;
  revertField: (key: keyof TDraft & string) => void;
  revertAll: () => Promise<void>;
  apply: () => Promise<boolean>;
  focusField: (key: keyof TDraft & string) => void;
  session: InspectorEditSessionV2;
}

interface InternalV2State<TDraft extends Record<string, unknown>> {
  targetKey: string;
  baseline: TDraft;
  draft: TDraft;
  dirtyFields: ReadonlySet<string>;
  touchedFields: ReadonlySet<string>;
  applying: boolean;
  appliedFlash: boolean;
  rejected: boolean;
  stagedTabId: string | null;
}

const APPLIED_FLASH_DURATION_MS = 3000;

export function useInspectorEditSessionV2Controller<
  TDraft extends Record<string, unknown>,
>(
  options: UseInspectorEditSessionV2Options<TDraft>,
): InspectorEditSessionV2Controller<TDraft> {
  const {
    applyBlockReason = null,
    baseline,
    fieldLabels,
    hasLiveOverrides,
    historyMode = "mutation-owned",
    lockReason = null,
    mode,
    modeTabId,
    nodeTitle,
    onApply,
    onFocusField,
    onRevert,
    selectionKey,
    serverFieldErrors,
    specId,
    validate,
  } = options;

  const store = useContext(InspectorEditSessionContext);
  const kernel = useContext(KernelContext);
  const targetKey = `${selectionKey}::${specId}`;
  const activeTabKey = modeTabId ?? "default";
  const activeSessionKey = formatInspectorSessionKey(
    selectionKey,
    specId,
    activeTabKey,
  );

  const [state, setState] = useState<InternalV2State<TDraft>>(() => ({
    appliedFlash: false,
    applying: false,
    baseline,
    dirtyFields: EMPTY_STRING_SET,
    draft: baseline,
    rejected: false,
    stagedTabId: mode === "staged" ? activeTabKey : null,
    targetKey,
    touchedFields: EMPTY_STRING_SET,
  }));

  // Render-phase target reset or lossless incoming revision rebase (Review Focus #2).
  let effectiveState = state;
  if (state.targetKey !== targetKey) {
    effectiveState = {
      appliedFlash: false,
      applying: false,
      baseline,
      dirtyFields: EMPTY_STRING_SET,
      draft: baseline,
      rejected: false,
      stagedTabId: mode === "staged" ? activeTabKey : null,
      targetKey,
      touchedFields: EMPTY_STRING_SET,
    };
    setState(effectiveState);
  } else if (!areDraftObjectsShallowEqual(baseline, state.baseline)) {
    const nextDraft = rebaseInspectorDraft(
      state.draft,
      baseline,
      state.dirtyFields,
    );
    const nextDirty = new Set<string>();
    for (const key of state.dirtyFields) {
      if (!areInspectorFieldValuesEqual(nextDraft[key], baseline[key])) {
        nextDirty.add(key);
      }
    }
    effectiveState = {
      ...state,
      baseline,
      dirtyFields: nextDirty.size > 0 ? nextDirty : EMPTY_STRING_SET,
      draft: nextDraft,
    };
    setState(effectiveState);
  } else if (mode === "staged" && state.stagedTabId !== activeTabKey) {
    effectiveState = {
      ...state,
      stagedTabId: activeTabKey,
    };
    setState(effectiveState);
  }

  const invalidFields = useMemo<ReadonlyMap<string, string>>(() => {
    const merged = new Map<string, string>();
    if (validate) {
      const validationOutput = validate(effectiveState.draft);
      if (validationOutput instanceof Map) {
        for (const [key, msg] of validationOutput.entries()) {
          if (msg) merged.set(key, msg);
        }
      } else {
        for (const [key, msg] of Object.entries(validationOutput)) {
          if (msg) merged.set(key, msg);
        }
      }
    }
    if (serverFieldErrors) {
      for (const [key, msg] of Object.entries(serverFieldErrors)) {
        if (msg) merged.set(key, msg);
      }
    }
    return merged.size > 0 ? merged : EMPTY_ERROR_MAP;
  }, [effectiveState.draft, serverFieldErrors, validate]);

  const dirtyFieldLabels = useMemo<readonly string[]>(() => {
    if (effectiveState.dirtyFields.size === 0) return [];
    return Array.from(effectiveState.dirtyFields, (key) => fieldLabels?.[key] ?? key);
  }, [effectiveState.dirtyFields, fieldLabels]);

  const stagedDirty = effectiveState.dirtyFields.size > 0;
  const liveOverridden =
    mode === "liveViewport"
      ? (hasLiveOverrides?.(effectiveState.draft, effectiveState.baseline) ?? stagedDirty)
      : false;
  const dirty = mode === "liveViewport" ? liveOverridden : stagedDirty;
  const valid = invalidFields.size === 0;

  const status: InspectorEditSessionStatusV2 = useMemo(() => {
    if (mode === "readOnly") return "ReadOnlyIdle";
    if (mode === "liveViewport") {
      return liveOverridden ? "LiveOverridden" : "LiveClean";
    }
    if (mode === "immediate") {
      return effectiveState.applying ? "ImmediateRunning" : "ImmediateReady";
    }
    if (effectiveState.applying) return "Applying";
    if (effectiveState.rejected && stagedDirty) return "ApplyRejected";
    if (!stagedDirty) {
      return effectiveState.appliedFlash ? "AppliedFlash" : "StagedClean";
    }
    return valid ? "DirtyValid" : "DirtyInvalid";
  }, [
    effectiveState.appliedFlash,
    effectiveState.applying,
    effectiveState.rejected,
    liveOverridden,
    mode,
    stagedDirty,
    valid,
  ]);

  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) {
        clearTimeout(flashTimerRef.current);
      }
    };
  }, []);

  const stagedSessionKey = formatInspectorSessionKey(
    selectionKey,
    specId,
    effectiveState.stagedTabId ?? activeTabKey,
  );

  const runtimeRef = useRef({
    applyBlockReason,
    applying: effectiveState.applying,
    baseline: effectiveState.baseline,
    dirty,
    dirtyFieldLabels,
    dirtyFields: effectiveState.dirtyFields,
    draft: effectiveState.draft,
    historyMode,
    invalidFields,
    lockReason,
    mode,
    nodeTitle,
    onApply,
    onFocusField,
    onRevert,
    stagedDirty,
    stagedSessionKey,
    valid,
  });

  useLayoutEffect(() => {
    runtimeRef.current = {
      applyBlockReason,
      applying: effectiveState.applying,
      baseline: effectiveState.baseline,
      dirty,
      dirtyFieldLabels,
      dirtyFields: effectiveState.dirtyFields,
      draft: effectiveState.draft,
      historyMode,
      invalidFields,
      lockReason,
      mode,
      nodeTitle,
      onApply,
      onFocusField,
      onRevert,
      stagedDirty,
      stagedSessionKey,
      valid,
    };
  });

  const stagedOwner = useMemo(() => Symbol("inspector-v2-staged-owner"), []);
  const auxOwner = useMemo(() => Symbol("inspector-v2-aux-owner"), []);

  const setField = useCallback(
    <K extends keyof TDraft & string>(key: K, value: TDraft[K]) => {
      setState((prev) => {
        if (areInspectorFieldValuesEqual(prev.draft[key], value)) {
          return prev;
        }
        const nextDraft = { ...prev.draft, [key]: value };
        const nextDirty = new Set(prev.dirtyFields);
        if (areInspectorFieldValuesEqual(value, prev.baseline[key])) {
          nextDirty.delete(key);
        } else {
          nextDirty.add(key);
        }
        const dirtySet = nextDirty.size > 0 ? nextDirty : EMPTY_STRING_SET;
        runtimeRef.current.draft = nextDraft;
        runtimeRef.current.dirtyFields = dirtySet;
        runtimeRef.current.stagedDirty = dirtySet.size > 0;
        runtimeRef.current.dirty = dirtySet.size > 0;
        return {
          ...prev,
          appliedFlash: false,
          dirtyFields: dirtySet,
          draft: nextDraft,
          rejected: false,
        };
      });
    },
    [],
  );

  const patchDraft = useCallback((partial: Partial<TDraft>) => {
    setState((prev) => {
      const nextDraft = { ...prev.draft, ...partial };
      const nextDirty = new Set(prev.dirtyFields);
      for (const key of Object.keys(partial)) {
        if (areInspectorFieldValuesEqual(nextDraft[key], prev.baseline[key])) {
          nextDirty.delete(key);
        } else {
          nextDirty.add(key);
        }
      }
      const dirtySet = nextDirty.size > 0 ? nextDirty : EMPTY_STRING_SET;
      runtimeRef.current.draft = nextDraft;
      runtimeRef.current.dirtyFields = dirtySet;
      runtimeRef.current.stagedDirty = dirtySet.size > 0;
      runtimeRef.current.dirty = dirtySet.size > 0;
      return {
        ...prev,
        appliedFlash: false,
        dirtyFields: dirtySet,
        draft: nextDraft,
        rejected: false,
      };
    });
  }, []);

  const markTouched = useCallback((key: keyof TDraft & string) => {
    setState((prev) => {
      if (prev.touchedFields.has(key)) return prev;
      const nextTouched = new Set(prev.touchedFields);
      nextTouched.add(key);
      return { ...prev, touchedFields: nextTouched };
    });
  }, []);

  const revertField = useCallback((fieldKey: keyof TDraft & string) => {
    setState((prev) => {
      if (!prev.dirtyFields.has(fieldKey)) return prev;
      const nextDraft = { ...prev.draft, [fieldKey]: prev.baseline[fieldKey] };
      const nextDirty = new Set(prev.dirtyFields);
      nextDirty.delete(fieldKey);
      const nextTouched = new Set(prev.touchedFields);
      nextTouched.delete(fieldKey);
      const dirtySet = nextDirty.size > 0 ? nextDirty : EMPTY_STRING_SET;
      runtimeRef.current.draft = nextDraft;
      runtimeRef.current.dirtyFields = dirtySet;
      runtimeRef.current.stagedDirty = dirtySet.size > 0;
      runtimeRef.current.dirty = dirtySet.size > 0;
      return {
        ...prev,
        dirtyFields: dirtySet,
        draft: nextDraft,
        rejected: false,
        touchedFields: nextTouched.size > 0 ? nextTouched : EMPTY_STRING_SET,
      };
    });
  }, []);

  const revertAll = useCallback(async () => {
    const snap = runtimeRef.current;
    runtimeRef.current.draft = snap.baseline;
    runtimeRef.current.dirtyFields = EMPTY_STRING_SET;
    runtimeRef.current.dirtyFieldLabels = [];
    runtimeRef.current.stagedDirty = false;
    runtimeRef.current.dirty = false;
    setState((prev) => ({
      ...prev,
      appliedFlash: false,
      dirtyFields: EMPTY_STRING_SET,
      draft: prev.baseline,
      rejected: false,
      touchedFields: EMPTY_STRING_SET,
    }));
    await snap.onRevert?.(snap.baseline);
  }, []);

  const apply = useCallback(async (): Promise<boolean> => {
    const snap = runtimeRef.current;
    if (
      snap.applying ||
      snap.lockReason ||
      snap.applyBlockReason ||
      !snap.valid ||
      !snap.onApply
    ) {
      return false;
    }
    const sessionScopeKey = kernel?.commands.getSessionScopeKey?.() ?? null;
    const historyGeneration = kernel?.authoringHistory?.getGeneration?.();
    const isCurrentSession = () =>
      (kernel?.commands.getSessionScopeKey?.() ?? null) === sessionScopeKey;
    const isCurrentHistoryGeneration = () =>
      historyGeneration === undefined ||
      kernel?.authoringHistory?.getGeneration?.() === historyGeneration;

    if (!isCurrentSession() || !isCurrentHistoryGeneration()) {
      return false;
    }

    const submittedDraft = snap.draft;
    const submittedBaseline = snap.baseline;
    runtimeRef.current.applying = true;
    setState((prev) => ({ ...prev, appliedFlash: false, applying: true, rejected: false }));

    try {
      let applied = false;
      if (snap.historyMode === "bridge") {
        const requestOptions: RequestOptions | undefined = sessionScopeKey
          ? { sessionScopeKey }
          : undefined;
        applied = await applyInspectorSessionWithHistory(
          {
            apply: () => snap.onApply!(submittedDraft, submittedBaseline),
            applying: true,
            dirty: true,
            mode: "staged",
            reset: () => undefined,
            valid: true,
          },
          kernel
            ? {
                model: {
                  scene: (reqOpts) => kernel.api.model.scene(reqOpts),
                },
              }
            : null,
          kernel?.authoringHistory ?? null,
          "Inspector changes",
          {
            isCurrent: isCurrentSession,
            isHistoryGenerationCurrent: isCurrentHistoryGeneration,
            requestOptions,
          },
        );
      } else {
        applied =
          (await snap.onApply(submittedDraft, submittedBaseline)) === true &&
          isCurrentSession() &&
          isCurrentHistoryGeneration();
      }

      if (!applied) {
        runtimeRef.current.applying = false;
        setState((prev) => ({ ...prev, applying: false, rejected: true }));
        return false;
      }

      // Preserve any concurrent edits made while the write was in flight.
      runtimeRef.current.applying = false;
      setState((prev) => {
        const nextDirty = new Set<string>();
        for (const key of Object.keys(prev.draft)) {
          if (!areInspectorFieldValuesEqual(prev.draft[key], submittedDraft[key])) {
            nextDirty.add(key);
          }
        }
        const dirtySet = nextDirty.size > 0 ? nextDirty : EMPTY_STRING_SET;
        runtimeRef.current.baseline = submittedDraft;
        runtimeRef.current.dirtyFields = dirtySet;
        runtimeRef.current.stagedDirty = dirtySet.size > 0;
        runtimeRef.current.dirty = dirtySet.size > 0;
        return {
          ...prev,
          appliedFlash: dirtySet.size === 0,
          applying: false,
          baseline: submittedDraft,
          dirtyFields: dirtySet,
          rejected: false,
          touchedFields: EMPTY_STRING_SET,
        };
      });

      if (flashTimerRef.current !== null) {
        clearTimeout(flashTimerRef.current);
      }
      flashTimerRef.current = setTimeout(() => {
        setState((prev) =>
          prev.appliedFlash ? { ...prev, appliedFlash: false } : prev,
        );
      }, APPLIED_FLASH_DURATION_MS);

      return true;
    } catch {
      runtimeRef.current.applying = false;
      setState((prev) => ({ ...prev, applying: false, rejected: true }));
      return false;
    }
  }, [kernel]);

  const focusField = useCallback((fieldKey: keyof TDraft & string) => {
    runtimeRef.current.onFocusField?.(fieldKey);
  }, []);

  const stagedFacade = useMemo<InspectorEditSessionV2>(
    () => ({
      apply: () => apply(),
      get applyBlockReason() {
        return runtimeRef.current.applyBlockReason;
      },
      get applying() {
        return runtimeRef.current.applying;
      },
      get dirty() {
        return runtimeRef.current.stagedDirty;
      },
      get dirtyFieldLabels() {
        return runtimeRef.current.dirtyFieldLabels;
      },
      get dirtyFields() {
        return runtimeRef.current.dirtyFields;
      },
      focusField: (key: string) => focusField(key),
      get invalidFields() {
        return runtimeRef.current.invalidFields;
      },
      get lockReason() {
        return runtimeRef.current.lockReason;
      },
      mode: "staged",
      get nodeTitle() {
        return runtimeRef.current.nodeTitle;
      },
      revertAll: () => revertAll(),
      revertField: (key: string) => revertField(key),
      sessionKey: stagedSessionKey,
      get valid() {
        return runtimeRef.current.valid;
      },
    }),
    [apply, focusField, revertAll, revertField, stagedSessionKey],
  );

  const activeFacade = useMemo<InspectorEditSessionV2>(
    () =>
      mode === "staged"
        ? stagedFacade
        : {
            apply: async () => false,
            get applyBlockReason() {
              return runtimeRef.current.applyBlockReason;
            },
            get applying() {
              return runtimeRef.current.applying;
            },
            get dirty() {
              return runtimeRef.current.dirty;
            },
            dirtyFieldLabels: [],
            dirtyFields: EMPTY_STRING_SET,
            focusField: (key: string) => focusField(key),
            invalidFields: EMPTY_ERROR_MAP,
            get lockReason() {
              return runtimeRef.current.lockReason;
            },
            mode,
            get nodeTitle() {
              return runtimeRef.current.nodeTitle;
            },
            revertAll: () => revertAll(),
            revertField: (key: string) => revertField(key),
            sessionKey: activeSessionKey,
            valid: true,
          },
    [activeSessionKey, focusField, mode, revertAll, revertField, stagedFacade],
  );

  const shouldHoldStagedSession = mode === "staged" || stagedDirty;

  const dirtyFieldLabelsKey = dirtyFieldLabels.join("\u0000");
  const invalidFieldsKey = Array.from(invalidFields.entries())
    .map(([k, v]) => `${k}:${v}`)
    .join("\u0000");
  const dirtyFieldsKey = Array.from(effectiveState.dirtyFields).join("\u0000");

  useEffect(() => {
    if (!store || !shouldHoldStagedSession) return;
    store.registerV2(stagedSessionKey, stagedOwner, stagedFacade);
    return () => store.unregisterV2(stagedSessionKey, stagedOwner);
  }, [shouldHoldStagedSession, stagedFacade, stagedOwner, stagedSessionKey, store]);

  useEffect(() => {
    if (!store || !shouldHoldStagedSession) return;
    store.updateV2(stagedSessionKey, stagedOwner, stagedFacade);
  }, [
    applyBlockReason,
    dirtyFieldLabelsKey,
    dirtyFieldsKey,
    effectiveState.applying,
    invalidFieldsKey,
    lockReason,
    nodeTitle,
    shouldHoldStagedSession,
    stagedDirty,
    stagedFacade,
    stagedOwner,
    stagedSessionKey,
    store,
    valid,
  ]);

  useEffect(() => {
    if (!store || mode === "staged") return;
    store.registerV2(activeSessionKey, auxOwner, activeFacade);
    return () => store.unregisterV2(activeSessionKey, auxOwner);
  }, [activeFacade, activeSessionKey, auxOwner, mode, store]);

  useEffect(() => {
    if (!store || mode === "staged") return;
    store.updateV2(activeSessionKey, auxOwner, activeFacade);
  }, [activeFacade, activeSessionKey, auxOwner, dirty, mode, store]);

  return {
    animationKey: `${selectionKey}:${activeTabKey}`,
    appliedFlash: effectiveState.appliedFlash,
    apply,
    applying: effectiveState.applying,
    baseline: effectiveState.baseline,
    dirty,
    dirtyFieldLabels,
    dirtyFields: effectiveState.dirtyFields,
    draft: effectiveState.draft,
    focusField,
    invalidFields,
    markTouched,
    patchDraft,
    revertAll,
    revertField,
    session: activeFacade,
    sessionKey: activeSessionKey,
    setField,
    status,
    touchedFields: effectiveState.touchedFields,
    valid,
  };
}

export function useRegisterInspectorEditSession(
  mode: InspectorEditMode | null,
  applying: boolean,
  dirty: boolean,
  valid: boolean,
  lockReason: string | undefined,
  apply: () => Promise<boolean> | boolean,
  reset: () => Promise<void> | void,
  options: {
    applyBlockReason?: string;
    historyMode?: "bridge" | "mutation-owned";
  } = {},
): () => boolean {
  const historyMode = options.historyMode ?? "bridge";
  const applyBlockReason = options.applyBlockReason;
  const store = useContext(InspectorEditSessionContext);
  const kernel = useContext(KernelContext);
  const applyRef = useRef(apply);
  const resetRef = useRef(reset);
  const sessionRef = useRef<InspectorEditSession | null>(
    mode
      ? {
          apply: () => applyRef.current(),
          applyBlockReason,
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
          applyBlockReason,
          applying,
          dirty,
          lockReason,
          mode,
          reset: () => resetRef.current(),
          valid,
        }
      : null;
  }, [apply, applyBlockReason, applying, dirty, lockReason, mode, reset, valid]);
  const owner = useMemo(() => Symbol("inspector-edit-session"), []);
  const applyWithHistory = useCallback(async () => {
    const sessionScopeKey = kernel?.commands.getSessionScopeKey?.() ?? null;
    const historyGeneration = kernel?.authoringHistory?.getGeneration?.();
    const isCurrentSession = () =>
      (kernel?.commands.getSessionScopeKey?.() ?? null) === sessionScopeKey;
    const isCurrentHistoryGeneration = () =>
      historyGeneration === undefined ||
      kernel?.authoringHistory?.getGeneration?.() === historyGeneration;
    const currentSession = sessionRef.current;
    if (!currentSession || !isCurrentSession() || !isCurrentHistoryGeneration()) {
      return false;
    }

    if (historyMode === "mutation-owned") {
      const applied = (await currentSession.apply()) === true;
      return applied && isCurrentSession() && isCurrentHistoryGeneration();
    }

    const requestOptions: RequestOptions | undefined = sessionScopeKey
      ? { sessionScopeKey }
      : undefined;
    return applyInspectorSessionWithHistory(
      currentSession,
      kernel
        ? {
            model: {
              scene: (reqOpts) => kernel.api.model.scene(reqOpts),
            },
          }
        : null,
      kernel?.authoringHistory ?? null,
      "Inspector changes",
      {
        isCurrent: isCurrentSession,
        isHistoryGenerationCurrent: isCurrentHistoryGeneration,
        requestOptions,
      },
    );
  }, [historyMode, kernel]);
  const facade = useMemo<InspectorEditSession>(
    () => ({
      apply: () => applyWithHistory(),
      get applyBlockReason() {
        return sessionRef.current?.applyBlockReason;
      },
      get applying() {
        return sessionRef.current?.applying ?? false;
      },
      get dirty() {
        return sessionRef.current?.dirty ?? false;
      },
      get lockReason() {
        return sessionRef.current?.lockReason;
      },
      get mode() {
        return sessionRef.current?.mode ?? "immediate";
      },
      reset: () => sessionRef.current?.reset(),
      get valid() {
        return sessionRef.current?.valid ?? true;
      },
    }),
    [applyWithHistory],
  );

  useEffect(() => {
    if (!store) return;
    store.register(owner, sessionRef.current ? facade : null);
    return () => store.unregister(owner);
  }, [facade, owner, store]);

  useEffect(() => {
    if (!store) return;
    store.update(owner, sessionRef.current ? facade : null);
  }, [applying, applyBlockReason, dirty, facade, lockReason, mode, owner, store, valid]);

  // Call only after this form's write has been acknowledged. Selection guards
  // read the facade synchronously, before React can publish the next render.
  // A late ACK must not clear a newer form's draft or change its selection.
  return useCallback(() => {
    if (!sessionRef.current || (store && store.getCurrentSession() !== facade)) {
      return false;
    }
    sessionRef.current = { ...sessionRef.current, dirty: false };
    store?.update(owner, facade);
    return true;
  }, [facade, owner, store]);
}
