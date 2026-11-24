"use client";

import { useSyncExternalStore } from "react";

export type SessionErrorCategory = "frontend" | "backend" | "api" | "model";
export type SessionErrorSeverity = "error" | "warning";

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
}

const STORAGE_PREFIX = "fullmag:session-errors:v1:";
const DEFAULT_STORAGE_SCOPE = "__global__";
const MAX_ENTRIES = 150;
const MAX_FIELD_LEN = 2_400;

type Listener = () => void;

function truncate(value: string | null | undefined, max = MAX_FIELD_LEN): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export function buildSessionErrorFingerprint(input: {
  category: SessionErrorCategory;
  code?: string | null;
  message: string;
  path?: string | null;
  source: string;
  title: string;
}): string {
  return [
    input.category,
    input.source.trim().toLowerCase(),
    (input.code ?? "").trim().toLowerCase(),
    input.title.trim().toLowerCase(),
    (input.path ?? "").trim().toLowerCase(),
    input.message.trim().slice(0, 240).toLowerCase(),
  ].join("|");
}

function storageKeyFor(sessionId: string | null): string {
  return `${STORAGE_PREFIX}${sessionId?.trim() || DEFAULT_STORAGE_SCOPE}`;
}

function readPersistedEntries(sessionId: string | null): SessionErrorEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(storageKeyFor(sessionId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is SessionErrorEntry => {
        if (!item || typeof item !== "object") return false;
        const record = item as Partial<SessionErrorEntry>;
        return (
          typeof record.id === "string" &&
          typeof record.fingerprint === "string" &&
          typeof record.category === "string" &&
          typeof record.title === "string" &&
          typeof record.message === "string" &&
          typeof record.lastSeenMs === "number"
        );
      })
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function writePersistedEntries(
  sessionId: string | null,
  entries: readonly SessionErrorEntry[],
): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      storageKeyFor(sessionId),
      JSON.stringify(entries.slice(0, MAX_ENTRIES)),
    );
  } catch {
    // Ignore storage quota / private-mode restrictions.
  }
}

class SessionErrorStore {
  private sessionId: string | null = null;
  private entries: SessionErrorEntry[] = [];
  private snapshot: SessionErrorSnapshot = { sessionId: null, entries: [] };
  private readonly listeners = new Set<Listener>();
  private sequence = 0;
  private hydratedScope: string | null = null;

  subscribe = (listener: Listener): (() => void) => {
    this.ensureHydrated();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): SessionErrorSnapshot => {
    this.ensureHydrated();
    return this.snapshot;
  };

  setSessionId(nextSessionId: string | null): void {
    const normalized = nextSessionId?.trim() || null;
    if (this.hydratedScope !== null && this.sessionId === normalized) {
      return;
    }
    this.sessionId = normalized;
    this.hydratedScope = storageKeyFor(normalized);
    const persisted = readPersistedEntries(normalized);
    // Keep any early errors recorded before the session ID settled when moving from global -> first session.
    const merged = mergeErrorLists(
      persisted,
      normalized !== null && this.entries.every((entry) => entry.sessionId === null)
        ? this.entries.map((entry) => ({ ...entry, sessionId: normalized }))
        : [],
    );
    this.entries = merged;
    writePersistedEntries(this.sessionId, this.entries);
    this.publish();
  }

  record(input: SessionErrorInput): SessionErrorEntry {
    this.ensureHydrated();
    const timestampMs = input.timestampMs ?? Date.now();
    const title = truncate(input.title, 200) ?? "Application error";
    const message = truncate(input.message, 1_200) ?? title;
    const source = truncate(input.source, 120) ?? "unknown";
    const code = truncate(input.code, 80);
    const path = truncate(input.path, 300);
    const detail = truncate(input.detail, MAX_FIELD_LEN);
    const requestId = truncate(input.requestId, 120);
    const severity: SessionErrorSeverity = input.severity ?? "error";
    const sessionId = input.sessionId ?? this.sessionId;
    const fingerprint = buildSessionErrorFingerprint({
      category: input.category,
      code,
      message,
      path,
      source,
      title,
    });

    const existingIndex = this.entries.findIndex(
      (entry) => entry.fingerprint === fingerprint,
    );
    let nextEntry: SessionErrorEntry;
    if (existingIndex >= 0) {
      const existing = this.entries[existingIndex]!;
      nextEntry = {
        ...existing,
        count: existing.count + 1,
        detail: detail ?? existing.detail,
        lastSeenMs: Math.max(existing.lastSeenMs, timestampMs),
        requestId: requestId ?? existing.requestId,
        severity:
          existing.severity === "error" || severity === "error"
            ? "error"
            : "warning",
      };
      this.entries = [
        nextEntry,
        ...this.entries.slice(0, existingIndex),
        ...this.entries.slice(existingIndex + 1),
      ];
    } else {
      nextEntry = {
        category: input.category,
        code,
        count: 1,
        detail,
        fingerprint,
        firstSeenMs: timestampMs,
        id: `err-${timestampMs}-${this.sequence++}`,
        lastSeenMs: timestampMs,
        message,
        path,
        requestId,
        sessionId,
        severity,
        source,
        title,
      };
      this.entries = [nextEntry, ...this.entries].slice(0, MAX_ENTRIES);
    }

    writePersistedEntries(this.sessionId, this.entries);
    this.publish();
    return nextEntry;
  }

  clear(): void {
    this.ensureHydrated();
    if (this.entries.length === 0) return;
    this.entries = [];
    writePersistedEntries(this.sessionId, this.entries);
    this.publish();
  }

  resetForTests(): void {
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.removeItem(storageKeyFor(this.sessionId));
        window.sessionStorage.removeItem(storageKeyFor(null));
      } catch {
        // Ignore storage errors in tests.
      }
    }
    this.sessionId = null;
    this.hydratedScope = null;
    this.entries = [];
    this.sequence = 0;
    this.snapshot = { sessionId: null, entries: [] };
    this.publish();
  }

  private ensureHydrated(): void {
    const scope = storageKeyFor(this.sessionId);
    if (this.hydratedScope === scope) return;
    this.hydratedScope = scope;
    const persisted = readPersistedEntries(this.sessionId);
    if (persisted.length > 0) {
      this.entries = mergeErrorLists(persisted, this.entries);
      this.snapshot = {
        entries: Object.freeze([...this.entries]),
        sessionId: this.sessionId,
      };
    }
  }

  private publish(): void {
    this.snapshot = {
      entries: Object.freeze([...this.entries]),
      sessionId: this.sessionId,
    };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function mergeErrorLists(
  primary: readonly SessionErrorEntry[],
  secondary: readonly SessionErrorEntry[],
): SessionErrorEntry[] {
  const byFingerprint = new Map<string, SessionErrorEntry>();
  for (const entry of [...primary, ...secondary]) {
    const existing = byFingerprint.get(entry.fingerprint);
    if (!existing) {
      byFingerprint.set(entry.fingerprint, entry);
      continue;
    }
    byFingerprint.set(entry.fingerprint, {
      ...existing,
      count: Math.max(existing.count, entry.count),
      detail: existing.detail ?? entry.detail,
      firstSeenMs: Math.min(existing.firstSeenMs, entry.firstSeenMs),
      lastSeenMs: Math.max(existing.lastSeenMs, entry.lastSeenMs),
      requestId: existing.requestId ?? entry.requestId,
      severity:
        existing.severity === "error" || entry.severity === "error"
          ? "error"
          : "warning",
    });
  }
  return Array.from(byFingerprint.values())
    .sort((left, right) => right.lastSeenMs - left.lastSeenMs)
    .slice(0, MAX_ENTRIES);
}

export const sessionErrorStore = new SessionErrorStore();

export function useSessionErrors(): SessionErrorSnapshot {
  return useSyncExternalStore(
    sessionErrorStore.subscribe,
    sessionErrorStore.getSnapshot,
    sessionErrorStore.getSnapshot,
  );
}

export function useSessionErrorCount(): number {
  const snapshot = useSessionErrors();
  return snapshot.entries.filter((entry) => entry.severity === "error").length;
}

const CATEGORY_LABELS: Record<SessionErrorCategory, string> = {
  api: "API / WS",
  backend: "Backend",
  frontend: "Frontend",
  model: "Model",
};

export function sessionErrorCategoryLabel(category: SessionErrorCategory): string {
  return CATEGORY_LABELS[category];
}

export function formatSingleSessionErrorForAi(
  entry: SessionErrorEntry,
  context: SessionErrorReportContext = {},
): string {
  const seenLabel =
    entry.lastSeenMs > 0
      ? `\`${new Date(entry.lastSeenMs).toISOString()}\`${entry.count > 1 && entry.firstSeenMs > 0 ? ` (first seen \`${new Date(entry.firstSeenMs).toISOString()}\`)` : ""}`
      : "`active backend diagnostic`";
  const lines: string[] = [
    `### [${entry.category.toUpperCase()} · ${entry.severity.toUpperCase()}] ${entry.title}${entry.code ? ` (\`${entry.code}\`)` : ""}${entry.count > 1 ? ` ×${entry.count}` : ""}`,
    `- **Last seen:** ${seenLabel}`,
    `- **Source:** \`${entry.source}\``,
  ];
  if (entry.path) lines.push(`- **Target / Path:** \`${entry.path}\``);
  if (entry.requestId) lines.push(`- **Request ID:** \`${entry.requestId}\``);
  if (context.sessionId) lines.push(`- **Session:** \`${context.sessionId}\``);
  lines.push(`- **Message:** ${entry.message}`);
  if (entry.detail) {
    lines.push("", "```text", entry.detail, "```");
  }
  return lines.join("\n");
}

export function formatSessionErrorsForAiReport(
  entries: readonly SessionErrorEntry[],
  context: SessionErrorReportContext = {},
): string {
  const generatedAt = context.generatedAtIso ?? new Date().toISOString();
  const totalOccurrences = entries.reduce((sum, entry) => sum + entry.count, 0);
  const counts: Record<SessionErrorCategory, number> = {
    api: 0,
    backend: 0,
    frontend: 0,
    model: 0,
  };
  for (const entry of entries) {
    counts[entry.category] += 1;
  }

  const lines: string[] = [
    "# Fullmag Session Error Report",
    "",
    "Paste this diagnostic report into an AI assistant or issue tracker to reproduce and debug the errors recorded during this Fullmag Control Room session.",
    "",
    "## Session Context",
    `- **Generated (UTC):** \`${generatedAt}\``,
    `- **Session ID:** \`${context.sessionId ?? "none"}\``,
  ];
  if (context.sessionName) lines.push(`- **Session name:** ${context.sessionName}`);
  if (context.url) lines.push(`- **URL:** ${context.url}`);
  if (context.discretization) {
    lines.push(`- **Solver lane:** \`${context.discretization.toUpperCase()}\``);
  }
  if (context.sceneRevision != null || context.meshRevision != null) {
    lines.push(
      `- **Revisions:** scene \`${context.sceneRevision ?? "unknown"}\` · mesh \`${context.meshRevision ?? "unknown"}\``,
    );
  }
  if (context.runId) lines.push(`- **Active run:** \`${context.runId}\``);
  if (context.viewport) lines.push(`- **Viewport:** \`${context.viewport}\``);
  if (context.userAgent) lines.push(`- **Browser:** \`${context.userAgent}\``);

  lines.push(
    "",
    "## Summary",
    `- **Unique issues:** ${entries.length} (${totalOccurrences} total occurrences)`,
    `- **By source:** Frontend ${counts.frontend} · Backend ${counts.backend} · API/WS ${counts.api} · Model ${counts.model}`,
    "",
  );

  if (entries.length === 0) {
    lines.push("_No errors or warnings were recorded in this session._");
    return lines.join("\n");
  }

  lines.push("## Recorded Issues (newest first)", "");
  entries.forEach((entry, index) => {
    lines.push(
      formatSingleSessionErrorForAi(entry, {}).replace(
        /^### /,
        `### ${index + 1}. `,
      ),
      "",
    );
  });

  return lines.join("\n").trimEnd() + "\n";
}
