"use client";

type MemoryBudgetCategory =
  | "api-cache"
  | "binary-buffer"
  | "diagnostics-buffer"
  | "object-url"
  | "render-buffer"
  | "session-state"
  | "viewport-cache"
  | "webgl"
  | "worker"
  | "other";

export interface MemoryBudgetEntry {
  byteLength: number;
  category: MemoryBudgetCategory;
  createdAtMs: number;
  entryCount: number;
  id: string;
  label: string;
  maxBytes: number | null;
  owner: string;
  releaseReason: string | null;
}

type MemoryBudgetProviderEntry = Omit<
  MemoryBudgetEntry,
  "createdAtMs" | "owner" | "releaseReason"
> &
  Partial<Pick<MemoryBudgetEntry, "createdAtMs" | "owner" | "releaseReason">>;

export interface MemoryBudgetCategorySnapshot {
  byteLength: number;
  category: MemoryBudgetCategory;
  entries: MemoryBudgetEntry[];
  entryCount: number;
  maxBytes: number | null;
}

type MemoryBudgetProvider = () => MemoryBudgetProviderEntry | null;
type MemoryBudgetListener = () => void;

interface MemoryBudgetProviderRegistration {
  createdAtMs: number;
  provider: MemoryBudgetProvider;
}

export type MemoryLedgerEntryInput = Omit<
  MemoryBudgetEntry,
  "createdAtMs" | "releaseReason"
> &
  Partial<Pick<MemoryBudgetEntry, "createdAtMs" | "releaseReason">>;

export type MemoryLedgerEntryPatch = Partial<
  Omit<MemoryLedgerEntryInput, "id" | "createdAtMs">
>;

export class MemoryBudgetRegistry {
  private readonly ledgerEntries = new Map<string, MemoryBudgetEntry>();
  private readonly listeners = new Set<MemoryBudgetListener>();
  private readonly providers = new Map<string, MemoryBudgetProviderRegistration>();
  private version = 0;

  register(id: string, provider: MemoryBudgetProvider): () => void {
    this.providers.set(id, {
      createdAtMs: Date.now(),
      provider,
    });
    this.publish();
    return () => {
      if (this.providers.get(id)?.provider === provider) {
        this.providers.delete(id);
        this.publish();
      }
    };
  }

  getVersion(): number {
    return this.version;
  }

  registerLedgerEntry(entry: MemoryLedgerEntryInput): () => void {
    this.ledgerEntries.set(entry.id, normalizeLedgerEntry(entry));
    this.publish();
    return () => {
      this.releaseLedgerEntry(entry.id, "unregistered");
    };
  }

  releaseLedgerEntry(id: string, releaseReason = "released"): boolean {
    const entry = this.ledgerEntries.get(id);
    if (!entry) return false;
    this.ledgerEntries.set(id, {
      ...entry,
      releaseReason,
    });
    this.ledgerEntries.delete(id);
    this.publish();
    return true;
  }

  snapshot(): MemoryBudgetEntry[] {
    const entries: MemoryBudgetEntry[] = [];
    for (const [id, registration] of this.providers) {
      const entry = registration.provider();
      if (entry) {
        entries.push(normalizeProviderEntry(id, entry, registration.createdAtMs));
      }
    }
    for (const entry of this.ledgerEntries.values()) {
      entries.push({ ...entry });
    }
    return entries;
  }

  snapshotByCategory(): MemoryBudgetCategorySnapshot[] {
    const byCategory = new Map<MemoryBudgetCategory, MemoryBudgetEntry[]>();
    for (const entry of this.snapshot()) {
      const entries = byCategory.get(entry.category) ?? [];
      entries.push(entry);
      byCategory.set(entry.category, entries);
    }

    return Array.from(byCategory.entries())
      .map(([category, entries]) => ({
        byteLength: entries.reduce((total, entry) => total + entry.byteLength, 0),
        category,
        entries,
        entryCount: entries.reduce((total, entry) => total + entry.entryCount, 0),
        maxBytes: sumMaxBytes(entries),
      }))
      .sort((left, right) => right.byteLength - left.byteLength);
  }

  subscribe(listener: MemoryBudgetListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  totalBytes(): number {
    return this.snapshot().reduce((total, entry) => total + entry.byteLength, 0);
  }

  updateLedgerEntry(id: string, patch: MemoryLedgerEntryPatch): boolean {
    const entry = this.ledgerEntries.get(id);
    if (!entry) return false;
    this.ledgerEntries.set(id, {
      ...entry,
      ...normalizeLedgerPatch(patch),
    });
    this.publish();
    return true;
  }

  private publish(): void {
    this.version += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const memoryBudgetRegistry = new MemoryBudgetRegistry();

function normalizeProviderEntry(
  id: string,
  entry: MemoryBudgetProviderEntry,
  createdAtMs: number,
): MemoryBudgetEntry {
  return {
    byteLength: normalizeNonNegativeNumber(entry.byteLength),
    category: entry.category,
    createdAtMs: normalizeTimestamp(entry.createdAtMs, createdAtMs),
    entryCount: normalizeNonNegativeNumber(entry.entryCount),
    id: entry.id,
    label: entry.label,
    maxBytes: normalizeNullableNonNegativeNumber(entry.maxBytes),
    owner: entry.owner ?? ownerFromId(id),
    releaseReason: entry.releaseReason ?? null,
  };
}

function normalizeLedgerEntry(entry: MemoryLedgerEntryInput): MemoryBudgetEntry {
  return {
    byteLength: normalizeNonNegativeNumber(entry.byteLength),
    category: entry.category,
    createdAtMs: normalizeTimestamp(entry.createdAtMs, Date.now()),
    entryCount: normalizeNonNegativeNumber(entry.entryCount),
    id: entry.id,
    label: entry.label,
    maxBytes: normalizeNullableNonNegativeNumber(entry.maxBytes),
    owner: entry.owner,
    releaseReason: entry.releaseReason ?? null,
  };
}

function normalizeLedgerPatch(
  patch: MemoryLedgerEntryPatch,
): MemoryLedgerEntryPatch {
  return {
    ...patch,
    byteLength:
      patch.byteLength === undefined
        ? undefined
        : normalizeNonNegativeNumber(patch.byteLength),
    entryCount:
      patch.entryCount === undefined
        ? undefined
        : normalizeNonNegativeNumber(patch.entryCount),
    maxBytes:
      patch.maxBytes === undefined
        ? undefined
        : normalizeNullableNonNegativeNumber(patch.maxBytes),
    releaseReason: patch.releaseReason ?? undefined,
  };
}

function normalizeNonNegativeNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function normalizeNullableNonNegativeNumber(value: number | null): number | null {
  return value === null ? null : normalizeNonNegativeNumber(value);
}

function normalizeTimestamp(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : fallback;
}

function ownerFromId(id: string): string {
  const [owner] = id.split(".");
  return owner || id;
}

function sumMaxBytes(entries: readonly MemoryBudgetEntry[]): number | null {
  let total = 0;
  for (const entry of entries) {
    if (entry.maxBytes === null) return null;
    total += entry.maxBytes;
  }
  return total;
}
