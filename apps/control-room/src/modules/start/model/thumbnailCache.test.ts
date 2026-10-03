import { describe, expect, it } from "vitest";

import { LruCache } from "./thumbnailCache";

describe("LruCache", () => {
  it("evicts the least recently used entry beyond capacity", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.has("a")).toBe(false);
    expect(cache.size).toBe(2);
  });

  it("counts a read as use", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
  });

  it("replaces a value without growing", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("a", 9);
    expect(cache.size).toBe(1);
    expect(cache.get("a")).toBe(9);
  });

  it("rejects a capacity that cannot hold anything", () => {
    expect(() => new LruCache<string, number>(0)).toThrow(RangeError);
  });
});
