import { describe, expect, it, vi } from "vitest";

import { ResourceCache } from "./ResourceCache";

describe("ResourceCache", () => {
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

  it("rejects oversized entries without evicting useful cached data", () => {
    const cache = new ResourceCache<string>({ maxBytes: 4 });
    cache.set("small", { byteLength: 2, data: "small" });

    expect(cache.set("large", { byteLength: 5, data: "large" })).toBe(false);

    expect(cache.get("small")?.data).toBe("small");
    expect(cache.get("large")).toBeNull();
    expect(cache.stats()).toEqual({ byteLength: 2, entryCount: 1 });
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
});
