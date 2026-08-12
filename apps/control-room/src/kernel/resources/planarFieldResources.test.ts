import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  DATA_PLANAR_FIELD_META_PATH,
  DATA_PLANAR_FIELD_SCALAR_PATH,
} from "../api/apiPaths";
import { planarFieldResourceKey } from "../api/fieldQueryIdentity";

import { ResourceCache } from "./ResourceCache";
import {
  loadCachedPlanarBinary,
  loadCachedPlanarScalar,
  resolvePlanarFieldResourceKey,
} from "./planarFieldResources";

describe("planar field resources", () => {
  it("normalizes query order into one resource identity", () => {
    const first = planarFieldResourceKey("m", "plane/a", {
      resolution_y: 64,
      component: "z",
      resolution_x: 128,
    });
    const second = planarFieldResourceKey("m", "plane/a", {
      resolution_x: 128,
      resolution_y: 64,
      component: "z",
    });

    expect(first).toBe(second);
    expect(first).toBe(
      `${DATA_PLANAR_FIELD_META_PATH.replace("{quantity_id}", "m").replace("{monitor_id}", "plane%2Fa")}?component=z&include_mesh=false&quality=interactive&resolution_x=128&resolution_y=64&scope_kind=monitor_target&vector_budget=0`,
    );
    expect(
      resolvePlanarFieldResourceKey(
        "m",
        "plane/a",
        { component: "z" },
        '"etag"',
        DATA_PLANAR_FIELD_SCALAR_PATH,
      ),
    ).toContain("#revision=%22etag%22");
  });

  it("rejects a 304 response when no matching cached payload exists", async () => {
    const cache = new ResourceCache<ArrayBuffer>({ maxBytes: 1024 });
    await expect(
      loadCachedPlanarBinary(cache, "missing", async () => ({
        etag: '"missing"',
        status: "not-modified",
      })),
    ).rejects.toThrow("returned 304 without cache entry");
  });

  it("reuses the cached payload and sends its etag", async () => {
    const cache = new ResourceCache<ArrayBuffer>({ maxBytes: 1024 });
    const payload = new Uint8Array([1, 2, 3]).buffer;
    cache.set("field", {
      byteLength: payload.byteLength,
      data: payload,
      etag: '"field-etag"',
    });
    const request = vi.fn(async () => ({
      etag: '"field-etag"',
      status: "not-modified" as const,
    }));

    await expect(loadCachedPlanarBinary(cache, "field", request)).resolves.toBe(
      payload,
    );
    expect(request).toHaveBeenCalledWith('"field-etag"');
  });

  it("returns the scalar response etag with the cached binary payload", async () => {
    const cache = new ResourceCache<ArrayBuffer>({ maxBytes: 1024 });
    const payload = new Uint8Array([1, 2, 3]).buffer;
    cache.set("field", {
      byteLength: payload.byteLength,
      data: payload,
      etag: '"scalar-current"',
    });

    await expect(
      loadCachedPlanarScalar(cache, "field", async () => ({
        etag: '"scalar-current"',
        status: "not-modified",
      })),
    ).resolves.toEqual({ data: payload, etag: '"scalar-current"' });
  });

  it("delegates inactive resources to the shared no-load hook policy", () => {
    const source = readFileSync(
      new URL("./planarFieldResources.ts", import.meta.url),
      "utf8",
    );
    const binaryHook = source.slice(
      source.indexOf("export function usePlanarFieldBinaryResource"),
      source.indexOf("export async function loadCachedPlanarBinary"),
    );

    expect(binaryHook).toContain("enabled: options.enabled");
    expect(binaryHook).toContain("return useResource<ArrayBuffer | null>");
  });
});
