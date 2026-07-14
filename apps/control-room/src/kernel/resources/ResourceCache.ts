export interface ResourceCacheEntry<TData, TMetadata = unknown> {
  byteLength: number;
  data: TData;
  dispose?: () => void;
  etag?: string | null;
  metadata?: TMetadata;
}

export interface ResourceCacheOptions {
  maxBytes: number;
  onEvent?: ResourceCacheEventListener;
}

export interface ResourceCacheStats {
  byteLength: number;
  entryCount: number;
}

export type ResourceCacheEventAction = "evict" | "hit" | "miss" | "set";

interface ResourceCacheEvent {
  action: ResourceCacheEventAction;
  byteLength: number | null;
  entryCount: number;
  key: string;
  maxBytes: number;
  retained: boolean;
  timestampMs: number;
}

export type ResourceCacheEventListener = (event: ResourceCacheEvent) => void;

export class ResourceCache<TData, TMetadata = unknown> {
  private readonly entries = new Map<string, ResourceCacheEntry<TData, TMetadata>>();
  private readonly inflight = new Map<string, Promise<ResourceCacheEntry<TData, TMetadata>>>();
  private readonly listeners = new Set<ResourceCacheEventListener>();
  private readonly retained = new Map<string, number>();
  private byteLength = 0;

  constructor(private readonly options: ResourceCacheOptions) {}

  clear(): void {
    for (const [key, entry] of this.entries) {
      entry.dispose?.();
      this.emit("evict", key, entry.byteLength);
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
    this.emit("evict", key, entry.byteLength);
    return true;
  }

  get(key: string): ResourceCacheEntry<TData, TMetadata> | null {
    const entry = this.entries.get(key);
    if (!entry) {
      this.emit("miss", key, null);
      return null;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    this.emit("hit", key, entry.byteLength);
    return entry;
  }

  peek(key: string): ResourceCacheEntry<TData, TMetadata> | null {
    return this.entries.get(key) ?? null;
  }

  getOrLoad(
    key: string,
    load: () => Promise<ResourceCacheEntry<TData, TMetadata>>,
  ): Promise<ResourceCacheEntry<TData, TMetadata>> {
    const cached = this.get(key);
    if (cached) {
      return Promise.resolve(cached);
    }

    const current = this.inflight.get(key);
    if (current) {
      this.emit("hit", key, null);
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

  set(key: string, entry: ResourceCacheEntry<TData, TMetadata>): boolean {
    if (entry.byteLength > this.options.maxBytes) {
      this.delete(key);
      for (const existingKey of Array.from(this.entries.keys())) {
        if (!this.retained.has(existingKey)) {
          this.delete(existingKey);
        }
      }
      this.entries.set(key, entry);
      this.byteLength += entry.byteLength;
      this.emit("set", key, entry.byteLength);
      return true;
    }

    this.delete(key);
    this.entries.set(key, entry);
    this.byteLength += entry.byteLength;
    this.emit("set", key, entry.byteLength);
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

  maxBytes(): number {
    return this.options.maxBytes;
  }

  subscribe(listener: ResourceCacheEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(
    action: ResourceCacheEventAction,
    key: string,
    byteLength: number | null,
  ): void {
    const event: ResourceCacheEvent = {
      action,
      byteLength,
      entryCount: this.entries.size,
      key,
      maxBytes: this.options.maxBytes,
      retained: this.retained.has(key),
      timestampMs: Date.now(),
    };
    this.options.onEvent?.(event);
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private evictUntilWithinBudget(): void {
    while (this.byteLength > this.options.maxBytes) {
      let oldestKey: string | undefined;
      for (const key of this.entries.keys()) {
        if (!this.retained.has(key)) {
          oldestKey = key;
          break;
        }
      }
      if (oldestKey === undefined) return;
      this.delete(oldestKey);
    }
  }
}
