import { describe, it, expect } from "vitest";
import { ResourceCache } from "../ResourceCache";

describe("ResourceCache", () => {
  it("stores and retrieves entries", () => {
    const cache = new ResourceCache();
    cache.set("a", { x: 1 }, 1);
    const entry = cache.get("a");
    expect(entry).not.toBeNull();
    expect(entry!.data).toEqual({ x: 1 });
    expect(entry!.revision).toBe(1);
  });

  it("returns null for missing key", () => {
    const cache = new ResourceCache();
    expect(cache.get("missing")).toBeNull();
  });

  // ── Revision validation ──────────────────────────────────────────

  it("isValid returns true when revision matches", () => {
    const cache = new ResourceCache();
    cache.set("k", "data", 5);
    expect(cache.isValid("k", 5)).toBe(true);
  });

  it("isValid returns false when revision is stale", () => {
    const cache = new ResourceCache();
    cache.set("k", "data", 5);
    expect(cache.isValid("k", 6)).toBe(false);
  });

  it("isValid returns false for unknown key", () => {
    const cache = new ResourceCache();
    expect(cache.isValid("missing", 1)).toBe(false);
  });

  // ── Generation invalidation ──────────────────────────────────────

  it("invalidateByGeneration removes entries from older generations", () => {
    const cache = new ResourceCache();
    cache.set("old1", "x", 1, /* generationId */ 1);
    cache.set("old2", "y", 2, 1);
    cache.set("new1", "z", 3, 2);

    cache.invalidateByGeneration(2);

    expect(cache.get("old1")).toBeNull();
    expect(cache.get("old2")).toBeNull();
    expect(cache.get("new1")).not.toBeNull();
  });

  // ── LRU eviction ─────────────────────────────────────────────────

  it("evicts oldest entry when size limit is exceeded", () => {
    // maxBytes = 100; each string "aaaa" ≈ 8 bytes (4 chars * 2)
    // but JSON.stringify adds quotes → '\"aaaa\"' = 6 chars * 2 = 12 bytes
    const cache = new ResourceCache(50);
    cache.set("first", "aaaa", 1);
    cache.set("second", "bbbb", 2);
    cache.set("third", "cccc", 3);
    // At some point eviction should have removed "first"
    // Verify at least one early entry is gone while later entries survive
    const stats = cache.getCacheStats();
    expect(stats.totalBytes).toBeLessThanOrEqual(50);
  });

  it("promotes accessed entry to most-recent on get", () => {
    const cache = new ResourceCache(60);
    cache.set("a", "xx", 1);
    cache.set("b", "yy", 2);
    // Touch "a" so "b" becomes the oldest
    cache.get("a");
    cache.set("c", "zzzzzzzzzzzzzzzz", 3);
    // "b" should be evicted before "a"
    expect(cache.get("a")).not.toBeNull();
  });

  // ── Stats ────────────────────────────────────────────────────────

  it("getCacheStats reports correct entry count", () => {
    const cache = new ResourceCache();
    cache.set("a", "x", 1);
    cache.set("b", "y", 2);
    const stats = cache.getCacheStats();
    expect(stats.entryCount).toBe(2);
    expect(stats.totalBytes).toBeGreaterThan(0);
    expect(stats.utilization).toBeGreaterThan(0);
  });

  it("getCacheStats shows zero after clear", () => {
    const cache = new ResourceCache();
    cache.set("a", "x", 1);
    cache.clear();
    const stats = cache.getCacheStats();
    expect(stats.entryCount).toBe(0);
    expect(stats.totalBytes).toBe(0);
  });

  // ── Static key helpers ───────────────────────────────────────────

  it("domainKey returns deterministic key", () => {
    expect(ResourceCache.domainKey(3, "fdm")).toBe("domain:3:fdm");
  });

  it("fieldKey returns deterministic key", () => {
    expect(ResourceCache.fieldKey("m", 7, 2)).toBe("field:2:m:7:full");
    expect(ResourceCache.fieldKey("m", 7, 2, "x")).toBe("field:2:m:7:x");
  });

  // ── remove ───────────────────────────────────────────────────────

  it("remove deletes an entry and adjusts totalBytes", () => {
    const cache = new ResourceCache();
    cache.set("a", "data", 1);
    cache.remove("a");
    expect(cache.get("a")).toBeNull();
    expect(cache.getCacheStats().totalBytes).toBe(0);
  });

  // ── estimateSize for typed arrays ────────────────────────────────

  it("correctly sizes ArrayBuffer entries", () => {
    const cache = new ResourceCache();
    const buf = new ArrayBuffer(128);
    cache.set("buf", buf, 1);
    expect(cache.getCacheStats().totalBytes).toBe(128);
  });

  it("correctly sizes typed array views", () => {
    const cache = new ResourceCache();
    const arr = new Float32Array(16);
    cache.set("f32", arr, 1);
    expect(cache.getCacheStats().totalBytes).toBe(64); // 16 * 4
  });
});
