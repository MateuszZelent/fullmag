import { describe, expect, it, vi } from "vitest";

import { ResourceCache } from "./ResourceCache";

describe("ResourceCache", () => {
  it("inspects missing, inflight, ready, retained, and released entries without exposing data", async () => {
    const cache = new ResourceCache<string>({ maxBytes: 10 });

    expect(cache.inspect("field:m")).toEqual({
      byteLength: null,
      entryState: "missing",
      etag: null,
      key: "field:m",
      retainCount: 0,
    });

    let resolveLoad!: (entry: {
      byteLength: number;
      data: string;
      etag: string;
    }) => void;
    const pending = cache.getOrLoad(
      "field:m",
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    );

    expect(cache.inspect("field:m")).toEqual({
      byteLength: null,
      entryState: "inflight",
      etag: null,
      key: "field:m",
      retainCount: 0,
    });

    resolveLoad({ byteLength: 6, data: "secret", etag: '"field-1"' });
    await pending;
    const ready = cache.inspect("field:m");
    expect(ready).toEqual({
      byteLength: 6,
      entryState: "ready",
      etag: '"field-1"',
      key: "field:m",
      retainCount: 0,
    });
    expect(ready).not.toHaveProperty("data");
    expect(ready).not.toHaveProperty("metadata");

    const releaseFirst = cache.retain("field:m");
    const releaseSecond = cache.retain("field:m");
    expect(cache.inspect("field:m").retainCount).toBe(2);
    releaseFirst();
    expect(cache.inspect("field:m").retainCount).toBe(1);
    releaseSecond();
    expect(cache.inspect("field:m").retainCount).toBe(0);
  });

  it("inspects an entry without refreshing LRU position or emitting cache events", () => {
    const events: unknown[] = [];
    const cache = new ResourceCache<string>({
      maxBytes: 2,
      onEvent: (event) => events.push(event),
    });
    cache.set("oldest", { byteLength: 1, data: "old" });
    cache.set("newest", { byteLength: 1, data: "new" });
    events.length = 0;

    expect(cache.inspect("oldest").entryState).toBe("ready");
    expect(events).toEqual([]);

    cache.set("replacement", { byteLength: 1, data: "replacement" });
    expect(cache.peek("oldest")).toBeNull();
    expect(cache.peek("newest")?.data).toBe("new");
  });

  it("stores, replaces, evicts, and preserves typed metadata", () => {
    const cache = new ResourceCache<string, { revision: number }>({ maxBytes: 2 });
    cache.set("a", { byteLength: 1, data: "a", metadata: { revision: 1 } });
    expect(cache.get("a")?.metadata).toEqual({ revision: 1 });

    cache.set("a", { byteLength: 1, data: "b", metadata: { revision: 2 } });
    expect(cache.get("a")?.metadata).toEqual({ revision: 2 });

    cache.set("b", { byteLength: 2, data: "b", metadata: { revision: 3 } });
    expect(cache.peek("a")).toBeNull();
    expect(cache.get("b")?.metadata).toEqual({ revision: 3 });

    cache.set("oversize", {
      byteLength: 3,
      data: "large",
      metadata: { revision: 4 },
    });
    expect(cache.get("oversize")?.metadata).toEqual({ revision: 4 });
  });

  it("keeps metadata absent for caches that do not declare it", () => {
    const cache = new ResourceCache<string>({ maxBytes: 1 });
    cache.set("a", { byteLength: 1, data: "a" });
    expect(cache.get("a")).not.toHaveProperty("metadata");
  });

  it("reuses cached entries and refreshes their LRU position", () => {
    const cache = new ResourceCache<string>({ maxBytes: 3 });
    const evictedA = vi.fn();
    const evictedB = vi.fn();

    cache.set("a", { byteLength: 1, data: "a", dispose: evictedA });
    cache.set("b", { byteLength: 1, data: "b", dispose: evictedB });
    expect(cache.get("a")?.data).toBe("a");

    cache.set("c", { byteLength: 2, data: "c" });

    expect(cache.get("a")?.data).toBe("a");
    expect(cache.get("b")).toBeNull();
    expect(cache.get("c")?.data).toBe("c");
    expect(evictedA).not.toHaveBeenCalled();
    expect(evictedB).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toEqual({ byteLength: 3, entryCount: 2 });
  });

  it("deduplicates concurrent loads for the same key", async () => {
    const cache = new ResourceCache<string>({ maxBytes: 10 });
    const load = vi.fn(async () => ({
      byteLength: 4,
      data: "loaded",
      etag: '"loaded"',
    }));

    const [first, second] = await Promise.all([
      cache.getOrLoad("field:m", load),
      cache.getOrLoad("field:m", load),
    ]);

    expect(first).toBe(second);
    expect(first.data).toBe("loaded");
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.get("field:m")?.etag).toBe('"loaded"');
  });

  it("keeps one oversized current entry instead of silently dropping it", () => {
    const cache = new ResourceCache<string>({ maxBytes: 4 });
    const disposeSmall = vi.fn();
    cache.set("small", { byteLength: 2, data: "small" });
    cache.set("small-disposable", {
      byteLength: 1,
      data: "small-disposable",
      dispose: disposeSmall,
    });

    expect(cache.set("large", { byteLength: 5, data: "large" })).toBe(true);

    expect(cache.get("small")).toBeNull();
    expect(cache.get("small-disposable")).toBeNull();
    expect(cache.get("large")?.data).toBe("large");
    expect(disposeSmall).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toEqual({ byteLength: 5, entryCount: 1 });
  });

  it("keeps retained entries out of LRU eviction until released", () => {
    const cache = new ResourceCache<string>({ maxBytes: 3 });
    cache.set("a", { byteLength: 2, data: "a" });
    cache.set("b", { byteLength: 1, data: "b" });
    const releaseA = cache.retain("a");

    cache.set("c", { byteLength: 1, data: "c" });

    expect(cache.get("a")?.data).toBe("a");
    expect(cache.get("b")).toBeNull();
    expect(cache.get("c")?.data).toBe("c");

    releaseA();
    cache.set("d", { byteLength: 2, data: "d" });

    expect(cache.get("a")).toBeNull();
    expect(cache.get("c")?.data).toBe("c");
    expect(cache.get("d")?.data).toBe("d");
  });

  it("emits diagnostic cache events without changing cache behavior", () => {
    const events: unknown[] = [];
    const cache = new ResourceCache<string>({
      maxBytes: 3,
      onEvent: (event) => events.push({ ...event, timestampMs: 0 }),
    });
    const unsubscribe = cache.subscribe((event) => {
      events.push({ listener: true, ...event, timestampMs: 0 });
    });

    cache.get("missing");
    cache.set("a", { byteLength: 2, data: "a" });
    cache.get("a");
    cache.set("b", { byteLength: 2, data: "b" });
    unsubscribe();
    cache.clear();

    expect(events).toEqual([
      expect.objectContaining({ action: "miss", byteLength: null, key: "missing" }),
      expect.objectContaining({
        action: "miss",
        byteLength: null,
        key: "missing",
        listener: true,
      }),
      expect.objectContaining({ action: "set", byteLength: 2, key: "a" }),
      expect.objectContaining({
        action: "set",
        byteLength: 2,
        key: "a",
        listener: true,
      }),
      expect.objectContaining({ action: "hit", byteLength: 2, key: "a" }),
      expect.objectContaining({
        action: "hit",
        byteLength: 2,
        key: "a",
        listener: true,
      }),
      expect.objectContaining({ action: "set", byteLength: 2, key: "b" }),
      expect.objectContaining({
        action: "set",
        byteLength: 2,
        key: "b",
        listener: true,
      }),
      expect.objectContaining({ action: "evict", byteLength: 2, key: "a" }),
      expect.objectContaining({
        action: "evict",
        byteLength: 2,
        key: "a",
        listener: true,
      }),
      expect.objectContaining({ action: "evict", byteLength: 2, key: "b" }),
    ]);
  });
});
