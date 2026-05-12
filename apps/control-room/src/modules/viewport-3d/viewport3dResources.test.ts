import { describe, expect, it, vi } from "vitest";

import { DATA_FIELD_VECTOR_PATH } from "@/kernel/api/apiPaths";
import { ResourceCache } from "@/kernel/resources/ResourceCache";

import {
  loadCachedBinaryResource,
  resolveViewport3DFieldVectorResourceKey,
} from "./viewport3dResources";

describe("viewport3dResources", () => {
  it("builds stable resource keys for scoped field vectors", () => {
    expect(
      resolveViewport3DFieldVectorResourceKey("m", {
        component: "full",
        scope_id: "part-1",
        scope_kind: "part",
      }),
    ).toBe(
      `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?component=full&scope_id=part-1&scope_kind=part`,
    );
  });

  it("uses cached binary data when the API reports not modified", async () => {
    const cache = new ResourceCache<string>({ maxBytes: 32 });
    cache.set("topology", {
      byteLength: 4,
      data: "cached",
      etag: '"topology-1"',
    });
    const request = vi.fn(async (etag?: string | null) => ({
      etag: etag ?? null,
      status: "not-modified" as const,
    }));

    await expect(
      loadCachedBinaryResource(cache, "topology", request),
    ).resolves.toBe("cached");
    expect(request).toHaveBeenCalledWith('"topology-1"');
  });

  it("stores decoded binary data returned by the API", async () => {
    const cache = new ResourceCache<string>({ maxBytes: 32 });

    await expect(
      loadCachedBinaryResource(cache, "field:m", async () => ({
        byteLength: 5,
        data: "fresh",
        etag: '"field-1"',
        status: "ready",
      })),
    ).resolves.toBe("fresh");

    expect(cache.get("field:m")).toMatchObject({
      data: "fresh",
      etag: '"field-1"',
    });
  });

  it("retains oversized binary data as the current entry for future 304 reuse", async () => {
    const cache = new ResourceCache<string>({ maxBytes: 4 });
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        byteLength: 8,
        data: "large-topology",
        etag: '"large-1"',
        status: "ready" as const,
      })
      .mockResolvedValueOnce({
        etag: '"large-1"',
        status: "not-modified" as const,
      });

    await expect(
      loadCachedBinaryResource(cache, "topology", request),
    ).resolves.toBe("large-topology");
    await expect(
      loadCachedBinaryResource(cache, "topology", request),
    ).resolves.toBe("large-topology");

    expect(request).toHaveBeenNthCalledWith(2, '"large-1"');
    expect(cache.stats()).toEqual({ byteLength: 8, entryCount: 1 });
  });

  it("can inspect cached binary etags without refreshing LRU order", () => {
    const cache = new ResourceCache<string>({ maxBytes: 10 });
    cache.set("oldest", { byteLength: 4, data: "old", etag: '"old"' });
    cache.set("middle", { byteLength: 4, data: "mid", etag: '"mid"' });

    expect(cache.peek("oldest")?.etag).toBe('"old"');

    cache.set("newest", { byteLength: 4, data: "new", etag: '"new"' });

    expect(cache.peek("oldest")).toBeNull();
    expect(cache.peek("middle")?.etag).toBe('"mid"');
    expect(cache.peek("newest")?.etag).toBe('"new"');
  });
});
