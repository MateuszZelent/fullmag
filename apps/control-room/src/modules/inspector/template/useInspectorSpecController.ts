"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  formatInspectorSessionKey,
  useRegisterInspectorEditSessionV2,
  type InspectorEditSessionV2,
} from "../InspectorEditSession";
import { evaluateInspectorRowError } from "./PropertyRow";
import type { CommitBarSpec, InspectorNotice, InspectorSpec } from "./types";
import { inspectorValuesEqual } from "./unitConversion";

export type InspectorConflictResolutionStrategy = "keep-local" | "use-server";

export interface InspectorFieldConflict {
  readonly key: string;
  readonly label: string;
  readonly baseValue: unknown;
  readonly localValue: unknown;
  readonly serverValue: unknown;
}

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

export type InspectorRequestApplyHandler = (options?: {
  confirmed?: boolean;
}) => Promise<boolean>;

export type InspectorPendingConfirmPresenter = (
  confirmSpec: InspectorConfirmApplyState,
) => void;

export interface RegisteredControllerApplyHooks {
  confirmPendingApply: () => Promise<boolean>;
  cancelPendingApply: () => void;
  registerPendingConfirmPresenter: (
    presenter: InspectorPendingConfirmPresenter,
  ) => () => void;
  stagePendingConfirm: (confirmSpec: InspectorConfirmApplyState) => boolean;
}

const controllerApplyHooksRegistry = new WeakMap<
  (...args: never[]) => unknown,
  RegisteredControllerApplyHooks
>();

export function getRegisteredControllerApplyHooks(
  fn: ((...args: never[]) => unknown) | undefined,
): RegisteredControllerApplyHooks | undefined {
  return fn ? controllerApplyHooksRegistry.get(fn) : undefined;
}

export interface UseInspectorSpecControllerOptions<TDraft> {
  initialModeTabId?: string;
  onApplied?: (draft: TDraft) => void;
  onLiveFieldChange?: <K extends keyof TDraft & string>(key: K, value: TDraft[K]) => void;
  appliedFlashMs?: number;
  resetFieldInputsOnPatch?: boolean;
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
  readonly conflictFields: ReadonlyMap<string, InspectorFieldConflict>;
  readonly hasConflicts: boolean;
  readonly conflictNotice: InspectorNotice<TDraft> | null;
  readonly invalidFields: ReadonlyMap<string, string>;
  readonly valid: boolean;
  readonly touchedFields: ReadonlySet<string>;
  readonly fieldResetTokens: ReadonlyMap<string, number>;
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
  resolveConflict: (strategy: InspectorConflictResolutionStrategy, fieldKey?: string) => void;
  touchField: (fieldKey: string) => void;
  setParseError: (fieldKey: string, error: string | null) => void;
  requestApply: InspectorRequestApplyHandler;
  confirmPendingApply: () => Promise<boolean>;
  cancelPendingApply: () => void;
  acknowledgeCommitted: () => void;
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
  /** Baseline value observed when each staged override was first edited (for server-conflict detection). */
  stagedBaseValues: Partial<TDraft>;
  liveOverrides: Partial<TDraft>;
  committedBaseline: { forSourceBaseline: TDraft; value: TDraft } | null;
  touchedFields: Set<string>;
  fieldResetTokens: Map<string, number>;
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
    stagedBaseValues: {},
    liveOverrides: {},
    committedBaseline: null,
    touchedFields: new Set(),
    fieldResetTokens: new Map(),
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
  const resetFieldInputsOnPatch = options?.resetFieldInputsOnPatch ?? false;

  const [scopedState, setScopedState] = useState<ScopedEditState<TDraft>>(() =>
    createEmptyScopedState(targetKey),
  );
  const activeScoped =
    scopedState.targetKey === targetKey ? scopedState : createEmptyScopedState<TDraft>(targetKey);

  const [applying, setApplying] = useState(false);
  const committedCleanRef = useRef(false);
  const pendingConfirmRef = useRef<InspectorConfirmApplyState | null>(null);
  const pendingConfirmPresenterRef = useRef<InspectorPendingConfirmPresenter | null>(null);
  useLayoutEffect(() => {
    pendingConfirmRef.current = activeScoped.pendingConfirm;
  }, [activeScoped.pendingConfirm]);
  useLayoutEffect(() => {
    committedCleanRef.current = false;
  }, [targetKey]);
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

  const conflictFields = useMemo<ReadonlyMap<string, InspectorFieldConflict>>(() => {
    const conflicts = new Map<string, InspectorFieldConflict>();
    if (spec.commitBar.mode !== "staged") return conflicts;
    const serverRecord = effectiveBaseline as Record<string, unknown>;
    const baseValuesRecord = activeScoped.stagedBaseValues as Record<string, unknown>;
    const overrideEntries = Object.entries(activeScoped.stagedOverrides as Record<string, unknown>);
    for (const [key, localValue] of overrideEntries) {
      if (liveFieldKeys.has(key)) continue;
      if (!Object.prototype.hasOwnProperty.call(baseValuesRecord, key)) continue;
      const baseValue = baseValuesRecord[key];
      const serverValue = serverRecord[key];
      if (
        !inspectorValuesEqual(localValue, serverValue) &&
        !inspectorValuesEqual(serverValue, baseValue)
      ) {
        conflicts.set(key, {
          key,
          label: fieldLabelLookup.get(key) ?? key,
          baseValue,
          localValue,
          serverValue,
        });
      }
    }
    return conflicts;
  }, [
    activeScoped.stagedBaseValues,
    activeScoped.stagedOverrides,
    effectiveBaseline,
    fieldLabelLookup,
    liveFieldKeys,
    spec.commitBar.mode,
  ]);

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
      committedCleanRef.current = false;
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
        const nextBaseValues = { ...prev.stagedBaseValues } as Record<string, unknown>;
        if (inspectorValuesEqual(value, baseRecord[key])) {
          delete nextOverrides[key];
          delete nextBaseValues[key];
        } else {
          if (!Object.prototype.hasOwnProperty.call(nextBaseValues, key)) {
            nextBaseValues[key] = baseRecord[key];
          }
          nextOverrides[key] = value;
        }
        return {
          ...prev,
          stagedOverrides: nextOverrides as Partial<TDraft>,
          stagedBaseValues: nextBaseValues as Partial<TDraft>,
          appliedFlash: false,
          applyError: null,
        };
      });
    },
    [clearAppliedTimer, effectiveBaseline, liveFieldKeys, options, updateScoped],
  );

  const patchDraft = useCallback(
    (partial: Partial<TDraft>) => {
      committedCleanRef.current = false;
      clearAppliedTimer();
      const baseRecord = effectiveBaseline as Record<string, unknown>;
      updateScoped((prev) => {
        const nextStaged = { ...prev.stagedOverrides } as Record<string, unknown>;
        const nextBaseValues = { ...prev.stagedBaseValues } as Record<string, unknown>;
        const nextLive = { ...prev.liveOverrides } as Record<string, unknown>;
        const nextFieldResetTokens = resetFieldInputsOnPatch ? new Map(prev.fieldResetTokens) : null;
        const nextParseErrors = resetFieldInputsOnPatch ? new Map(prev.parseErrors) : null;
        for (const [key, value] of Object.entries(partial as Record<string, unknown>)) {
          nextFieldResetTokens?.set(key, (nextFieldResetTokens.get(key) ?? 0) + 1);
          nextParseErrors?.delete(key);
          if (liveFieldKeys.has(key)) {
            nextLive[key] = value;
          } else if (inspectorValuesEqual(value, baseRecord[key])) {
            delete nextStaged[key];
            delete nextBaseValues[key];
          } else {
            if (!Object.prototype.hasOwnProperty.call(nextBaseValues, key)) {
              nextBaseValues[key] = baseRecord[key];
            }
            nextStaged[key] = value;
          }
        }
        return {
          ...prev,
          stagedOverrides: nextStaged as Partial<TDraft>,
          stagedBaseValues: nextBaseValues as Partial<TDraft>,
          liveOverrides: nextLive as Partial<TDraft>,
          fieldResetTokens: nextFieldResetTokens ?? prev.fieldResetTokens,
          parseErrors: nextParseErrors ?? prev.parseErrors,
          appliedFlash: false,
          applyError: null,
        };
      });
    },
    [clearAppliedTimer, effectiveBaseline, liveFieldKeys, resetFieldInputsOnPatch, updateScoped],
  );

  const revertField = useCallback(
    (fieldKey: string) => {
      updateScoped((prev) => {
        const nextOverrides = { ...prev.stagedOverrides } as Record<string, unknown>;
        const nextBaseValues = { ...prev.stagedBaseValues } as Record<string, unknown>;
        delete nextOverrides[fieldKey];
        delete nextBaseValues[fieldKey];
        const nextParseErrors = new Map(prev.parseErrors);
        nextParseErrors.delete(fieldKey);
        return {
          ...prev,
          stagedOverrides: nextOverrides as Partial<TDraft>,
          stagedBaseValues: nextBaseValues as Partial<TDraft>,
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
      stagedBaseValues: {},
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

  const resolveConflict = useCallback(
    (strategy: InspectorConflictResolutionStrategy, fieldKey?: string) => {
      const serverRecord = effectiveBaseline as Record<string, unknown>;
      const targetKeys = fieldKey ? [fieldKey] : Array.from(conflictFields.keys());
      if (targetKeys.length === 0) return;

      updateScoped((prev) => {
        const nextOverrides = { ...prev.stagedOverrides } as Record<string, unknown>;
        const nextBaseValues = { ...prev.stagedBaseValues } as Record<string, unknown>;
        const nextParseErrors = new Map(prev.parseErrors);
        let changed = false;

        for (const key of targetKeys) {
          if (!Object.prototype.hasOwnProperty.call(nextOverrides, key)) continue;
          changed = true;
          if (strategy === "use-server") {
            delete nextOverrides[key];
            delete nextBaseValues[key];
            nextParseErrors.delete(key);
          } else {
            nextBaseValues[key] = serverRecord[key];
          }
        }

        if (!changed) return prev;
        return {
          ...prev,
          stagedOverrides: nextOverrides as Partial<TDraft>,
          stagedBaseValues: nextBaseValues as Partial<TDraft>,
          parseErrors: nextParseErrors,
          applyError: null,
        };
      });
    },
    [conflictFields, effectiveBaseline, updateScoped],
  );

  const conflictNotice = useMemo<InspectorNotice<TDraft> | null>(() => {
    if (conflictFields.size === 0) return null;
    const conflicts = Array.from(conflictFields.values());
    const labels = conflicts.map((entry) => entry.label).join(", ");
    const firstKey = conflicts[0]?.key as (keyof TDraft & string) | undefined;
    return {
      id: "inspector-server-conflict",
      tone: "warn",
      title:
        conflicts.length === 1
          ? "1 field changed on server"
          : `${conflicts.length} fields changed on server`,
      text: `Server updated ${labels} while you had local edits. Keep your local values or adopt the server revision.`,
      ...(firstKey ? { focusFieldKey: firstKey } : {}),
      quickFix: {
        label: "Use server",
        onApply: () => {
          resolveConflict("use-server");
        },
      },
    };
  }, [conflictFields, resolveConflict]);

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
    const submittedDraft = draft;
    const submittedBaseline = baseline;
    const submittedOverrides = { ...activeScoped.stagedOverrides } as Record<string, unknown>;

    pendingConfirmRef.current = null;
    setApplying(true);
    updateScoped((prev) => ({
      ...prev,
      pendingConfirm: null,
      applyError: null,
    }));

    try {
      const result = await spec.commitBar.onApply(submittedDraft, effectiveBaseline);
      if (result !== false) {
        updateScoped((prev) => {
          const prevOverrides = prev.stagedOverrides as Record<string, unknown>;
          const prevBaseValues = prev.stagedBaseValues as Record<string, unknown>;
          const submittedDraftRecord = submittedDraft as Record<string, unknown>;
          const nextOverrides: Record<string, unknown> = {};
          const nextBaseValues: Record<string, unknown> = {};
          const nextTouched = new Set<string>();
          const nextParseErrors = new Map<string, string>();

          for (const [key, currentValue] of Object.entries(prevOverrides)) {
            const wasSubmitted = Object.prototype.hasOwnProperty.call(
              submittedOverrides,
              key,
            );
            if (wasSubmitted && inspectorValuesEqual(currentValue, submittedOverrides[key])) {
              continue;
            }
            nextOverrides[key] = currentValue;
            if (wasSubmitted) {
              nextBaseValues[key] = submittedDraftRecord[key];
            } else if (Object.prototype.hasOwnProperty.call(prevBaseValues, key)) {
              nextBaseValues[key] = prevBaseValues[key];
            } else {
              nextBaseValues[key] = submittedDraftRecord[key];
            }
            if (prev.touchedFields.has(key)) {
              nextTouched.add(key);
            }
          }

          for (const [key, err] of prev.parseErrors) {
            const wasSubmittedCleanly =
              Object.prototype.hasOwnProperty.call(submittedOverrides, key) &&
              Object.prototype.hasOwnProperty.call(prevOverrides, key) &&
              inspectorValuesEqual(prevOverrides[key], submittedOverrides[key]);
            if (!wasSubmittedCleanly) {
              nextParseErrors.set(key, err);
            }
          }

          const hasRemainingEdits =
            Object.keys(nextOverrides).length > 0 || nextParseErrors.size > 0;

          return {
            ...prev,
            stagedOverrides: nextOverrides as Partial<TDraft>,
            stagedBaseValues: nextBaseValues as Partial<TDraft>,
            committedBaseline: { forSourceBaseline: submittedBaseline, value: submittedDraft },
            touchedFields: nextTouched,
            parseErrors: nextParseErrors,
            forceShowErrors: false,
            applyError: null,
            appliedFlash: !hasRemainingEdits,
          };
        });
        clearAppliedTimer();
        appliedTimerRef.current = setTimeout(() => {
          appliedTimerRef.current = null;
          updateScoped((prev) => (prev.appliedFlash ? { ...prev, appliedFlash: false } : prev));
        }, appliedFlashMs);
        options?.onApplied?.(submittedDraft);
        return true;
      }

      updateScoped((prev) => ({
        ...prev,
        forceShowErrors: true,
        applyError: "Changes could not be applied. Review highlighted fields.",
      }));
      committedCleanRef.current = false;
      return false;
    } catch (error) {
      committedCleanRef.current = false;
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
      committedCleanRef.current = false;
      setApplying(false);
    }
  }, [
    activeScoped.stagedOverrides,
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

  const registerPendingConfirmPresenter = useCallback(
    (presenter: InspectorPendingConfirmPresenter) => {
      pendingConfirmPresenterRef.current = presenter;
      return () => {
        if (pendingConfirmPresenterRef.current === presenter) {
          pendingConfirmPresenterRef.current = null;
        }
      };
    },
    [],
  );

  const stagePendingConfirm = useCallback(
    (confirmSpec: InspectorConfirmApplyState): boolean => {
      pendingConfirmRef.current = confirmSpec;
      updateScoped((prev) => ({ ...prev, pendingConfirm: confirmSpec }));
      const presenter = pendingConfirmPresenterRef.current;
      presenter?.(confirmSpec);
      return presenter !== null;
    },
    [updateScoped],
  );

  const confirmPendingApply = useCallback(async (): Promise<boolean> => {
    if (spec.commitBar.mode !== "staged") return false;
    if (applying || (!canCleanApply && dirtyFields.size === 0) || Boolean(lockReason)) {
      return false;
    }
    if (invalidFields.size > 0) {
      pendingConfirmRef.current = null;
      updateScoped((prev) => ({
        ...prev,
        pendingConfirm: null,
        forceShowErrors: true,
      }));
      return false;
    }
    return executeApply();
  }, [
    applying,
    canCleanApply,
    dirtyFields.size,
    executeApply,
    invalidFields.size,
    lockReason,
    spec.commitBar.mode,
    updateScoped,
  ]);

  const cancelPendingApply = useCallback(() => {
    pendingConfirmRef.current = null;
    updateScoped((prev) => ({ ...prev, pendingConfirm: null }));
  }, [updateScoped]);

  const requestApplyInternal = useCallback(async (): Promise<boolean> => {
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
      stagePendingConfirm(confirmSpec);
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
    stagePendingConfirm,
    updateScoped,
  ]);

  const requestApply = useCallback<InspectorRequestApplyHandler>(
    (applyOptions?: { confirmed?: boolean }) =>
      applyOptions?.confirmed ? confirmPendingApply() : requestApplyInternal(),
    [confirmPendingApply, requestApplyInternal],
  );

  useLayoutEffect(() => {
    controllerApplyHooksRegistry.set(requestApply, {
      confirmPendingApply,
      cancelPendingApply,
      registerPendingConfirmPresenter,
      stagePendingConfirm,
    });
  }, [
    cancelPendingApply,
    confirmPendingApply,
    registerPendingConfirmPresenter,
    requestApply,
    stagePendingConfirm,
  ]);

  const resetDisplay = useCallback(async (): Promise<void> => {
    if (spec.commitBar.mode !== "liveViewport") return;
    await spec.commitBar.onResetDisplay();
    updateScoped((prev) => ({
      ...prev,
      liveOverrides: {},
      stagedOverrides: {},
      stagedBaseValues: {},
    }));
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

  const acknowledgeCommitted = useCallback(() => {
    committedCleanRef.current = true;
  }, []);

  const registeredSessionKey = isStagedSpec
    ? formatInspectorSessionKey(selectionTargetKey, spec.id, stagedTabId)
    : sessionKey;
  const nodeTitle = spec.identity.title(draft);
  const registeredSession = useMemo<InspectorEditSessionV2>(
    () => ({
      sessionKey: registeredSessionKey,
      nodeTitle,
      mode: isStagedSpec ? "staged" : effectiveCommitMode,
      allowCleanApply: canCleanApply,
      applying,
      get dirty() {
        if (committedCleanRef.current) return false;
        return isStagedSpec ? dirtyFields.size > 0 : phase === "liveOverridden";
      },
      get pendingConfirmation() {
        return pendingConfirmRef.current !== null;
      },
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
      canCleanApply,
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
    conflictFields,
    hasConflicts: conflictFields.size > 0,
    conflictNotice,
    invalidFields,
    valid: invalidFields.size === 0,
    touchedFields: activeScoped.touchedFields,
    fieldResetTokens: activeScoped.fieldResetTokens,
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
    resolveConflict,
    touchField,
    setParseError,
    requestApply,
    confirmPendingApply,
    cancelPendingApply,
    acknowledgeCommitted,
    resetDisplay,
    focusField,
    clearFocusRequest,
  };
}
