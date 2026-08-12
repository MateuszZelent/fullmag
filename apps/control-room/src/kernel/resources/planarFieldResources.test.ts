import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  DATA_PLANAR_FIELD_EMPTY_MASK_PATH,
  DATA_PLANAR_FIELD_META_PATH,
  DATA_PLANAR_FIELD_MESH_OVERLAY_PATH,
  DATA_PLANAR_FIELD_PROBE_PATH,
  DATA_PLANAR_FIELD_RENDER_PNG_PATH,
  DATA_PLANAR_FIELD_SCALAR_PATH,
  DATA_PLANAR_FIELD_VECTORS_PATH,
} from "../api/apiPaths";
import { planarFieldResourceKey } from "../api/fieldQueryIdentity";

import { ResourceCache } from "./ResourceCache";
import {
  loadCachedPlanarBinary,
  loadCachedPlanarScalar,
  planarFieldQueryFromMetaLinks,
  resolvePlanarFieldResourceKey,
} from "./planarFieldResources";

describe("planar field resources", () => {
  const canonicalSuffix =
    "?sample_token=planar-sample-v2%3Aexact&component=normal" +
    "&expected_scene_revision=101&expected_monitor_revision=202" +
    "&expected_mesh_revision=303&expected_carrier_revision=304" +
    "&expected_field_revision=404&resolution_x=128&resolution_y=64" +
    "&scope_kind=monitor_target&quality=interactive&include_mesh=false";
  const metaLinks = (
    quantityId = "m",
    monitorId = "plane-1",
    origin = "",
  ) => {
    const link = (path: string) =>
      origin +
      path
        .replace("{quantity_id}", encodeURIComponent(quantityId))
        .replace("{monitor_id}", encodeURIComponent(monitorId)) +
      canonicalSuffix;
    return {
      empty_mask: link(DATA_PLANAR_FIELD_EMPTY_MASK_PATH),
      mesh_overlay: link(DATA_PLANAR_FIELD_MESH_OVERLAY_PATH),
      probe: link(DATA_PLANAR_FIELD_PROBE_PATH),
      render_png: link(DATA_PLANAR_FIELD_RENDER_PNG_PATH),
      scalar: link(DATA_PLANAR_FIELD_SCALAR_PATH),
      vectors: link(DATA_PLANAR_FIELD_VECTORS_PATH),
    };
  };

  it("normalizes query order into one resource identity", () => {
    const first = planarFieldResourceKey("m /% żółć", "plane/a", {
      resolution_y: 64,
      component: "z",
      resolution_x: 128,
    });
    const second = planarFieldResourceKey("m /% żółć", "plane/a", {
      resolution_x: 128,
      resolution_y: 64,
      component: "z",
    });

    expect(first).toBe(second);
    expect(first).toBe(
      `${DATA_PLANAR_FIELD_META_PATH.replace("{quantity_id}", "m%20%2F%25%20%C5%BC%C3%B3%C5%82%C4%87").replace("{monitor_id}", "plane%2Fa")}?component=z&include_mesh=false&quality=interactive&resolution_x=128&resolution_y=64&scope_kind=monitor_target&vector_budget=0`,
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

  it("keeps immutable sample tokens and exact revisions in binary cache identity", () => {
    const revisions = {
      expected_carrier_revision: "9007199254741001",
      expected_field_revision: "9007199254741002",
      expected_mesh_revision: "9007199254741003",
      expected_monitor_revision: "9007199254741004",
      expected_scene_revision: "9007199254741005",
    } as const;
    const first = planarFieldResourceKey("m", "plane/a", {
      ...revisions,
      sample_token: "planar-sample-v2:first",
    });
    const second = planarFieldResourceKey("m", "plane/a", {
      ...revisions,
      sample_token: "planar-sample-v2:second",
    });

    expect(first).not.toBe(second);
    expect(first).toContain("sample_token=planar-sample-v2%3Afirst");
    for (const [name, revision] of Object.entries(revisions)) {
      expect(first).toContain(`${name}=${revision}`);
    }
  });

  it("derives exact binary identity from valid same-origin metadata links", () => {
    const result = planarFieldQueryFromMetaLinks(
      "m",
      "plane-1",
      metaLinks("m", "plane-1", "http://fullmag.invalid"),
    );

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.query).toMatchObject({
      sample_token: "planar-sample-v2:exact",
      expected_scene_revision: "101",
      expected_monitor_revision: "202",
      expected_mesh_revision: "303",
      expected_carrier_revision: "304",
      expected_field_revision: "404",
      quality: "interactive",
      resolution_x: 128,
      resolution_y: 64,
      scope_kind: "monitor_target",
    });
  });

  it("accepts exact canonical paths for specially encoded ids", () => {
    const quantityId = "m /% żółć";
    const monitorId = "plane /% żółć";
    expect(
      planarFieldQueryFromMetaLinks(
        quantityId,
        monitorId,
        metaLinks(quantityId, monitorId),
      ),
    ).toMatchObject({ ok: true });
  });

  it.each([
    ["wrong quantity", "m", "plane-1", metaLinks("H_eff", "plane-1")],
    ["wrong monitor", "m", "plane-1", metaLinks("m", "plane-2")],
    ["external origin", "m", "plane-1", metaLinks("m", "plane-1", "https://example.invalid")],
  ])("rejects %s without throwing", (_name, quantityId, monitorId, links) => {
    expect(() =>
      planarFieldQueryFromMetaLinks(quantityId, monitorId, links),
    ).not.toThrow();
    expect(planarFieldQueryFromMetaLinks(quantityId, monitorId, links)).toMatchObject({
      ok: false,
    });
  });

  it("rejects an arbitrary shared prefix and identity disagreement", () => {
    const links = metaLinks();
    const falsePrefix = Object.fromEntries(
      Object.entries(links).map(([kind, link]) => [
        kind,
        link.replace(
          DATA_PLANAR_FIELD_SCALAR_PATH.split("{quantity_id}")[0],
          "/not-the-planar-resource-family/",
        ),
      ]),
    ) as typeof links;
    expect(planarFieldQueryFromMetaLinks("m", "plane-1", falsePrefix)).toMatchObject({
      ok: false,
    });
    expect(
      planarFieldQueryFromMetaLinks("m", "plane-1", {
        ...links,
        vectors: links.vectors.replace(
          "expected_field_revision=404",
          "expected_field_revision=405",
        ),
      }),
    ).toMatchObject({ ok: false });
  });

  it("returns a controlled error for malformed links", () => {
    const links = metaLinks();
    const malformed = {
      ...links,
      scalar: links.scalar.slice(0, links.scalar.indexOf("?")),
    };

    expect(() =>
      planarFieldQueryFromMetaLinks("m", "plane-1", malformed),
    ).not.toThrow();
    const result = planarFieldQueryFromMetaLinks("m", "plane-1", malformed);
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.error.message).toContain("Canonical planar metadata link is missing");
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
