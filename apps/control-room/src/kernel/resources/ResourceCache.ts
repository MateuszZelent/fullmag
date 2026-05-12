export interface ResourceCacheEntry<TData> {
  byteLength: number;
  data: TData;
  dispose?: () => void;
  etag?: string | null;
}

export interface ResourceCacheOptions {
  maxBytes: number;
}

export interface ResourceCacheStats {
  byteLength: number;
  entryCount: number;
}

export class ResourceCache<TData> {
  private readonly entries = new Map<string, ResourceCacheEntry<TData>>();
  private readonly inflight = new Map<string, Promise<ResourceCacheEntry<TData>>>();
  private readonly retained = new Map<string, number>();
  private byteLength = 0;

  constructor(private readonly options: ResourceCacheOptions) {}

  clear(): void {
    for (const entry of this.entries.values()) {
      entry.dispose?.();
    }
    this.entries.clear();
    this.retained.clear();
    this.byteLength = 0;
  }

  delete(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;

    this.entries.delete(key);
    this.retained.delete(key);
    this.byteLength -= entry.byteLength;
    entry.dispose?.();
    return true;
  }

  get(key: string): ResourceCacheEntry<TData> | null {
    const entry = this.entries.get(key);
    if (!entry) return null;

    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  peek(key: string): ResourceCacheEntry<TData> | null {
    return this.entries.get(key) ?? null;
  }

  getOrLoad(
    key: string,
    load: () => Promise<ResourceCacheEntry<TData>>,
  ): Promise<ResourceCacheEntry<TData>> {
    const cached = this.get(key);
    if (cached) {
      return Promise.resolve(cached);
    }

    const current = this.inflight.get(key);
    if (current) {
      return current;
    }

    const pending = load().then((entry) => {
      this.set(key, entry);
      return this.get(key) ?? entry;
    });
    this.inflight.set(key, pending);

    return pending.finally(() => {
      this.inflight.delete(key);
    });
  }

  set(key: string, entry: ResourceCacheEntry<TData>): boolean {
    if (entry.byteLength > this.options.maxBytes) {
      return false;
    }

    this.delete(key);
    this.entries.set(key, entry);
    this.byteLength += entry.byteLength;
    this.evictUntilWithinBudget();
    return true;
  }

  retain(key: string): () => void {
    this.retained.set(key, (this.retained.get(key) ?? 0) + 1);
    let released = false;

    return () => {
      if (released) return;
      released = true;
      const count = this.retained.get(key);
      if (count === undefined) return;
      if (count <= 1) {
        this.retained.delete(key);
      } else {
        this.retained.set(key, count - 1);
      }
    };
  }

  stats(): ResourceCacheStats {
    return {
      byteLength: this.byteLength,
      entryCount: this.entries.size,
    };
  }

  private evictUntilWithinBudget(): void {
    while (this.byteLength > this.options.maxBytes) {
      const oldestKey = Array.from(this.entries.keys()).find(
        (key) => !this.retained.has(key),
      );
      if (oldestKey === undefined) return;
      this.delete(oldestKey);
    }
  }
}
