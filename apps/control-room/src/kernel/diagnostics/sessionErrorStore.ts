"use client";

import { useSyncExternalStore } from "react";
import type {
  SessionErrorAppendRequest,
  SessionErrorEntry as ApiSessionErrorEntry,
  SessionErrorHistoryResource,
  SessionErrorOccurrence,
} from "../api/apiTypes";

export type SessionErrorCategory = "frontend" | "backend" | "api" | "model";
export type SessionErrorSeverity = "error" | "warning";
export type SessionErrorSyncStatus = "idle" | "loading" | "syncing" | "ready" | "offline";

export interface SessionErrorEntry {
  readonly id: string;
  readonly fingerprint: string;
  readonly category: SessionErrorCategory;
  readonly severity: SessionErrorSeverity;
  readonly source: string;
  readonly code: string | null;
  readonly title: string;
  readonly message: string;
  readonly detail: string | null;
  readonly path: string | null;
  readonly requestId: string | null;
  readonly firstSeenMs: number;
  readonly lastSeenMs: number;
  readonly count: number;
  readonly sessionId: string | null;
}

export interface SessionErrorInput {
  readonly category: SessionErrorCategory;
  readonly severity?: SessionErrorSeverity;
  readonly source: string;
  readonly code?: string | null;
  readonly title: string;
  readonly message: string;
  readonly detail?: string | null;
  readonly path?: string | null;
  readonly requestId?: string | null;
  readonly timestampMs?: number;
  readonly sessionId?: string | null;
}

export interface SessionErrorReportContext {
  readonly sessionId?: string | null;
  readonly sessionName?: string | null;
  readonly url?: string | null;
  readonly discretization?: string | null;
  readonly sceneRevision?: number | null;
  readonly meshRevision?: number | null;
  readonly runId?: string | null;
  readonly userAgent?: string | null;
  readonly viewport?: string | null;
  readonly generatedAtIso?: string;
}

export interface SessionErrorSnapshot {
  readonly sessionId: string | null;
  readonly entries: readonly SessionErrorEntry[];
  readonly pendingCount: number;
  readonly pendingClear: boolean;
  readonly clearGeneration: number;
  readonly revision: number | null;
  readonly syncStatus: SessionErrorSyncStatus;
}

export interface SessionErrorStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoreOptions {
  readonly storage?: SessionErrorStorage | null;
  readonly createEventId?: (timestampMs: number, sequence: number) => string;
}

interface PendingOccurrence {
  readonly clearGeneration: number | null;
  readonly afterClearRequest: boolean;
  readonly event: SessionErrorOccurrence;
}

interface Outbox {
  readonly version: 1;
  clearGeneration: number | null;
  pendingClearGeneration: number | null;
  clearRequested: boolean;
  occurrences: PendingOccurrence[];
}

type Listener = () => void;

const LEGACY_PREFIX = "fullmag:session-errors:v1:";
const OUTBOX_PREFIX = "fullmag:session-errors:outbox:v1:";
const GLOBAL_SCOPE = "__global__";
const MAX_ENTRIES = 150;
const MAX_OUTBOX_EVENTS = 200;
const MAX_FIELD_LEN = 2_400;
export const SESSION_ERROR_APPEND_BATCH_LIMIT = 20;

function emptyOutbox(): Outbox {
  return { version: 1, clearGeneration: null, pendingClearGeneration: null, clearRequested: false, occurrences: [] };
}

function truncate(value: string | null | undefined, max = MAX_FIELD_LEN): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function normalizeEventId(value: string): string {
  return value.replace(/[^A-Za-z0-9_:-]/g, "_").slice(0, 160) || `event-${Date.now()}`;
}

function safeTimestamp(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : Date.now();
}

function normalizeOccurrence(event: SessionErrorOccurrence): SessionErrorOccurrence {
  const firstSeenMs = safeTimestamp(event.firstSeenMs);
  return {
    category: event.category,
    code: truncate(event.code, 80),
    count: Number.isSafeInteger(event.count) && event.count > 0 ? event.count : 1,
    detail: truncate(event.detail),
    eventId: normalizeEventId(event.eventId),
    firstSeenMs,
    lastSeenMs: Math.max(firstSeenMs, safeTimestamp(event.lastSeenMs)),
    message: truncate(event.message, 1_200) ?? "Application error",
    path: truncate(event.path, 300),
    requestId: truncate(event.requestId, 120),
    severity: event.severity,
    source: truncate(event.source, 120) ?? "unknown",
    title: truncate(event.title, 200) ?? "Application error",
  };
}

function fingerprint(input: Pick<SessionErrorEntry, "category" | "code" | "message" | "path" | "source" | "title">): string {
  return [
    input.category,
    input.source.trim().toLowerCase(),
    (input.code ?? "").trim().toLowerCase(),
    input.title.trim().toLowerCase(),
    (input.path ?? "").trim().toLowerCase(),
    input.message.trim().slice(0, 240).toLowerCase(),
  ].join("|");
}

export function buildSessionErrorFingerprint(input: {
  category: SessionErrorCategory;
  code?: string | null;
  message: string;
  path?: string | null;
  source: string;
  title: string;
}): string {
  return fingerprint({
    category: input.category,
    code: input.code ?? null,
    message: input.message,
    path: input.path ?? null,
    source: input.source,
    title: input.title,
  });
}

function storageKey(prefix: string, sessionId: string | null): string {
  return `${prefix}${sessionId?.trim() || GLOBAL_SCOPE}`;
}

function browserStorage(): SessionErrorStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function isCategory(value: unknown): value is SessionErrorCategory {
  return value === "frontend" || value === "backend" || value === "api" || value === "model";
}

function isSeverity(value: unknown): value is SessionErrorSeverity {
  return value === "error" || value === "warning";
}

function parseLegacyEntries(raw: string | null): SessionErrorEntry[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.flatMap((item): SessionErrorEntry[] => {
      if (!item || typeof item !== "object") return [];
      const entry = item as Partial<SessionErrorEntry>;
      if (!isCategory(entry.category) || !isSeverity(entry.severity) ||
        typeof entry.id !== "string" || typeof entry.fingerprint !== "string" ||
        typeof entry.source !== "string" || typeof entry.title !== "string" ||
        typeof entry.message !== "string" || !Number.isSafeInteger(entry.lastSeenMs) ||
        (entry.lastSeenMs ?? -1) < 0 || !Number.isSafeInteger(entry.count) ||
        (entry.count ?? 0) < 1) return [];
      return [{
        category: entry.category,
        code: entry.code ?? null,
        count: entry.count!,
        detail: entry.detail ?? null,
        fingerprint: entry.fingerprint,
        firstSeenMs: Number.isSafeInteger(entry.firstSeenMs) && (entry.firstSeenMs ?? -1) >= 0
          ? entry.firstSeenMs!
          : entry.lastSeenMs!,
        id: entry.id,
        lastSeenMs: entry.lastSeenMs!,
        message: entry.message,
        path: entry.path ?? null,
        requestId: entry.requestId ?? null,
        sessionId: entry.sessionId ?? null,
        severity: entry.severity,
        source: entry.source,
        title: entry.title,
      }];
    }).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function parseOutbox(raw: string | null): Outbox {
  if (!raw) return emptyOutbox();
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return emptyOutbox();
    const record = value as Partial<Outbox>;
    if (record.version !== 1 || !Array.isArray(record.occurrences)) return emptyOutbox();
    const clearGeneration = Number.isSafeInteger(record.clearGeneration) && (record.clearGeneration ?? -1) >= 0
      ? record.clearGeneration!
      : null;
    const pendingClearGeneration = Number.isSafeInteger(record.pendingClearGeneration) && (record.pendingClearGeneration ?? -1) >= 0
      ? record.pendingClearGeneration!
      : null;
    const occurrences = record.occurrences.flatMap((item): PendingOccurrence[] => {
      if (!item || typeof item !== "object") return [];
      const pending = item as Partial<PendingOccurrence>;
      const event = pending.event as Partial<SessionErrorOccurrence> | undefined;
      if (!event || !isCategory(event.category) || !isSeverity(event.severity) ||
        typeof event.eventId !== "string" || !/^[A-Za-z0-9_:-]{1,160}$/.test(event.eventId) ||
        typeof event.source !== "string" || typeof event.title !== "string" ||
        typeof event.message !== "string" || !Number.isSafeInteger(event.firstSeenMs) ||
        (event.firstSeenMs ?? -1) < 0 || !Number.isSafeInteger(event.lastSeenMs) ||
        (event.lastSeenMs ?? -1) < (event.firstSeenMs ?? 0) ||
        !Number.isSafeInteger(event.count) || (event.count ?? 0) < 1) return [];
      const generation = pending.clearGeneration;
      if (generation !== null && (!Number.isSafeInteger(generation) || (generation ?? -1) < 0)) return [];
      return [{
        clearGeneration: generation ?? null,
        afterClearRequest: pending.afterClearRequest === true,
        event: normalizeOccurrence(event as SessionErrorOccurrence),
      }];
    });
    return {
      version: 1,
      clearGeneration,
      pendingClearGeneration,
      clearRequested: record.clearRequested === true || pendingClearGeneration !== null,
      occurrences: occurrences.slice(-MAX_OUTBOX_EVENTS),
    };
  } catch {
    return emptyOutbox();
  }
}

function readOutbox(storage: SessionErrorStorage | null, sessionId: string | null): Outbox {
  try {
    return storage ? parseOutbox(storage.getItem(storageKey(OUTBOX_PREFIX, sessionId))) : emptyOutbox();
  } catch {
    return emptyOutbox();
  }
}

function writeOutbox(storage: SessionErrorStorage | null, sessionId: string | null, outbox: Outbox): boolean {
  if (!storage) return false;
  const key = storageKey(OUTBOX_PREFIX, sessionId);
  try {
    if (outbox.occurrences.length === 0 && !outbox.clearRequested) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, JSON.stringify(outbox));
    }
    return true;
  } catch {
    return false;
  }
}

function removeItem(storage: SessionErrorStorage | null, key: string): void {
  try { storage?.removeItem(key); } catch { /* Storage may be disabled. */ }
}

function occurrenceFromEntry(entry: SessionErrorEntry, eventId: string): SessionErrorOccurrence {
  return normalizeOccurrence({
    category: entry.category,
    code: entry.code,
    count: entry.count,
    detail: entry.detail,
    eventId,
    firstSeenMs: entry.firstSeenMs,
    lastSeenMs: entry.lastSeenMs,
    message: entry.message,
    path: entry.path,
    requestId: entry.requestId,
    severity: entry.severity,
    source: entry.source,
    title: entry.title,
  } as SessionErrorOccurrence);
}

function entryFromOccurrence(event: SessionErrorOccurrence, sessionId: string | null): SessionErrorEntry {
  return {
    category: event.category,
    code: event.code ?? null,
    count: event.count,
    detail: event.detail ?? null,
    fingerprint: buildSessionErrorFingerprint(event),
    firstSeenMs: event.firstSeenMs,
    id: `pending:${buildSessionErrorFingerprint(event)}`,
    lastSeenMs: event.lastSeenMs,
    message: event.message,
    path: event.path ?? null,
    requestId: event.requestId ?? null,
    sessionId,
    severity: event.severity,
    source: event.source,
    title: event.title,
  };
}

function serverEntry(entry: ApiSessionErrorEntry, sessionId: string): SessionErrorEntry {
  return {
    category: entry.category,
    code: entry.code ?? null,
    count: entry.count,
    detail: entry.detail ?? null,
    fingerprint: entry.fingerprint,
    firstSeenMs: entry.firstSeenMs,
    id: entry.id,
    lastSeenMs: entry.lastSeenMs,
    message: entry.message,
    path: entry.path ?? null,
    requestId: entry.requestId ?? null,
    sessionId: entry.sessionId ?? sessionId,
    severity: entry.severity,
    source: entry.source,
    title: entry.title,
  };
}

function visibleEntries(
  server: readonly SessionErrorEntry[],
  pending: readonly PendingOccurrence[],
  sessionId: string | null,
  clearGeneration: number,
): SessionErrorEntry[] {
  const entries = new Map(server.map((entry) => [entry.fingerprint, entry]));
  const pendingByFingerprint = new Map<string, SessionErrorEntry>();
  for (const item of pending) {
    if (item.clearGeneration !== null && item.clearGeneration < clearGeneration) continue;
    const entry = entryFromOccurrence(item.event, sessionId);
    const serverEntry = entries.get(entry.fingerprint);
    if (serverEntry && entry.lastSeenMs <= serverEntry.lastSeenMs) continue;
    const previous = pendingByFingerprint.get(entry.fingerprint);
    pendingByFingerprint.set(entry.fingerprint, previous ? {
      ...previous,
      count: previous.count + entry.count,
      detail: entry.detail ?? previous.detail,
      firstSeenMs: Math.min(previous.firstSeenMs, entry.firstSeenMs),
      lastSeenMs: Math.max(previous.lastSeenMs, entry.lastSeenMs),
      requestId: entry.requestId ?? previous.requestId,
      severity: previous.severity === "error" || entry.severity === "error" ? "error" : "warning",
    } : entry);
  }
  for (const [key, pendingEntry] of pendingByFingerprint) {
    const previous = entries.get(key);
    entries.set(key, previous ? {
      ...previous,
      count: previous.count + pendingEntry.count,
      detail: pendingEntry.detail ?? previous.detail,
      firstSeenMs: Math.min(previous.firstSeenMs, pendingEntry.firstSeenMs),
      lastSeenMs: Math.max(previous.lastSeenMs, pendingEntry.lastSeenMs),
      requestId: pendingEntry.requestId ?? previous.requestId,
      severity: previous.severity === "error" || pendingEntry.severity === "error" ? "error" : "warning",
    } : pendingEntry);
  }
  return Array.from(entries.values()).sort((a, b) => b.lastSeenMs - a.lastSeenMs).slice(0, MAX_ENTRIES);
}

class SessionErrorStore {
  private readonly storage: SessionErrorStorage | null;
  private readonly createEventId: (timestampMs: number, sequence: number) => string;
  private sessionId: string | null = null;
  private scopeKey: string | null = null;
  private outbox = emptyOutbox();
  private serverEntries: SessionErrorEntry[] = [];
  private revision: number | null = null;
  private serverClearGeneration = 0;
  private syncStatus: SessionErrorSyncStatus = "idle";
  private sequence = 0;
  private snapshot: SessionErrorSnapshot = {
    sessionId: null, entries: [], pendingCount: 0, pendingClear: false,
    clearGeneration: 0, revision: null, syncStatus: "idle",
  };
  private readonly listeners = new Set<Listener>();
  private readonly outboxListeners = new Set<Listener>();

  constructor(options: StoreOptions) {
    this.storage = options.storage === undefined ? browserStorage() : options.storage;
    this.createEventId = options.createEventId ?? ((time, sequence) => {
      const id = typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : Math.random().toString(36).slice(2, 14);
      return `event-${time}-${sequence}-${id}`;
    });
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribeOutbox = (listener: Listener): (() => void) => {
    this.outboxListeners.add(listener);
    return () => this.outboxListeners.delete(listener);
  };

  getSnapshot = (): SessionErrorSnapshot => this.snapshot;

  setSessionScope(sessionId: string | null, scopeKey: string | null): void {
    const nextId = sessionId?.trim() || null;
    const nextScope = nextId ? scopeKey?.trim() || null : null;
    if (this.sessionId === nextId && this.scopeKey === nextScope) return;
    const previousId = this.sessionId;
    const earlyOutbox = previousId === null ? this.outbox : emptyOutbox();
    this.sessionId = nextId;
    this.scopeKey = nextScope;
    this.serverEntries = [];
    this.revision = null;
    this.serverClearGeneration = 0;
    this.syncStatus = nextId ? "loading" : "idle";
    this.outbox = readOutbox(this.storage, nextId);

    this.migrateLegacy(nextId);
    if (nextId && previousId === null) {
      this.migrateLegacy(null);
      this.mergeEarlyOutbox(earlyOutbox);
    }
    this.publish(true);
  }

  recordForScope(scopeKey: string | null, input: SessionErrorInput): void {
    if (scopeKey === this.scopeKey) this.record(input);
  }

  record(input: SessionErrorInput): SessionErrorEntry {
    const timestampMs = safeTimestamp(input.timestampMs ?? Date.now());
    const event = normalizeOccurrence({
      category: input.category,
      code: input.code ?? null,
      count: 1,
      detail: input.detail ?? null,
      eventId: this.createEventId(timestampMs, this.sequence++),
      firstSeenMs: timestampMs,
      lastSeenMs: timestampMs,
      message: input.message,
      path: input.path ?? null,
      requestId: input.requestId ?? null,
      severity: input.severity ?? "error",
      source: input.source,
      title: input.title,
    } as SessionErrorOccurrence);
    const duplicateId = this.outbox.occurrences.some((item) => item.event.eventId === event.eventId);
    const uniqueEvent = duplicateId
      ? normalizeOccurrence({ ...event, eventId: `${event.eventId}-${this.sequence++}` } as SessionErrorOccurrence)
      : event;
    this.outbox.occurrences = [...this.outbox.occurrences, {
      clearGeneration: this.outbox.clearRequested
        ? this.outbox.pendingClearGeneration
        : this.outbox.clearGeneration,
      afterClearRequest: this.outbox.clearRequested,
      event: uniqueEvent,
    }].slice(-MAX_OUTBOX_EVENTS);
    this.persistOutbox();
    this.publish(true);
    return entryFromOccurrence(uniqueEvent, this.sessionId);
  }

  clear(): void {
    if (this.sessionId === null) {
      this.outbox = { ...this.outbox, occurrences: [], pendingClearGeneration: null, clearRequested: false };
      this.serverEntries = [];
    } else {
      const observed = this.outbox.clearGeneration ?? (this.revision === null ? null : this.serverClearGeneration);
      this.outbox = {
        ...this.outbox,
        occurrences: [],
        pendingClearGeneration: this.outbox.clearRequested
          ? this.outbox.pendingClearGeneration
          : observed === null ? null : observed + 1,
        clearRequested: true,
      };
    }
    this.persistOutbox();
    this.publish(true);
  }

  getAppendBatch(): SessionErrorAppendRequest | null {
    const generation = this.outbox.clearGeneration;
    if (!this.sessionId || !this.scopeKey || generation === null || this.outbox.clearRequested) return null;
    const events = this.outbox.occurrences
      .filter((item) => item.clearGeneration === generation)
      .slice(0, SESSION_ERROR_APPEND_BATCH_LIMIT)
      .map((item) => item.event);
    return events.length > 0 ? { clearGeneration: generation, events } : null;
  }

  hasPendingClear(): boolean {
    return Boolean(this.sessionId && this.scopeKey && this.outbox.clearRequested);
  }

  markSyncing(scopeKey: string): void {
    if (!this.matchesScope(scopeKey)) return;
    this.syncStatus = "syncing";
    this.publish();
  }

  markSyncReady(scopeKey: string): void {
    if (!this.matchesScope(scopeKey)) return;
    this.syncStatus = "ready";
    this.publish();
  }

  markSyncFailed(scopeKey: string): void {
    if (!this.matchesScope(scopeKey)) return;
    this.syncStatus = "offline";
    this.publish();
  }

  markGenerationUnknown(scopeKey: string): void {
    if (!this.matchesScope(scopeKey)) return;
    this.outbox = { ...this.outbox, clearGeneration: null };
    this.persistOutbox();
    this.publish();
  }

  applyResource(scopeKey: string, resource: SessionErrorHistoryResource): boolean {
    if (!this.matchesResource(scopeKey, resource) || (this.revision !== null && resource.revision < this.revision)) return false;
    this.revision = resource.revision;
    this.serverClearGeneration = resource.clearGeneration;
    this.serverEntries = resource.entries.map((entry) => serverEntry(entry, resource.sessionId));
    const original = this.outbox;
    let pendingGeneration = this.outbox.pendingClearGeneration;
    const firstClearRead = this.outbox.clearRequested && pendingGeneration === null;
    if (firstClearRead) pendingGeneration = resource.clearGeneration + 1;
    const clearConfirmed = this.outbox.clearRequested && !firstClearRead &&
      pendingGeneration !== null && resource.clearGeneration >= pendingGeneration;
    const occurrences = this.outbox.occurrences.flatMap((item): PendingOccurrence[] => {
      const afterRemoteClear = resource.clearedAtMs != null && item.event.firstSeenMs > resource.clearedAtMs;
      if (item.afterClearRequest) {
        if (clearConfirmed) {
          return resource.clearGeneration === pendingGeneration || afterRemoteClear
            ? [{ ...item, clearGeneration: resource.clearGeneration, afterClearRequest: false }]
            : [];
        }
        return item.clearGeneration === null || item.clearGeneration >= resource.clearGeneration ? [item] : [];
      }
      if (item.clearGeneration !== null && item.clearGeneration >= resource.clearGeneration) return [item];
      if (afterRemoteClear || (item.clearGeneration === null && resource.clearedAtMs == null)) {
        return [{ ...item, clearGeneration: resource.clearGeneration }];
      }
      return [];
    });
    const clearRequested = this.outbox.clearRequested && !clearConfirmed;
    this.outbox = {
      ...this.outbox,
      clearGeneration: resource.clearGeneration,
      pendingClearGeneration: clearRequested ? pendingGeneration ?? resource.clearGeneration + 1 : null,
      clearRequested,
      occurrences,
    };
    this.syncStatus = "ready";
    const outboxChanged = !sameOutbox(original, this.outbox);
    if (outboxChanged) this.persistOutbox();
    this.publish(outboxChanged);
    return true;
  }

  acknowledgeAppend(scopeKey: string, eventIds: readonly string[], resource: SessionErrorHistoryResource): boolean {
    if (!this.matchesResource(scopeKey, resource)) return false;
    const accepted = new Set(eventIds);
    this.outbox = {
      ...this.outbox,
      occurrences: this.outbox.occurrences.filter((item) => !accepted.has(item.event.eventId)),
    };
    this.persistOutbox();
    this.applyResource(scopeKey, resource);
    return true;
  }

  acknowledgeClear(scopeKey: string, resource: SessionErrorHistoryResource): boolean {
    if (!this.matchesResource(scopeKey, resource)) return false;
    const target = this.outbox.pendingClearGeneration;
    if (target !== null && resource.clearGeneration < target) return false;
    this.outbox = {
      ...this.outbox,
      clearGeneration: resource.clearGeneration,
      pendingClearGeneration: null,
      clearRequested: false,
      occurrences: this.outbox.occurrences.flatMap((item): PendingOccurrence[] => {
        if (item.afterClearRequest) {
          const afterRemoteClear = resource.clearedAtMs != null && item.event.firstSeenMs > resource.clearedAtMs;
          return target === null || resource.clearGeneration === target || afterRemoteClear
            ? [{ ...item, clearGeneration: resource.clearGeneration, afterClearRequest: false }]
            : [];
        }
        return item.clearGeneration === null || item.clearGeneration >= resource.clearGeneration ? [item] : [];
      }),
    };
    this.persistOutbox();
    return this.applyResource(scopeKey, resource) || resource.revision <= (this.revision ?? resource.revision);
  }

  resetForTests(): void {
    removeItem(this.storage, storageKey(OUTBOX_PREFIX, this.sessionId));
    removeItem(this.storage, storageKey(OUTBOX_PREFIX, null));
    removeItem(this.storage, storageKey(LEGACY_PREFIX, this.sessionId));
    removeItem(this.storage, storageKey(LEGACY_PREFIX, null));
    this.sessionId = null;
    this.scopeKey = null;
    this.outbox = emptyOutbox();
    this.serverEntries = [];
    this.revision = null;
    this.serverClearGeneration = 0;
    this.syncStatus = "idle";
    this.sequence = 0;
    this.publish(true);
  }

  private matchesScope(scopeKey: string): boolean {
    return this.sessionId !== null && this.scopeKey === scopeKey;
  }

  private matchesResource(scopeKey: string, resource: SessionErrorHistoryResource): boolean {
    return this.matchesScope(scopeKey) && resource.sessionId === this.sessionId;
  }

  private migrateLegacy(readSessionId: string | null): void {
    if (!this.storage) return;
    let legacy: SessionErrorEntry[];
    try {
      legacy = parseLegacyEntries(this.storage.getItem(storageKey(LEGACY_PREFIX, readSessionId)));
    } catch {
      return;
    }
    if (legacy.length === 0) return;
    const known = new Set(this.outbox.occurrences.map((item) => item.event.eventId));
    const additions = legacy.flatMap((entry): PendingOccurrence[] => {
      const eventId = normalizeEventId(`legacy-${entry.id}`);
      if (known.has(eventId)) return [];
      known.add(eventId);
      return [{
        clearGeneration: this.outbox.clearGeneration,
        afterClearRequest: false,
        event: occurrenceFromEntry(entry, eventId),
      }];
    });
    const prior = this.outbox;
    this.outbox = { ...prior, occurrences: [...prior.occurrences, ...additions].slice(-MAX_OUTBOX_EVENTS) };
    if (writeOutbox(this.storage, this.sessionId, this.outbox)) {
      removeItem(this.storage, storageKey(LEGACY_PREFIX, readSessionId));
    }
  }

  private mergeEarlyOutbox(memoryOutbox: Outbox): void {
    const diskOutbox = readOutbox(this.storage, null);
    const known = new Set(this.outbox.occurrences.map((item) => item.event.eventId));
    const early: PendingOccurrence[] = [];
    for (const item of [...memoryOutbox.occurrences, ...diskOutbox.occurrences]) {
      if (known.has(item.event.eventId)) continue;
      known.add(item.event.eventId);
      early.push({
        ...item,
        clearGeneration: this.outbox.clearGeneration,
        afterClearRequest: false,
      });
    }
    if (early.length === 0) return;
    this.outbox = { ...this.outbox, occurrences: [...this.outbox.occurrences, ...early].slice(-MAX_OUTBOX_EVENTS) };
    if (writeOutbox(this.storage, this.sessionId, this.outbox)) {
      removeItem(this.storage, storageKey(OUTBOX_PREFIX, null));
      removeItem(this.storage, storageKey(LEGACY_PREFIX, null));
    }
  }

  private persistOutbox(): void {
    writeOutbox(this.storage, this.sessionId, this.outbox);
  }

  private publish(outboxChanged = false): void {
    const pendingClear = this.outbox.clearRequested;
    const hideServer = pendingClear && (this.outbox.pendingClearGeneration === null ||
      this.outbox.pendingClearGeneration > this.serverClearGeneration);
    const entries = visibleEntries(
      hideServer ? [] : this.serverEntries,
      this.outbox.occurrences,
      this.sessionId,
      this.serverClearGeneration,
    );
    this.snapshot = {
      sessionId: this.sessionId,
      entries: Object.freeze(entries),
      pendingCount: this.outbox.occurrences.filter((item) => item.clearGeneration === null ||
        item.clearGeneration >= this.serverClearGeneration).length,
      pendingClear,
      clearGeneration: this.outbox.pendingClearGeneration ?? this.outbox.clearGeneration ?? this.serverClearGeneration,
      revision: this.revision,
      syncStatus: this.syncStatus,
    };
    for (const listener of this.listeners) listener();
    if (outboxChanged) for (const listener of this.outboxListeners) listener();
  }
}

function sameOutbox(left: Outbox, right: Outbox): boolean {
  return left.clearGeneration === right.clearGeneration &&
    left.pendingClearGeneration === right.pendingClearGeneration &&
    left.clearRequested === right.clearRequested &&
    left.occurrences.length === right.occurrences.length &&
    left.occurrences.every((item, index) => item.event.eventId === right.occurrences[index]?.event.eventId &&
      item.clearGeneration === right.occurrences[index]?.clearGeneration &&
      item.afterClearRequest === right.occurrences[index]?.afterClearRequest);
}

export function createSessionErrorStore(options: StoreOptions = {}): SessionErrorStore {
  return new SessionErrorStore(options);
}

export const sessionErrorStore = createSessionErrorStore();

export function mergeErrorLists(primary: readonly SessionErrorEntry[], secondary: readonly SessionErrorEntry[]): SessionErrorEntry[] {
  const entries = new Map<string, SessionErrorEntry>();
  for (const entry of [...primary, ...secondary]) {
    const existing = entries.get(entry.fingerprint);
    entries.set(entry.fingerprint, existing ? {
      ...existing,
      count: Math.max(existing.count, entry.count),
      detail: existing.detail ?? entry.detail,
      firstSeenMs: Math.min(existing.firstSeenMs, entry.firstSeenMs),
      lastSeenMs: Math.max(existing.lastSeenMs, entry.lastSeenMs),
      requestId: existing.requestId ?? entry.requestId,
      severity: existing.severity === "error" || entry.severity === "error" ? "error" : "warning",
    } : entry);
  }
  return Array.from(entries.values()).sort((a, b) => b.lastSeenMs - a.lastSeenMs).slice(0, MAX_ENTRIES);
}

export function useSessionErrors(): SessionErrorSnapshot {
  return useSyncExternalStore(sessionErrorStore.subscribe, sessionErrorStore.getSnapshot, sessionErrorStore.getSnapshot);
}

export function useSessionErrorCount(): number {
  return useSessionErrors().entries.filter((entry) => entry.severity === "error").length;
}

const CATEGORY_LABELS: Record<SessionErrorCategory, string> = {
  api: "API / WS", backend: "Backend", frontend: "Frontend", model: "Model",
};

export function sessionErrorCategoryLabel(category: SessionErrorCategory): string {
  return CATEGORY_LABELS[category];
}

export function formatSingleSessionErrorForAi(entry: SessionErrorEntry, context: SessionErrorReportContext = {}): string {
  const seen = entry.lastSeenMs > 0
    ? `\`${new Date(entry.lastSeenMs).toISOString()}\`${entry.count > 1 && entry.firstSeenMs > 0 ? ` (first seen \`${new Date(entry.firstSeenMs).toISOString()}\`)` : ""}`
    : "`active backend diagnostic`";
  const lines = [
    `### [${entry.category.toUpperCase()} · ${entry.severity.toUpperCase()}] ${entry.title}${entry.code ? ` (\`${entry.code}\`)` : ""}${entry.count > 1 ? ` ×${entry.count}` : ""}`,
    `- **Last seen:** ${seen}`,
    `- **Source:** \`${entry.source}\``,
  ];
  if (entry.path) lines.push(`- **Target / Path:** \`${entry.path}\``);
  if (entry.requestId) lines.push(`- **Request ID:** \`${entry.requestId}\``);
  if (context.sessionId) lines.push(`- **Session:** \`${context.sessionId}\``);
  lines.push(`- **Message:** ${entry.message}`);
  if (entry.detail) lines.push("", "```text", entry.detail, "```");
  return lines.join("\n");
}

export function formatSessionErrorsForAiReport(entries: readonly SessionErrorEntry[], context: SessionErrorReportContext = {}): string {
  const counts: Record<SessionErrorCategory, number> = { api: 0, backend: 0, frontend: 0, model: 0 };
  for (const entry of entries) counts[entry.category] += 1;
  const lines = [
    "# Fullmag Session Error Report",
    "",
    "Paste this diagnostic report into an AI assistant or issue tracker to reproduce and debug the errors recorded during this Fullmag Control Room session.",
    "",
    "## Session Context",
    `- **Generated (UTC):** \`${context.generatedAtIso ?? new Date().toISOString()}\``,
    `- **Session ID:** \`${context.sessionId ?? "none"}\``,
  ];
  if (context.sessionName) lines.push(`- **Session name:** ${context.sessionName}`);
  if (context.url) lines.push(`- **URL:** ${context.url}`);
  if (context.discretization) lines.push(`- **Solver lane:** \`${context.discretization.toUpperCase()}\``);
  if (context.sceneRevision != null || context.meshRevision != null) {
    lines.push(`- **Revisions:** scene \`${context.sceneRevision ?? "unknown"}\` · mesh \`${context.meshRevision ?? "unknown"}\``);
  }
  if (context.runId) lines.push(`- **Active run:** \`${context.runId}\``);
  if (context.viewport) lines.push(`- **Viewport:** \`${context.viewport}\``);
  if (context.userAgent) lines.push(`- **Browser:** \`${context.userAgent}\``);
  lines.push(
    "", "## Summary",
    `- **Unique issues:** ${entries.length} (${entries.reduce((sum, entry) => sum + entry.count, 0)} total occurrences)`,
    `- **By source:** Frontend ${counts.frontend} · Backend ${counts.backend} · API/WS ${counts.api} · Model ${counts.model}`,
    "",
  );
  if (entries.length === 0) {
    lines.push("_No errors or warnings were recorded in this session._");
    return lines.join("\n");
  }
  lines.push("## Recorded Issues (newest first)", "");
  entries.forEach((entry, index) => lines.push(
    formatSingleSessionErrorForAi(entry).replace(/^### /, `### ${index + 1}. `), "",
  ));
  return lines.join("\n").trimEnd() + "\n";
}
