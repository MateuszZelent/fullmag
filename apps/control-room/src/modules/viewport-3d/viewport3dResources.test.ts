import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { DATA_FIELD_VECTOR_PATH } from "@/kernel/api/apiPaths";
import { ResourceCache } from "@/kernel/resources/ResourceCache";

import {
  loadCachedBinaryResource,
  resolveViewport3DAirboxFieldVectorResourceKeys,
  resolveViewport3DFieldVectorResourceKey,
  resolveViewport3DQuantityFieldVectorResourceKeys,
} from "./viewport3dResources";

const viewport3dResourcesSourceUrl = new URL(
  "./viewport3dResources.ts",
  import.meta.url,
);

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

  it("builds scoped airbox field vector resource keys per mesh part", () => {
    expect(
      resolveViewport3DAirboxFieldVectorResourceKeys("h_demag", [
        { id: "airbox" },
        { id: "airbox-shell" },
      ]),
    ).toEqual(
      new Map([
        [
          "airbox",
          `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "H_demag")}?component=full&scope_id=airbox&scope_kind=airbox`,
        ],
        [
          "airbox-shell",
          `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "H_demag")}?component=full&scope_id=airbox-shell&scope_kind=airbox`,
        ],
      ]),
    );
  });

  it("does not build airbox field vector resource keys for magnetic-only quantities", () => {
    expect(
      resolveViewport3DAirboxFieldVectorResourceKeys("m", [{ id: "airbox" }]),
    ).toEqual(new Map());
    expect(
      resolveViewport3DAirboxFieldVectorResourceKeys("h_ex", [{ id: "airbox" }]),
    ).toEqual(new Map());
  });

  it("builds stable full-field keys for target-specific quantities", () => {
    expect(
      resolveViewport3DQuantityFieldVectorResourceKeys(["h_eff", "m", "h_eff"]),
    ).toEqual(
      new Map([
        [
          "h_eff",
          `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "H_eff")}?component=full&scope_kind=full`,
        ],
        [
          "m",
          `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?component=full&scope_kind=full`,
        ],
      ]),
    );
  });

  it("keeps field vector runtime keys stable across field revisions", () => {
    const source = readFileSync(viewport3dResourcesSourceUrl, "utf8");

    expect(source).not.toContain("#fields=");
    expect(source).not.toContain("resolveRevisionedFieldVectorCacheKey");
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

  it("can reuse cached binary data without a conditional request", async () => {
    const cache = new ResourceCache<string>({ maxBytes: 32 });
    cache.set("field:m", {
      byteLength: 4,
      data: "cached-field",
      etag: '"field-1"',
    });
    const request = vi.fn(async () => ({
      byteLength: 5,
      data: "fresh",
      etag: '"field-2"',
      status: "ready" as const,
    }));

    await expect(
      loadCachedBinaryResource(cache, "field:m", request, {
        preferCached: true,
      }),
    ).resolves.toBe("cached-field");
    expect(request).not.toHaveBeenCalled();
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
