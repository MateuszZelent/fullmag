/**
 * Revision-based resource cache with LRU eviction.
 * Keyed by resource path; stores revision + generation for invalidation.
 */

export interface CacheEntry<T = unknown> {
  data: T;
  revision: number;
  generationId: number;
  fetchedAt: number;
  byteSize: number;
}

export interface CacheStats {
  entryCount: number;
  totalBytes: number;
  maxBytes: number;
  utilization: number;
}

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024; // 100 MB

export class ResourceCache {
  private store = new Map<string, CacheEntry>();
  private accessOrder: string[] = [];
  private totalBytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number = DEFAULT_MAX_BYTES) {
    this.maxBytes = maxBytes;
  }

  set<T>(key: string, data: T, revision: number, generationId: number = 0): void {
    const byteSize = this.estimateSize(data);

    // Remove existing entry first
    if (this.store.has(key)) {
      const existing = this.store.get(key)!;
      this.totalBytes -= existing.byteSize;
      this.store.delete(key);
      this.removeFromAccessOrder(key);
    }

    // Evict until we have room
    while (this.totalBytes + byteSize > this.maxBytes && this.store.size > 0) {
      this.evictOldest();
    }

    const entry: CacheEntry<T> = {
      data,
      revision,
      generationId,
      fetchedAt: Date.now(),
      byteSize,
    };
    this.store.set(key, entry as CacheEntry);
    this.accessOrder.push(key);
    this.totalBytes += byteSize;
  }

  get<T>(key: string): CacheEntry<T> | null {
    const entry = this.store.get(key);
    if (!entry) return null;

    // Move to end (most recently used)
    this.removeFromAccessOrder(key);
    this.accessOrder.push(key);

    return entry as CacheEntry<T>;
  }

  isValid(key: string, currentRevision: number): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    return entry.revision === currentRevision;
  }

  invalidateByGeneration(newGenerationId: number): void {
    const toRemove: string[] = [];
    for (const [key, entry] of this.store) {
      if (entry.generationId !== newGenerationId) {
        toRemove.push(key);
      }
    }
    for (const key of toRemove) {
      this.remove(key);
    }
  }

  evictOldest(): void {
    if (this.accessOrder.length === 0) return;
    const oldestKey = this.accessOrder[0];
    this.remove(oldestKey);
  }

  remove(key: string): void {
    const entry = this.store.get(key);
    if (entry) {
      this.totalBytes -= entry.byteSize;
      this.store.delete(key);
      this.removeFromAccessOrder(key);
    }
  }

  clear(): void {
    this.store.clear();
    this.accessOrder.length = 0;
    this.totalBytes = 0;
  }

  getCacheStats(): CacheStats {
    return {
      entryCount: this.store.size,
      totalBytes: this.totalBytes,
      maxBytes: this.maxBytes,
      utilization: this.maxBytes > 0 ? this.totalBytes / this.maxBytes : 0,
    };
  }

  // ── Static key helpers ──────────────────────────────────────────────

  static domainKey(genId: number, kind: string): string {
    return `domain:${genId}:${kind}`;
  }

  static fieldKey(quantityId: string, revision: number, genId: number): string {
    return `field:${genId}:${quantityId}:${revision}`;
  }

  // ── Internal ────────────────────────────────────────────────────────

  private removeFromAccessOrder(key: string): void {
    const idx = this.accessOrder.indexOf(key);
    if (idx !== -1) {
      this.accessOrder.splice(idx, 1);
    }
  }

  private estimateSize(data: unknown): number {
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (ArrayBuffer.isView(data)) return data.byteLength;
    if (typeof data === "string") return data.length * 2;
    // Rough JSON estimate
    try {
      return JSON.stringify(data).length * 2;
    } catch {
      return 1024;
    }
  }
}
