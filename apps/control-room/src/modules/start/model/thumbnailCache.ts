/**
 * A small least-recently-used map. Thumbnails are pinned here as decoded
 * images so scrolling back to a row does not decode it again, while the bound
 * keeps a long recent list from holding every preview in memory.
 */
export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("LruCache capacity must be a positive integer.");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    // Re-insert so Map order tracks recency; the first key is the oldest.
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

export const THUMBNAIL_CACHE_CAPACITY = 60;

const decoded = new LruCache<string, HTMLImageElement>(THUMBNAIL_CACHE_CAPACITY);

export function pinThumbnail(src: string, image: HTMLImageElement): void {
  decoded.set(src, image);
}

export function isThumbnailPinned(src: string): boolean {
  return decoded.has(src);
}
