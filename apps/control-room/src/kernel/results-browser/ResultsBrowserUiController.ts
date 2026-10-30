"use client";

import { useCallback, useSyncExternalStore } from "react";

import type { ResultsSource } from "../api/resultsBrowser";
import { useKernel } from "../KernelContext";

const MAX_UI_KEYS = 32;
const MAX_QUERY_LENGTH = 512;
const MAX_ENTRY_ID_LENGTH = 512;
const MAX_TRACKED_ENTRY_IDS = 512;

export interface ResultsBrowserUiIdentity {
  readonly source: ResultsSource;
  readonly runId: string;
  readonly sessionIdentityKey: string;
}

export interface ResultsBrowserUiState {
  readonly query: string;
  readonly collapsedIds: readonly string[];
  readonly expandedIds: readonly string[];
  readonly focusedEntryId: string | null;
}

export type ResultsBrowserUiKey = string;

export const EMPTY_RESULTS_BROWSER_UI_STATE: ResultsBrowserUiState = Object.freeze({
  query: "",
  collapsedIds: Object.freeze([]),
  expandedIds: Object.freeze([]),
  focusedEntryId: null,
});

type ResultsBrowserUiListener = () => void;

function nonEmptyIdentityPart(value: string): string | null {
  return value.trim().length > 0 ? value : null;
}

/** A stable fence; it intentionally omits catalog revision. */
export function resultsBrowserUiIdentityKey(
  identity: ResultsBrowserUiIdentity | null,
): ResultsBrowserUiKey | null {
  if (!identity) return null;
  const runId = nonEmptyIdentityPart(identity.runId);
  const sessionIdentityKey = nonEmptyIdentityPart(identity.sessionIdentityKey);
  if (!runId || !sessionIdentityKey) return null;
  const source = identity.source;
  if (source.kind === "current") {
    return JSON.stringify(["current", null, runId, sessionIdentityKey]);
  }
  const itemId = nonEmptyIdentityPart(source.itemId);
  return itemId
    ? JSON.stringify(["workspace", itemId, runId, sessionIdentityKey])
    : null;
}

function normalizeEntryId(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim().slice(0, MAX_ENTRY_ID_LENGTH);
  return normalized.length > 0 ? normalized : null;
}

function normalizeEntryIds(values: readonly string[]): readonly string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const normalized = normalizeEntryId(value);
    if (!normalized) continue;
    unique.add(normalized);
    if (unique.size >= MAX_TRACKED_ENTRY_IDS) break;
  }
  return Object.freeze([...unique]);
}

function evictOldestExcept(values: Set<string>, protectedId: string): boolean {
  for (const value of values) {
    if (value === protectedId) continue;
    values.delete(value);
    return true;
  }
  return false;
}

function keepEntryIdWithinBound(
  collapsedIds: Set<string>,
  expandedIds: Set<string>,
  preferred: "collapsed" | "expanded",
  protectedId: string,
): void {
  while (collapsedIds.size + expandedIds.size > MAX_TRACKED_ENTRY_IDS) {
    const opposite = preferred === "collapsed" ? expandedIds : collapsedIds;
    if (evictOldestExcept(opposite, protectedId)) continue;
    const preferredIds = preferred === "collapsed" ? collapsedIds : expandedIds;
    if (!evictOldestExcept(preferredIds, protectedId)) break;
  }
}

export class ResultsBrowserUiController {
  private readonly states = new Map<ResultsBrowserUiKey, ResultsBrowserUiState>();
  private readonly listeners = new Map<ResultsBrowserUiKey, Set<ResultsBrowserUiListener>>();

  get size(): number {
    return this.states.size;
  }

  getSnapshot(key: ResultsBrowserUiKey | null): ResultsBrowserUiState {
    return key ? this.states.get(key) ?? EMPTY_RESULTS_BROWSER_UI_STATE : EMPTY_RESULTS_BROWSER_UI_STATE;
  }

  getServerSnapshot(): ResultsBrowserUiState {
    return EMPTY_RESULTS_BROWSER_UI_STATE;
  }

  subscribe(key: ResultsBrowserUiKey | null, listener: ResultsBrowserUiListener): () => void {
    if (!key) return () => undefined;
    const listeners = this.listeners.get(key) ?? new Set<ResultsBrowserUiListener>();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }

  setQuery(key: ResultsBrowserUiKey | null, query: string): void {
    this.update(key, { query: query.slice(0, MAX_QUERY_LENGTH) });
  }

  toggleCollapsed(key: ResultsBrowserUiKey | null, entryId: string): void {
    const normalized = normalizeEntryId(entryId);
    if (!normalized) return;
    const current = this.getSnapshot(key);
    this.setCollapsed(key, normalized, !current.collapsedIds.includes(normalized));
  }

  setCollapsed(key: ResultsBrowserUiKey | null, entryId: string, collapsed: boolean): void {
    const normalized = normalizeEntryId(entryId);
    if (!normalized) return;
    const current = this.getSnapshot(key);
    const collapsedIds = new Set(current.collapsedIds);
    const expandedIds = new Set(current.expandedIds);
    if (collapsed) {
      expandedIds.delete(normalized);
      collapsedIds.delete(normalized);
      collapsedIds.add(normalized);
      keepEntryIdWithinBound(collapsedIds, expandedIds, "collapsed", normalized);
    } else {
      collapsedIds.delete(normalized);
    }
    this.update(key, {
      collapsedIds: [...collapsedIds],
      expandedIds: [...expandedIds],
    });
  }

  toggleExpanded(
    key: ResultsBrowserUiKey | null,
    entryId: string,
    defaultCollapsed = false,
  ): void {
    const normalized = normalizeEntryId(entryId);
    if (!normalized) return;
    const current = this.getSnapshot(key);
    const expanded = defaultCollapsed
      ? current.expandedIds.includes(normalized) && !current.collapsedIds.includes(normalized)
      : !current.collapsedIds.includes(normalized);
    this.setExpanded(key, normalized, !expanded, defaultCollapsed);
  }

  setExpanded(
    key: ResultsBrowserUiKey | null,
    entryId: string,
    expanded: boolean,
    defaultCollapsed = false,
  ): void {
    const normalized = normalizeEntryId(entryId);
    if (!normalized) return;
    const current = this.getSnapshot(key);
    const collapsedIds = new Set(current.collapsedIds);
    const expandedIds = new Set(current.expandedIds);
    if (expanded) {
      collapsedIds.delete(normalized);
      expandedIds.delete(normalized);
      if (defaultCollapsed) {
        expandedIds.add(normalized);
        keepEntryIdWithinBound(collapsedIds, expandedIds, "expanded", normalized);
      }
    } else {
      expandedIds.delete(normalized);
      collapsedIds.delete(normalized);
      collapsedIds.add(normalized);
      keepEntryIdWithinBound(collapsedIds, expandedIds, "collapsed", normalized);
    }
    this.update(key, {
      collapsedIds: [...collapsedIds],
      expandedIds: [...expandedIds],
    });
  }

  setFocusedEntryId(key: ResultsBrowserUiKey | null, entryId: string | null): void {
    this.update(key, { focusedEntryId: normalizeEntryId(entryId) });
  }

  private update(
    key: ResultsBrowserUiKey | null,
    patch: Partial<ResultsBrowserUiState>,
  ): void {
    if (!key) return;
    const current = this.getSnapshot(key);
    const collapsedIds = patch.collapsedIds
      ? normalizeEntryIds(patch.collapsedIds)
      : current.collapsedIds;
    const collapsedIdSet = new Set(collapsedIds);
    const expandedIds = normalizeEntryIds(
      patch.expandedIds ?? current.expandedIds,
    )
      .filter((entryId) => !collapsedIdSet.has(entryId))
      .slice(0, Math.max(0, MAX_TRACKED_ENTRY_IDS - collapsedIds.length));
    const next: ResultsBrowserUiState = Object.freeze({
      query: typeof patch.query === "string"
        ? patch.query.slice(0, MAX_QUERY_LENGTH)
        : current.query,
      collapsedIds,
      expandedIds: Object.freeze(expandedIds),
      focusedEntryId: Object.prototype.hasOwnProperty.call(patch, "focusedEntryId")
        ? normalizeEntryId(patch.focusedEntryId ?? null)
        : current.focusedEntryId,
    });
    if (
      next.query === current.query &&
      next.focusedEntryId === current.focusedEntryId &&
      next.collapsedIds.length === current.collapsedIds.length &&
      next.collapsedIds.every((value, index) => value === current.collapsedIds[index]) &&
      next.expandedIds.length === current.expandedIds.length &&
      next.expandedIds.every((value, index) => value === current.expandedIds[index])
    ) {
      return;
    }
    this.states.delete(key);
    this.states.set(key, next);
    while (this.states.size > MAX_UI_KEYS) {
      const oldest = this.states.keys().next().value;
      if (oldest === undefined) break;
      this.states.delete(oldest);
      // Keep active subscribers attached to the key. They must observe the
      // bounded-state eviction as an empty snapshot and remain able to see a
      // later update if the key is reused before they unsubscribe.
      for (const listener of this.listeners.get(oldest) ?? []) listener();
    }
    for (const listener of this.listeners.get(key) ?? []) listener();
  }
}

export interface ResultsBrowserUiBinding extends ResultsBrowserUiState {
  setQuery: (query: string) => void;
  toggleCollapsed: (entryId: string) => void;
  setCollapsed: (entryId: string, collapsed: boolean) => void;
  toggleExpanded: (entryId: string, defaultCollapsed?: boolean) => void;
  setExpanded: (entryId: string, expanded: boolean, defaultCollapsed?: boolean) => void;
  setFocusedEntryId: (entryId: string | null) => void;
}

const NOOP_SUBSCRIBE = () => () => undefined;

/** Kernel-owned UI state; it never contains catalog pages, files or payloads. */
export function useResultsBrowserUi(
  identity: ResultsBrowserUiIdentity | null,
): ResultsBrowserUiBinding {
  const controller = useKernel().resultsBrowserUi;
  const key = resultsBrowserUiIdentityKey(identity);
  const subscribe = useCallback(
    (listener: ResultsBrowserUiListener) =>
      key ? controller.subscribe(key, listener) : NOOP_SUBSCRIBE(),
    [controller, key],
  );
  const getSnapshot = useCallback(
    () => controller.getSnapshot(key),
    [controller, key],
  );
  const state = useSyncExternalStore(
    subscribe,
    getSnapshot,
    controller.getServerSnapshot,
  );
  const setQuery = useCallback(
    (query: string) => controller.setQuery(key, query),
    [controller, key],
  );
  const toggleCollapsed = useCallback(
    (entryId: string) => controller.toggleCollapsed(key, entryId),
    [controller, key],
  );
  const setCollapsed = useCallback(
    (entryId: string, collapsed: boolean) => controller.setCollapsed(key, entryId, collapsed),
    [controller, key],
  );
  const toggleExpanded = useCallback(
    (entryId: string, defaultCollapsed?: boolean) => controller.toggleExpanded(key, entryId, defaultCollapsed),
    [controller, key],
  );
  const setExpanded = useCallback(
    (entryId: string, expanded: boolean, defaultCollapsed?: boolean) =>
      controller.setExpanded(key, entryId, expanded, defaultCollapsed),
    [controller, key],
  );
  const setFocusedEntryId = useCallback(
    (entryId: string | null) => controller.setFocusedEntryId(key, entryId),
    [controller, key],
  );
  return { ...state, setQuery, toggleCollapsed, setCollapsed, toggleExpanded, setExpanded, setFocusedEntryId };
}
