"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  formatInspectorSessionKey,
  useRegisterInspectorEditSessionV2,
  type InspectorEditSessionV2,
} from "../InspectorEditSession";
import { evaluateInspectorRowError } from "./PropertyRow";
import type { CommitBarSpec, InspectorSpec } from "./types";
import { inspectorValuesEqual } from "./unitConversion";

export type InspectorSessionPhase =
  | "readOnlyIdle"
  | "liveClean"
  | "liveOverridden"
  | "immediateReady"
  | "stagedClean"
  | "dirtyValid"
  | "dirtyInvalid"
  | "confirmCostly"
  | "applying"
  | "appliedFlash"
  | "applyRejected";

export interface InspectorConfirmApplyState {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
}

export interface UseInspectorSpecControllerOptions<TDraft> {
  initialModeTabId?: string;
  onApplied?: (draft: TDraft) => void;
  onLiveFieldChange?: <K extends keyof TDraft & string>(key: K, value: TDraft[K]) => void;
  appliedFlashMs?: number;
}

export interface InspectorSpecController<TDraft> {
  readonly sessionKey: string;
  readonly animationKey: string;
  readonly effectiveCommitMode: CommitBarSpec<TDraft>["mode"];
  readonly phase: InspectorSessionPhase;
  readonly draft: TDraft;
  readonly baseline: TDraft;
  readonly dirty: boolean;
  readonly dirtyFields: ReadonlySet<string>;
  readonly dirtyFieldLabels: readonly string[];
  readonly invalidFields: ReadonlyMap<string, string>;
  readonly valid: boolean;
  readonly touchedFields: ReadonlySet<string>;
  readonly forceShowErrors: boolean;
  readonly applying: boolean;
  readonly appliedFlash: boolean;
  readonly applyError: string | null;
  readonly lockReason: string | null;
  readonly pendingConfirm: InspectorConfirmApplyState | null;
  readonly activeModeTabId: string | undefined;
  readonly displayUnits: Readonly<Record<string, string>>;
  readonly focusRequest: { key: keyof TDraft & string; seq: number } | null;
  setActiveModeTabId: (tabId: string) => void;
  setDisplayUnit: (fieldKey: string, unit: string) => void;
  setField: <K extends keyof TDraft & string>(key: K, value: TDraft[K]) => void;
  patchDraft: (partial: Partial<TDraft>) => void;
  revertField: (fieldKey: string) => void;
  revertAll: () => void;
  touchField: (fieldKey: string) => void;
  setParseError: (fieldKey: string, error: string | null) => void;
  requestApply: () => Promise<boolean>;
  confirmPendingApply: () => Promise<boolean>;
  cancelPendingApply: () => void;
  resetDisplay: () => Promise<void>;
  focusField: (fieldKey: keyof TDraft & string) => void;
  clearFocusRequest: () => void;
}

const persistedModeTabsBySpecId = new Map<string, string>();
const persistedDisplayUnitsBySpecId = new Map<string, Record<string, string>>();

export function resetPersistedInspectorModeTabs(): void {
  persistedModeTabsBySpecId.clear();
  persistedDisplayUnitsBySpecId.clear();
}

function resolveSelectionTargetKey(selection: Selection): string {
  if (selection.nodeId) return selection.nodeId;
  const parts = [
    selection.kind,
    selection.objectId,
    selection.ref?.type,
    selection.label,
  ].filter(Boolean);
  return parts.join(":") || "empty";
}

interface ScopedEditState<TDraft> {
  targetKey: string;
  stagedOverrides: Partial<TDraft>;
  liveOverrides: Partial<TDraft>;
  committedBaseline: { forSourceBaseline: TDraft; value: TDraft } | null;
  touchedFields: Set<string>;
  parseErrors: Map<string, string>;
  forceShowErrors: boolean;
  applyError: string | null;
  appliedFlash: boolean;
  pendingConfirm: InspectorConfirmApplyState | null;
}

function createEmptyScopedState<TDraft>(targetKey: string): ScopedEditState<TDraft> {
  return {
    targetKey,
    stagedOverrides: {},
    liveOverrides: {},
    committedBaseline: null,
    touchedFields: new Set(),
    parseErrors: new Map(),
    forceShowErrors: false,
    applyError: null,
    appliedFlash: false,
    pendingConfirm: null,
  };
}

/**
 * Central state-machine controller for any `InspectorSpec<TDraft>` view.
 *
 * - Keeps dirty staged overrides isolated from incoming `baseline` revisions so
 *   clean fields rebase in-place without unmounting DOM nodes or dropping focus/scroll.
 * - Keeps `animationKey` bound exclusively to `${selectionTargetKey}:${activeModeTabId}`
 *   (never to scene revision).
 * - Keeps live-section edits and display-unit switches out of `dirtyFields`.
 */
export function useInspectorSpecController<TDraft extends object>(
  spec: InspectorSpec<TDraft>,
  selection: Selection,
  baseline: TDraft,
  serverFieldErrors?: Readonly<Record<string, string | null | undefined>>,
  options?: UseInspectorSpecControllerOptions<TDraft>,
): InspectorSpecController<TDraft> {
  const selectionTargetKey = resolveSelectionTargetKey(selection);
  const targetKey = `${selectionTargetKey}::${spec.id}`;
  const appliedFlashMs = options?.appliedFlashMs ?? 3000;

  const [scopedState, setScopedState] = useState<ScopedEditState<TDraft>>(() =>
    createEmptyScopedState(targetKey),
  );
  const activeScoped =
    scopedState.targetKey === targetKey ? scopedState : createEmptyScopedState<TDraft>(targetKey);

  const [applying, setApplying] = useState(false);
  const [focusRequest, setFocusRequest] = useState<{
    key: keyof TDraft & string;
    seq: number;
  } | null>(null);
  const appliedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const validModeTabIds = useMemo(
    () => new Set((spec.modeTabs ?? []).map((tab) => tab.id)),
    [spec.modeTabs],
  );

  const resolveDefaultTabId = useCallback((): string | undefined => {
    const tabs = spec.modeTabs;
    if (!tabs || tabs.length === 0) return undefined;
    const initial = options?.initialModeTabId;
    if (initial && validModeTabIds.has(initial)) return initial;
    const persisted = persistedModeTabsBySpecId.get(spec.id);
    if (persisted && validModeTabIds.has(persisted)) return persisted;
    return tabs[0]?.id;
  }, [options?.initialModeTabId, spec.id, spec.modeTabs, validModeTabIds]);

  const [modeTabState, setModeTabState] = useState<{
    specId: string;
    tabId: string | undefined;
  }>(() => ({ specId: spec.id, tabId: resolveDefaultTabId() }));

  const activeModeTabId =
    modeTabState.specId === spec.id &&
    modeTabState.tabId &&
    validModeTabIds.has(modeTabState.tabId)
      ? modeTabState.tabId
      : resolveDefaultTabId();

  const [displayUnitsBySpec, setDisplayUnitsBySpec] = useState<{
    specId: string;
    units: Record<string, string>;
  }>(() => ({
    specId: spec.id,
    units: { ...(persistedDisplayUnitsBySpecId.get(spec.id) ?? {}) },
  }));

  const displayUnits =
    displayUnitsBySpec.specId === spec.id
      ? displayUnitsBySpec.units
      : (persistedDisplayUnitsBySpecId.get(spec.id) ?? {});

  const updateScoped = useCallback(
    (updater: (prev: ScopedEditState<TDraft>) => ScopedEditState<TDraft>) => {
      setScopedState((prev) => {
        const base =
          prev.targetKey === targetKey ? prev : createEmptyScopedState<TDraft>(targetKey);
        return updater(base);
      });
    },
    [targetKey],
  );

  const clearAppliedTimer = useCallback(() => {
    if (appliedTimerRef.current !== null) {
      clearTimeout(appliedTimerRef.current);
      appliedTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearAppliedTimer(), [clearAppliedTimer]);

  const effectiveBaseline: TDraft =
    activeScoped.committedBaseline &&
    activeScoped.committedBaseline.forSourceBaseline === baseline
      ? activeScoped.committedBaseline.value
      : baseline;

  const liveFieldKeys = useMemo(() => {
    const keys = new Set<string>();
    if (spec.commitBar.mode !== "staged") return keys;
    for (const section of spec.sections) {
      if (!section.live) continue;
      for (const row of section.rows) {
        if (row.key) keys.add(row.key);
      }
    }
    return keys;
  }, [spec.commitBar.mode, spec.sections]);

  // Rebase clean fields from incoming baseline while preserving dirty staged overrides.
  const draft = useMemo<TDraft>(() => {
    const merged = {
      ...effectiveBaseline,
      ...activeScoped.liveOverrides,
      ...activeScoped.stagedOverrides,
    };
    return merged;
  }, [effectiveBaseline, activeScoped.liveOverrides, activeScoped.stagedOverrides]);

  const dirtyFields = useMemo<ReadonlySet<string>>(() => {
    const next = new Set<string>();
    if (spec.commitBar.mode !== "staged") return next;
    const baseRecord = effectiveBaseline as Record<string, unknown>;
    const overrideEntries = Object.entries(activeScoped.stagedOverrides as Record<string, unknown>);
    for (const [key, value] of overrideEntries) {
      if (liveFieldKeys.has(key)) continue;
      if (!inspectorValuesEqual(value, baseRecord[key])) {
        next.add(key);
      }
    }
    return next;
  }, [activeScoped.stagedOverrides, effectiveBaseline, liveFieldKeys, spec.commitBar.mode]);

  const fieldLabelLookup = useMemo(() => {
    const map = new Map<string, string>();
    if (spec.identity.renameFieldKey) {
      map.set(spec.identity.renameFieldKey, "Name");
    }
    for (const section of spec.sections) {
      for (const row of section.rows) {
        if (row.key && row.label) {
          map.set(row.key, row.label);
        }
      }
    }
    return map;
  }, [spec.identity.renameFieldKey, spec.sections]);

  const dirtyFieldLabels = useMemo<readonly string[]>(() => {
    return Array.from(dirtyFields).map((key) => fieldLabelLookup.get(key) ?? key);
  }, [dirtyFields, fieldLabelLookup]);

  const invalidFields = useMemo<ReadonlyMap<string, string>>(() => {
    const errors = new Map<string, string>();
    for (const section of spec.sections) {
      if (section.showWhen && !section.showWhen(draft)) continue;
      for (const row of section.rows) {
        if (!row.key) continue;
        if (row.showWhen && !row.showWhen(draft)) continue;
        const parseErr = activeScoped.parseErrors.get(row.key) ?? null;
        const serverErr = serverFieldErrors?.[row.key] ?? null;
        const resolved = parseErr ?? evaluateInspectorRowError(row, draft, serverErr);
        if (resolved) {
          errors.set(row.key, resolved);
        }
      }
    }
    return errors;
  }, [activeScoped.parseErrors, draft, serverFieldErrors, spec.sections]);

  const activeTab = useMemo(
    () => (spec.modeTabs ?? []).find((tab) => tab.id === activeModeTabId),
    [activeModeTabId, spec.modeTabs],
  );
  const effectiveCommitMode: CommitBarSpec<TDraft>["mode"] =
    activeTab?.commitModeOverride ?? spec.commitBar.mode;

  const lockReason =
    spec.commitBar.mode === "staged" ? (spec.commitBar.lockReason?.(draft) ?? null) : null;

  const setActiveModeTabId = useCallback(
    (tabId: string) => {
      if (!validModeTabIds.has(tabId)) return;
      persistedModeTabsBySpecId.set(spec.id, tabId);
      setModeTabState({ specId: spec.id, tabId });
    },
    [spec.id, validModeTabIds],
  );

  const setDisplayUnit = useCallback(
    (fieldKey: string, unit: string) => {
      setDisplayUnitsBySpec((prev) => {
        const base =
          prev.specId === spec.id
            ? prev.units
            : (persistedDisplayUnitsBySpecId.get(spec.id) ?? {});
        const nextUnits = { ...base, [fieldKey]: unit };
        persistedDisplayUnitsBySpecId.set(spec.id, nextUnits);
        return { specId: spec.id, units: nextUnits };
      });
    },
    [spec.id],
  );

  const setField = useCallback(
    <K extends keyof TDraft & string>(key: K, value: TDraft[K]) => {
      clearAppliedTimer();
      if (liveFieldKeys.has(key)) {
        updateScoped((prev) => ({
          ...prev,
          liveOverrides: { ...prev.liveOverrides, [key]: value },
        }));
        options?.onLiveFieldChange?.(key, value);
        return;
      }

      const baseRecord = effectiveBaseline as Record<string, unknown>;
      updateScoped((prev) => {
        const nextOverrides = { ...prev.stagedOverrides } as Record<string, unknown>;
        if (inspectorValuesEqual(value, baseRecord[key])) {
          delete nextOverrides[key];
        } else {
          nextOverrides[key] = value;
        }
        return {
          ...prev,
          stagedOverrides: nextOverrides as Partial<TDraft>,
          appliedFlash: false,
          applyError: null,
        };
      });
    },
    [clearAppliedTimer, effectiveBaseline, liveFieldKeys, options, updateScoped],
  );

  const patchDraft = useCallback(
    (partial: Partial<TDraft>) => {
      clearAppliedTimer();
      const baseRecord = effectiveBaseline as Record<string, unknown>;
      updateScoped((prev) => {
        const nextStaged = { ...prev.stagedOverrides } as Record<string, unknown>;
        const nextLive = { ...prev.liveOverrides } as Record<string, unknown>;
        for (const [key, value] of Object.entries(partial as Record<string, unknown>)) {
          if (liveFieldKeys.has(key)) {
            nextLive[key] = value;
          } else if (inspectorValuesEqual(value, baseRecord[key])) {
            delete nextStaged[key];
          } else {
            nextStaged[key] = value;
          }
        }
        return {
          ...prev,
          stagedOverrides: nextStaged as Partial<TDraft>,
          liveOverrides: nextLive as Partial<TDraft>,
          appliedFlash: false,
          applyError: null,
        };
      });
    },
    [clearAppliedTimer, effectiveBaseline, liveFieldKeys, updateScoped],
  );

  const revertField = useCallback(
    (fieldKey: string) => {
      updateScoped((prev) => {
        const nextOverrides = { ...prev.stagedOverrides } as Record<string, unknown>;
        delete nextOverrides[fieldKey];
        const nextParseErrors = new Map(prev.parseErrors);
        nextParseErrors.delete(fieldKey);
        return {
          ...prev,
          stagedOverrides: nextOverrides as Partial<TDraft>,
          parseErrors: nextParseErrors,
          applyError: null,
        };
      });
    },
    [updateScoped],
  );

  const revertAll = useCallback(() => {
    clearAppliedTimer();
    updateScoped((prev) => ({
      ...prev,
      stagedOverrides: {},
      touchedFields: new Set(),
      parseErrors: new Map(),
      forceShowErrors: false,
      applyError: null,
      appliedFlash: false,
      pendingConfirm: null,
    }));
    if (spec.commitBar.mode === "staged") {
      spec.commitBar.onRevert?.(effectiveBaseline);
    }
  }, [clearAppliedTimer, effectiveBaseline, spec.commitBar, updateScoped]);

  const touchField = useCallback(
    (fieldKey: string) => {
      updateScoped((prev) => {
        if (prev.touchedFields.has(fieldKey)) return prev;
        const nextTouched = new Set(prev.touchedFields);
        nextTouched.add(fieldKey);
        return { ...prev, touchedFields: nextTouched };
      });
    },
    [updateScoped],
  );

  const setParseError = useCallback(
    (fieldKey: string, error: string | null) => {
      updateScoped((prev) => {
        const existing = prev.parseErrors.get(fieldKey) ?? null;
        if (existing === error) return prev;
        const nextParseErrors = new Map(prev.parseErrors);
        if (error) {
          nextParseErrors.set(fieldKey, error);
        } else {
          nextParseErrors.delete(fieldKey);
        }
        return { ...prev, parseErrors: nextParseErrors };
      });
    },
    [updateScoped],
  );

  const executeApply = useCallback(async (): Promise<boolean> => {
    if (spec.commitBar.mode !== "staged") return false;
    setApplying(true);
    updateScoped((prev) => ({
      ...prev,
      pendingConfirm: null,
      applyError: null,
    }));

    try {
      const ok = await spec.commitBar.onApply(draft, effectiveBaseline);
      if (ok) {
        updateScoped((prev) => ({
          ...prev,
          stagedOverrides: {},
          committedBaseline: { forSourceBaseline: baseline, value: draft },
          touchedFields: new Set(),
          parseErrors: new Map(),
          forceShowErrors: false,
          applyError: null,
          appliedFlash: true,
        }));
        clearAppliedTimer();
        appliedTimerRef.current = setTimeout(() => {
          appliedTimerRef.current = null;
          updateScoped((prev) => ({ ...prev, appliedFlash: false }));
        }, appliedFlashMs);
        options?.onApplied?.(draft);
        return true;
      }

      updateScoped((prev) => ({
        ...prev,
        forceShowErrors: true,
        applyError: "Changes could not be applied. Review highlighted fields.",
      }));
      return false;
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim()
          ? error.message.trim()
          : "Changes could not be applied.";
      updateScoped((prev) => ({
        ...prev,
        forceShowErrors: true,
        applyError: message,
      }));
      return false;
    } finally {
      setApplying(false);
    }
  }, [
    appliedFlashMs,
    baseline,
    clearAppliedTimer,
    draft,
    effectiveBaseline,
    options,
    spec.commitBar,
    updateScoped,
  ]);

  const canCleanApply =
    spec.commitBar.mode === "staged" &&
    Boolean(
      typeof spec.commitBar.allowCleanApply === "function"
        ? spec.commitBar.allowCleanApply(draft, effectiveBaseline)
        : spec.commitBar.allowCleanApply,
    );

  const requestApply = useCallback(async (): Promise<boolean> => {
    if (spec.commitBar.mode !== "staged") return false;
    if (applying || (!canCleanApply && dirtyFields.size === 0) || Boolean(lockReason)) {
      return false;
    }

    if (invalidFields.size > 0) {
      updateScoped((prev) => ({ ...prev, forceShowErrors: true }));
      return false;
    }

    const confirmSpec = spec.commitBar.confirmApply?.(draft, effectiveBaseline) ?? null;
    if (confirmSpec) {
      updateScoped((prev) => ({ ...prev, pendingConfirm: confirmSpec }));
      return false;
    }

    return executeApply();
  }, [
    applying,
    canCleanApply,
    dirtyFields.size,
    draft,
    effectiveBaseline,
    executeApply,
    invalidFields.size,
    lockReason,
    spec.commitBar,
    updateScoped,
  ]);

  const confirmPendingApply = useCallback(async (): Promise<boolean> => {
    return executeApply();
  }, [executeApply]);

  const cancelPendingApply = useCallback(() => {
    updateScoped((prev) => ({ ...prev, pendingConfirm: null }));
  }, [updateScoped]);

  const resetDisplay = useCallback(async (): Promise<void> => {
    if (spec.commitBar.mode !== "liveViewport") return;
    await spec.commitBar.onResetDisplay();
    updateScoped((prev) => ({ ...prev, liveOverrides: {}, stagedOverrides: {} }));
  }, [spec.commitBar, updateScoped]);

  const focusField = useCallback((fieldKey: keyof TDraft & string) => {
    setFocusRequest((prev) => ({ key: fieldKey, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

  const clearFocusRequest = useCallback(() => {
    setFocusRequest(null);
  }, []);

  const phase: InspectorSessionPhase = useMemo(() => {
    if (effectiveCommitMode === "readOnly") return "readOnlyIdle";
    if (effectiveCommitMode === "liveViewport") {
      const overridden =
        spec.commitBar.mode === "liveViewport"
          ? spec.commitBar.hasOverrides(draft, effectiveBaseline)
          : false;
      return overridden ? "liveOverridden" : "liveClean";
    }
    if (effectiveCommitMode === "immediate") return "immediateReady";
    if (applying) return "applying";
    if (activeScoped.pendingConfirm) return "confirmCostly";
    if (activeScoped.applyError) return "applyRejected";
    if (activeScoped.appliedFlash) return "appliedFlash";
    if (dirtyFields.size === 0) return "stagedClean";
    return invalidFields.size > 0 ? "dirtyInvalid" : "dirtyValid";
  }, [
    activeScoped.appliedFlash,
    activeScoped.applyError,
    activeScoped.pendingConfirm,
    applying,
    dirtyFields.size,
    draft,
    effectiveBaseline,
    effectiveCommitMode,
    invalidFields.size,
    spec.commitBar,
  ]);

  const sessionKey = formatInspectorSessionKey(
    selectionTargetKey,
    spec.id,
    activeModeTabId,
  );
  const animationKey = `${selectionTargetKey}:${activeModeTabId ?? "default"}`;

  const isStagedSpec = spec.commitBar.mode === "staged";
  const stagedTabId = useMemo(() => {
    if (effectiveCommitMode === "staged") return activeModeTabId ?? "default";
    const firstStaged = (spec.modeTabs ?? []).find(
      (tab) => (tab.commitModeOverride ?? spec.commitBar.mode) === "staged",
    );
    return firstStaged?.id ?? "default";
  }, [activeModeTabId, effectiveCommitMode, spec.commitBar.mode, spec.modeTabs]);

  const registeredSessionKey = isStagedSpec
    ? formatInspectorSessionKey(selectionTargetKey, spec.id, stagedTabId)
    : sessionKey;
  const nodeTitle = spec.identity.title(draft);
  const registeredSession = useMemo<InspectorEditSessionV2>(
    () => ({
      sessionKey: registeredSessionKey,
      nodeTitle,
      mode: isStagedSpec ? "staged" : effectiveCommitMode,
      applying,
      dirty: isStagedSpec ? dirtyFields.size > 0 : phase === "liveOverridden",
      dirtyFields,
      dirtyFieldLabels,
      invalidFields,
      valid: invalidFields.size === 0,
      lockReason,
      applyBlockReason: null,
      apply: isStagedSpec ? () => requestApply() : async () => false,
      revertAll:
        effectiveCommitMode === "liveViewport" && !isStagedSpec
          ? resetDisplay
          : revertAll,
      revertField,
      focusField: (fieldKey) => focusField(fieldKey as keyof TDraft & string),
    }),
    [
      applying,
      dirtyFieldLabels,
      dirtyFields,
      effectiveCommitMode,
      focusField,
      invalidFields,
      isStagedSpec,
      lockReason,
      nodeTitle,
      phase,
      registeredSessionKey,
      requestApply,
      resetDisplay,
      revertAll,
      revertField,
    ],
  );
  useRegisterInspectorEditSessionV2(registeredSession);

  return {
    sessionKey,
    animationKey,
    effectiveCommitMode,
    phase,
    draft,
    baseline: effectiveBaseline,
    dirty: dirtyFields.size > 0,
    dirtyFields,
    dirtyFieldLabels,
    invalidFields,
    valid: invalidFields.size === 0,
    touchedFields: activeScoped.touchedFields,
    forceShowErrors: activeScoped.forceShowErrors,
    applying,
    appliedFlash: activeScoped.appliedFlash,
    applyError: activeScoped.applyError,
    lockReason,
    pendingConfirm: activeScoped.pendingConfirm,
    activeModeTabId,
    displayUnits,
    focusRequest,
    setActiveModeTabId,
    setDisplayUnit,
    setField,
    patchDraft,
    revertField,
    revertAll,
    touchField,
    setParseError,
    requestApply,
    confirmPendingApply,
    cancelPendingApply,
    resetDisplay,
    focusField,
    clearFocusRequest,
  };
}
