"use client";

export type MemoryBudgetCategory =
  | "api-cache"
  | "render-buffer"
  | "session-state"
  | "viewport-cache"
  | "other";

export interface MemoryBudgetEntry {
  byteLength: number;
  category: MemoryBudgetCategory;
  entryCount: number;
  id: string;
  label: string;
  maxBytes: number | null;
}

type MemoryBudgetProvider = () => MemoryBudgetEntry | null;

export class MemoryBudgetRegistry {
  private readonly providers = new Map<string, MemoryBudgetProvider>();

  register(id: string, provider: MemoryBudgetProvider): () => void {
    this.providers.set(id, provider);
    return () => {
      if (this.providers.get(id) === provider) {
        this.providers.delete(id);
      }
    };
  }

  snapshot(): MemoryBudgetEntry[] {
    const entries: MemoryBudgetEntry[] = [];
    for (const provider of this.providers.values()) {
      const entry = provider();
      if (entry) entries.push(entry);
    }
    return entries;
  }

  totalBytes(): number {
    return this.snapshot().reduce((total, entry) => total + entry.byteLength, 0);
  }
}

export const memoryBudgetRegistry = new MemoryBudgetRegistry();
