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
  eTag?: string | null;
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
  private totalBytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number = DEFAULT_MAX_BYTES) {
    this.maxBytes = maxBytes;
  }

  set<T>(
    key: string,
    data: T,
    revision: number,
    generationId: number = 0,
    eTag?: string | null,
  ): void {
    const byteSize = this.estimateSize(data);

    const existing = this.store.get(key);
    if (existing) {
      this.totalBytes -= existing.byteSize;
      this.store.delete(key);
    }

    if (byteSize > this.maxBytes) {
      return;
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
      eTag: eTag ?? null,
    };
    this.store.set(key, entry as CacheEntry);
    this.totalBytes += byteSize;
  }

  get<T>(key: string): CacheEntry<T> | null {
    const entry = this.store.get(key);
    if (!entry) return null;

    // Reinsert to keep Map iteration order aligned with LRU.
    this.store.delete(key);
    this.store.set(key, entry);

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
    const oldest = this.store.keys().next().value as string | undefined;
    if (oldest) {
      this.remove(oldest);
    }
  }

  remove(key: string): void {
    const entry = this.store.get(key);
    if (entry) {
      this.totalBytes -= entry.byteSize;
      this.store.delete(key);
    }
  }

  clear(): void {
    this.store.clear();
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

  static fieldKey(
    quantityId: string,
    revision: number,
    genId: number,
    component: string = "full",
  ): string {
    return `field:${genId}:${quantityId}:${revision}:${component}`;
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
